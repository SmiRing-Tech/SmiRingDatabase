import { useEffect, useMemo, useState } from 'react';
import { type TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { tileId } from './tileIdentity';

/**
 * Deterministic ordering for tiles the first time we see them. After that
 * `useStableTileOrder` freezes their position, so this only decides where a *newly
 * joined* participant lands relative to other newcomers in the same batch.
 */
function seedOrder(a: TrackReferenceOrPlaceholder, b: TrackReferenceOrPlaceholder) {
  const shareRank = (t: TrackReferenceOrPlaceholder) =>
    t.source === Track.Source.ScreenShare ? 0 : 1;
  if (shareRank(a) !== shareRank(b)) return shareRank(a) - shareRank(b);

  const localRank = (t: TrackReferenceOrPlaceholder) => (t.participant.isLocal ? 0 : 1);
  if (localRank(a) !== localRank(b)) return localRank(a) - localRank(b);

  const joined = (t: TrackReferenceOrPlaceholder) => t.participant.joinedAt?.getTime() ?? 0;
  if (joined(a) !== joined(b)) return joined(a) - joined(b);

  return tileId(a).localeCompare(tileId(b));
}

/**
 * Orders tiles by join order and *keeps them there*.
 *
 * Tiles only ever move when someone joins (appended at the end) or leaves (removed
 * in place). Speaking, muting and toggling a camera never reorder anything.
 *
 * This is a deliberate departure from LiveKit's own `useVisualStableUpdate` /
 * `sortTrackReferences`, which sort by `isSpeaking` / `audioLevel` / `lastSpokeAt` to
 * pull active speakers onto the first page. That behaviour exists to serve
 * pagination; with a scrollable grid it buys nothing and costs the one thing users
 * notice most — tiles jumping around mid-conversation.
 */
export function useStableTileOrder(
  tracks: TrackReferenceOrPlaceholder[],
): TrackReferenceOrPlaceholder[] {
  // The *order* only changes when someone joins or leaves, so it is keyed on the set
  // of ids rather than on the array identity — `useTracks` hands back a fresh array
  // on every room event.
  const idKey = useMemo(() => tracks.map(tileId).sort().join(' '), [tracks]);

  // Seeded from the first render's tracks so the very first paint is already ordered
  // rather than empty.
  const [orderedIds, setOrderedIds] = useState<string[]>(() =>
    [...tracks].sort(seedOrder).map(tileId),
  );

  useEffect(() => {
    setOrderedIds((prev) => {
      const ids = new Set(tracks.map(tileId));
      const kept = prev.filter((id) => ids.has(id));
      const keptSet = new Set(kept);
      const added = tracks
        .filter((t) => !keptSet.has(tileId(t)))
        .sort(seedOrder)
        .map(tileId);

      if (added.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...added];
    });
    // `tracks` is deliberately not a dependency: it is a fresh array on every room
    // event, and the value captured when `idKey` changes is exactly the current one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKey]);

  // Resolved separately, and on every render: a tile keeps its id when its
  // placeholder resolves into a real published track, so the ids can be unchanged
  // while the references behind them are not. Caching this alongside the order would
  // pin tiles to their stale placeholder and the video would never appear.
  return useMemo(() => {
    const byId = new Map(tracks.map((t) => [tileId(t), t]));
    return orderedIds
      .map((id) => byId.get(id))
      .filter((t): t is TrackReferenceOrPlaceholder => t !== undefined);
  }, [orderedIds, tracks]);
}
