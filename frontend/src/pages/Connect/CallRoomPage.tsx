import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  LiveKitRoom,
  useLocalParticipant,
  type LocalUserChoices,
  GridLayout,
  ControlBar,
  RoomAudioRenderer,
  ConnectionStateToast,
  FocusLayoutContainer,
  FocusLayout,
  CarouselLayout,
  LayoutContextProvider,
  useCreateLayoutContext,
  usePinnedTracks,
  useTracks,
  isTrackReference,
  ParticipantTile,
  VideoTrack,
  AudioTrack,
  ParticipantName,
  TrackMutedIndicator,
  ConnectionQualityIndicator,
  FocusToggle,
  ParticipantPlaceholder,
  ScreenShareIcon,
  useEnsureTrackRef,
  type TrackReferenceOrPlaceholder,
  type ParticipantTileProps,
} from '@livekit/components-react';
import { isEqualTrackRef } from '@livekit/components-core';
import {
  VideoPresets,
  Track,
  RoomEvent,
  ParticipantEvent,
  type RoomOptions,
  type LocalVideoTrack,
  type LocalAudioTrack,
} from 'livekit-client';
import { BackgroundBlur } from '@livekit/track-processors';
import { KrispNoiseFilter, isKrispNoiseFilterSupported } from '@livekit/krisp-noise-filter';
import { MicVAD } from '@ricky0123/vad-web';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import '@livekit/components-styles';
import {
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  Sparkles,
  Settings,
  Sliders,
  Volume2,
  X,
  MicOff,
  PictureInPicture2,
  Share2,
} from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';
import { useDocumentPiP } from '../../hooks/useDocumentPiP';
import { useAdvancedChat } from '../../hooks/useAdvancedChat';
import DocumentPipContent from './DocumentPipContent';
import AdvancedChat from '../../components/Connect/AdvancedChat';

/**
 * Silences outgoing audio whenever the local participant isn't actually speaking.
 */
function useVadAutoGate(enabled: boolean) {
  const { localParticipant } = useLocalParticipant();
  const [loading, setLoading] = useState(false);
  const [trackEpoch, setTrackEpoch] = useState(0);

  useEffect(() => {
    const bump = () => setTrackEpoch((n) => n + 1);
    localParticipant.on(ParticipantEvent.LocalTrackPublished, bump);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, bump);
    };
  }, [localParticipant]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let vad: MicVAD | null = null;
    let vadTrack: MediaStreamTrack | null = null;
    let gatedTrack: MediaStreamTrack | null = null;

    const setGate = (open: boolean) => {
      if (gatedTrack && gatedTrack.readyState === 'live') {
        gatedTrack.enabled = open;
      }
    };

    const start = async () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = pub?.track as LocalAudioTrack | undefined;
      if (!track) return;

      gatedTrack = track.mediaStreamTrack;
      vadTrack = gatedTrack.clone();
      const vadStream = new MediaStream([vadTrack]);

      setLoading(true);
      try {
        vad = await MicVAD.new({
          baseAssetPath: '/vad/',
          onnxWASMBasePath: '/vad/',
          ortConfig: (ort) => {
            ort.env.logLevel = 'error';
            ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
          },
          getStream: async () => vadStream,
          pauseStream: async () => {},
          resumeStream: async () => vadStream,
          onSpeechStart: () => setGate(true),
          onSpeechEnd: () => setGate(false),
          onVADMisfire: () => setGate(false),
        });
        if (cancelled) {
          await vad.destroy();
          vad = null;
          return;
        }
        setGate(false);
      } catch (e) {
        console.error('[Connect] failed to start VAD auto-gate:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void start();

    return () => {
      cancelled = true;
      setLoading(false);
      void (async () => {
        try {
          await vad?.destroy();
        } catch (e) {
          console.error('[Connect] failed to destroy VAD:', e);
        }
        vadTrack?.stop();
        setGate(true);
      })();
    };
  }, [enabled, localParticipant, trackEpoch]);

  return loading;
}

/**
 * Media Enhancements Settings Popover (Krisp AI, Background Blur, VAD)
 * Rendered inline next to the control bar, so it moves with it instead of
 * needing manually-tracked viewport coordinates.
 */
function MediaEnhancements() {
  const { localParticipant } = useLocalParticipant();
  const [isOpen, setIsOpen] = useState(false);
  const [blurred, setBlurred] = useState(true);
  const [blurLoading, setBlurLoading] = useState(false);
  const [krispEnabled, setKrispEnabled] = useState(true);
  const [krispLoading, setKrispLoading] = useState(false);
  const [autoGateEnabled, setAutoGateEnabled] = useState(true);
  const autoGateLoading = useVadAutoGate(autoGateEnabled);

  const isKrispSupported = isKrispNoiseFilterSupported();

  const appliedRef = useRef<{ track: LocalAudioTrack | null; enabled: boolean | null }>({
    track: null,
    enabled: null,
  });

  const appliedBlurRef = useRef<{ track: LocalVideoTrack | null; applied: boolean | null }>({
    track: null,
    applied: null,
  });

  const applyKrisp = useCallback(async (enabled: boolean, track: LocalAudioTrack) => {
    if (enabled) {
      if (!track.getProcessor()) {
        await track.setProcessor(KrispNoiseFilter({ quality: 'high', useBVC: true }));
      }
    } else if (track.getProcessor()) {
      await track.stopProcessor();
    }
  }, []);

  useEffect(() => {
    if (!isKrispSupported) return;

    const syncKrisp = async () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = pub?.track as LocalAudioTrack | undefined;
      if (!track) return;
      const already = appliedRef.current;
      if (already.track === track && already.enabled === krispEnabled) return;
      try {
        await applyKrisp(krispEnabled, track);
        appliedRef.current = { track, enabled: krispEnabled };
      } catch (e) {
        console.error('[Connect] Failed to enable Krisp filter:', e);
      }
    };

    syncKrisp();
    localParticipant.on(ParticipantEvent.LocalTrackPublished, syncKrisp);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, syncKrisp);
    };
  }, [localParticipant, krispEnabled, isKrispSupported, applyKrisp]);

  const toggleKrisp = useCallback(async () => {
    if (!isKrispSupported) return;
    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    const nextEnabled = !krispEnabled;
    setKrispLoading(true);
    try {
      if (track) {
        await applyKrisp(nextEnabled, track);
        appliedRef.current = { track, enabled: nextEnabled };
      }
      setKrispEnabled(nextEnabled);
    } catch (e) {
      console.error('[Connect] failed to toggle Krisp filter:', e);
    } finally {
      setKrispLoading(false);
    }
  }, [localParticipant, krispEnabled, isKrispSupported, applyKrisp]);

  useEffect(() => {
    const syncBlur = async () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Camera);
      const track = pub?.track as LocalVideoTrack | undefined;
      if (!track) return;
      const already = appliedBlurRef.current;
      if (already.track === track && already.applied === blurred) return;
      setBlurLoading(true);
      try {
        if (blurred) {
          if (!track.getProcessor()) {
            await track.setProcessor(BackgroundBlur(10));
          }
        } else if (track.getProcessor()) {
          await track.stopProcessor();
        }
        appliedBlurRef.current = { track, applied: blurred };
      } catch (e) {
        console.error('[Connect] Failed to sync background blur:', e);
      } finally {
        setBlurLoading(false);
      }
    };

    syncBlur();
    localParticipant.on(ParticipantEvent.LocalTrackPublished, syncBlur);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, syncBlur);
    };
  }, [localParticipant, blurred]);

  const toggleBlur = useCallback(() => {
    setBlurred((prev) => !prev);
  }, []);

  return (
    <div className="relative flex items-center">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className={`p-2 rounded-xl border transition-all duration-200 active:scale-95 flex items-center justify-center relative ${
          isOpen || blurred || krispEnabled
            ? 'bg-indigo-600/90 text-white border-indigo-400/50 hover:bg-indigo-600'
            : 'bg-gray-900/80 text-gray-200 border-gray-700/80 hover:bg-gray-800'
        }`}
        title="メディア設定 (ブラー / ノイズ除去)"
      >
        <Settings className={`w-5 h-5 transition-transform duration-300 ${isOpen ? 'rotate-90' : ''}`} />
        {(blurred || krispEnabled || autoGateEnabled) && (
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 border-2 border-gray-900 rounded-full animate-pulse" />
        )}
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute bottom-full right-0 mb-2 z-50 w-80 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-5 text-white space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-200">
            <div className="flex items-center justify-between border-b border-gray-800 pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-indigo-400" />
                <h3 className="font-bold text-sm text-gray-100">エフェクト & ノイズ設定</h3>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Krisp AI Toggle */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-indigo-400" />
                  <div>
                    <p className="text-xs font-bold text-gray-200">Krisp AI ノイズ除去</p>
                    <p className="text-[10px] text-gray-400">マイクの周囲の雑音をクリアに除去</p>
                  </div>
                </div>

                {isKrispSupported ? (
                  <button
                    onClick={toggleKrisp}
                    disabled={krispLoading}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                      krispEnabled ? 'bg-indigo-500' : 'bg-gray-700'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out flex items-center justify-center ${
                        krispEnabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    >
                      {krispLoading && <Loader2 className="w-3 h-3 animate-spin text-gray-600" />}
                    </span>
                  </button>
                ) : (
                  <span className="text-[10px] bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">
                    非対応
                  </span>
                )}
              </div>
            </div>

            {/* VAD Toggle */}
            <div className="space-y-2 border-t border-gray-800/80 pt-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MicOff className="w-4 h-4 text-indigo-400" />
                  <div>
                    <p className="text-xs font-bold text-gray-200">自動ミュート（発話検知）</p>
                    <p className="text-[10px] text-gray-400">話していない間は音声を送信しない</p>
                  </div>
                </div>

                <button
                  onClick={() => setAutoGateEnabled((prev) => !prev)}
                  disabled={autoGateLoading}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                    autoGateEnabled ? 'bg-indigo-500' : 'bg-gray-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out flex items-center justify-center ${
                      autoGateEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  >
                    {autoGateLoading && <Loader2 className="w-3 h-3 animate-spin text-gray-600" />}
                  </span>
                </button>
              </div>
            </div>

            {/* Background Blur */}
            <div className="space-y-2 border-t border-gray-800/80 pt-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-indigo-400" />
                  <div>
                    <p className="text-xs font-bold text-gray-200">背景ブラー</p>
                    <p className="text-[10px] text-gray-400">カメラの背景をぼかしてプライバシー保護</p>
                  </div>
                </div>

                <button
                  onClick={toggleBlur}
                  disabled={blurLoading}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                    blurred ? 'bg-indigo-500' : 'bg-gray-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out flex items-center justify-center ${
                      blurred ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  >
                    {blurLoading && <Loader2 className="w-3 h-3 animate-spin text-gray-600" />}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Custom Participant Tile with Avatar rendering when camera is off
 */
function CustomParticipantTile({ trackRef, ...htmlProps }: ParticipantTileProps) {
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
    } catch {}
  }

  const [imgError, setImgError] = useState(false);
  const isCameraOff =
    !isVideo || trackReference.publication?.isMuted || !trackReference.publication?.isSubscribed;

  return (
    <ParticipantTile trackRef={trackReference} {...htmlProps}>
      {isVideo && <VideoTrack trackRef={trackReference} />}
      {!isVideo && isTrackReference(trackReference) && (
        <AudioTrack trackRef={trackReference} />
      )}

      {/* Camera Off Placeholder */}
      {isCameraOff && !isScreenShare && (
        <div className="lk-participant-placeholder absolute inset-0 flex items-center justify-center pointer-events-none">
          {avatarUrl && !imgError ? (
            <div className="w-20 h-20 sm:w-24 sm:h-24 md:w-28 md:h-28 rounded-3xl overflow-hidden border-2 border-slate-700/80 shadow-2xl bg-slate-800 flex items-center justify-center animate-in fade-in zoom-in-95 duration-200">
              <img
                src={avatarUrl}
                alt={participant.name || participant.identity}
                className="w-full h-full object-cover"
                onError={() => setImgError(true)}
              />
            </div>
          ) : (
            <ParticipantPlaceholder />
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
        <ConnectionQualityIndicator className="lk-participant-metadata-item" />
      </div>
      <FocusToggle trackRef={trackReference} />
    </ParticipantTile>
  );
}

/**
 * "..." More Menu next to the control bar (currently just holds the PiP entry point).
 * Rendered inline next to the control bar so it moves with it automatically.
 */
function MoreMenu({
  onOpenPip,
  isPipActive,
}: {
  onOpenPip: () => void;
  isPipActive: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="relative flex items-center">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className={`p-2 rounded-xl border transition-all duration-200 active:scale-95 flex items-center justify-center ${
          isOpen
            ? 'bg-indigo-600/90 text-white border-indigo-400/50 hover:bg-indigo-600'
            : 'bg-gray-900/80 text-gray-200 border-gray-700/80 hover:bg-gray-800'
        }`}
        title="その他のメニュー"
      >
        <span className="text-lg leading-none font-black tracking-widest">...</span>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute bottom-full left-0 mb-2 z-50 w-56 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-2 text-white animate-in fade-in slide-in-from-bottom-3 duration-200">
            <button
              onClick={() => {
                onOpenPip();
                setIsOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
            >
              <PictureInPicture2 className="w-4 h-4 text-indigo-400" />
              <span>{isPipActive ? 'PiP表示中' : 'PiPで開く'}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Custom VideoConference with side-docked AdvancedChat and auto-PiP handling
 */
function CustomVideoConference({
  onOpenPip,
  onClosePip,
  isPipSupported,
  isPipActive,
  chat,
  showChat,
  setShowChat,
}: {
  onOpenPip: () => void;
  onClosePip: () => void;
  isPipSupported: boolean;
  isPipActive: boolean;
  chat: ReturnType<typeof useAdvancedChat>;
  showChat: boolean;
  setShowChat: (val: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const lastAutoFocusedScreenShareTrack = useRef<TrackReferenceOrPlaceholder | null>(null);
  const { localParticipant } = useLocalParticipant();
  const rawTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );

  // Exclude own (local) screen share track from being displayed on local screen
  const tracks = useMemo(() => {
    return rawTracks.filter(
      (t) =>
        !(
          t.source === Track.Source.ScreenShare &&
          t.participant.identity === localParticipant?.identity
        ),
    );
  }, [rawTracks, localParticipant?.identity]);

  const layoutContext = useCreateLayoutContext();

  // Remote screen share tracks (for autofocusing)
  const screenShareTracks = rawTracks
    .filter(isTrackReference)
    .filter(
      (track) =>
        track.publication.source === Track.Source.ScreenShare &&
        track.participant.identity !== localParticipant?.identity,
    );

  // Detect whether screen sharing is active (local or remote)
  const isAnyScreenSharing =
    (localParticipant?.isScreenShareEnabled ?? false) ||
    rawTracks.some(
      (t) =>
        isTrackReference(t) &&
        t.source === Track.Source.ScreenShare,
    );

  const focusTrack = usePinnedTracks(layoutContext)?.[0];
  const carouselTracks = tracks.filter((track) => !isEqualTrackRef(track, focusTrack));

  useEffect(() => {
    if (
      screenShareTracks.some((track) => track.publication.isSubscribed) &&
      lastAutoFocusedScreenShareTrack.current === null
    ) {
      layoutContext.pin.dispatch?.({ msg: 'set_pin', trackReference: screenShareTracks[0] });
      lastAutoFocusedScreenShareTrack.current = screenShareTracks[0];
    } else if (
      lastAutoFocusedScreenShareTrack.current &&
      !screenShareTracks.some(
        (track) =>
          track.publication.trackSid ===
          lastAutoFocusedScreenShareTrack.current?.publication?.trackSid,
      )
    ) {
      layoutContext.pin.dispatch?.({ msg: 'clear_pin' });
      lastAutoFocusedScreenShareTrack.current = null;
    }
    if (focusTrack && !isTrackReference(focusTrack)) {
      const updatedFocusTrack = tracks.find(
        (tr) =>
          tr.participant.identity === focusTrack.participant.identity &&
          tr.source === focusTrack.source,
      );
      if (updatedFocusTrack !== focusTrack && isTrackReference(updatedFocusTrack)) {
        layoutContext.pin.dispatch?.({ msg: 'set_pin', trackReference: updatedFocusTrack });
      }
    }
  }, [
    screenShareTracks
      .map((ref) => `${ref.publication.trackSid}_${ref.publication.isSubscribed}`)
      .join(),
    focusTrack?.publication?.trackSid,
    tracks,
  ]);

  // Automatically open Document PiP on screen share start, and close PiP on screen share stop
  const prevScreenShareRef = useRef(false);
  useEffect(() => {
    if (isAnyScreenSharing && !prevScreenShareRef.current && isPipSupported && !isPipActive) {
      onOpenPip();
    } else if (!isAnyScreenSharing && prevScreenShareRef.current && isPipActive) {
      onClosePip();
    }
    prevScreenShareRef.current = isAnyScreenSharing;
  }, [isAnyScreenSharing, isPipSupported, isPipActive, onOpenPip, onClosePip]);

  return (
    <div className="lk-video-conference relative flex flex-row h-full w-full overflow-hidden">
      {/* Screen Share PiP Suggestion Banner */}
      {isAnyScreenSharing && isPipSupported && !isPipActive && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-3 px-4 py-2 bg-indigo-950/90 hover:bg-indigo-900/90 border border-indigo-500/50 backdrop-blur-md rounded-2xl shadow-2xl text-white">
            <div className="flex items-center gap-2">
              <Share2 className="w-4 h-4 text-indigo-400 animate-pulse" />
              <span className="text-xs font-semibold">画面共有中：PiPを開くと参加者の顔を確認できます</span>
            </div>
            <button
              onClick={onOpenPip}
              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs rounded-xl transition-all shadow-md active:scale-95 flex items-center gap-1.5"
            >
              <PictureInPicture2 className="w-3.5 h-3.5" />
              <span>PiPで開く</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Conference Area */}
      <div className="flex-1 flex flex-col h-full min-w-0 relative overflow-hidden">
        <LayoutContextProvider
          value={layoutContext}
          onWidgetChange={(state) => {
            if (state.showChat !== showChat) {
              setShowChat(state.showChat);
            }
          }}
        >
          <div className="lk-video-conference-inner h-full min-h-0">
            {!focusTrack ? (
              <div className="lk-grid-layout-wrapper">
                <GridLayout tracks={tracks}>
                  <CustomParticipantTile />
                </GridLayout>
              </div>
            ) : (
              <div className="lk-focus-layout-wrapper">
                <FocusLayoutContainer>
                  <CarouselLayout tracks={carouselTracks}>
                    <CustomParticipantTile />
                  </CarouselLayout>
                  {focusTrack && <FocusLayout trackRef={focusTrack} />}
                </FocusLayoutContainer>
              </div>
            )}
            {/* Control bar row: "..." menu and media settings sit inline next to
                LiveKit's ControlBar so they move with it — no viewport-relative
                coordinates to update whenever the sidebar/layout changes. */}
            <div className="relative flex items-center justify-center">
              <ControlBar controls={{ chat: true, settings: false }} />
              {isPipSupported && (
                <div className="absolute left-2 sm:left-4 top-1/2 -translate-y-1/2">
                  <MoreMenu onOpenPip={onOpenPip} isPipActive={isPipActive} />
                </div>
              )}
              <div className="absolute right-2 sm:right-4 top-1/2 -translate-y-1/2">
                <MediaEnhancements />
              </div>
            </div>
          </div>
        </LayoutContextProvider>
      </div>

      {/* Docked Advanced Chat Sidebar (No overlap with bottom menu or settings) */}
      {showChat && (
        <aside className="w-80 md:w-96 h-full shrink-0 z-30 shadow-2xl animate-in slide-in-from-right duration-200">
          <AdvancedChat chat={chat} />
        </aside>
      )}

      <RoomAudioRenderer />
      <ConnectionStateToast />
    </div>
  );
}

/**
 * Inner Component rendered INSIDE <LiveKitRoom>
 * Safely accesses LiveKit context for useAdvancedChat, DocumentPiP, and Header controls.
 */
function CallRoomInner({
  roomId,
  roomTitle,
}: {
  roomId: string;
  roomTitle: string;
}) {
  const [copied, setCopied] = useState(false);
  const [showChat, setShowChat] = useState(false);

  // Safe to call inside <LiveKitRoom>
  const chat = useAdvancedChat();

  // Document Picture-in-Picture Hook
  const { isSupported: isPipSupported, isPipActive, pipWindow, openPip, closePip } = useDocumentPiP();

  const copyRoomId = async () => {
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard errors */
    }
  };

  return (
    <div className="h-full w-full flex flex-col overflow-hidden select-none">
      {/* Custom Slim In-Room Header */}
      <header className="h-11 shrink-0 bg-gray-950/90 border-b border-gray-800/80 backdrop-blur-md px-4 md:px-6 flex items-center justify-between z-30">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <h2 className="font-bold text-sm text-gray-100 truncate max-w-[180px] sm:max-w-xs md:max-w-md">
            {roomTitle || 'ミーティング'}
          </h2>

          {/* Room Code Badge with Copy */}
          <button
            onClick={copyRoomId}
            className="flex items-center gap-1.5 px-2 py-0.5 bg-gray-900/90 hover:bg-gray-800 border border-gray-700/80 hover:border-gray-600 rounded-md text-xs font-mono text-gray-300 hover:text-white transition-all active:scale-95 shrink-0"
            title="ルームコードをコピー"
          >
            <span>{roomId}</span>
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3 text-gray-400" />
            )}
          </button>
        </div>
      </header>

      {/* Main Video Conference Area */}
      <div className="flex-1 relative overflow-hidden">
        <CustomVideoConference
          onOpenPip={() => openPip({ width: 380, height: 620 })}
          onClosePip={closePip}
          isPipSupported={isPipSupported}
          isPipActive={isPipActive}
          chat={chat}
          showChat={showChat}
          setShowChat={setShowChat}
        />

        {/* Render Document PiP Portal when active */}
        {isPipActive &&
          pipWindow &&
          createPortal(
            <DocumentPipContent roomTitle={roomTitle} onClose={closePip} chat={chat} />,
            pipWindow.document.body,
          )}
      </div>
    </div>
  );
}

export default function CallRoomPage() {
  const navigate = useNavigate();
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();

  const [token, setToken] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [roomTitle, setRoomTitle] = useState('');
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDisconnected, setIsDisconnected] = useState(false);

  // Load choices from sessionStorage
  useEffect(() => {
    if (!roomId) return;
    try {
      const stored = sessionStorage.getItem(`smiring_connect_choices_${roomId}`);
      if (stored) {
        setChoices(JSON.parse(stored));
      }
    } catch (e) {
      console.warn('[CallRoomPage] Failed to parse stored choices:', e);
    }
  }, [roomId]);

  // Fetch token and connect to room
  useEffect(() => {
    if (!roomId) return;
    let isMounted = true;
    setLoading(true);

    const initConnection = async () => {
      try {
        const storedChoices = sessionStorage.getItem(`smiring_connect_choices_${roomId}`);
        const parsedChoices = storedChoices ? JSON.parse(storedChoices) : null;
        const displayName =
          parsedChoices?.username || user?.email?.split('@')[0] || 'guest';

        const res = await apiClient.post('/api/connect/token', {
          room: roomId,
          username: displayName,
        });

        if (!isMounted) return;

        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(
            body.detail ||
              '通話サーバー（LiveKit）がまだ準備中です。カメラ・マイクの確認まではできています。',
          );
          setLoading(false);
          return;
        }

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.error || `トークンの取得に失敗しました (${res.status})`);
          setLoading(false);
          return;
        }

        const data = await res.json();
        setToken(data.token);
        setServerUrl(data.url);
        if (data.roomTitle) {
          setRoomTitle(data.roomTitle);
        }
      } catch (e: any) {
        if (isMounted) {
          setErrorMsg(e?.message || '接続中にエラーが発生しました');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    initConnection();

    return () => {
      isMounted = false;
    };
  }, [roomId, user?.id]);

  const roomOptions: RoomOptions = useMemo(
    () => ({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: VideoPresets.h360.resolution,
        deviceId: choices?.videoDeviceId || undefined,
      },
      audioCaptureDefaults: {
        deviceId: choices?.audioDeviceId || undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      publishDefaults: {
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
        audioPreset: { maxBitrate: 32_000 },
        dtx: true,
        red: true,
      },
    }),
    [choices],
  );

  const handleLeave = () => {
    setIsDisconnected(true);
  };

  const handleCloseWindow = () => {
    window.close();
    navigate('/connect');
  };

  if (isDisconnected) {
    return (
      <div className="h-screen w-screen bg-[#0f1115] flex flex-col items-center justify-center p-6 text-white text-center">
        <div className="w-16 h-16 rounded-3xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center mb-4">
          <Check className="w-8 h-8 text-indigo-400" />
        </div>
        <h1 className="text-2xl font-black mb-2">通話を終了しました</h1>
        <p className="text-sm text-gray-400 mb-8 max-w-sm">
          このタブを閉じるか、SmiRingConnectのトップページに戻ることができます。
        </p>
        <div className="flex gap-3">
          <button
            onClick={handleCloseWindow}
            className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-indigo-900/30 transition-all active:scale-95"
          >
            タブを閉じる
          </button>
          <button
            onClick={() => navigate('/connect')}
            className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-gray-200 font-bold text-sm rounded-xl border border-gray-700 transition-all active:scale-95"
          >
            ルーム一覧に戻る
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-screen w-screen bg-[#0f1115] flex flex-col items-center justify-center gap-4 text-white">
        <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
        <p className="font-bold text-sm text-gray-300">ルームに接続しています...</p>
      </div>
    );
  }

  if (errorMsg || !token || !serverUrl) {
    return (
      <div className="h-screen w-screen bg-[#0f1115] flex flex-col items-center justify-center p-6 text-white text-center">
        <div className="w-16 h-16 rounded-3xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center mb-4">
          <AlertTriangle className="w-8 h-8 text-rose-500" />
        </div>
        <h1 className="text-2xl font-black mb-2">接続できませんでした</h1>
        <p className="text-sm text-gray-400 mb-8 max-w-md">
          {errorMsg || 'ルーム情報の取得に失敗しました。'}
        </p>
        <div className="flex gap-3">
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-indigo-900/30 transition-all active:scale-95"
          >
            再試行
          </button>
          <button
            onClick={() => navigate('/connect')}
            className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-gray-200 font-bold text-sm rounded-xl border border-gray-700 transition-all active:scale-95"
          >
            戻る
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-[#0f1115] flex flex-col overflow-hidden select-none" data-lk-theme="default">
      <LiveKitRoom
        token={token}
        serverUrl={serverUrl}
        connect
        video={choices?.videoEnabled ?? true}
        audio={choices?.audioEnabled ?? true}
        options={roomOptions}
        onDisconnected={handleLeave}
        onError={(e) => {
          setErrorMsg(e.message);
        }}
        style={{ height: '100%' }}
      >
        <CallRoomInner
          roomId={roomId!}
          roomTitle={roomTitle}
        />
      </LiveKitRoom>
    </div>
  );
}
