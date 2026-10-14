import type { LevelMeterBatch, LevelMeterOptions } from './levelMeter.worklet';
import { LEVEL_BLOCK_MS, summarizeLevels, type LevelSummary } from './levelStats';
import levelMeterWorkletUrl from './levelMeter.worklet.ts?worker&url';

/** Loads the level-meter processor into `ctx`. Call once per context before creating stages. */
export function loadLevelMeter(ctx: BaseAudioContext): Promise<void> {
  return ctx.audioWorklet.addModule(levelMeterWorkletUrl);
}

const BLOCKS_PER_POST = 10;
/** How far back the live peak readout looks. */
const PEAK_HOLD_BATCHES = 10;

/**
 * One measured point in an audio graph: a MediaStream fed into a level-meter worklet. Keeps a
 * live readout (last 100ms RMS, last ~1s peak) for display, and, between startTake() and
 * endTake(), every block for a full LevelSummary.
 */
export class MeteredStage {
  /** Exposed so callers can also route this stage elsewhere (e.g. to headphones). */
  readonly source: MediaStreamAudioSourceNode;
  /** The measured stream itself, e.g. for recording it alongside a take. */
  readonly stream: MediaStream;
  private readonly meter: AudioWorkletNode;
  private readonly sink: GainNode;
  private lastPower = 0;
  private readonly recentPeaks: number[] = [];
  private take: { power: number[]; meanAbs: number[]; peak: number[]; clipped: number } | null = null;

  constructor(ctx: AudioContext, stream: MediaStream) {
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);
    const options: LevelMeterOptions = {
      blockSize: Math.round((ctx.sampleRate * LEVEL_BLOCK_MS) / 1000),
      blocksPerPost: BLOCKS_PER_POST,
    };
    this.meter = new AudioWorkletNode(ctx, 'level-meter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: options,
    });
    this.meter.port.onmessage = (event: MessageEvent<LevelMeterBatch>) => this.onBatch(event.data);
    // Only pulled once it reaches the destination; it writes nothing, so this stays silent.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.meter);
    this.meter.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  private onBatch(batch: LevelMeterBatch) {
    let power = 0;
    let peak = 0;
    for (let i = 0; i < batch.power.length; i++) {
      power += batch.power[i];
      if (batch.peak[i] > peak) peak = batch.peak[i];
    }
    this.lastPower = power / batch.power.length;
    this.recentPeaks.push(peak);
    if (this.recentPeaks.length > PEAK_HOLD_BATCHES) this.recentPeaks.shift();

    if (!this.take) return;
    for (let i = 0; i < batch.power.length; i++) {
      this.take.power.push(batch.power[i]);
      this.take.meanAbs.push(batch.meanAbs[i]);
      this.take.peak.push(batch.peak[i]);
    }
    this.take.clipped += batch.clipped;
  }

  /** Mean square of the last batch (~100ms) and the highest sample of the last ~1s. */
  get live(): { power: number; peak: number } {
    return { power: this.lastPower, peak: Math.max(0, ...this.recentPeaks) };
  }

  startTake() {
    this.take = { power: [], meanAbs: [], peak: [], clipped: 0 };
  }

  /** Ends the take and summarizes it; null if no take was running. */
  endTake(): LevelSummary | null {
    const take = this.take;
    this.take = null;
    return take ? summarizeLevels(take) : null;
  }

  dispose() {
    this.take = null;
    this.meter.port.postMessage({ type: 'stop' });
    this.source.disconnect();
    this.meter.disconnect();
    this.sink.disconnect();
  }
}
