import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  LiveKitRoom,
  VideoConference,
  PreJoin,
  useLocalParticipant,
  type LocalUserChoices,
} from '@livekit/components-react';
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
import '@livekit/components-styles';
import { ArrowLeft, Video, AlertTriangle, Loader2, Copy, Check, Sparkles, Settings, Sliders, Volume2, X } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';

/**
 * Provides a media enhancements settings popover at the bottom-right of the video room.
 * Allows users to toggle Krisp AI Noise Cancellation and Background Blur ON/OFF.
 *
 * We evaluated alternatives to Krisp: server-side noise cancellation (Hetzner
 * LiveKit Agent) with DeepFilterNet (too CPU-heavy for the 2 vCPU box) and
 * DTLN (CPU-feasible but sounded worse than unprocessed audio), and
 * client-side DeepFilterNet3 via WASM (deepfilternet3-noise-filter — crashes
 * reliably with a WASM panic in this environment, unrelated to our code).
 * Krisp remains the best working option.
 */
function MediaEnhancements() {
  const { localParticipant } = useLocalParticipant();
  const [isOpen, setIsOpen] = useState(false);
  const [blurred, setBlurred] = useState(false);
  const [blurLoading, setBlurLoading] = useState(false);
  const [krispEnabled, setKrispEnabled] = useState(true);
  const [krispLoading, setKrispLoading] = useState(false);

  const isKrispSupported = isKrispNoiseFilterSupported();

  // Tracks which enabled-state is actually applied to which track instance,
  // so we don't tear down and recreate the processor every time
  // LocalTrackPublished fires (e.g. on every mute/unmute republish).
  const appliedRef = useRef<{ track: LocalAudioTrack | null; enabled: boolean | null }>({
    track: null,
    enabled: null,
  });

  const applyKrisp = useCallback(async (enabled: boolean, track: LocalAudioTrack) => {
    if (enabled) {
      if (!track.getProcessor()) {
        await track.setProcessor(KrispNoiseFilter());
      }
    } else if (track.getProcessor()) {
      await track.stopProcessor();
    }
  }, []);

  // Re-apply the desired Krisp state on mic track publish (e.g. device switch) —
  // but only if it isn't already applied to this exact track, see appliedRef above.
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

  const toggleBlur = useCallback(async () => {
    const pub = localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.track as LocalVideoTrack | undefined;
    if (!track) return;
    setBlurLoading(true);
    try {
      if (blurred) {
        await track.stopProcessor();
        setBlurred(false);
      } else {
        await track.setProcessor(BackgroundBlur(10));
        setBlurred(true);
      }
    } catch (e) {
      console.error('[Connect] failed to toggle background blur:', e);
    } finally {
      setBlurLoading(false);
    }
  }, [localParticipant, blurred]);

  return (
    <>
      {/* Floating Settings Button at Bottom-Right */}
      <div className="fixed bottom-5 right-5 z-40">
        <button
          onClick={() => setIsOpen((prev) => !prev)}
          className={`p-3 rounded-2xl shadow-xl backdrop-blur-md border transition-all duration-200 active:scale-95 flex items-center justify-center relative ${
            isOpen || blurred || krispEnabled
              ? 'bg-indigo-600/90 text-white border-indigo-400/50 hover:bg-indigo-600'
              : 'bg-gray-900/80 text-gray-200 border-gray-700/80 hover:bg-gray-800'
          }`}
          title="メディア設定 (ブラー / ノイズ除去)"
        >
          <Settings className={`w-5 h-5 transition-transform duration-300 ${isOpen ? 'rotate-90' : ''}`} />
          {(blurred || krispEnabled) && (
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-400 border-2 border-gray-900 rounded-full animate-pulse" />
          )}
        </button>
      </div>

      {/* Popover / Modal Panel */}
      {isOpen && (
        <>
          {/* Backdrop overlay */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          <div className="fixed bottom-20 right-5 z-50 w-80 bg-gray-900/95 border border-gray-700/80 backdrop-blur-xl rounded-2xl shadow-2xl p-5 text-white space-y-4 animate-in fade-in slide-in-from-bottom-3 duration-200">
            {/* Modal Header */}
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

            {/* Krisp AI Noise Cancellation Toggle */}
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

            {/* Background Blur Toggle */}
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
    </>
  );
}

type Phase = 'prejoin' | 'connecting' | 'in-room' | 'error';

export default function ConnectRoomPage() {
  const navigate = useNavigate();
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();

  const [phase, setPhase] = useState<Phase>('prejoin');
  const [token, setToken] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [roomTitle, setRoomTitle] = useState('');
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // Fetch room title info early if available
  useEffect(() => {
    if (!roomId) return;
    apiClient.get('/api/connect/rooms').then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        const found = data.rooms?.find((r: any) => r.room_id === roomId);
        if (found?.room_title) {
          setRoomTitle(found.room_title);
        }
      }
    }).catch(() => {});
  }, [roomId]);

  // Low-bitrate defaults; adaptiveStream/dynacast auto-scale to bandwidth.
  const roomOptions: RoomOptions = useMemo(
    () => ({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: VideoPresets.h360.resolution, // cap at 360p
        deviceId: choices?.videoDeviceId || undefined,
      },
      audioCaptureDefaults: {
        deviceId: choices?.audioDeviceId || undefined,
        // Native browser AEC/NS/AGC — this is what actually prevents howling
        // (it references the exact uncompressed local playback buffer, which
        // a server-side approach cannot access).
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      publishDefaults: {
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
        audioPreset: { maxBitrate: 32_000 }, // ~32kbps audio
        dtx: true, // skip silence
        red: true, // packet-loss resilience
      },
    }),
    [choices],
  );

  const preJoinDefaults = useMemo(
    () => ({
      username: user?.email?.split('@')[0] ?? 'guest',
      videoEnabled: true,
      audioEnabled: true,
    }),
    [user],
  );

  const handlePreJoinSubmit = useCallback(
    async (values: LocalUserChoices) => {
      if (!roomId) return;
      setChoices(values);
      setPhase('connecting');
      setErrorMsg('');
      try {
        const res = await apiClient.post('/api/connect/token', { room: roomId });

        if (res.status === 503) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(
            body.detail ||
              '通話サーバー（LiveKit）がまだ準備中です。カメラ・マイクの確認まではできています。',
          );
          setPhase('error');
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setErrorMsg(body.error || `トークンの取得に失敗しました (${res.status})`);
          setPhase('error');
          return;
        }

        const data = await res.json();
        setToken(data.token);
        setServerUrl(data.url);
        if (data.roomTitle) {
          setRoomTitle(data.roomTitle);
        }
        setPhase('in-room');
      } catch (e: any) {
        setErrorMsg(e?.message || '接続中にエラーが発生しました');
        setPhase('error');
      }
    },
    [roomId],
  );

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

  // In-call (full screen)
  if (phase === 'in-room' && token && serverUrl) {
    return (
      <div className="h-full w-full bg-[#0f1115] relative" data-lk-theme="default">
        {/* Top-left Room Title Header */}
        <div className="absolute top-4 left-4 z-40 flex items-center gap-2.5 bg-gray-900/85 border border-gray-700/80 backdrop-blur-md px-4 py-2 rounded-2xl text-white shadow-xl pointer-events-auto">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-black text-xs md:text-sm tracking-tight text-gray-100">
            {roomTitle || 'SmiRing Connect'}
          </span>
          <span className="text-[10px] font-mono text-gray-400 bg-gray-800/90 px-2 py-0.5 rounded-lg border border-gray-700">
            {roomId}
          </span>
        </div>

        <LiveKitRoom
          token={token}
          serverUrl={serverUrl}
          connect
          video={choices?.videoEnabled ?? true}
          audio={choices?.audioEnabled ?? true}
          options={roomOptions}
          onDisconnected={() => navigate('/connect')}
          onError={(e) => {
            setErrorMsg(e.message);
            setPhase('error');
          }}
          style={{ height: '100%' }}
        >
          <MediaEnhancements />
          <VideoConference />
        </LiveKitRoom>
      </div>
    );
  }

  // Shared shell for lobby / connecting / error
  return (
    <div className="min-h-full bg-slate-50/30 p-6 md:p-10 relative overflow-hidden">
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-indigo-400/5 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-sky-400/5 blur-[120px] pointer-events-none" />

      <div className="max-w-3xl mx-auto relative z-10">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-2 text-indigo-600 font-bold text-sm tracking-wide uppercase">
              <Video className="w-4 h-4" />
              <span>SmiRing Connect</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-gray-900 tracking-tight">
              {roomTitle ? roomTitle : 'ミーティングに参加'}
            </h1>
            {/* Room code */}
            <button
              onClick={copyRoomId}
              className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-200 hover:border-indigo-300 rounded-lg text-sm font-bold text-gray-600 transition-all active:scale-95"
              title="コードをコピー"
            >
              <span className="text-indigo-600">ルームコード:</span>
              <span className="font-mono">{roomId}</span>
              {copied ? (
                <Check className="w-4 h-4 text-emerald-500" />
              ) : (
                <Copy className="w-4 h-4 text-slate-400" />
              )}
            </button>
          </div>

          <button
            onClick={() => navigate('/connect')}
            className="self-start flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-600 font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all duration-200 active:scale-95"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>戻る</span>
          </button>
        </div>

        {/* Body */}
        <div className="bg-white border border-slate-100 rounded-3xl p-4 md:p-6 shadow-sm">
          {phase === 'prejoin' && (
            <div data-lk-theme="default" className="rounded-2xl overflow-hidden">
              <PreJoin
                defaults={preJoinDefaults}
                onSubmit={handlePreJoinSubmit}
                onError={(e) => setErrorMsg(e.message)}
                joinLabel="このルームに参加"
                micLabel="マイク"
                camLabel="カメラ"
                userLabel="表示名"
              />
            </div>
          )}

          {phase === 'connecting' && (
            <div className="flex flex-col items-center justify-center gap-4 py-20 text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
              <p className="font-bold text-sm">接続しています...</p>
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
              <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200">
                <AlertTriangle className="w-8 h-8 text-amber-500" />
              </div>
              <div>
                <p className="font-black text-gray-900 mb-1">まだ接続できません</p>
                <p className="text-sm text-gray-500 font-semibold max-w-md">{errorMsg}</p>
              </div>
              <div className="flex gap-3 mt-2">
                <button
                  onClick={() => {
                    setErrorMsg('');
                    setPhase('prejoin');
                  }}
                  className="px-5 py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white font-bold text-sm rounded-xl shadow-sm transition-all active:scale-95"
                >
                  もう一度試す
                </button>
                <button
                  onClick={() => navigate('/connect')}
                  className="px-5 py-2.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 font-bold text-sm rounded-xl shadow-sm transition-all active:scale-95"
                >
                  やめる
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
