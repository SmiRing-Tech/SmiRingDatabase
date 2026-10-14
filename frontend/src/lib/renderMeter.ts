/**
 * How much main-thread time React spends re-rendering the call screen — telemetry for the load
 * governor (useLoadGovernor reads it every sample). The call screen's top components re-render on
 * a long list of room events (active speaker changes, connection quality, mutes…), several times
 * a second in a lively meeting; on a slow PC each pass could cost tens of ms, competing with audio
 * and video work. This measures it instead of guessing.
 *
 * A measured component calls `renderMeterBegin(name)` at the top of its body and
 * `renderMeterEnd(name)` from a dependency-less useLayoutEffect, so one span covers rendering its
 * whole subtree plus the DOM commit (children's layout effects run before the parent's). A span
 * that starts while another is open is nested inside it and not counted twice.
 */

const STALE_MS = 1000;

const open = new Map<string, { start: number; nested: boolean }>();
let renders = 0;
let renderMs = 0;
let maxMs = 0;

export function renderMeterBegin(name: string) {
  const now = performance.now();
  let nested = false;
  for (const [other, span] of open) {
    // A render React threw away never reaches its layout effect; don't let it mark later ones nested.
    if (now - span.start > STALE_MS) open.delete(other);
    else if (other !== name) nested = true;
  }
  open.set(name, { start: now, nested });
}

export function renderMeterEnd(name: string) {
  const span = open.get(name);
  if (!span) return;
  open.delete(name);
  if (span.nested) return;
  const ms = performance.now() - span.start;
  renders += 1;
  renderMs += ms;
  maxMs = Math.max(maxMs, ms);
}

/** Totals since the last call, then resets. */
export function takeRenderMeter() {
  const result = { renders, renderMs, maxMs };
  renders = 0;
  renderMs = 0;
  maxMs = 0;
  return result;
}
