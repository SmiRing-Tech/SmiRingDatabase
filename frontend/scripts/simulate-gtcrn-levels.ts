/**
 * Dev-only: simulates the GTCRN worker's real-time controller (src/lib/audio/gtcrn/
 * gtcrnLevelController.ts, plus the worker's backlog cap) against machines of different speeds,
 * in virtual time — to see how the skip level, the backlog and the fallbacks behave before
 * anyone has to sit on a slow laptop to find out. Not part of the app build.
 *
 *   npx tsx scripts/simulate-gtcrn-levels.ts
 *
 * "Base cost" is ms per 64ms chunk at level 0 (all frames inferred). For scale: ~0.7ms on an M4,
 * and an estimated 36-65ms on the 2-core MacBook Air that measured 90-160ms with the old
 * one-frame-per-run model.
 */
import { createLevelState, setLevel, updateLevel } from '../src/lib/audio/gtcrn/gtcrnLevelController';
import { GTCRN_MAX_SKIP_LEVEL, type GtcrnSkipLevel } from '../src/lib/audio/gtcrn/GtcrnStreamProcessor';

const CHUNK_MS = 64;
// Mirrors gtcrnInference.worker.ts.
const MAX_BACKLOG_CHUNKS = 4;
const OVERLOAD_TRIPS = 3;
const OVERLOAD_WINDOW_MS = 10_000;
// Relative cost per level, as measured (see LEVEL_COST in the controller).
const LEVEL_COST: Record<GtcrnSkipLevel, number> = { 0: 1, 1: 0.75, 2: 0.62 };

let seed = 1;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** ±20% jitter, plus a 3x spike on 2% of chunks (GC pauses, a busy moment elsewhere). */
function chunkCost(base: number, level: GtcrnSkipLevel) {
  const spike = random() < 0.02 ? 3 : 1;
  return base * LEVEL_COST[level] * (0.8 + 0.4 * random()) * spike;
}

function simulate(baseCostAt: (t: number) => number, durationMs: number) {
  const state = createLevelState(0);
  const queue: number[] = []; // arrival times
  let workerFreeAt = 0;
  let nextArrival = 0;
  let capTrips: number[] = [];
  let overloadedAt: number | null = null;
  let passthrough = 0;
  let processed = 0;
  let maxDelay = 0;
  const timeAtLevel: Record<GtcrnSkipLevel, number> = { 0: 0, 1: 0, 2: 0 };
  const timeline: string[] = [];
  let lastLevel: GtcrnSkipLevel = 0;

  for (let now = 0; now <= durationMs && overloadedAt === null; ) {
    // Next event: a chunk arriving, or the worker finishing.
    if (nextArrival <= workerFreeAt || queue.length === 0) {
      now = Math.max(now, nextArrival);
      queue.push(nextArrival);
      nextArrival += CHUNK_MS;
      if (now < workerFreeAt) continue;
    } else {
      now = workerFreeAt;
    }
    if (queue.length === 0) continue;

    // Worker takes the next job (with the backlog cap applied first).
    if (queue.length > MAX_BACKLOG_CHUNKS) {
      passthrough += queue.length - 1;
      queue.splice(0, queue.length - 1);
      setLevel(state, GTCRN_MAX_SKIP_LEVEL, now);
      capTrips = capTrips.filter((t) => now - t < OVERLOAD_WINDOW_MS);
      capTrips.push(now);
      if (capTrips.length >= OVERLOAD_TRIPS) overloadedAt = now;
    }
    const arrived = queue.shift()!;
    const level = state.level;
    const cost = chunkCost(baseCostAt(now), level);
    const done = now + cost;
    timeAtLevel[level] += cost;
    processed++;
    maxDelay = Math.max(maxDelay, done - arrived);
    // Chunks that arrive while this one is processing count toward the backlog it leaves.
    while (nextArrival <= done) {
      queue.push(nextArrival);
      nextArrival += CHUNK_MS;
    }
    updateLevel(state, cost, queue.length, CHUNK_MS, done);
    if (state.level !== lastLevel) {
      timeline.push(`${(done / 1000).toFixed(1)}s:L${state.level}`);
      lastLevel = state.level;
    }
    workerFreeAt = done;
    now = done;
  }

  const total = timeAtLevel[0] + timeAtLevel[1] + timeAtLevel[2] || 1;
  return {
    processed,
    passthroughPct: Math.round((passthrough / Math.max(1, processed + passthrough)) * 1000) / 10,
    maxDelayMs: Math.round(maxDelay),
    overloadedAt: overloadedAt === null ? '-' : `${(overloadedAt / 1000).toFixed(1)}s`,
    levelShare: [0, 1, 2].map((l) => `${Math.round((timeAtLevel[l as GtcrnSkipLevel] / total) * 100)}%`).join('/'),
    timeline: timeline.slice(0, 8).join(' ') + (timeline.length > 8 ? ` …(+${timeline.length - 8})` : ''),
  };
}

console.log('steady machines, 120s each (levelShare = share of work at level 0/1/2):');
for (const base of [1, 30, 45, 55, 65, 75, 90, 120]) {
  seed = 1;
  const r = simulate(() => base, 120_000);
  console.log(
    `  base ${String(base).padStart(3)}ms/chunk: maxDelay ${String(r.maxDelayMs).padStart(4)}ms, passthrough ${r.passthroughPct}%, ` +
      `overloaded ${r.overloadedAt}, levels ${r.levelShare}  ${r.timeline}`,
  );
}

console.log('\nload changes mid-call (30ms -> 60ms at 30s -> 30ms at 70s), 120s:');
seed = 1;
console.log(' ', simulate((t) => (t >= 30_000 && t < 70_000 ? 60 : 30), 120_000));
