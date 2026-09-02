import { isTrackReference, type TrackReferenceOrPlaceholder } from '@livekit/components-react';

/**
 * Stable identity for a video tile.
 *
 * Deliberately NOT `getTrackReferenceId()` from @livekit/components-core: that one
 * embeds `publication.trackSid`, which changes every time a track is republished
 * (turning a camera off and on again does exactly that). Keying pins or React
 * elements on it means a pinned participant silently falls out of the pin set — and
 * their tile fully remounts — the moment they toggle their camera.
 *
 * identity + source is stable across republishes, and is also identical for the
 * placeholder and the real track reference of the same participant, so a tile keeps
 * its identity while a camera is still connecting.
 */
export const tileId = (t: TrackReferenceOrPlaceholder) =>
  `${t.participant.identity}::${t.source}`;

/**
 * A plain-string snapshot of the fields that decide what a tile actually renders
 * (mute state, subscription state, native dimensions).
 *
 * This exists only to make `CustomParticipantTile`'s `React.memo` comparator work.
 * LiveKit mutates a `TrackPublication` in place rather than replacing it on
 * mute/unmute — `trackRef.publication` is the *same object instance* before and
 * after the change — so a comparator that reads `prevProps.trackRef.publication`
 * and `nextProps.trackRef.publication` is reading the identical live object twice
 * and will always see it as "unchanged", even when it just changed. Camera mute
 * would appear to work only after some *unrelated* prop forced a re-render (e.g.
 * toggling a pin), one step behind the real state.
 *
 * A `string` doesn't have this problem: it's a primitive built fresh, in the
 * caller's render (which *does* re-run on every mute/unmute event — `useTracks`
 * isn't narrowed with `updateOnlyOn`), so the value captured in last render's props
 * is truly a snapshot of what things were then, comparable by `===` against a fresh
 * one now. Compute this once per tile in whichever component maps over `tracks`
 * (`GridLayoutView`, `StageLayoutView`'s stage and strip) and pass it down as
 * `revisionKey`.
 */
export function trackRevisionKey(t: TrackReferenceOrPlaceholder): string {
  if (!isTrackReference(t)) return 'placeholder';
  const pub = t.publication;
  return `${pub.trackSid}:${pub.isMuted}:${pub.isSubscribed}:${pub.dimensions?.width ?? ''}x${pub.dimensions?.height ?? ''}`;
}

/**
 * Upper bound on how many tiles are laid out to fill the visible grid area.
 * Participants beyond this count don't shrink the tiles any further — they overflow
 * into scrollable rows instead, and only the ones actually scrolled into view get a
 * live `<video>`.
 *
 * This is the main knob for how much SFU forwarding a single viewer costs, so it is
 * deliberately a single constant. The real ceiling depends on the viewer's CPU.
 */
export const MAX_LIVE_TILES = 20;

/**
 * Phones thermally throttle long before a laptop does, and 20 simultaneous video
 * decoders is well past what a mid-range device sustains.
 */
export const MAX_LIVE_TILES_NARROW = 8;

/** Container width (px) below which we treat the layout as narrow. */
export const NARROW_WIDTH = 640;

/** How many thumbnails the speaker/pin film strip shows before it starts scrolling. */
export const STRIP_CAPACITY = 6;

/**
 * Container width (px) below which the film strip moves from a right-hand column to
 * a strip along the bottom.
 *
 * Measured on the layout container, never the viewport: opening the chat sidebar
 * shrinks the video column by 320-384px without changing `100vw`, so Tailwind's
 * `sm:`/`md:` breakpoints report a width the video area doesn't actually have.
 */
export const STRIP_ORIENTATION_WIDTH = 720;

/** Preferred tile aspect ratio (slightly taller than 16:9 to suit portrait cameras). */
export const TILE_RATIO = 16 / 10;

/** Gap between tiles, in px. Shared by the grid and the strips. */
export const TILE_GAP = 8;
