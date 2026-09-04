import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  PreJoin,
  type LocalUserChoices,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { ArrowLeft, Video, AlertTriangle, Loader2, Copy, Check } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import PreJoinBackgroundDialog from '../../components/Connect/PreJoinBackgroundDialog';
import { useAuth } from '../../context/AuthContext';

type Phase = 'prejoin' | 'in-room' | 'error';

const CUSTOM_USERNAME_KEY = 'smiring_connect_custom_username';

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
  const prejoinContainerRef = useRef<HTMLDivElement>(null);

  // PreJoin (this component's library internals) never exposes the camera/mic
  // MediaStreams it captures for the device preview, and only releases them on
  // unmount. Since the call opens in a new tab (window.open), that unmount
  // happens asynchronously, after the new tab already starts its own capture
  // of the same devices. Mobile OS audio stacks handle that overlap badly
  // (silent mic in the new tab), so track every stream ourselves via a
  // getUserMedia interceptor and stop them explicitly before opening the tab.
  const activeMediaStreamsRef = useRef<Set<MediaStream>>(new Set());

  useEffect(() => {
    if (phase !== 'prejoin') return;

    const mediaDevices = navigator.mediaDevices;
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.getUserMedia = async (constraints?: MediaStreamConstraints) => {
      const stream = await originalGetUserMedia(constraints);
      activeMediaStreamsRef.current.add(stream);
      return stream;
    };

    return () => {
      mediaDevices.getUserMedia = originalGetUserMedia;
    };
  }, [phase]);

  const stopPreJoinPreviewTracks = useCallback(() => {
    activeMediaStreamsRef.current.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    activeMediaStreamsRef.current.clear();
  }, []);

  // Fetch basic_profile_info to get English name & Avatar URL
  const userEmail = user?.email;
  useEffect(() => {
    let isMounted = true;
    apiClient
      .get('/api/basic_profile_info/me')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          const nameEn = data.name_english?.trim();
          const nameJp = data.name_kanji?.trim();
          const fallback = userEmail?.split('@')[0] ?? 'guest';
          if (isMounted) {
            const profileName = nameEn || nameJp || fallback;
            setDefaultDisplayName(profileName);
            if (data.avatar_link) {
              setMyAvatarUrl(data.avatar_link);
            }
          }
        } else if (isMounted) {
          setDefaultDisplayName(userEmail?.split('@')[0] ?? 'guest');
        }
      })
      .catch(() => {
        if (isMounted) {
          setDefaultDisplayName(userEmail?.split('@')[0] ?? 'guest');
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
  }, [user?.id, userEmail]);

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

  // Track whether a custom name is being used
  const [isCustomName, setIsCustomName] = useState(false);
  const [backgroundDialogOpen, setBackgroundDialogOpen] = useState(false);

  // Initial username calculation:
  // 1. Custom entered name from localStorage if exists
  // 2. Default profile name (name_english -> name_kanji -> email account -> guest)
  const initialUsername = useMemo(() => {
    if (!defaultDisplayName) return '';
    try {
      const savedCustom = localStorage.getItem(CUSTOM_USERNAME_KEY);
      if (savedCustom && savedCustom.trim() && savedCustom.trim() !== defaultDisplayName) {
        return savedCustom.trim();
      }
    } catch {
      /* ignore */
    }
    return defaultDisplayName;
  }, [defaultDisplayName]);

  useEffect(() => {
    if (!defaultDisplayName) return;
    try {
      const savedCustom = localStorage.getItem(CUSTOM_USERNAME_KEY);
      setIsCustomName(Boolean(savedCustom && savedCustom.trim() && savedCustom.trim() !== defaultDisplayName));
    } catch {
      setIsCustomName(false);
    }
  }, [defaultDisplayName]);

  const userFallback = userEmail?.split('@')[0] || 'guest';
  const preJoinDefaults = useMemo(
    () => ({
      username: initialUsername || userFallback,
      videoEnabled: true,
      audioEnabled: true,
    }),
    [initialUsername, userFallback],
  );

  // Prevent credit card autofill suggestions on the PreJoin input safely without MutationObserver loops
  useEffect(() => {
    if (profileLoading || phase !== 'prejoin') return;

    const timer = setTimeout(() => {
      const container = prejoinContainerRef.current;
      if (!container) return;

      const input = container.querySelector<HTMLInputElement>('.lk-username-container input');
      if (!input) return;

      // Disable browser credit card / password manager autofill heuristics
      input.setAttribute('name', 'smiring_connect_display_name_no_autofill');
      input.setAttribute('autocomplete', 'one-time-code');
      input.setAttribute('data-1p-ignore', 'true');
      input.setAttribute('data-lpignore', 'true');
      input.setAttribute('data-form-type', 'other');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');

      const handleInput = () => {
        const val = input.value.trim();
        const nextIsCustom = Boolean(defaultDisplayName && val && val !== defaultDisplayName);
        if (nextIsCustom) {
          try {
            localStorage.setItem(CUSTOM_USERNAME_KEY, val);
          } catch {}
        } else {
          try {
            localStorage.removeItem(CUSTOM_USERNAME_KEY);
          } catch {}
        }
        setIsCustomName((prev) => (prev !== nextIsCustom ? nextIsCustom : prev));
      };

      input.addEventListener('input', handleInput);
    }, 100);

    return () => {
      clearTimeout(timer);
    };
  }, [profileLoading, phase, defaultDisplayName]);

  // Reset username back to profile default
  const handleResetToDefaultName = useCallback(() => {
    if (!defaultDisplayName) return;
    try {
      localStorage.removeItem(CUSTOM_USERNAME_KEY);
    } catch {}
    setIsCustomName(false);

    const input = prejoinContainerRef.current?.querySelector<HTMLInputElement>('.lk-username-container input');
    if (input) {
      input.value = defaultDisplayName;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [defaultDisplayName]);

  const handlePreJoinSubmit = useCallback(
    (values: LocalUserChoices) => {
      if (!roomId) return;
      try {
        sessionStorage.setItem(`smiring_connect_choices_${roomId}`, JSON.stringify(values));
      } catch (e) {
        console.warn('[Connect] Failed to save choices to sessionStorage:', e);
      }

      // Release the PreJoin preview's camera/mic before opening the new tab so
      // it doesn't race a second capture of the same devices there (see
      // stopPreJoinPreviewTracks above).
      stopPreJoinPreviewTracks();

      // Open call in a new tab without SmiRingDatabase shell
      window.open(`/connect/call/${roomId}`, '_blank');
      setPhase('in-room');
    },
    [roomId, stopPreJoinPreviewTracks],
  );

  const handlePreJoinError = useCallback((e: Error) => {
    setErrorMsg(e.message);
    setPhase('error');
  }, []);

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
            <div
              ref={prejoinContainerRef}
              data-lk-theme="default"
              className="rounded-2xl overflow-hidden relative"
            >
              {profileLoading ? (
                <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
                  <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
                  <p className="text-xs font-semibold">プロフィール情報を読み込み中...</p>
                </div>
              ) : (
                <>
                  <style>{`
                    ${myAvatarUrl ? `
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
                    ` : ''}
                    .lk-prejoin .lk-username-container {
                      display: flex !important;
                      flex-direction: column !important;
                      gap: 0.625rem !important;
                      width: 100% !important;
                    }
                    .lk-prejoin .lk-username-container input {
                      width: 100% !important;
                      box-sizing: border-box !important;
                    }
                  `}</style>

                  <PreJoin
                    defaults={preJoinDefaults}
                    persistUserChoices={false}
                    onSubmit={handlePreJoinSubmit}
                    onError={handlePreJoinError}
                    joinLabel="このルームに参加"
                    micLabel="マイク"
                    camLabel="カメラ"
                    userLabel="表示名"
                  />

                  {/* 背景エフェクト: 入室前にここで決めておくと、通話開始時にそのまま適用される */}
                  <div className="max-w-[480px] mx-auto mt-3 px-1">
                    <button
                      type="button"
                      onClick={() => setBackgroundDialogOpen(true)}
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
                      <span>背景エフェクトを設定</span>
                    </button>
                  </div>

                  {/* Reset to Default Name Button (rendered cleanly in React) */}
                  {isCustomName && defaultDisplayName && (
                    <div className="max-w-[480px] mx-auto mt-2 px-1 flex justify-end">
                      <button
                        type="button"
                        onClick={handleResetToDefaultName}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 hover:bg-indigo-50 text-indigo-600 hover:text-indigo-700 border border-slate-200 hover:border-indigo-200 font-bold text-xs rounded-xl shadow-xs transition-all active:scale-95"
                        title={`デフォルト（${defaultDisplayName}）に戻す`}
                      >
                        <span>デフォルト（{defaultDisplayName}）に戻す</span>
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                          <path d="M3 3v5h5" />
                        </svg>
                      </button>
                    </div>
                  )}
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

      <PreJoinBackgroundDialog
        open={backgroundDialogOpen}
        onClose={() => setBackgroundDialogOpen(false)}
      />
    </div>
  );
}
