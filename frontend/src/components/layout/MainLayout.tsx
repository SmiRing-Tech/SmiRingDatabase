import { useState } from 'react';
import { Outlet, useNavigate, Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useInactivityLogout } from '../../hooks/useInactivityLogout';
import { 
  Menu, 
  X, 
  Home, 
  Users, 
  Image as ImageIcon, 
  FileText, 
  User, 
  LogOut 
} from 'lucide-react';

export default function MainLayout() {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const navigate = useNavigate();
  useInactivityLogout();

  const handleLogout = async () => {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error('Logout failed:', error);
    }
    
    // ドロワーを閉じてログイン画面へ遷移
    setIsDrawerOpen(false);
    navigate('/sign-in');
  };

  return (
    <div className="flex flex-col h-screen w-full bg-white text-gray-900">
      
      {/* --- 1. Global Nav Bar (AppBar 相当) --- */}
      {/* Theme.of(context).colorScheme.inversePrimary っぽい色合いに */}
      <header className="h-16 bg-blue-100 flex items-center px-4 shrink-0 shadow-sm relative z-10">
        
        {/* ハンバーガーメニューボタン */}
        <button
          onClick={() => setIsDrawerOpen(true)}
          className="p-2 mr-2 text-blue-900 hover:bg-blue-200 rounded-md transition-colors"
        >
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* タイトル (FlutterのTextButton相当：タップでHomeへ) */}
        <Link to="/home" className="text-xl font-bold text-blue-900 hover:opacity-80 transition-opacity">
          SmiRing Database
        </Link>
      </header>

      {/* --- 2. ボディ (中身) --- */}
      {/* ここに HomePage や ProfilePage などが展開されます */}
      <main className="flex-1 overflow-y-auto relative bg-white">
        <Outlet />
      </main>

      {/* --- 3. Drawer (ドロワーメニュー) とオーバーレイ --- */}
      
      {/* 背景の暗いもやもや (オーバーレイ) */}
      {/* isDrawerOpenがtrueの時だけ表示され、タップするとメニューが閉じます */}
      {isDrawerOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 transition-opacity"
          onClick={() => setIsDrawerOpen(false)} 
        />
      )}

      {/* ドロワー本体 */}
      {/* -translate-x-full で画面左外に隠しておき、translate-x-0 で表示させます */}
      <div
        className={`fixed inset-y-0 left-0 w-64 bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isDrawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* SafeArea 相当の余白とヘッダー */}
        <div className="relative pt-safe border-b border-gray-100 flex items-center justify-center p-2 min-h-[60px]">
          <button 
            onClick={() => setIsDrawerOpen(false)} 
            className="absolute left-2 p-3 text-gray-400 hover:bg-gray-100 rounded-full transition-colors"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <span className="text-lg font-bold text-gray-700">Menu</span>
        </div>

        {/* Linkコンポーネントを使って、画面を再読み込みせずに高速遷移します */}
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          <Link to="/home" onClick={() => setIsDrawerOpen(false)} className="block px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium">
            🏠 Home
          </Link>
          <Link to="/members" onClick={() => setIsDrawerOpen(false)} className="block px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium">
            🌐 Members
          </Link>
          <Link to="/gallery" onClick={() => setIsDrawerOpen(false)} className="block px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium">
            🖼️ Gallery
          </Link>
          <Link to="/form-list" onClick={() => setIsDrawerOpen(false)} className="block px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium">
            📝 My Forms
          </Link>
          <Link to="/profile" onClick={() => setIsDrawerOpen(false)} className="block px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium">
            👤 My Profile
          </Link>
        </nav>

        {/* ログアウトボタン (Spacer 相当で一番下に押しやられる) */}
        <div className="p-4 border-t border-gray-100">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center space-x-2 px-4 py-3 text-red-600 hover:bg-red-50 rounded-md font-bold transition-colors"
          >
            {/* ログアウトアイコン */}
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span>ログアウト</span>
          </button>
        </div>
      </div>
      
    </div>
  );
}