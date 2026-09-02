import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FitBox, ZoomTransform } from './ClampedVideoTrack';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const IDENTITY: ZoomTransform = { scale: 1, x: 0, y: 0 };

/**
 * Keeps the scaled video box covering the container: pan is limited to the overflow
 * the zoom actually created, so no edge can ever be dragged into view.
 *
 * At `scale === 1` both maxima are 0, which snaps the video back to dead centre
 * rather than leaving it drifted where the last gesture ended.
 */
function clampPan(x: number, y: number, scale: number, fit: FitBox | null) {
  if (!fit) return { x: 0, y: 0 };
  const maxX = Math.max(0, (fit.boxW * scale - fit.contW) / 2);
  const maxY = Math.max(0, (fit.boxH * scale - fit.contH) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

/**
 * Zooms about a point, keeping whatever is under that point stationary.
 * `px`/`py` are relative to the container's centre, matching `transform-origin`.
 */
function zoomAt(
  prev: ZoomTransform,
  nextScale: number,
  px: number,
  py: number,
  fit: FitBox | null,
): ZoomTransform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
  const k = scale / prev.scale;
  return { scale, ...clampPan(px - (px - prev.x) * k, py - (py - prev.y) * k, scale, fit) };
}

export interface ZoomPan {
  /** Attach to the element that wraps the video. */
  setContainer: (el: HTMLDivElement | null) => void;
  /** Pass to `ClampedVideoTrack`; undefined when zooming is disabled. */
  zoom: ZoomTransform | undefined;
  /** Pass to `ClampedVideoTrack` so panning knows the fitted box size. */
  onFitChange: (fit: FitBox) => void;
  /** Spread onto the container element. */
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onDoubleClick: (e: React.MouseEvent) => void;
  };
  isZoomed: boolean;
  isDragging: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  percent: number;
}

/**
 * Local zoom and pan for a video, as a CSS transform.
 *
 * Nothing here touches LiveKit: the publisher keeps sending exactly what it sent
 * before, and every viewer zooms independently. A shared screen usually arrives at a
 * higher resolution than the tile displays it at, so zooming in genuinely recovers
 * detail rather than just enlarging pixels.
 *
 * The caller must key the owning component on the track (`<StageTile key={tileId} />`)
 * so switching to a different stage track remounts and starts back at 1x. That is
 * what React recommends over resetting state in an effect, and it is why there is no
 * reset-on-change effect here.
 */
export function useZoomPan(enabled: boolean): ZoomPan {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<ZoomTransform>(IDENTITY);
  const [isDragging, setIsDragging] = useState(false);

  const fitRef = useRef<FitBox | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchDistRef = useRef<number | null>(null);

  const reset = useCallback(() => setZoom(IDENTITY), []);

  const onFitChange = useCallback((fit: FitBox) => {
    const prev = fitRef.current;
    fitRef.current = fit;
    // A resize (window, or opening the chat sidebar) invalidates the pan we clamped
    // against, so start clean rather than leaving the video parked off-centre.
    if (prev && (Math.abs(prev.contW - fit.contW) > 4 || Math.abs(prev.contH - fit.contH) > 4)) {
      setZoom(IDENTITY);
    }
  }, []);

  /** Pointer/client coords -> offset from the container's centre. */
  const toCenterCoords = useCallback(
    (clientX: number, clientY: number) => {
      if (!container) return { px: 0, py: 0 };
      const rect = container.getBoundingClientRect();
      return {
        px: clientX - rect.left - rect.width / 2,
        py: clientY - rect.top - rect.height / 2,
      };
    },
    [container],
  );

  // Wheel must be a manual, non-passive listener: React routes onWheel through a
  // passive root listener, so preventDefault() there is a no-op that logs an error
  // and lets the page scroll behind the zoom.
  useEffect(() => {
    if (!container || !enabled) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      // Trackpad pinch (and literal Ctrl+wheel) — browsers report both this way.
      // Its per-event deltaY is much smaller than a physical wheel notch, so it
      // needs a stronger multiplier than plain-wheel zoom used to, to feel
      // responsive rather than sluggish.
      if (e.ctrlKey) {
        const rect = container.getBoundingClientRect();
        const px = e.clientX - rect.left - rect.width / 2;
        const py = e.clientY - rect.top - rect.height / 2;
        setZoom((prev) =>
          zoomAt(prev, prev.scale * Math.exp(-e.deltaY * 0.02), px, py, fitRef.current),
        );
        return;
      }

      // Plain wheel/two-finger scroll pans instead of zooming: a scroll gesture
      // reads as "move around" to anyone on a trackpad, and freeing the physical
      // mouse wheel from zoom duty removes the fight between the two gestures.
      // Zooming is still available via pinch (above), the +/- buttons, or double-click.
      setZoom((prev) => ({
        ...prev,
        ...clampPan(prev.x - e.deltaX, prev.y - e.deltaY, prev.scale, fitRef.current),
      }));
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [container, enabled]);

  const handlers = useMemo(
    () => ({
      onPointerDown: (e: React.PointerEvent) => {
        if (!enabled) return;
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointersRef.current.size === 1 && zoom.scale > 1) {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setIsDragging(true);
        }
      },

      onPointerMove: (e: React.PointerEvent) => {
        if (!enabled) return;
        const pointers = pointersRef.current;
        const prevPoint = pointers.get(e.pointerId);
        if (!prevPoint) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size >= 2) {
          const [a, b] = [...pointers.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          const prevDist = pinchDistRef.current;
          pinchDistRef.current = dist;
          if (prevDist && prevDist > 0) {
            const { px, py } = toCenterCoords((a.x + b.x) / 2, (a.y + b.y) / 2);
            setZoom((prev) => zoomAt(prev, prev.scale * (dist / prevDist), px, py, fitRef.current));
          }
          return;
        }

        if (!isDragging) return;
        const dx = e.clientX - prevPoint.x;
        const dy = e.clientY - prevPoint.y;
        setZoom((prev) => ({
          ...prev,
          ...clampPan(prev.x + dx, prev.y + dy, prev.scale, fitRef.current),
        }));
      },

      onPointerUp: (e: React.PointerEvent) => {
        pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size < 2) pinchDistRef.current = null;
        if (pointersRef.current.size === 0) setIsDragging(false);
      },

      onPointerCancel: (e: React.PointerEvent) => {
        pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size < 2) pinchDistRef.current = null;
        if (pointersRef.current.size === 0) setIsDragging(false);
      },

      onDoubleClick: (e: React.MouseEvent) => {
        if (!enabled) return;
        const { px, py } = toCenterCoords(e.clientX, e.clientY);
        setZoom((prev) =>
          prev.scale > 1 ? IDENTITY : zoomAt(prev, 2, px, py, fitRef.current),
        );
      },
    }),
    [enabled, isDragging, toCenterCoords, zoom.scale],
  );

  const zoomIn = useCallback(
    () => setZoom((prev) => zoomAt(prev, prev.scale * 1.4, 0, 0, fitRef.current)),
    [],
  );
  const zoomOut = useCallback(
    () => setZoom((prev) => zoomAt(prev, prev.scale / 1.4, 0, 0, fitRef.current)),
    [],
  );

  return {
    setContainer,
    zoom: enabled && zoom.scale !== 1 ? zoom : undefined,
    onFitChange,
    handlers,
    isZoomed: enabled && zoom.scale > 1,
    isDragging,
    zoomIn,
    zoomOut,
    reset,
    percent: Math.round(zoom.scale * 100),
  };
}
