import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Drag-to-resize for the call screen's panels (the right-hand side panel, the speaker view's
 * film strip). While dragging, the new width goes straight onto the element's style once per
 * animation frame — no React state, so the call screen doesn't re-render on every mouse move;
 * `commit` runs once at the end, which is where the caller stores the width in state/localStorage.
 */
export function startWidthDrag(
  event: ReactPointerEvent<HTMLElement>,
  options: {
    startWidth: number;
    /** 1: dragging right widens. -1: dragging left widens (a handle on the panel's left edge). */
    direction: 1 | -1;
    min: number;
    max: number;
    apply: (width: number) => void;
    commit: (width: number) => void;
  },
) {
  if (event.button !== 0) return;
  event.preventDefault();
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  handle.setPointerCapture(pointerId);
  const startX = event.clientX;
  const { startWidth, direction, min, max, apply, commit } = options;
  let latestX = startX;
  let width = startWidth;
  let frame = 0;
  let ended = false;
  const body = document.body.style;
  const previous = { cursor: body.cursor, userSelect: body.userSelect };
  body.cursor = 'col-resize';
  body.userSelect = 'none';

  const flush = () => {
    frame = 0;
    width = Math.round(Math.min(max, Math.max(min, startWidth + (latestX - startX) * direction)));
    apply(width);
  };
  const onMove = (e: PointerEvent) => {
    latestX = e.clientX;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const onEnd = () => {
    if (ended) return;
    ended = true;
    if (frame) {
      cancelAnimationFrame(frame);
      flush();
    }
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    handle.removeEventListener('lostpointercapture', onEnd);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    body.cursor = previous.cursor;
    body.userSelect = previous.userSelect;
    commit(width);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
  handle.addEventListener('lostpointercapture', onEnd);
}

export function readStoredWidth(key: string): number | null {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function storeWidth(key: string, width: number | null) {
  try {
    if (width === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(width));
  } catch {
    // Private mode / blocked storage: the width just doesn't survive a reload.
  }
}

/** The thin grab area itself; a line shows on hover. Hidden on phones, where panels are full screen. */
export const RESIZE_HANDLE_CLASS =
  'hidden sm:block absolute inset-y-0 w-2 cursor-col-resize touch-none z-40 group/resize';
export const RESIZE_HANDLE_LINE_CLASS =
  'mx-auto h-full w-0.5 bg-transparent group-hover/resize:bg-sky-500/70 group-active/resize:bg-sky-400';
