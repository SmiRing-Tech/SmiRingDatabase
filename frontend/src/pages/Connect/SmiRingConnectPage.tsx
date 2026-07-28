import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Video,
  ArrowLeft,
  Plus,
  LogIn,
  Pin,
  Copy,
  Check,
  Trash2,
  Sparkles,
  Loader2,
  Info,
  Calendar,
} from 'lucide-react';
import { apiClient } from '../../lib/apiClient';

interface ConnectRoom {
  id: string;
  created_at: string;
  room_id: string;
  room_title: string;
  metadata?: string | null;
}

/** Generate a random room id (alphanumeric, matches LiveKit room-name rules). */
function generateRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  for (const b of bytes) id += chars[b % chars.length];
  return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6, 9)}`;
}

export default function SmiRingConnectPage() {
  const navigate = useNavigate();
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState('');

  // Fixed rooms state
  const [rooms, setRooms] = useState<ConnectRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(true);

  // New fixed room state
  const [roomTitle, setRoomTitle] = useState('');
  const [customRoomId, setCustomRoomId] = useState('');
  const [showCustomId, setShowCustomId] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Copy state
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Fetch fixed rooms on load
  const fetchRooms = async () => {
    setLoadingRooms(true);
    try {
      const res = await apiClient.get('/api/connect/rooms');
      if (res.ok) {
        const data = await res.json();
        setRooms(data.rooms ?? []);
      }
    } catch (e) {
      console.error('[Connect] Failed to fetch rooms:', e);
    } finally {
      setLoadingRooms(false);
    }
  };

  useEffect(() => {
    fetchRooms();
  }, []);

  const startNewMeeting = () => {
    navigate(`/connect/room/${generateRoomId()}`);
  };

  const joinMeeting = (targetCode?: string) => {
    const code = (targetCode ?? joinCode).trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      setJoinError('コードは半角英数字・ハイフン・アンダースコアのみ（1〜64文字）で入力してください');
      return;
    }
    setJoinError('');
    navigate(`/connect/room/${code}`);
  };

  const createFixedRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomTitle.trim()) {
      setCreateError('ミーティング名を入力してください');
      return;
    }
    setCreateError('');
    setCreating(true);

    try {
      const res = await apiClient.post('/api/connect/rooms', {
        room_title: roomTitle.trim(),
        room_id: customRoomId.trim() || undefined,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCreateError(body.error || '固定ミーティングの作成に失敗しました');
        return;
      }

      setRoomTitle('');
      setCustomRoomId('');
      setShowCustomId(false);
      await fetchRooms();
    } catch (e: any) {
      setCreateError(e?.message || '通信エラーが発生しました');
    } finally {
      setCreating(false);
    }
  };

  const deleteFixedRoom = async (id: string, title: string) => {
    if (!window.confirm(`固定ミーティング「${title}」を削除してもよろしいですか？`)) {
      return;
    }
    try {
      const res = await apiClient.delete(`/api/connect/rooms/${id}`);
      if (res.ok) {
        setRooms((prev) => prev.filter((r) => r.id !== id));
      }
    } catch (e) {
      console.error('[Connect] Delete room failed:', e);
    }
  };

  const copyRoomId = async (roomId: string) => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopiedId(roomId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* ignore clipboard errors */
    }
  };

  // Match registered fixed room for entered joinCode
  const matchedFixedRoom = rooms.find(
    (r) => r.room_id.toLowerCase() === joinCode.trim().toLowerCase(),
  );

  return (
    <div className="min-h-full bg-slate-50/30 p-6 md:p-10 relative overflow-hidden pb-20">
      {/* Background soft glow blobs */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-indigo-400/5 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-sky-400/5 blur-[120px] pointer-events-none" />

      <div className="max-w-6xl mx-auto relative z-10 space-y-10">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2 text-indigo-600 font-bold text-sm tracking-wide uppercase">
              <Video className="w-4 h-4" />
              <span>SmiRing Connect</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-black text-gray-900 tracking-tight">
              ビデオ通話
            </h1>
            <p className="text-sm text-gray-400 font-semibold mt-2">
              メンバー同士でつながるビデオ通話・固定ミーティング
            </p>
          </div>

          <button
            onClick={() => navigate('/apps')}
            className="self-start flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-600 font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all duration-200 active:scale-95"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>アプリ一覧へ戻る</span>
          </button>
        </div>

        {/* Action Cards Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Card 1: Start new meeting */}
          <div
            onClick={startNewMeeting}
            className="group relative bg-white border border-slate-100 rounded-3xl p-6 shadow-sm hover:shadow-xl hover:border-indigo-100 transition-all duration-300 flex flex-col justify-between items-start gap-4 cursor-pointer active:scale-[0.98]"
          >
            <div className="w-full flex justify-between items-center">
              <div className="p-4 rounded-2xl bg-gradient-to-br border flex items-center justify-center group-hover:scale-110 group-hover:rotate-3 transition-transform duration-300 shadow-sm from-indigo-50 to-indigo-100/80 border-indigo-200 text-indigo-600">
                <Plus className="w-6 h-6 text-indigo-600" />
              </div>
              <span className="text-[10px] font-bold text-indigo-500 bg-indigo-50 border border-indigo-100 px-2.5 py-1 rounded-full">
                インスタント
              </span>
            </div>

            <div className="flex-1 flex flex-col gap-1.5 mt-2">
              <h3 className="text-lg font-black text-gray-900 group-hover:text-indigo-600 transition-colors">
                新しいミーティングを開始
              </h3>
              <p className="text-xs text-gray-400 leading-relaxed font-semibold">
                ランダムなIDですぐにビデオ通話を立ち上げて、メンバーを招待できます
              </p>
            </div>

            <div className="w-full flex justify-end pt-2 mt-auto">
              <span className="text-xs font-bold text-indigo-500 flex items-center gap-1 group-hover:translate-x-1.5 transition-transform duration-300">
                開始
                <span className="text-sm">→</span>
              </span>
            </div>
          </div>

          {/* Card 2: Join meeting */}
          <div className="group relative bg-white border border-slate-100 rounded-3xl p-6 shadow-sm hover:shadow-xl hover:border-sky-100 transition-all duration-300 flex flex-col items-start gap-4">
            <div className="w-full flex justify-between items-center">
              <div className="p-4 rounded-2xl bg-gradient-to-br border flex items-center justify-center transition-transform duration-300 shadow-sm from-sky-50 to-sky-100/80 border-sky-200 text-sky-600">
                <LogIn className="w-6 h-6 text-sky-600" />
              </div>
              <span className="text-[10px] font-bold text-sky-600 bg-sky-50 border border-sky-100 px-2.5 py-1 rounded-full">
                ID指定
              </span>
            </div>

            <div className="flex-1 flex flex-col gap-1.5 mt-2 w-full">
              <h3 className="text-lg font-black text-gray-900">
                ミーティングに参加
              </h3>
              <p className="text-xs text-gray-400 leading-relaxed font-semibold mb-2">
                招待コード・ルームIDを入力して既存の部屋に参加します
              </p>

              <div className="flex flex-col sm:flex-row gap-2 w-full">
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && joinMeeting()}
                  placeholder="例: abc-def-ghi"
                  className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none text-sm font-semibold text-gray-800 rounded-xl transition-all"
                />
                <button
                  onClick={() => joinMeeting()}
                  disabled={!joinCode.trim()}
                  className="px-5 py-2.5 bg-sky-500 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all active:scale-95"
                >
                  参加
                </button>
              </div>

              {/* Matched fixed room notification */}
              {matchedFixedRoom && (
                <div className="mt-2 p-2.5 bg-indigo-50 border border-indigo-200 rounded-xl flex items-start gap-2 text-indigo-700 animate-in fade-in duration-200">
                  <Info className="w-4 h-4 shrink-0 mt-0.5 text-indigo-500" />
                  <div className="text-xs">
                    <p className="font-bold">
                      固定ミーティング「{matchedFixedRoom.room_title}」です
                    </p>
                    <p className="text-[10px] text-indigo-500 font-medium">
                      下の一覧からもいつでもワンクリックで参加できます
                    </p>
                  </div>
                </div>
              )}

              {joinError && (
                <p className="text-xs text-rose-500 font-semibold mt-1">{joinError}</p>
              )}
            </div>
          </div>

          {/* Card 3: Create fixed meeting */}
          <div className="group relative bg-white border border-slate-100 rounded-3xl p-6 shadow-sm hover:shadow-xl hover:border-purple-100 transition-all duration-300 flex flex-col items-start gap-4">
            <div className="w-full flex justify-between items-center">
              <div className="p-4 rounded-2xl bg-gradient-to-br border flex items-center justify-center transition-transform duration-300 shadow-sm from-purple-50 to-purple-100/80 border-purple-200 text-purple-600">
                <Pin className="w-6 h-6 text-purple-600" />
              </div>
              <span className="text-[10px] font-bold text-purple-600 bg-purple-50 border border-purple-100 px-2.5 py-1 rounded-full">
                常設ルーム
              </span>
            </div>

            <form onSubmit={createFixedRoom} className="flex-1 flex flex-col gap-2.5 w-full mt-2">
              <h3 className="text-lg font-black text-gray-900">
                固定ミーティングを作成
              </h3>
              <p className="text-xs text-gray-400 leading-relaxed font-semibold">
                いつも使うミーティング名で永続ルームを作成します
              </p>

              <input
                type="text"
                value={roomTitle}
                onChange={(e) => setRoomTitle(e.target.value)}
                placeholder="ミーティング名 (例: 定例ミーティング)"
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 focus:border-purple-400 focus:ring-2 focus:ring-purple-100 outline-none text-sm font-semibold text-gray-800 rounded-xl transition-all"
              />

              {showCustomId ? (
                <input
                  type="text"
                  value={customRoomId}
                  onChange={(e) => setCustomRoomId(e.target.value)}
                  placeholder="カスタムID (任意: 例 weekly-mtg)"
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 focus:border-purple-400 outline-none text-xs font-mono text-gray-800 rounded-xl transition-all"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCustomId(true)}
                  className="self-start text-[11px] font-bold text-purple-600 hover:underline"
                >
                  + IDをカスタム指定する（任意）
                </button>
              )}

              {createError && (
                <p className="text-xs text-rose-500 font-semibold">{createError}</p>
              )}

              <button
                type="submit"
                disabled={creating || !roomTitle.trim()}
                className="mt-1 w-full py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all active:scale-95 flex items-center justify-center gap-1.5"
              >
                {creating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>作成中...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>固定ミーティングを作成</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* Fixed Meetings List Section */}
        <div className="space-y-4 pt-4 border-t border-slate-200/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-indigo-50 border border-indigo-100 text-indigo-600">
                <Calendar className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-xl font-black text-gray-900 tracking-tight">
                  固定ミーティング一覧
                </h2>
                <p className="text-xs text-gray-400 font-semibold">
                  いつでもワンクリックで参加できる常設ルーム
                </p>
              </div>
            </div>

            <span className="text-xs font-bold text-slate-500 bg-slate-100 border border-slate-200 px-3 py-1 rounded-full">
              全 {rooms.length} 件
            </span>
          </div>

          {loadingRooms ? (
            <div className="flex items-center justify-center py-16 text-gray-400 gap-2 font-bold text-sm bg-white rounded-3xl border border-slate-100 shadow-sm">
              <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
              <span>読み込み中...</span>
            </div>
          ) : rooms.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 bg-white rounded-3xl border border-slate-100 shadow-sm text-center px-4">
              <div className="p-4 rounded-2xl bg-purple-50 border border-purple-100 mb-3">
                <Pin className="w-8 h-8 text-purple-400" />
              </div>
              <p className="font-black text-gray-800 text-base mb-1">
                固定ミーティングはまだありません
              </p>
              <p className="text-xs text-gray-400 font-semibold max-w-sm">
                上の「固定ミーティングを作成」からよく使う会議用ルームを作成すると、ここからワンクリックで参加できるようになります。
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {rooms.map((room) => (
                <div
                  key={room.id}
                  className="bg-white border border-slate-100 hover:border-indigo-200 rounded-3xl p-5 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between gap-4 group"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-black text-gray-900 text-base group-hover:text-indigo-600 transition-colors line-clamp-1">
                        {room.room_title}
                      </h3>
                      <button
                        onClick={() => deleteFixedRoom(room.id, room.room_title)}
                        className="text-gray-300 hover:text-rose-500 p-1.5 rounded-lg hover:bg-rose-50 transition-colors shrink-0"
                        title="固定ミーティングを削除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-mono text-gray-600 bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-lg">
                        ID: {room.room_id}
                      </span>
                      <button
                        onClick={() => copyRoomId(room.room_id)}
                        className="p-1 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                        title="ルームIDをコピー"
                      >
                        {copiedId === room.room_id ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>

                    <p className="text-[10px] text-gray-400 font-medium">
                      作成日: {new Date(room.created_at).toLocaleDateString('ja-JP')}
                    </p>
                  </div>

                  <button
                    onClick={() => joinMeeting(room.room_id)}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl shadow-sm hover:shadow transition-all active:scale-95 flex items-center justify-center gap-1.5"
                  >
                    <Video className="w-3.5 h-3.5" />
                    <span>ワンクリックで参加</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
