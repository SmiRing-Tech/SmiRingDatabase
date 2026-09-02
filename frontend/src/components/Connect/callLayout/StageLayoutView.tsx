import { useMemo, useState } from 'react';
import { isTrackReference, type TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { Minimize2, ZoomIn, ZoomOut } from 'lucide-react';
import { CustomParticipantTile } from './ParticipantTileContent';
import { computeGridGeometry, useElementSize } from './geometry';
import { useLiveTileIds, useScrollWindow } from './useScrollWindow';
import { useZoomPan } from './useZoomPan';
import {
  STRIP_CAPACITY,
  STRIP_ORIENTATION_WIDTH,
  TILE_GAP,
  TILE_RATIO,
  tileId,
  trackRevisionKey,
} from './tileIdentity';

interface StripProps {
  tracks: TrackReferenceOrPlaceholder[];
  orientation: 'right' | 'bottom';
  pinnedSet: Set<string>;
  onTogglePin: (id: string) => void;
}

/**
 * The thumbnails beside the stage. Shows `STRIP_CAPACITY` at a time and scrolls for
 * the rest — the same windowing as the grid, so tiles scrolled out of the strip stop
 * costing bandwidth too.
 *
 * Scrolling rather than swapping people in and out means the strip never rearranges
 * itself under the user, and everyone stays reachable.
 */
function FilmStrip({ tracks, orientation, pinnedSet, onTogglePin }: StripProps) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(scrollEl);
  const isVertical = orientation === 'right';

  // Vertical: the scroll axis is height, so tile height is what makes exactly
  // STRIP_CAPACITY fit, and tile width follows from the column width.
  // Horizontal: the strip's height is fixed by its class, so tile height comes from
  // the cross axis and the width follows the aspect ratio — sizing it off the scroll
  // axis instead would produce tiles taller than the strip.
  const contentH = Math.max(1, height - TILE_GAP * 2);
  const contentW = Math.max(1, width - TILE_GAP * 2);
  const tileH = isVertical
    ? Math.max(1, Math.floor((contentH - TILE_GAP * (STRIP_CAPACITY - 1)) / STRIP_CAPACITY))
    : contentH;
  const tileW = isVertical ? contentW : Math.max(1, Math.floor(tileH * TILE_RATIO));

  const win = useScrollWindow(scrollEl, {
    pitch: (isVertical ? tileH : tileW) + TILE_GAP,
    perRow: 1,
    count: tracks.length,
    viewport: isVertical ? height : width,
    axis: isVertical ? 'y' : 'x',
  });

  const orderedIds = useMemo(() => tracks.map(tileId), [tracks]);
  const liveIds = useLiveTileIds(orderedIds, win);

  if (tracks.length === 0) return null;

  return (
    <div
      ref={setScrollEl}
      className={
        isVertical
          ? 'shrink-0 h-full w-[clamp(140px,18%,220px)] overflow-y-auto overflow-x-hidden'
          : 'shrink-0 w-full h-28 overflow-x-auto overflow-y-hidden'
      }
      style={{ scrollbarGutter: 'stable' }}
    >
      <div
        className={isVertical ? 'flex flex-col' : 'flex flex-row'}
        style={{ gap: `${TILE_GAP}px`, padding: `${TILE_GAP}px` }}
      >
        {tracks.map((track) => {
          const id = tileId(track);
          return (
            <div
              key={id}
              className="relative shrink-0"
              style={{ width: `${tileW}px`, height: `${tileH}px` }}
            >
              <CustomParticipantTile
                trackRef={track}
                revisionKey={trackRevisionKey(track)}
                renderVideo={liveIds.has(id)}
                isPinned={pinnedSet.has(id)}
                onTogglePin={onTogglePin}
                density="compact"
                className="w-full h-full"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface StageTileProps {
  track: TrackReferenceOrPlaceholder;
  isPinned: boolean;
  onTogglePin: (id: string) => void;
}

/**
 * One large tile. Screen shares additionally get local zoom/pan, so a viewer can
 * magnify small text in a shared window without the presenter changing anything.
 */
function StageTile({ track, isPinned, onTogglePin }: StageTileProps) {
  const zoomEnabled = isTrackReference(track) && track.source === Track.Source.ScreenShare;
  // Destructured rather than held as an object: passing a member of it straight
  // into `ref=` makes the lint rule treat every other member access as a ref read.
  const {
    setContainer, zoom, onFitChange, handlers,
    isZoomed, isDragging, zoomIn, zoomOut, reset, percent,
  } = useZoomPan(zoomEnabled);

  return (
    <div className="relative min-w-0 min-h-0 w-full h-full">
      <div
        ref={setContainer}
        className="absolute inset-0 overflow-hidden"
        style={{
          touchAction: zoomEnabled ? 'none' : undefined,
          cursor: isZoomed ? (isDragging ? 'grabbing' : 'grab') : undefined,
        }}
        {...(zoomEnabled ? handlers : {})}
      >
        <CustomParticipantTile
          trackRef={track}
          revisionKey={trackRevisionKey(track)}
          isPinned={isPinned}
          onTogglePin={onTogglePin}
          zoom={zoom}
          onFitChange={zoomEnabled ? onFitChange : undefined}
          className="w-full h-full"
        />
      </div>

      {zoomEnabled && (
        <div className="absolute bottom-2 right-2 z-20 flex items-center gap-1 rounded-xl border border-gray-700/80 bg-gray-950/85 p-1 backdrop-blur-md">
          <button
            type="button"
            onClick={zoomOut}
            title="縮小"
            className="rounded-lg p-1.5 text-gray-200 transition-colors hover:bg-gray-800 active:scale-95"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="min-w-[3ch] text-center text-[10px] font-bold tabular-nums text-gray-300">
            {percent}%
          </span>
          <button
            type="button"
            onClick={zoomIn}
            title="拡大"
            className="rounded-lg p-1.5 text-gray-200 transition-colors hover:bg-gray-800 active:scale-95"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          {isZoomed && (
            <button
              type="button"
              onClick={reset}
              title="等倍に戻す"
              className="rounded-lg p-1.5 text-indigo-300 transition-colors hover:bg-gray-800 active:scale-95"
            >
              <Minimize2 className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface StageLayoutViewProps {
  stageTracks: TrackReferenceOrPlaceholder[];
  stripTracks: TrackReferenceOrPlaceholder[];
  pinned: string[];
  onTogglePin: (id: string) => void;
}

/**
 * Speaker view's shell: a stage on the left/top, a film strip on the right/bottom.
 *
 * What lands on the stage is decided by the caller (`useCallLayout`) — every pinned
 * tile if any are pinned, otherwise the one auto-selected speaker. Pinning is not a
 * separate view; it just changes what this same shell puts on the stage.
 *
 * The strip sits on the right, not the left as LiveKit's `CarouselLayout` puts it.
 */
export default function StageLayoutView({
  stageTracks,
  stripTracks,
  pinned,
  onTogglePin,
}: StageLayoutViewProps) {
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(rootEl);
  // Measured directly rather than derived from the root minus an assumed strip width:
  // the strip is sized by CSS `clamp()`, and flexbox is the only thing that actually
  // knows what the stage ended up with.
  const stage = useElementSize(stageEl);

  // Measured on the container, never the viewport: opening the chat sidebar takes
  // 320-384px off this area without changing `100vw`, so Tailwind's `sm:`/`md:`
  // breakpoints would report a width the video area doesn't have.
  const orientation: 'right' | 'bottom' =
    width > 0 && width < STRIP_ORIENTATION_WIDTH ? 'bottom' : 'right';
  const isVertical = orientation === 'right';

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  // Same geometry helper as the grid, so 1 pinned tile fills the stage, 2 sit side by
  // side, 3-4 form a 2x2, and larger counts keep tiling with no extra code.
  const stageGeometry = useMemo(
    () =>
      computeGridGeometry({
        count: stageTracks.length,
        width: Math.max(1, stage.width - TILE_GAP * 2),
        height: Math.max(1, stage.height - TILE_GAP * 2),
        maxVisible: Math.max(1, stageTracks.length),
        minTileW: 80,
        minTileH: 60,
      }),
    [stageTracks.length, stage.width, stage.height],
  );

  return (
    <div
      ref={setRootEl}
      className={`w-full h-full min-h-0 min-w-0 flex ${isVertical ? 'flex-row' : 'flex-col'}`}
    >
      <div ref={setStageEl} className="flex-1 min-w-0 min-h-0 relative">
        <div
          className="absolute inset-0 grid place-content-center"
          style={{
            gridTemplateColumns: `repeat(${stageGeometry.cols}, ${stageGeometry.tileW}px)`,
            gridAutoRows: `${stageGeometry.rowH}px`,
            gap: `${TILE_GAP}px`,
            padding: `${TILE_GAP}px`,
          }}
        >
          {stageTracks.map((track) => (
            <StageTile
              key={tileId(track)}
              track={track}
              isPinned={pinnedSet.has(tileId(track))}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      </div>

      <FilmStrip
        tracks={stripTracks}
        orientation={orientation}
        pinnedSet={pinnedSet}
        onTogglePin={onTogglePin}
      />
    </div>
  );
}
