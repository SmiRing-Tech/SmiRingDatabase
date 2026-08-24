import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  PreJoin,
  type LocalUserChoices,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { ArrowLeft, Video, AlertTriangle, Loader2, Copy, Check } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { useAuth } from '../../context/AuthContext';

type Phase = 'prejoin' | 'in-room' | 'error';

export default function ConnectRoomPage() {
  const navigate = useNavigate();
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();

  const [phase, setPhase] = useState<Phase>('prejoin');
  const [roomTitle, setRoomTitle] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // Profile data for default username (English name) and camera-off avatar
  const [defaultDisplayName, setDefaultDisplayName] = useState('');
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  // Fetch basic_profile_info to get English name & Avatar URL
  useEffect(() => {
    let isMounted = true;
    apiClient
      .get('/api/basic_profile_info/me')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const nameEn = data.name_english?.trim();
          const nameJp = data.name_kanji?.trim();
          const fallback = user?.email?.split('@')[0] ?? 'guest';
          if (isMounted) {
            setDefaultDisplayName(nameEn || nameJp || fallback);
            if (data.avatar_link) {
              setMyAvatarUrl(data.avatar_link);
            }
          }
        } else if (isMounted) {
          setDefaultDisplayName(user?.email?.split('@')[0] ?? 'guest');
        }
      })
      .catch(() => {
        if (isMounted) {
          setDefaultDisplayName(user?.email?.split('@')[0] ?? 'guest');
        }
      })
      .finally(() => {
        if (isMounted) {
          setProfileLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [user]);

  // Fetch room title info early if available
  useEffect(() => {
    if (!roomId) return;
    apiClient
      .get('/api/connect/rooms')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const found = data.rooms?.find((r: any) => r.room_id === roomId);
          if (found?.room_title) {
            setRoomTitle(found.room_title);
          }
        }
      })
      .catch(() => {});
  }, [roomId]);

  const preJoinDefaults = useMemo(
    () => ({
      username: defaultDisplayName || user?.email?.split('@')[0] || 'guest',
      videoEnabled: true,
      audioEnabled: true,
    }),
    [defaultDisplayName, user],
  );

  const handlePreJoinSubmit = useCallback(
    (values: LocalUserChoices) => {
      if (!roomId) return;
      try {
        sessionStorage.setItem(`smiring_connect_choices_${roomId}`, JSON.stringify(values));
      } catch (e) {
        console.warn('[Connect] Failed to save choices to sessionStorage:', e);
      }

      // Open call in a new tab without SmiRingDatabase shell
      window.open(`/connect/call/${roomId}`, '_blank');
      setPhase('in-room');
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

  // When room is opened in a new tab
  if (phase === 'in-room') {
    return (
      <div className="min-h-full bg-slate-50/30 p-6 md:p-10 flex items-center justify-center">
        <div className="max-w-md w-full bg-white border border-slate-100 rounded-3xl p-8 shadow-sm text-center">
          <div className="w-16 h-16 rounded-3xl bg-indigo-50 border border-indigo-100 flex items-center justify-center mx-auto mb-4">
            <Video className="w-8 h-8 text-indigo-600" />
          </div>
          <h2 className="text-2xl font-black text-gray-900 mb-2">別タブで通話を開始しました</h2>
          <p className="text-sm text-gray-500 mb-6">
            新しいタブでルーム「{roomTitle || roomId}」に接続しています。
          </p>
          <div className="space-y-3">
            <button
              onClick={() => window.open(`/connect/call/${roomId}`, '_blank')}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm rounded-xl shadow-sm transition-all active:scale-95 flex items-center justify-center gap-2"
            >
              <Video className="w-4 h-4" />
              <span>通話タブをもう一度開く</span>
            </button>
            <button
              onClick={() => navigate('/connect')}
              className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-gray-700 font-bold text-sm rounded-xl transition-all active:scale-95"
            >
              ルーム一覧に戻る
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Lobby (Prejoin)
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
            <div data-lk-theme="default" className="rounded-2xl overflow-hidden relative">
              {profileLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                  <p className="text-xs font-semibold">プロフィール情報を読み込み中...</p>
                </div>
              ) : (
                <>
                  {myAvatarUrl && (
                    <style>{`
                      .lk-prejoin .lk-video-container .lk-camera-off-note {
                        position: absolute !important;
                        inset: 0 !important;
                        width: 100% !important;
                        height: 100% !important;
                        display: flex !important;
                        align-items: center !important;
                        justify-content: center !important;
                        background-color: #0f1115 !important;
                      }
                      .lk-prejoin .lk-video-container .lk-camera-off-note > svg {
                        display: none !important;
                      }
                      .lk-prejoin .lk-video-container .lk-camera-off-note::after {
                        content: "" !important;
                        display: block !important;
                        width: 110px !important;
                        height: 110px !important;
                        background-image: url("${myAvatarUrl}") !important;
                        background-size: cover !important;
                        background-position: center !important;
                        border-radius: 1.5rem !important;
                        border: 2px solid rgba(255, 255, 255, 0.2) !important;
                        box-shadow: 0 12px 30px -6px rgba(0, 0, 0, 0.6) !important;
                      }
                    `}</style>
                  )}
                  <PreJoin
                    defaults={preJoinDefaults}
                    onSubmit={handlePreJoinSubmit}
                    onError={(e) => {
                      setErrorMsg(e.message);
                      setPhase('error');
                    }}
                    joinLabel="このルームに参加"
                    micLabel="マイク"
                    camLabel="カメラ"
                    userLabel="表示名"
                  />
                </>
              )}
            </div>
          )}

          {phase === 'error' && (
            <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
              <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200">
                <AlertTriangle className="w-8 h-8 text-amber-500" />
              </div>
              <div>
                <p className="font-black text-gray-900 mb-1">エラーが発生しました</p>
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
