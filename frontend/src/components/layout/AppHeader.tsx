import { Link } from 'react-router-dom';
import { Menu, MessageSquare } from 'lucide-react';

type Props = {
  onMenuClick: () => void;
};

export default function AppHeader({ onMenuClick }: Props) {
  return (
    <header className="h-16 bg-sky-100 backdrop-blur-md flex items-center px-6 shrink-0 border-b border-sky-100 sticky top-0 z-30">

      {/* ハンバーガーメニューボタン */}
      <button
        onClick={onMenuClick}
        className="p-2.5 -ml-2 mr-3 text-sky-600 hover:bg-sky-100/50 rounded-xl transition-all duration-200 active:scale-95"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* タイトル */}
      <Link
        to="/home"
        className="text-lg font-black tracking-tight text-sky-900 hover:text-sky-600 transition-colors flex items-center gap-2"
      >
        <div className="w-7 h-7 rounded-lg overflow-hidden bg-white/50 flex items-center justify-center border border-sky-100 shadow-sm">
          <img src="/assets/images/SmiRing_logo_temp.png" alt="Logo" className="w-5 h-5 object-contain rounded-sm" />
        </div>
        SmiRing Database
      </Link>

      {/* スペーサー */}
      <div className="flex-1" />

      {/* 右側アイコン群 */}
      <div className="flex items-center gap-2">
        <Link
          to="/feedback"
          className="p-2.5 text-sky-600 hover:bg-sky-100/50 rounded-xl transition-all duration-200 active:scale-95"
          title="フィードバックを送る"
        >
          <MessageSquare className="w-5 h-5" />
        </Link>
      </div>
    </header>
  );
}
