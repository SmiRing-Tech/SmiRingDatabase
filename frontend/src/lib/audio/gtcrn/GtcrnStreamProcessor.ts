import FFT from 'fft.js';
import { sqrtHann } from './window';

// Matches vendor/gtcrn/stream/gtcrn_stream.py exactly: 16kHz, 512-point STFT, 256 hop
// (= 50% overlap), sqrt-Hann analysis/synthesis window. GTCRN itself is single-frame-at-a-time
// (T=1 per call) with all recurrent state as explicit tensors, so real-time streaming is just
// "run one 16ms hop through the model and overlap-add the result" — no batching trick needed.
export const GTCRN_SAMPLE_RATE = 16000;
const N_FFT = 512;
const HOP = 256;
const FREQ_BINS = N_FFT / 2 + 1; // 257, onesided — matches torch.stft's default onesided=True

const CONV_CACHE_SIZE = 2 * 1 * 16 * 16 * 33;
const TRA_CACHE_SIZE = 2 * 3 * 1 * 1 * 16;
const INTER_CACHE_SIZE = 2 * 1 * 33 * 16;

/**
 * Minimal shape both `onnxruntime-web` (browser) and `onnxruntime-node` (used only by the
 * Node-side numerical validation script, never shipped) satisfy without this file importing
 * either package directly — keeps the DSP/model-plumbing logic here testable outside a browser.
 */
export interface OrtTensorLike {
  data: Float32Array;
  dims: readonly number[];
}
export interface OrtSessionLike {
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
}
export type MakeTensor = (data: Float32Array, dims: readonly number[]) => OrtTensorLike;

export class GtcrnStreamProcessor {
  private readonly fft = new FFT(N_FFT);
  private readonly window = sqrtHann(N_FFT);

  // Sliding analysis window over the most recent N_FFT samples — shifted left by HOP and
  // refilled at the tail on every hop, so frame t is always inputRing after t*HOP samples.
  private readonly inputRing = new Float32Array(N_FFT);
  // Overlap-add accumulator: same trick in reverse. Every hop adds a new synthesis frame in,
  // the first HOP samples (which no later frame can ever touch again — window support is only
  // N_FFT wide) are emitted, then the buffer shifts left by HOP to make room for the next frame.
  private readonly overlapBuffer = new Float32Array(N_FFT);

  private convCache = new Float32Array(CONV_CACHE_SIZE);
  private traCache = new Float32Array(TRA_CACHE_SIZE);
  private interCache = new Float32Array(INTER_CACHE_SIZE);

  // Samples handed to push() that haven't yet accumulated into a full HOP.
  private carry = new Float32Array(0);

  private readonly session: OrtSessionLike;
  private readonly makeTensor: MakeTensor;

  // Plain fields + assignment, not TS constructor-parameter shorthand: this file is exercised
  // directly by Node's native (strip-only) TS loader in scripts/validate-gtcrn-node.ts, which
  // doesn't support that shorthand.
  constructor(session: OrtSessionLike, makeTensor: MakeTensor) {
    this.session = session;
    this.makeTensor = makeTensor;
  }

  /**
   * Feed any number of new 16kHz samples. Returns as many enhanced samples as are now ready —
   * always a multiple of HOP (128 = 8ms hops... no, HOP=256 = 16ms), possibly zero if fewer
   * than one hop's worth has accumulated since the last call.
   */
  async push(samples: Float32Array): Promise<Float32Array> {
    const combined = new Float32Array(this.carry.length + samples.length);
    combined.set(this.carry, 0);
    combined.set(samples, this.carry.length);

    const hopsReady = Math.floor(combined.length / HOP);
    const consumed = hopsReady * HOP;
    this.carry = combined.slice(consumed);

    const out = new Float32Array(hopsReady * HOP);
    for (let h = 0; h < hopsReady; h++) {
      const hop = combined.subarray(h * HOP, (h + 1) * HOP);
      const outHop = await this.processOneHop(hop);
      out.set(outHop, h * HOP);
    }
    return out;
  }

  private async processOneHop(newHop: Float32Array): Promise<Float32Array> {
    this.inputRing.copyWithin(0, HOP);
    this.inputRing.set(newHop, N_FFT - HOP);

    const windowed = new Float32Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) windowed[i] = this.inputRing[i] * this.window[i];

    const spec = this.fft.createComplexArray();
    this.fft.realTransform(spec, Array.from(windowed));
    // spec[0 .. 2*FREQ_BINS-1] now holds bins 0..256 as interleaved [re,im] — exactly the
    // (F, 2) layout GTCRN's `mix` input expects for a single T=1 frame.
    const mixData = new Float32Array(FREQ_BINS * 2);
    for (let i = 0; i < mixData.length; i++) mixData[i] = spec[i];

    const feeds: Record<string, OrtTensorLike> = {
      mix: this.makeTensor(mixData, [1, FREQ_BINS, 1, 2]),
      conv_cache: this.makeTensor(this.convCache, [2, 1, 16, 16, 33]),
      tra_cache: this.makeTensor(this.traCache, [2, 3, 1, 1, 16]),
      inter_cache: this.makeTensor(this.interCache, [2, 1, 33, 16]),
    };
    const results = await this.session.run(feeds);
    this.convCache = new Float32Array(results.conv_cache_out.data);
    this.traCache = new Float32Array(results.tra_cache_out.data);
    this.interCache = new Float32Array(results.inter_cache_out.data);

    const enh = results.enh.data; // (1, FREQ_BINS, 1, 2) flat == interleaved [re,im] per bin

    const fullSpec = this.fft.createComplexArray();
    for (let k = 0; k < FREQ_BINS; k++) {
      fullSpec[2 * k] = enh[2 * k];
      fullSpec[2 * k + 1] = enh[2 * k + 1];
    }
    this.fft.completeSpectrum(fullSpec);

    const timeComplex = this.fft.createComplexArray();
    this.fft.inverseTransform(timeComplex, fullSpec);

    // Synthesis window, then overlap-add. sqrt-Hann analysis+synthesis at exactly 50% hop is
    // COLA with a constant sum of 1 in steady state (two windows overlapping at any interior
    // point always sum to 1 — see window.ts), so no extra normalization divisor is needed here.
    for (let i = 0; i < N_FFT; i++) {
      this.overlapBuffer[i] += timeComplex[2 * i] * this.window[i];
    }

    const outHop = this.overlapBuffer.slice(0, HOP);
    this.overlapBuffer.copyWithin(0, HOP);
    this.overlapBuffer.fill(0, N_FFT - HOP);
    return outHop;
  }
}
