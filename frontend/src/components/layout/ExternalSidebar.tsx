import { NavLink, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { Calendar, GraduationCap, ClipboardList, User, LogOut, X } from 'lucide-react';

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

const navItems = [
  { to: '/events', icon: Calendar, label: 'イベント' },
  { to: '/study-info', icon: GraduationCap, label: '留学情報' },
  { to: '/survey', icon: ClipboardList, label: 'アンケート' },
  { to: '/profile', icon: User, label: 'プロフィール' },
];

export default function ExternalSidebar({ isOpen, onClose }: Props) {
  const navigate = useNavigate();

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error('Logout failed:', error);
    }
    onClose();
    navigate('/sign-in');
  };

  return (
    <>
      {/* スマホ用オーバーレイ */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-sky-900/20 backdrop-blur-[2px] z-40 md:hidden"
          onClick={onClose}
        />
      )}

      <aside className={`
        fixed inset-y-0 left-0 z-50 w-72 bg-white border-r border-slate-100 shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col
        md:relative md:z-0 md:shadow-none md:translate-x-0
        ${isOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="flex items-center justify-between p-6 pb-4 md:hidden">
          <h2 className="text-xl font-black text-gray-900">Menu</h2>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded-full transition-all duration-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-3.5 px-4 py-3.5 rounded-2xl font-bold text-sm transition-all duration-200 group ${
                  isActive
                    ? 'bg-sky-50 text-sky-600'
                    : 'text-slate-600 hover:bg-sky-50 hover:text-sky-600'
                }`
              }
            >
              <item.icon className="w-5 h-5 text-slate-300 group-hover:text-sky-500 transition-colors" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-6 border-t border-slate-50">
          <button
            onClick={handleSignOut}
            className="w-full flex items-center justify-center gap-2.5 px-4 py-4 text-rose-500 hover:bg-rose-50 rounded-2xl font-black text-sm transition-all duration-200 active:scale-[0.98]"
          >
            <LogOut className="w-5 h-5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>
    </>
  );
}
