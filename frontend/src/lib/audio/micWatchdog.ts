import { TrackEvent, type LocalAudioTrack } from 'livekit-client';
import { createLevelTap } from './audioPipelineHealth';
import { keepAudioContextResumed } from './keepAudioContextResumed';

/**
 * Watches a mic track for "the mic is on but nothing is coming out" and fixes it before anyone
 * has to notice. Used in the pre-join screen and in the call (CallRoomPage's useMicWatchdog).
 *
 * Telemetry (2026-10-14 .. 11-19) showed two separate ways this happens, both right after joining:
 *
 *  A. The browser/OS hands us a live mic track that delivers exact digital silence (every sample
 *     0). A real microphone always has some noise floor, so exact zeros mean the capture itself is
 *     broken, not a quiet room. Re-acquiring the device (restartTrack -> getUserMedia) fixed it
 *     every time it happened.
 *  B. The raw mic is fine, but our own processing pipeline is still reading an older, ended clone
 *     of it (the noise canceller clones the track once, at creation). Rebuilding the pipeline —
 *     what toggling noise cancellation did by accident — fixes it.
 *
 * Both are detectable while the mic is muted: LiveKit mutes by setting `.enabled = false` on the
 * track, and this measures its own clone with `.enabled` forced back on (same trick as the
 * pre-join level meter). The clone only feeds a local AnalyserNode, so nothing is sent anywhere.
 *
 * Never switches to a different device on its own (it could pick the wrong mic); it only
 * re-acquires the same one. Attempts are capped so a mic that is genuinely silent (OS-level
 * mute, input volume 0, a virtual device with nothing playing) doesn't restart in a loop — after
 * the cap it reports 'failed' so the UI can ask the person to check their mic instead.
 */

export type MicWatchdogStatus = 'ok' | 'healing' | 'failed';

export interface MicWatchdogOptions {
  phase: 'prejoin' | 'call';
  /**
   * In the call: inspects our own processing pipeline. Called only while the raw mic has sound.
   * Returns why the pipeline is broken, or null when it's fine (or can't be judged right now).
   */
  checkPipeline?: () => string | null;
  /** In the call: tears down and rebuilds the processing pipeline. */
  rebuildPipeline?: (reason: string) => void;
  onStatus?: (status: MicWatchdogStatus) => void;
  /** Where heal attempts are recorded (telemetry). */
  log: (type: string, data: Record<string, unknown>) => void;
}

const TICK_MS = 500;
/** Exact silence this long on the raw mic means the capture is broken (A). */
const RAW_SILENT_MS = 2000;
/** The pipeline looking broken this long while the raw mic has sound means B. */
const PIPELINE_BAD_MS = 2000;
/** Don't judge a freshly (re)built probe or pipeline: the first buffers can legitimately be empty. */
const SETTLE_MS = 1000;
const MAX_ATTEMPTS = 3;
const ATTEMPT_WINDOW_MS = 120_000;

/** Pre-join heal records, held until the call's telemetry session exists (see flushPrejoinMicEvents). */
const pendingPrejoinEvents: { type: string; data: Record<string, unknown> }[] = [];

/** Pre-join log sink: telemetry only starts once the call does, so keep these until then. */
export function bufferPrejoinMicEvent(type: string, data: Record<string, unknown>) {
  if (pendingPrejoinEvents.length < 50) pendingPrejoinEvents.push({ type, data: { ...data, at: Date.now() } });
}

/** Called once the call's telemetry is running, to record what happened in the pre-join screen. */
export function flushPrejoinMicEvents(log: (type: string, data: Record<string, unknown>) => void) {
  for (const { type, data } of pendingPrejoinEvents.splice(0)) log(type, data);
}

/** Starts watching. Returns a stop function. */
export function startMicWatchdog(track: LocalAudioTrack, opts: MicWatchdogOptions): () => void {
  const ctx = new AudioContext();
  const detachResume = keepAudioContextResumed(ctx);
  let stopped = false;

  // --- raw mic probe: a clone of the track LiveKit currently holds, rebuilt when it changes ---
  let probeClone: MediaStreamTrack | null = null;
  let probeSource: MediaStreamAudioSourceNode | null = null;
  let probeTap: ReturnType<typeof createLevelTap> | null = null;
  let probeBuiltAt = 0;
  const buildProbe = () => {
    probeSource?.disconnect();
    probeTap?.node.disconnect();
    probeClone?.stop();
    probeSource = null;
    probeTap = null;
    probeClone = null;
    const raw = track.mediaStreamTrack;
    if (!raw || raw.readyState === 'ended') return;
    probeClone = raw.clone();
    probeClone.enabled = true;
    probeSource = ctx.createMediaStreamSource(new MediaStream([probeClone]));
    probeTap = createLevelTap(ctx);
    probeSource.connect(probeTap.node);
    probeBuiltAt = performance.now();
  };
  buildProbe();
  const onRestarted = () => {
    buildProbe();
    rawSilentMs = 0;
    pipelineBadMs = 0;
  };
  track.on(TrackEvent.Restarted, onRestarted);

  // --- status + attempt budget ---
  let status: MicWatchdogStatus = 'ok';
  const setStatus = (next: MicWatchdogStatus) => {
    if (next === status) return;
    status = next;
    opts.onStatus?.(next);
  };
  const attempts: number[] = [];
  const canAttempt = (now: number) => {
    while (attempts.length && now - attempts[0] > ATTEMPT_WINDOW_MS) attempts.shift();
    return attempts.length < MAX_ATTEMPTS;
  };

  let rawSilentMs = 0;
  let pipelineBadMs = 0;
  let pipelineSettleUntil = 0;
  let busy = false;
  let gaveUpLogged = false;

  const giveUp = (what: string) => {
    setStatus('failed');
    if (!gaveUpLogged) {
      gaveUpLogged = true;
      opts.log('mic-heal-gave-up', { phase: opts.phase, what, attempts: attempts.length });
    }
  };

  const healRaw = async (reason: string) => {
    const now = performance.now();
    if (!canAttempt(now)) return giveUp('raw');
    attempts.push(now);
    busy = true;
    setStatus('healing');
    const startedAt = now;
    const before = { raw: track.mediaStreamTrack?.readyState, label: track.mediaStreamTrack?.label };
    try {
      // No options: LiveKit re-acquires with the constraints it already has (same device).
      await track.restartTrack();
      // LiveKit mutes by .enabled; keep a muted mic muted on the fresh track.
      if (track.isMuted && track.mediaStreamTrack) track.mediaStreamTrack.enabled = false;
      opts.log('mic-heal', {
        phase: opts.phase,
        action: 'restart-track',
        reason,
        ok: true,
        ms: Math.round(performance.now() - startedAt),
        attempt: attempts.length,
        ...before,
      });
    } catch (e) {
      opts.log('mic-heal', {
        phase: opts.phase,
        action: 'restart-track',
        reason,
        ok: false,
        error: String(e),
        attempt: attempts.length,
        ...before,
      });
    } finally {
      busy = false;
      // Restarted rebuilds the probe; make sure a failed restart also gets a fresh look.
      if (!probeClone || probeClone.readyState === 'ended') buildProbe();
      rawSilentMs = 0;
      pipelineBadMs = 0;
    }
  };

  const healPipeline = (reason: string) => {
    if (!opts.rebuildPipeline) return;
    const now = performance.now();
    if (!canAttempt(now)) return giveUp('pipeline');
    attempts.push(now);
    setStatus('healing');
    opts.log('mic-heal', { phase: opts.phase, action: 'rebuild-pipeline', reason, attempt: attempts.length });
    opts.rebuildPipeline(reason);
    pipelineBadMs = 0;
    // The rebuild takes a moment (the noise canceller restarts); judge the new one, not the old.
    pipelineSettleUntil = now + SETTLE_MS * 3;
  };

  const tick = () => {
    if (stopped || busy) return;
    const now = performance.now();
    const raw = track.mediaStreamTrack;

    if (!raw || raw.readyState === 'ended') {
      void healRaw('raw-ended');
      return;
    }
    // A suspended context reads silence from everything: can't judge until it runs.
    if (ctx.state !== 'running') {
      rawSilentMs = 0;
      pipelineBadMs = 0;
      return;
    }
    if (!probeClone || probeClone.readyState === 'ended') {
      buildProbe();
      return;
    }
    if (now - probeBuiltAt < SETTLE_MS) return;

    const peak = probeTap?.read() ?? -999;
    if (peak === -999) {
      rawSilentMs += TICK_MS;
      pipelineBadMs = 0;
      if (rawSilentMs >= RAW_SILENT_MS) void healRaw('raw-silent');
      return;
    }
    rawSilentMs = 0;

    // Raw mic has sound. Anything still silent downstream is ours (B).
    const problem = now >= pipelineSettleUntil ? (opts.checkPipeline?.() ?? null) : null;
    if (problem) {
      pipelineBadMs += TICK_MS;
      if (pipelineBadMs >= PIPELINE_BAD_MS) healPipeline(problem);
      return;
    }
    pipelineBadMs = 0;
    if (status !== 'ok') {
      if (status === 'healing' || status === 'failed') {
        opts.log('mic-heal-recovered', { phase: opts.phase, attempts: attempts.length });
      }
      gaveUpLogged = false;
      setStatus('ok');
    }
  };
  const interval = setInterval(tick, TICK_MS);

  return () => {
    stopped = true;
    clearInterval(interval);
    track.off(TrackEvent.Restarted, onRestarted);
    detachResume();
    probeSource?.disconnect();
    probeTap?.node.disconnect();
    probeClone?.stop();
    void ctx.close().catch(() => {});
  };
}
