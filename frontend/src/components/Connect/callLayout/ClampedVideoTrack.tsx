import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  VideoTrack,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';

/** Zoom/pan transform applied on top of the fitted video box. Purely local. */
export interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

/** The fitted video box and the container it sits in, in px. */
export interface FitBox {
  /** Width of the letterboxed/cropped video box. */
  boxW: number;
  /** Height of the letterboxed/cropped video box. */
  boxH: number;
  /** Width of the container the box is centered in. */
  contW: number;
  /** Height of the container the box is centered in. */
  contH: number;
}

export interface ClampedVideoTrackProps {
  trackRef: TrackReferenceOrPlaceholder;
  className?: string;
  isLocalMirror?: boolean;
  /** Local zoom/pan. Only meaningful for screen shares on a stage. */
  zoom?: ZoomTransform;
  /** Reports the fitted box size, which zoom/pan needs to clamp panning. */
  onFitChange?: (fit: FitBox) => void;
}

/**
 * Clamped Video Track:
 * Automatically detects whether the stream is landscape (PC) or portrait (mobile)
 * and clamps display aspect ratio between [native ratio] and [1:1 square], centering
 * vertically or horizontally as needed to prevent extreme crop/zoom.
 *
 * Screen shares are letterboxed to their exact native ratio instead (never cropped),
 * since cropping a shared screen would cut off content.
 */
export default function ClampedVideoTrack({
  trackRef,
  className = '',
  isLocalMirror = false,
  zoom,
  onFitChange,
}: ClampedVideoTrackProps) {
  // Callback ref, not useRef: the early `return null` below means this component can
  // render nothing on its first pass and mount the container only later, when the
  // placeholder resolves into a real track reference. A `useRef` + `[]`-dep effect
  // would run once against a null ref and never re-run, so the ResizeObserver would
  // never attach and `containerSize` would stay null forever — silently disabling all
  // the clamping math below.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [nativeRatio, setNativeRatio] = useState<number | null>(null);

  const isRef = isTrackReference(trackRef);
  const isScreenShare = trackRef.source === Track.Source.ScreenShare;

  useEffect(() => {
    if (!containerEl) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setContainerSize({ width, height });
        }
      }
    });

    observer.observe(containerEl);
    const rect = containerEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setContainerSize({ width: rect.width, height: rect.height });
    }

    return () => observer.disconnect();
  }, [containerEl]);

  useEffect(() => {
    if (!isRef) return;
    const dims = trackRef.publication?.dimensions;
    if (dims && dims.width > 0 && dims.height > 0) {
      setNativeRatio(dims.width / dims.height);
    }
  }, [trackRef, isRef]);

  const onVideoLoadedMetadata = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setNativeRatio(video.videoWidth / video.videoHeight);
    }
  }, []);

  const fit = useMemo<FitBox | null>(() => {
    if (!containerSize) return null;

    const { width: cW, height: cH } = containerSize;
    if (cW <= 0 || cH <= 0) return null;

    const cRatio = cW / cH;
    const rNative = nativeRatio ?? 16 / 9;

    if (isScreenShare) {
      // Contain: fit the whole shared screen, never crop it.
      if (cRatio > rNative) {
        return { boxW: Math.floor(cH * rNative), boxH: cH, contW: cW, contH: cH };
      }
      return { boxW: cW, boxH: Math.floor(cW / rNative), contW: cW, contH: cH };
    }

    // Min and Max allowed aspect ratios:
    // Landscape video: [1:1, nativeRatio] -> max crop is 1:1 square
    // Portrait video:  [nativeRatio, 1:1] -> max crop is 1:1 square
    let rMin: number;
    let rMax: number;

    if (rNative >= 1.0) {
      rMin = 1.0;
      rMax = rNative;
    } else {
      rMin = rNative;
      rMax = 1.0;
    }

    let targetW = cW;
    let targetH = cH;

    if (cRatio < rMin) {
      targetW = cW;
      targetH = cW / rMin;
    } else if (cRatio > rMax) {
      targetH = cH;
      targetW = cH * rMax;
    }

    return {
      boxW: Math.floor(targetW),
      boxH: Math.floor(targetH),
      contW: cW,
      contH: cH,
    };
  }, [containerSize, nativeRatio, isScreenShare]);

  const boxW = fit?.boxW ?? 0;
  const boxH = fit?.boxH ?? 0;
  const contW = fit?.contW ?? 0;
  const contH = fit?.contH ?? 0;
  useEffect(() => {
    if (!fit) return;
    onFitChange?.({ boxW, boxH, contW, contH });
    // Depend on the numbers, not the object, so a fresh-but-equal `fit` is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxW, boxH, contW, contH, onFitChange]);

  const boxStyle = useMemo<React.CSSProperties>(() => {
    const size: React.CSSProperties = fit
      ? { width: `${fit.boxW}px`, height: `${fit.boxH}px` }
      : { width: '100%', height: '100%' };

    if (!zoom) return size;

    return {
      ...size,
      // The transform sits on the already-fitted box, so it composes with the
      // letterbox math above instead of fighting it. Transforms don't affect layout
      // size, so the ResizeObserver on the container never sees this and there is no
      // feedback loop.
      transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
      transformOrigin: 'center center',
      willChange: zoom.scale !== 1 ? 'transform' : undefined,
    };
  }, [fit, zoom]);

  // Every hook above runs unconditionally; only now is it safe to bail out.
  if (!isRef) return null;

  return (
    <div
      ref={setContainerEl}
      className={`absolute inset-0 w-full h-full min-h-0 min-w-0 overflow-hidden flex items-center justify-center ${className}`}
    >
      <div
        style={boxStyle}
        className="relative overflow-hidden shrink-0 flex items-center justify-center rounded-xl sm:rounded-2xl"
      >
        <VideoTrack
          trackRef={trackRef}
          onLoadedMetadata={onVideoLoadedMetadata}
          className="w-full h-full object-cover"
          style={{ transform: isLocalMirror ? 'scaleX(-1)' : 'none' }}
        />
      </div>
    </div>
  );
}
