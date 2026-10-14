/**
 * Sample-accurate level meter: reduces every sample it's fed to per-block statistics (mean
 * square, mean |x|, peak) and posts them out in small batches. An AnalyserNode can only show
 * the most recent fftSize samples at whatever moment the page happens to read it, so polling
 * one either misses audio or double-counts it; this sees every sample exactly once, which is
 * what a level *measurement* (rather than a meter needle) needs. See levelMeter.ts for the
 * main-thread side and the statistics computed from these blocks.
 *
 * Multi-channel input (tab audio is stereo) is folded into one block series: power and |x| are
 * averaged across channels, peak is the max of any channel.
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

export interface LevelMeterOptions {
  /** Samples per block — 10ms at the context's rate. */
  blockSize: number;
  /** Blocks per posted batch. */
  blocksPerPost: number;
}

/** Worklet -> main, once per `blocksPerPost` blocks. Arrays are transferred, not copied. */
export interface LevelMeterBatch {
  type: 'blocks';
  /** Mean square per block. */
  power: Float32Array;
  /** Mean |x| per block (what ITU-T P.56's envelope is built from). */
  meanAbs: Float32Array;
  /** Max |x| per block. */
  peak: Float32Array;
  /** Samples at or above CLIP_LEVEL in this batch. */
  clipped: number;
}

/** Float samples reaching ±1 are the ones that hard-clip once the encoder converts to int16. */
const CLIP_LEVEL = 0.999;

class LevelMeterProcessor extends AudioWorkletProcessor {
  private readonly blockSize: number;
  private readonly blocksPerPost: number;
  private power: Float32Array;
  private meanAbs: Float32Array;
  private peak: Float32Array;
  private block = 0;
  private sumSquares = 0;
  private sumAbs = 0;
  private blockPeak = 0;
  private inBlock = 0;
  private clipped = 0;
  private stopped = false;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const { blockSize, blocksPerPost } = options?.processorOptions as LevelMeterOptions;
    this.blockSize = blockSize;
    this.blocksPerPost = blocksPerPost;
    this.power = new Float32Array(blocksPerPost);
    this.meanAbs = new Float32Array(blocksPerPost);
    this.peak = new Float32Array(blocksPerPost);
    this.port.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'stop') this.stopped = true;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channels = inputs[0];
    // Nothing connected (yet): stay alive rather than retiring this processor for good.
    if (!channels || channels.length === 0) return true;

    const channelCount = channels.length;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sq = 0;
      let abs = 0;
      for (let c = 0; c < channelCount; c++) {
        const x = channels[c][i];
        const a = x < 0 ? -x : x;
        sq += x * x;
        abs += a;
        if (a > this.blockPeak) this.blockPeak = a;
        if (a >= CLIP_LEVEL) this.clipped++;
      }
      this.sumSquares += sq / channelCount;
      this.sumAbs += abs / channelCount;
      if (++this.inBlock === this.blockSize) this.closeBlock();
    }
    return true;
  }

  private closeBlock() {
    this.power[this.block] = this.sumSquares / this.blockSize;
    this.meanAbs[this.block] = this.sumAbs / this.blockSize;
    this.peak[this.block] = this.blockPeak;
    this.sumSquares = 0;
    this.sumAbs = 0;
    this.blockPeak = 0;
    this.inBlock = 0;
    if (++this.block < this.blocksPerPost) return;

    const batch: LevelMeterBatch = {
      type: 'blocks',
      power: this.power,
      meanAbs: this.meanAbs,
      peak: this.peak,
      clipped: this.clipped,
    };
    this.port.postMessage(batch, [this.power.buffer, this.meanAbs.buffer, this.peak.buffer]);
    this.power = new Float32Array(this.blocksPerPost);
    this.meanAbs = new Float32Array(this.blocksPerPost);
    this.peak = new Float32Array(this.blocksPerPost);
    this.block = 0;
    this.clipped = 0;
  }
}

registerProcessor('level-meter', LevelMeterProcessor);
