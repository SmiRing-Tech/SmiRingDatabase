import { useEffect, useState } from 'react';

/** Tiles assumed visible before the scroll container has been measured. */
const INITIAL_WINDOW = 12;

export interface ScrollWindowOptions {
  /** Distance from the start of one row to the start of the next, in px. */
  pitch: number;
  /** Items per row (1 for the vertical/horizontal strips). */
  perRow: number;
  /** Total item count. */
  count: number;
  /** Visible length of the scroll container along the scroll axis, in px. */
  viewport: number;
  axis?: 'y' | 'x';
  /** Rows of lookahead kept mounted on each side of the viewport. */
  prefetchRows?: number;
  /** Idle time after scrolling stops before new tiles are allowed to mount. */
  settleMs?: number;
}

export interface ScrollWindow {
  /** Index range of items currently within the viewport plus prefetch margin. */
  start: number;
  end: number;
  /** False while a scroll gesture is in flight. */
  settled: boolean;
}

/**
 * Computes which items are on screen, by arithmetic rather than observation.
 *
 * Because every row is exactly `pitch` tall, the visible range follows directly from
 * `scrollTop`. The alternative — an IntersectionObserver per tile — means a hundred
 * observations and a callback storm on every flick, for information we can divide
 * our way to.
 *
 * `settled` is what keeps fast scrolling smooth: see `useLiveTileIds`.
 */
export function useScrollWindow(
  el: HTMLElement | null,
  { pitch, perRow, count, viewport, axis = 'y', prefetchRows = 1, settleMs = 120 }: ScrollWindowOptions,
): ScrollWindow {
  // Before the container has been measured we can't know what's visible. The initial
  // guess is capped rather than using `count`: in a 60-person room that would mount
  // every video at once for a frame, which is exactly the cost this hook exists to
  // avoid. The real window lands as soon as the element mounts.
  const [win, setWin] = useState(() => ({ start: 0, end: Math.min(count, INITIAL_WINDOW) }));
  const [settled, setSettled] = useState(true);

  useEffect(() => {
    if (!el || pitch <= 0 || count <= 0) return;

    let raf = 0;
    let timer = 0;

    const compute = () => {
      raf = 0;
      const offset = axis === 'y' ? el.scrollTop : el.scrollLeft;
      const rows = Math.ceil(count / perRow);
      const firstRow = Math.max(0, Math.floor(offset / pitch) - prefetchRows);
      const lastRow = Math.min(rows - 1, Math.ceil((offset + viewport) / pitch) + prefetchRows);
      const next = {
        start: firstRow * perRow,
        end: Math.min(count, (lastRow + 1) * perRow),
      };
      setWin((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };

    const onScroll = () => {
      setSettled(false);
      // At most one recompute per frame, however fast the scroll events arrive.
      if (!raf) raf = requestAnimationFrame(compute);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setSettled(true), settleMs);
    };

    compute();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [el, pitch, perRow, count, viewport, axis, prefetchRows, settleMs]);

  return { start: win.start, end: win.end, settled };
}

/**
 * Decides which tiles actually get a live `<video>`.
 *
 * Mid-flick we mount nothing new and only keep what is already playing and still in
 * range. Tearing decoders up and down at flick speed is what makes a virtualized
 * video grid stutter; showing cheap avatars for the ~120ms of a fast scroll, then
 * filling in once it stops, reads as smooth instead.
 */
export function useLiveTileIds(orderedIds: string[], win: ScrollWindow): Set<string> {
  const windowIds = orderedIds.slice(win.start, win.end);
  const key = `${win.settled}|${windowIds.join(' ')}`;

  // React's "adjust state when a prop changes" pattern rather than an effect: the new
  // value is needed for *this* render, and going through an effect would paint one
  // frame of stale tiles first.
  const [state, setState] = useState(() => ({ key, live: new Set(windowIds) }));

  if (state.key !== key) {
    const inWindow = new Set(windowIds);
    const live = win.settled
      ? inWindow
      : // Mid-flick: keep what is already playing and still in range, mount nothing new.
        new Set([...state.live].filter((id) => inWindow.has(id)));
    setState({ key, live });
    return live;
  }

  return state.live;
}
