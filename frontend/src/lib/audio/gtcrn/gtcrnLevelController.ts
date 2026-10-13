import { GTCRN_MAX_SKIP_LEVEL, type GtcrnSkipLevel } from './GtcrnStreamProcessor';

/**
 * Picks GTCRN's skip level (see GtcrnSkipLevel) from what the worker measures live: how long
 * each 64ms chunk actually took, and how many chunks are waiting. Pure functions over a small
 * state object so the dynamics can be simulated outside a browser (scripts/simulate-gtcrn-levels.ts).
 */

/** Step a skip level up once the smoothed per-chunk cost passes this share of the budget, or a
 *  backlog of BACKLOG_STEP_UP_CHUNKS forms. Not 2 chunks: one 3x spike (a GC pause, a busy
 *  moment elsewhere) leaves ~2 behind, and that alone shouldn't cost quality. */
const STEP_UP_COST_RATIO = 0.8;
const BACKLOG_STEP_UP_CHUNKS = 3;
/** After any level change, wait this long for the new level's cost to show before judging again. */
const LEVEL_SETTLE_MS = 1500;
/** Step back down only when the *next lower* level's estimated cost would sit under this share
 *  of the budget, continuously for STEP_DOWN_CALM_MS — slow to trust, so it doesn't flap. Judged
 *  on a much slower average than stepping up, so that occasional spikes neither keep resetting
 *  the calm period (which left a simulated 45ms machine stuck at the lightest level for good)
 *  nor talk it into stepping down early. */
const STEP_DOWN_COST_RATIO = 0.6;
const STEP_DOWN_CALM_MS = 10_000;
const SLOW_COST_EMA_ALPHA = 0.05;
/** Measured relative per-chunk cost of each level (WASM: ~0.71 / 0.53 / 0.44ms on an M4) — used
 *  only to estimate what stepping down would cost. */
const LEVEL_COST: Record<GtcrnSkipLevel, number> = { 0: 1, 1: 0.75, 2: 0.62 };
/** Smoothing for the step-up average: slow enough that one 3x spike moves it by only ~20% of the
 *  chunk cost (well short of STEP_UP_COST_RATIO from a normal level), fast enough that a real,
 *  sustained slowdown crosses it within ~10 chunks (~0.6s) — and the backlog rule catches a
 *  sudden one sooner. */
const COST_EMA_ALPHA = 0.1;

export interface LevelState {
  level: GtcrnSkipLevel;
  /** Smoothed ms per chunk at the current level; null right after a level change. */
  costEma: number | null;
  /** Same, much more heavily smoothed — for stepping down. */
  slowCostEma: number | null;
  levelChangedAt: number;
  /** When the step-down condition last started holding continuously (0 = not holding). */
  calmSince: number;
}

export function createLevelState(now: number): LevelState {
  return { level: 0, costEma: null, slowCostEma: null, levelChangedAt: now, calmSince: 0 };
}

export function setLevel(state: LevelState, level: GtcrnSkipLevel, now: number) {
  state.level = level;
  state.costEma = null;
  state.slowCostEma = null;
  state.levelChangedAt = now;
  state.calmSince = 0;
}

/** Adjusts the skip level from the latest chunk's cost and the backlog left behind it. */
export function updateLevel(state: LevelState, costMs: number, backlog: number, budgetMs: number, now: number) {
  state.costEma = state.costEma === null ? costMs : state.costEma + COST_EMA_ALPHA * (costMs - state.costEma);
  state.slowCostEma =
    state.slowCostEma === null ? costMs : state.slowCostEma + SLOW_COST_EMA_ALPHA * (costMs - state.slowCostEma);
  if (now - state.levelChangedAt < LEVEL_SETTLE_MS) return;

  const falling = backlog >= BACKLOG_STEP_UP_CHUNKS || state.costEma > budgetMs * STEP_UP_COST_RATIO;
  if (falling) {
    if (state.level < GTCRN_MAX_SKIP_LEVEL) setLevel(state, (state.level + 1) as GtcrnSkipLevel, now);
    return;
  }
  if (state.level === 0) return;
  const lower = (state.level - 1) as GtcrnSkipLevel;
  const estimatedLowerCost = (state.slowCostEma / LEVEL_COST[state.level]) * LEVEL_COST[lower];
  if (backlog < BACKLOG_STEP_UP_CHUNKS - 1 && estimatedLowerCost < budgetMs * STEP_DOWN_COST_RATIO) {
    if (state.calmSince === 0) state.calmSince = now;
    else if (now - state.calmSince >= STEP_DOWN_CALM_MS) setLevel(state, lower, now);
  } else {
    state.calmSince = 0;
  }
}
