import { useMemo, useState } from 'react';
import { type TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { CustomParticipantTile } from './ParticipantTileContent';
import { computeGridGeometry, useElementSize } from './geometry';
import { useLiveTileIds, useScrollWindow } from './useScrollWindow';
import {
  MAX_LIVE_TILES,
  MAX_LIVE_TILES_NARROW,
  NARROW_WIDTH,
  TILE_GAP,
  tileId,
  trackRevisionKey,
} from './tileIdentity';

export interface GridLayoutViewProps {
  /** Expected pre-ordered with pinned tiles first — see `useCallLayout`'s `gridTracks`. */
  tracks: TrackReferenceOrPlaceholder[];
  pinned: string[];
  onTogglePin: (id: string) => void;
}

/**
 * The default view: every participant in a uniform grid.
 *
 * Pinning someone here does not enlarge their tile — a mixed-size grid would break
 * the uniform-row math the virtualization in this file depends on. It moves them to
 * the front instead (`tracks` arrives pre-ordered that way). Actually making someone
 * big is what speaker view's stage is for.
 *
 * Up to `MAX_LIVE_TILES` everyone fits and nothing scrolls, exactly as before. Past
 * that the tiles stop shrinking and extra rows overflow into an ordinary scroll —
 * deliberately *not* pagination, which reads as tiles being swapped underneath you
 * rather than as moving through a list.
 *
 * Only tiles inside the scroll viewport (plus a row of lookahead) render a `<video>`;
 * the rest render their avatar. With no element attached, `adaptiveStream` pauses
 * those tracks at the SFU, so the number of streams a viewer actually receives stays
 * flat no matter how many people join.
 */
export default function GridLayoutView({ tracks, pinned, onTogglePin }: GridLayoutViewProps) {
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(scrollEl);

  const maxVisible = width > 0 && width < NARROW_WIDTH ? MAX_LIVE_TILES_NARROW : MAX_LIVE_TILES;

  const geometry = useMemo(
    () => computeGridGeometry({ count: tracks.length, width, height, maxVisible }),
    [tracks.length, width, height, maxVisible],
  );

  const win = useScrollWindow(scrollEl, {
    pitch: geometry.pitch,
    perRow: geometry.cols,
    count: tracks.length,
    viewport: height,
  });

  const orderedIds = useMemo(() => tracks.map(tileId), [tracks]);
  const liveIds = useLiveTileIds(orderedIds, win);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);

  // Centre a partial final row instead of leaving it left-aligned under a full grid.
  const lastRowStart = (geometry.totalRows - 1) * geometry.cols;
  const lastRowCount = tracks.length - lastRowStart;

  return (
    <div
      ref={setScrollEl}
      className="w-full h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden"
      // `scrollbarGutter: stable` is required, not cosmetic: without it the scrollbar
      // appearing narrows the container, which can re-flow the grid into fitting,
      // which removes the scrollbar again — an endless ResizeObserver loop.
      style={{ scrollbarGutter: 'stable' }}
    >
      <div
        style={{
          display: 'grid',
          justifyContent: 'center',
          alignContent: 'start',
          gridTemplateColumns: `repeat(${geometry.cols}, ${geometry.tileW}px)`,
          gridAutoRows: `${geometry.rowH}px`,
          gap: `${TILE_GAP}px`,
          padding: `${TILE_GAP}px`,
        }}
      >
        {tracks.map((track, index) => {
          const id = tileId(track);
          const isLastRowFirst = index === lastRowStart && lastRowCount < geometry.cols;

          return (
            <div
              key={id}
              className="relative min-w-0 min-h-0"
              style={
                isLastRowFirst
                  ? { gridColumnStart: 1 + Math.floor((geometry.cols - lastRowCount) / 2) }
                  : undefined
              }
            >
              <CustomParticipantTile
                trackRef={track}
                revisionKey={trackRevisionKey(track)}
                renderVideo={liveIds.has(id)}
                isPinned={pinnedSet.has(id)}
                onTogglePin={onTogglePin}
                className="w-full h-full"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
