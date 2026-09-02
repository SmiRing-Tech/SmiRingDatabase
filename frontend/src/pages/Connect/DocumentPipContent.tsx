import { useState, useMemo, useEffect, useRef } from 'react';
import {
  useLocalParticipant,
  useTracks,
  useSpeakingParticipants,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
  AudioTrack,
  TrackMutedIndicator,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
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
import ClampedVideoTrack from '../../components/Connect/callLayout/ClampedVideoTrack';
import { tileId } from '../../components/Connect/callLayout/tileIdentity';

interface DocumentPipContentProps {
  roomTitle?: string;
  onClose: () => void;
  chat: ReturnType<typeof useAdvancedChat>;
  /** Tile ids pinned in the main call window — see `useCallLayout`. Same identity
   *  scheme (`tileId`), so pins carry straight over without re-deriving them here. */
  pinnedIds: string[];
}

type PipLayoutMode = 'grid' | 'speaker';

function PipParticipantTile({
  trackRef,
  isSpeaking,
  isSmall,
}: {
  trackRef: TrackReferenceOrPlaceholder;
  isSpeaking?: boolean;
  isSmall?: boolean;
}) {
  // Declared before the `!participant` bail-out below: a hook after an early return
  // runs a different number of times depending on the branch taken, which React
  // rejects the moment the condition ever flips.
  const [imgError, setImgError] = useState(false);

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
    } catch {
      // Metadata is participant-controlled; unparseable just means no avatar.
    }
  }

  const isCameraOff =
    !isVideo || trackRef.publication?.isMuted || !trackRef.publication?.isSubscribed;

  const micPub = participant.getTrackPublication(Track.Source.Microphone);
  const isMicMuted = !micPub || micPub.isMuted || !micPub.isSubscribed;
  const isEffectivelySpeaking = Boolean(isSpeaking && !isMicMuted);

  const displayName = participant.name || participant.identity || '参加者';

  return (
    <div
      className={`group relative w-full h-full min-h-0 bg-slate-900 rounded-xl sm:rounded-2xl overflow-hidden border transition-all duration-200 flex flex-col items-center justify-center select-none ${
        isEffectivelySpeaking
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

      {/* Bottom Info Bar: Name + Mute status. Hidden by default to keep the PiP feed
          clean — surfaces on hover, or automatically while the person is speaking. */}
      <div
        className={`absolute bottom-1.5 left-1.5 right-1.5 flex items-center justify-between gap-1 px-2 py-0.5 sm:py-1 bg-gray-950/80 backdrop-blur-md rounded-md sm:rounded-lg border border-gray-800/70 text-white text-[10px] sm:text-xs z-10 transition-opacity duration-150 group-hover:opacity-100 ${
          isEffectivelySpeaking ? 'opacity-100' : 'opacity-0'
        }`}
      >
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
        {isEffectivelySpeaking && (
          <span className="flex h-1.5 w-1.5 sm:h-2 sm:w-2 relative shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 sm:h-2 sm:w-2 bg-emerald-500"></span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function DocumentPipContent({
  roomTitle,
  onClose,
  chat,
  pinnedIds,
}: DocumentPipContentProps) {
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

  // This PiP window is (re)created fresh each time it opens, which for the
  // screen-share auto-open case happens right as sharing starts — default to the
  // single/speaker view once so the shared screen is front and center instead of
  // one tile in a grid. A one-shot ref instead of layoutMode's initial state so a
  // manual grid choice made afterward isn't fought if this flips again.
  const hasFocusedOwnShareRef = useRef(false);
  useEffect(() => {
    if (isLocalScreenSharing && !hasFocusedOwnShareRef.current) {
      hasFocusedOwnShareRef.current = true;
      setLayoutMode('speaker');
    }
  }, [isLocalScreenSharing]);

  // Subscribe to all video tracks (camera & screen share)
  const rawTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    // See the matching note in CallRoomPage: `updateOnlyOn` replaces the default
    // event set, which already includes ActiveSpeakersChanged plus mute events.
    { onlySubscribed: false },
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

  // Filter tracks: apply hideSelf setting (own screen share is kept — this PiP
  // auto-opens specifically so the presenter can see what they're sharing)
  const filteredTracks = useMemo(() => {
    return rawTracks.filter((t) => {
      if (hideSelf && t.participant.identity === localParticipant?.identity) {
        return false;
      }
      return true;
    });
  }, [rawTracks, hideSelf, localParticipant?.identity]);

  // Determine active/speaker track for Speaker mode (or when compacted)
  const activeSpeakerTrack = useMemo(() => {
    // 1. While sharing our own screen, that's the whole reason this PiP is open —
    // always keep it in focus over anyone else speaking.
    if (isLocalScreenSharing) {
      const ownScreenShare = filteredTracks.find(
        (t) =>
          t.source === Track.Source.ScreenShare &&
          t.participant.identity === localParticipant?.identity,
      );
      if (ownScreenShare) return ownScreenShare;
    }

    // 2. If a remote speaker was actively talking, keep focus on them
    if (focusedRemoteSpeakerId) {
      const match = filteredTracks.find((t) => t.participant.identity === focusedRemoteSpeakerId);
      if (match) return match;
    }

    // 3. Or prefer remote screen share
    const remoteScreenShare = filteredTracks.find(
      (t) =>
        isTrackReference(t) &&
        t.source === Track.Source.ScreenShare &&
        t.participant.identity !== localParticipant?.identity,
    );
    if (remoteScreenShare) return remoteScreenShare;

    // 4. Or first remote participant
    const remoteTrack = filteredTracks.find(
      (t) => t.participant.identity !== localParticipant?.identity,
    );
    if (remoteTrack) return remoteTrack;

    // 5. Fallback to first available track (e.g. self if alone in room)
    return filteredTracks[0] || null;
  }, [isLocalScreenSharing, focusedRemoteSpeakerId, filteredTracks, localParticipant?.identity]);

  // Whichever of the pinned tracks are actually present in this window's own
  // (differently filtered) track list — a pin made in the main window before PiP
  // filtered out that participant (hideSelf) just resolves to nothing here rather
  // than crashing.
  const pinnedTracks = useMemo(() => {
    const pinnedSet = new Set(pinnedIds);
    return filteredTracks.filter((t) => pinnedSet.has(tileId(t)));
  }, [filteredTracks, pinnedIds]);

  // What the single/speaker view actually shows: pinned people if any, otherwise the
  // one auto-detected speaker. Pins take priority — once you've pinned someone in the
  // main window that's a standing choice, not something the active speaker should
  // override just because someone else happens to be talking right now.
  const stageTracks = useMemo(
    () => (pinnedTracks.length > 0 ? pinnedTracks : activeSpeakerTrack ? [activeSpeakerTrack] : []),
    [pinnedTracks, activeSpeakerTrack],
  );

  // Everyone else — including ourselves — as a small filmstrip below the stage in
  // speaker view, mirroring the main call window's stage+strip layout instead of
  // blanking out to just the one staged tile.
  const stripTracks = useMemo(() => {
    const stageIds = new Set(stageTracks.map(tileId));
    return filteredTracks.filter((t) => !stageIds.has(tileId(t)));
  }, [filteredTracks, stageTracks]);

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

          {/* Return to Call Tab Button (Looks like X, focuses main tab & closes PiP) */}
          <button
            onClick={() => {
              try {
                window.focus();
              } catch {}
              onClose();
            }}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 text-xs ml-0.5 transition-colors"
            title="通話に戻る"
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
          // Single / Speaker Focus View: the pinned people (or the one auto-detected
          // speaker) large on stage, everyone else — including ourselves — as a small
          // filmstrip below, mirroring the main call window's stage+strip layout.
          <div className="w-full h-full min-h-0 flex flex-col gap-1.5 overflow-hidden">
            <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden">
              {stageTracks.length > 0 ? (
                <div
                  className={`w-full h-full min-h-0 grid gap-1.5 ${
                    stageTracks.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
                  }`}
                >
                  {stageTracks.map((trackRef) => (
                    <div
                      key={tileId(trackRef)}
                      className="min-h-0 w-full h-full overflow-hidden flex items-center justify-center"
                    >
                      <PipParticipantTile
                        trackRef={trackRef}
                        isSpeaking={speakingParticipants.some(
                          (p) => p.identity === trackRef.participant.identity,
                        )}
                        isSmall={stageTracks.length > 1}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-gray-500 gap-2">
                  <Radio className="w-7 h-7 opacity-40 animate-pulse text-indigo-400" />
                  <p className="text-xs font-semibold">話者を待機中...</p>
                </div>
              )}
            </div>

            {/* Filmstrip: skip it in the compact-forced collapse — there's no room
                to spare once the window itself is this small. */}
            {!isCompact && stripTracks.length > 0 && (
              <div className="shrink-0 h-14 sm:h-16 flex gap-1.5 overflow-x-auto">
                {stripTracks.map((trackRef) => (
                  <div key={tileId(trackRef)} className="h-full aspect-video shrink-0">
                    <PipParticipantTile
                      trackRef={trackRef}
                      isSpeaking={speakingParticipants.some(
                        (p) => p.identity === trackRef.participant.identity,
                      )}
                      isSmall
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
