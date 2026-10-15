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
 *   1. background effect 'high' -> 'balanced' (not restored automatically)
 *   2. receive 1: other people's cameras shown small arrive at 10fps (receiveFpsController.ts)
 *   3. camera 540p / 15fps, segmentation 10/s
 *   4. receive 2: small ones at 5fps, ones shown large at 10fps
 *   5. camera 360p / 10fps, segmentation 5/s (the floor: segmentation never under half the
 *      camera's frame rate)
 *   6. receive 3: a screen share being received arrives at half its frame rate (its resolution —
 *      the legibility of its text — is never touched)
 *   7. own screen share AV1 -> VP8 1080p (lib/video/screenShare.ts; a republish, one-way for the
 *      rest of that share, and remembered so the next share starts on VP8)
 *   8. camera off, with a dialog saying why (the person can turn it back on; it then resumes at 5)
 *   9. own screen share VP8 at 720p, the floor for a share (decided 2026-10-15)
 * Steps 7 and 9 only apply while sharing; screen share outranks the camera, so the camera goes
 * first except for that 720p floor, which is worse than losing one's camera.
 * Receiving steps come first because they only change what this person sees; the camera steps
 * change what everyone sees of them. A step that would change nothing is skipped: the camera
 * steps while the camera is off, the receiving steps when nothing received could be slowed down
 * (no cameras, or only senders without temporal layers — iPhones, Safari, H.264).
 * Steps 2-6 and 9 come back automatically after a calm stretch, most recent first, with backoff if
 * they relapse. No notice for the receiving steps: they only affect this person's own view.
 * (Moving noise cancellation to the server slots in before 8 once it exists.)
 */

export type VideoLevel = 0 | 1 | 2;
export type ReceiveLevel = 0 | 1 | 2 | 3;

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
  bgActive: boolean;
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
  /** After the person turns the camera back on themselves, don't switch it off again for this long. */
  cameraResumeGraceMs: 60_000,
} as const;

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
  if (!sample.visible) return { pressure: 'neutral', reasons: ['hidden'], audioUrgent: false };

  const reasons: string[] = [];
  let calm = true;

  const cpu = sample.encoderCpuFraction;
  if (cpu !== undefined) {
    if (cpu >= T.encoderCpuOverload) reasons.push('encoder');
    if (cpu >= T.encoderCpuCalm) calm = false;
  }

  if (sample.mainLagMaxMs >= T.mainLagOverloadMs) reasons.push('main-lag');
  if (sample.longTaskMsPerSec >= T.longTaskOverloadMsPerSec) reasons.push('long-tasks');
  if (sample.mainLagMaxMs >= T.mainLagCalmMs || sample.longTaskMsPerSec >= T.longTaskCalmMsPerSec) calm = false;

  if (sample.bgActive && sample.bgFps !== undefined && sample.bgExpectedFps) {
    const ratio = sample.bgFps / sample.bgExpectedFps;
    if (ratio < T.bgFpsRatioOverload) reasons.push('bg-fps');
    if (ratio < T.bgFpsRatioCalm) calm = false;
  }
  if (sample.bgActive && sample.bgCostMs !== undefined) {
    if (sample.bgCostMs >= T.bgCostOverloadMs) reasons.push('bg-cost');
    if (sample.bgCostMs >= T.bgCostCalmMs) calm = false;
  }

  if (sample.recv?.streams) {
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
  cameraOffByGovernor: boolean;
  overloadedSince: number | null;
  calmSince: number | null;
  lastChangeAt: number;
  lastRecoveryAt: number | null;
  recoverBackoff: number;
  /** When the person turned the camera back on after the governor switched it off. */
  cameraResumedAt: number | null;
}

export function initialGovernorState(now: number): GovernorState {
  return {
    bgDowngraded: false,
    video: 0,
    recv: 0,
    shareVp8: false,
    share720: false,
    cameraOffByGovernor: false,
    overloadedSince: null,
    calmSince: null,
    lastChangeAt: now,
    lastRecoveryAt: null,
    recoverBackoff: 1,
    cameraResumedAt: null,
  };
}

export type GovernorAction =
  | { kind: 'bg-balanced' }
  | { kind: 'video'; level: VideoLevel; direction: 'down' | 'up' }
  | { kind: 'recv'; level: ReceiveLevel; direction: 'down' | 'up' }
  | { kind: 'share-vp8' }
  | { kind: 'share-720'; direction: 'down' | 'up' }
  | { kind: 'camera-off'; withBackground: boolean };

/** What the governor needs to know about the call, beyond the sample. */
export interface GovernorContext {
  /** The background effect's model, or null when the effect is off. */
  bgQuality: 'high' | 'balanced' | null;
  cameraOn: boolean;
  /**
   * Whether going to each receive level from here would actually slow something down (some
   * remote camera that would get a lower target and has temporal layers). Unset = no.
   */
  recvRelief?: { 1: boolean; 2: boolean; 3?: boolean };
  /** The codec of this person's own screen share, or null/undefined when not sharing. */
  shareCodec?: 'av1' | 'vp8' | 'h264' | null;
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
  }

  // The person turned the camera back on after the governor switched it off: resume at the
  // lightest video level rather than from the top.
  if (state.cameraOffByGovernor && ctx.cameraOn) {
    state.cameraOffByGovernor = false;
    state.video = 2;
    state.cameraResumedAt = now;
    state.lastChangeAt = now;
    state.overloadedSince = null;
    state.calmSince = null;
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
    const settle = verdict.audioUrgent ? T.settleAudioMs : T.settleMs;
    if (now - state.overloadedSince >= escalateAfter && sinceChange >= settle) {
      const cameraOffAllowed = state.cameraResumedAt === null || now - state.cameraResumedAt >= T.cameraResumeGraceMs;
      const action = nextStepDown(state, ctx, cameraOffAllowed);
      if (action) {
        if (state.lastRecoveryAt !== null && now - state.lastRecoveryAt < T.relapseWindowMs) {
          state.recoverBackoff = Math.min(T.maxRecoverBackoff, state.recoverBackoff * 2);
        }
        applyToState(state, action);
        state.lastChangeAt = now;
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

  return { state, verdict };
}

/** The first step of the ladder not taken yet that would change something. */
function nextStepDown(state: GovernorState, ctx: GovernorContext, cameraOffAllowed: boolean): GovernorAction | null {
  if (ctx.bgQuality === 'high' && !state.bgDowngraded) return { kind: 'bg-balanced' };
  const relief = ctx.recvRelief ?? { 1: false, 2: false };
  if (state.recv < 1 && relief[1]) return { kind: 'recv', level: 1, direction: 'down' };
  if (ctx.cameraOn && state.video < 1) return { kind: 'video', level: 1, direction: 'down' };
  // Straight from 0 when level 1 had nothing to slow down (say, only cameras shown large).
  if (state.recv < 2 && relief[2]) return { kind: 'recv', level: 2, direction: 'down' };
  if (ctx.cameraOn && state.video < 2) return { kind: 'video', level: 2, direction: 'down' };
  if (state.recv < 3 && relief[3]) return { kind: 'recv', level: 3, direction: 'down' };
  if (ctx.shareCodec === 'av1' && !state.shareVp8) return { kind: 'share-vp8' };
  if (ctx.cameraOn && cameraOffAllowed) return { kind: 'camera-off', withBackground: ctx.bgQuality !== null };
  if (ctx.shareCodec && ctx.shareCodec !== 'av1' && !state.share720) return { kind: 'share-720', direction: 'down' };
  return null;
}

/**
 * Undo the most recent step still in effect: the ladder in reverse (share 720p, receive 3, camera
 * 2, receive 2, camera 1, receive 1). The share's switch to VP8 isn't undone mid-share — each
 * undo would be another republish the viewers see.
 */
function nextStepUp(state: GovernorState): GovernorAction | null {
  const cameraSteps = !state.cameraOffByGovernor;
  if (state.share720) return { kind: 'share-720', direction: 'up' };
  if (state.recv === 3) return { kind: 'recv', level: 2, direction: 'up' };
  if (cameraSteps && state.video === 2) return { kind: 'video', level: 1, direction: 'up' };
  if (state.recv === 2) return { kind: 'recv', level: 1, direction: 'up' };
  if (cameraSteps && state.video === 1) return { kind: 'video', level: 0, direction: 'up' };
  if (state.recv === 1) return { kind: 'recv', level: 0, direction: 'up' };
  return null;
}

function applyToState(state: GovernorState, action: GovernorAction) {
  if (action.kind === 'bg-balanced') state.bgDowngraded = true;
  else if (action.kind === 'video') state.video = action.level;
  else if (action.kind === 'recv') state.recv = action.level;
  else if (action.kind === 'share-vp8') state.shareVp8 = true;
  else if (action.kind === 'share-720') state.share720 = action.direction === 'down';
  else state.cameraOffByGovernor = true;
}
