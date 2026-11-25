/**
 * Compositing for the worker background pipeline (see WorkerBackgroundProcessor): reads camera
 * frames, renders the effect with BackgroundCompositor on an OffscreenCanvas, and writes the
 * result out. Frames never touch the main thread. Two ways in and out, by browser:
 *  - 'streams' (Chrome/Edge): the page builds MediaStreamTrackProcessor/MediaStreamTrackGenerator
 *    (Chrome exposes them on the page) and transfers their readable/writable here.
 *  - 'track' (Safari 18+, the standard shape): the page transfers a camera track here; this
 *    worker builds MediaStreamTrackProcessor and VideoTrackGenerator itself (worker-only APIs)
 *    and transfers the generator's track back.
 *
 * The matte comes from a segmenter worker attached over a MessagePort. Two ways to use it:
 *  - latest (matteSync off): never wait. Every frame is composited with the latest matte, and a
 *    new one is requested only once the previous request has been answered — a slow segmenter
 *    lowers the segmentation rate, not the frame rate. The matte is always from an earlier frame,
 *    which shows as the cut-out trailing a sudden movement. Not used by the call any more.
 *  - matteSync (the call and the pre-join preview, at every governor level since 2026-11-20): only
 *    frames composited with the matte made from that very frame go out. A frame that gets a
 *    segmentation request is held until its matte arrives (the next frames keep being read
 *    meanwhile); a frame that doesn't — the segmentation rate (= the governor's camera frame rate)
 *    isn't due, or two requests are already out (maxInFlight) — is dropped before any work is
 *    done on it. So the
 *    frame rate sent is the segmentation rate, and a segmenter that can't keep up lowers the frame
 *    rate rather than misaligning the cut-out. (Until 2026-11-20 frames in between went out with
 *    the nearest matte, which on 2026-11-19 a person could see as the cut-out a frame behind.)
 *    A segmenter that hasn't answered for STALE_GIVE_UP_MS (broken rather than stalled; the
 *    2026-11-19 window-switch stalls lasted up to about a second) can't be waited on: frames go out
 *    with the latest matte until it answers, and the pipeline's failure checks take it from there.
 *    photoIntervalMs > 0 (the governor's photo mode): one frame per interval, the same way.
 * Stale mattes (latest mode, or the give-up above): a frame whose newest matte comes from more than
 * twice the segmentation interval away (in camera time) is dropped, not sent.
 */
import {
  BackgroundCompositor,
  type BackgroundMode,
  type EffectTarget,
} from './backgroundCompositor';
import type { SegmentReply, SegmentRequest } from './backgroundSegmenter.worker';
import { MATTE_STYLE } from './matteStyle';
import type { SegmentationQuality } from './MediapipeBackgroundProcessor';

export interface CompositorSettings {
  mode: BackgroundMode;
  target: EffectTarget;
  blurRadius: number;
  temporalSmoothing: number;
  edgeFeather: number;
  matteLo: number;
  matteHi: number;
  segmentationFps: number;
  segmentationScheduler: 'interval' | 'exact';
  /** Overrides the segmenter's own mask polarity (the invertMask debugging escape hatch). */
  invertOverride: number | null;
  measureGpuSync: boolean;
  /** Composite each frame with its own matte (see the header). */
  matteSync: boolean;
  /** Photo mode: process and send one frame per this many ms; 0 = every frame. */
  photoIntervalMs: number;
}

/** Where frames come from and go to; see the header. */
export type CompositorIO =
  | { kind: 'streams'; readable: ReadableStream<VideoFrame>; writable: WritableStream<VideoFrame> }
  | { kind: 'track'; track: MediaStreamTrack };

/** A new camera after a device switch: a readable ('streams') or a track ('track'). */
export type CompositorSource = { readable: ReadableStream<VideoFrame> } | { track: MediaStreamTrack };

export type CompositorRequest =
  | {
      type: 'init';
      io: CompositorIO;
      width: number;
      height: number;
      settings: CompositorSettings;
    }
  /** Device switch: the same output, frames from a new camera track. */
  | { type: 'replaceSource'; source: CompositorSource }
  /**
   * 'track' mode: the page's original camera track changed state. The copy here is independent
   * of it — LiveKit turns the camera off by stopping the original, which leaves this copy (and
   * the camera light) running — so the page mirrors it over.
   */
  | { type: 'sourceState'; enabled: boolean; ended: boolean }
  /** 'track' mode: the page lowered/raised the camera's capture settings; apply them to the copy too. */
  | { type: 'sourceConstraints'; constraints: MediaTrackConstraints }
  /** Start (or switch to) getting mattes from this segmenter worker's port. */
  | { type: 'attachSegmenter'; port: MessagePort }
  | { type: 'settings'; settings: Partial<CompositorSettings> }
  /** The still image for `image` mode; null clears it (falls back to blur). */
  | { type: 'setImage'; image: ImageBitmap | null }
  | { type: 'stop' };

/** Totals since the previous report; sent once a second. */
export interface CompositorStats {
  intervalMs: number;
  frames: number;
  /** This worker's time: per-frame compositing plus uploading/feathering each new matte. */
  compositeMsTotal: number;
  compositeMsMax: number;
  segmentations: number;
  segmentMsTotal: number;
  segmentMsMax: number;
  /** The segmenter worker's whole time for the mattes received. */
  segmenterWorkMsTotal: number;
  /** From asking for a matte to having it, summed. */
  maskLatencyMsTotal: number;
  droppedFrames: number;
  /** Longest gap between two frames handed to the sender in this interval, ms (receivers see it as a stall). */
  maxGapMs: number;
  /** matteSync: frames held for their own matte, the time they were held, how many went out with
   *  it, and how many went out with the latest matte instead (the segmenter not answering, see
   *  the header). */
  heldFrames: number;
  heldMsTotal: number;
  ownMatteFrames: number;
  forcedOut: number;
  /** matteSync: frames dropped unprocessed because no matte was asked for them (the segmentation
   *  rate wasn't due, or the segmenter was still busy with an earlier frame). */
  unmatched: number;
  /** Frames dropped unprocessed by photo mode. */
  photoSkipped: number;
  /** Frames dropped because their matte was too old (see the header). */
  staleDropped: number;
  /**
   * What the camera itself delivered (telemetry, 2026-11-21: a Windows camera fell to ~9fps
   * during a screen share with this pipeline idle). Frames read from the camera; the longest gap
   * between two of their capture timestamps, ms; and the time reading was paused waiting for the
   * output (backpressure). Gaps with no such wait are the camera's; with it, frames may also have
   * been dropped unread in the track processor's buffer.
   */
  framesIn: number;
  inputMaxGapMs: number;
  outputWaitMs: number;
  /**
   * Where the time went (2026-11-24: a Windows PC read only ~12fps of a 20fps camera with this
   * pipeline 8% busy and reading 95% blocked on the output). `inputWaitMs`: time reading waited for
   * the next camera frame - large means the camera is the limit; ~0 means frames were already
   * waiting. `writeMs`: time inside writing a finished frame to the output track (the sender's
   * backpressure) - large means the encoder/sender is the limit.
   */
  inputWaitMs: number;
  writeMs: number;
}

export type CompositorResponse =
  /** In 'track' mode, carries the output track (transferred). */
  | { type: 'started'; track?: MediaStreamTrack }
  | { type: 'ready' }
  | { type: 'stats'; stats: CompositorStats }
  | { type: 'fatal'; message: string }
  | { type: 'stopped' };

// Worker-only standard API (Safari 18+); not in TypeScript's DOM types yet.
declare class VideoTrackGenerator {
  readonly writable: WritableStream<VideoFrame>;
  readonly track: MediaStreamTrack;
}
const workerScope = globalThis as { VideoTrackGenerator?: unknown; MediaStreamTrackProcessor?: unknown };

const REQUIRED_STABLE_FRAMES = 5;
const STATS_INTERVAL_MS = 1000;
/** This many frames in a row failing to render means the pipeline is broken, not unlucky. */
const MAX_CONSECUTIVE_FAILURES = 30;
/** No matte for this long: stop dropping frames for stale mattes (see the header). */
const STALE_GIVE_UP_MS = 3000;

const post = (message: CompositorResponse) => self.postMessage(message);

let settings: CompositorSettings;
let canvas: OffscreenCanvas;
let compositor: BackgroundCompositor;
let writer: WritableStreamDefaultWriter<VideoFrame> | undefined;
let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
/** 'track' mode: the camera track transferred in, stopped when replaced or on stop. */
let sourceTrack: MediaStreamTrack | undefined;
let segmenterPort: MessagePort | undefined;
let lastSegmentationAt = 0;
let segmentationCredit = 0;
let lastSchedulerAt = 0;
let stableFrameCount = 0;
let ready = false;
let consecutiveFailures = 0;
let stopped = false;
let fatalSent = false;

const emptyStats = (): CompositorStats => ({
  intervalMs: 0,
  frames: 0,
  compositeMsTotal: 0,
  compositeMsMax: 0,
  segmentations: 0,
  segmentMsTotal: 0,
  segmentMsMax: 0,
  segmenterWorkMsTotal: 0,
  maskLatencyMsTotal: 0,
  droppedFrames: 0,
  maxGapMs: 0,
  heldFrames: 0,
  heldMsTotal: 0,
  ownMatteFrames: 0,
  forcedOut: 0,
  unmatched: 0,
  photoSkipped: 0,
  staleDropped: 0,
  framesIn: 0,
  inputMaxGapMs: 0,
  outputWaitMs: 0,
  inputWaitMs: 0,
  writeMs: 0,
});
/** Camera timestamp (µs) of the frame the current matte was made from, and when it arrived. */
let matteFrameTimestamp: number | null = null;
let matteArrivedAt = 0;
/** matteSync: frames waiting for their own matte, oldest first (one per request out). */
const held: { frame: VideoFrame; arrivedAt: number }[] = [];
/** Segmentation requests out right now, oldest first: the frame's timestamp and when it was asked.
 *  The segmenter answers them in order. */
let inFlight: { timestamp: number; at: number }[] = [];
/** Every output goes through this chain, so frames leave in order whoever sends them. */
let outputChain: Promise<void> = Promise.resolve();
let stats = emptyStats();
/** When the last output frame was written; reset with each new source so a camera switch isn't a "gap". */
let lastOutputAt: number | null = null;
/** Capture timestamp (µs) of the last frame read from the camera; reset with each new source. */
let lastInputTimestamp: number | null = null;
let statsSince = 0;
let statsTimer: ReturnType<typeof setInterval> | undefined;

function fatal(message: string) {
  if (fatalSent) return;
  fatalSent = true;
  post({ type: 'fatal', message });
}

function matteOptions(invert: number, quality: SegmentationQuality, maskGrid: { width: number; height: number }) {
  return {
    // Photo mode's frames are a second or more apart: blending in the previous one's matte would
    // leave a ghost of where the person was.
    invert: settings.invertOverride ?? invert,
    style: MATTE_STYLE[quality],
    // The mask bitmap is the camera frame's size (see backgroundSegmenter.worker), not the model's grid.
    maskGrid,
    matteLo: settings.matteLo,
    matteHi: settings.matteHi,
    temporalSmoothing: settings.photoIntervalMs > 0 ? 0 : settings.temporalSmoothing,
    edgeFeather: settings.edgeFeather,
  };
}

/** Same rate limiting as MediapipeBackgroundProcessor.updateMatte; true when this frame should get a new matte. */
function segmentationDue(now: number) {
  const hasMatteHistory = compositor.hasMatteHistory;
  if (settings.segmentationScheduler === 'exact') {
    const elapsed = lastSchedulerAt ? now - lastSchedulerAt : Infinity;
    lastSchedulerAt = now;
    segmentationCredit = Math.min(2, segmentationCredit + (elapsed * settings.segmentationFps) / 1000);
    if (hasMatteHistory && segmentationCredit < 1) return false;
    segmentationCredit = Math.max(0, segmentationCredit - 1);
    return true;
  }
  const minInterval = 1000 / Math.max(1, settings.segmentationFps);
  return !hasMatteHistory || now - lastSegmentationAt >= minInterval;
}

/**
 * Requests outstanding at once. matteSync: two, so the segmenter starts on the next frame the
 * moment it finishes one — with a single request it sat idle until the next camera frame arrived,
 * and a segmentation just over the camera's frame interval (50ms at 20fps) halved the frame rate
 * sent: 55ms per segmentation meant 10fps instead of the ~18 the segmenter can do. Costs up to one
 * more segmentation of delay, only when it's that slow. Latest-matte mode: one (nothing waits).
 */
function maxInFlight() {
  return settings.matteSync || settings.photoIntervalMs > 0 ? 2 : 1;
}

/** Asks for this frame's matte if one is due and there's room; true when it was asked for. */
function requestMatte(frame: VideoFrame): boolean {
  if (!segmenterPort || inFlight.length >= maxInFlight()) return false;
  const now = performance.now();
  if (!segmentationDue(now)) return false;
  lastSegmentationAt = now;
  inFlight.push({ timestamp: frame.timestamp, at: now });
  const copy = frame.clone();
  const message: SegmentRequest = { frame: copy, sentAt: now };
  segmenterPort.postMessage(message, [copy]);
  return true;
}

/** The segmenter hasn't answered its oldest request for STALE_GIVE_UP_MS: stop waiting on it (header). */
function segmenterStuck(now = performance.now()) {
  return inFlight.length > 0 && now - inFlight[0].at > STALE_GIVE_UP_MS;
}

function onSegmentReply(reply: SegmentReply) {
  const answeredTimestamp = inFlight.shift()?.timestamp ?? null;
  try {
    handleSegmentReply(reply);
    if (reply.ok && !stopped && answeredTimestamp !== null) {
      matteFrameTimestamp = answeredTimestamp;
      matteArrivedAt = performance.now();
    }
  } finally {
    // matteSync: the answered frame now has its own matte (it's the oldest held: requests are
    // answered in order). A failed segmentation has none for it.
    if (held.length && answeredTimestamp !== null) {
      if (reply.ok) releaseHeld((ts) => ts <= answeredTimestamp, answeredTimestamp);
      else dropHeld((ts) => ts <= answeredTimestamp);
    }
  }
}

function handleSegmentReply(reply: SegmentReply) {
  if (!reply.ok) return;
  if (stopped) {
    reply.mask.close();
    return;
  }
  const t0 = performance.now();
  try {
    compositor.composeMatteFromImage(reply.mask, matteOptions(reply.invert, reply.quality, reply.maskGrid));
  } finally {
    reply.mask.close();
  }
  const ms = performance.now() - t0;
  stats.compositeMsTotal += ms;
  stats.segmentations += 1;
  stats.segmentMsTotal += reply.segmentMs;
  stats.segmentMsMax = Math.max(stats.segmentMsMax, reply.segmentMs);
  stats.segmenterWorkMsTotal += reply.workMs;
  stats.maskLatencyMsTotal += performance.now() - reply.sentAt;
}

function attachSegmenter(port: MessagePort) {
  // A request still out with the old segmenter is simply forgotten; closing its port drops the reply.
  segmenterPort?.close();
  segmenterPort = port;
  inFlight = [];
  // A frame waiting on the old segmenter will never get its matte.
  dropHeld();
  port.onmessage = (event: MessageEvent<SegmentReply>) => onSegmentReply(event.data);
}

/**
 * Renders one frame; returns the output frame, or null when it must not go out. `hasOwnMatte`:
 * this frame's matte was already composed (matteSync), so don't ask for another.
 */
function renderFrame(frame: VideoFrame, hasOwnMatte = false): VideoFrame | null {
  const t0 = performance.now();
  compositor.resize(frame.displayWidth, frame.displayHeight);
  compositor.uploadFrame(frame);
  if (!hasOwnMatte) requestMatte(frame);
  compositor.render({ mode: settings.mode, blurRadius: settings.blurRadius, target: settings.target });

  // Same readiness rule as the main-thread processor: a few frames on a warmed-up matte, and the
  // output stays black until then (a freshly reset matte later just restarts the count).
  stableFrameCount = compositor.hasMatteHistory ? stableFrameCount + 1 : 0;
  if (!ready && stableFrameCount >= REQUIRED_STABLE_FRAMES) {
    ready = true;
    post({ type: 'ready' });
  }
  if (!ready) compositor.blank();
  if (settings.measureGpuSync) compositor.gl.finish();

  const out = new VideoFrame(canvas, { timestamp: frame.timestamp });
  const ms = performance.now() - t0;
  stats.frames += 1;
  stats.compositeMsTotal += ms;
  stats.compositeMsMax = Math.max(stats.compositeMsMax, ms);
  return out;
}

/** Renders one frame (closing it); null when it failed and must not go out. */
function renderSafely(frame: VideoFrame, hasOwnMatte: boolean): VideoFrame | null {
  try {
    const out = renderFrame(frame, hasOwnMatte);
    consecutiveFailures = 0;
    return out;
  } catch (err) {
    // Dropped, never passed through raw: the raw frame shows the room the effect is hiding.
    // The receiver just holds the previous frame.
    console.error('[bg-compositor] frame failed:', err);
    stats.droppedFrames += 1;
    consecutiveFailures += 1;
    if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) fatal(`${MAX_CONSECUTIVE_FAILURES} frames in a row failed: ${String(err)}`);
    return null;
  } finally {
    frame.close();
  }
}

/** Queues an output frame behind any earlier ones; resolves once it's written. */
function emit(out: VideoFrame): Promise<void> {
  outputChain = outputChain.then(async () => {
    if (stopped) {
      out.close();
      return;
    }
    try {
      const writeFrom = performance.now();
      await writer!.write(out);
      const at = performance.now();
      stats.writeMs += at - writeFrom;
      if (lastOutputAt !== null) stats.maxGapMs = Math.max(stats.maxGapMs, at - lastOutputAt);
      lastOutputAt = at;
    } catch (err) {
      out.close();
      if (!stopped) fatal(`output closed: ${String(err)}`);
    }
  });
  return outputChain;
}

/**
 * matteSync: sends the held frames that `release` picks (a prefix, oldest first), composited with
 * whatever matte is current. `ownTimestamp`: the frame that matte was made from, if any; frames
 * going out with any other matte count as forcedOut.
 */
function releaseHeld(release: (timestamp: number) => boolean, ownTimestamp: number | null) {
  const now = performance.now();
  while (held.length && release(held[0].frame.timestamp)) {
    const { frame, arrivedAt } = held.shift()!;
    stats.heldFrames += 1;
    stats.heldMsTotal += now - arrivedAt;
    if (ownTimestamp !== null && frame.timestamp === ownTimestamp) stats.ownMatteFrames += 1;
    else stats.forcedOut += 1;
    if (dropIfStale(frame)) continue;
    const out = renderSafely(frame, true);
    if (out) void emit(out);
  }
}

/**
 * True (and the frame closed) when the newest matte is from more than twice the segmentation
 * interval away from this frame in camera time — see the header.
 */
function dropIfStale(frame: VideoFrame): boolean {
  if (!compositor.hasMatteHistory || matteFrameTimestamp === null) return false;
  if (performance.now() - matteArrivedAt > STALE_GIVE_UP_MS) return false;
  const maxAgeMs = (2 * 1000) / Math.max(1, settings.segmentationFps);
  if (Math.abs(frame.timestamp - matteFrameTimestamp) / 1000 <= maxAgeMs) return false;
  frame.close();
  stats.staleDropped += 1;
  return true;
}

/** Closes held frames (all, or the oldest ones `which` picks) without sending them: stopping, or
 *  their matte will never come. */
function dropHeld(which: (timestamp: number) => boolean = () => true) {
  while (held.length && which(held[0].frame.timestamp)) held.shift()!.frame.close();
}

/** Pulls frames from one source until it ends or is replaced. */
async function pump(source: ReadableStreamDefaultReader<VideoFrame>) {
  while (!stopped && reader === source) {
    let result: ReadableStreamReadResult<VideoFrame>;
    try {
      const readFrom = performance.now();
      result = await source.read();
      stats.inputWaitMs += performance.now() - readFrom;
    } catch {
      return; // cancelled by replaceSource/stop
    }
    if (result.done) return;
    const frame = result.value;
    if (stopped || reader !== source || frame.codedWidth === 0 || frame.codedHeight === 0) {
      frame.close();
      continue;
    }
    stats.framesIn += 1;
    if (lastInputTimestamp !== null && frame.timestamp > lastInputTimestamp) {
      stats.inputMaxGapMs = Math.max(stats.inputMaxGapMs, (frame.timestamp - lastInputTimestamp) / 1000);
    }
    lastInputTimestamp = frame.timestamp;
    // Photo mode: drop everything between the frames that go out (and while one waits for its
    // matte), before any work is done on it.
    const photo = settings.photoIntervalMs > 0;
    if (photo && (held.length || (lastOutputAt !== null && performance.now() - lastOutputAt < settings.photoIntervalMs))) {
      frame.close();
      stats.photoSkipped += 1;
      continue;
    }

    // matteSync: only frames with their own matte go out (see the header).
    const holding =
      (settings.matteSync || photo) && compositor.hasMatteHistory && !!segmenterPort && !segmenterStuck();
    if (!holding && held.length) releaseHeld(() => true, null);
    if (holding) {
      if (requestMatte(frame)) {
        held.push({ frame, arrivedAt: performance.now() });
      } else {
        frame.close();
        stats.unmatched += 1;
      }
      // Backpressure: don't read further ahead than the output can take.
      const waitFrom = performance.now();
      await outputChain;
      stats.outputWaitMs += performance.now() - waitFrom;
      continue;
    }

    // Latest-matte path (also the start, before the first matte, and a stuck segmenter).
    // Ask for a fresh matte before judging this frame: a dropped frame must still get one going.
    requestMatte(frame);
    if (settings.matteSync && compositor.hasMatteHistory) stats.forcedOut += 1;
    if (dropIfStale(frame)) continue;
    const out = renderSafely(frame, false);
    if (out) {
      const waitFrom = performance.now();
      await emit(out);
      stats.outputWaitMs += performance.now() - waitFrom;
    }
  }
}

function switchSource(source: CompositorSource) {
  const previous = reader;
  const previousTrack = sourceTrack;
  if ('track' in source) {
    sourceTrack = source.track;
    reader = new MediaStreamTrackProcessor({ track: source.track as MediaStreamVideoTrack }).readable.getReader();
  } else {
    sourceTrack = undefined;
    reader = source.readable.getReader();
  }
  previous?.cancel().catch(() => {});
  previousTrack?.stop();
  // A frame from the previous camera still waiting for its matte isn't worth sending now, and a
  // new camera's timestamps aren't comparable with the old one's mattes.
  dropHeld();
  matteFrameTimestamp = null;
  lastOutputAt = null;
  lastInputTimestamp = null;
  void pump(reader);
}

function sendStats() {
  const now = performance.now();
  stats.intervalMs = now - statsSince;
  statsSince = now;
  post({ type: 'stats', stats });
  stats = emptyStats();
}

function init(request: Extract<CompositorRequest, { type: 'init' }>) {
  settings = request.settings;
  canvas = new OffscreenCanvas(request.width, request.height);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    fatal('compositor WebGL context lost');
  });
  compositor = new BackgroundCompositor(canvas);
  const io = request.io;
  let outputTrack: MediaStreamTrack | undefined;
  if (io.kind === 'track') {
    if (typeof workerScope.MediaStreamTrackProcessor === 'undefined' || typeof workerScope.VideoTrackGenerator === 'undefined') {
      throw new Error('MediaStreamTrackProcessor/VideoTrackGenerator are not available in this worker');
    }
    const generator = new VideoTrackGenerator();
    writer = generator.writable.getWriter();
    outputTrack = generator.track;
    switchSource({ track: io.track });
  } else {
    writer = io.writable.getWriter();
    switchSource({ readable: io.readable });
  }
  statsSince = performance.now();
  statsTimer = setInterval(sendStats, STATS_INTERVAL_MS);
  if (outputTrack) {
    // MediaStreamTrack is transferable in browsers with this API; TypeScript doesn't know yet.
    self.postMessage({ type: 'started', track: outputTrack } satisfies CompositorResponse, {
      transfer: [outputTrack as unknown as Transferable],
    });
  } else post({ type: 'started' });
}

async function stop() {
  stopped = true;
  dropHeld();
  if (statsTimer !== undefined) clearInterval(statsTimer);
  segmenterPort?.close();
  await reader?.cancel().catch(() => {});
  reader = undefined;
  sourceTrack?.stop();
  sourceTrack = undefined;
  await writer?.close().catch(() => {});
  compositor?.destroy();
  // Give the GPU memory back now rather than whenever the worker gets collected.
  compositor?.gl.getExtension('WEBGL_lose_context')?.loseContext();
  post({ type: 'stopped' });
}

self.onmessage = (event: MessageEvent<CompositorRequest>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'init':
        init(message);
        break;
      case 'replaceSource':
        // A different camera may have a different size; the next frame's resize() handles it.
        switchSource(message.source);
        break;
      case 'attachSegmenter':
        attachSegmenter(message.port);
        break;
      case 'sourceState':
        if (!sourceTrack) break;
        if (message.ended) {
          sourceTrack.stop();
          sourceTrack = undefined;
          void reader?.cancel().catch(() => {});
          reader = undefined;
        } else {
          sourceTrack.enabled = message.enabled;
        }
        break;
      case 'sourceConstraints':
        sourceTrack?.applyConstraints(message.constraints).catch((err) => console.warn('[bg-compositor] applyConstraints failed:', err));
        break;
      case 'settings':
        settings = { ...settings, ...message.settings };
        break;
      case 'setImage':
        compositor.setImage(message.image, message.image ? message.image.width / Math.max(1, message.image.height) : 1);
        message.image?.close();
        break;
      case 'stop':
        void stop();
        break;
    }
  } catch (err) {
    fatal(`${message.type}: ${err instanceof Error ? err.message : String(err)}`);
  }
};
