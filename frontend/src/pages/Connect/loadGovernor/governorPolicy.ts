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
 *   0b. camera 20fps -> 15fps at 720p, then 0c. -> 10fps (cam-fps; with the background effect on).
 *      Every frame sent is composited with its own frame's matte at every level
 *      (backgroundCompositor.worker), so the frame rate *is* the segmentation rate: fewer frames is
 *      fewer inferences, composites and encodes at once. 10fps comes before 'balanced' (product
 *      call, 2026-11-20: 'high' as long as possible): measured on a 10-core Mac, 'high' at 10fps
 *      segments ~27ms/s, about what 'balanced' does at 20fps (~32ms/s). (Until 2026-11-20 0b
 *      halved segmentation at 20fps, which left every other frame cut out with the previous
 *      frame's matte.)
 *   1. background effect 'high' -> 'balanced'. The other way is automatic too, for anyone on
 *      'balanced' however they got there (stored choice, first-run detection, the effect's own
 *      slow-frame fallback): after bgRestoreAfterMs calm with every other step back, 'high' is
 *      tried; heavy again within bgRestoreTrialMs (for a reason the background can cause) means
 *      this machine can't hold it, and it stays 'balanced' for the call. Desktop and the worker
 *      pipeline only, and not when the person picked 'balanced' themselves during this call
 *      (bgUpgradable).
 *   2. receive 1: other people's cameras shown small arrive at 10fps (receiveFpsController.ts)
 *   3. camera 540p / 10fps (no notice)
 *   4. receive 2: ones shown large capped at 360p (frame rate kept — a large tile at 10fps visibly
 *      stutters, and 720p -> 360p cuts its decode ~70%)
 *   5. camera 360p / 5fps (the same segmentation rates as the earlier 15fps/10fps levels, whose
 *      frames in between went out with a neighbour's matte)
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
 * they relapse. Steps taken for a brief spike (and 'high', after the effect's own fallback or a
 * spike) come back much sooner, once there's clear headroom (fastRestoreAction).
 * A call doesn't start at the top of the ladder: useLoadGovernor starts it where this browser's
 * last call settled, or at 0c with nothing remembered (startLevel.ts), as a brief episode. No notice for the receiving steps: they only affect this person's own view.
 * (Moving noise cancellation to the server slots in before 8 once it exists.)
 */

export type VideoLevel = 0 | 1 | 2;
/** Steps 0b/0c: the camera at 15fps (1) or 10fps (2), 720p kept. */
export type CamFpsStep = 0 | 1 | 2;
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
 * The camera at a level (and steps 0b/0c, `camFps` 1 = 15fps / 2 = 10fps, only at level 0), relative to
 * whatever the device captures normally (level 0): never *raise* a phone's 360p to 540p just
 * because that's what level 1 means on a laptop. Segmentation runs at the frame rate: every frame
 * sent gets its own matte (see step 0b).
 */
export function videoProfileFor(level: VideoLevel, base: VideoProfile, camFps: CamFpsStep = 0): VideoProfile {
  if (level === 0 && !camFps) return base;
  const target =
    level === 0
      ? { width: base.width, height: base.height, frameRate: camFps === 1 ? 15 : 10 }
      : level === 1
        ? { width: 960, height: 540, frameRate: 10 }
        : { width: 640, height: 360, frameRate: 5 };
  const frameRate = Math.min(base.frameRate, target.frameRate);
  return {
    width: Math.min(base.width, target.width),
    height: Math.min(base.height, target.height),
    frameRate,
    segmentationFps: frameRate,
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
  /** The window went to or from the background during this sample. */
  visibilityChanged?: boolean;
  /** Time since the window last went to or from the background (undefined = never). */
  sinceVisibilityChangeMs?: number;
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
  /** Background matte timing (backgroundCompositor.worker: matteSync / photo mode). Telemetry only. */
  bgMatte?: { delayMs?: number; ownPct?: number; forcedOut: number; unmatched?: number; staleDropped: number };
  /** Segmentation rate and timing (worker pipeline). Telemetry only. */
  bgSegment?: { perSec: number; roundTripMs?: number; workMs?: number };
  bgFps?: number;
  bgExpectedFps?: number;
  /** Background effect cost per frame (all its threads), ms. */
  bgCostMs?: number;
  /**
   * Worker pipeline: the busier worker thread's share of the window (0..1). When set, judged
   * instead of bgCostMs: time per frame on threads beside the page says little by itself, and it
   * doubled when every frame sent got its own segmentation (see WorkerBackgroundProcessor's
   * PERF_SLOW_BUSY).
   */
  bgBusy?: number;
  audioActive: boolean;
  audioChunks: number;
  /** Chunks where the noise cancel was really struggling (loadSignals audio-chunk `stressed`). */
  audioStressedChunks: number;
  audioPassthroughChunks: number;
  audioUnderruns: number;
  /**
   * Noise cancel: ms of this window played from the raw mic because processed audio was late
   * (gtcrnPlayback's raw fill). Counted directly because while the inference worker is stalled no
   * chunks finish, so the per-chunk stress share sees least exactly when it's worst (2026-11-20: up
   * to 10s at a time filled raw while the governor read 'neutral'). Unset = not measured.
   */
  audioFilledMs?: number;
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
  /**
   * What the camera delivers, before anything is done to it. Telemetry only. `captureFps`: the
   * frame rate the camera track is set to (getSettings). `fps` / `maxGapMs`: frames read from it
   * per second and the longest gap between their capture timestamps (background effect's worker
   * pipeline only); `outputWaitMsPerSec`: how long reading waited on the output.
   */
  cameraIn?: {
    captureFps?: number;
    fps?: number;
    maxGapMs?: number;
    outputWaitMsPerSec?: number;
    /** Time per second reading waited for a camera frame / writing a frame to the output waited. */
    inputWaitMsPerSec?: number;
    writeMsPerSec?: number;
  };
  /** The load-free "your connection is unstable" judgement (networkWarning.ts). Telemetry only. */
  netWarning?: { bad: boolean; shown: boolean };
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
  /** Frames per second the sender is fed (RTCStats media-source): the camera's own rate without
   *  a background effect, the effect's output with one. */
  sourceFps?: number;
  /** Encode time per frame of that layer, ms. */
  encodeMs?: number;
  /** Encoding time summed over all layers, per second of wall time (1000 = one core fully busy), ms/s. */
  encodeMsPerSec?: number;
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
  bgBusyOverload: 0.8,
  bgBusyCalm: 0.5,
  /** Share of noise-cancel chunks it was really struggling with (see audioStressedChunks). */
  audioStressOverload: 0.5,
  audioStressCalm: 0.1,
  /** Share of a window played raw because the noise cancel was late: audio-stress / not calm. */
  audioFillOverload: 0.2,
  audioFillCalm: 0.02,
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
  /**
   * After the window goes to or from the background, don't step down for this long unless the
   * audio actually breaks. The switch itself costs a few seconds of real but passing load (the
   * browser and OS redrawing, CPU pressure 'serious', background frames stalling, the noise
   * cancel briefly stressed): on 2026-11-19 a 10-core Mac went to 'balanced' and camera level 1
   * from switching windows, while staying fine for minutes at a time hidden or shown.
   */
  visibilitySwitchGraceMs: 10_000,
  /**
   * ...but at most this much grace within any switchGraceWindowMs: switching every few seconds
   * otherwise kept it on for good, and on 2026-11-19 a 70s call ran with the background effect
   * under 15fps 29% of the time without the governor stepping down once.
   */
  switchGraceBudgetMs: 10_000,
  switchGraceWindowMs: 30_000,
  /** Calm this long, with every other step undone, before trying the background on 'high' again. */
  bgRestoreAfterMs: 300_000,
  /** Overloaded (for a background reason) within this long of that = this machine can't hold 'high'. */
  bgRestoreTrialMs: 60_000,
  /**
   * Fast restore (see fastRestoreAction): steps taken for a brief overload — at most this much
   * overloaded time in all, about one step's worth — come back as soon as the machine shows clear
   * headroom for fastRestoreAfterMs, one every fastRestoreStepGapMs, instead of after the minute /
   * five minutes of calm a long or recurring overload needs. Overloaded again within
   * fastRestoreTrialMs of one = it wasn't just a spike: no fast restores for fastRestoreCooldownMs.
   * Asked for 2026-11-20: a single spike at the start of a call left the background on 'balanced'
   * for minutes on a machine then running its effect threads at 3-6%.
   */
  fastRestoreBriefOverloadMs: 12_000,
  fastRestoreAfterMs: 24_000,
  fastRestoreStepGapMs: 10_000,
  fastRestoreTrialMs: 60_000,
  fastRestoreCooldownMs: 600_000,
  /** Headroom: stricter than calm (see hasHeadroom). */
  headroomBgBusy: 0.3,
  headroomBgCostMs: 6,
  headroomBgFpsRatio: 0.9,
  headroomMainLagMs: 100,
  headroomEncoderCpu: 0.02,
  /** 'high' only comes back fast when, calm on 'high' earlier in the call, its busier worker thread
   *  ran under this. */
  headroomHighBusy: 0.3,
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

/**
 * Clear headroom, not just calm: visible and steady (hidden tabs are throttled — nothing to judge
 * by), the machine's CPU pressure nominal, the page's timers on time, no encoder CPU limits, the
 * noise cancel unstressed, and the background effect keeping its frame rate with its threads
 * mostly idle.
 */
export function hasHeadroom(sample: LoadSample, verdict: Verdict, T: GovernorThresholds = GOVERNOR_THRESHOLDS): boolean {
  if (verdict.pressure !== 'calm' || !sample.visible || sample.visibilityChanged) return false;
  if ((sample.cpuPressure ?? 0) > 0) return false;
  if (sample.mainLagMaxMs >= T.headroomMainLagMs) return false;
  if ((sample.encoderCpuFraction ?? 0) >= T.headroomEncoderCpu) return false;
  if (sample.audioStressedChunks > 0 || sample.audioUnderruns > 0 || sample.audioPassthroughChunks > 0) return false;
  if ((sample.audioFilledMs ?? 0) > 0) return false;
  if (sample.bgActive) {
    if (sample.bgBusy !== undefined ? sample.bgBusy >= T.headroomBgBusy : (sample.bgCostMs ?? 0) >= T.headroomBgCostMs) {
      return false;
    }
    if (sample.bgFps !== undefined && sample.bgExpectedFps && sample.bgFps / sample.bgExpectedFps < T.headroomBgFpsRatio) {
      return false;
    }
  }
  return true;
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

  // Not across a switch to or from the background either: the timers ran throttled for part of it.
  const steady = visible && !sample.visibilityChanged;
  if (steady && sample.mainLagMaxMs >= T.mainLagOverloadMs) reasons.push('main-lag');
  if (steady && sample.longTaskMsPerSec >= T.longTaskOverloadMsPerSec) reasons.push('long-tasks');
  if (steady && (sample.mainLagMaxMs >= T.mainLagCalmMs || sample.longTaskMsPerSec >= T.longTaskCalmMsPerSec)) calm = false;

  if (visible && sample.bgActive && sample.bgFps !== undefined && sample.bgExpectedFps) {
    const ratio = sample.bgFps / sample.bgExpectedFps;
    if (ratio < T.bgFpsRatioOverload) reasons.push('bg-fps');
    if (ratio < T.bgFpsRatioCalm) calm = false;
  }
  if (visible && sample.bgActive && sample.bgBusy !== undefined) {
    if (sample.bgBusy >= T.bgBusyOverload) reasons.push('bg-cost');
    if (sample.bgBusy >= T.bgBusyCalm) calm = false;
  } else if (visible && sample.bgActive && sample.bgCostMs !== undefined) {
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
  if (sample.audioFilledMs && sample.intervalMs > 0) {
    const filled = sample.audioFilledMs / sample.intervalMs;
    if (filled >= T.audioFillOverload && !reasons.includes('audio-stress')) reasons.push('audio-stress');
    if (filled >= T.audioFillCalm) calm = false;
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
  /** Camera at 15fps (1, step 0b) or 10fps (2, step 0c), 720p kept. */
  camFps: CamFpsStep;
  /** Samples the switch grace held off, with their length, over the last switchGraceWindowMs. */
  graceLog: { t: number; ms: number }[];
  /** When the background was last put back on 'high' (the restore trial), or null. */
  bgRestoredAt: number | null;
  /** The restore trial failed: 'high' is too much for this machine, for the rest of the call. */
  bgRestoreBlocked: boolean;
  /**
   * The overload episode the steps in effect were taken for: overloaded time in it (switch grace
   * excluded). Closed once everything is back. Decides whether they may come back fast.
   */
  episode: { overloadedMs: number } | null;
  /** Since when every sample has shown headroom (hasHeadroom), or null. */
  headroomSince: number | null;
  /** The last fast restore, and until when fast restores are off (one didn't hold). */
  fastRestoredAt: number | null;
  fastBlockedUntil: number;
  /** The background's busier worker thread on 'high' in the last calm visible sample this call. */
  highCalmBusy: number | null;
  /**
   * The call started on 'balanced' because this browser's last call settled there (startLevel):
   * 'high' is then not part of the fast restore — the frame rate comes back fast on 'balanced',
   * the known-good state, and 'high' is tried on the normal calm path.
   */
  bgRemembered?: boolean;
  /** The background's model at the previous sample (to notice the effect's own fallback). */
  lastBgQuality?: 'high' | 'balanced' | null;
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
    camFps: 0,
    graceLog: [],
    bgRestoredAt: null,
    bgRestoreBlocked: false,
    episode: null,
    headroomSince: null,
    fastRestoredAt: null,
    fastBlockedUntil: 0,
    highCalmBusy: null,
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
  | { kind: 'photo'; direction: 'down' | 'up' }
  | { kind: 'cam-fps'; step: CamFpsStep; direction: 'down' | 'up' };

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
  /** The background effect is on, so steps 0b/0c (camera 15/10fps: fewer frames segmented,
   *  composited and encoded) are the cheapest relief there is. Unset = no. */
  camFpsAvailable?: boolean;
}

export interface GovernorStep {
  state: GovernorState;
  verdict: Verdict;
  action?: GovernorAction;
  /** Overloaded, but not counted: within visibilitySwitchGraceMs of a window switch. */
  switchGrace?: boolean;
  /** This sample showed clear headroom (hasHeadroom). */
  headroom?: boolean;
  /** The action is a fast restore (see fastRestoreAction). */
  fast?: boolean;
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

  // 'high' is back by other means (the person picked it): the step isn't in effect any more.
  if (state.bgDowngraded && ctx.bgQuality === 'high') state.bgDowngraded = false;

  if (state.lastRecoveryAt !== null && now - state.lastRecoveryAt >= T.backoffResetMs) {
    state.recoverBackoff = 1;
  }

  // Right after the window went to or from the background: wait it out unless the audio broke —
  // within a budget, so switching back and forth all the time doesn't switch the governor off.
  state.graceLog = state.graceLog.filter((g) => now - g.t < T.switchGraceWindowMs);
  const graceSpent = state.graceLog.reduce((sum, g) => sum + g.ms, 0);
  const switchGrace =
    verdict.pressure === 'overloaded' &&
    sample.sinceVisibilityChangeMs !== undefined &&
    sample.sinceVisibilityChangeMs < T.visibilitySwitchGraceMs &&
    graceSpent < T.switchGraceBudgetMs &&
    !verdict.reasons.some((r) => r === 'audio-underrun' || r === 'audio-passthrough');
  if (switchGrace) state.graceLog = [...state.graceLog, { t: now, ms: sample.intervalMs }];
  const pressure = switchGrace ? 'neutral' : verdict.pressure;

  // Fast-restore bookkeeping: the episode's overloaded time, the headroom streak, what 'high'
  // costs here when things are calm.
  const headroom = hasHeadroom(sample, verdict, T);
  state.headroomSince = headroom ? (state.headroomSince ?? now) : null;
  if (ctx.bgQuality === 'high' && verdict.pressure === 'calm' && sample.visible && sample.bgActive && sample.bgBusy !== undefined) {
    state.highCalmBusy = sample.bgBusy;
  }
  if (pressure === 'overloaded') {
    state.episode = { overloadedMs: (state.episode?.overloadedMs ?? 0) + sample.intervalMs };
  }
  // The effect dropped to 'balanced' by itself (its own slow-frame fallback reacts to a couple of
  // seconds): an episode with no overload the governor saw — a spike — so 'high' may come back fast.
  if (prev.lastBgQuality === 'high' && ctx.bgQuality === 'balanced' && !state.bgDowngraded) {
    state.episode ??= { overloadedMs: 0 };
  }
  state.lastBgQuality = ctx.bgQuality;

  if (pressure === 'overloaded') {
    state.overloadedSince ??= now;
    state.calmSince = null;
  } else if (pressure === 'calm') {
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
      // Heavy right after 'high' came back, for a reason it can cause: it's the cause — straight
      // back to 'balanced' rather than through the frame-rate steps first.
      const trialRunning =
        state.bgRestoredAt !== null &&
        now - state.bgRestoredAt < T.bgRestoreTrialMs &&
        ctx.bgQuality === 'high' &&
        !state.bgDowngraded &&
        verdict.reasons.some((r) => BG_REASONS.includes(r));
      const action: GovernorAction | null = trialRunning ? { kind: 'bg-balanced' } : nextStepDown(state, ctx, verdict.reasons);
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
        // A fast restore that didn't hold: this is more than a spike. The slow paths take it from
        // here, and no fast ones for a while.
        if (state.fastRestoredAt !== null && now - state.fastRestoredAt < T.fastRestoreTrialMs) {
          state.fastBlockedUntil = now + T.fastRestoreCooldownMs;
        }
        applyToState(state, action);
        state.lastChangeAt = now;
        state.lastWasShareSwitch = action.kind === 'share-vp8';
        state.overloadedSince = null;
        return { state, verdict, action, headroom };
      }
    }
  }

  const fast = fastRestoreAction(state, ctx, now, T);
  if (fast) {
    applyToState(state, fast);
    if (fast.kind === 'bg-high') state.bgRestoredAt = now;
    state.lastChangeAt = now;
    state.lastRecoveryAt = now;
    state.fastRestoredAt = now;
    state.calmSince = null;
    return { state, verdict, action: fast, headroom, fast: true };
  }

  const undo = state.calmSince !== null ? nextStepUp(state, ctx) : null;
  if (
    undo &&
    state.calmSince !== null &&
    sinceChange >= T.settleMs &&
    now - state.calmSince >= T.recoverAfterMs * state.recoverBackoff
  ) {
    const action = undo;
    applyToState(state, action);
    if (action.kind === 'bg-high') state.bgRestoredAt = now;
    state.lastChangeAt = now;
    state.lastRecoveryAt = now;
    state.calmSince = null;
    return { state, verdict, action, headroom };
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
    return { state, verdict, action, headroom };
  }

  // Nothing left to undo: the episode is over.
  if (!undo && !nextStepUp(state, ctx) && !(ctx.bgQuality === 'balanced' && bgFastUpgradable(state, ctx, T))) {
    state.episode = null;
  }

  return { state, verdict, switchGrace: switchGrace || undefined, headroom };
}

/** 'high' may come back on the fast path: allowed at all, and known to run light here. */
function bgFastUpgradable(state: GovernorState, ctx: GovernorContext, T: GovernorThresholds): boolean {
  return !!ctx.bgUpgradable && !state.bgRestoreBlocked && state.highCalmBusy !== null && state.highCalmBusy < T.headroomHighBusy;
}

/**
 * The next fast restore, or null (see GOVERNOR_THRESHOLDS.fastRestoreBriefOverloadMs): the steps
 * in effect were taken for a brief overload, headroom has held for fastRestoreAfterMs, and the
 * last change was at least fastRestoreStepGapMs ago. Same order as the slow path, then 'high'.
 */
function fastRestoreAction(state: GovernorState, ctx: GovernorContext, now: number, T: GovernorThresholds): GovernorAction | null {
  if (!state.episode || state.episode.overloadedMs > T.fastRestoreBriefOverloadMs) return null;
  if (now < state.fastBlockedUntil) return null;
  if (state.headroomSince === null || now - state.headroomSince < T.fastRestoreAfterMs) return null;
  if (now - state.lastChangeAt < T.fastRestoreStepGapMs) return null;
  const undo = nextStepUp(state, ctx);
  if (undo?.kind === 'bg-high' && state.bgRemembered) {
    return state.camFps ? { kind: 'cam-fps', step: (state.camFps - 1) as CamFpsStep, direction: 'up' } : null;
  }
  if (undo) return undo;
  if (ctx.bgQuality === 'balanced' && bgFastUpgradable(state, ctx, T)) return { kind: 'bg-high' };
  return null;
}

/** The first step of the ladder not taken yet that would change something. */
function nextStepDown(state: GovernorState, ctx: GovernorContext, reasons: string[] = []): GovernorAction | null {
  // The AV1 share itself is what's heavy: switch it first — the camera steps wouldn't touch the cause.
  if (reasons.includes('share-encode') && ctx.shareCodec === 'av1' && !state.shareVp8) return { kind: 'share-vp8' };
  if (ctx.shareCodec && ctx.shareCodec !== 'av1' && !state.share1080 && !state.share720 && (ctx.shareHeight ?? 0) > 1080 * 1.05) {
    return { kind: 'share-1080', direction: 'down' };
  }
  if (ctx.camFpsAvailable && ctx.cameraOn && state.video === 0 && state.camFps < 2) {
    return { kind: 'cam-fps', step: (state.camFps + 1) as CamFpsStep, direction: 'down' };
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
 * 3, camera 2, receive 2, camera 1, receive 1, background 'high', camera 15fps, 20fps, share 1080p).
 * The share's switch to VP8 isn't undone mid-share — each undo would be another republish the
 * viewers see. 'high' is here when the governor took it away and may try it again (the restore
 * trial still applies); otherwise it has its own, slower path (see stepGovernor).
 */
function nextStepUp(state: GovernorState, ctx: GovernorContext): GovernorAction | null {
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
  if (state.bgDowngraded && ctx.bgQuality === 'balanced' && ctx.bgUpgradable && !state.bgRestoreBlocked) {
    return { kind: 'bg-high' };
  }
  if (state.camFps) return { kind: 'cam-fps', step: (state.camFps - 1) as CamFpsStep, direction: 'up' };
  if (state.share1080) return { kind: 'share-1080', direction: 'up' };
  return null;
}

function applyToState(state: GovernorState, action: GovernorAction) {
  if (action.kind === 'bg-balanced') state.bgDowngraded = true;
  else if (action.kind === 'bg-high') {
    state.bgDowngraded = false;
    state.bgRemembered = false;
  }
  else if (action.kind === 'video') state.video = action.level;
  else if (action.kind === 'recv') state.recv = action.level;
  else if (action.kind === 'share-vp8') state.shareVp8 = true;
  else if (action.kind === 'share-720') state.share720 = action.direction === 'down';
  else if (action.kind === 'share-1080') state.share1080 = action.direction === 'down';
  else if (action.kind === 'cam-fps') state.camFps = action.step;
  else state.photo = action.direction === 'down';
}
