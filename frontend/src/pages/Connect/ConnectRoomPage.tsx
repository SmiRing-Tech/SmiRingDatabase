import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { ArrowLeft, Video, AlertTriangle, Loader2, Copy, Check, Sparkles } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';

/**
 * Applies Krisp AI noise cancellation to the local mic track as soon as it's
 * published, and exposes a toggle button for background blur on the camera
 * track. Rendered inside <LiveKitRoom> so it has access to RoomContext.
 */
function MediaEnhancements() {
  const { localParticipant } = useLocalParticipant();
  const [blurred, setBlurred] = useState(false);
  const [blurLoading, setBlurLoading] = useState(false);

  // Noise cancellation: apply once per mic track publish, no user toggle needed.
  useEffect(() => {
    if (!isKrispNoiseFilterSupported()) return;

    const applyToMicTrack = () => {
      const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
      const track = pub?.track as LocalAudioTrack | undefined;
      if (track && !track.getProcessor()) {
        track.setProcessor(KrispNoiseFilter());
      }
    };

    applyToMicTrack();
    localParticipant.on(ParticipantEvent.LocalTrackPublished, applyToMicTrack);
    return () => {
      localParticipant.off(ParticipantEvent.LocalTrackPublished, applyToMicTrack);
    };
  }, [localParticipant]);

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
    <button
      onClick={toggleBlur}
      disabled={blurLoading}
      className={`absolute top-3 right-3 z-10 flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold shadow-md transition-all active:scale-95 disabled:opacity-50 ${
        blurred
          ? 'bg-indigo-500 text-white'
          : 'bg-white/90 text-gray-700 hover:bg-white'
      }`}
    >
      <Sparkles className="w-3.5 h-3.5" />
      {blurLoading ? '切り替え中...' : blurred ? '背景ブラー: ON' : '背景ブラー: OFF'}
    </button>
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
  const [choices, setChoices] = useState<LocalUserChoices | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

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
              ミーティングに参加
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
