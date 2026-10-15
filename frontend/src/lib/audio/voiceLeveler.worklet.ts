/**
 * Slow voice leveler: brings speech towards a target level by adjusting a gain over seconds,
 * not syllables — the "someone is far from their mic / has a quiet mic" fix, as opposed to the
 * compressor after it (VoiceFinishChain), which evens out loud and quiet syllables.
 *
 * Runs entirely on the audio thread, with no lookahead: each 10ms block's gain is decided from
 * blocks already seen and applied as a per-sample ramp across the next one, so it adds no
 * latency and never steps (no clicks).
 *
 *  - Speech detection: a block counts as speech if it is well above a tracked noise floor (and
 *    above an absolute minimum). Only speech blocks move the level estimate or the gain; in
 *    pauses everything holds, so room noise is never gradually pulled up between words.
 *  - Level estimate: speech-block power, smoothed over ~0.4s.
 *  - Gain moves towards (target - level) at a capped rate — slowly up, faster down — clamped to
 *    [minGainDb, maxGainDb].
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

export interface VoiceLevelerSettings {
  enabled: boolean;
  /** Speech level the gain aims for, dBFS (mean power of speech). */
  targetDb: number;
  maxGainDb: number;
  minGainDb: number;
}

/** main -> worklet. */
export interface VoiceLevelerSettingsMessage {
  type: 'settings';
  settings: VoiceLevelerSettings;
}

/** worklet -> main, every STATE_EVERY_BLOCKS. */
export interface VoiceLevelerState {
  type: 'state';
  gainDb: number;
  /** Current speech-level estimate before the gain, dBFS; null until speech has been heard. */
  speechDb: number | null;
  speaking: boolean;
  /** Tracked noise floor of the input, dBFS — what pauses sound like before the gain. */
  floorDb: number;
}

const BLOCK_MS = 10;
const STATE_EVERY_BLOCKS = 10;
/** Speech must be this far above the noise floor... */
const SPEECH_ABOVE_FLOOR_DB = 10;
/** ...and at least this loud at all, so a near-silent room never reads as speech. */
const SPEECH_MIN_DB = -60;
/** How fast the noise-floor estimate may creep up while sound continues (it drops instantly). */
const FLOOR_RISE_DB_PER_SEC = 1;
const LEVEL_TIME_CONSTANT_MS = 400;
const GAIN_UP_DB_PER_SEC = 6;
const GAIN_DOWN_DB_PER_SEC = 20;

const toDb = (power: number) => 10 * Math.log10(power + 1e-12);

class VoiceLevelerProcessor extends AudioWorkletProcessor {
  private settings: VoiceLevelerSettings = { enabled: false, targetDb: -24, maxGainDb: 12, minGainDb: -6 };
  private readonly blockSize = Math.round((sampleRate * BLOCK_MS) / 1000);
  private readonly levelAlpha = 1 - Math.exp(-BLOCK_MS / LEVEL_TIME_CONSTANT_MS);
  private sumSquares = 0;
  private inBlock = 0;
  private blocksSinceState = 0;
  private floorDb = SPEECH_MIN_DB;
  private levelPower: number | null = null;
  private speaking = false;
  /** Gain as a dB value (the decision) and its linear per-sample ramp (what's applied). */
  private gainDb = 0;
  private gain = 1;
  private gainStep = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.port.onmessage = (event: MessageEvent<VoiceLevelerSettingsMessage>) => {
      if (event.data?.type === 'settings') this.settings = event.data.settings;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    if (!input) {
      output.fill(0);
      return true;
    }
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      output[i] = x * this.gain;
      this.gain += this.gainStep;
      this.sumSquares += x * x;
      if (++this.inBlock === this.blockSize) this.closeBlock();
    }
    return true;
  }

  private closeBlock() {
    const power = this.sumSquares / this.blockSize;
    this.sumSquares = 0;
    this.inBlock = 0;
    const db = toDb(power);

    if (db < this.floorDb) this.floorDb = db;
    else this.floorDb += (FLOOR_RISE_DB_PER_SEC * BLOCK_MS) / 1000;
    this.speaking = db > Math.max(this.floorDb + SPEECH_ABOVE_FLOOR_DB, SPEECH_MIN_DB);

    const { enabled, targetDb, maxGainDb, minGainDb } = this.settings;
    // Pauses hold the gain where it is; only speech moves it.
    let desiredDb = this.gainDb;
    if (this.speaking) {
      this.levelPower = this.levelPower === null ? power : this.levelPower + this.levelAlpha * (power - this.levelPower);
      desiredDb = Math.min(maxGainDb, Math.max(minGainDb, targetDb - toDb(this.levelPower)));
    }
    if (!enabled) {
      // Back to unity over one block.
      this.gainDb = 0;
    } else {
      const up = (GAIN_UP_DB_PER_SEC * BLOCK_MS) / 1000;
      const down = (GAIN_DOWN_DB_PER_SEC * BLOCK_MS) / 1000;
      this.gainDb += Math.min(up, Math.max(-down, desiredDb - this.gainDb));
    }

    const nextGain = 10 ** (this.gainDb / 20);
    this.gainStep = (nextGain - this.gain) / this.blockSize;

    if (++this.blocksSinceState >= STATE_EVERY_BLOCKS) {
      this.blocksSinceState = 0;
      const state: VoiceLevelerState = {
        type: 'state',
        gainDb: this.gainDb,
        speechDb: this.levelPower === null ? null : toDb(this.levelPower),
        speaking: this.speaking,
        floorDb: this.floorDb,
      };
      this.port.postMessage(state);
    }
  }
}

registerProcessor('voice-leveler', VoiceLevelerProcessor);
