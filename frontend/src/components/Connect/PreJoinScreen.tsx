import { useCallback, useEffect, useRef, useState } from 'react';
import { createLocalTracks, Track, VideoPresets, type LocalAudioTrack, type LocalVideoTrack } from 'livekit-client';
import { Mic, MicOff, Video, VideoOff, Loader2, RotateCcw } from 'lucide-react';
import PreJoinBackgroundPanel from './PreJoinBackgroundPanel';
import { usePreJoinBackground } from '../../pages/Connect/usePreJoinBackground';

const CUSTOM_USERNAME_KEY = 'smiring_connect_custom_username';

export interface PreJoinChoices {
  username: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoDeviceId?: string;
  audioDeviceId?: string;
}

interface PreJoinScreenProps {
  defaultUsername: string;
  avatarUrl: string | null;
  joinLabel?: string;
  /**
   * Fires once, when the user clicks join. Hands the already-created (and, if a
   * background effect is selected, already-processed) tracks up to the caller —
   * ownership transfers here, this component will not stop them on unmount after
   * this fires. `videoTrack`/`audioTrack` are null only if that device was toggled
   * off before joining.
   */
  onSubmit: (
    choices: PreJoinChoices,
    videoTrack: LocalVideoTrack | null,
    audioTrack: LocalAudioTrack | null,
  ) => void;
  /** A single getUserMedia() call failed (permission denied, no device, etc). */
  onError: (e: Error) => void;
}

/**
 * Self-built replacement for LiveKit's `<PreJoin>`.
 *
 * `<PreJoin>` never exposes the camera/mic MediaStreamTracks it captures for its
 * preview — only a `videoProcessor` prop hooks into it — so whatever it captures
 * has to be thrown away and recaptured for the actual call. On browsers/devices set
 * to always ask for camera/mic permission, that shows the permission prompt twice,
 * and re-attaching a background-effect processor to the *second* capture after it's
 * already on screen is what causes the black-preview bug documented in
 * `useBackgroundEffect.ts`.
 *
 * This component creates the real tracks itself (one combined `getUserMedia()` call
 * — see `createLocalTracks`) and hands them to `onSubmit` on join, so the caller can
 * carry the exact same, already-processed tracks into the call instead of
 * recapturing.
 */
export default function PreJoinScreen({
  defaultUsername,
  avatarUrl,
  joinLabel = 'このルームに参加',
  onSubmit,
  onError,
}: PreJoinScreenProps) {
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const [videoTrack, setVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [audioTrack, setAudioTrack] = useState<LocalAudioTrack | null>(null);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoDeviceId, setVideoDeviceId] = useState<string | undefined>();
  const [audioDeviceId, setAudioDeviceId] = useState<string | undefined>();
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);

  const hasSubmittedRef = useRef(false);

  // One combined getUserMedia() call for the whole session — the tracks created
  // here are the exact ones published for the call (see PreJoinScreen's doc
  // comment above and `onSubmit`).
  useEffect(() => {
    let cancelled = false;
    let localVideo: LocalVideoTrack | null = null;
    let localAudio: LocalAudioTrack | null = null;

    void (async () => {
      try {
        const tracks = await createLocalTracks({
          video: { resolution: VideoPresets.h360.resolution },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        for (const t of tracks) {
          if (t.kind === Track.Kind.Video) localVideo = t as LocalVideoTrack;
          if (t.kind === Track.Kind.Audio) localAudio = t as LocalAudioTrack;
        }
        if (cancelled) {
          tracks.forEach((t) => t.stop());
          return;
        }
        setVideoTrack(localVideo);
        setAudioTrack(localAudio);
        if (localVideo) setVideoDeviceId(localVideo.mediaStreamTrack.getSettings().deviceId);
        if (localAudio) setAudioDeviceId(localAudio.mediaStreamTrack.getSettings().deviceId);
      } catch (e) {
        if (!cancelled) {
          onErrorRef.current(
            e instanceof Error ? e : new Error('カメラ・マイクを起動できませんでした'),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      if (hasSubmittedRef.current) return; // ownership handed to the caller on submit
      const v = localVideo;
      const a = localAudio;
      void (async () => {
        if (v?.getProcessor()) await v.stopProcessor().catch(() => {});
        v?.stop();
        a?.stop();
      })();
    };
    // Runs once for the lifetime of this screen — device switches use restartTrack
    // on the same track instead of recreating it (see handleVideoDeviceChange).
  }, []);

  // Device labels are only populated once permission is granted, so enumerate
  // after the tracks above resolve rather than on mount.
  useEffect(() => {
    if (!videoTrack && !audioTrack) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setVideoDevices(devices.filter((d) => d.kind === 'videoinput'));
        setAudioDevices(devices.filter((d) => d.kind === 'audioinput'));
      })
      .catch(() => {});
  }, [videoTrack, audioTrack]);

  // Live preview.
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!videoTrack || !el) return;
    videoTrack.attach(el);
    return () => {
      videoTrack.detach(el);
    };
  }, [videoTrack]);

  const { state: backgroundState } = usePreJoinBackground(videoTrack);
  const [backgroundPanelOpen, setBackgroundPanelOpen] = useState(false);

  const toggleVideo = useCallback(async () => {
    if (!videoTrack) return;
    if (videoEnabled) await videoTrack.mute();
    else await videoTrack.unmute();
    setVideoEnabled((v) => !v);
  }, [videoTrack, videoEnabled]);

  const toggleAudio = useCallback(async () => {
    if (!audioTrack) return;
    if (audioEnabled) await audioTrack.mute();
    else await audioTrack.unmute();
    setAudioEnabled((v) => !v);
  }, [audioTrack, audioEnabled]);

  const handleVideoDeviceChange = useCallback(
    async (deviceId: string) => {
      if (!videoTrack) return;
      await videoTrack.restartTrack({ deviceId, resolution: VideoPresets.h360.resolution });
      setVideoDeviceId(deviceId);
    },
    [videoTrack],
  );

  const handleAudioDeviceChange = useCallback(
    async (deviceId: string) => {
      if (!audioTrack) return;
      await audioTrack.restartTrack({
        deviceId,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      setAudioDeviceId(deviceId);
    },
    [audioTrack],
  );

  // Username: defaults to the profile name, remembers a manually-typed override in
  // localStorage (matches the account across rooms, same key ConnectRoomPage used).
  // `defaultUsername` starts as '' and arrives once the profile fetch resolves, so
  // this has to re-derive when it changes — done during render (React's documented
  // pattern for resetting state from a prop) rather than in an effect, since an
  // effect would commit the stale value for one extra render first.
  const usernameFromStorage = (name: string): string => {
    if (!name) return '';
    try {
      const saved = localStorage.getItem(CUSTOM_USERNAME_KEY);
      if (saved && saved.trim() && saved.trim() !== name) return saved.trim();
    } catch {
      /* ignore */
    }
    return name;
  };

  const [lastDefaultUsername, setLastDefaultUsername] = useState(defaultUsername);
  const [username, setUsername] = useState(() => usernameFromStorage(defaultUsername));
  const [isCustomName, setIsCustomName] = useState(
    () => !!defaultUsername && usernameFromStorage(defaultUsername) !== defaultUsername,
  );

  if (defaultUsername !== lastDefaultUsername) {
    setLastDefaultUsername(defaultUsername);
    const next = usernameFromStorage(defaultUsername);
    setUsername(next);
    setIsCustomName(!!defaultUsername && next !== defaultUsername);
  }

  const handleUsernameChange = (value: string) => {
    setUsername(value);
    const trimmed = value.trim();
    const nextIsCustom = Boolean(defaultUsername && trimmed && trimmed !== defaultUsername);
    setIsCustomName(nextIsCustom);
    try {
      if (nextIsCustom) localStorage.setItem(CUSTOM_USERNAME_KEY, trimmed);
      else localStorage.removeItem(CUSTOM_USERNAME_KEY);
    } catch {
      /* ignore */
    }
  };

  const handleResetToDefaultName = () => {
    try {
      localStorage.removeItem(CUSTOM_USERNAME_KEY);
    } catch {
      /* ignore */
    }
    setUsername(defaultUsername);
    setIsCustomName(false);
  };

  const handleJoin = useCallback(() => {
    hasSubmittedRef.current = true;
    onSubmit(
      {
        username: username.trim() || defaultUsername || 'guest',
        videoEnabled,
        audioEnabled,
        videoDeviceId,
        audioDeviceId,
      },
      videoTrack,
      audioTrack,
    );
  }, [onSubmit, username, defaultUsername, videoEnabled, audioEnabled, videoDeviceId, audioDeviceId, videoTrack, audioTrack]);

  const ready = !!videoTrack || !!audioTrack;

  return (
    <div className="rounded-2xl overflow-hidden relative">
      <div className="relative aspect-video w-full max-w-[480px] mx-auto rounded-2xl overflow-hidden bg-[#0f1115]">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className={`w-full h-full object-cover ${videoEnabled ? '' : 'hidden'}`}
          style={{ transform: 'scaleX(-1)' }}
        />

        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
            <p className="text-xs font-semibold">カメラを準備しています...</p>
          </div>
        )}

        {ready && !videoEnabled && (
          <div className="absolute inset-0 flex items-center justify-center">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                className="w-28 h-28 rounded-3xl object-cover border-2 border-white/20 shadow-2xl"
              />
            ) : (
              <VideoOff className="w-10 h-10 text-gray-500" />
            )}
          </div>
        )}

        {ready && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-3">
            <button
              type="button"
              onClick={toggleAudio}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-95 ${
                audioEnabled
                  ? 'bg-white/15 hover:bg-white/25 text-white'
                  : 'bg-rose-500/90 hover:bg-rose-500 text-white'
              }`}
              title={audioEnabled ? 'マイクをオフ' : 'マイクをオン'}
            >
              {audioEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={toggleVideo}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-95 ${
                videoEnabled
                  ? 'bg-white/15 hover:bg-white/25 text-white'
                  : 'bg-rose-500/90 hover:bg-rose-500 text-white'
              }`}
              title={videoEnabled ? 'カメラをオフ' : 'カメラをオン'}
            >
              {videoEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
            </button>
          </div>
        )}
      </div>

      <div className="max-w-[480px] mx-auto mt-4 px-1 space-y-3">
        <div>
          <label className="block text-xs font-bold text-gray-500 mb-1.5">表示名</label>
          <input
            type="text"
            name="smiring_connect_display_name_no_autofill"
            autoComplete="one-time-code"
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => handleUsernameChange(e.target.value)}
            className="w-full box-border px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
            placeholder="表示名を入力"
          />
          {isCustomName && defaultUsername && (
            <button
              type="button"
              onClick={handleResetToDefaultName}
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-700"
            >
              <RotateCcw className="w-3 h-3" />
              <span>デフォルト（{defaultUsername}）に戻す</span>
            </button>
          )}
        </div>

        {(videoDevices.length > 0 || audioDevices.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {videoDevices.length > 0 && (
              <select
                value={videoDeviceId}
                onChange={(e) => handleVideoDeviceChange(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-gray-700 focus:outline-none"
              >
                {videoDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'カメラ'}
                  </option>
                ))}
              </select>
            )}
            {audioDevices.length > 0 && (
              <select
                value={audioDeviceId}
                onChange={(e) => handleAudioDeviceChange(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-gray-700 focus:outline-none"
              >
                {audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'マイク'}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handleJoin}
          disabled={!ready}
          className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white font-bold text-sm rounded-xl shadow-sm transition-all active:scale-95"
        >
          {joinLabel}
        </button>

        <button
          type="button"
          onClick={() => setBackgroundPanelOpen((v) => !v)}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-white hover:bg-indigo-50 text-indigo-600 hover:text-indigo-700 border border-slate-200 hover:border-indigo-200 font-bold text-sm rounded-xl shadow-xs transition-all active:scale-95"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
          <span>{backgroundPanelOpen ? '背景エフェクトを閉じる' : '背景エフェクトを設定'}</span>
        </button>

        <PreJoinBackgroundPanel open={backgroundPanelOpen} state={backgroundState} />
      </div>
    </div>
  );
}
