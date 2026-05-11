import { useState } from 'react';
import { Outlet, useNavigate, Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
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
  // メニューの開閉状態を管理するState
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const navigate = useNavigate();

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
      <header className="h-16 bg-blue-100 flex items-center px-4 shrink-0 shadow-sm relative z-10">
        
        {/* ハンバーガーメニューボタン */}
        <button
          onClick={() => setIsDrawerOpen(true)}
          className="p-2 mr-2 text-blue-900 hover:bg-blue-200 rounded-md transition-colors"
        >
          <Menu className="w-6 h-6" />
        </button>

        {/* タイトル (FlutterのTextButton相当：タップでHomeへ) */}
        <Link to="/home" className="text-xl font-bold text-blue-900 hover:opacity-80 transition-opacity">
          SmiRing Database
        </Link>
      </header>

      {/* --- 2. ボディ (中身) --- */}
      <main className="flex-1 overflow-y-auto relative bg-white">
        <Outlet />
      </main>

      {/* --- 3. Drawer (ドロワーメニュー) とオーバーレイ --- */}
      {isDrawerOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 transition-opacity"
          onClick={() => setIsDrawerOpen(false)} 
        />
      )}

      {/* ドロワー本体 */}
      <div
        className={`fixed inset-y-0 left-0 w-64 bg-white shadow-xl z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
          isDrawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* SafeArea 相当の余白とヘッダー */}
        <div className="relative pt-safe border-b border-gray-100 flex items-center justify-center p-2 min-h-[60px]">
          <button 
            onClick={() => setIsDrawerOpen(false)} 
            className="absolute left-2 p-3 text-blue-700 hover:bg-gray-100 rounded-full transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
          <span className="text-lg font-bold text-gray-700">Menu</span>
        </div>

        {/* ナビゲーションリンク */}
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          <Link 
            to="/home" 
            onClick={() => setIsDrawerOpen(false)} 
            className="flex items-center gap-3 px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium transition-colors"
          >
            <Home className="w-5 h-5 text-blue-700" />
            Home
          </Link>
          <Link 
            to="/members" 
            onClick={() => setIsDrawerOpen(false)} 
            className="flex items-center gap-3 px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium transition-colors"
          >
            <Users className="w-5 h-5 text-blue-700" />
            Members
          </Link>
          <Link 
            to="/gallery" 
            onClick={() => setIsDrawerOpen(false)} 
            className="flex items-center gap-3 px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium transition-colors"
          >
            <ImageIcon className="w-5 h-5 text-blue-700" />
            Gallery
          </Link>
          <Link 
            to="/form-list" 
            onClick={() => setIsDrawerOpen(false)} 
            className="flex items-center gap-3 px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium transition-colors"
          >
            <FileText className="w-5 h-5 text-blue-700" />
            My Forms
          </Link>
          <Link 
            to="/profile" 
            onClick={() => setIsDrawerOpen(false)} 
            className="flex items-center gap-3 px-4 py-3 rounded-md hover:bg-blue-50 text-gray-700 font-medium transition-colors"
          >
            <User className="w-5 h-5 text-blue-700" />
            My Profile
          </Link>
        </nav>

        {/* ログアウトボタン */}
        <div className="p-4 border-t border-gray-100">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 text-red-600 hover:bg-red-50 rounded-md font-bold transition-colors"
          >
            <LogOut className="w-5 h-5" />
            <span>ログアウト</span>
          </button>
        </div>
      </div>
      
    </div>
  );
}