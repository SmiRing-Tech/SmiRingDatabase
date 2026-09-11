/**
 * A metronome living in its own thread, purely so VideoDelayPipeline's frame-release timing
 * survives the tab being backgrounded. Chrome (and others) clamp main-thread setTimeout/
 * setInterval to ~1/sec once a tab is hidden, which is fine for most UI work but turns a video
 * pacing delay into "frames dump out once a second" — dedicated Web Workers are exempt from that
 * throttling, so this file's only job is to tick reliably regardless of tab visibility.
 */

const TICK_MS = 10;
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
