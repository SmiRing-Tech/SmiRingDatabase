import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';
import {
  BackgroundCompositor,
  type BackgroundMode,
  type EffectTarget,
  type MatteOptions,
} from './backgroundCompositor';
import { registerDiagProbe } from '../connectDiagnostics';

/**
 * A LiveKit `TrackProcessor` that blurs the camera background using MediaPipe
 * Image Segmenter directly, instead of going through `@livekit/track-processors`.
 *
 * Why not just use `BackgroundBlur` from `@livekit/track-processors`? That
 * processor is already MediaPipe under the hood, but it consumes the segmenter's
 * *category* mask — a hard 0/1 per-pixel classification. Hair, glasses frames and
 * motion-blurred edges are exactly the places where a pixel is genuinely
 * "partly person", and a binary mask has no way to say so, which is what produces
 * the cut-out-with-scissors look.
 *
 * This processor consumes the *confidence* mask instead, so a strand of hair can
 * come through at alpha 0.4, and adds two things the built-in pipeline has no
 * knob for:
 *
 *   - temporal smoothing, so the matte stops crawling frame to frame;
 *   - a tunable feather, so the alpha ramp is a soft gradient rather than a
 *     gradient-derived smoothstep at a fixed width.
 *
 * Everything stays on the GPU: MediaPipe renders into the same WebGL2 canvas we
 * composite on, so the mask never round-trips through CPU memory (the one
 * exception is polarity detection, which reads back a handful of frames at
 * startup and only when the model ships no label map).
 */

export type SegmentationQuality = 'balanced' | 'high';

/** What tripped onSustainedSlowFrames, for logging/diagnostics. */
export interface SlowFrameMeasure {
  trigger: 'sustained' | 'spike' | 'starved';
  avgFrameMs?: number;
  fps?: number;
  expectedFps?: number;
}

/** Pinned to the installed @mediapipe/tasks-vision version — keep in sync on upgrade. */
const TASKS_VISION_VERSION = '1.0.1';
/** Where the tasks-vision WASM fileset is loaded from (also by the worker spike). */
export const MEDIAPIPE_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;

const MODELS: Record<SegmentationQuality, string> = {
  // 244 KB. Binary person/background, trained on 256x144 landscape input, which
  // matches a 16:9 webcam without the aspect squash the square model suffers.
  balanced:
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite',
  // 15.6 MB. Six classes (background / hair / body-skin / face-skin / clothes /
  // accessories); the dedicated hair class is what makes the difference on
  // fly-away strands. Cached by the browser after the first download.
  high: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

/** Thrown by `loadSegmentationModel` when the download misses the caller's deadline. */
export class SegmentationModelTimeoutError extends Error {
  constructor(quality: SegmentationQuality, timeoutMs: number) {
    super(`segmentation model '${quality}' did not finish downloading within ${timeoutMs}ms`);
    this.name = 'SegmentationModelTimeoutError';
  }
}

type ModelDownload = { promise: Promise<Uint8Array>; controller: AbortController; done: boolean };

/** One download per model for the whole page, shared by every processor and caller. */
const modelDownloads = new Map<SegmentationQuality, ModelDownload>();

function startModelDownload(quality: SegmentationQuality): ModelDownload {
  const controller = new AbortController();
  const entry: ModelDownload = { controller, done: false, promise: Promise.resolve(new Uint8Array()) };
  entry.promise = fetch(MODELS[quality], { signal: controller.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`segmentation model '${quality}' download failed (${res.status})`);
      const buffer = new Uint8Array(await res.arrayBuffer());
      entry.done = true;
      return buffer;
    })
    .catch((err) => {
      // Never cache a failure (including an abort) — the next attempt should hit the network again.
      if (modelDownloads.get(quality) === entry) modelDownloads.delete(quality);
      throw err;
    });
  modelDownloads.set(quality, entry);
  return entry;
}

/**
 * Downloads a model's bytes ourselves rather than handing MediaPipe a URL, so the slow part
 * of a model load — on 'high', a 15.6 MB download — can be given a deadline and *cancelled*.
 * MediaPipe's own loader has no cancellation at all, and LiveKit holds the track's change lock
 * for the whole of `setProcessor()` → `init()`, so once a processor has started loading there
 * is no way to give up on it early: `stopProcessor()` just queues behind it. Fetching the bytes
 * up front, before any processor or segmenter exists, makes "give up" a plain fetch abort with
 * no GL state involved — see MediapipeBackgroundProcessor.init()'s doc comment for why two
 * segmenters must never overlap.
 *
 * With `timeoutMs`, rejects with `SegmentationModelTimeoutError` and aborts the download if it
 * isn't done by then. Aborted rather than left to finish in the background: on a connection
 * slow enough to miss the deadline, the rest of a 15 MB download would be competing with the
 * call's own audio/video for that same bandwidth. The abort applies to the shared download, so
 * any other caller waiting on the same model at that moment gets the rejection too.
 *
 * Kept in memory once loaded, so rebuilding a processor later in the page (a quality toggle,
 * a re-publish) never downloads again.
 */
export function loadSegmentationModel(quality: SegmentationQuality, timeoutMs?: number): Promise<Uint8Array> {
  const entry = modelDownloads.get(quality) ?? startModelDownload(quality);
  if (timeoutMs === undefined || entry.done) return entry.promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.controller.abort();
      reject(new SegmentationModelTimeoutError(quality, timeoutMs));
    }, timeoutMs);
    entry.promise.then(
      (buffer) => {
        clearTimeout(timer);
        resolve(buffer);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Which way each bundled model's confidence mask reads — 1 when it scores
 * *background* (so the shader needs to invert it to get subject alpha), 0 when
 * it already scores the *subject* directly. This is a fixed property of a
 * specific model file, not something that varies frame to frame, so there is
 * nothing to detect at runtime.
 *
 * There used to be a `detectPolarity()` that guessed this per-session from
 * live frames (outer border of a webcam shot = background, centre = subject).
 * That heuristic's assumption breaks exactly when nobody is framed centre yet
 * — the first second after the camera opens, or anyone sitting off to one
 * side — which is precisely when getting it right matters most, and got it
 * backwards often enough to be the actual bug (see the "反転" reports).
 * `balanced`'s value here comes from commit c32f217, which found this
 * empirically (its single category, despite being labelled "background",
 * scores the subject); `high` was already correct under the old heuristic's
 * default guess, which is consistent with it being a true per-class softmax
 * confidence (see the label-matched mask selection in createSegmenter/
 * updateMatte) rather than an arbitrary binary convention.
 *
 * Re-verify (or re-measure and update this table) if either model file is
 * ever swapped for a different version/architecture.
 */
export const MODEL_INVERT: Record<SegmentationQuality, number> = {
  balanced: 0,
  high: 1,
};

export type { BackgroundMode, EffectTarget };

export type MediapipeBackgroundOptions = {
  /** Replace the background with a blurred copy of it, or with a still image. */
  mode?: BackgroundMode;
  /**
   * Whether the effect replaces the background (the usual case) or the subject
   * — the latter blurs the person and leaves the room sharp, or cuts the image
   * into the person's silhouette.
   */
  target?: EffectTarget;
  /**
   * Image to sit behind the subject in `image` mode. Cross-origin URLs (e.g. R2
   * presigned links) are fetched with `crossOrigin = 'anonymous'`, so the bucket
   * must send CORS headers — without them the load fails rather than silently
   * tainting the canvas, which would break frame capture entirely.
   */
  imageUrl?: string | null;
  /** Background blur strength in output pixels. Only used in `blur` mode. */
  blurRadius?: number;
  /** Which segmentation model to load. Changing this requires a new processor. */
  quality?: SegmentationQuality;
  /** How much of the previous frame's matte to keep, 0..0.95. Higher = steadier edge, more lag. */
  temporalSmoothing?: number;
  /** Width of the soft alpha ramp at the silhouette, in output pixels. */
  edgeFeather?: number;
  /** Cap on segmentation inferences per second; frames in between reuse the last matte. */
  segmentationFps?: number;
  /**
   * How segmentationFps is enforced.
   *  - 'interval' (default, what the app runs): skip a frame if less than 1000/fps ms passed
   *    since the last inference. With fps equal to the camera's, any frame arriving slightly early
   *    is skipped, so in practice this runs at about *half* the camera rate (measured: 10/s at
   *    a 20fps camera with segmentationFps 20).
   *  - 'exact': a credit counter that hits the requested rate on average (e.g. 3 of every 4
   *    frames for 15/s at 20fps) — for the blur lab to compare rates honestly.
   */
  segmentationScheduler?: 'interval' | 'exact';
  /** Override the WASM bundle / model URLs, e.g. to self-host them. */
  assetPaths?: { wasmFileSet?: string; modelAssetPath?: string };
  /** MediaPipe inference backend. GPU unless you have a reason. */
  delegate?: 'GPU' | 'CPU';
  /**
   * Benchmarking only (the blur lab): call gl.finish() at the end of every frame so the
   * per-frame timings include the GPU's own work, not just the main thread queueing it. Makes
   * the pipeline slower — never set it in the app.
   */
  measureGpuSync?: boolean;
  /**
   * Forces how the confidence mask is read: `true` = it scores background,
   * `false` = it scores the subject. Leave undefined to use the known-correct
   * value for `quality` (see `MODEL_INVERT`). This is a debugging escape
   * hatch, not the way to swap the effect around — that is what `target` is
   * for.
   */
  invertMask?: boolean;
  /** Cutoff below which mask values are clamped to 0 (background). Default: 0.30 */
  matteLo?: number;
  /** Cutoff above which mask values are saturated to 1 (subject). Default: 0.75 */
  matteHi?: number;
  /**
   * Fires once, the first time this processor is measurably too heavy for the machine *right
   * now* — whatever the reason (a weak CPU, or a strong one busy with other apps). Two kinds of
   * evidence, whichever shows up first:
   *  - `sustained` / `spike`: its own per-frame cost (segmentation + GL compositing) averaged
   *    above a stutter-level threshold over a rolling window;
   *  - `starved`: frames simply aren't getting through — fewer than half the camera's frame
   *    rate processed over several seconds, with the camera on and the page visible. Per-frame
   *    cost alone misses this: on a saturated machine each frame that *does* run can look cheap
   *    while most frames never run at all (measured: ~5ms/frame at 0-4fps on a 2-core
   *    MacBook Air), and a main-thread freeze shows up here as zero frames.
   * This processor has no lighter mode of its own, so it only reports; the caller decides
   * (`high` -> `balanced`, `balanced` -> off).
   */
  onSustainedSlowFrames?: (measure: SlowFrameMeasure) => void;
  /**
   * Fires once, the first time this processor's own per-frame cost has averaged
   * *comfortably below* a headroom threshold over a longer rolling window than
   * onSustainedSlowFrames uses — deliberately slower to trust and stricter to
   * satisfy, so a `balanced` processor doesn't talk a caller into `high` on the
   * strength of a few good seconds only to immediately trip the slow-frame
   * fallback once the heavier model's own real cost shows up. Meant for a caller
   * running `balanced` to try upgrading to `high`; meaningless (never fires) for
   * a processor that has nothing heavier to go to.
   */
  onSustainedFastFrames?: (avgFrameMs: number) => void;
};

/** Shared with WorkerBackgroundProcessor, so both paths start from the same settings. */
export const MEDIAPIPE_BACKGROUND_DEFAULTS = {
  mode: 'blur' as BackgroundMode,
  target: 'background' as EffectTarget,
  imageUrl: null as string | null,
  blurRadius: 16,
  quality: 'balanced' as SegmentationQuality,
  temporalSmoothing: 0.25,
  edgeFeather: 1.5,
  // Enough to steady a stationary edge; the shader drops it toward zero wherever
  // the matte is moving, so raising it does not reintroduce trails.
  segmentationFps: 30,
  delegate: 'GPU' as const,
  measureGpuSync: false,
  segmentationScheduler: 'interval' as 'interval' | 'exact',
  invertMask: undefined as boolean | undefined,
  matteLo: 0.3,
  matteHi: 0.75,
};

/** True when the browser can run this processor at all. */
export function supportsMediapipeBackground(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof VideoFrame === 'undefined') return false;
  const canRender = !!document.createElement('canvas').getContext('webgl2');
  const canPipe =
    (typeof MediaStreamTrackGenerator !== 'undefined' &&
      typeof MediaStreamTrackProcessor !== 'undefined') ||
    'captureStream' in HTMLCanvasElement.prototype;
  return canRender && canPipe;
}

/** Rolling-average state for one of trackFramePerf's windows (see pushPerfWindow). */
type PerfWindowState = { durations: number[]; sum: number };

let instanceCounter = 0;

/**
 * Diagnostic logging for the prewarm/rewire/stabilize dance around processor
 * swaps — the "black background right after switching to High" bug lives
 * somewhere across process boundaries (two segmenter pipelines, a clone()d
 * track, livekit's own setProcessor/stopProcessor sequencing) that don't show
 * up in a single stack trace, so timestamped, per-instance logs are the way to
 * actually see the order things happen in. Left in as plain console.debug
 * (not behind a flag) until the bug is confirmed fixed — cheap enough to keep
 * a little longer, and DevTools' console filter hides it in one search.
 */
function bgLog(id: number, msg: string, data?: Record<string, unknown>) {
  // Dev-only: several call sites log per-frame (every N frames of a 30fps pipeline) for the
  // entire lifetime of the background effect, which is wasted string/object work in production.
  if (!import.meta.env.DEV) return;
  const t = typeof performance !== 'undefined' ? performance.now().toFixed(0) : '?';
  console.log(`[mediapipe-bg #${id} t=${t}ms] ${msg}`, data ?? '');
}

export class MediapipeBackgroundProcessor implements TrackProcessor<Track.Kind.Video> {
  private readonly id = ++instanceCounter;

  private log(msg: string, data?: Record<string, unknown>) {
    bgLog(this.id, msg, data);
  }

  /**
   * Includes the model, because LiveKit identifies a processor by this string
   * (it serialises `processor` down to `.name` when deciding whether preview
   * tracks need rebuilding). Everything else about this processor can be changed
   * in place; the model cannot, so the name has to change with it.
   */
  name: string;

  processedTrack?: MediaStreamTrack;

  // invertMask stays genuinely optional: undefined means "auto-detect", which is
  // a different state from either explicit true or false.
  private options: Required<
    Omit<
      MediapipeBackgroundOptions,
      'assetPaths' | 'invertMask' | 'onSustainedSlowFrames' | 'onSustainedFastFrames'
    >
  > &
    Pick<
      MediapipeBackgroundOptions,
      'assetPaths' | 'invertMask' | 'onSustainedSlowFrames' | 'onSustainedFastFrames'
    >;

  private segmenter?: ImageSegmenter;

  private canvas?: HTMLCanvasElement;

  /** The GL half of the effect (shared with the worker path); MediaPipe renders into its context. */
  private compositor?: BackgroundCompositor;

  /** URL of the image currently loaded into the compositor, so we only re-upload on a real change. */
  private loadedImageUrl?: string | null;

  /** Guards against an out-of-order load when the URL changes mid-flight. */
  private imageLoadToken = 0;

  private sourceTrack?: MediaStreamTrack;

  private streamProcessor?: MediaStreamTrackProcessor<VideoFrame>;

  private streamGenerator?: MediaStreamTrackGenerator<VideoFrame>;

  private abortController?: AbortController;

  private fallbackVideo?: HTMLVideoElement;

  private fallbackStream?: MediaStream;

  private fallbackHandle?: number;

  /** Drives the Safari/Firefox path while the tab is hidden; see startHiddenTicker. */
  private hiddenTicker?: Worker;

  private onVisibilityChange?: () => void;

  private width = 0;

  private height = 0;

  private maskIndex = 0;

  /** Label map from the model, if it ships one. Used to pick the mask, never the polarity. */
  private labels: string[] = [];

  /** Where the last init() spent its time, for the blur lab's load-freeze breakdown (ms). */
  readonly loadTimings: {
    filesetMs?: number;
    modelFetchMs?: number;
    createSegmenterMs?: number;
    firstSegmentationMs?: number;
  } = {};

  private maskIndexResolved = false;

  private lastSegmentationMs = 0;

  /** 'exact' scheduler state: inference credit (capped at 2 so a slightly late frame isn't lost). */
  private segmentationCredit = 0;
  private lastSchedulerAt = 0;

  private lastTimestampMs = 0;

  private stopped = false;

  /**
   * Frames composited after matte history has warmed up. Polarity is fixed and
   * known from construction (see `MODEL_INVERT`), so the only thing left to
   * warm up is temporal smoothing — frames rendered before matte history
   * exists skip it and look rougher. That's not what "the effect is ready"
   * should mean, but `init()`/`setBackground()` resolve as soon as the
   * pipeline is wired, well before it holds — see `waitUntilReady`.
   */
  private stableFrameCount = 0;

  private readonly requiredStableFrames = 5;

  private readyResolved = false;

  private readyWaiters: Array<() => void> = [];

  private stabilityFrameLogCount = 0;

  /** Rolling window of renderFrame() durations, for onSustainedSlowFrames. */
  private static readonly PERF_SLOW_WINDOW = 90;

  /** Above this average ms/frame, compositing alone is already eating most of a 30fps budget. */
  private static readonly PERF_SLOW_AVG_MS = 20;

  private slowWindow: PerfWindowState = { durations: [], sum: 0 };

  /**
   * Second, shorter/stricter window alongside PERF_SLOW_WINDOW — a genuine but shorter-lived
   * heavy patch (a busy CPU for a couple of seconds, not the whole call) averages out inside
   * the 90-frame/~4.5s window above before ever crossing PERF_SLOW_AVG_MS, since most
   * individual frames are cheap GL-only work between segmentations (see trackFramePerf's
   * comment) and dilute the average. ~1.5s at 20fps is short enough that a real stutter of
   * that length isn't hidden by cheaper neighboring frames, and 33ms/frame (sub-30fps) is a
   * level a background effect alone has no business sustaining for that long. Reuses the same
   * `slowCallbackFired` latch as PERF_SLOW_WINDOW — whichever trips first wins, there is only
   * ever one downgrade.
   */
  private static readonly PERF_SPIKE_WINDOW = 30;

  private static readonly PERF_SPIKE_AVG_MS = 33;

  private spikeWindow: PerfWindowState = { durations: [], sum: 0 };

  private slowCallbackFired = false;

  /**
   * Rolling window for onSustainedFastFrames — longer than PERF_SLOW_WINDOW (roughly
   * 5s vs 3s at 30fps) so an upgrade only fires on a longer run of genuinely good
   * frames than it takes to trigger the opposite, more urgent, downgrade.
   */
  private static readonly PERF_FAST_WINDOW = 150;

  /** Below this average ms/frame, there's enough headroom under PERF_SLOW_AVG_MS that
   *  trying the heavier model is unlikely to immediately trip the slow-frame fallback. */
  private static readonly PERF_FAST_AVG_MS = 6;

  /**
   * ...and the PERF_FAST_WINDOW frames must also have *arrived* at close to the camera's frame
   * rate. Cheap frames prove nothing if most frames never got processed: a saturated 2-core
   * MacBook Air measured ~5ms/frame at a few fps, passed the cost check alone, got "upgraded" to
   * the 15.6 MB model, and froze for 7s twice loading it.
   */
  private static readonly PERF_FAST_MIN_FPS_RATIO = 0.85;

  /** Starvation check (see onSustainedSlowFrames): measured over windows this long... */
  private static readonly STARVATION_WINDOW_MS = 5000;

  /** ...and tripped below this fraction of the camera's frame rate. */
  private static readonly STARVATION_MIN_FPS_RATIO = 0.5;

  /** The first frames (model warm-up, shader compile — measured at 4.3s for the very first
   *  segmentation on a slow machine) aren't representative; starvation is only judged once the
   *  matte is stable, or after this long, whichever comes first. */
  private static readonly STARVATION_GRACE_MS = 10_000;

  private starvationTimer?: ReturnType<typeof setInterval>;
  private starvationFrames = 0;
  private starvationWindowStart = 0;
  private starvationMonitorStart = 0;

  private fastFrameDurations: number[] = [];

  private fastFrameTimes: number[] = [];

  private fastFrameDurationSum = 0;

  private fastCallbackFired = false;

  /** Marks this frame's contribution towards / away from "stable", from renderFrame(). */
  private trackStability() {
    const wasCounting = this.stableFrameCount > 0;
    if (this.compositor?.hasMatteHistory) {
      this.stableFrameCount += 1;
    } else {
      // Not just "don't count it" — a freshly reset matte (resize, restart)
      // means any earlier streak no longer reflects the live pipeline.
      if (wasCounting) {
        this.log('stability reset', { hadStreak: this.stableFrameCount });
      }
      this.stableFrameCount = 0;
    }
    // Log the first few frames of every streak toward readiness, not every
    // frame after — this fires at 30fps otherwise and drowns everything else.
    if (this.stableFrameCount > 0 && this.stableFrameCount <= this.requiredStableFrames) {
      this.stabilityFrameLogCount += 1;
      if (this.stabilityFrameLogCount <= this.requiredStableFrames + 1) {
        this.log('stable frame', {
          stableFrameCount: this.stableFrameCount,
          invert: this.resolvedInvert,
          usingImage: this.usingImageBackground(),
          mode: this.options.mode,
        });
      }
    }
    if (!this.readyResolved && this.stableFrameCount >= this.requiredStableFrames) {
      this.resolveReady('stabilized');
    }
  }

  private resolveReady(reason: 'stabilized' | 'timeout') {
    if (this.readyResolved) return;
    this.readyResolved = true;
    this.log('waitUntilReady resolved', {
      reason,
      stableFrameCount: this.stableFrameCount,
      invert: this.resolvedInvert,
    });
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /**
   * Resolves once this processor's output has been internally verified —
   * polarity confidently detected and the matte has stabilized over a handful
   * of frames — rather than merely "the model loaded and the pipeline is
   * wired". Callers should gate showing the preview to the user on this, not
   * on `init()`/`setBackground()` resolving.
   *
   * Falls back to a timeout: a camera with nothing distinguishable between its
   * border and centre (e.g. pointed at a blank wall) may never clear
   * `MIN_POLARITY_GAP`, and an infinite spinner is worse than an unverified
   * preview in that edge case.
   */
  waitUntilReady(timeoutMs = 4000): Promise<void> {
    if (this.readyResolved) {
      this.log('waitUntilReady called, already resolved');
      return Promise.resolve();
    }
    this.log('waitUntilReady waiting', { timeoutMs, stableFrameCount: this.stableFrameCount });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.log('waitUntilReady TIMED OUT', { stableFrameCount: this.stableFrameCount });
        this.resolveReady('timeout');
      }, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  constructor(options: MediapipeBackgroundOptions = {}) {
    this.options = { ...MEDIAPIPE_BACKGROUND_DEFAULTS, ...options };
    this.name = `mediapipe-background-${this.options.quality}`;
    this.log('constructed', { name: this.name, mode: this.options.mode, imageUrl: this.options.imageUrl });
  }

  /** The model this processor was built with; changing it requires a new instance. */
  get quality(): SegmentationQuality {
    return this.options.quality;
  }

  /** Live-updates the numeric knobs; every one of them is re-read each frame. */
  updateOptions(
    options: Pick<
      MediapipeBackgroundOptions,
      | 'blurRadius'
      | 'edgeFeather'
      | 'temporalSmoothing'
      | 'segmentationFps'
      | 'target'
      | 'invertMask'
      | 'matteLo'
      | 'matteHi'
    >,
  ) {
    this.options = { ...this.options, ...options };
  }

  /**
   * Re-points the slow/fast callbacks — for a caller adopting a processor someone else built
   * (the call taking over the pre-join screen's). Only rebinds where reports go: the starvation
   * check runs only if onSustainedSlowFrames was set at construction.
   */
  setCallbacks(callbacks: Pick<MediapipeBackgroundOptions, 'onSustainedSlowFrames' | 'onSustainedFastFrames'>) {
    this.options = { ...this.options, ...callbacks };
  }

  /**
   * Switches between blurred and still-image backgrounds. Rejects if the image
   * cannot be loaded (CORS, 404, expired presigned URL); the processor keeps
   * running and falls back to blur, so callers can surface the error without
   * having to tear anything down.
   */
  async setBackground(options: { mode: BackgroundMode; imageUrl?: string | null }) {
    this.options = { ...this.options, ...options };
    if (options.mode !== 'image') return;
    await this.loadImage(this.options.imageUrl ?? null);
  }

  private releaseImageTexture() {
    this.compositor?.setImage(null);
    this.loadedImageUrl = undefined;
  }

  private async loadImage(url: string | null) {
    // Every load takes a ticket; a slower earlier load must not overwrite a newer one.
    const token = this.imageLoadToken + 1;
    this.imageLoadToken = token;

    if (!url) {
      this.releaseImageTexture();
      return;
    }
    if (url === this.loadedImageUrl && this.compositor?.hasImage) return;

    const image = new Image();
    // Required: without it a cross-origin image taints the canvas, and a tainted
    // canvas makes new VideoFrame(canvas) / captureStream throw, killing the track.
    image.crossOrigin = 'anonymous';
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error(
        '背景画像を読み込めませんでした。URL の有効期限か、配信元の CORS 設定を確認してください。',
      );
    }

    const compositor = this.compositor;
    if (token !== this.imageLoadToken || !compositor || this.stopped) return;

    compositor.setImage(image, image.naturalWidth / Math.max(1, image.naturalHeight));
    this.loadedImageUrl = url;
  }

  /**
   * How to read the confidence mask, as a 0/1 shader uniform. An explicit
   * `invertMask` wins; otherwise the known-correct value for this model, from
   * `MODEL_INVERT` — see its doc comment for why this is a fixed table rather
   * than something detected from live frames.
   */
  private get resolvedInvert(): number {
    if (this.options.invertMask !== undefined) return this.options.invertMask ? 1 : 0;
    return MODEL_INVERT[this.options.quality];
  }

  /** What the processor believes about mask polarity — for debug UIs. */
  get maskPolarity(): { inverted: boolean; source: 'override' | 'fixed' } {
    if (this.options.invertMask !== undefined) {
      return { inverted: this.options.invertMask, source: 'override' };
    }
    return { inverted: this.resolvedInvert === 1, source: 'fixed' };
  }

  /** False whenever image mode is requested but no image is actually loaded. */
  private usingImageBackground() {
    return this.options.mode === 'image' && !!this.compositor?.hasImage;
  }

  /**
   * There used to be a `prewarm()`/`rewireSource()` pair here meant to warm a
   * second, higher-quality processor in the background against a clone of the
   * camera track and hand off to it seamlessly. Dropped: MediaPipe's
   * tasks-vision WASM build pools GPU buffers globally rather than scoping
   * them per `ImageSegmenter` instance, so two segmenters alive at once
   * corrupt each other's GL state — "object does not belong to this context"
   * errors and the newer processor's output going solid black. See
   * `detectSegmentationQuality()` in backgroundLibrary.ts: quality is now
   * picked once, before the only processor this track will ever have is
   * built, so only one segmenter is ever alive.
   */
  async init(opts: VideoProcessorOptions) {
    this.log('init() called', { trackId: opts.track.id, trackState: opts.track.readyState });
    this.stopped = false;
    this.sourceTrack = opts.track;

    const settings = opts.track.getSettings();
    this.width = settings.width ?? 640;
    this.height = settings.height ?? 360;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    // Before MediaPipe touches the canvas, so the compositor's context attributes are the ones
    // that stick — MediaPipe's later getContext('webgl2') on the same canvas returns that object.
    this.compositor = new BackgroundCompositor(this.canvas);
    // A second concurrent segmenter/GL context (prewarm's) is exactly the kind
    // of thing that can push a browser over its concurrent-WebGL-context
    // budget, which shows up as this firing and the canvas going solid black.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.log('!!! webglcontextlost !!!', { frameCount: this.frameCount });
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.log('webglcontextrestored', { frameCount: this.frameCount });
    });

    await this.createSegmenter();
    if (this.options.mode === 'image' && this.options.imageUrl) {
      // A failed image must not stop the camera; blur is the fallback.
      await this.loadImage(this.options.imageUrl).catch((err) => {
        console.error('[mediapipe-bg]', err);
        this.log('image load FAILED, falling back to blur', { imageUrl: this.options.imageUrl, err: String(err) });
      });
    }
    this.startPipeline();
    this.startStarvationMonitor();
    this.unregisterDiagProbe?.();
    this.unregisterDiagProbe = registerDiagProbe('background', () => this.takePerfSnapshot());
    this.log('init() done', {
      processedTrackId: this.processedTrack?.id,
      usingImageBackground: this.usingImageBackground(),
    });
  }

  async restart(opts: VideoProcessorOptions) {
    this.log('restart() (device switch)', { trackId: opts.track.id });
    this.stopPipeline();
    this.sourceTrack = opts.track;
    const settings = opts.track.getSettings();
    this.resize(settings.width ?? this.width, settings.height ?? this.height);
    this.startPipeline();
    // The switch itself is a gap with no frames — start the starvation check over, grace included.
    this.startStarvationMonitor();
  }

  async destroy() {
    this.log('destroy() called', { stableFrameCount: this.stableFrameCount, readyResolved: this.readyResolved });
    this.stopped = true;
    this.stopPipeline();
    this.stopStarvationMonitor();
    this.unregisterDiagProbe?.();
    this.unregisterDiagProbe = undefined;

    await this.segmenter?.close();
    this.segmenter = undefined;

    this.compositor?.destroy();
    this.compositor = undefined;
    this.loadedImageUrl = undefined;
    this.canvas = undefined;
    this.processedTrack = undefined;
  }

  // ---------------------------------------------------------------- MediaPipe

  private async createSegmenter() {
    this.log('createSegmenter() start', { quality: this.options.quality, delegate: this.options.delegate });
    const t0 = performance.now();
    const fileset = await FilesetResolver.forVisionTasks(
      this.options.assetPaths?.wasmFileSet ?? MEDIAPIPE_WASM_BASE,
    );
    const t1 = performance.now();

    // Normally already in memory: callers that care about load time fetch it first, with a
    // deadline, before building this processor at all — see loadSegmentationModel.
    const modelAssetPath = this.options.assetPaths?.modelAssetPath;
    const modelAssetBuffer = modelAssetPath ? undefined : await loadSegmentationModel(this.options.quality);
    const t2 = performance.now();
    this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        ...(modelAssetPath ? { modelAssetPath } : { modelAssetBuffer }),
        delegate: this.options.delegate,
      },
      canvas: this.canvas,
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
    });

    // Keep the label map for picking which mask to read. Deliberately do NOT
    // infer polarity from it: the binary selfie model lists a "background" label
    // yet hands back a single mask scoring the *subject*, so trusting the labels
    // here inverted the whole effect on that model.
    this.labels = this.segmenter.getLabels();
    this.loadTimings.filesetMs = Math.round(t1 - t0);
    this.loadTimings.modelFetchMs = Math.round(t2 - t1);
    this.loadTimings.createSegmenterMs = Math.round(performance.now() - t2);
    this.loadTimings.firstSegmentationMs = undefined;
    this.log('createSegmenter() done', { ms: Math.round(performance.now() - t0), labels: this.labels });
  }

  // ----------------------------------------------------------------- Plumbing

  private startPipeline() {
    if (!this.sourceTrack || !this.canvas) {
      this.log('startPipeline() aborted, missing sourceTrack/canvas', {
        hasSourceTrack: !!this.sourceTrack,
        hasCanvas: !!this.canvas,
      });
      return;
    }

    const canUseInsertableStreams =
      typeof MediaStreamTrackGenerator !== 'undefined' &&
      typeof MediaStreamTrackProcessor !== 'undefined';

    this.log('startPipeline()', {
      sourceTrackId: this.sourceTrack.id,
      sourceTrackState: this.sourceTrack.readyState,
      canUseInsertableStreams,
    });

    if (canUseInsertableStreams) {
      this.streamProcessor = new MediaStreamTrackProcessor({
        track: this.sourceTrack as MediaStreamVideoTrack,
      });
      this.streamGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
      this.abortController = new AbortController();
      this.frameCount = 0;

      const transformer = new TransformStream<VideoFrame, VideoFrame>({
        transform: (frame, controller) => this.transform(frame, controller),
      });

      this.streamProcessor.readable
        .pipeThrough(transformer, { signal: this.abortController.signal })
        .pipeTo(this.streamGenerator.writable, { signal: this.abortController.signal })
        .catch((err) => {
          if (!this.stopped) {
            console.error('[mediapipe-bg] pipeline error:', err);
            this.log('pipeline stream errored', { err: String(err) });
          }
        });

      this.processedTrack = this.streamGenerator as unknown as MediaStreamTrack;
      this.log('startPipeline() insertable-streams path wired', { processedTrackId: this.processedTrack.id });
      return;
    }

    // Safari / Firefox: no insertable streams, so pull frames off a hidden
    // <video> and publish the canvas via captureStream instead.
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([this.sourceTrack]);
    this.fallbackVideo = video;

    const frameRate = this.sourceTrack.getSettings().frameRate ?? 30;
    this.fallbackStream = this.canvas.captureStream(frameRate);
    this.processedTrack = this.fallbackStream.getVideoTracks()[0];

    void video
      .play()
      .then(() => {
        this.scheduleFallbackFrame();
        this.startHiddenTicker();
      })
      .catch((err) => console.error('[mediapipe-bg] could not start fallback video:', err));
  }

  private renderFallbackFrame() {
    const video = this.fallbackVideo;
    if (!video || this.stopped) return;
    try {
      if (video.videoWidth > 0) {
        this.resize(video.videoWidth, video.videoHeight);
        this.renderFrame(video);
      }
    } catch (err) {
      console.error('[mediapipe-bg] render error:', err);
    }
  }

  /**
   * requestVideoFrameCallback/requestAnimationFrame stop firing while the tab is hidden, and the
   * canvas captureStream then has nothing new to send. While hidden, a worker metronome (workers
   * are exempt from background timer throttling) renders at ~20fps instead; while visible it's
   * idle. Not enough on Safari, which also pauses the soundless source <video> and the canvas
   * capture stream itself in hidden tabs (WebKit bug 242679) — Safari 18+ uses the worker
   * pipeline instead (WorkerBackgroundProcessor), so this path only serves older Safari/Firefox.
   */
  private startHiddenTicker() {
    if (this.hiddenTicker || this.stopped) return;
    const ticker = new Worker(new URL('./videoDelayTicker.worker.ts', import.meta.url), { type: 'module' });
    ticker.onmessage = () => {
      if (document.visibilityState === 'hidden') this.renderFallbackFrame();
    };
    const sync = () => ticker.postMessage(document.visibilityState === 'hidden' ? 'start' : 'stop');
    document.addEventListener('visibilitychange', sync);
    sync();
    this.hiddenTicker = ticker;
    this.onVisibilityChange = sync;
  }

  private scheduleFallbackFrame() {
    const video = this.fallbackVideo;
    if (!video || this.stopped) return;

    const render = () => {
      if (!this.fallbackVideo || this.stopped) return;
      this.renderFallbackFrame();
      this.scheduleFallbackFrame();
    };

    if ('requestVideoFrameCallback' in video) {
      this.fallbackHandle = video.requestVideoFrameCallback(() => render());
    } else {
      this.fallbackHandle = requestAnimationFrame(() => render());
    }
  }

  private stopPipeline() {
    this.abortController?.abort();
    this.abortController = undefined;
    this.streamProcessor = undefined;
    this.streamGenerator = undefined;

    if (this.fallbackVideo && this.fallbackHandle !== undefined) {
      if ('cancelVideoFrameCallback' in this.fallbackVideo) {
        this.fallbackVideo.cancelVideoFrameCallback(this.fallbackHandle);
      } else {
        cancelAnimationFrame(this.fallbackHandle);
      }
    }
    this.fallbackHandle = undefined;
    if (this.onVisibilityChange) document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.onVisibilityChange = undefined;
    this.hiddenTicker?.terminate();
    this.hiddenTicker = undefined;
    if (this.fallbackVideo) {
      this.fallbackVideo.srcObject = null;
      this.fallbackVideo = undefined;
    }
    this.fallbackStream?.getTracks().forEach((track) => track.stop());
    this.fallbackStream = undefined;
  }

  private frameCount = 0;

  // Feeds the in-call diagnostics recorder (lib/connectDiagnostics), reset on every read.
  // Main-thread wall time: GL calls are queued to the GPU asynchronously, so on a healthy GPU
  // this is mostly submission cost — but on a software-rendered one (SwiftShader etc.) it *is*
  // the rendering, which is exactly the case these numbers are here to catch.
  private diagFrames = 0;
  private diagFrameMsTotal = 0;
  private diagFrameMsMax = 0;
  private diagSegmentations = 0;
  private diagSegmentMsTotal = 0;
  private diagSegmentMsMax = 0;
  private diagLastReadAt = 0;
  private unregisterDiagProbe?: () => void;

  /** The camera's own frame rate — what "keeping up" means for this processor. */
  private expectedFps(): number {
    const rate = this.sourceTrack?.getSettings().frameRate;
    return Math.min(rate && rate > 0 ? rate : 20, 30);
  }

  private startStarvationMonitor() {
    this.stopStarvationMonitor();
    if (!this.options.onSustainedSlowFrames) return;
    const now = performance.now();
    this.starvationMonitorStart = now;
    this.starvationWindowStart = now;
    this.starvationFrames = 0;
    this.starvationTimer = setInterval(() => this.checkStarvation(), 1000);
  }

  private stopStarvationMonitor() {
    if (this.starvationTimer !== undefined) clearInterval(this.starvationTimer);
    this.starvationTimer = undefined;
  }

  /**
   * Runs on a 1s timer rather than per frame, because the case it exists for is frames *not*
   * arriving. A main-thread freeze delays the timer itself, so the freeze lands inside the
   * window as elapsed time with no frames — counted as starvation, which is what it is.
   */
  private checkStarvation() {
    const now = performance.now();
    const track = this.sourceTrack;
    const inGrace =
      !this.readyResolved && now - this.starvationMonitorStart < MediapipeBackgroundProcessor.STARVATION_GRACE_MS;
    const eligible =
      !this.stopped &&
      !this.slowCallbackFired &&
      !inGrace &&
      document.visibilityState === 'visible' &&
      track?.readyState === 'live' &&
      track.enabled &&
      !track.muted;
    if (!eligible) {
      this.starvationWindowStart = now;
      this.starvationFrames = 0;
      return;
    }
    const elapsed = now - this.starvationWindowStart;
    if (elapsed < MediapipeBackgroundProcessor.STARVATION_WINDOW_MS) return;
    const fps = this.starvationFrames / (elapsed / 1000);
    const expectedFps = this.expectedFps();
    this.starvationWindowStart = now;
    this.starvationFrames = 0;
    if (fps < expectedFps * MediapipeBackgroundProcessor.STARVATION_MIN_FPS_RATIO) {
      this.slowCallbackFired = true;
      this.log('starved: frames not keeping up', { fps: Math.round(fps * 10) / 10, expectedFps });
      this.options.onSustainedSlowFrames?.({
        trigger: 'starved',
        fps: Math.round(fps * 10) / 10,
        expectedFps: Math.round(expectedFps),
      });
    }
  }

  /** Per-frame costs since the previous call, then resets — what the diagnostics probe records,
   *  also read directly by the blur lab. */
  takePerfSnapshot(): Record<string, unknown> {
    const now = performance.now();
    const seconds = this.diagLastReadAt ? (now - this.diagLastReadAt) / 1000 : undefined;
    // Two decimals: on a fast machine a frame costs ~1ms, and one decimal hid ±10% differences.
    const avg = (total: number, count: number) => (count ? Math.round((total / count) * 100) / 100 : undefined);
    const data = {
      path: 'main',
      quality: this.options.quality,
      mode: this.options.mode,
      delegate: this.options.delegate,
      fps: seconds ? Math.round((this.diagFrames / seconds) * 10) / 10 : undefined,
      frameMsAvg: avg(this.diagFrameMsTotal, this.diagFrames),
      frameMsMax: Math.round(this.diagFrameMsMax),
      segmentations: this.diagSegmentations,
      segmentMsAvg: avg(this.diagSegmentMsTotal, this.diagSegmentations),
      segmentMsMax: Math.round(this.diagSegmentMsMax),
    };
    this.diagLastReadAt = now;
    this.diagFrames = 0;
    this.diagFrameMsTotal = 0;
    this.diagFrameMsMax = 0;
    this.diagSegmentations = 0;
    this.diagSegmentMsTotal = 0;
    this.diagSegmentMsMax = 0;
    return data;
  }

  private transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
    let handedOff = false;
    this.frameCount += 1;
    const n = this.frameCount;
    try {
      if (frame.codedWidth === 0 || frame.codedHeight === 0 || this.stopped || !this.canvas) {
        this.log('transform() PASSTHROUGH (raw frame, not composited)', {
          frameNum: n,
          codedWidth: frame.codedWidth,
          codedHeight: frame.codedHeight,
          stopped: this.stopped,
          hasCanvas: !!this.canvas,
        });
        controller.enqueue(frame);
        handedOff = true;
        return;
      }

      this.resize(frame.displayWidth, frame.displayHeight);
      this.renderFrame(frame);
      if (n <= 3 || n % 60 === 0) {
        this.log('transform() composited frame', {
          frameNum: n,
          canvasSize: `${this.canvas.width}x${this.canvas.height}`,
          invert: this.resolvedInvert,
          usingImage: this.usingImageBackground(),
          glContextLost: this.compositor?.gl.isContextLost(),
        });
      }
      controller.enqueue(new VideoFrame(this.canvas, { timestamp: frame.timestamp }));
    } catch (err) {
      console.error('[mediapipe-bg] frame failed, passing it through:', err);
      this.log('transform() EXCEPTION, passing raw frame through', {
        frameNum: n,
        err: String(err),
        glContextLost: this.compositor?.gl.isContextLost(),
      });
      if (!handedOff) {
        controller.enqueue(frame);
        handedOff = true;
      }
    } finally {
      if (!handedOff) frame.close();
    }
  }

  // ------------------------------------------------------------------- Render

  private resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0 || !this.compositor) return;
    this.width = width;
    this.height = height;
    this.compositor.resize(width, height);
  }

  private renderFrame(source: VideoFrame | HTMLVideoElement) {
    const compositor = this.compositor;
    if (!compositor) return;

    const t0 = performance.now();

    compositor.uploadFrame(source);
    this.updateMatte(source);

    compositor.render({ mode: this.options.mode, blurRadius: this.options.blurRadius, target: this.options.target });
    this.trackStability();

    // While not yet confirmed stable (fresh processor, matte/temporal-smoothing still
    // converging), blank the visible output instead of publishing it. This runs *after*
    // composite() so everything upstream — matte history, temporal smoothing, the
    // stability counter itself — keeps accumulating normally underneath; only what
    // actually reaches the canvas (and from there, the published track) is suppressed.
    if (!this.readyResolved) compositor.blank();

    if (this.options.measureGpuSync) compositor.gl.finish();
    const frameMs = performance.now() - t0;
    this.starvationFrames += 1;
    this.diagFrames += 1;
    this.diagFrameMsTotal += frameMs;
    if (frameMs > this.diagFrameMsMax) this.diagFrameMsMax = frameMs;
    this.trackFramePerf(frameMs);
  }

  /**
   * Feeds one rolling window and reports its average once the window is full — shared by both
   * the long/lenient and short/strict slow-frame windows below (and the fast-frame one), so the
   * two don't duplicate the push/trim/average bookkeeping with only their constants differing.
   * Returns null until the window has enough samples to mean anything.
   */
  private static pushPerfWindow(state: PerfWindowState, windowSize: number, durationMs: number): number | null {
    state.durations.push(durationMs);
    state.sum += durationMs;
    if (state.durations.length > windowSize) {
      state.sum -= state.durations.shift()!;
    }
    if (state.durations.length < windowSize) return null;
    return state.sum / state.durations.length;
  }

  /**
   * Averages over rolling windows rather than reacting to any single frame — segmentForVideo
   * only actually runs on the fraction of frames allowed by segmentationFps, so most
   * individual frames are cheap GL-only work and a one-off spike or dip (a GC pause, a
   * dropped frame) is not the same thing as this processor genuinely being too heavy, or
   * comfortably light, for the device.
   *
   * Two windows feed the same slow-frame callback: PERF_SLOW_WINDOW catches a steady, lower-grade
   * cost held for the whole ~4.5s window, and PERF_SPIKE_WINDOW catches a shorter but more severe
   * patch (~1.5s) that the longer window would otherwise average away — see PERF_SPIKE_WINDOW's
   * comment. Whichever crosses its own threshold first fires; there is only ever one downgrade.
   */
  private trackFramePerf(durationMs: number) {
    const slowCb = this.options.onSustainedSlowFrames;
    if (slowCb && !this.slowCallbackFired) {
      const sustainedAvg = MediapipeBackgroundProcessor.pushPerfWindow(
        this.slowWindow,
        MediapipeBackgroundProcessor.PERF_SLOW_WINDOW,
        durationMs,
      );
      const spikeAvg = MediapipeBackgroundProcessor.pushPerfWindow(
        this.spikeWindow,
        MediapipeBackgroundProcessor.PERF_SPIKE_WINDOW,
        durationMs,
      );
      const triggeredBy =
        sustainedAvg !== null && sustainedAvg > MediapipeBackgroundProcessor.PERF_SLOW_AVG_MS
          ? ('sustained' as const)
          : spikeAvg !== null && spikeAvg > MediapipeBackgroundProcessor.PERF_SPIKE_AVG_MS
            ? ('spike' as const)
            : null;
      if (triggeredBy) {
        const avg = triggeredBy === 'sustained' ? sustainedAvg! : spikeAvg!;
        this.slowCallbackFired = true;
        this.log('sustained slow frames detected', { avgFrameMs: Math.round(avg), triggeredBy });
        slowCb({ trigger: triggeredBy, avgFrameMs: Math.round(avg * 10) / 10 });
      }
    }

    const fastCb = this.options.onSustainedFastFrames;
    if (fastCb && !this.fastCallbackFired) {
      this.fastFrameDurations.push(durationMs);
      this.fastFrameTimes.push(performance.now());
      this.fastFrameDurationSum += durationMs;
      if (this.fastFrameDurations.length > MediapipeBackgroundProcessor.PERF_FAST_WINDOW) {
        this.fastFrameDurationSum -= this.fastFrameDurations.shift()!;
        this.fastFrameTimes.shift();
      }
      if (this.fastFrameDurations.length >= MediapipeBackgroundProcessor.PERF_FAST_WINDOW) {
        const avg = this.fastFrameDurationSum / this.fastFrameDurations.length;
        const spanSec = (this.fastFrameTimes[this.fastFrameTimes.length - 1] - this.fastFrameTimes[0]) / 1000;
        const fps = spanSec > 0 ? (this.fastFrameTimes.length - 1) / spanSec : 0;
        const expectedFps = this.expectedFps();
        if (
          avg < MediapipeBackgroundProcessor.PERF_FAST_AVG_MS &&
          fps >= expectedFps * MediapipeBackgroundProcessor.PERF_FAST_MIN_FPS_RATIO
        ) {
          this.fastCallbackFired = true;
          this.log('sustained fast frames detected', { avgFrameMs: Math.round(avg), fps: Math.round(fps) });
          fastCb(avg);
        }
      }
    }
  }

  private updateMatte(source: VideoFrame | HTMLVideoElement) {
    const compositor = this.compositor;
    const segmenter = this.segmenter;
    if (!compositor || !segmenter) return;
    const hasMatteHistory = compositor.hasMatteHistory;

    // Throttle inference; in-between frames reuse the matte we already have.
    const now = performance.now();
    if (this.options.segmentationScheduler === 'exact') {
      const elapsed = this.lastSchedulerAt ? now - this.lastSchedulerAt : Infinity;
      this.lastSchedulerAt = now;
      this.segmentationCredit = Math.min(2, this.segmentationCredit + (elapsed * this.options.segmentationFps) / 1000);
      if (hasMatteHistory && this.segmentationCredit < 1) return;
      this.segmentationCredit = Math.max(0, this.segmentationCredit - 1);
    } else {
      const minInterval = 1000 / Math.max(1, this.options.segmentationFps);
      if (hasMatteHistory && now - this.lastSegmentationMs < minInterval) return;
    }
    this.lastSegmentationMs = now;

    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const timestamp = Math.max(this.lastTimestampMs + 1, Math.round(now));
    this.lastTimestampMs = timestamp;

    // segmentForVideo is synchronous: the callback runs before it returns, and the
    // masks are only valid inside it.
    const segmentStart = performance.now();
    segmenter.segmentForVideo(source, timestamp, (result) => {
      try {
        const masks = result.confidenceMasks;
        if (!masks?.length) return;

        if (!this.maskIndexResolved) {
          // Labels line up with masks only when there is one mask per label; with
          // a single mask there is nothing to choose and index 0 is the answer.
          const backgroundIndex = this.labels.findIndex(
            (label) => label.toLowerCase() === 'background',
          );
          this.maskIndex =
            masks.length === this.labels.length && backgroundIndex >= 0 ? backgroundIndex : 0;
          this.maskIndexResolved = true;
        }

        const mask = masks[this.maskIndex];
        if (!mask) return;
        compositor.composeMatte(mask.getAsWebGLTexture(), this.matteOptions());
      } finally {
        result.close();
      }
    });
    const segmentMs = performance.now() - segmentStart;
    // The very first inference is where the GPU delegate compiles its shaders — measured at 4.3s
    // on a 2-core MacBook Air, i.e. a big share of the "switching the effect freezes the call".
    if (this.loadTimings.firstSegmentationMs === undefined) {
      this.loadTimings.firstSegmentationMs = Math.round(segmentMs);
    }
    this.diagSegmentations += 1;
    this.diagSegmentMsTotal += segmentMs;
    if (segmentMs > this.diagSegmentMsMax) this.diagSegmentMsMax = segmentMs;
  }

  private matteOptions(): MatteOptions {
    return {
      invert: this.resolvedInvert,
      matteLo: this.options.matteLo ?? 0.3,
      matteHi: this.options.matteHi ?? 0.75,
      temporalSmoothing: this.options.temporalSmoothing,
      edgeFeather: this.options.edgeFeather,
    };
  }
}

/** Convenience factory mirroring the `BackgroundBlur(...)` call shape. */
export function MediapipeBackgroundBlur(options: MediapipeBackgroundOptions = {}) {
  return new MediapipeBackgroundProcessor(options);
}
