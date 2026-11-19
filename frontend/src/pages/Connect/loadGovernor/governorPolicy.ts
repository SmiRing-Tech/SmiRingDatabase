/**
 * The load governor's decisions, as pure functions over measured samples — no timers, no DOM,
 * no LiveKit — so the policy can be read, simulated (scripts/simulate-load-governor.ts) and
 * re-tuned without a slow machine at hand. useLoadGovernor.ts gathers the samples and applies
 * the actions.
 *
 * Priorities (product call): audio must never break up, then screen share keeps its quality,
 * then the camera. So the governor only ever lightens *camera* video — the person's own, and the
 * other people's they receive — and lightens it faster when the audio is the one struggling.
 * Screen share is never touched, sent or received; its encoder running out of CPU counts as
 * pressure like anything else.
 *
 * Ladder, one step at a time:
 *   0. own screen share 1440p -> 1080p (only while sharing a screen taller than 1080p: 1440p is
 *      the bonus for small text, so it goes first)
 *   1. background effect 'high' -> 'balanced'. The other way is automatic too, for anyone on
 *      'balanced' however they got there (stored choice, first-run detection, the effect's own
 *      slow-frame fallback): after bgRestoreAfterMs calm with every other step back, 'high' is
 *      tried; heavy again within bgRestoreTrialMs (for a reason the background can cause) means
 *      this machine can't hold it, and it stays 'balanced' for the call. Desktop and the worker
 *      pipeline only, and not when the person picked 'balanced' themselves during this call
 *      (bgUpgradable).
 *   2. receive 1: other people's cameras shown small arrive at 10fps (receiveFpsController.ts)
 *   3. camera 540p / 15fps, segmentation 10/s (no notice: hardly visible)
 *   4. receive 2: ones shown large capped at 360p (frame rate kept — a large tile at 10fps visibly
 *      stutters, and 720p -> 360p cuts its decode ~70%)
 *   5. camera 360p / 10fps, segmentation 5/s (the floor: segmentation never under half the
 *      camera's frame rate)
 *   6. receive 3: small ones at 5fps, large ones at 10fps, and a screen share being received at half
 *      its frame rate (its resolution — the legibility of its text — is never touched)
 *   6b. receive 4: every camera capped at 180p
 *   6c. receive 5: large ones at 5fps too
 *      (2b/6b/6c added 2026-11-19: frame rate alone left a slow machine in a 10-person call decoding
 *      seven 720p streams and overloaded for the whole call. Details in receiveFpsController.ts.)
 *   7. own screen share AV1 -> VP8 1080p (lib/video/screenShare.ts; a republish, one-way for the
 *      rest of that share, and remembered so the next share starts on VP8)
 *   8. photo mode: the camera keeps running but sends one still frame every PHOTO interval (more
 *      seconds apart while still overloaded), each composited with its own matte; others see the
 *      last frame with a small badge. Replaced "camera off" on 2026-11-19: with the camera's
 *      encoding and background effect down to one frame a second or less, turning it off
 *      wouldn't take away any load that matters. Comes back automatically like the others.
 *   9. own screen share VP8 at 720p, the floor for a share (decided 2026-10-15)
 * Steps 7 and 9 only apply while sharing; screen share outranks the camera, so the camera goes
 * first except for that 720p floor, which is worse than losing one's camera — unless the AV1
 * share's own encoder is the overload ('share-encode'): then step 7 comes first.
 * Receiving steps come first because they only change what this person sees; the camera steps
 * change what everyone sees of them. A step that would change nothing is skipped: the camera
 * steps while the camera is off, the receiving steps when nothing received could be slowed down
 * (no cameras, or only senders without temporal layers — iPhones, Safari, H.264).
 * Steps 0 and 2-9 come back automatically after a calm stretch, most recent first, with backoff if
 * they relapse. No notice for the receiving steps: they only affect this person's own view.
 * (Moving noise cancellation to the server slots in before 8 once it exists.)
 */

export type VideoLevel = 0 | 1 | 2;
export type ReceiveLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface VideoProfile {
  width: number;
  height: number;
  frameRate: number;
  /** Background effect segmentation rate at this level, and how it's enforced. */
  segmentationFps: number;
  segmentationScheduler: 'interval' | 'exact';
}

/**
 * Levels 1-2 relative to whatever the device captures normally (level 0): never *raise* a
 * phone's 360p to 540p just because that's what level 1 means on a laptop.
 */
export function videoProfileFor(level: VideoLevel, base: VideoProfile): VideoProfile {
  if (level === 0) return base;
  const target =
    level === 1
      ? { width: 960, height: 540, frameRate: 15, segmentationFps: 10 }
      : { width: 640, height: 360, frameRate: 10, segmentationFps: 5 };
  const frameRate = Math.min(base.frameRate, target.frameRate);
  return {
    width: Math.min(base.width, target.width),
    height: Math.min(base.height, target.height),
    frameRate,
    // Never under half the camera rate; never above it either.
    segmentationFps: Math.min(frameRate, Math.max(target.segmentationFps, frameRate / 2)),
    segmentationScheduler: 'exact',
  };
}

/** One measurement window (the governor samples every couple of seconds). */
export interface LoadSample {
  t: number;
  intervalMs: number;
  /** Hidden tabs are deprioritised by the browser — their numbers say nothing about the machine. */
  visible: boolean;
  cameraOn: boolean;
  sharing: boolean;
  /** Share of the window the camera or screen-share encoder was CPU-limited (worst layer), 0..1. */
  encoderCpuFraction?: number;
  /** Worst lateness of a 100ms main-thread timer in the window. */
  mainLagMaxMs: number;
  /** Long tasks on the main thread, ms per second (Chromium only; 0 elsewhere). */
  longTaskMsPerSec: number;
  /** The background effect is running on a live camera (it keeps reporting while the camera is off). */
  bgActive: boolean;
  /** Whole-machine CPU pressure, worst in the window: 0 nominal .. 3 critical (Chromium only). Telemetry only. */
  cpuPressure?: number;
  /**
   * Whole-machine CPU contention (lib/cpuProbe.worker): the same fixed work's duration, avg and
   * worst in the window, and the probe worker's worst timer lateness. Telemetry only.
   */
  cpuProbe?: { workMsAvg: number; workMsMax: number; lateMsMax: number };
  /** Page frame pacing while visible (requestAnimationFrame): frames/s and the longest gap, ms. Telemetry only. */
  frames?: { fps: number; maxGapMs: number };
  /** Longest gap between camera frames leaving the background effect, ms (worker pipeline only). Telemetry only. */
  bgMaxGapMs?: number;
  /** Average wait for a frame's own matte (matteSync / photo mode). Telemetry only. */
  bgSyncWaitMs?: number;
  bgFps?: number;
  bgExpectedFps?: number;
  /** Background effect cost per frame (all its threads), ms. */
  bgCostMs?: number;
  audioActive: boolean;
  audioChunks: number;
  /** Chunks at the lightest noise-cancel setting, or sent through unprocessed. */
  audioStressedChunks: number;
  audioPassthroughChunks: number;
  audioUnderruns: number;
  audioOverloaded: boolean;
  /**
   * Receiving side: decoding and showing everyone else's video. Recorded for telemetry only —
   * not judged yet (lightening what's received is a later step).
   */
  recv?: ReceiveStats;
  recvControl?: ReceiveControl;
  /** Network and what this device sends. Telemetry only — not judged. */
  net?: NetStats;
  cameraSend?: SendStats;
  shareSend?: SendStats;
  /** The voice leveler on the outgoing mic (lib/audio/voiceFinish). Telemetry only. */
  leveler?: { gainAvgDb: number; gainMaxDb: number; speakingFraction: number; speechDb: number | null; floorDb: number };
  /** React re-rendering the call screen (lib/renderMeter). Telemetry only — not judged. */
  render?: RenderStats;
}

export interface RenderStats {
  perSec: number;
  /** Main-thread ms per second spent rendering + committing. */
  msPerSec: number;
  /** Slowest single pass in the window, ms. */
  maxMs: number;
}

export interface ReceiveStats {
  /** Remote video streams being received (cameras and screen shares). */
  streams: number;
  /** Frames decoded per second, all streams together. */
  decodedFps: number;
  /** Average decode time per frame, ms. */
  decodeMsPerFrame?: number;
  /** Frames dropped (decoded but never shown, or lost before decoding) per second. */
  droppedPerSec: number;
  /** Video freezes the browser detected in the window (Chromium). */
  freezes: number;
  /** Tallest stream received, px. */
  maxHeight: number;
  /** Per stream, to tell whose video froze. Telemetry only. */
  perStream?: StreamStats[];
}

export interface StreamStats {
  /** Sender's participant identity. */
  identity: string;
  source: 'camera' | 'share';
  fps: number;
  freezes: number;
  /** Time spent frozen in the window, ms (Chromium's totalFreezesDuration). */
  freezeMs: number;
  height: number;
}

export interface NetStats {
  /** Everything this device sends / receives, kbps. */
  upKbps?: number;
  downKbps?: number;
  /** The browser's estimate of the usable uplink (what the encoders are given to share), kbps. */
  bweKbps?: number;
  rttMs?: number;
}

/** One outgoing video (all its simulcast layers together). */
export interface SendStats {
  kbps: number;
  /** Tallest layer actually sent, px, and its frame rate. */
  height: number;
  fps: number;
  /** Encode time per frame of that layer, ms. */
  encodeMs?: number;
  /** Share of the window the encoder was held back by the uplink / by CPU, 0..1. */
  bandwidthLimited?: number;
  cpuLimited?: number;
}

/** What the receiving steps are doing (receiveFpsController.ts). Telemetry only. */
export interface ReceiveControl {
  /** Remote cameras currently asked for fewer frames. */
  throttled: number;
  /** Remote cameras found to have no temporal layers (nothing to slow down). */
  noLayers: number;
  /** Remote cameras asked for a lower resolution layer (receive 4). */
  capped?: number;
}

/**
 * Every number the governor judges by. Only this object should need to change when re-tuning.
 *
 * Calibrated 2026-10-14 between two measured extremes (telemetry + a diagnostics log):
 *  - an M4 MacBook Air (10 cores) with 17 `yes` processes and three 30000-fish WebGL aquariums
 *    running: encoder never CPU-limited (0%), background effect never under 82% of camera frames,
 *    timer lag p95 under 90ms (single 600-900ms spikes on UI actions), long tasks <=65ms/s,
 *    background cost <=5ms/frame, 2 single playback underruns in 18 minutes;
 *  - a 2019 MacBook Air (2 cores) in a real call that was unusable: encoder CPU-limited in 68% of
 *    samples, background effect mostly under 45% of camera frames, 78 underruns.
 * The encoder and background-frame-rate signals separate the two cleanly; main-thread lag spikes
 * on both, so it only counts when it lasts (as everything does — see escalateAfterMs).
 */
export const GOVERNOR_THRESHOLDS = {
  /** Encoder CPU-limited for at least this share of a window = overloaded; under calm = calm. */
  encoderCpuOverload: 0.4,
  encoderCpuCalm: 0.1,
  /** Main thread: worst timer lateness in a window. */
  mainLagOverloadMs: 400,
  mainLagCalmMs: 150,
  /** Long tasks, ms per second. */
  longTaskOverloadMsPerSec: 300,
  longTaskCalmMsPerSec: 80,
  /** Background effect processing fewer than this share of camera frames = overloaded. */
  bgFpsRatioOverload: 0.6,
  bgFpsRatioCalm: 0.8,
  /** Background effect cost per frame (both its threads), ms. */
  bgCostOverloadMs: 25,
  bgCostCalmMs: 12,
  /** Share of noise-cancel chunks at its lightest setting/passed through. */
  audioStressOverload: 0.5,
  audioStressCalm: 0.1,
  /** Playback underruns in one window that mean the audio is breaking up (a lone one happens on
   *  a healthy machine now and then). Any passthrough chunk counts regardless. */
  audioUnderrunOverload: 2,
  /**
   * Receiving side: remote video frames dropped per second, and decode time per frame (both
   * stretch out when the CPU can't keep up — a Pixel 7 decoded at 22-50ms/frame while starved).
   * Calibrated 2026-10-15 on a 70-minute weekly meeting (3 coping machines: M4 Mac, two Intel Arc
   * Windows laptops, up to 3 streams incl. 1080p share): decode p99 <=2.7ms, max 9ms; Android
   * hardware decode of 720p runs 7-10ms when healthy (lab), hence the calm line at 15. Drops come
   * as isolated bursts (up to 16/s in one window, at most 2 windows in a row) — never the 4+
   * consecutive windows escalation needs — so 3/s only counts when it persists.
   */
  recvDropOverloadPerSec: 3,
  recvDropCalmPerSec: 0.5,
  recvDecodeOverloadMs: 25,
  recvDecodeCalmMs: 15,
  /**
   * The screen share's own encoder: busy share of one core (ms/frame x fps / 1000), or one frame's
   * encode time. Needed because an AV1 encoder that's drowning still reports no CPU limitation:
   * on 2026-10-16 an M4 sharing a scrolled/clicked browser in AV1 took 12-40ms/frame with spikes to
   * 95-400ms while qualityLimitationReason stayed 'none'. VP8 at 1080p runs ~11ms x 15fps = 0.17.
   */
  shareEncodeOverloadLoad: 0.4,
  shareEncodeOverloadMs: 60,
  shareEncodeCalmLoad: 0.15,
  shareEncodeCalmMs: 25,
  /** Overloaded this long, continuously, before stepping down. */
  escalateAfterMs: 8_000,
  /** ...or this long when the audio is the one in trouble (it comes first). */
  escalateAfterAudioMs: 4_000,
  /** After any change, give it this long to take effect before judging again. */
  settleMs: 15_000,
  settleAudioMs: 6_000,
  /** Calm this long before undoing a step (times the backoff). */
  recoverAfterMs: 60_000,
  /** Overloaded again within this long of a recovery = the recovery didn't hold. */
  relapseWindowMs: 30_000,
  maxRecoverBackoff: 8,
  /** A recovery that held this long resets the backoff. */
  backoffResetMs: 300_000,
  /** Calm this long, with every other step undone, before trying the background on 'high' again. */
  bgRestoreAfterMs: 300_000,
  /** Overloaded (for a background reason) within this long of that = this machine can't hold 'high'. */
  bgRestoreTrialMs: 60_000,
} as const;

/** Reasons the background effect itself can be behind (see the 'high' restore trial). */
const BG_REASONS = ['bg-fps', 'bg-cost', 'main-lag', 'long-tasks'];

export type GovernorThresholds = { [K in keyof typeof GOVERNOR_THRESHOLDS]: number };

export type Pressure = 'overloaded' | 'neutral' | 'calm';

export interface Verdict {
  pressure: Pressure;
  /** Which signals were over their overload line (empty unless overloaded). */
  reasons: string[];
  /** The audio itself is breaking up or about to: step down on the shorter clocks. */
  audioUrgent: boolean;
}

export function classify(sample: LoadSample, T: GovernorThresholds = GOVERNOR_THRESHOLDS): Verdict {
  // A hidden tab is judged too, on what stays meaningful there: the audio, the encoders and the
  // share's encode load. What Chrome throttles in background tabs — main-thread timers, the
  // background effect, rendering received video — is left out. (It used to judge nothing at all
  // while hidden, which is every screen share: the presenter is looking at what they share. On
  // 2026-10-16 the noise cancel sat at its lightest setting for a whole share and the governor
  // never moved.)
  const visible = sample.visible;
  const reasons: string[] = [];
  let calm = true;

  const cpu = sample.encoderCpuFraction;
  if (cpu !== undefined) {
    if (cpu >= T.encoderCpuOverload) reasons.push('encoder');
    if (cpu >= T.encoderCpuCalm) calm = false;
  }

  const share = sample.shareSend;
  if (share?.encodeMs !== undefined && share.fps > 0) {
    const load = (share.encodeMs * share.fps) / 1000;
    if (load >= T.shareEncodeOverloadLoad || share.encodeMs >= T.shareEncodeOverloadMs) reasons.push('share-encode');
    if (load >= T.shareEncodeCalmLoad || share.encodeMs >= T.shareEncodeCalmMs) calm = false;
  }

  if (visible && sample.mainLagMaxMs >= T.mainLagOverloadMs) reasons.push('main-lag');
  if (visible && sample.longTaskMsPerSec >= T.longTaskOverloadMsPerSec) reasons.push('long-tasks');
  if (visible && (sample.mainLagMaxMs >= T.mainLagCalmMs || sample.longTaskMsPerSec >= T.longTaskCalmMsPerSec)) calm = false;

  if (visible && sample.bgActive && sample.bgFps !== undefined && sample.bgExpectedFps) {
    const ratio = sample.bgFps / sample.bgExpectedFps;
    if (ratio < T.bgFpsRatioOverload) reasons.push('bg-fps');
    if (ratio < T.bgFpsRatioCalm) calm = false;
  }
  if (visible && sample.bgActive && sample.bgCostMs !== undefined) {
    if (sample.bgCostMs >= T.bgCostOverloadMs) reasons.push('bg-cost');
    if (sample.bgCostMs >= T.bgCostCalmMs) calm = false;
  }

  if (visible && sample.recv?.streams) {
    if (sample.recv.droppedPerSec >= T.recvDropOverloadPerSec) reasons.push('recv-drop');
    if (sample.recv.droppedPerSec >= T.recvDropCalmPerSec) calm = false;
    const decodeMs = sample.recv.decodeMsPerFrame;
    if (decodeMs !== undefined) {
      if (decodeMs >= T.recvDecodeOverloadMs) reasons.push('recv-decode');
      if (decodeMs >= T.recvDecodeCalmMs) calm = false;
    }
  }

  let audioUrgent = false;
  if (sample.audioActive && sample.audioChunks > 0) {
    const stress = sample.audioStressedChunks / sample.audioChunks;
    if (stress >= T.audioStressOverload) reasons.push('audio-stress');
    if (stress >= T.audioStressCalm) calm = false;
  }
  if (sample.audioPassthroughChunks > 0 || sample.audioUnderruns >= T.audioUnderrunOverload) {
    reasons.push(sample.audioPassthroughChunks > 0 ? 'audio-passthrough' : 'audio-underrun');
    audioUrgent = true;
  }
  if (sample.audioPassthroughChunks > 0 || sample.audioUnderruns > 0) calm = false;

  if (reasons.length > 0) {
    return { pressure: 'overloaded', reasons, audioUrgent: audioUrgent || reasons.includes('audio-stress') };
  }
  return { pressure: calm ? 'calm' : 'neutral', reasons: [], audioUrgent: false };
}

export interface GovernorState {
  bgDowngraded: boolean;
  video: VideoLevel;
  recv: ReceiveLevel;
  /** This share was republished as VP8 (step 7). Cleared when the share ends. */
  shareVp8: boolean;
  /** This share is capped at 720p (step 9). Cleared when the share ends. */
  share720: boolean;
  /** This share is capped at 1080p instead of 1440p (step 0). Cleared when the share ends. */
  share1080: boolean;
  /** The last step down was step 7 (see the settle rule in stepGovernor). */
  lastWasShareSwitch?: boolean;
  /** Photo mode (step 8). */
  photo: boolean;
  /** When the background was last put back on 'high' (the restore trial), or null. */
  bgRestoredAt: number | null;
  /** The restore trial failed: 'high' is too much for this machine, for the rest of the call. */
  bgRestoreBlocked: boolean;
  overloadedSince: number | null;
  calmSince: number | null;
  lastChangeAt: number;
  lastRecoveryAt: number | null;
  recoverBackoff: number;
}

export function initialGovernorState(now: number): GovernorState {
  return {
    bgDowngraded: false,
    video: 0,
    recv: 0,
    shareVp8: false,
    share720: false,
    share1080: false,
    photo: false,
    bgRestoredAt: null,
    bgRestoreBlocked: false,
    overloadedSince: null,
    calmSince: null,
    lastChangeAt: now,
    lastRecoveryAt: null,
    recoverBackoff: 1,
  };
}

export type GovernorAction =
  | { kind: 'bg-balanced' }
  | { kind: 'bg-high' }
  | { kind: 'video'; level: VideoLevel; direction: 'down' | 'up' }
  | { kind: 'recv'; level: ReceiveLevel; direction: 'down' | 'up' }
  | { kind: 'share-vp8' }
  | { kind: 'share-720'; direction: 'down' | 'up' }
  | { kind: 'share-1080'; direction: 'down' | 'up' }
  | { kind: 'photo'; direction: 'down' | 'up' };

/** What the governor needs to know about the call, beyond the sample. */
export interface GovernorContext {
  /** The background effect's model, or null when the effect is off. */
  bgQuality: 'high' | 'balanced' | null;
  /** Whether 'balanced' may be tried on 'high' (see step 1). Unset = no. */
  bgUpgradable?: boolean;
  cameraOn: boolean;
  /**
   * Whether going to each receive level from here would actually slow something down (some
   * remote camera that would get a lower target and has temporal layers). Unset = no.
   */
  recvRelief?: { 1: boolean; 2: boolean; 3?: boolean; 4?: boolean; 5?: boolean };
  /** The codec of this person's own screen share, or null/undefined when not sharing. */
  shareCodec?: 'av1' | 'vp8' | 'h264' | null;
  /** Height the own share is captured at right now (for step 0: only worth it above 1080p). */
  shareHeight?: number;
}

export interface GovernorStep {
  state: GovernorState;
  verdict: Verdict;
  action?: GovernorAction;
}

/** Advances the governor by one sample. Returns at most one action. */
export function stepGovernor(
  prev: GovernorState,
  sample: LoadSample,
  ctx: GovernorContext,
  T: GovernorThresholds = GOVERNOR_THRESHOLDS,
): GovernorStep {
  const now = sample.t;
  const state = { ...prev };
  const verdict = classify(sample, T);

  // A share's steps belong to that share: the next one starts fresh.
  if (!ctx.shareCodec) {
    state.shareVp8 = false;
    state.share720 = false;
    state.share1080 = false;
  }

  if (state.lastRecoveryAt !== null && now - state.lastRecoveryAt >= T.backoffResetMs) {
    state.recoverBackoff = 1;
  }

  if (verdict.pressure === 'overloaded') {
    state.overloadedSince ??= now;
    state.calmSince = null;
  } else if (verdict.pressure === 'calm') {
    state.calmSince ??= now;
    state.overloadedSince = null;
  } else {
    state.overloadedSince = null;
    state.calmSince = null;
  }

  const sinceChange = now - state.lastChangeAt;

  if (state.overloadedSince !== null) {
    const escalateAfter = verdict.audioUrgent ? T.escalateAfterAudioMs : T.escalateAfterMs;
    // A share republish (step 7) takes a while to show its effect — the new encoder starts on a
    // keyframe and ramps up — so it always gets the full settle, even when the audio is urgent.
    const settle = verdict.audioUrgent && !state.lastWasShareSwitch ? T.settleAudioMs : T.settleMs;
    if (now - state.overloadedSince >= escalateAfter && sinceChange >= settle) {
      const action = nextStepDown(state, ctx, verdict.reasons);
      if (action) {
        if (action.kind === 'bg-balanced') {
          // The restore trial: heavy again soon after going back to 'high', for a reason the
          // background can cause -> this machine can't hold it. Later than that, or for another
          // reason, may just be a passing load: wait for calm and try again.
          const trialFailed =
            state.bgRestoredAt !== null &&
            now - state.bgRestoredAt < T.bgRestoreTrialMs &&
            verdict.reasons.some((r) => BG_REASONS.includes(r));
          if (trialFailed) state.bgRestoreBlocked = true;
          state.bgRestoredAt = null;
        }
        if (state.lastRecoveryAt !== null && now - state.lastRecoveryAt < T.relapseWindowMs) {
          state.recoverBackoff = Math.min(T.maxRecoverBackoff, state.recoverBackoff * 2);
        }
        applyToState(state, action);
        state.lastChangeAt = now;
        state.lastWasShareSwitch = action.kind === 'share-vp8';
        state.overloadedSince = null;
        return { state, verdict, action };
      }
    }
  }

  const undo = state.calmSince !== null ? nextStepUp(state) : null;
  if (
    undo &&
    state.calmSince !== null &&
    sinceChange >= T.settleMs &&
    now - state.calmSince >= T.recoverAfterMs * state.recoverBackoff
  ) {
    const action = undo;
    applyToState(state, action);
    state.lastChangeAt = now;
    state.lastRecoveryAt = now;
    state.calmSince = null;
    return { state, verdict, action };
  }

  // Everything else is back: try the background on 'high' after a long calm.
  if (
    !undo &&
    ctx.bgUpgradable &&
    !state.bgRestoreBlocked &&
    ctx.bgQuality === 'balanced' &&
    state.calmSince !== null &&
    sinceChange >= T.settleMs &&
    now - state.calmSince >= T.bgRestoreAfterMs
  ) {
    const action: GovernorAction = { kind: 'bg-high' };
    applyToState(state, action);
    state.bgRestoredAt = now;
    state.lastChangeAt = now;
    state.calmSince = null;
    return { state, verdict, action };
  }

  return { state, verdict };
}

/** The first step of the ladder not taken yet that would change something. */
function nextStepDown(state: GovernorState, ctx: GovernorContext, reasons: string[] = []): GovernorAction | null {
  // The AV1 share itself is what's heavy: switch it first — the camera steps wouldn't touch the cause.
  if (reasons.includes('share-encode') && ctx.shareCodec === 'av1' && !state.shareVp8) return { kind: 'share-vp8' };
  if (ctx.shareCodec && ctx.shareCodec !== 'av1' && !state.share1080 && !state.share720 && (ctx.shareHeight ?? 0) > 1080 * 1.05) {
    return { kind: 'share-1080', direction: 'down' };
  }
  if (ctx.bgQuality === 'high' && !state.bgDowngraded) return { kind: 'bg-balanced' };
  const relief = ctx.recvRelief ?? { 1: false, 2: false };
  if (state.recv < 1 && relief[1]) return { kind: 'recv', level: 1, direction: 'down' };
  if (ctx.cameraOn && state.video < 1) return { kind: 'video', level: 1, direction: 'down' };
  // Straight from 0 when level 1 had nothing to slow down (say, only cameras shown large).
  if (state.recv < 2 && relief[2]) return { kind: 'recv', level: 2, direction: 'down' };
  if (ctx.cameraOn && state.video < 2) return { kind: 'video', level: 2, direction: 'down' };
  if (state.recv < 3 && relief[3]) return { kind: 'recv', level: 3, direction: 'down' };
  if (state.recv < 4 && relief[4]) return { kind: 'recv', level: 4, direction: 'down' };
  if (state.recv < 5 && relief[5]) return { kind: 'recv', level: 5, direction: 'down' };
  if (ctx.shareCodec === 'av1' && !state.shareVp8) return { kind: 'share-vp8' };
  if (ctx.cameraOn && !state.photo) return { kind: 'photo', direction: 'down' };
  if (ctx.shareCodec && ctx.shareCodec !== 'av1' && !state.share720) return { kind: 'share-720', direction: 'down' };
  return null;
}

/**
 * Undo the most recent step still in effect: the ladder in reverse (share 720p, photo, receive 5, 4,
 * 3, camera 2, receive 2, camera 1, receive 1, share 1080p). The share's switch to VP8 isn't undone
 * mid-share — each undo would be another republish the viewers see. The background's 'high' has
 * its own, slower path (see stepGovernor).
 */
function nextStepUp(state: GovernorState): GovernorAction | null {
  const cameraSteps = !state.photo;
  if (state.share720) return { kind: 'share-720', direction: 'up' };
  if (state.photo) return { kind: 'photo', direction: 'up' };
  if (state.recv === 5) return { kind: 'recv', level: 4, direction: 'up' };
  if (state.recv === 4) return { kind: 'recv', level: 3, direction: 'up' };
  if (state.recv === 3) return { kind: 'recv', level: 2, direction: 'up' };
  if (cameraSteps && state.video === 2) return { kind: 'video', level: 1, direction: 'up' };
  if (state.recv === 2) return { kind: 'recv', level: 1, direction: 'up' };
  if (cameraSteps && state.video === 1) return { kind: 'video', level: 0, direction: 'up' };
  if (state.recv === 1) return { kind: 'recv', level: 0, direction: 'up' };
  if (state.share1080) return { kind: 'share-1080', direction: 'up' };
  return null;
}

function applyToState(state: GovernorState, action: GovernorAction) {
  if (action.kind === 'bg-balanced') state.bgDowngraded = true;
  else if (action.kind === 'bg-high') state.bgDowngraded = false;
  else if (action.kind === 'video') state.video = action.level;
  else if (action.kind === 'recv') state.recv = action.level;
  else if (action.kind === 'share-vp8') state.shareVp8 = true;
  else if (action.kind === 'share-720') state.share720 = action.direction === 'down';
  else if (action.kind === 'share-1080') state.share1080 = action.direction === 'down';
  else state.photo = action.direction === 'down';
}
