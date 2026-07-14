import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Video, ArrowLeft, Plus, LogIn } from 'lucide-react';

/** Generate a random room id (alphanumeric, matches LiveKit room-name rules). */
function generateRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  for (const b of bytes) id += chars[b % chars.length];
  // Format as abc-def-ghi for readability
  return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6, 9)}`;
}

export default function SmiRingConnectPage() {
  const navigate = useNavigate();
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState('');

  const startNewMeeting = () => {
    navigate(`/connect/room/${generateRoomId()}`);
  };

  const joinMeeting = () => {
    const code = joinCode.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      setJoinError('コードは英数字・ハイフン・アンダースコアのみ（1〜64文字）で入力してください');
      return;
    }
    setJoinError('');
    navigate(`/connect/room/${code}`);
  };

  return (
    <div className="min-h-full bg-slate-50/30 p-6 md:p-10 relative overflow-hidden">
      {/* Background soft glow blobs */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-indigo-400/5 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-sky-400/5 blur-[120px] pointer-events-none" />

      <div className="max-w-6xl mx-auto relative z-10">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-2 text-indigo-600 font-bold text-sm tracking-wide uppercase">
              <Video className="w-4 h-4" />
              <span>SmiRing Connect</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-black text-gray-900 tracking-tight">
              ビデオ通話
            </h1>
            <p className="text-sm text-gray-400 font-semibold mt-2">
              メンバー同士でつながるビデオ通話
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

        {/* Action Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Start new meeting */}
          <div
            onClick={startNewMeeting}
            className="group relative bg-white border border-slate-100 rounded-3xl p-6 shadow-sm hover:shadow-xl hover:border-indigo-100 transition-all duration-300 flex flex-col items-start gap-4 cursor-pointer active:scale-[0.98]"
          >
            <div className="p-4 rounded-2xl bg-gradient-to-br border flex items-center justify-center group-hover:scale-110 group-hover:rotate-3 transition-transform duration-300 shadow-sm from-indigo-50 to-indigo-100/80 border-indigo-200 text-indigo-600">
              <Plus className="w-6 h-6 text-indigo-600" />
            </div>
            <div className="flex-1 flex flex-col gap-1.5 mt-2">
              <h3 className="text-lg font-black text-gray-900 group-hover:text-indigo-600 transition-colors">
                新しいミーティングを開始
              </h3>
              <p className="text-xs text-gray-400 leading-relaxed font-semibold">
                すぐにビデオ通話を立ち上げて、メンバーを招待できます
              </p>
            </div>
            <div className="w-full flex justify-end pt-2 mt-auto">
              <span className="text-xs font-bold text-indigo-500 flex items-center gap-1 group-hover:translate-x-1.5 transition-transform duration-300">
                開始
                <span className="text-sm">→</span>
              </span>
            </div>
          </div>

          {/* Join meeting */}
          <div className="group relative bg-white border border-slate-100 rounded-3xl p-6 shadow-sm hover:shadow-xl hover:border-sky-100 transition-all duration-300 flex flex-col items-start gap-4">
            <div className="p-4 rounded-2xl bg-gradient-to-br border flex items-center justify-center transition-transform duration-300 shadow-sm from-sky-50 to-sky-100/80 border-sky-200 text-sky-600">
              <LogIn className="w-6 h-6 text-sky-600" />
            </div>
            <div className="flex-1 flex flex-col gap-1.5 mt-2 w-full">
              <h3 className="text-lg font-black text-gray-900">
                ミーティングに参加
              </h3>
              <p className="text-xs text-gray-400 leading-relaxed font-semibold mb-2">
                招待コードを入力して既存のミーティングに参加します
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
                  onClick={joinMeeting}
                  disabled={!joinCode.trim()}
                  className="px-5 py-2.5 bg-sky-500 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all active:scale-95"
                >
                  参加
                </button>
              </div>
              {joinError && (
                <p className="text-xs text-rose-500 font-semibold mt-1">{joinError}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
