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
 * The matte comes from a segmenter worker attached over a MessagePort. This worker never waits
 * for it: every frame is composited with the latest matte, and a new one is requested only once
 * the previous request has been answered — so a slow segmenter lowers the segmentation rate, not
 * the frame rate, and swapping segmenters (attachSegmenter) never pauses the output.
 */
import {
  BackgroundCompositor,
  type BackgroundMode,
  type EffectTarget,
} from './backgroundCompositor';
import type { SegmentReply, SegmentRequest } from './backgroundSegmenter.worker';

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

const post = (message: CompositorResponse) => self.postMessage(message);

let settings: CompositorSettings;
let canvas: OffscreenCanvas;
let compositor: BackgroundCompositor;
let writer: WritableStreamDefaultWriter<VideoFrame> | undefined;
let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
/** 'track' mode: the camera track transferred in, stopped when replaced or on stop. */
let sourceTrack: MediaStreamTrack | undefined;
let segmenterPort: MessagePort | undefined;
let requestInFlight = false;
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
});
let stats = emptyStats();
let statsSince = 0;
let statsTimer: ReturnType<typeof setInterval> | undefined;

function fatal(message: string) {
  if (fatalSent) return;
  fatalSent = true;
  post({ type: 'fatal', message });
}

function matteOptions(invert: number) {
  return {
    invert: settings.invertOverride ?? invert,
    matteLo: settings.matteLo,
    matteHi: settings.matteHi,
    temporalSmoothing: settings.temporalSmoothing,
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

function requestMatte(frame: VideoFrame) {
  if (!segmenterPort || requestInFlight) return;
  const now = performance.now();
  if (!segmentationDue(now)) return;
  lastSegmentationAt = now;
  requestInFlight = true;
  const copy = frame.clone();
  const message: SegmentRequest = { frame: copy, sentAt: now };
  segmenterPort.postMessage(message, [copy]);
}

function onSegmentReply(reply: SegmentReply) {
  requestInFlight = false;
  if (!reply.ok) return;
  if (stopped) {
    reply.mask.close();
    return;
  }
  const t0 = performance.now();
  try {
    compositor.composeMatteFromImage(reply.mask, matteOptions(reply.invert));
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
  requestInFlight = false;
  port.onmessage = (event: MessageEvent<SegmentReply>) => onSegmentReply(event.data);
}

/** Renders one frame; returns the output frame, or null when it must not go out. */
function renderFrame(frame: VideoFrame): VideoFrame | null {
  const t0 = performance.now();
  compositor.resize(frame.displayWidth, frame.displayHeight);
  compositor.uploadFrame(frame);
  requestMatte(frame);
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

/** Pulls frames from one source until it ends or is replaced. */
async function pump(source: ReadableStreamDefaultReader<VideoFrame>) {
  while (!stopped && reader === source) {
    let result: ReadableStreamReadResult<VideoFrame>;
    try {
      result = await source.read();
    } catch {
      return; // cancelled by replaceSource/stop
    }
    if (result.done) return;
    const frame = result.value;
    if (stopped || reader !== source || frame.codedWidth === 0 || frame.codedHeight === 0) {
      frame.close();
      continue;
    }
    let out: VideoFrame | null = null;
    try {
      out = renderFrame(frame);
      consecutiveFailures = 0;
    } catch (err) {
      // Dropped, never passed through raw: the raw frame shows the room the effect is hiding.
      // The receiver just holds the previous frame.
      console.error('[bg-compositor] frame failed:', err);
      stats.droppedFrames += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) fatal(`${MAX_CONSECUTIVE_FAILURES} frames in a row failed: ${String(err)}`);
    } finally {
      frame.close();
    }
    if (!out) continue;
    try {
      await writer!.write(out);
    } catch (err) {
      out.close();
      if (!stopped) fatal(`output closed: ${String(err)}`);
      return;
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
