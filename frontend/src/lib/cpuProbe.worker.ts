/**
 * Whole-machine CPU contention probe for the load governor's telemetry.
 *
 * Everything else the governor measures only says whether *this page* kept up. Users report the
 * opposite symptom — Connect keeps up while the rest of the computer (other tabs, other apps)
 * gets sluggish — so this measures how much CPU is left for anyone: once a second it runs the
 * same fixed piece of arithmetic and reports how long it took, plus how late its own timer fired.
 * On an idle machine both stay at their floor; when every core is busy the OS time-slices this
 * thread with everyone else and both stretch. Compare against the session's own floor (the
 * summary script uses a low percentile), not across machines.
 *
 * Runs in a dedicated worker: not throttled when the tab is hidden, and never blocks the page.
 * Cost: a few ms of one core per second.
 */

const TICK_MS = 1000;
const ITERATIONS = 400_000;

let lastTick = performance.now();
let sink = 0;

function work(): number {
  const t0 = performance.now();
  let x = sink || 1;
  for (let i = 1; i <= ITERATIONS; i += 1) x = (x * 1.000001 + Math.sqrt(i)) % 1e9;
  sink = x; // keep the loop from being optimised away
  return performance.now() - t0;
}

setInterval(() => {
  const now = performance.now();
  const lateMs = Math.max(0, now - lastTick - TICK_MS);
  lastTick = now;
  self.postMessage({ workMs: work(), lateMs });
}, TICK_MS);
