import { memo, useState } from 'react';
import {
  AudioTrack,
  ConnectionQualityIndicator,
  ParticipantName,
  ParticipantPlaceholder,
  ParticipantTile,
  ScreenShareIcon,
  TrackMutedIndicator,
  isTrackReference,
  useEnsureTrackRef,
  type ParticipantTileProps,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { Pin, PinOff } from 'lucide-react';
import ClampedVideoTrack, { type FitBox, type ZoomTransform } from './ClampedVideoTrack';
import { tileId } from './tileIdentity';

/**
 * `data-lk-speaking` border/ring/shadow should stay off while the mic is muted
 * (speaking indicator would be misleading). Shared by both tile wrappers below.
 */
function micMutedTileClassName(trackReference: TrackReferenceOrPlaceholder) {
  const participant = trackReference.participant;
  const micPub = participant?.getTrackPublication(Track.Source.Microphone);
  const isMicMuted = !micPub || micPub.isMuted || !micPub.isSubscribed;
  return isMicMuted
    ? '[&[data-lk-speaking="true"]]:!border-transparent [&[data-lk-speaking="true"]]:!ring-0 [&[data-lk-speaking="true"]]:!shadow-none'
    : '';
}

export interface TileDisplayProps {
  /**
   * When false the `<video>` is not rendered at all and the avatar placeholder takes
   * its place. This is how the windowed layouts stop paying for off-screen
   * participants: with no element attached, LiveKit's `adaptiveStream` pauses the
   * track at the SFU, so the media genuinely stops flowing.
   *
   * Deliberately not `publication.setSubscribed(false)` — a real resubscribe needs
   * renegotiation and would stall visibly every time you scroll.
   */
  renderVideo?: boolean;
  /** Show a pin button. `onTogglePin` receives the tile's `tileId`. */
  isPinned?: boolean;
  onTogglePin?: (id: string) => void;
  /** Local zoom/pan. Only passed for screen shares on a stage. */
  zoom?: ZoomTransform;
  onFitChange?: (fit: FitBox) => void;
  /** `compact` shrinks the avatar and drops the connection indicator, for strips. */
  density?: 'normal' | 'compact';
}

/**
 * The actual visual content of a tile (video/audio, camera-off avatar, name/mute
 * bar, pin toggle) — deliberately NOT wrapped in LiveKit's `<ParticipantTile>`.
 * `<ParticipantTile>` already renders `children ?? <its own default video>`, so a
 * component meant to be used as its children must not wrap itself in a second
 * `<ParticipantTile>`. `CustomParticipantTile` below does that wrapping.
 * (Nesting two `<ParticipantTile>`s here previously caused the focused tile to
 * double-mount its `<video>` element and briefly render solid black.)
 */
export function ParticipantTileContent({
  trackRef,
  renderVideo = true,
  isPinned = false,
  onTogglePin,
  zoom,
  onFitChange,
  density = 'normal',
}: { trackRef: TrackReferenceOrPlaceholder } & TileDisplayProps) {
  const trackReference = useEnsureTrackRef(trackRef);
  const participant = trackReference.participant;
  const isVideo =
    isTrackReference(trackReference) &&
    (trackReference.publication?.kind === 'video' ||
      trackReference.source === Track.Source.Camera ||
      trackReference.source === Track.Source.ScreenShare);
  const isScreenShare = trackReference.source === Track.Source.ScreenShare;

  let avatarUrl: string | null = null;
  if (participant?.metadata) {
    try {
      const parsed = JSON.parse(participant.metadata);
      avatarUrl = parsed.avatar_url || null;
    } catch {
      // Metadata is participant-controlled; unparseable just means no avatar.
    }
  }

  const [imgError, setImgError] = useState(false);

  const showVideo = isVideo && renderVideo;
  const isCameraOff =
    !showVideo || trackReference.publication?.isMuted || !trackReference.publication?.isSubscribed;
  // A live screen share never shows the avatar, but a windowed-out one must — the
  // alternative is a black rectangle.
  const showPlaceholder = isCameraOff && (!isScreenShare || !renderVideo);

  if (participant?.isLocal && trackReference.source === Track.Source.Camera) {
    console.log('[ParticipantTileContent] local camera tile', {
      isVideo,
      showVideo,
      isMuted: trackReference.publication?.isMuted,
      isSubscribed: trackReference.publication?.isSubscribed,
      hasPublication: !!trackReference.publication,
      isCameraOff,
      showPlaceholder,
    });
  }

  const avatarSize =
    density === 'compact'
      ? 'w-12 h-12 sm:w-14 sm:h-14'
      : 'w-20 h-20 sm:w-24 sm:h-24 md:w-28 md:h-28';

  return (
    <>
      {showVideo && (
        <ClampedVideoTrack
          trackRef={trackReference}
          isLocalMirror={participant.isLocal && !isScreenShare}
          zoom={zoom}
          onFitChange={onFitChange}
        />
      )}
      {!isVideo && isTrackReference(trackReference) && <AudioTrack trackRef={trackReference} />}

      {/* Camera Off / windowed-out placeholder.
          NOT `lk-participant-placeholder`: that class is `opacity: 0` unless the tile
          also carries `data-lk-video-muted=true`, which LiveKit only sets when the
          track is genuinely muted. A windowed-out tile whose camera is *on* would
          therefore render a fully transparent placeholder over a black tile. */}
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-[var(--lk-bg2)] rounded-lg">
          {avatarUrl && !imgError ? (
            <div
              className={`${avatarSize} rounded-3xl overflow-hidden border-2 border-slate-700/80 shadow-2xl bg-slate-800 flex items-center justify-center animate-in fade-in zoom-in-95 duration-200`}
            >
              <img
                src={avatarUrl}
                alt={participant.name || participant.identity}
                className="w-full h-full object-cover"
                onError={() => setImgError(true)}
              />
            </div>
          ) : (
            // `ParticipantPlaceholder`'s SVG hardcodes width={320} height={320} as
            // literal element attributes. LiveKit's own CSS normally overrides that
            // via `.lk-participant-placeholder svg { width: auto; height: 100% }`, a
            // rule that only matches that exact class name — which the wrapper above
            // deliberately doesn't carry (see the comment on it) — and depends on the
            // browser preferring CSS over SVG presentation attributes, which is not
            // guaranteed everywhere. Passing `width`/`height` as props instead lands
            // directly in the element's attribute object (the component spreads its
            // props there, after the 320 defaults), which unconditionally wins.
            // `preserveAspectRatio="xMidYMid meet"` (already set internally) keeps the
            // icon's own 1:1 shape centered and unstretched inside this 100% box even
            // though the box itself may not be square.
            <div className="w-full h-full p-[10%]">
              <ParticipantPlaceholder width="100%" height="100%" />
            </div>
          )}
        </div>
      )}

      {/* Metadata Bar (Name + Mute indicator) */}
      <div className="lk-participant-metadata">
        <div className="lk-participant-metadata-item">
          {!isScreenShare ? (
            <>
              <TrackMutedIndicator
                trackRef={{
                  participant: trackReference.participant,
                  source: Track.Source.Microphone,
                }}
                show="muted"
              />
              <ParticipantName />
            </>
          ) : (
            <>
              <ScreenShareIcon style={{ marginRight: '0.25rem' }} />
              <ParticipantName>&apos;s screen</ParticipantName>
            </>
          )}
        </div>
        {density === 'normal' && (
          <ConnectionQualityIndicator className="lk-participant-metadata-item" />
        )}
      </div>

      {/* Replaces LiveKit's <FocusToggle>, which can only ever pin one track.
          Reusing `lk-focus-toggle-button` inherits its top-right placement and
          fade-in-on-hover; `!opacity-100` overrides the class's `opacity: 0` so an
          already-pinned tile keeps showing its badge without hovering. */}
      {onTogglePin && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(tileId(trackReference));
          }}
          title={isPinned ? 'ピン留めを解除' : 'ピン留め'}
          aria-pressed={isPinned}
          className={`lk-focus-toggle-button ${isPinned ? '!opacity-100 text-indigo-300' : ''}`}
        >
          {isPinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
        </button>
      )}
    </>
  );
}

export type CustomParticipantTileProps = ParticipantTileProps &
  TileDisplayProps & {
    /**
     * Snapshot from `trackRevisionKey()`, passed by the caller (`GridLayoutView`,
     * `StageLayoutView`). Required for the memo below to work — see its comment.
     */
    revisionKey?: string;
  };

/**
 * Grid/strip/stage tile: wraps `ParticipantTileContent` in LiveKit's
 * `<ParticipantTile>`, which supplies `.lk-participant-tile` (position: relative,
 * the speaking ring, and the `data-lk-*` attributes the stylesheet keys off).
 *
 * Memoized because a full-size grid re-renders on every `ActiveSpeakersChanged`,
 * which in a busy room is several times a second. The speaking ring still animates:
 * `<ParticipantTile>` subscribes to speaking state internally rather than receiving
 * it as a prop.
 */
function CustomParticipantTileImpl({
  trackRef,
  renderVideo,
  isPinned,
  onTogglePin,
  zoom,
  onFitChange,
  density,
  // Destructured out (not rendered) purely so it doesn't get spread onto the
  // underlying DOM node below — only `tilePropsEqual` reads it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  revisionKey,
  ...htmlProps
}: CustomParticipantTileProps) {
  const trackReference = useEnsureTrackRef(trackRef);

  return (
    <ParticipantTile
      trackRef={trackReference}
      {...htmlProps}
      className={`${micMutedTileClassName(trackReference)} ${htmlProps.className || ''}`}
    >
      <ParticipantTileContent
        trackRef={trackReference}
        renderVideo={renderVideo}
        isPinned={isPinned}
        onTogglePin={onTogglePin}
        zoom={zoom}
        onFitChange={onFitChange}
        density={density}
      />
    </ParticipantTile>
  );
}

/**
 * `useTracks` rebuilds its `{participant, publication, source}` objects on every room
 * event, so a plain `memo` would never hit: the `trackRef` prop is always a new
 * object. Comparing what the tile actually renders from is what makes memoization
 * real — without it a 40-tile grid re-renders wholesale several times a second in a
 * busy room.
 *
 * Mute state, subscription state and native dimensions are compared via
 * `revisionKey` — a plain string the caller snapshots fresh each render — rather
 * than by reaching into `trackRef.publication` here. LiveKit mutates a
 * `TrackPublication` in place on mute/unmute instead of replacing it, so
 * `trackRef.publication` is the *same object* before and after the change; reading
 * `.isMuted` off it in this comparator would just read the current (post-mutation)
 * value on both sides and always call it "unchanged" — camera mute would only ever
 * appear to work one render late, whenever some *other* prop happened to change too.
 * `revisionKey`, being a primitive built in the caller's render, doesn't have that
 * problem: last render's value is genuinely frozen in `prevProps`.
 *
 * The speaking ring is not compared at all because `<ParticipantTile>` subscribes
 * to that itself.
 */
function tilePropsEqual(a: CustomParticipantTileProps, b: CustomParticipantTileProps) {
  // `trackRef` is optional in LiveKit's prop type because its layout components
  // inject it by cloning. Our layouts always pass it, but if either side is missing
  // it we can't reason about equality — re-render.
  const refA = a.trackRef;
  const refB = b.trackRef;
  if (!refA || !refB) return false;

  // A caller that forgot to pass `revisionKey` gets no memo protection rather than a
  // silently-stale tile — safe by default, matching the missing-trackRef guard above.
  if (a.revisionKey === undefined || b.revisionKey === undefined) return false;

  return (
    refA.participant.identity === refB.participant.identity &&
    refA.source === refB.source &&
    refA.participant.metadata === refB.participant.metadata &&
    a.revisionKey === b.revisionKey &&
    a.renderVideo === b.renderVideo &&
    a.isPinned === b.isPinned &&
    a.onTogglePin === b.onTogglePin &&
    a.density === b.density &&
    a.className === b.className &&
    a.zoom === b.zoom &&
    a.onFitChange === b.onFitChange
  );
}

export const CustomParticipantTile = memo(CustomParticipantTileImpl, tilePropsEqual);
