/**
 * A metronome living in its own thread, purely so VideoDelayPipeline's frame-release timing
 * survives the tab being backgrounded. Chrome (and others) clamp main-thread setTimeout/
 * setInterval to ~1/sec once a tab is hidden, which is fine for most UI work but turns a video
 * pacing delay into "frames dump out once a second" — dedicated Web Workers are exempt from that
 * throttling, so this file's only job is to tick reliably regardless of tab visibility.
 */

// 50ms rather than something closer to a frame period: this only paces a fixed lip-sync delay
// of a couple hundred ms, and A/V drift under ~1s is imperceptible for this app's calls (per
// product call — see the battery-optimization discussion this constant came out of), so the
// release-time granularity this trades away costs nothing anyone will notice. In exchange it
// cuts this worker's wakeups (and the main thread's postMessage handling of each one, including
// VideoDelayPipeline's own waiters bookkeeping) by 5x versus the previous 10ms tick — this ticks
// for the entire duration of every call that has the video-delay pipeline active, so the
// wakeup rate is a real, sustained battery cost, not a one-off.
const TICK_MS = 50;
let intervalId: ReturnType<typeof setInterval> | undefined;

self.onmessage = (event: MessageEvent<'start' | 'stop'>) => {
  if (event.data === 'start') {
    if (intervalId !== undefined) return;
    intervalId = setInterval(() => self.postMessage('tick'), TICK_MS);
  } else if (event.data === 'stop') {
    if (intervalId !== undefined) clearInterval(intervalId);
    intervalId = undefined;
  }
};
