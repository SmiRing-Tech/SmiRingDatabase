/**
 * Playback stage of the GTCRN noise-cancel pipeline.
 *
 * This used to be a ScriptProcessorNode, whose onaudioprocess callback runs on the main thread —
 * and that is what made operating the UI audible to everyone else on the call. When the main
 * thread stalls (the user switches tab or app and the OS deprioritises the renderer), the
 * callback doesn't fire at all, so it never even reaches its own "pad with silence" branch and
 * `underrunCount` stays flat. The audio render thread keeps pulling a buffer every quantum
 * regardless and replays whatever the node last held, so listeners hear the same chunk over and
 * over — the reported "が、が、が、が" stutter, which is a repeat artifact, not a dropout.
 *
 * process() runs on the render thread, so it keeps being called on time no matter what the main
 * thread is doing. A stall now only starves the queue: PRIME_MS of pre-buffered audio absorbs
 * short ones completely, and anything longer degrades to silence instead of to a repeat.
 *
 * Deliberately dependency-free. onnxruntime-web can't run in an AudioWorkletGlobalScope (see
 * GtcrnNoiseCancelTrack's header), but that only ever ruled out doing *inference* here — moving
 * the output stage over needs nothing but a ring buffer.
 */

interface AudioWorkletProcessorLike {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessorLike;
  new (options?: { processorOptions?: unknown }): AudioWorkletProcessorLike;
};
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessorLike,
): void;
declare const sampleRate: number;

export interface GtcrnPlaybackOptions {
  /** Audio held back before playback starts, and rebuilt after every underrun. This is the
   * cushion that decides how long a main-thread stall can last while staying inaudible — and
   * it is added directly to mouth-to-ear latency, so it's a straight trade. */
  primeMs: number;
  /** Ceiling on queued audio. Without it, a producer that ever runs ahead leaves the extra
   * delay in place for the rest of the call. */
  maxMs: number;
}

/** Worklet -> main. Counters are cumulative; `queuedMs` is a live gauge. */
export interface GtcrnPlaybackStats {
  type: 'stats';
  underrunCount: number;
  droppedSamples: number;
  queuedMs: number;
  priming: boolean;
}

const STATS_INTERVAL_MS = 3000;

class GtcrnPlaybackProcessor extends AudioWorkletProcessor {
  private readonly ring: Float32Array;
  private readonly capacity: number;
  private readonly primeSamples: number;
  private readonly maxSamples: number;

  private readIndex = 0;
  private available = 0;
  private priming = true;
  private stopped = false;

  private underrunCount = 0;
  private droppedSamples = 0;
  private samplesSinceStats = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const { primeMs, maxMs } = options?.processorOptions as GtcrnPlaybackOptions;
    this.primeSamples = Math.round((primeMs / 1000) * sampleRate);
    this.maxSamples = Math.round((maxMs / 1000) * sampleRate);
    this.capacity = this.maxSamples + this.primeSamples + sampleRate;
    this.ring = new Float32Array(this.capacity);

    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type: string; samples?: Float32Array };
      if (msg.type === 'samples' && msg.samples) this.write(msg.samples);
      else if (msg.type === 'stop') this.stopped = true;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    if (!out) return !this.stopped;

    if (this.priming && this.available >= this.primeSamples) this.priming = false;

    if (this.priming) {
      out.fill(0);
    } else {
      const take = Math.min(out.length, this.available);
      this.read(out, take);
      if (take < out.length) {
        out.fill(0, take);
        this.underrunCount++;
        // Refill the cushion rather than limping along from empty: the input for the window
        // that starved us is gone either way, so the extra silence costs nothing that wasn't
        // already lost, and it restores the margin that absorbs the next stall. Without this,
        // one long stall would leave the pipeline permanently running at zero margin.
        this.priming = true;
      }
    }

    this.samplesSinceStats += out.length;
    if (this.samplesSinceStats >= (STATS_INTERVAL_MS / 1000) * sampleRate) {
      this.samplesSinceStats = 0;
      const stats: GtcrnPlaybackStats = {
        type: 'stats',
        underrunCount: this.underrunCount,
        droppedSamples: this.droppedSamples,
        queuedMs: (this.available / sampleRate) * 1000,
        priming: this.priming,
      };
      this.port.postMessage(stats);
    }

    return !this.stopped;
  }

  private read(out: Float32Array, count: number): void {
    const firstRun = Math.min(count, this.capacity - this.readIndex);
    out.set(this.ring.subarray(this.readIndex, this.readIndex + firstRun), 0);
    if (firstRun < count) out.set(this.ring.subarray(0, count - firstRun), firstRun);
    this.readIndex = (this.readIndex + count) % this.capacity;
    this.available -= count;
  }

  private write(samples: Float32Array): void {
    let data = samples;
    if (data.length > this.maxSamples) {
      this.droppedSamples += data.length - this.maxSamples;
      data = data.subarray(data.length - this.maxSamples);
    }

    const overflow = this.available + data.length - this.maxSamples;
    if (overflow > 0) {
      this.readIndex = (this.readIndex + overflow) % this.capacity;
      this.available -= overflow;
      this.droppedSamples += overflow;
    }

    const writeIndex = (this.readIndex + this.available) % this.capacity;
    const firstRun = Math.min(data.length, this.capacity - writeIndex);
    this.ring.set(data.subarray(0, firstRun), writeIndex);
    if (firstRun < data.length) this.ring.set(data.subarray(firstRun), 0);
    this.available += data.length;
  }
}

registerProcessor('gtcrn-playback', GtcrnPlaybackProcessor);
