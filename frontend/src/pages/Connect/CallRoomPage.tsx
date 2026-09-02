import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  LiveKitRoom,
  useLocalParticipant,
  useMediaDeviceSelect,
  useRoomContext,
  type LocalUserChoices,
  RoomAudioRenderer,
  ConnectionStateToast,
  useTracks,
} from '@livekit/components-react';
import { supportsScreenSharing } from '@livekit/components-core';
import {
  VideoPresets,
  Track,
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
  Volume2,
  X,
  Mic,
  MicOff,
  Video,
  VideoOff,
  PictureInPicture2,
  ScreenShare,
  MessageSquare,
  PhoneOff,
  Ellipsis,
  ChevronUp,
  LayoutGrid,
  Maximize2,
  DoorOpen,
} from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import MiniRoomPanel from '../../components/Connect/MiniRoomPanel';
import MiniRoomMoveToast from '../../components/Connect/MiniRoomMoveToast';
import { useAuth } from '../../context/AuthContext';
import { SMIRING_MEMBER_ROLE_ID } from '../../hooks/useIsInternal';
import { useMiniRooms, type UseMiniRoomsResult } from '../../hooks/useMiniRooms';
import { useDocumentPiP } from '../../hooks/useDocumentPiP';
import { useActiveSpeakerVideoPip } from '../../hooks/useActiveSpeakerVideoPip';
import { useAdvancedChat } from '../../hooks/useAdvancedChat';
import DocumentPipContent from './DocumentPipContent';
import AdvancedChat from '../../components/Connect/AdvancedChat';
import LeaveConfirmModal from '../../components/Connect/LeaveConfirmModal';
import GridLayoutView from '../../components/Connect/callLayout/GridLayoutView';
import StageLayoutView from '../../components/Connect/callLayout/StageLayoutView';
import {
  useCallLayout,
  type CallLayout,
  type LayoutMode,
} from '../../components/Connect/callLayout/useCallLayout';

/**
 * Shared look for every control-bar button (mic, camera, screen-share, chat,
 * more, leave) — icon on top, small label underneath. Wide enough for comfortable
 * clicking with generous horizontal breathing room.
 */
function controlButtonClass(active: boolean, danger = false) {
  const base =
    'flex flex-col items-center justify-center gap-0.5 min-w-[4.25rem] sm:min-w-[4.75rem] h-[52px] px-3.5 py-1.5 rounded-xl border transition-all duration-200 active:scale-95 shrink-0';
  if (danger) {
    return `${base} text-rose-400 border-rose-500/40 bg-gray-900/80 hover:bg-rose-500/10 hover:border-rose-500/60`;
  }
  return `${base} ${
    active
      ? 'bg-indigo-600/90 text-white border-indigo-400/50 hover:bg-indigo-600'
      : 'bg-gray-900/80 text-gray-200 border-gray-700/80 hover:bg-gray-800'
  }`;
}

function ControlButtonLabel({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-bold leading-none whitespace-nowrap">{children}</span>;
}

/**
 * Tracks an element's rendered width via ResizeObserver, so layout code can react
 * to the *actual* space available (container width) rather than guessing from the
 * viewport breakpoint — the control bar can be squeezed by the chat sidebar, not
 * just by a narrow phone.
 */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/**
 * Silences outgoing audio whenever the local participant isn't actually speaking.
 */
function useVadAutoGate(enabled: boolean) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const [loading, setLoading] = useState(false);
  const [trackEpoch, setTrackEpoch] = useState(0);

  // Manual mute must always win. LiveKit's own setMicrophoneEnabled() toggles this
  // exact same mediaStreamTrack.enabled flag, so without this ref, VAD hearing
  // speech while manually muted would flip the flag back to enabled — that's what
  // made a "muted" tile still light up as speaking.
  const isMicrophoneEnabledRef = useRef(isMicrophoneEnabled);
  const gatedTrackRef = useRef<MediaStreamTrack | null>(null);

  useEffect(() => {
    isMicrophoneEnabledRef.current = isMicrophoneEnabled;
    // Close the gate the instant a manual mute happens, instead of waiting for
    // VAD to notice silence on its own.
    if (!isMicrophoneEnabled) {
      const track = gatedTrackRef.current;
      if (track && track.readyState === 'live') {
        track.enabled = false;
      }
    }
  }, [isMicrophoneEnabled]);

  useEffect(() => {
    // Only restart the VAD when the microphone track itself changes (e.g. device
    // switch). Camera/screen-share publish events also fire LocalTrackPublished;
    // reacting to those tore down and rebuilt the VAD on every screen share
    // start/stop, and if speech detection didn't fire right after, the mic stayed
    // gated closed even though the UI still showed it as unmuted.
    const bump = (publication: { source?: Track.Source }) => {
      if (publication?.source !== Track.Source.Microphone) return;
      setTrackEpoch((n) => n + 1);
    };
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

    const setGate = (open: boolean) => {
      const track = gatedTrackRef.current;
      if (!track || track.readyState !== 'live') return;
      // Never let VAD re-open a mic the user has manually muted.
      if (open && !isMicrophoneEnabledRef.current) return;
      track.enabled = open;
    };

    const start = async () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = pub?.track as LocalAudioTrack | undefined;
      if (!track) return;

      gatedTrackRef.current = track.mediaStreamTrack;
      vadTrack = gatedTrackRef.current.clone();
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
 * Renders dropdown content into `document.body` via a portal, positioned against
 * `anchorRef`'s on-screen position, instead of as an `absolute` child of the trigger
 * button. On some mobile browsers (notably iOS Safari) `<video>` elements composite in
 * their own layer and ignore the page's normal z-index stacking entirely.
 */
function DropdownPortal({
  anchorRef,
  onClose,
  children,
  align = 'left',
  direction = 'up',
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  align?: 'left' | 'right';
  direction?: 'up' | 'down';
}) {
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const top = direction === 'up' ? rect.top - 8 : rect.bottom + 8;
      setPos(
        align === 'right'
          ? { top, right: window.innerWidth - rect.right }
          : { top, left: rect.left },
      );
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, align, direction]);

  if (!pos) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[999]" onClick={onClose} />
      <div
        className={`fixed z-[1000] animate-in fade-in ${
          direction === 'up' ? 'slide-in-from-bottom-3' : 'slide-in-from-top-3'
        } duration-200`}
        style={{
          top: pos.top,
          left: pos.left,
          right: pos.right,
          transform: direction === 'up' ? 'translateY(-100%)' : 'none',
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * Owns the Krisp/blur/VAD toggle state and track-processor wiring.
 */
function useMediaEnhancementsState(localParticipant: ReturnType<typeof useLocalParticipant>['localParticipant']) {
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

  return {
    blurred,
    blurLoading,
    krispEnabled,
    krispLoading,
    autoGateEnabled,
    setAutoGateEnabled,
    autoGateLoading,
    isKrispSupported,
    toggleKrisp,
    toggleBlur,
  };
}

type MediaEnhancementsState = ReturnType<typeof useMediaEnhancementsState>;

/**
 * Device menu for Audio Input (Microphone), Audio Output (Speaker), and Noise Suppression
 */
function MicMenuDropdown({
  anchorRef,
  onClose,
  mediaEnhancements,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  mediaEnhancements: MediaEnhancementsState;
}) {
  const {
    devices: audioInputs,
    activeDeviceId: activeInputId,
    setActiveMediaDevice: setActiveInput,
  } = useMediaDeviceSelect({ kind: 'audioinput' });

  const {
    devices: audioOutputs,
    activeDeviceId: activeOutputId,
    setActiveMediaDevice: setActiveOutput,
  } = useMediaDeviceSelect({ kind: 'audiooutput' });

  const {
    krispEnabled,
    krispLoading,
    autoGateEnabled,
    setAutoGateEnabled,
    autoGateLoading,
    isKrispSupported,
    toggleKrisp,
  } = mediaEnhancements;

  return (
    <DropdownPortal anchorRef={anchorRef} onClose={onClose} align="left">
      <div className="w-80 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-3.5 text-white space-y-3">
        <div className="flex items-center justify-between border-b border-gray-800 pb-2 px-1">
          <div className="flex items-center gap-1.5">
            <Mic className="w-3.5 h-3.5 text-indigo-400" />
            <h3 className="font-bold text-xs text-gray-100">マイク・スピーカー設定</h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Microphones (Audio Input) */}
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-gray-400 px-1 uppercase tracking-wider">マイク（入力）</p>
          <div className="space-y-0.5 max-h-32 overflow-y-auto no-scrollbar">
            {audioInputs.map((device) => {
              const isSelected = device.deviceId === activeInputId;
              return (
                <button
                  key={device.deviceId}
                  onClick={async () => {
                    await setActiveInput(device.deviceId);
                    onClose();
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-all ${
                    isSelected
                      ? 'bg-indigo-600/30 text-indigo-300 font-bold border border-indigo-500/40'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <span className="truncate">{device.label || `マイク (${device.deviceId.slice(0, 5)}...)`}</span>
                  {isSelected && <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
                </button>
              );
            })}
            {audioInputs.length === 0 && (
              <p className="text-[11px] text-gray-500 py-1 px-1">利用可能なマイクがありません</p>
            )}
          </div>
        </div>

        {/* Speakers (Audio Output) if available */}
        {audioOutputs.length > 0 && (
          <div className="space-y-1 border-t border-gray-800/80 pt-2">
            <p className="text-[10px] font-bold text-gray-400 px-1 uppercase tracking-wider">スピーカー（出力）</p>
            <div className="space-y-0.5 max-h-28 overflow-y-auto no-scrollbar">
              {audioOutputs.map((device) => {
                const isSelected = device.deviceId === activeOutputId;
                return (
                  <button
                    key={device.deviceId}
                    onClick={async () => {
                      await setActiveOutput(device.deviceId);
                      onClose();
                    }}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-all ${
                      isSelected
                        ? 'bg-indigo-600/30 text-indigo-300 font-bold border border-indigo-500/40'
                        : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                    }`}
                  >
                    <span className="truncate">{device.label || `スピーカー (${device.deviceId.slice(0, 5)}...)`}</span>
                    {isSelected && <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Krisp AI Noise Filter */}
        <div className="space-y-1.5 border-t border-gray-800/80 pt-2.5 px-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-indigo-400" />
              <div>
                <p className="text-xs font-bold text-gray-200">Krisp AI ノイズ除去</p>
                <p className="text-[10px] text-gray-400">マイクの周囲の雑音を除去</p>
              </div>
            </div>

            {isKrispSupported ? (
              <button
                onClick={toggleKrisp}
                disabled={krispLoading}
                className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                  krispEnabled ? 'bg-indigo-500' : 'bg-gray-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out flex items-center justify-center ${
                    krispEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                >
                  {krispLoading && <Loader2 className="w-2.5 h-2.5 animate-spin text-gray-600" />}
                </span>
              </button>
            ) : (
              <span className="text-[10px] bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">
                非対応
              </span>
            )}
          </div>
        </div>

        {/* VAD Auto-Gate */}
        <div className="space-y-1.5 border-t border-gray-800/80 pt-2.5 px-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MicOff className="w-4 h-4 text-indigo-400" />
              <div>
                <p className="text-xs font-bold text-gray-200">自動ミュート（発話検知）</p>
                <p className="text-[10px] text-gray-400">話していない間は送信しない</p>
              </div>
            </div>

            <button
              onClick={() => setAutoGateEnabled((prev) => !prev)}
              disabled={autoGateLoading}
              className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                autoGateEnabled ? 'bg-indigo-500' : 'bg-gray-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out flex items-center justify-center ${
                  autoGateEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              >
                {autoGateLoading && <Loader2 className="w-2.5 h-2.5 animate-spin text-gray-600" />}
              </span>
            </button>
          </div>
        </div>
      </div>
    </DropdownPortal>
  );
}

/**
 * Device menu for Video Input (Camera) and Background Blur
 */
function CameraMenuDropdown({
  anchorRef,
  onClose,
  mediaEnhancements,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  mediaEnhancements: MediaEnhancementsState;
}) {
  const {
    devices: videoInputs,
    activeDeviceId: activeVideoId,
    setActiveMediaDevice: setActiveVideo,
  } = useMediaDeviceSelect({ kind: 'videoinput' });

  const { blurred, blurLoading, toggleBlur } = mediaEnhancements;

  return (
    <DropdownPortal anchorRef={anchorRef} onClose={onClose} align="left">
      <div className="w-80 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-3.5 text-white space-y-3">
        <div className="flex items-center justify-between border-b border-gray-800 pb-2 px-1">
          <div className="flex items-center gap-1.5">
            <Video className="w-3.5 h-3.5 text-indigo-400" />
            <h3 className="font-bold text-xs text-gray-100">カメラ設定</h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Video Devices List */}
        <div className="space-y-1">
          <p className="text-[10px] font-bold text-gray-400 px-1 uppercase tracking-wider">カメラ（映像入力）</p>
          <div className="space-y-0.5 max-h-44 overflow-y-auto no-scrollbar">
            {videoInputs.map((device) => {
              const isSelected = device.deviceId === activeVideoId;
              return (
                <button
                  key={device.deviceId}
                  onClick={async () => {
                    await setActiveVideo(device.deviceId);
                    onClose();
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-all ${
                    isSelected
                      ? 'bg-indigo-600/30 text-indigo-300 font-bold border border-indigo-500/40'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  <span className="truncate">{device.label || `カメラ (${device.deviceId.slice(0, 5)}...)`}</span>
                  {isSelected && <Check className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
                </button>
              );
            })}
            {videoInputs.length === 0 && (
              <p className="text-[11px] text-gray-500 py-1 px-1">利用可能なカメラがありません</p>
            )}
          </div>
        </div>

        {/* Background Blur Toggle */}
        <div className="space-y-1.5 border-t border-gray-800/80 pt-3 px-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <div>
                <p className="text-xs font-bold text-gray-200">背景ブラー</p>
                <p className="text-[10px] text-gray-400">背景をぼかしてプライバシー保護</p>
              </div>
            </div>

            <button
              onClick={toggleBlur}
              disabled={blurLoading}
              className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
                blurred ? 'bg-indigo-500' : 'bg-gray-700'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out flex items-center justify-center ${
                  blurred ? 'translate-x-5' : 'translate-x-0'
                }`}
              >
                {blurLoading && <Loader2 className="w-2.5 h-2.5 animate-spin text-gray-600" />}
              </span>
            </button>
          </div>
        </div>
      </div>
    </DropdownPortal>
  );
}

function MicButton({ mediaEnhancements }: { mediaEnhancements: MediaEnhancementsState }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleMic = useCallback(async () => {
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch (e) {
      console.error('Failed to toggle mic:', e);
    }
  }, [localParticipant, isMicrophoneEnabled]);

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-stretch h-[52px] rounded-xl border transition-all duration-200 shrink-0 ${
        isMicrophoneEnabled
          ? 'bg-indigo-600/90 border-indigo-400/50 text-white'
          : 'bg-gray-900/80 border-gray-700/80 text-gray-200'
      }`}
    >
      <button
        onClick={toggleMic}
        title={isMicrophoneEnabled ? 'マイクをミュート' : 'マイクをミュート解除'}
        className="flex flex-col items-center justify-center gap-0.5 min-w-[3.5rem] sm:min-w-[4rem] px-3 py-1.5 transition-colors hover:brightness-110 active:scale-95 rounded-l-xl"
      >
        {isMicrophoneEnabled ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5 text-rose-400" />}
        <ControlButtonLabel>マイク</ControlButtonLabel>
      </button>

      <button
        onClick={() => setIsOpen((prev) => !prev)}
        title="マイク・スピーカー設定"
        className={`flex items-center justify-center px-2 border-l transition-colors rounded-r-xl ${
          isMicrophoneEnabled
            ? 'border-indigo-400/40 hover:bg-indigo-700/60 text-white/90'
            : 'border-gray-700/80 hover:bg-gray-800 text-gray-400 hover:text-white'
        }`}
      >
        <ChevronUp className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <MicMenuDropdown anchorRef={containerRef} onClose={() => setIsOpen(false)} mediaEnhancements={mediaEnhancements} />
      )}
    </div>
  );
}

function CameraButton({ mediaEnhancements }: { mediaEnhancements: MediaEnhancementsState }) {
  const { localParticipant, isCameraEnabled } = useLocalParticipant();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const toggleCam = useCallback(async () => {
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch (e) {
      console.error('Failed to toggle camera:', e);
    }
  }, [localParticipant, isCameraEnabled]);

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-stretch h-[52px] rounded-xl border transition-all duration-200 shrink-0 ${
        isCameraEnabled
          ? 'bg-indigo-600/90 border-indigo-400/50 text-white'
          : 'bg-gray-900/80 border-gray-700/80 text-gray-200'
      }`}
    >
      <button
        onClick={toggleCam}
        title={isCameraEnabled ? 'カメラをオフ' : 'カメラをオン'}
        className="flex flex-col items-center justify-center gap-0.5 min-w-[3.5rem] sm:min-w-[4rem] px-3 py-1.5 transition-colors hover:brightness-110 active:scale-95 rounded-l-xl"
      >
        {isCameraEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5 text-rose-400" />}
        <ControlButtonLabel>カメラ</ControlButtonLabel>
      </button>

      <button
        onClick={() => setIsOpen((prev) => !prev)}
        title="カメラ設定"
        className={`flex items-center justify-center px-2 border-l transition-colors rounded-r-xl ${
          isCameraEnabled
            ? 'border-indigo-400/40 hover:bg-indigo-700/60 text-white/90'
            : 'border-gray-700/80 hover:bg-gray-800 text-gray-400 hover:text-white'
        }`}
      >
        <ChevronUp className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <CameraMenuDropdown anchorRef={containerRef} onClose={() => setIsOpen(false)} mediaEnhancements={mediaEnhancements} />
      )}
    </div>
  );
}

function useScreenShareToggle() {
  const isSupported = useMemo(() => supportsScreenSharing(), []);
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();

  const toggleShare = useCallback(async () => {
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled);
    } catch (e) {
      console.error('Failed to toggle screen share:', e);
    }
  }, [localParticipant, isScreenShareEnabled]);

  return { isSupported, isScreenShareEnabled, toggleShare };
}

function ScreenShareButton() {
  const { isSupported, isScreenShareEnabled, toggleShare } = useScreenShareToggle();

  if (!isSupported) return null;

  return (
    <button onClick={toggleShare} title="画面共有" className={controlButtonClass(isScreenShareEnabled)}>
      <ScreenShare className="w-5 h-5" />
      <ControlButtonLabel>共有</ControlButtonLabel>
    </button>
  );
}

/** Same screen-share toggle, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function ScreenShareMenuItem({ onSelect }: { onSelect: () => void }) {
  const { isSupported, isScreenShareEnabled, toggleShare } = useScreenShareToggle();

  if (!isSupported) return null;

  return (
    <button
      onClick={() => {
        toggleShare();
        onSelect();
      }}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <ScreenShare className="w-4 h-4 text-indigo-400" />
      <span>{isScreenShareEnabled ? '画面共有を停止' : '画面共有'}</span>
    </button>
  );
}

function LeaveButton() {
  const room = useRoomContext();
  const [showConfirm, setShowConfirm] = useState(false);

  const handleConfirmLeave = () => {
    room.disconnect();
  };

  return (
    <>
      <button
        onClick={() => setShowConfirm(true)}
        title="通話を終了"
        className={controlButtonClass(false, true)}
      >
        <PhoneOff className="w-5 h-5" />
        <ControlButtonLabel>退出</ControlButtonLabel>
      </button>

      <LeaveConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleConfirmLeave}
      />
    </>
  );
}

/**
 * Chat open/close toggle. Deliberately NOT LiveKit's built-in <ControlBar chat> button:
 * that button drives `showChat` through LiveKit's internal layout-context widget state,
 * which only the ControlBar's own click handler ever updates. AdvancedChat's "back to
 * video" button sets `showChat` directly instead, so the two ended up as two different
 * sources of truth for the same boolean — closing chat via the back button didn't update
 * the widget state, so the next LiveKit-driven render could silently put it back to `true`.
 * Routing every toggle through this one button (and the same `setShowChat` the back button
 * uses) keeps `showChat` single-owned.
 */
function ChatToggleButton({
  isOpen,
  unreadCount,
  onClick,
}: {
  isOpen: boolean;
  unreadCount: number;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} title="チャット" className={`relative ${controlButtonClass(isOpen)}`}>
      <MessageSquare className="w-5 h-5" />
      <ControlButtonLabel>チャット</ControlButtonLabel>
      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full border-2 border-gray-950 flex items-center justify-center animate-pulse">
          {unreadCount}
        </span>
      )}
    </button>
  );
}

/** Same chat toggle, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function ChatMenuItem({
  isOpen,
  unreadCount,
  onClick,
}: {
  isOpen: boolean;
  unreadCount: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <MessageSquare className="w-4 h-4 text-indigo-400" />
      <span>{isOpen ? 'チャットを閉じる' : 'チャット'}</span>
      {unreadCount > 0 && (
        <span className="ml-auto min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
          {unreadCount}
        </span>
      )}
    </button>
  );
}

/** Opens the mini-room (breakout room) creation dialog. */
function MiniRoomButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} title="ミニルーム" className={controlButtonClass(false)}>
      <DoorOpen className="w-5 h-5" />
      <ControlButtonLabel>ミニルーム</ControlButtonLabel>
    </button>
  );
}

/** Same mini-room entry point, styled as a row inside `MoreMenu` for when the bar is too narrow. */
function MiniRoomMenuItem({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <DoorOpen className="w-4 h-4 text-indigo-400" />
      <span>ミニルーム</span>
    </button>
  );
}

/**
 * One entry in the control bar's overflow system: rendered as a pill button in
 * the bar when there's room, or as a row inside `MoreMenu` when there isn't.
 * `priority` decides collapse order — the LOWEST priority item collapses first
 * as the bar gets narrower. To add a new control-bar feature (screen recording,
 * AI chat, participant list, ...), just add one more entry to the `overflowItems`
 * array built in `CustomVideoConference` — the width measurement and collapsing
 * below are generic and don't need to change.
 */
interface OverflowBarItem {
  key: string;
  priority: number;
  badgeCount?: number;
  renderBar: () => ReactNode;
  renderMenuItem: (close: () => void) => ReactNode;
}

/** Estimated rendered width (pill + gap) of one `controlButtonClass` button, used to decide how many overflow items fit. */
const OVERFLOW_ITEM_WIDTH_PX = 84;

/**
 * "その他のメニュー" next to the control bar. Always holds the PiP entry point
 * (when supported), plus whichever `overflowItems` didn't fit in the bar — see
 * the collapsing logic in `CustomVideoConference`.
 */
function MoreMenu({
  showPip,
  onOpenPip,
  isPipActive,
  collapsedItems,
}: {
  showPip: boolean;
  onOpenPip: () => void;
  isPipActive: boolean;
  collapsedItems: OverflowBarItem[];
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const badgeTotal = collapsedItems.reduce((sum, item) => sum + (item.badgeCount ?? 0), 0);

  return (
    <div className="relative flex items-center">
      <button
        ref={triggerRef}
        onClick={() => setIsOpen((prev) => !prev)}
        title="その他のメニュー"
        className={`relative ${controlButtonClass(isOpen)}`}
      >
        <Ellipsis className="w-5 h-5" />
        <ControlButtonLabel>その他</ControlButtonLabel>
        {badgeTotal > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full border-2 border-gray-950 flex items-center justify-center animate-pulse">
            {badgeTotal}
          </span>
        )}
      </button>

      {isOpen && (
        <DropdownPortal anchorRef={triggerRef} onClose={() => setIsOpen(false)} align="left">
          <div className="w-56 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-2 text-white">
            {collapsedItems.map((item) => (
              <div key={item.key}>{item.renderMenuItem(close)}</div>
            ))}
            {showPip && (
              <button
                onClick={() => {
                  onOpenPip();
                  close();
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
              >
                <PictureInPicture2 className="w-4 h-4 text-indigo-400" />
                <span>{isPipActive ? 'PiP表示中' : 'PiPで開く'}</span>
              </button>
            )}
          </div>
        </DropdownPortal>
      )}
    </div>
  );
}

const LAYOUT_MODE_OPTIONS: { mode: LayoutMode; label: string; icon: typeof LayoutGrid }[] = [
  { mode: 'grid', label: 'グリッド', icon: LayoutGrid },
  { mode: 'speaker', label: 'スピーカー', icon: Maximize2 },
];

/**
 * Switches between grid / speaker. Structured like `MoreMenu` so it inherits
 * `DropdownPortal`'s iOS-Safari z-index workaround.
 *
 * There is no "pin" entry here: pinning is a per-tile action (the pin button on each
 * tile), orthogonal to which of these two layouts is showing. See `useCallLayout`.
 *
 * Unlike `ScreenShareButton` this is *not* hidden on small screens: escaping a
 * 20-tile grid matters most on a phone.
 */
function LayoutModeButton({
  mode,
  onSelect,
}: {
  mode: LayoutMode;
  onSelect: (mode: LayoutMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const activeOption = LAYOUT_MODE_OPTIONS.find((o) => o.mode === mode);
  const ActiveIcon = activeOption?.icon ?? LayoutGrid;
  const activeLabel = activeOption?.label ?? '表示';

  return (
    <div className="relative flex items-center">
      <button
        ref={triggerRef}
        onClick={() => setIsOpen((prev) => !prev)}
        title="表示レイアウトを変更"
        className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-900/90 hover:bg-gray-800 border border-gray-700/80 hover:border-gray-600 rounded-md text-xs font-semibold text-gray-200 hover:text-white transition-all active:scale-95 shrink-0"
      >
        <ActiveIcon className="w-3.5 h-3.5 text-indigo-400" />
        <span>{activeLabel}</span>
      </button>

      {isOpen && (
        <DropdownPortal anchorRef={triggerRef} onClose={() => setIsOpen(false)} align="right" direction="down">
          <div className="w-52 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-2 text-white">
            <div className="px-2.5 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">表示レイアウト</div>
            {LAYOUT_MODE_OPTIONS.map(({ mode: optionMode, label, icon: Icon }) => {
              const isActive = optionMode === mode;
              return (
                <button
                  key={optionMode}
                  onClick={() => {
                    onSelect(optionMode);
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-bold transition-colors ${
                    isActive ? 'bg-indigo-600/25 text-white' : 'text-gray-200 hover:bg-gray-800'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-300' : 'text-indigo-400'}`} />
                  <span>{label}</span>
                  {isActive && <Check className="w-3.5 h-3.5 ml-auto text-indigo-300" />}
                </button>
              );
            })}
          </div>
        </DropdownPortal>
      )}
    </div>
  );
}

/**
 * Custom VideoConference with side-docked AdvancedChat and auto-PiP handling
 */
function CustomVideoConference({
  layout,
  onOpenPip,
  onClosePip,
  isPipSupported,
  isPipActive,
  chat,
  showChat,
  setShowChat,
  isMiniRoomHost,
  mainRoomId,
  miniRooms,
}: {
  layout: CallLayout;
  onOpenPip: () => void;
  onClosePip: () => void;
  isPipSupported: boolean;
  isPipActive: boolean;
  chat: ReturnType<typeof useAdvancedChat>;
  showChat: boolean;
  setShowChat: (val: boolean | ((prev: boolean) => boolean)) => void;
  isMiniRoomHost: boolean;
  mainRoomId: string;
  miniRooms: UseMiniRoomsResult;
}) {
  const { localParticipant } = useLocalParticipant();
  const mediaEnhancements = useMediaEnhancementsState(localParticipant);

  // Mini-room panel, opened by the control-bar button. Visible/openable by everyone —
  // MiniRoomPanel itself branches host vs. non-host content.
  const [showMiniRoomPanel, setShowMiniRoomPanel] = useState(false);

  // Center control-bar items (Screen Share, Chat, and any future additions) fold into
  // the "..." menu once they don't fit. `centerWidth` is the actual box width flexbox
  // already assigned to the center `flex-1` slot — i.e. exactly the room available
  // after Mic/Camera (left) and Leave (right) take their space — so this keeps working
  // automatically if those change size too, not just when the viewport is narrow.
  const { ref: centerRef, width: centerWidth } = useElementWidth<HTMLDivElement>();

  const overflowItems: OverflowBarItem[] = [
    {
      key: 'screenshare',
      priority: 1,
      renderBar: () => <ScreenShareButton />,
      renderMenuItem: (close) => <ScreenShareMenuItem onSelect={close} />,
    },
    {
      key: 'chat',
      priority: 2,
      badgeCount: chat.totalUnreadCount,
      renderBar: () => (
        <ChatToggleButton
          isOpen={showChat}
          unreadCount={chat.totalUnreadCount}
          onClick={() => setShowChat((prev) => !prev)}
        />
      ),
      renderMenuItem: (close) => (
        <ChatMenuItem
          isOpen={showChat}
          unreadCount={chat.totalUnreadCount}
          onClick={() => {
            setShowChat((prev) => !prev);
            close();
          }}
        />
      ),
    },
    {
      key: 'miniroom',
      priority: 0,
      renderBar: () => <MiniRoomButton onClick={() => setShowMiniRoomPanel(true)} />,
      renderMenuItem: (close) => (
        <MiniRoomMenuItem
          onClick={() => {
            setShowMiniRoomPanel(true);
            close();
          }}
        />
      ),
    },
    // Add future control-bar features here (screen recording, AI chat, participant
    // list, ...) with a `priority` — lower numbers collapse into "..." first as the
    // bar narrows. No other change needed; the fit/collapse logic below is generic.
  ];

  // Reserve room for the "More" button itself so it doesn't pop in/out as items
  // cross the fit threshold (that would shrink the available space and could flip
  // the decision back and forth).
  const availableForItems = centerWidth === null ? Infinity : centerWidth - OVERFLOW_ITEM_WIDTH_PX;
  const fitCount =
    availableForItems === Infinity ? overflowItems.length : Math.max(0, Math.floor(availableForItems / OVERFLOW_ITEM_WIDTH_PX));
  const visibleKeys = new Set(
    [...overflowItems]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, fitCount)
      .map((item) => item.key),
  );
  const visibleItems = overflowItems.filter((item) => visibleKeys.has(item.key));
  const collapsedItems = overflowItems.filter((item) => !visibleKeys.has(item.key));

  // Detect whether the local user (myself) is sharing screen
  const isLocalScreenSharing = localParticipant?.isScreenShareEnabled ?? false;

  // Automatically open Document PiP only when the local user starts screen sharing, and close on stop
  const prevLocalScreenShareRef = useRef(false);
  useEffect(() => {
    if (isLocalScreenSharing && !prevLocalScreenShareRef.current && isPipSupported && !isPipActive) {
      onOpenPip();
    } else if (!isLocalScreenSharing && prevLocalScreenShareRef.current && isPipActive) {
      onClosePip();
    }
    prevLocalScreenShareRef.current = isLocalScreenSharing;
  }, [isLocalScreenSharing, isPipSupported, isPipActive, onOpenPip, onClosePip]);

  return (
    <div className="lk-video-conference relative flex flex-row h-full w-full overflow-hidden">
      {/* Screen Share PiP Suggestion Banner (Only for local screen share) */}
      {isLocalScreenSharing && isPipSupported && !isPipActive && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex items-center gap-3 px-4 py-2 bg-indigo-950/90 hover:bg-indigo-900/90 border border-indigo-500/50 backdrop-blur-md rounded-2xl shadow-2xl text-white">
            <div className="flex items-center gap-2">
              <ScreenShare className="w-4 h-4 text-indigo-400 animate-pulse" />
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

      {/* Main Conference Area — hidden below `sm` while chat is open (phones can't fit a
          320px+ chat sidebar next to the video grid without squeezing the control bar off
          screen), so chat becomes a full-screen page you switch to and back from instead,
          matching the PiP window's video/chat tab behavior. */}
      <div
        className={`flex-1 h-full min-w-0 relative overflow-hidden ${
          showChat ? 'hidden sm:flex sm:flex-col' : 'flex flex-col'
        }`}
      >
        {/* `lk-video-conference-inner` supplies the flex column. The old
            `lk-grid-layout-wrapper` / `lk-focus-layout-wrapper` classes are gone on
            purpose: they hardcode `height: calc(100% - var(--lk-control-bar-height))`
            with a 69px control bar, while ours is ~57px, so they left 12px unused. */}
        <div className="lk-video-conference-inner h-full min-h-0">
          <div className="flex-1 min-h-0 relative">
            {layout.mode === 'grid' ? (
              <GridLayoutView
                tracks={layout.gridTracks}
                pinned={layout.pinned}
                onTogglePin={layout.togglePin}
              />
            ) : (
              <StageLayoutView
                stageTracks={layout.stageTracks}
                stripTracks={layout.stripTracks}
                pinned={layout.pinned}
                onTogglePin={layout.togglePin}
              />
            )}
          </div>
          {/* Control bar: Left (Mic & Camera), Center (overflow items + More), Right (Leave).
              Center items collapse into the "..." menu by priority once the bar is too
              narrow to fit everything (measured via ResizeObserver, not a viewport
              breakpoint, since the chat sidebar can squeeze this even on wide screens). */}
          <div className="shrink-0 px-3 sm:px-6 py-2.5 border-t border-gray-800/80 bg-gray-950/80 backdrop-blur-md">
            <div className="flex items-center justify-between w-full gap-2">
              {/* Left: Mic & Camera */}
              <div className="flex items-center gap-2 shrink-0">
                <MicButton mediaEnhancements={mediaEnhancements} />
                <CameraButton mediaEnhancements={mediaEnhancements} />
              </div>

              {/* Center: overflow items (Screen Share, Chat, ...) + More (PiP + collapsed items) */}
              <div ref={centerRef} className="flex items-center justify-center gap-2 flex-1 min-w-0">
                {visibleItems.map((item) => (
                  <Fragment key={item.key}>{item.renderBar()}</Fragment>
                ))}
                {(isPipSupported || collapsedItems.length > 0) && (
                  <MoreMenu
                    showPip={isPipSupported}
                    onOpenPip={onOpenPip}
                    isPipActive={isPipActive}
                    collapsedItems={collapsedItems}
                  />
                )}
              </div>

              {/* Right: Leave */}
              <div className="flex items-center gap-2 shrink-0">
                <LeaveButton />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Chat: docked sidebar on sm+ screens, full-screen page (with a back-to-video
          button) below `sm` — see the comment on the main conference area above. */}
      {showChat && (
        <aside className="w-full sm:w-80 md:w-96 h-full shrink-0 z-30 shadow-2xl animate-in slide-in-from-right duration-200">
          <AdvancedChat chat={chat} onBackToVideo={() => setShowChat(false)} />
        </aside>
      )}

      <RoomAudioRenderer />
      <ConnectionStateToast />

      <MiniRoomPanel
        isOpen={showMiniRoomPanel}
        onClose={() => setShowMiniRoomPanel(false)}
        isHost={isMiniRoomHost}
        mainRoomId={mainRoomId}
        miniRooms={miniRooms}
      />
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
  const { user, roles, roleIds } = useAuth();

  // Mini-room ("host") permission: for now the only people who can create mini rooms
  // are smiring_member users. This is also where future per-room capabilities (start
  // recording, force-enable screen share, ...) will hang off the same "host" concept.
  const isMiniRoomHost = roles.includes('smiring_member') || roleIds.includes(SMIRING_MEMBER_ROLE_ID);

  const miniRooms = useMiniRooms({ mainRoomId: roomId, selfIdentity: user?.id || '', isHost: isMiniRoomHost });

  // Safe to call inside <LiveKitRoom>. selfIdentity comes from the authenticated user id
  // (same value the backend issues as the LiveKit participant identity) rather than
  // localParticipant.identity, which is empty until the LiveKit connection completes.
  // Keyed off the *current* room (main or mini room) so each mini room gets its own
  // independent chat thread, exactly like any other Connect room would.
  const chat = useAdvancedChat({ roomId: miniRooms.currentRoomId, selfIdentity: user?.id || '' });

  const { localParticipant } = useLocalParticipant();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    // No `updateOnlyOn`: it *replaces* the default `allParticipantRoomEvents`, which
    // already contains ActiveSpeakersChanged along with TrackMuted/TrackUnmuted.
    // Narrowing it to ActiveSpeakersChanged alone therefore gained nothing and
    // silently dropped mute/unmute refreshes.
    { onlySubscribed: false },
  );

  // Owns layout mode, pins, speaker tracking and screen-share auto-focus. Replaces
  // LiveKit's single-track `LayoutContext` pin entirely. Lifted up to this level
  // (rather than inside `CustomVideoConference`) so the PiP window — a sibling, not a
  // descendant — can read the same pin state and show the same pinned people the
  // main window is showing.
  const layout = useCallLayout(tracks, localParticipant?.identity);

  // Document Picture-in-Picture Hook (Desktop Chrome etc.)
  const {
    isSupported: isDocumentPipSupported,
    isPipActive: isDocumentPipActive,
    pipWindow,
    openPip: openDocumentPip,
    closePip: closeDocumentPip,
  } = useDocumentPiP();

  // Active Speaker Video Picture-in-Picture Hook (Mobile / Video PiP fallback).
  // Native auto-PiP-on-tab-switch is only enabled where Document PiP isn't
  // available (mobile/Safari) — on desktop it would otherwise fight with the
  // manual PiP button, popping a mismatched raw-video window instead of the
  // custom DocumentPipContent UI.
  const {
    isVideoPipSupported,
    isVideoPipActive,
    requestVideoPip,
    exitVideoPip,
  } = useActiveSpeakerVideoPip({ enableAutoPip: !isDocumentPipSupported });

  const isPipSupported = isDocumentPipSupported || isVideoPipSupported;
  const isPipActive = isDocumentPipActive || isVideoPipActive;

  const handleOpenPip = useCallback(() => {
    if (isDocumentPipSupported) {
      openDocumentPip({ width: 380, height: 620 });
    } else if (isVideoPipSupported) {
      requestVideoPip();
    }
  }, [isDocumentPipSupported, openDocumentPip, isVideoPipSupported, requestVideoPip]);

  const handleClosePip = useCallback(() => {
    if (isDocumentPipActive) {
      closeDocumentPip();
    } else if (isVideoPipActive) {
      exitVideoPip();
    }
  }, [isDocumentPipActive, closeDocumentPip, isVideoPipActive, exitVideoPip]);

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

          {/* Current mini room indicator — the badge above always stays the shareable
              main-room invite code, this just supplements it while inside a mini room. */}
          {!miniRooms.isInMainRoom && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-indigo-500/15 border border-indigo-500/30 rounded-md text-xs font-bold text-indigo-300 shrink-0">
              現在: {miniRooms.rooms.find((r) => r.id === miniRooms.currentRoomId)?.name ?? 'ミニルーム'}
            </span>
          )}
        </div>

        {/* Right: Layout Mode Selector */}
        <div className="flex items-center gap-2">
          <LayoutModeButton mode={layout.mode} onSelect={layout.setMode} />
        </div>
      </header>

      {/* Main Video Conference Area */}
      <div className="flex-1 relative overflow-hidden">
        <CustomVideoConference
          layout={layout}
          onOpenPip={handleOpenPip}
          onClosePip={handleClosePip}
          isPipSupported={isPipSupported}
          isPipActive={isPipActive}
          chat={chat}
          showChat={showChat}
          setShowChat={setShowChat}
          isMiniRoomHost={isMiniRoomHost}
          mainRoomId={roomId}
          miniRooms={miniRooms}
        />

        <MiniRoomMoveToast pendingMove={miniRooms.pendingMove} />

        {/* Render Document PiP Portal when active */}
        {isDocumentPipActive &&
          pipWindow &&
          createPortal(
            <DocumentPipContent
              roomTitle={roomTitle}
              onClose={closeDocumentPip}
              chat={chat}
              pinnedIds={layout.pinned}
            />,
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

  // Warn user with native browser dialog when trying to close the tab or leave during active call
  useEffect(() => {
    if (isDisconnected || !token || !serverUrl) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
      return '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDisconnected, token, serverUrl]);

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
      disconnectOnPageLeave: false,
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
      <div className="h-dvh w-screen bg-[#0f1115] flex flex-col items-center justify-center p-6 text-white text-center">
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
      <div className="h-dvh w-screen bg-[#0f1115] flex flex-col items-center justify-center gap-4 text-white">
        <Loader2 className="w-10 h-10 animate-spin text-indigo-500" />
        <p className="font-bold text-sm text-gray-300">ルームに接続しています...</p>
      </div>
    );
  }

  if (errorMsg || !token || !serverUrl) {
    return (
      <div className="h-dvh w-screen bg-[#0f1115] flex flex-col items-center justify-center p-6 text-white text-center">
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
    <div className="h-dvh w-screen bg-[#0f1115] flex flex-col overflow-hidden select-none" data-lk-theme="default">
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
