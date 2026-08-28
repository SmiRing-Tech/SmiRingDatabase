import { useEffect, useState } from 'react';
import { MAX_LIVE_TILES, TILE_GAP, TILE_RATIO } from './tileIdentity';

export interface GridGeometry {
  /** Number of columns. */
  cols: number;
  /** Height of every row, in px. Uniform — this is what makes virtualization arithmetic. */
  rowH: number;
  /** Width of every tile, in px. */
  tileW: number;
  /** Distance from the top of one row to the top of the next (`rowH + gap`). */
  pitch: number;
  /** Total rows needed for *all* tiles, including the ones that overflow into scroll. */
  totalRows: number;
}

export interface GridGeometryInput {
  count: number;
  width: number;
  height: number;
  gap?: number;
  ratio?: number;
  minTileW?: number;
  minTileH?: number;
  maxVisible?: number;
}

/**
 * Lays out `count` tiles into a uniform grid that fills `width` x `height`.
 *
 * Two properties matter and neither is negotiable:
 *
 * 1. **Rows are uniform.** Every row is exactly `rowH` tall, so the set of tiles
 *    visible at a given `scrollTop` can be computed with division instead of
 *    measuring each tile. That is what lets the grid virtualize without attaching an
 *    IntersectionObserver to every participant.
 * 2. **Tiles stop shrinking at `maxVisible`.** Up to that many participants the grid
 *    fills the area exactly (no scrollbar, same look as before). Past it the tile
 *    size is frozen and the extra rows overflow, which is what turns "more people"
 *    into "scroll further" rather than "everyone gets smaller".
 */
export function computeGridGeometry({
  count,
  width: W,
  height: H,
  gap = TILE_GAP,
  ratio = TILE_RATIO,
  minTileW = 140,
  minTileH = 88,
  maxVisible = MAX_LIVE_TILES,
}: GridGeometryInput): GridGeometry {
  const safeCount = Math.max(1, count);
  const target = Math.max(1, Math.min(safeCount, maxVisible));

  if (W <= 0 || H <= 0) {
    return { cols: 1, rowH: 0, tileW: 0, pitch: gap, totalRows: safeCount };
  }

  // Pick the column count that maximises the area actually drawn for `target` tiles.
  // Note `w` is the letterboxed width inside the cell, not the cell width — a layout
  // with wide cells but short rows draws no bigger a video than a square one.
  let cols = 1;
  let best = -1;
  const colCap = Math.max(1, Math.floor((W + gap) / (minTileW + gap)));
  for (let c = 1; c <= Math.min(target, colCap); c++) {
    const r = Math.ceil(target / c);
    const cw = (W - gap * (c - 1)) / c;
    const ch = (H - gap * (r - 1)) / r;
    if (cw <= 0 || ch <= 0) continue;
    const w = Math.min(cw, ch * ratio);
    const area = w * (w / ratio);
    if (area > best) {
      best = area;
      cols = c;
    }
  }

  // Row height: the rows needed for `target` fill H exactly, unless that would push
  // tiles below `minTileH` — in which case we cap the row count and let rows overflow.
  const rowsWanted = Math.ceil(target / cols);
  const rowsByMin = Math.max(1, Math.floor((H + gap) / (minTileH + gap)));
  const rows = Math.max(1, Math.min(rowsWanted, rowsByMin));
  const rowH = Math.max(1, Math.floor((H - gap * (rows - 1)) / rows));
  const tileW = Math.max(1, Math.floor((W - gap * (cols - 1)) / cols));

  return { cols, rowH, tileW, pitch: rowH + gap, totalRows: Math.ceil(safeCount / cols) };
}

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Tracks an element's content-box size.
 *
 * Two details keep this from oscillating, and both are load-bearing:
 *
 * - Sizes are floored to whole pixels and sub-3px changes are ignored. Sub-pixel
 *   ResizeObserver noise would otherwise re-run the grid math on every frame.
 * - Callers that scroll must also set `scrollbarGutter: 'stable'`. Without it the
 *   scrollbar appearing narrows the container, which can re-flow the grid into
 *   fitting, which removes the scrollbar, which widens the container… a genuine
 *   infinite ResizeObserver loop.
 *
 * Takes the element itself (held in state via a callback ref) rather than a
 * RefObject, so the observer attaches whenever the node appears — including when it
 * mounts after the first render — and so the same node can be handed to other hooks.
 */
export function useElementSize(el: HTMLElement | null): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useEffect(() => {
    if (!el) return;

    const apply = (rawW: number, rawH: number) => {
      const width = Math.floor(rawW);
      const height = Math.floor(rawH);
      setSize((prev) =>
        Math.abs(prev.width - width) < 3 && Math.abs(prev.height - height) < 3
          ? prev
          : { width, height },
      );
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) apply(width, height);
      }
    });
    observer.observe(el);

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) apply(rect.width, rect.height);

    return () => observer.disconnect();
  }, [el]);

  return size;
}
