import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isTrackReference,
  useSpeakingParticipants,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track } from 'livekit-client';

/**
 * How long someone must hold the floor before the stage swaps to them.
 *
 * Without this the stage flips on every "うん" and back-channel noise, which is the
 * single most distracting thing a speaker view can do. 1.2s is long enough to ignore
 * interjections and short enough that a real handover still feels immediate.
 */
const SPEAKER_HOLD_MS = 1200;

export interface AutoStageOptions {
  /** Identity of the local participant, so the stage never follows your own voice. */
  localIdentity?: string;
  /** Set false to ignore screen shares (the PiP window shows its own share separately). */
  preferScreenShare?: boolean;
  holdMs?: number;
}

/**
 * Picks the single track that belongs on the stage in speaker view.
 *
 * Priority ladder:
 *   1. a screen share (remote before local) — someone presenting outranks anyone talking
 *   2. the dominant remote speaker, once they've held the floor for `holdMs`
 *   3. whoever last satisfied (2), so a pause doesn't blank the stage
 *   4. the first remote participant
 *   5. the local participant, for the case of being alone in the room
 *
 * Never stages the local participant while anyone else is present: watching yourself
 * fill the screen because you spoke is uniformly disliked.
 */
export function useAutoStageTrack(
  tracks: TrackReferenceOrPlaceholder[],
  { localIdentity, preferScreenShare = true, holdMs = SPEAKER_HOLD_MS }: AutoStageOptions = {},
): TrackReferenceOrPlaceholder | null {
  const speakingParticipants = useSpeakingParticipants();
  const [heldSpeakerId, setHeldSpeakerId] = useState<string | null>(null);

  // The candidate currently accumulating floor time, and when they started.
  const pendingRef = useRef<{ id: string; since: number } | null>(null);

  const dominantRemoteId =
    speakingParticipants.find((p) => p.identity !== localIdentity)?.identity ?? null;

  useEffect(() => {
    if (!dominantRemoteId) {
      // Silence doesn't reset the held speaker — the stage stays where it was.
      pendingRef.current = null;
      return;
    }

    if (dominantRemoteId === heldSpeakerId) {
      pendingRef.current = null;
      return;
    }

    const now = Date.now();
    if (pendingRef.current?.id !== dominantRemoteId) {
      pendingRef.current = { id: dominantRemoteId, since: now };
    }

    // Always go through the timer, never a synchronous setState: speaking state can
    // stay unchanged for longer than the hold window, so the next render is not
    // guaranteed to re-check, and promoting inline would cascade an extra render on
    // every speaker event.
    const remaining = Math.max(0, holdMs - (now - pendingRef.current.since));
    const timer = window.setTimeout(() => {
      if (pendingRef.current?.id === dominantRemoteId) {
        setHeldSpeakerId(dominantRemoteId);
        pendingRef.current = null;
      }
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [dominantRemoteId, heldSpeakerId, holdMs]);

  return useMemo(() => {
    if (tracks.length === 0) return null;

    if (preferScreenShare) {
      const shares = tracks.filter(
        (t) => isTrackReference(t) && t.source === Track.Source.ScreenShare,
      );
      const remoteShare = shares.find((t) => t.participant.identity !== localIdentity);
      if (remoteShare) return remoteShare;
      if (shares.length > 0) return shares[0];
    }

    if (heldSpeakerId) {
      const held = tracks.find(
        (t) => t.participant.identity === heldSpeakerId && t.source === Track.Source.Camera,
      );
      if (held) return held;
    }

    const firstRemote = tracks.find((t) => t.participant.identity !== localIdentity);
    if (firstRemote) return firstRemote;

    return tracks[0];
  }, [tracks, heldSpeakerId, localIdentity, preferScreenShare]);
}
