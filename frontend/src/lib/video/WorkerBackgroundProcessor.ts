import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';
import {
  loadSegmentationModel,
  MediapipeBackgroundProcessor,
  MEDIAPIPE_BACKGROUND_DEFAULTS,
  MEDIAPIPE_WASM_BASE,
  MODEL_INVERT,
  type BackgroundMode,
  type MediapipeBackgroundOptions,
  type SegmentationQuality,
} from './MediapipeBackgroundProcessor';
import type { CompositorRequest, CompositorResponse, CompositorSettings, CompositorStats } from './backgroundCompositor.worker';
import type { SegmenterLoadTimings, SegmenterRequest, SegmenterResponse } from './backgroundSegmenter.worker';
import { diagEvent, registerDiagProbe } from '../connectDiagnostics';

/**
 * The background effect with all per-frame work off the main thread — the same effect as
 * MediapipeBackgroundProcessor (same shaders via BackgroundCompositor, same model files, same
 * options and callbacks), so callers can use either.
 *
 *   camera track ── MediaStreamTrackProcessor.readable ──▶ compositor worker ──▶ MediaStreamTrackGenerator
 *                                                              ▲ │  (processedTrack)
 *                                         mask (ImageBitmap)   │ ▼  frame (VideoFrame)
 *                                                          segmenter worker
 *
 * Why: on a slow machine the main-thread version froze the whole page for seconds every time a
 * model loaded (4.3s / 7.2s measured on a 2-core MacBook Air), and every quality change had to
 * blank the video while the old segmenter was torn down and a new one built. Here the page never
 * waits on the effect, and setQuality() builds and warms the new segmenter in its own worker
 * beside the running one before handing over — no black frames, no freeze. Measured on an M4:
 * 1.08-1.13x the main-thread cost, zero black frames across model swaps.
 *
 * Chrome/Edge only (needs MediaStreamTrackProcessor/Generator on the page and OffscreenCanvas
 * WebGL2 in workers). If the workers can't start, init() quietly runs a MediapipeBackgroundProcessor
 * instead and disables this path for the rest of the page; if they break later, it reports
 * onPipelineFailure so the caller can rebuild (which then gets the main-thread version).
 */

export type WorkerBackgroundOptions = MediapipeBackgroundOptions & {
  /**
   * The worker pipeline broke mid-call (a crashed worker, a lost GPU context). The published
   * video has stopped updating; the caller should rebuild the effect, which will then use the
   * main-thread processor — this path stays off for the rest of the page.
   */
  onPipelineFailure?: (reason: string) => void;
};

/** Height of the mask the segmenter hands over, per model — about each model's own resolution. */
const SEGMENTER_MASK_HEIGHT: Record<SegmentationQuality, number> = { balanced: 144, high: 256 };

/** Generous: on a slow machine a model load plus first inference took 4-7s on the main thread. */
const INIT_TIMEOUT_MS = 20_000;

// Same thresholds as MediapipeBackgroundProcessor's per-frame windows, applied to the compositor's
// once-a-second reports. "Cost per frame" is both workers' time divided by frames, which is what the
// main-thread version's per-frame duration measures too.
const PERF_SLOW_WINDOW_S = 5;
const PERF_SLOW_AVG_MS = 20;
const PERF_SPIKE_WINDOW_S = 2;
const PERF_SPIKE_AVG_MS = 33;
const PERF_FAST_WINDOW_S = 8;
const PERF_FAST_AVG_MS = 6;
const PERF_FAST_MIN_FPS_RATIO = 0.85;
const STARVATION_WINDOW_MS = 5000;
const STARVATION_MIN_FPS_RATIO = 0.5;
const STARVATION_GRACE_MS = 10_000;

let disabledReason: string | null = null;

/** Turns the worker path off for the rest of the page (createBackgroundProcessor then picks the main thread). */
export function disableWorkerBackground(reason: string) {
  if (disabledReason) return;
  disabledReason = reason;
  console.warn('[bg-worker] worker pipeline disabled for this page:', reason);
  diagEvent('background-worker-disabled', { reason });
}

export function workerBackgroundDisabledReason() {
  return disabledReason;
}

export function supportsWorkerBackground(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    typeof MediaStreamTrackGenerator !== 'undefined' &&
    typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function'
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

type SegmenterHandle = { worker: Worker; quality: SegmentationQuality };

type ResolvedOptions = Required<
  Omit<MediapipeBackgroundOptions, 'assetPaths' | 'invertMask' | 'onSustainedSlowFrames' | 'onSustainedFastFrames'>
> &
  WorkerBackgroundOptions;

export class WorkerBackgroundProcessor implements TrackProcessor<Track.Kind.Video> {
  /** Constant: the model changes in place (setQuality), so LiveKit must keep treating this as one processor. */
  readonly name = 'mediapipe-background-worker';

  processedTrack?: MediaStreamTrack;

  /** Where the last segmenter load spent its time (ms) — same shape as the main-thread processor's. */
  readonly loadTimings: MediapipeBackgroundProcessor['loadTimings'] = {};

  private options: ResolvedOptions;
  private currentQuality: SegmentationQuality;
  private compositor?: Worker;
  private segmenter?: SegmenterHandle;
  private sourceTrack?: MediaStreamTrack;
  private aspect = 16 / 9;
  /** The main-thread processor this runs instead when the workers couldn't start. */
  private fallback?: MediapipeBackgroundProcessor;
  private failedReason: string | null = null;
  private stopped = false;
  private swapChain: Promise<void> = Promise.resolve();
  private segmenterRestarted = false;
  private compositorStarted?: { resolve: () => void; reject: (err: Error) => void };
  private compositorStopped?: () => void;

  private readyResolved = false;
  private readyWaiters: Array<() => void> = [];

  private loadedImageUrl?: string | null;
  private imageLoadToken = 0;

  private history: CompositorStats[] = [];
  private slowCallbackFired = false;
  private fastCallbackFired = false;
  private starvationTimer?: ReturnType<typeof setInterval>;
  private starvationFrames = 0;
  private starvationWindowStart = 0;
  private starvationMonitorStart = 0;

  private diag = { ...emptyTotals(), seconds: 0 };
  private unregisterDiagProbe?: () => void;

  constructor(options: WorkerBackgroundOptions = {}) {
    this.options = { ...MEDIAPIPE_BACKGROUND_DEFAULTS, ...options };
    this.currentQuality = this.options.quality;
  }

  get quality(): SegmentationQuality {
    return this.fallback?.quality ?? this.currentQuality;
  }

  /** True when setQuality() can change the model without rebuilding (no fallback, not failed). */
  get canSwapQuality() {
    return !this.fallback && !this.failedReason && !!this.compositor;
  }

  /** Set once the pipeline has broken mid-call; the caller should rebuild. */
  get failed() {
    return !!this.failedReason;
  }

  /** Which pipeline is actually running — for diagnostics. */
  get pipeline(): 'worker' | 'main' {
    return this.fallback ? 'main' : 'worker';
  }

  // -------------------------------------------------------------------- Setup

  async init(opts: VideoProcessorOptions) {
    this.stopped = false;
    this.sourceTrack = opts.track;
    if (disabledReason || !supportsWorkerBackground()) {
      await this.initFallback(opts);
      return;
    }
    try {
      await withTimeout(this.initWorkers(opts.track), INIT_TIMEOUT_MS, 'worker pipeline start');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[bg-worker] could not start, using the main-thread processor:', err);
      await this.teardownWorkers();
      disableWorkerBackground(reason);
      await this.initFallback(opts);
    }
  }

  private async initFallback(opts: VideoProcessorOptions) {
    this.fallback = new MediapipeBackgroundProcessor({ ...this.options, quality: this.currentQuality });
    await this.fallback.init(opts);
    this.processedTrack = this.fallback.processedTrack;
  }

  private async initWorkers(track: MediaStreamTrack) {
    const settings = track.getSettings();
    const width = settings.width ?? 640;
    const height = settings.height ?? 360;
    this.aspect = width / Math.max(1, height);

    const worker = new Worker(new URL('./backgroundCompositor.worker.ts', import.meta.url), { type: 'module' });
    this.compositor = worker;
    const started = new Promise<void>((resolve, reject) => (this.compositorStarted = { resolve, reject }));
    worker.onmessage = (event: MessageEvent<CompositorResponse>) => this.onCompositorMessage(event.data);
    worker.onerror = (event) => {
      const message = `compositor worker error: ${event.message}`;
      if (this.compositorStarted) this.compositorStarted.reject(new Error(message));
      else this.pipelineFailed(message);
    };

    const processor = new MediaStreamTrackProcessor({ track: track as MediaStreamVideoTrack });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.processedTrack = generator as unknown as MediaStreamTrack;
    const request: CompositorRequest = {
      type: 'init',
      readable: processor.readable,
      writable: generator.writable,
      width,
      height,
      settings: this.compositorSettings(),
    };
    worker.postMessage(request, [processor.readable, generator.writable]);
    await started;
    this.compositorStarted = undefined;

    await this.startSegmenter(this.currentQuality);
    // Gave up meanwhile (init timed out and fell back): the fallback owns the rest.
    if (!this.compositor) return;
    if (this.options.mode === 'image' && this.options.imageUrl) {
      // A failed image must not stop the camera; blur is the fallback.
      await this.loadImage(this.options.imageUrl).catch((err) => console.error('[bg-worker]', err));
    }
    this.startStarvationMonitor();
    this.unregisterDiagProbe?.();
    this.unregisterDiagProbe = registerDiagProbe('background', () => this.takePerfSnapshot());
  }

  private compositorSettings(): CompositorSettings {
    const o = this.options;
    return {
      mode: o.mode,
      target: o.target,
      blurRadius: o.blurRadius,
      temporalSmoothing: o.temporalSmoothing,
      edgeFeather: o.edgeFeather,
      matteLo: o.matteLo,
      matteHi: o.matteHi,
      segmentationFps: o.segmentationFps,
      segmentationScheduler: o.segmentationScheduler,
      invertOverride: o.invertMask === undefined ? null : o.invertMask ? 1 : 0,
      measureGpuSync: o.measureGpuSync,
    };
  }

  private postToCompositor(message: CompositorRequest, transfer: Transferable[] = []) {
    this.compositor?.postMessage(message, transfer);
  }

  /**
   * Builds a segmenter worker for `quality`, waits until it is loaded *and* warmed up (first
   * inference done), then hands it to the compositor and retires the previous one. The compositor
   * keeps using the previous matte source the whole time.
   */
  private async startSegmenter(quality: SegmentationQuality) {
    const modelPath = this.options.assetPaths?.modelAssetPath;
    const model: { url: string } | { buffer: ArrayBuffer } = modelPath
      ? { url: modelPath }
      : // A copy: the page-wide download stays cached for later swaps and the main-thread path.
        { buffer: (await loadSegmentationModel(quality)).slice().buffer };
    const worker = new Worker(new URL('./backgroundSegmenter.worker.ts', import.meta.url), { type: 'module' });
    const channel = new MessageChannel();
    let readyHandled = false;
    const ready = new Promise<SegmenterLoadTimings>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<SegmenterResponse>) => {
        const message = event.data;
        if (message.type === 'ready') {
          readyHandled = true;
          resolve(message.loadTimings);
        } else if (message.type === 'error') {
          if (!readyHandled) reject(new Error(message.message));
          else if (message.fatal && this.segmenter?.worker === worker) this.onSegmenterFailed(message.message);
        }
      };
      worker.onerror = (event) => {
        const message = `segmenter worker error: ${event.message}`;
        if (!readyHandled) reject(new Error(message));
        else if (this.segmenter?.worker === worker) this.onSegmenterFailed(message);
      };
    });
    const request: SegmenterRequest = {
      type: 'init',
      port: channel.port2,
      wasmBase: this.options.assetPaths?.wasmFileSet ?? MEDIAPIPE_WASM_BASE,
      model,
      delegate: this.options.delegate,
      invert: MODEL_INVERT[quality],
      maskHeight: SEGMENTER_MASK_HEIGHT[quality],
      aspect: this.aspect,
    };
    const transfer: Transferable[] = [channel.port2];
    if ('buffer' in model) transfer.push(model.buffer);
    worker.postMessage(request, transfer);

    let timings: SegmenterLoadTimings;
    try {
      timings = await ready;
    } catch (err) {
      worker.terminate();
      throw err;
    }
    if (this.stopped || !this.compositor) {
      worker.terminate();
      return;
    }
    this.postToCompositor({ type: 'attachSegmenter', port: channel.port1 }, [channel.port1]);
    const previous = this.segmenter;
    this.segmenter = { worker, quality };
    Object.assign(this.loadTimings, timings, { modelFetchMs: 0 });
    if (previous) void this.retireSegmenter(previous);
  }

  private async retireSegmenter({ worker }: SegmenterHandle) {
    await new Promise<void>((resolve) => {
      worker.onmessage = (event: MessageEvent<SegmenterResponse>) => {
        if (event.data.type === 'stopped') resolve();
      };
      worker.onerror = () => resolve();
      setTimeout(resolve, 2000);
      worker.postMessage({ type: 'stop' } satisfies SegmenterRequest);
    });
    worker.terminate();
  }

  /** A running segmenter broke: one fresh attempt at the same model, then give up on the pipeline. */
  private onSegmenterFailed(reason: string) {
    console.error('[bg-worker] segmenter failed:', reason);
    if (this.segmenterRestarted) {
      this.pipelineFailed(`segmenter: ${reason}`);
      return;
    }
    this.segmenterRestarted = true;
    diagEvent('background-segmenter-restart', { reason });
    this.swapChain = this.swapChain
      .then(() => this.startSegmenter(this.currentQuality))
      .catch((err) => this.pipelineFailed(`segmenter restart: ${err instanceof Error ? err.message : String(err)}`));
  }

  private pipelineFailed(reason: string) {
    if (this.failedReason || this.stopped) return;
    this.failedReason = reason;
    console.error('[bg-worker] pipeline failed:', reason);
    disableWorkerBackground(reason);
    this.options.onPipelineFailure?.(reason);
  }

  private async teardownWorkers() {
    const compositor = this.compositor;
    this.compositor = undefined;
    const segmenter = this.segmenter;
    this.segmenter = undefined;
    if (compositor) {
      await new Promise<void>((resolve) => {
        this.compositorStopped = resolve;
        setTimeout(resolve, 2000);
        compositor.postMessage({ type: 'stop' } satisfies CompositorRequest);
      });
      compositor.terminate();
    }
    if (segmenter) await this.retireSegmenter(segmenter);
    this.processedTrack?.stop();
    this.processedTrack = undefined;
  }

  async restart(opts: VideoProcessorOptions) {
    this.sourceTrack = opts.track;
    if (this.fallback) {
      await this.fallback.restart(opts);
      this.processedTrack = this.fallback.processedTrack;
      return;
    }
    const processor = new MediaStreamTrackProcessor({ track: opts.track as MediaStreamVideoTrack });
    this.postToCompositor({ type: 'replaceSource', readable: processor.readable }, [processor.readable]);
    // The switch itself is a gap with no frames — start the starvation check over, grace included.
    this.startStarvationMonitor();
  }

  async destroy() {
    this.stopped = true;
    this.stopStarvationMonitor();
    this.unregisterDiagProbe?.();
    this.unregisterDiagProbe = undefined;
    if (this.fallback) {
      await this.fallback.destroy();
      this.processedTrack = undefined;
      return;
    }
    await this.teardownWorkers();
  }

  // ----------------------------------------------------------------- Controls

  /**
   * Changes the model without interrupting the video: the new segmenter loads and warms up in
   * its own worker while the current one keeps working, then takes over. Resolves at the
   * hand-over. Calls are queued, so overlapping toggles apply in order.
   */
  setQuality(quality: SegmentationQuality): Promise<void> {
    if (!this.canSwapQuality) return Promise.reject(new Error('this processor cannot change quality in place'));
    const run = this.swapChain.then(async () => {
      if (quality === this.currentQuality || this.stopped) return;
      await this.startSegmenter(quality);
      this.currentQuality = quality;
      // A different model is a different cost; judge it afresh.
      this.history = [];
      this.slowCallbackFired = false;
      this.fastCallbackFired = false;
    });
    this.swapChain = run.catch(() => {});
    return run;
  }

  /** Re-points the callbacks — see MediapipeBackgroundProcessor.setCallbacks. */
  setCallbacks(
    callbacks: Pick<WorkerBackgroundOptions, 'onSustainedSlowFrames' | 'onSustainedFastFrames' | 'onPipelineFailure'>,
  ) {
    this.options = { ...this.options, ...callbacks };
    this.fallback?.setCallbacks(callbacks);
  }

  /** Live-updates the numeric knobs, like MediapipeBackgroundProcessor.updateOptions. */
  updateOptions(options: Parameters<MediapipeBackgroundProcessor['updateOptions']>[0]) {
    if (this.fallback) {
      this.fallback.updateOptions(options);
      return;
    }
    this.options = { ...this.options, ...options };
    this.postToCompositor({ type: 'settings', settings: this.compositorSettings() });
  }

  /**
   * Switches between blurred and still-image backgrounds. Rejects if the image cannot be loaded;
   * the effect keeps running on blur in that case (same contract as the main-thread processor).
   */
  async setBackground(options: { mode: BackgroundMode; imageUrl?: string | null }) {
    if (this.fallback) {
      await this.fallback.setBackground(options);
      return;
    }
    this.options = { ...this.options, ...options };
    this.postToCompositor({ type: 'settings', settings: { mode: this.options.mode } });
    if (options.mode !== 'image') return;
    await this.loadImage(this.options.imageUrl ?? null);
  }

  private async loadImage(url: string | null) {
    // Every load takes a ticket; a slower earlier load must not overwrite a newer one.
    const token = ++this.imageLoadToken;
    if (!url) {
      this.loadedImageUrl = undefined;
      this.postToCompositor({ type: 'setImage', image: null });
      return;
    }
    if (url === this.loadedImageUrl) return;

    const image = new Image();
    // Required: a tainted image can't be turned into an ImageBitmap for the worker.
    image.crossOrigin = 'anonymous';
    image.src = url;
    let bitmap: ImageBitmap;
    try {
      await image.decode();
      bitmap = await createImageBitmap(image);
    } catch {
      throw new Error('背景画像を読み込めませんでした。URL の有効期限か、配信元の CORS 設定を確認してください。');
    }
    if (token !== this.imageLoadToken || this.stopped || !this.compositor) {
      bitmap.close();
      return;
    }
    this.postToCompositor({ type: 'setImage', image: bitmap }, [bitmap]);
    this.loadedImageUrl = url;
  }

  /**
   * Resolves once the output is verified stable (a few frames on a warmed-up matte), or after the
   * timeout — same contract as MediapipeBackgroundProcessor.waitUntilReady.
   */
  waitUntilReady(timeoutMs = 4000): Promise<void> {
    if (this.fallback) return this.fallback.waitUntilReady(timeoutMs);
    if (this.readyResolved) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolveReady();
        resolve();
      }, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private resolveReady() {
    if (this.readyResolved) return;
    this.readyResolved = true;
    this.readyWaiters.splice(0).forEach((resolve) => resolve());
  }

  // ------------------------------------------------------------ Measurements

  private onCompositorMessage(message: CompositorResponse) {
    switch (message.type) {
      case 'started':
        this.compositorStarted?.resolve();
        break;
      case 'ready':
        this.resolveReady();
        break;
      case 'stats':
        this.onStats(message.stats);
        break;
      case 'fatal':
        if (this.compositorStarted) this.compositorStarted.reject(new Error(message.message));
        else this.pipelineFailed(`compositor: ${message.message}`);
        break;
      case 'stopped':
        this.compositorStopped?.();
        break;
    }
  }

  private onStats(stats: CompositorStats) {
    addTotals(this.diag, stats);
    this.diag.seconds += stats.intervalMs / 1000;
    this.starvationFrames += stats.frames;
    this.history.push(stats);
    if (this.history.length > PERF_FAST_WINDOW_S) this.history.shift();
    if (this.readyResolved) this.checkFrameCost();
  }

  /** Both workers' time per frame over the last `seconds` reports, or null without enough data. */
  private windowCost(seconds: number, minFrames: number) {
    if (this.history.length < seconds) return null;
    const window = this.history.slice(-seconds);
    const frames = window.reduce((sum, s) => sum + s.frames, 0);
    if (frames < minFrames) return null;
    const ms = window.reduce((sum, s) => sum + s.compositeMsTotal + s.segmenterWorkMsTotal, 0);
    const elapsed = window.reduce((sum, s) => sum + s.intervalMs, 0) / 1000;
    return { avgMs: ms / frames, fps: frames / Math.max(0.001, elapsed) };
  }

  private checkFrameCost() {
    const slowCb = this.options.onSustainedSlowFrames;
    if (slowCb && !this.slowCallbackFired) {
      const sustained = this.windowCost(PERF_SLOW_WINDOW_S, 30);
      const spike = this.windowCost(PERF_SPIKE_WINDOW_S, 20);
      const trigger =
        sustained && sustained.avgMs > PERF_SLOW_AVG_MS
          ? ({ trigger: 'sustained', avgMs: sustained.avgMs } as const)
          : spike && spike.avgMs > PERF_SPIKE_AVG_MS
            ? ({ trigger: 'spike', avgMs: spike.avgMs } as const)
            : null;
      if (trigger) {
        this.slowCallbackFired = true;
        slowCb({ trigger: trigger.trigger, avgFrameMs: Math.round(trigger.avgMs * 10) / 10 });
      }
    }
    const fastCb = this.options.onSustainedFastFrames;
    if (fastCb && !this.fastCallbackFired) {
      const fast = this.windowCost(PERF_FAST_WINDOW_S, 60);
      if (fast && fast.avgMs < PERF_FAST_AVG_MS && fast.fps >= this.expectedFps() * PERF_FAST_MIN_FPS_RATIO) {
        this.fastCallbackFired = true;
        fastCb(fast.avgMs);
      }
    }
  }

  /** The camera's own frame rate — what "keeping up" means. */
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

  /** Same rule as MediapipeBackgroundProcessor.checkStarvation: under half the camera's rate for 5s. */
  private checkStarvation() {
    const now = performance.now();
    const track = this.sourceTrack;
    const inGrace = !this.readyResolved && now - this.starvationMonitorStart < STARVATION_GRACE_MS;
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
    if (elapsed < STARVATION_WINDOW_MS) return;
    const fps = this.starvationFrames / (elapsed / 1000);
    const expectedFps = this.expectedFps();
    this.starvationWindowStart = now;
    this.starvationFrames = 0;
    if (fps < expectedFps * STARVATION_MIN_FPS_RATIO) {
      this.slowCallbackFired = true;
      this.options.onSustainedSlowFrames?.({
        trigger: 'starved',
        fps: Math.round(fps * 10) / 10,
        expectedFps: Math.round(expectedFps),
      });
    }
  }

  /**
   * Costs since the previous call, then resets — what the diagnostics probe records (also read by
   * the blur lab). frameMsAvg is both workers' time per frame, comparable with the main-thread
   * processor's; the compositor reports once a second, so `seconds` is the span actually covered.
   */
  takePerfSnapshot(): Record<string, unknown> {
    if (this.fallback) return { ...this.fallback.takePerfSnapshot(), fallback: disabledReason };
    const d = this.diag;
    const avg = (total: number, count: number) => (count ? Math.round((total / count) * 100) / 100 : undefined);
    const data = {
      path: 'worker',
      quality: this.currentQuality,
      mode: this.options.mode,
      delegate: this.options.delegate,
      seconds: Math.round(d.seconds * 100) / 100,
      fps: d.seconds ? Math.round((d.frames / d.seconds) * 10) / 10 : undefined,
      frameMsAvg: avg(d.compositeMsTotal + d.segmenterWorkMsTotal, d.frames),
      frameMsMax: Math.round(d.compositeMsMax),
      compositeMsAvg: avg(d.compositeMsTotal, d.frames),
      segmentations: d.segmentations,
      segmentMsAvg: avg(d.segmentMsTotal, d.segmentations),
      segmentMsMax: Math.round(d.segmentMsMax),
      segmenterWorkMsAvg: avg(d.segmenterWorkMsTotal, d.segmentations),
      maskLatencyMsAvg: avg(d.maskLatencyMsTotal, d.segmentations),
      droppedFrames: d.droppedFrames || undefined,
    };
    this.diag = { ...emptyTotals(), seconds: 0 };
    return data;
  }
}

function emptyTotals(): Omit<CompositorStats, 'intervalMs'> {
  return {
    frames: 0,
    compositeMsTotal: 0,
    compositeMsMax: 0,
    segmentations: 0,
    segmentMsTotal: 0,
    segmentMsMax: 0,
    segmenterWorkMsTotal: 0,
    maskLatencyMsTotal: 0,
    droppedFrames: 0,
  };
}

function addTotals(into: Omit<CompositorStats, 'intervalMs'>, stats: CompositorStats) {
  into.frames += stats.frames;
  into.compositeMsTotal += stats.compositeMsTotal;
  into.compositeMsMax = Math.max(into.compositeMsMax, stats.compositeMsMax);
  into.segmentations += stats.segmentations;
  into.segmentMsTotal += stats.segmentMsTotal;
  into.segmentMsMax = Math.max(into.segmentMsMax, stats.segmentMsMax);
  into.segmenterWorkMsTotal += stats.segmenterWorkMsTotal;
  into.maskLatencyMsTotal += stats.maskLatencyMsTotal;
  into.droppedFrames += stats.droppedFrames;
}
