import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { isTrackReference, type TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { tileId } from './tileIdentity';
import { useStableTileOrder } from './useStableTileOrder';
import { useAutoStageTrack } from './useAutoStageTrack';

export type LayoutMode = 'grid' | 'speaker';

interface LayoutState {
  mode: LayoutMode;
  /**
   * Ordered set of pinned tiles. Orthogonal to `mode`: pinning never changes which
   * layout is showing by itself. In grid view a pin just moves someone to the front;
   * in speaker view it overrides which track(s) land on the stage instead of the
   * auto-selected speaker.
   */
  pinned: string[];
  /** Shares *we* switched to speaker view for, so we know when to undo it. */
  autoShareIds: string[];
  /** Mode to restore once every auto-focused share has ended. */
  modeBeforeAutoShare: LayoutMode | null;
  /** Set once the user explicitly picks a mode during a share episode. */
  userOverrode: boolean;
}

type Action =
  | { type: 'set_mode'; mode: LayoutMode }
  | { type: 'toggle_pin'; id: string }
  | { type: 'auto_focus_share'; id: string }
  | { type: 'sync_tracks'; presentIds: string[] };

const initialState: LayoutState = {
  mode: 'grid',
  pinned: [],
  autoShareIds: [],
  modeBeforeAutoShare: null,
  userOverrode: false,
};

function reducer(state: LayoutState, action: Action): LayoutState {
  switch (action.type) {
    case 'set_mode': {
      if (action.mode === state.mode) return state;
      return { ...state, mode: action.mode, userOverrode: true };
    }

    case 'toggle_pin': {
      // Deliberately does not touch `mode`: pinning in grid view reorders, it doesn't
      // spotlight, and pinning in speaker view swaps the stage without leaving
      // speaker view — either way the current layout stays put.
      const pinned = state.pinned.includes(action.id)
        ? state.pinned.filter((id) => id !== action.id)
        : [...state.pinned, action.id];
      return { ...state, pinned };
    }

    case 'auto_focus_share': {
      // Once the user has made a mode choice during this share episode, never steal
      // focus again — including for a second share that starts later.
      if (state.userOverrode) return state;
      if (state.autoShareIds.includes(action.id)) return state;

      return {
        ...state,
        mode: 'speaker',
        autoShareIds: [...state.autoShareIds, action.id],
        modeBeforeAutoShare: state.modeBeforeAutoShare ?? state.mode,
        // Deliberately left false: an auto-focus is not a user choice.
        userOverrode: false,
      };
    }

    case 'sync_tracks': {
      const present = new Set(action.presentIds);

      const pinned = state.pinned.filter((id) => present.has(id));
      const autoShareIds = state.autoShareIds.filter((id) => present.has(id));

      let mode = state.mode;
      let modeBeforeAutoShare = state.modeBeforeAutoShare;
      let userOverrode = state.userOverrode;

      // Every share we auto-focused has ended.
      if (state.autoShareIds.length > 0 && autoShareIds.length === 0) {
        if (!userOverrode && modeBeforeAutoShare) mode = modeBeforeAutoShare;
        modeBeforeAutoShare = null;
        // Reset so the *next* share is allowed to auto-focus again.
        userOverrode = false;
      }

      const unchanged =
        mode === state.mode &&
        modeBeforeAutoShare === state.modeBeforeAutoShare &&
        userOverrode === state.userOverrode &&
        pinned.length === state.pinned.length &&
        autoShareIds.length === state.autoShareIds.length;
      if (unchanged) return state;

      return { mode, pinned, autoShareIds, modeBeforeAutoShare, userOverrode };
    }

    default:
      return state;
  }
}

export interface CallLayout {
  mode: LayoutMode;
  setMode: (mode: LayoutMode) => void;
  pinned: string[];
  togglePin: (id: string) => void;
  /** All tiles, pinned ones first, otherwise in stable join order. What grid view renders. */
  gridTracks: TrackReferenceOrPlaceholder[];
  /** The large tile(s) in speaker view: every pinned tile, or one auto-selected speaker. */
  stageTracks: TrackReferenceOrPlaceholder[];
  /** Everyone not on the stage, with the current speaker floated to the front. */
  stripTracks: TrackReferenceOrPlaceholder[];
}

/**
 * Owns which layout is showing, which tiles are pinned, and screen-share
 * auto-focus, and partitions the room's tracks accordingly.
 *
 * There is no separate "pin view": pinning is orthogonal to the grid/speaker choice
 * (see `toggle_pin` above). Replaces LiveKit's `LayoutContext` pin mechanism
 * entirely — that one holds a single pinned track, and its `<FocusToggle>` is the
 * only way to set it. Note `usePinnedTracks` must not be left behind anywhere —
 * unlike `<FocusToggle>`, which degrades quietly, it calls `useEnsureLayoutContext`
 * and throws without a provider.
 */
export function useCallLayout(
  tracks: TrackReferenceOrPlaceholder[],
  localIdentity: string | undefined,
): CallLayout {
  const [state, dispatch] = useReducer(reducer, initialState);

  const stableTracks = useStableTileOrder(tracks);
  // Computed unconditionally (not just in speaker view): also drives strip
  // promotion below, and using the same hook in both roles keeps the "who is
  // speaking" answer identical whether or not they currently happen to be staged.
  const autoStageTrack = useAutoStageTrack(stableTracks, { localIdentity });

  const pinnedSet = useMemo(() => new Set(state.pinned), [state.pinned]);

  // Pinned tiles move to the front so grid view can show them first without
  // resizing anything; unpinned tiles keep their stable relative order.
  const gridTracks = useMemo(() => {
    if (pinnedSet.size === 0) return stableTracks;
    const pinnedTracks = stableTracks.filter((t) => pinnedSet.has(tileId(t)));
    const rest = stableTracks.filter((t) => !pinnedSet.has(tileId(t)));
    return [...pinnedTracks, ...rest];
  }, [stableTracks, pinnedSet]);

  // Both effects key on a joined string and read the array from that same render, so
  // they only fire when membership actually changes — `useTracks` hands back a fresh
  // array on every room event.
  const presentIds = useMemo(() => stableTracks.map(tileId), [stableTracks]);
  const shareIds = useMemo(
    () =>
      stableTracks
        .filter(
          (t) =>
            isTrackReference(t) &&
            t.source === Track.Source.ScreenShare &&
            // Matches the previous behaviour: a local share counts immediately, a
            // remote one only once actually subscribed.
            (t.publication.isSubscribed || t.participant.isLocal),
        )
        .map(tileId),
    [stableTracks],
  );

  const presentKey = presentIds.join(' ');
  const shareKey = shareIds.join(' ');

  // Prune pins for participants who left, and unwind auto-focus when shares end.
  useEffect(() => {
    dispatch({ type: 'sync_tracks', presentIds });
    // Keyed on the joined ids rather than the array, which is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentKey]);

  useEffect(() => {
    for (const id of shareIds) {
      dispatch({ type: 'auto_focus_share', id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareKey]);

  const setMode = useCallback((mode: LayoutMode) => {
    dispatch({ type: 'set_mode', mode });
  }, []);

  const togglePin = useCallback((id: string) => {
    dispatch({ type: 'toggle_pin', id });
  }, []);

  const { stageTracks, stripTracks } = useMemo(() => {
    if (state.mode === 'grid') {
      return { stageTracks: [], stripTracks: [] };
    }

    const byId = new Map(stableTracks.map((t) => [tileId(t), t]));

    const stage =
      state.pinned.length > 0
        ? state.pinned
            .map((id) => byId.get(id))
            .filter((t): t is TrackReferenceOrPlaceholder => t !== undefined)
        : autoStageTrack
          ? [autoStageTrack]
          : [];

    const stageIds = new Set(stage.map(tileId));
    const rest = stableTracks.filter((t) => !stageIds.has(tileId(t)));

    // Surface whoever is currently talking at the top of the strip, even when
    // they're not staged — e.g. pinned people are on stage, but you still want to
    // glance over and see who's actually speaking right now. The promotion follows
    // `autoStageTrack`, which already only moves after 1.2s of holding the floor, so
    // this doesn't jitter the strip on every "うん".
    if (!autoStageTrack) return { stageTracks: stage, stripTracks: rest };
    const speakerId = tileId(autoStageTrack);
    const speakerIndex = rest.findIndex((t) => tileId(t) === speakerId);
    if (speakerIndex <= 0) return { stageTracks: stage, stripTracks: rest };

    const promoted = rest[speakerIndex];
    const reordered = [promoted, ...rest.slice(0, speakerIndex), ...rest.slice(speakerIndex + 1)];
    return { stageTracks: stage, stripTracks: reordered };
  }, [state.mode, state.pinned, stableTracks, autoStageTrack]);

  return {
    mode: state.mode,
    setMode,
    pinned: state.pinned,
    togglePin,
    gridTracks,
    stageTracks,
    stripTracks,
  };
}
