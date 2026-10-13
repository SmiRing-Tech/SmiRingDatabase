/**
 * SPIKE (blur lab only): main-thread handle for backgroundSpike.worker.ts — the same calls the
 * lab makes on MediapipeBackgroundProcessor (init / waitUntilReady / takePerfSnapshot / destroy /
 * processedTrack / loadTimings), so the lab can run either path through one code path. All the
 * per-frame work happens in workers; this side only wires the streams and relays messages.
 *
 * With `split`, segmentation runs in a second worker (backgroundSegmenterSpike.worker.ts), and
 * setQuality() swaps models the way the app would want to: build and warm the new segmenter
 * next to the running one, then point the compositor at it — the output never pauses.
 */
import {
  loadSegmentationModel,
  MEDIAPIPE_WASM_BASE,
  MODEL_INVERT,
  type SegmentationQuality,
} from './MediapipeBackgroundProcessor';
import type { SpikeLoadTimings, SpikeOptions, SpikeRequest, SpikeResponse } from './backgroundSpike.worker';
import type { SegmenterRequest, SegmenterResponse } from './backgroundSegmenterSpike.worker';

export interface WorkerSpikeOptions {
  quality: SegmentationQuality;
  /** For models the app doesn't ship (the lab's square model); the worker fetches it itself. */
  modelUrl?: string;
  /** Segmentation in its own worker (swappable without pausing) instead of inside the compositor. */
  split?: boolean;
  segmentationFps: number;
  segmentationScheduler: 'interval' | 'exact';
  measureGpuSync: boolean;
  delegate: 'GPU' | 'CPU';
  blurRadius: number;
  temporalSmoothing: number;
  edgeFeather: number;
}

export function supportsWorkerBackgroundSpike(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    typeof MediaStreamTrackGenerator !== 'undefined'
  );
}

/** Height of the mask the segmenter hands over, per model — about the model's own resolution. */
const SEGMENTER_MASK_HEIGHT: Record<SegmentationQuality, number> = { balanced: 144, high: 256 };

type SegmenterHandle = { worker: Worker; quality: SegmentationQuality };

export class WorkerBackgroundSpike {
  processedTrack?: MediaStreamTrack;
  readonly loadTimings: SpikeLoadTimings = {};
  private worker?: Worker;
  private segmenter?: SegmenterHandle;
  private aspect = 16 / 9;
  private readyWaiters: Array<() => void> = [];
  private ready = false;
  private snapshotId = 0;
  private snapshotWaiters = new Map<number, (data: Record<string, unknown>) => void>();
  private loadedWaiter?: { resolve: () => void; reject: (err: Error) => void };
  private stoppedWaiter?: () => void;
  private readonly options: WorkerSpikeOptions;

  constructor(options: WorkerSpikeOptions) {
    this.options = options;
  }

  get quality(): SegmentationQuality {
    return this.segmenter?.quality ?? this.options.quality;
  }

  /** Copies the page-wide download (it stays cached for the main-thread path) or falls back to the URL. */
  private async modelFor(quality: SegmentationQuality) {
    if (this.options.modelUrl) return { model: { url: this.options.modelUrl }, transfer: [] as Transferable[] };
    const buffer = (await loadSegmentationModel(quality)).slice().buffer;
    return { model: { buffer }, transfer: [buffer] as Transferable[] };
  }

  /** Resolves once a segmenter is loaded (in split mode: loaded *and* warmed) — like the main-thread init(). */
  async init({ track }: { track: MediaStreamTrack }) {
    const worker = new Worker(new URL('./backgroundSpike.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<SpikeResponse>) => this.onMessage(event.data);
    worker.onerror = (event) => this.loadedWaiter?.reject(new Error(`worker error: ${event.message}`));

    const processor = new MediaStreamTrackProcessor({ track: track as MediaStreamVideoTrack });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.processedTrack = generator as unknown as MediaStreamTrack;

    const settings = track.getSettings();
    const width = settings.width ?? 640;
    const height = settings.height ?? 360;
    this.aspect = width / height;
    const workerOptions: SpikeOptions = {
      segmentationFps: this.options.segmentationFps,
      segmentationScheduler: this.options.segmentationScheduler,
      measureGpuSync: this.options.measureGpuSync,
      delegate: this.options.delegate,
      blurRadius: this.options.blurRadius,
      temporalSmoothing: this.options.temporalSmoothing,
      edgeFeather: this.options.edgeFeather,
      matteLo: 0.3,
      matteHi: 0.75,
      invert: MODEL_INVERT[this.options.quality],
    };
    const inline = this.options.split ? undefined : await this.modelFor(this.options.quality);
    const request: SpikeRequest = {
      type: 'init',
      readable: processor.readable,
      writable: generator.writable,
      width,
      height,
      segmentation: this.options.split ? 'external' : 'inline',
      wasmBase: MEDIAPIPE_WASM_BASE,
      model: inline?.model,
      options: workerOptions,
    };
    const loaded = new Promise<void>((resolve, reject) => (this.loadedWaiter = { resolve, reject }));
    worker.postMessage(request, [processor.readable, generator.writable, ...(inline?.transfer ?? [])]);
    await loaded;
    if (this.options.split) await this.setQuality(this.options.quality, true);
  }

  /**
   * Split mode only: builds a segmenter worker for `quality`, waits until it is loaded *and*
   * warmed up, then hands it to the compositor and retires the old one. Resolves at the
   * hand-over; the video keeps flowing (with the old model's matte) the whole time.
   */
  async setQuality(quality: SegmentationQuality, initial = false) {
    if (!this.options.split || !this.worker) throw new Error('setQuality needs split mode');
    const worker = new Worker(new URL('./backgroundSegmenterSpike.worker.ts', import.meta.url), { type: 'module' });
    const channel = new MessageChannel();
    const { model, transfer } = await this.modelFor(quality);
    const ready = new Promise<Extract<SegmenterResponse, { type: 'ready' }>['loadTimings']>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<SegmenterResponse>) => {
        if (event.data.type === 'ready') resolve(event.data.loadTimings);
        else if (event.data.type === 'error') reject(new Error(event.data.message));
      };
      worker.onerror = (event) => reject(new Error(`segmenter worker error: ${event.message}`));
    });
    const request: SegmenterRequest = {
      type: 'init',
      port: channel.port2,
      wasmBase: MEDIAPIPE_WASM_BASE,
      model,
      delegate: this.options.delegate,
      invert: MODEL_INVERT[quality],
      maskHeight: SEGMENTER_MASK_HEIGHT[quality],
      aspect: this.aspect,
    };
    worker.postMessage(request, [channel.port2, ...transfer]);
    let timings;
    try {
      timings = await ready;
    } catch (err) {
      worker.terminate();
      throw err;
    }
    if (!this.worker) {
      worker.terminate();
      return;
    }
    this.worker.postMessage({ type: 'attachSegmenter', port: channel.port1 } satisfies SpikeRequest, [channel.port1]);
    const previous = this.segmenter;
    this.segmenter = { worker, quality };
    if (initial) Object.assign(this.loadTimings, timings, { modelFetchMs: 0 });
    if (previous) await this.retireSegmenter(previous);
  }

  private async retireSegmenter({ worker }: SegmenterHandle) {
    await new Promise<void>((resolve) => {
      worker.onmessage = (event: MessageEvent<SegmenterResponse>) => event.data.type === 'stopped' && resolve();
      setTimeout(resolve, 2000);
      worker.postMessage({ type: 'stop' } satisfies SegmenterRequest);
    });
    worker.terminate();
  }

  private onMessage(message: SpikeResponse) {
    switch (message.type) {
      case 'loaded':
        Object.assign(this.loadTimings, message.loadTimings, { firstSegmentationMs: undefined });
        this.loadedWaiter?.resolve();
        break;
      case 'firstSegmentation':
        this.loadTimings.firstSegmentationMs = message.ms;
        break;
      case 'ready':
        this.ready = true;
        this.readyWaiters.splice(0).forEach((resolve) => resolve());
        break;
      case 'snapshot':
        this.snapshotWaiters.get(message.id)?.(message.data);
        this.snapshotWaiters.delete(message.id);
        break;
      case 'error':
        console.error('[bg-spike]', message.message);
        this.loadedWaiter?.reject(new Error(message.message));
        break;
      case 'stopped':
        this.stoppedWaiter?.();
        break;
    }
  }

  waitUntilReady(timeoutMs = 4000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Async (a round trip to the worker), unlike the main-thread processor's. */
  takePerfSnapshot(): Promise<Record<string, unknown>> {
    const worker = this.worker;
    if (!worker) return Promise.resolve({});
    const id = ++this.snapshotId;
    return new Promise((resolve) => {
      this.snapshotWaiters.set(id, resolve);
      worker.postMessage({ type: 'snapshot', id } satisfies SpikeRequest);
    });
  }

  async destroy() {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    const segmenter = this.segmenter;
    this.segmenter = undefined;
    const stopped = new Promise<void>((resolve) => {
      this.stoppedWaiter = resolve;
      setTimeout(resolve, 2000);
    });
    worker.postMessage({ type: 'stop' } satisfies SpikeRequest);
    await stopped;
    worker.terminate();
    if (segmenter) await this.retireSegmenter(segmenter);
    this.processedTrack?.stop();
  }
}
