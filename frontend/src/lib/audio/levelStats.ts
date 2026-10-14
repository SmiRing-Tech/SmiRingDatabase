/**
 * Level statistics over the 10ms blocks levelMeter.worklet.ts produces.
 *
 * The headline figure is the *active speech level* — the level of the speech itself, with the
 * pauses between words and sentences left out — computed with ITU-T P.56 method B, the standard
 * telephony/conferencing measure (results are in dBov, which for float audio is dB relative to
 * an RMS of 1.0, i.e. the same scale as dBFS RMS). A plain average over a take would mostly
 * measure how often someone paused, not how loud they were, and a peak would mostly measure
 * plosives; P.56 is what lets two takes of the same passage — different mics, distances, apps —
 * be compared on loudness alone.
 *
 * P.56 is specified per sample; this runs it per 10ms block (block mean |x| through the same
 * two-stage 30ms envelope, same 200ms hangover, same 15.9dB margin). Block granularity shifts
 * the activity boundaries by at most a block, which is far below what matters here.
 */

export const LEVEL_BLOCK_MS = 10;

/** dB floor used wherever a level would otherwise be -Infinity (digital silence). */
export const SILENCE_DB = -120;

const ENVELOPE_TIME_CONSTANT_MS = 30;
const HANGOVER_MS = 200;
const MARGIN_DB = 15.9;
const THRESHOLD_STEP_DB = 0.5;

export interface LevelBlocks {
  power: ArrayLike<number>;
  meanAbs: ArrayLike<number>;
  peak: ArrayLike<number>;
  clipped: number;
}

export interface LevelSummary {
  durationSec: number;
  /** ITU-T P.56 active speech level (dBov ≈ dBFS RMS). null if no speech was found. */
  activeLevelDb: number | null;
  /** Share of the take P.56 counted as speech, 0-100. */
  activityPct: number;
  /** 10th-percentile block level — the room/mic noise between words. */
  noiseFloorDb: number;
  /** 95th-percentile block level — the louder syllables. */
  loudDb: number;
  /** Highest sample of the take, dBFS. */
  peakDb: number;
  clippedSamples: number;
}

export const powerToDb = (power: number) => (power > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(power)) : SILENCE_DB);
export const amplitudeToDb = (amp: number) => (amp > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(amp)) : SILENCE_DB);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return SILENCE_DB;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

/** ITU-T P.56 method B over blocks. Returns null when nothing in the take looks like speech. */
export function activeSpeechLevel(power: ArrayLike<number>, meanAbs: ArrayLike<number>): { levelDb: number; activity: number } | null {
  const n = power.length;
  if (n === 0) return null;

  let energy = 0;
  for (let k = 0; k < n; k++) energy += power[k];
  if (energy <= 0) return null;

  // Two-stage exponential envelope of |x|, as in P.56.
  const g = Math.exp(-LEVEL_BLOCK_MS / ENVELOPE_TIME_CONSTANT_MS);
  const envelope = new Float64Array(n);
  let p = 0;
  let q = 0;
  for (let k = 0; k < n; k++) {
    p = g * p + (1 - g) * meanAbs[k];
    q = g * q + (1 - g) * p;
    envelope[k] = q;
  }

  const hangoverBlocks = Math.round(HANGOVER_MS / LEVEL_BLOCK_MS);
  // Walk thresholds upward; (active level - threshold) shrinks as the threshold rises, and the
  // active level is where that gap equals the margin.
  let prev: { thresholdDb: number; levelDb: number; activity: number } | null = null;
  for (let thresholdDb = SILENCE_DB; thresholdDb <= 0; thresholdDb += THRESHOLD_STEP_DB) {
    const threshold = 10 ** (thresholdDb / 20);
    let active = 0;
    let sinceAbove = Infinity;
    for (let k = 0; k < n; k++) {
      if (envelope[k] >= threshold) sinceAbove = 0;
      else sinceAbove++;
      if (sinceAbove <= hangoverBlocks) active++;
    }
    if (active === 0) break;
    const levelDb = 10 * Math.log10(energy / active);
    const activity = active / n;
    const gap = levelDb - thresholdDb;
    if (gap <= MARGIN_DB) {
      if (!prev) return { levelDb, activity };
      // Interpolate between the last threshold above the margin and this one.
      const prevGap = prev.levelDb - prev.thresholdDb;
      const t = (prevGap - MARGIN_DB) / (prevGap - gap);
      return {
        levelDb: prev.levelDb + t * (levelDb - prev.levelDb),
        activity: prev.activity + t * (activity - prev.activity),
      };
    }
    prev = { thresholdDb, levelDb, activity };
  }
  return null;
}

export function summarizeLevels(blocks: LevelBlocks): LevelSummary {
  const n = blocks.power.length;
  const blockDb: number[] = [];
  let peak = 0;
  for (let k = 0; k < n; k++) {
    blockDb.push(powerToDb(blocks.power[k]));
    if (blocks.peak[k] > peak) peak = blocks.peak[k];
  }
  blockDb.sort((a, b) => a - b);
  const active = activeSpeechLevel(blocks.power, blocks.meanAbs);
  return {
    durationSec: (n * LEVEL_BLOCK_MS) / 1000,
    activeLevelDb: active ? active.levelDb : null,
    activityPct: active ? active.activity * 100 : 0,
    noiseFloorDb: percentile(blockDb, 10),
    loudDb: percentile(blockDb, 95),
    peakDb: amplitudeToDb(peak),
    clippedSamples: blocks.clipped,
  };
}
