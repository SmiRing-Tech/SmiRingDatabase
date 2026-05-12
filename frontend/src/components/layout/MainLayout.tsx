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
    <div className="flex flex-col h-screen w-full bg-slate-50/50 text-gray-900 font-sans">
      
      {/* --- 1. Global Nav Bar --- */}
      <header className="h-16 bg-sky-100 backdrop-blur-md flex items-center px-6 shrink-0 border-b border-sky-100 sticky top-0 z-30">
        
        {/* ハンバーガーメニューボタン */}
        <button
          onClick={() => setIsDrawerOpen(true)}
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
      </header>

      {/* --- 2. ボディ --- */}
      <main className="flex-1 overflow-y-auto relative bg-white/50">
        <Outlet />
      </main>

      {/* --- 3. Drawer とオーバーレイ --- */}
      {isDrawerOpen && (
        <div
          className="fixed inset-0 bg-sky-900/20 backdrop-blur-[2px] z-40 animate-in fade-in duration-300"
          onClick={() => setIsDrawerOpen(false)} 
        />
      )}

      {/* ドロワー本体 */}
      <div
        className={`fixed inset-y-0 left-0 w-72 bg-white shadow-2xl z-50 transform transition-transform duration-500 cubic-bezier(0.4, 0, 0.2, 1) flex flex-col ${
          isDrawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Drawer Header */}
        <div className="pt-safe border-b border-slate-50 flex flex-col p-6 pb-4">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl overflow-hidden bg-sky-50 flex items-center justify-center border border-sky-100">
                <img src="/assets/images/SmiRing_logo_temp.png" alt="Logo" className="w-6 h-6 object-contain rounded-md" />
              </div>
              <span className="text-sm font-black tracking-wider text-gray-400">SmiRing</span>
            </div>
            <button 
              onClick={() => setIsDrawerOpen(false)} 
              className="p-2 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded-full transition-all duration-200"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <h2 className="text-xl font-black text-gray-900">Database Menu</h2>
          <p className="text-[10px] text-sky-400 font-bold uppercase tracking-[0.2em] mt-1">Archive Experiences</p>
        </div>

        {/* ナビゲーションリンク */}
        <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
          {[
            { to: '/home', icon: Home, label: 'Home' },
            { to: '/members', icon: Users, label: 'Members' },
            { to: '/gallery', icon: ImageIcon, label: 'Gallery' },
            { to: '/form-list', icon: FileText, label: 'My Forms' },
            { to: '/profile', icon: User, label: 'My Profile' },
          ].map((item) => (
            <Link 
              key={item.to}
              to={item.to} 
              onClick={() => setIsDrawerOpen(false)} 
              className="flex items-center gap-3.5 px-4 py-3.5 rounded-2xl text-slate-600 font-bold text-sm hover:bg-sky-50 hover:text-sky-600 transition-all duration-200 group"
            >
              <item.icon className="w-5 h-5 text-slate-300 group-hover:text-sky-500 transition-colors" />
              {item.label}
            </Link>
          ))}
        </nav>

        {/* ログアウトボタン */}
        <div className="p-6 border-t border-slate-50">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2.5 px-4 py-4 text-rose-500 hover:bg-rose-50 rounded-2xl font-black text-sm transition-all duration-200 active:scale-[0.98]"
          >
            <LogOut className="w-5 h-5" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
      
    </div>
  );
}