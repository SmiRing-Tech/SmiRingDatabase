import FFT from 'fft.js';
import { sqrtHann } from './window';

// Matches vendor/gtcrn/stream/gtcrn_stream.py exactly: 16kHz, 512-point STFT, 256 hop
// (= 50% overlap), sqrt-Hann analysis/synthesis window. All of GTCRN's recurrent state is
// explicit tensors, so real-time streaming is "run 16ms hops through the model and
// overlap-add the result".
export const GTCRN_SAMPLE_RATE = 16000;
const N_FFT = 512;
const HOP = 256;
const FREQ_BINS = N_FFT / 2 + 1; // 257, onesided — matches torch.stft's default onesided=True

/**
 * Frames per batch. The browser hands the worker 1024 samples (= 4 hops) at a time anyway, so
 * batching 4 frames into one session.run() adds no latency — and it's what makes this fast:
 * measured in single-threaded WASM, each run costs ~0.35ms of fixed overhead plus only ~0.09ms
 * per frame of actual model work, so one T=4 run (~0.7ms) replaces four T=1 runs (~1.75ms).
 * The T=4/T=2 models are re-exports of the same weights (see noise-cancel-research/
 * experiment_speedup.py) and produce the same output as T=1 to within float rounding.
 */
export const GTCRN_FRAMES_PER_BATCH = 4;

/**
 * How many frames of each batch actually go through the model, for machines that can't keep up
 * even batched (see gtcrnInference.worker.ts, which picks the level). Frames in between reuse
 * the most recent inferred frame's complex mask. Listening-tested acceptable at every level,
 * and all clearly better than no noise cancellation:
 *  - 0: all 4 frames (one T=4 run)
 *  - 1: frames 0 and 2 (one T=2 run, ~25% cheaper)
 *  - 2: frame 0 only (one T=1 run, ~40% cheaper)
 */
export type GtcrnSkipLevel = 0 | 1 | 2;
export const GTCRN_MAX_SKIP_LEVEL: GtcrnSkipLevel = 2;
const INFERRED_FRAMES: Record<GtcrnSkipLevel, readonly number[]> = {
  0: [0, 1, 2, 3],
  1: [0, 2],
  2: [0],
};

/** A reused mask is a gain; capping its magnitude stops a near-silent bin in the frame it was
 *  computed from from blowing up the frame it's reused on. */
const MAX_REUSED_MASK_GAIN = 2;

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

/** One session per frames-per-run count. Any subset works, and it may be filled in later — the
 *  processor reads it on every batch, so a model loaded after construction is picked up as soon
 *  as it exists (the worker loads T=4 up front and T=2/T=1 lazily). A batch that needs a T with
 *  no session falls back to one T=1 run per frame if T=1 is there; see supportedSkipLevel for
 *  keeping callers inside what's loaded. */
export type GtcrnSessions = Partial<Record<1 | 2 | 4, OrtSessionLike>>;

/** The session each skip level needs for its single run per batch. */
export const SESSION_FOR_LEVEL: Record<GtcrnSkipLevel, 1 | 2 | 4> = { 0: 4, 1: 2, 2: 1 };

/**
 * The lightest level at or below `requested` whose session is loaded — so a level is only ever
 * used once its model exists. Falls back to 0 (all frames) when nothing lighter is available;
 * level 0 itself works with either T=4 or, more slowly, T=1.
 */
export function supportedSkipLevel(sessions: GtcrnSessions, requested: GtcrnSkipLevel): GtcrnSkipLevel {
  for (let level = requested; level > 0; level--) {
    if (sessions[SESSION_FOR_LEVEL[level as GtcrnSkipLevel]]) return level as GtcrnSkipLevel;
  }
  return 0;
}

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
  // Analysis spectra (interleaved [re,im] per bin) waiting for a full batch.
  private pendingFrames: Float32Array[] = [];
  // Mask from the most recent inferred frame, reused on skipped frames.
  private readonly lastMask = new Float32Array(FREQ_BINS * 2);
  private hasMask = false;

  // Scratch buffers, allocated once and overwritten in full on every use rather than
  // reallocated per hop (fft.js's createComplexArray() returns a plain boxed-number Array, so
  // making these fresh per hop was pure GC churn).
  private readonly windowedBuf = new Float32Array(N_FFT);
  private readonly specBuf = this.fft.createComplexArray();
  private readonly fullSpecBuf = this.fft.createComplexArray();
  private readonly timeComplexBuf = this.fft.createComplexArray();

  private readonly sessions: GtcrnSessions;
  private readonly makeTensor: MakeTensor;

  // Plain fields + assignment, not TS constructor-parameter shorthand: this file is exercised
  // directly by Node's native (strip-only) TS loader in scripts/validate-gtcrn-node.ts, which
  // doesn't support that shorthand.
  /** @param sessions A T=1 session alone works (one run per frame); add T=2/T=4 for speed. Kept
   *  by reference, not copied, so sessions added to the object later are used too. */
  constructor(sessions: GtcrnSessions | OrtSessionLike, makeTensor: MakeTensor) {
    this.sessions = 'run' in sessions ? { 1: sessions } : sessions;
    this.makeTensor = makeTensor;
  }

  /**
   * Feed any number of new 16kHz samples. Returns as many enhanced samples as are now ready:
   * whole batches of GTCRN_FRAMES_PER_BATCH hops (1024 samples), possibly zero. Fed 1024 at a
   * time — what the capture worklet sends — every call returns exactly 1024.
   */
  async push(samples: Float32Array, level: GtcrnSkipLevel = 0): Promise<Float32Array> {
    const combined = new Float32Array(this.carry.length + samples.length);
    combined.set(this.carry, 0);
    combined.set(samples, this.carry.length);
    const hopsReady = Math.floor(combined.length / HOP);
    this.carry = combined.slice(hopsReady * HOP);
    for (let h = 0; h < hopsReady; h++) {
      this.pendingFrames.push(this.analyze(combined.subarray(h * HOP, (h + 1) * HOP)));
    }

    const batches = Math.floor(this.pendingFrames.length / GTCRN_FRAMES_PER_BATCH);
    const out = new Float32Array(batches * GTCRN_FRAMES_PER_BATCH * HOP);
    for (let b = 0; b < batches; b++) {
      const frames = this.pendingFrames.splice(0, GTCRN_FRAMES_PER_BATCH);
      const enhanced = await this.enhanceBatch(frames, level);
      for (let f = 0; f < enhanced.length; f++) {
        out.set(this.synthesize(enhanced[f]), (b * GTCRN_FRAMES_PER_BATCH + f) * HOP);
      }
    }
    return out;
  }

  /** Forget all streaming state (model caches, STFT/OLA buffers, pending audio, reused mask) —
   *  for picking up again after audio was deliberately skipped. */
  reset() {
    this.inputRing.fill(0);
    this.overlapBuffer.fill(0);
    this.convCache = new Float32Array(CONV_CACHE_SIZE);
    this.traCache = new Float32Array(TRA_CACHE_SIZE);
    this.interCache = new Float32Array(INTER_CACHE_SIZE);
    this.carry = new Float32Array(0);
    this.pendingFrames = [];
    this.hasMask = false;
  }

  /** One hop in -> that frame's analysis spectrum (bins 0..256, interleaved [re,im]). */
  private analyze(newHop: Float32Array): Float32Array {
    this.inputRing.copyWithin(0, HOP);
    this.inputRing.set(newHop, N_FFT - HOP);
    const windowed = this.windowedBuf;
    for (let i = 0; i < N_FFT; i++) windowed[i] = this.inputRing[i] * this.window[i];
    // realTransform only ever reads `data` by index, so the Float32Array can be passed directly.
    this.fft.realTransform(this.specBuf, windowed);
    return Float32Array.from((this.specBuf as unknown as number[]).slice(0, FREQ_BINS * 2));
  }

  /** Runs the frames the level selects through the model (one run when a session for that T
   *  exists), and fills the rest in with the most recent mask. Returns one enhanced spectrum
   *  per input frame, in order. */
  private async enhanceBatch(frames: Float32Array[], level: GtcrnSkipLevel): Promise<Float32Array[]> {
    const inferIdx = INFERRED_FRAMES[level].filter((i) => i < frames.length);
    const enhancedByIdx = new Map<number, Float32Array>();
    const batchSession = this.sessions[inferIdx.length as 1 | 2 | 4];
    const single = this.sessions[1];
    if (batchSession) {
      const outs = await this.runModel(batchSession, inferIdx.map((i) => frames[i]));
      inferIdx.forEach((i, k) => enhancedByIdx.set(i, outs[k]));
    } else if (single) {
      for (const i of inferIdx) enhancedByIdx.set(i, (await this.runModel(single, [frames[i]]))[0]);
    } else {
      throw new Error(`no GTCRN session for ${inferIdx.length} frames per run (use supportedSkipLevel)`);
    }

    return frames.map((mix, i) => {
      const enh = enhancedByIdx.get(i);
      if (enh) {
        this.updateMask(enh, mix);
        return enh;
      }
      return this.applyMask(mix);
    });
  }

  /** One session.run() over `frames` as consecutive time steps; advances the recurrent caches. */
  private async runModel(session: OrtSessionLike, frames: Float32Array[]): Promise<Float32Array[]> {
    const T = frames.length;
    // `mix` is (1, F, T, 2): flat index ((f * T) + t) * 2 + c.
    const mixData = new Float32Array(FREQ_BINS * T * 2);
    for (let t = 0; t < T; t++) {
      const frame = frames[t];
      for (let f = 0; f < FREQ_BINS; f++) {
        mixData[(f * T + t) * 2] = frame[2 * f];
        mixData[(f * T + t) * 2 + 1] = frame[2 * f + 1];
      }
    }
    const results = await session.run({
      mix: this.makeTensor(mixData, [1, FREQ_BINS, T, 2]),
      conv_cache: this.makeTensor(this.convCache, [2, 1, 16, 16, 33]),
      tra_cache: this.makeTensor(this.traCache, [2, 3, 1, 1, 16]),
      inter_cache: this.makeTensor(this.interCache, [2, 1, 33, 16]),
    });
    this.convCache = new Float32Array(results.conv_cache_out.data);
    this.traCache = new Float32Array(results.tra_cache_out.data);
    this.interCache = new Float32Array(results.inter_cache_out.data);

    const enh = results.enh.data; // same (1, F, T, 2) layout
    const outs: Float32Array[] = [];
    for (let t = 0; t < T; t++) {
      const frame = new Float32Array(FREQ_BINS * 2);
      for (let f = 0; f < FREQ_BINS; f++) {
        frame[2 * f] = enh[(f * T + t) * 2];
        frame[2 * f + 1] = enh[(f * T + t) * 2 + 1];
      }
      outs.push(frame);
    }
    return outs;
  }

  /** mask = enh / mix per bin (complex), capped at MAX_REUSED_MASK_GAIN. */
  private updateMask(enh: Float32Array, mix: Float32Array) {
    for (let f = 0; f < FREQ_BINS; f++) {
      const er = enh[2 * f];
      const ei = enh[2 * f + 1];
      const mr = mix[2 * f];
      const mi = mix[2 * f + 1];
      const denom = Math.max(mr * mr + mi * mi, 1e-16);
      let re = (er * mr + ei * mi) / denom;
      let im = (ei * mr - er * mi) / denom;
      const mag = Math.hypot(re, im);
      if (mag > MAX_REUSED_MASK_GAIN) {
        re *= MAX_REUSED_MASK_GAIN / mag;
        im *= MAX_REUSED_MASK_GAIN / mag;
      }
      this.lastMask[2 * f] = re;
      this.lastMask[2 * f + 1] = im;
    }
    this.hasMask = true;
  }

  private applyMask(mix: Float32Array): Float32Array {
    // Only reachable before any frame was inferred if a batch had no inferred frames, which no
    // level allows — but pass the frame through rather than zeroing it, just in case.
    if (!this.hasMask) return mix;
    const out = new Float32Array(FREQ_BINS * 2);
    for (let f = 0; f < FREQ_BINS; f++) {
      const kr = this.lastMask[2 * f];
      const ki = this.lastMask[2 * f + 1];
      out[2 * f] = mix[2 * f] * kr - mix[2 * f + 1] * ki;
      out[2 * f + 1] = mix[2 * f] * ki + mix[2 * f + 1] * kr;
    }
    return out;
  }

  /** One enhanced spectrum -> one hop of output samples (inverse FFT + overlap-add). */
  private synthesize(enh: Float32Array): Float32Array {
    const fullSpec = this.fullSpecBuf;
    for (let k = 0; k < FREQ_BINS * 2; k++) fullSpec[k] = enh[k];
    this.fft.completeSpectrum(fullSpec);
    const timeComplex = this.timeComplexBuf;
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
