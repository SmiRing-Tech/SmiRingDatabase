import { useCallback, useEffect, useRef, useState } from 'react';
import { createLocalTracks, Track, type LocalAudioTrack, type LocalVideoTrack } from 'livekit-client';
import { Mic, MicOff, Video, VideoOff, Loader2, RotateCcw, Volume2 } from 'lucide-react';
import PreJoinBackgroundPanel from './PreJoinBackgroundPanel';
import { usePreJoinBackground } from '../../pages/Connect/usePreJoinBackground';
import { warmupGtcrnModel } from '../../lib/audio/gtcrn/GtcrnNoiseCancelTrack';
import { isMobileDevice } from '../../pages/Connect/backgroundLibrary';
import { useMicLevel, playSpeakerTestTone } from './audioTest';

const CUSTOM_USERNAME_KEY = 'smiring_connect_custom_username';

/**
 * Requested as `{ ideal: ... }` rather than LiveKit's `VideoPresets.h720.resolution`
 * shorthand, which flattens down to bare numeric constraints — bare numbers mean
 * "exact match required" per the WebRTC spec, not "aim for this". That's mostly
 * fine on the very first getUserMedia() call, but `stopProcessor()` re-applies the
 * same constraints to the live camera track when a background effect is turned
 * off, and an exact 16:9 match isn't always satisfiable a second time depending on
 * the camera/driver's state at that point — when it isn't, the browser has fallen
 * back to some other mode the device offers (observed as the preview clipping to a
 * square). `ideal` asks for the same thing without a hard failure mode.
 *
 * Mobile captures at 360p rather than 720p, matching the single, un-simulcast
 * publishEncoding CallRoomPage gives phones (see roomOptions there) — capturing
 * 720p just to immediately encode it down to 360p wastes exactly the CPU/battery
 * budget this is meant to save. See MOBILE_VIDEO_ENCODING's comment for the rest
 * of the reasoning.
 */
const VIDEO_CAPTURE_CONSTRAINTS: MediaTrackConstraints = isMobileDevice()
  ? {
      width: { ideal: 640 },
      height: { ideal: 360 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 30 },
    }
  : {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 30 },
    };

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
  /** アカウントを持たない参加者向け。trueの場合、表示名が空欄のまま参加しようとするとエラーを出し、'guest'等への暗黙のフォールバックはしない。 */
  requireUsername?: boolean;
  /** trueの場合、参加ボタンを押せなくする（例: 既に入室リクエスト送信済みで待機中）。カメラ・マイク・背景の調整は引き続き行える。 */
  submitDisabled?: boolean;
  /** submitDisabled=true のときにボタンへ表示する文言。 */
  submitDisabledLabel?: string;
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
  requireUsername = false,
  submitDisabled = false,
  submitDisabledLabel,
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
          video: VIDEO_CAPTURE_CONSTRAINTS as any,
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

  const { state: backgroundState, isReady: isBackgroundReady } = usePreJoinBackground(videoTrack);
  const [backgroundPanelOpen, setBackgroundPanelOpen] = useState(false);

  // Preloads the noise-cancel ONNX model while the user is still looking at this screen — see
  // warmupGtcrnModel's doc comment for why this is what actually fixes "mic looks on but nobody
  // can hear me" reports, rather than just being a nice-to-have speedup. Started unconditionally
  // on mount, not gated on audioTrack existing, so it runs in parallel with the getUserMedia()
  // permission prompt rather than after it.
  const [noiseCancelWarm, setNoiseCancelWarm] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // A slow/failed download must not strand the user unable to join at all.
    const timeout = setTimeout(() => {
      if (!cancelled) setNoiseCancelWarm(true);
    }, 8000);
    void warmupGtcrnModel().finally(() => {
      clearTimeout(timeout);
      if (!cancelled) setNoiseCancelWarm(true);
    });
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    console.log(
      `[PreJoinScreen t=${performance.now().toFixed(0)}ms] isBackgroundReady -> ${isBackgroundReady}`,
    );
  }, [isBackgroundReady]);

  const micLevel = useMicLevel(audioTrack);
  const [testingSpeaker, setTestingSpeaker] = useState(false);
  const handleTestSpeaker = useCallback(async () => {
    setTestingSpeaker(true);
    try {
      await playSpeakerTestTone();
    } finally {
      setTestingSpeaker(false);
    }
  }, []);

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
      await videoTrack.restartTrack({ deviceId, ...(VIDEO_CAPTURE_CONSTRAINTS as any) });
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

  const [nameError, setNameError] = useState('');

  const handleUsernameChange = (value: string) => {
    setUsername(value);
    if (nameError) setNameError('');
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
    const trimmed = username.trim();
    if (requireUsername && !trimmed) {
      setNameError('表示名を入力してください');
      return;
    }
    hasSubmittedRef.current = true;
    onSubmit(
      {
        username: trimmed || defaultUsername || 'guest',
        videoEnabled,
        audioEnabled,
        videoDeviceId,
        audioDeviceId,
      },
      videoTrack,
      audioTrack,
    );
  }, [
    onSubmit,
    username,
    requireUsername,
    defaultUsername,
    videoEnabled,
    audioEnabled,
    videoDeviceId,
    audioDeviceId,
    videoTrack,
    audioTrack,
  ]);

  // Block preview until videoTrack/audioTrack exist AND the background effect has
  // proven itself internally (polarity confidently detected + matte stabilized —
  // see MediapipeBackgroundProcessor.waitUntilReady()), not just "attached".
  const isVideoReady = !videoTrack || isBackgroundReady;
  // Only relevant when a mic track exists at all; noise-cancel itself only actually spins up
  // once the user is in the room (see useVadAutoGate) — this just makes sure its model is
  // already warm by then.
  const isAudioReady = !audioTrack || noiseCancelWarm;
  const ready = (!!videoTrack || !!audioTrack) && isVideoReady && isAudioReady;

  return (
    <div className="rounded-2xl overflow-hidden relative">
      <div className="relative aspect-video w-full max-w-[480px] mx-auto rounded-2xl overflow-hidden bg-[#0f1115]">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          className={`w-full h-full object-cover ${videoEnabled && ready ? '' : 'hidden'}`}
          style={{ transform: 'scaleX(-1)' }}
        />

        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400">
            <Loader2 className="w-8 h-8 animate-spin text-sky-500" />
            <p className="text-xs font-semibold">
              {!isVideoReady && !isAudioReady
                ? 'カメラとマイクを準備しています...'
                : !isVideoReady
                  ? 'カメラを準備しています...'
                  : 'マイクを準備しています...'}
            </p>
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
            className={`w-full box-border px-3.5 py-2.5 bg-slate-50 border rounded-xl text-sm font-semibold text-gray-900 focus:outline-none focus:ring-2 ${
              nameError
                ? 'border-rose-300 focus:ring-rose-100 focus:border-rose-400'
                : 'border-slate-200 focus:ring-sky-200 focus:border-sky-300'
            }`}
            placeholder="表示名を入力"
          />
          {nameError && <p className="mt-1.5 text-xs font-bold text-rose-500">{nameError}</p>}
          {isCustomName && defaultUsername && (
            <button
              type="button"
              onClick={handleResetToDefaultName}
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-bold text-sky-600 hover:text-sky-700"
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
              <div className="space-y-1">
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
                {/* Live input level — moves as you speak, so you can tell the mic is picking you up. */}
                <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-[width] duration-75"
                    style={{ width: `${Math.round(micLevel * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {audioDevices.length > 0 && (
          <button
            type="button"
            onClick={() => void handleTestSpeaker()}
            disabled={testingSpeaker}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-slate-50 hover:bg-slate-100 disabled:opacity-50 text-gray-600 border border-slate-200 font-bold text-xs rounded-xl transition-all active:scale-95"
          >
            <Volume2 className={`w-3.5 h-3.5 ${testingSpeaker ? 'animate-pulse text-sky-500' : ''}`} />
            <span>{testingSpeaker ? '再生中...' : 'スピーカーをテスト'}</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => setBackgroundPanelOpen((v) => !v)}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-slate-50 hover:bg-slate-100 text-gray-600 border border-slate-200 font-bold text-xs rounded-xl transition-all active:scale-95"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3.5 h-3.5"
          >
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
          <span>{backgroundPanelOpen ? '背景エフェクトを閉じる' : '背景エフェクトを設定'}</span>
        </button>

        <PreJoinBackgroundPanel open={backgroundPanelOpen} state={backgroundState} />

        <button
          type="button"
          onClick={handleJoin}
          disabled={!ready || submitDisabled}
          className="w-full py-3 bg-sky-600 hover:bg-sky-700 disabled:opacity-40 text-white font-bold text-sm rounded-xl shadow-sm transition-all active:scale-95"
        >
          {submitDisabled ? (submitDisabledLabel ?? joinLabel) : joinLabel}
        </button>
      </div>
    </div>
  );
}
