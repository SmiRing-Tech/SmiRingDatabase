import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  useLocalParticipant,
  useTracks,
  useSpeakingParticipants,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
  VideoTrack,
  AudioTrack,
  TrackMutedIndicator,
} from '@livekit/components-react';
import { Track, RoomEvent } from 'livekit-client';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  ScreenShareOff,
  LayoutGrid,
  Maximize2,
  Users,
  Eye,
  EyeOff,
  X,
  Radio,
  MessageSquare,
} from 'lucide-react';
import type { useAdvancedChat } from '../../hooks/useAdvancedChat';
import AdvancedChat from '../../components/Connect/AdvancedChat';

interface DocumentPipContentProps {
  roomTitle?: string;
  onClose: () => void;
  chat: ReturnType<typeof useAdvancedChat>;
}

type PipLayoutMode = 'grid' | 'speaker';

/**
 * Clamped Video Track:
 * Automatically detects whether the stream is landscape (PC) or portrait (mobile)
 * and clamps display aspect ratio between [native ratio] and [1:1 square], centering
 * vertically or horizontally as needed to prevent extreme crop/zoom.
 */
function ClampedVideoTrack({
  trackRef,
  className = '',
  isLocalMirror = false,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  className?: string;
  isLocalMirror?: boolean;
}) {
  if (!isTrackReference(trackRef)) return null;

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);
  const [nativeRatio, setNativeRatio] = useState<number | null>(null);

  const isScreenShare = trackRef.source === Track.Source.ScreenShare;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setContainerSize({ width, height });
        }
      }
    });

    observer.observe(el);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setContainerSize({ width: rect.width, height: rect.height });
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isTrackReference(trackRef)) {
      const dims = trackRef.publication?.dimensions;
      if (dims && dims.width > 0 && dims.height > 0) {
        setNativeRatio(dims.width / dims.height);
      }
    }
  }, [trackRef]);

  const onVideoLoadedMetadata = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setNativeRatio(video.videoWidth / video.videoHeight);
    }
  }, []);

  const videoStyle = useMemo<React.CSSProperties>(() => {
    if (!containerSize) {
      return { width: '100%', height: '100%' };
    }

    const { width: cW, height: cH } = containerSize;
    if (cW <= 0 || cH <= 0) return { width: '100%', height: '100%' };

    const cRatio = cW / cH;
    const rNative = nativeRatio ?? (isScreenShare ? 16 / 9 : 16 / 9);

    if (isScreenShare) {
      if (cRatio > rNative) {
        return {
          height: `${cH}px`,
          width: `${Math.floor(cH * rNative)}px`,
        };
      }
      return {
        width: `${cW}px`,
        height: `${Math.floor(cW / rNative)}px`,
      };
    }

    // Min and Max allowed aspect ratios:
    // Landscape video: [1:1, nativeRatio] -> max crop is 1:1 square
    // Portrait video:  [nativeRatio, 1:1] -> max crop is 1:1 square
    let rMin: number;
    let rMax: number;

    if (rNative >= 1.0) {
      rMin = 1.0;
      rMax = rNative;
    } else {
      rMin = rNative;
      rMax = 1.0;
    }

    let targetW = cW;
    let targetH = cH;

    if (cRatio < rMin) {
      targetW = cW;
      targetH = cW / rMin;
    } else if (cRatio > rMax) {
      targetH = cH;
      targetW = cH * rMax;
    } else {
      targetW = cW;
      targetH = cH;
    }

    return {
      width: `${Math.floor(targetW)}px`,
      height: `${Math.floor(targetH)}px`,
    };
  }, [containerSize, nativeRatio, isScreenShare]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 w-full h-full min-h-0 min-w-0 overflow-hidden flex items-center justify-center ${className}`}
    >
      <div
        style={videoStyle}
        className="relative overflow-hidden shrink-0 flex items-center justify-center rounded-xl sm:rounded-2xl"
      >
        <VideoTrack
          trackRef={trackRef}
          onLoadedMetadata={onVideoLoadedMetadata}
          className="w-full h-full object-cover"
          style={{ transform: isLocalMirror ? 'scaleX(-1)' : 'none' }}
        />
      </div>
    </div>
  );
}

function PipParticipantTile({
  trackRef,
  isSpeaking,
  isSmall,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  isSpeaking?: boolean;
  isSmall?: boolean;
}) {
  const participant = trackRef?.participant;
  if (!participant) return null;

  const isVideo =
    isTrackReference(trackRef) &&
    (trackRef.publication?.kind === 'video' ||
      trackRef.source === Track.Source.Camera ||
      trackRef.source === Track.Source.ScreenShare);
  const isScreenShare = trackRef.source === Track.Source.ScreenShare;

  let avatarUrl: string | null = null;
  if (participant.metadata) {
    try {
      const parsed = JSON.parse(participant.metadata);
      avatarUrl = parsed.avatar_url || null;
    } catch {}
  }

  const [imgError, setImgError] = useState(false);
  const isCameraOff =
    !isVideo || trackRef.publication?.isMuted || !trackRef.publication?.isSubscribed;

  const displayName = participant.name || participant.identity || '参加者';

  return (
    <div
      className={`relative w-full h-full min-h-0 bg-slate-900 rounded-xl sm:rounded-2xl overflow-hidden border transition-all duration-200 flex flex-col items-center justify-center select-none ${
        isSpeaking
          ? 'border-emerald-400 ring-2 ring-emerald-400/40 shadow-lg shadow-emerald-500/10'
          : 'border-slate-800/80 hover:border-slate-700'
      }`}
    >
      {/* Video stream with clamped aspect ratio */}
      {isVideo && (
        <ClampedVideoTrack
          trackRef={trackRef}
          isLocalMirror={participant.isLocal && !isScreenShare}
        />
      )}

      {/* Audio stream for audio-only track */}
      {!isVideo && isTrackReference(trackRef) && <AudioTrack trackRef={trackRef} />}

      {/* Camera Off Placeholder: Avatar or Icon */}
      {isCameraOff && !isScreenShare && (
        <div className="absolute inset-0 flex items-center justify-center p-2 bg-gradient-to-b from-slate-900 to-slate-950">
          {avatarUrl && !imgError ? (
            <div
              className={`rounded-xl sm:rounded-2xl overflow-hidden border-2 border-slate-700/80 shadow-xl bg-slate-800 flex items-center justify-center ${
                isSmall ? 'w-10 h-10' : 'w-14 h-14 sm:w-20 sm:h-20'
              }`}
            >
              <img
                src={avatarUrl}
                alt={displayName}
                className="w-full h-full object-cover"
                onError={() => setImgError(true)}
              />
            </div>
          ) : (
            <div
              className={`rounded-xl bg-slate-800/80 border border-slate-700 flex items-center justify-center text-slate-400 ${
                isSmall ? 'w-10 h-10' : 'w-14 h-14 sm:w-16 sm:h-16'
              }`}
            >
              <Users className={isSmall ? 'w-5 h-5 text-slate-500' : 'w-7 h-7 text-slate-500'} />
            </div>
          )}
        </div>
      )}

      {/* Bottom Info Bar: Name + Mute status */}
      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between gap-1 px-2 py-0.5 sm:py-1 bg-gray-950/80 backdrop-blur-md rounded-md sm:rounded-lg border border-gray-800/70 text-white text-[10px] sm:text-xs z-10">
        <div className="flex items-center gap-1 truncate max-w-[85%]">
          <TrackMutedIndicator
            trackRef={{
              participant: participant,
              source: Track.Source.Microphone,
            }}
            show="muted"
          />
          <span className="font-semibold truncate">
            {displayName}
            {isScreenShare && ' (共有中)'}
          </span>
        </div>
        {isSpeaking && (
          <span className="flex h-1.5 w-1.5 sm:h-2 sm:w-2 relative shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 sm:h-2 sm:w-2 bg-emerald-500"></span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function DocumentPipContent({ roomTitle, onClose, chat }: DocumentPipContentProps) {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const speakingParticipants = useSpeakingParticipants();

  const [currentTab, setCurrentTab] = useState<'video' | 'chat'>('video');
  const [showNotificationToast, setShowNotificationToast] = useState(false);

  const [layoutMode, setLayoutMode] = useState<PipLayoutMode>('grid');
  const [hideSelf, setHideSelf] = useState(false);
  const [focusedRemoteSpeakerId, setFocusedRemoteSpeakerId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Monitor physical PiP container dimensions using ResizeObserver (never relies on global window.innerWidth)
  const [containerDimensions, setContainerDimensions] = useState({
    width: 380,
    height: 600,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setContainerDimensions({ width, height });
        }
      }
    });

    observer.observe(el);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setContainerDimensions({ width: rect.width, height: rect.height });
    }

    return () => observer.disconnect();
  }, []);

  // Show toast notification when a new message arrives and user is in video mode
  useEffect(() => {
    if (
      chat.lastNotificationMessage &&
      chat.lastNotificationMessage.sender.identity !== localParticipant?.identity &&
      currentTab === 'video'
    ) {
      setShowNotificationToast(true);
      const timer = setTimeout(() => setShowNotificationToast(false), 4500);
      return () => clearTimeout(timer);
    }
  }, [chat.lastNotificationMessage, localParticipant?.identity, currentTab]);

  // Is window too small to fit multiple participants? (< 300px height or < 220px width)
  const isCompact = containerDimensions.height < 300 || containerDimensions.width < 220;

  // Check if local user is currently sharing screen
  const isLocalScreenSharing = localParticipant?.isScreenShareEnabled ?? false;

  // Subscribe to all video tracks (camera & screen share)
  const rawTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );

  // Update focused remote speaker only when another participant speaks (never switch focus to self when self speaks)
  useEffect(() => {
    const remoteSpeakers = speakingParticipants.filter(
      (p) => p.identity !== localParticipant?.identity,
    );
    if (remoteSpeakers.length > 0) {
      setFocusedRemoteSpeakerId(remoteSpeakers[0].identity);
    }
  }, [speakingParticipants, localParticipant?.identity]);

  // Filter tracks: Exclude own screen share and apply hideSelf setting
  const filteredTracks = useMemo(() => {
    return rawTracks.filter((t) => {
      // Never display own screen share inside PiP
      if (
        t.source === Track.Source.ScreenShare &&
        t.participant.identity === localParticipant?.identity
      ) {
        return false;
      }
      if (hideSelf && t.participant.identity === localParticipant?.identity) {
        return false;
      }
      return true;
    });
  }, [rawTracks, hideSelf, localParticipant?.identity]);

  // Determine active/speaker track for Speaker mode (or when compacted)
  const activeSpeakerTrack = useMemo(() => {
    // 1. If a remote speaker was actively talking, keep focus on them
    if (focusedRemoteSpeakerId) {
      const match = filteredTracks.find((t) => t.participant.identity === focusedRemoteSpeakerId);
      if (match) return match;
    }

    // 2. Or prefer remote screen share
    const remoteScreenShare = filteredTracks.find(
      (t) =>
        isTrackReference(t) &&
        t.source === Track.Source.ScreenShare &&
        t.participant.identity !== localParticipant?.identity,
    );
    if (remoteScreenShare) return remoteScreenShare;

    // 3. Or first remote participant
    const remoteTrack = filteredTracks.find(
      (t) => t.participant.identity !== localParticipant?.identity,
    );
    if (remoteTrack) return remoteTrack;

    // 4. Fallback to first available track (e.g. self if alone in room)
    return filteredTracks[0] || null;
  }, [focusedRemoteSpeakerId, filteredTracks, localParticipant?.identity]);

  // Actions
  const toggleMic = async () => {
    if (!localParticipant) return;
    try {
      await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
    } catch (e) {
      console.error('[PiP] Failed to toggle microphone:', e);
    }
  };

  const toggleCam = async () => {
    if (!localParticipant) return;
    try {
      await localParticipant.setCameraEnabled(!isCameraEnabled);
    } catch (e) {
      console.error('[PiP] Failed to toggle camera:', e);
    }
  };

  const handleStopScreenShare = async () => {
    if (!localParticipant) return;
    try {
      await localParticipant.setScreenShareEnabled(false);
    } catch (e) {
      console.error('[PiP] Failed to stop screen share:', e);
    } finally {
      onClose();
    }
  };

  // Determine effective display layout:
  // If window is very compact, automatically collapse to 1 person (activeSpeakerTrack)
  const displayAsSingle = isCompact || layoutMode === 'speaker';

  // Grid layout: Strictly prioritizes vertical stack (1 column) based on container width
  const gridStyle = useMemo(() => {
    const count = displayAsSingle ? 1 : filteredTracks.length;
    if (count <= 1) {
      return {
        gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
        gridTemplateRows: 'repeat(1, minmax(0, 1fr))',
      };
    }

    let cols = 1;
    if (!displayAsSingle) {
      if (containerDimensions.width >= 800) {
        cols = Math.min(3, count);
      } else if (containerDimensions.width >= 500) {
        cols = Math.min(2, count);
      } else {
        cols = 1;
      }
    }

    const rows = Math.ceil(count / cols);

    return {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
    };
  }, [displayAsSingle, filteredTracks.length, containerDimensions.width]);

  // If in Chat mode, render full-screen AdvancedChat within PiP window
  if (currentTab === 'chat') {
    return (
      <div ref={containerRef} className="w-full h-screen bg-[#0b0d11] text-gray-100 flex flex-col select-none overflow-hidden font-sans">
        <AdvancedChat
          chat={chat}
          onBackToVideo={() => setCurrentTab('video')}
          isCompact={isCompact}
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-screen bg-[#0b0d11] text-gray-100 flex flex-col select-none overflow-hidden font-sans relative">
      {/* Toast Notification for incoming chat message while in Video view */}
      {showNotificationToast && chat.lastNotificationMessage && (
        <div
          onClick={() => {
            chat.setActiveThreadId(chat.lastNotificationMessage!.threadId);
            setCurrentTab('chat');
            setShowNotificationToast(false);
          }}
          className="absolute top-11 left-2 right-2 z-50 bg-gray-950/95 border border-indigo-500/70 p-2.5 rounded-2xl shadow-2xl backdrop-blur-md flex items-center gap-2 cursor-pointer hover:bg-gray-900 transition-all animate-in fade-in slide-in-from-top-2 duration-200"
        >
          <div className="w-6 h-6 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0 shadow-md">
            <MessageSquare className="w-3.5 h-3.5 text-white" />
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="text-[10px] font-bold text-indigo-400 truncate">
              {chat.lastNotificationMessage.sender.name}
            </p>
            <p className="text-xs text-white truncate font-medium">
              {chat.lastNotificationMessage.text}
            </p>
          </div>
          <span className="text-[10px] text-indigo-400 font-bold shrink-0">開く</span>
        </div>
      )}

      {/* Top Bar: Room info & Layout Controls */}
      <header className="h-9 shrink-0 bg-gray-950/90 border-b border-gray-800/80 px-2.5 flex items-center justify-between gap-1.5 z-20">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
          <span className="font-bold text-xs text-gray-200 truncate max-w-[100px] sm:max-w-[150px]">
            {roomTitle || 'ミーティング'}
          </span>
        </div>

        {/* Layout Switchers */}
        <div className="flex items-center gap-0.5 sm:gap-1">
          {/* Grid Layout Button */}
          <button
            onClick={() => setLayoutMode('grid')}
            className={`p-1 rounded-lg text-xs transition-colors flex items-center gap-1 ${
              layoutMode === 'grid' && !isCompact
                ? 'bg-indigo-600/90 text-white font-bold'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
            title="グリッド表示（全員）"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>

          {/* Speaker Focus Button */}
          <button
            onClick={() => setLayoutMode('speaker')}
            className={`p-1 rounded-lg text-xs transition-colors flex items-center gap-1 ${
              layoutMode === 'speaker' || isCompact
                ? 'bg-indigo-600/90 text-white font-bold'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
            title="スピーカー表示（話者のみ）"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>

          {/* Hide / Show Self Button */}
          <button
            onClick={() => setHideSelf((prev) => !prev)}
            className={`p-1 rounded-lg text-xs transition-colors ${
              hideSelf
                ? 'bg-amber-600/80 text-white font-bold'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
            title={hideSelf ? '自分を表示する' : '自分を非表示にする'}
          >
            {hideSelf ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>

          {/* Close PiP Window Button */}
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 text-xs ml-0.5 transition-colors"
            title="PiPを閉じる"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Main View Area */}
      <main className="flex-1 p-1.5 overflow-hidden relative min-h-0 flex flex-col items-center justify-center">
        {!displayAsSingle ? (
          // Grid View: Dynamically sized to fill all available space prioritizing vertical stack
          <div className="grid gap-1.5 w-full h-full min-h-0" style={gridStyle}>
            {filteredTracks.map((trackRef) => {
              const isSpeaking = speakingParticipants.some(
                (p) => p.identity === trackRef.participant.identity,
              );
              return (
                <div
                  key={`${trackRef.participant.identity}_${trackRef.source}`}
                  className="min-h-0 h-full w-full overflow-hidden flex items-center justify-center"
                >
                  <PipParticipantTile
                    trackRef={trackRef}
                    isSpeaking={isSpeaking}
                    isSmall={filteredTracks.length > 2}
                  />
                </div>
              );
            })}
            {filteredTracks.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-1">
                <Users className="w-6 h-6 opacity-40" />
                <p className="text-xs font-semibold">参加者がいません</p>
              </div>
            )}
          </div>
        ) : (
          // Single / Speaker Focus View: Maximizes tile area to prevent distortion at small sizes
          <div className="w-full h-full min-h-0 flex flex-col gap-1.5 overflow-hidden">
            {activeSpeakerTrack ? (
              <div className="flex-1 w-full min-h-0 overflow-hidden flex items-center justify-center">
                <PipParticipantTile
                  trackRef={activeSpeakerTrack}
                  isSpeaking={speakingParticipants.some(
                    (p) => p.identity === activeSpeakerTrack.participant.identity,
                  )}
                  isSmall={false}
                />
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-500 gap-2">
                <Radio className="w-7 h-7 opacity-40 animate-pulse text-indigo-400" />
                <p className="text-xs font-semibold">話者を待機中...</p>
              </div>
            )}

            {/* Thumbnail row for others only when not in compact mode */}
            {!isCompact && filteredTracks.length > 1 && (
              <div className="h-16 shrink-0 flex gap-1 overflow-x-auto pb-0.5 justify-center">
                {filteredTracks
                  .filter((t) => t !== activeSpeakerTrack)
                  .map((trackRef) => (
                    <div
                      key={`${trackRef.participant.identity}_${trackRef.source}`}
                      className="w-20 h-full shrink-0 min-h-0 flex items-center justify-center"
                    >
                      <PipParticipantTile
                        trackRef={trackRef}
                        isSpeaking={speakingParticipants.some(
                          (p) => p.identity === trackRef.participant.identity,
                        )}
                        isSmall={true}
                      />
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Floating Bottom Control Bar */}
      <footer className="h-12 shrink-0 bg-gray-950/95 border-t border-gray-800/90 px-3 flex items-center justify-center gap-2.5 z-30">
        {/* Mic Toggle */}
        <button
          onClick={toggleMic}
          className={`p-2 rounded-xl border transition-all active:scale-90 flex items-center justify-center ${
            isMicrophoneEnabled
              ? 'bg-slate-800/90 text-white border-slate-700 hover:bg-slate-700'
              : 'bg-rose-500/20 text-rose-400 border-rose-500/50 hover:bg-rose-500/30'
          }`}
          title={isMicrophoneEnabled ? 'マイクをミュート' : 'マイクをオン'}
        >
          {isMicrophoneEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
        </button>

        {/* Cam Toggle */}
        <button
          onClick={toggleCam}
          className={`p-2 rounded-xl border transition-all active:scale-90 flex items-center justify-center ${
            isCameraEnabled
              ? 'bg-slate-800/90 text-white border-slate-700 hover:bg-slate-700'
              : 'bg-rose-500/20 text-rose-400 border-rose-500/50 hover:bg-rose-500/30'
          }`}
          title={isCameraEnabled ? 'カメラをオフ' : 'カメラをオン'}
        >
          {isCameraEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
        </button>

        {/* Chat Toggle Button with Notification Badge */}
        <button
          onClick={() => setCurrentTab('chat')}
          className="relative p-2 rounded-xl border border-slate-700 bg-slate-800/90 text-white hover:bg-slate-700 transition-all active:scale-90 flex items-center justify-center"
          title="チャットを開く"
        >
          <MessageSquare className="w-4 h-4 text-indigo-300" />
          {chat.totalUnreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 bg-rose-500 text-white text-[9px] font-bold rounded-full border-2 border-gray-950 flex items-center justify-center animate-pulse">
              {chat.totalUnreadCount}
            </span>
          )}
        </button>

        {/* Stop Screen Share Button (Rendered ONLY when local user is sharing screen) */}
        {isLocalScreenSharing && (
          <button
            onClick={handleStopScreenShare}
            className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-lg shadow-rose-900/30 transition-all active:scale-90 animate-in fade-in zoom-in-95 duration-200"
            title="画面共有を停止してPiPを閉じる"
          >
            <ScreenShareOff className="w-3.5 h-3.5" />
            <span>共有停止</span>
          </button>
        )}
      </footer>
    </div>
  );
}
