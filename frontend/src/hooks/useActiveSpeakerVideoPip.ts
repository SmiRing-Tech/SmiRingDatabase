import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useSpeakingParticipants,
  useTracks,
  isTrackReference,
} from '@livekit/components-react';
import { Track, RoomEvent, type LocalTrack, type RemoteTrack } from 'livekit-client';

/**
 * Hook for Mobile / Video Picture-in-Picture with Active Speaker tracking.
 *
 * Provides OS-level Video PiP (HTMLVideoElement.requestPictureInPicture) that seamlessly
 * updates its underlying video source to the active speaker (or screen share) in real-time.
 */
export function useActiveSpeakerVideoPip(options?: { enableAutoPip?: boolean }) {
  // `autoPictureInPicture` should only drive the browser's native raw-video PiP on
  // devices that can't use the richer Document PiP UI (mobile/Safari). On desktop,
  // where Document PiP is supported, leaving this on causes Chromium to auto-open
  // the plain video-element PiP on tab switch — a different, mismatched UI from the
  // custom DocumentPipContent window the manual PiP button opens.
  const enableAutoPip = options?.enableAutoPip ?? true;
  const speakingParticipants = useSpeakingParticipants();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const currentAttachedTrackRef = useRef<LocalTrack | RemoteTrack | null>(null);

  const [isVideoPipActive, setIsVideoPipActive] = useState(false);

  // Check if standard Video PiP is supported
  const isVideoPipSupported =
    typeof document !== 'undefined' &&
    'pictureInPictureEnabled' in document &&
    Boolean(document.pictureInPictureEnabled);

  // Fetch all camera and screen share tracks
  const rawTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );

  // Determine the highest priority video track to stream to PiP
  // Priority: 1. Screen share -> 2. Active speaking remote participant -> 3. Any remote participant -> 4. Local camera
  const targetTrackRef = (() => {
    const validTracks = rawTracks.filter(isTrackReference);

    // 1. Screen share track (remote or local)
    const screenShare = validTracks.find(
      (t) => t.publication.source === Track.Source.ScreenShare && t.publication.track,
    );
    if (screenShare?.publication.track) {
      return screenShare;
    }

    // 2. Active speaking remote participant camera
    const activeRemoteSpeaker = speakingParticipants.find((p) => !p.isLocal);
    if (activeRemoteSpeaker) {
      const speakerTrack = validTracks.find(
        (t) =>
          t.participant.identity === activeRemoteSpeaker.identity &&
          t.publication.source === Track.Source.Camera &&
          t.publication.track &&
          !t.publication.isMuted,
      );
      if (speakerTrack?.publication.track) {
        return speakerTrack;
      }
    }

    // 3. First available remote camera track
    const remoteCam = validTracks.find(
      (t) =>
        !t.participant.isLocal &&
        t.publication.source === Track.Source.Camera &&
        t.publication.track &&
        !t.publication.isMuted,
    );
    if (remoteCam?.publication.track) {
      return remoteCam;
    }

    // 4. Local camera track fallback
    const localCam = validTracks.find(
      (t) =>
        t.participant.isLocal &&
        t.publication.source === Track.Source.Camera &&
        t.publication.track &&
        !t.publication.isMuted,
    );
    return localCam ?? null;
  })();

  const targetTrack = targetTrackRef?.publication.track as LocalTrack | RemoteTrack | undefined;

  // Latest target, readable synchronously — requestVideoPip() has to attach *before* calling
  // requestPictureInPicture() (an element with no source can't enter PiP) and can't wait for a
  // React render to do it without burning the transient user-activation window.
  // Kept in sync from an effect (not during render) and declared above the attach effect below,
  // so effect ordering guarantees it already holds this render's value by the time that one
  // runs — and event handlers, which only fire after effects have flushed, always see it fresh.
  const targetTrackLatestRef = useRef(targetTrack);
  useEffect(() => {
    targetTrackLatestRef.current = targetTrack;
  }, [targetTrack]);

  /**
   * Whether the hidden element should currently be carrying a track at all.
   *
   * This used to be unconditional, which meant that on every desktop — where `enableAutoPip` is
   * false because Document PiP is used instead (see CallRoomPage's call site) — a 1x1 offscreen
   * <video> sat in document.body playing the active speaker, or during a screen share the
   * screen-share track, for the entire call whether or not PiP was ever opened. Pure waste:
   * an extra decode target and an extra compositing surface for the single heaviest track in
   * the room, for a feature the user wasn't using.
   *
   * It stays armed when `enableAutoPip` is on, because that's the mobile/Safari path where the
   * browser itself may put the element into PiP on tab switch (the `autoPictureInPicture`
   * attribute) — that can't work if the element has no source when the moment comes.
   */
  const [pipArmed, setPipArmed] = useState(false);
  const shouldAttach = enableAutoPip || isVideoPipActive || pipArmed;

  /** Attach/detach imperatively, so both the effect below and requestVideoPip() can drive it. */
  const syncAttachment = useCallback((videoEl: HTMLVideoElement | null, attach: boolean) => {
    if (!videoEl) return;
    const next = attach ? (targetTrackLatestRef.current ?? null) : null;
    if (currentAttachedTrackRef.current === next) return;

    if (currentAttachedTrackRef.current) {
      try {
        currentAttachedTrackRef.current.detach(videoEl);
      } catch {}
      currentAttachedTrackRef.current = null;
    }
    if (next) {
      try {
        next.attach(videoEl);
        currentAttachedTrackRef.current = next;
        videoEl.play().catch(() => {});
      } catch (e) {
        console.error('[VideoPiP] Failed to attach target track:', e);
      }
    }
  }, []);

  // Initialize hidden video element for PiP
  useEffect(() => {
    if (!isVideoPipSupported) return;

    let videoEl = videoRef.current;
    if (!videoEl) {
      videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.setAttribute('playsinline', 'true');
      videoEl.setAttribute('webkit-playsinline', 'true');
      if (enableAutoPip) {
        videoEl.setAttribute('autoPictureInPicture', 'true');
      }

      // Keep it in DOM so browser doesn't garbage-collect or refuse PiP, but out of view
      videoEl.style.position = 'fixed';
      videoEl.style.top = '-9999px';
      videoEl.style.left = '-9999px';
      videoEl.style.width = '1px';
      videoEl.style.height = '1px';
      videoEl.style.opacity = '0';
      videoEl.style.pointerEvents = 'none';
      videoEl.style.zIndex = '-1';

      document.body.appendChild(videoEl);
      videoRef.current = videoEl;
    }

    const onEnterPip = () => setIsVideoPipActive(true);
    const onLeavePip = () => {
      setIsVideoPipActive(false);
      // Back to carrying nothing once the window is gone — the effect below does the actual
      // detach. Left armed where autoPictureInPicture may re-open it without a user gesture.
      if (!enableAutoPip) setPipArmed(false);
    };

    videoEl.addEventListener('enterpictureinpicture', onEnterPip);
    videoEl.addEventListener('leavepictureinpicture', onLeavePip);

    return () => {
      videoEl?.removeEventListener('enterpictureinpicture', onEnterPip);
      videoEl?.removeEventListener('leavepictureinpicture', onLeavePip);
      if (currentAttachedTrackRef.current && videoEl) {
        try {
          currentAttachedTrackRef.current.detach(videoEl);
        } catch {}
      }
      if (videoEl && videoEl.parentNode) {
        videoEl.parentNode.removeChild(videoEl);
      }
      videoRef.current = null;
    };
  }, [isVideoPipSupported, enableAutoPip]);

  // Seamlessly switch track source on the PiP video element without closing PiP — and, when
  // PiP isn't in use at all, keep the element carrying nothing (see `shouldAttach`).
  useEffect(() => {
    syncAttachment(videoRef.current, shouldAttach);
  }, [targetTrack, shouldAttach, syncAttachment]);

  // Manual request Video PiP
  const requestVideoPip = useCallback(async () => {
    const videoEl = videoRef.current;
    if (!videoEl || !isVideoPipSupported) return;

    // Arm the element for as long as PiP is in use, and attach right now rather than waiting
    // for the effect above to run on the next render: an element with no source can't enter
    // PiP, and a render round-trip would spend part of the activation window described below.
    setPipArmed(true);
    syncAttachment(videoEl, true);

    try {
      if (document.pictureInPictureElement !== videoEl) {
        // Call requestPictureInPicture() first and don't await play() before it —
        // the browser's transient user-activation window (~5s in Chromium) starts
        // ticking from the tap that triggered this handler, and awaiting play()
        // first can burn through it, silently failing the PiP request.
        videoEl.play().catch(() => {});
        await videoEl.requestPictureInPicture();
      }
    } catch (e) {
      console.error('[VideoPiP] requestPictureInPicture failed:', e);
      // Never entered PiP, so don't leave the element holding a track for nothing.
      if (!enableAutoPip && !document.pictureInPictureElement) {
        setPipArmed(false);
        syncAttachment(videoEl, false);
      }
    }
  }, [isVideoPipSupported, syncAttachment, enableAutoPip]);

  // Manual exit Video PiP
  const exitVideoPip = useCallback(async () => {
    if (document.pictureInPictureElement) {
      try {
        await document.exitPictureInPicture();
      } catch (e) {
        console.error('[VideoPiP] exitPictureInPicture failed:', e);
      }
    }
  }, []);

  // MediaSession 'enterpictureinpicture' action handler: fires when the OS/browser's
  // own media-notification UI offers a PiP button and the user taps it.
  useEffect(() => {
    if (!isVideoPipSupported) return;

    if ('mediaSession' in navigator && 'setActionHandler' in navigator.mediaSession) {
      try {
        navigator.mediaSession.setActionHandler('enterpictureinpicture' as any, () => {
          requestVideoPip();
        });
      } catch (e) {
        // Some browsers may not support 'enterpictureinpicture' action
      }
    }

    return () => {
      if ('mediaSession' in navigator && 'setActionHandler' in navigator.mediaSession) {
        try {
          navigator.mediaSession.setActionHandler('enterpictureinpicture' as any, null);
        } catch {}
      }
    };
  }, [isVideoPipSupported, requestVideoPip]);

  return {
    isVideoPipSupported,
    isVideoPipActive,
    requestVideoPip,
    exitVideoPip,
  };
}
