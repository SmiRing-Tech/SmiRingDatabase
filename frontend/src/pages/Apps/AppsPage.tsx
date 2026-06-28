import { useNavigate } from 'react-router-dom';
import {
  Users,
  Image as ImageIcon,
  FileText,
  User,
  ArrowLeft,
  Lock,
} from 'lucide-react';
import { usePermission } from '../../hooks/usePermission';

interface AppItem {
  name: string;
  description: string;
  path: string;
  icon: React.ReactNode;
  colorClass: string; // Tailwind-like styling classes for the icon gradient
  badge?: string;
  disabled?: boolean;
}

export default function AppsPage() {
  const navigate = useNavigate();
  const canAccessManagement = usePermission('management', 'read');

  const appList: AppItem[] = [
    {
      name: 'Members',
      description: 'SmiRingメンバーのプロフィール一覧',
      path: '/members',
      icon: <Users className="w-6 h-6 text-emerald-600" />,
      colorClass: 'from-emerald-50 to-emerald-100/80 border-emerald-200 text-emerald-600'
    },
    {
      name: 'Gallery',
      description: 'みんなの写真ギャラリー',
      path: '/gallery',
      icon: <ImageIcon className="w-6 h-6 text-purple-600" />,
      colorClass: 'from-purple-50 to-purple-100/80 border-purple-200 text-purple-600'
    },
    {
      name: 'My Forms',
      description: 'アンケートの作成、送信、回答の閲覧',
      path: '/form-list',
      icon: <FileText className="w-6 h-6 text-amber-600" />,
      colorClass: 'from-amber-50 to-amber-100/80 border-amber-200 text-amber-600'
    },
    {
      name: 'My Profile',
      description: '自分のプロフィールの変更と設定',
      path: '/profile',
      icon: <User className="w-6 h-6 text-rose-600" />,
      colorClass: 'from-rose-50 to-rose-100/80 border-rose-200 text-rose-600'
    },
    ...(canAccessManagement ? [{
      name: 'Management Console',
      description: 'メンバーの管理、権限の付与、全体の方針の決定',
      path: '/management',
      icon: <Lock className="w-6 h-6 text-sky-600" />,
      colorClass: 'from-sky-50 to-sky-100/80 border-sky-200 text-sky-600'
    }] : [])
  ];

  return (
    <div className="min-h-full bg-slate-50/30 p-6 md:p-10 relative overflow-hidden">
      {/* Background soft glow blobs */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] rounded-full bg-blue-400/5 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] rounded-full bg-sky-400/5 blur-[120px] pointer-events-none" />

      <div className="max-w-6xl mx-auto relative z-10">
        {/* Header Section */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-black text-gray-900 tracking-tight">
              アプリ一覧
            </h1>
          </div>
          
          <button
            onClick={() => navigate('/home')}
            className="self-start flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-600 font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all duration-200 active:scale-95"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>ホームへ戻る</span>
          </button>
        </div>

        {/* Apps Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {appList.map((app, index) => {
            const isClickable = !app.disabled;
            return (
              <div
                key={index}
                onClick={() => isClickable && navigate(app.path)}
                className={`group relative bg-white border border-slate-100 rounded-3xl p-6 shadow-sm hover:shadow-xl hover:border-sky-100 transition-all duration-300 flex flex-col items-start gap-4 ${
                  isClickable 
                    ? 'cursor-pointer active:scale-[0.98]' 
                    : 'opacity-75 cursor-default'
                }`}
              >
                {/* Icon Blob */}
                <div className={`p-4 rounded-2xl bg-gradient-to-br border flex items-center justify-center group-hover:scale-110 group-hover:rotate-3 transition-transform duration-300 shadow-sm ${app.colorClass}`}>
                  {app.icon}
                </div>

                {/* Badge */}
                {app.badge && (
                  <span className="absolute top-6 right-6 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-slate-500 bg-slate-100 rounded-full">
                    {app.badge}
                  </span>
                )}

                {/* Content */}
                <div className="flex-1 flex flex-col gap-1.5 mt-2">
                  <h3 className="text-lg font-black text-gray-900 group-hover:text-sky-600 transition-colors">
                    {app.name}
                  </h3>
                  <p className="text-xs text-gray-400 leading-relaxed font-semibold">
                    {app.description}
                  </p>
                </div>

                {/* Arrow indicator */}
                {isClickable && (
                  <div className="w-full flex justify-end pt-2 mt-auto">
                    <span className="text-xs font-bold text-sky-500 flex items-center gap-1 group-hover:translate-x-1.5 transition-transform duration-300">
                      開く
                      <span className="text-sm">→</span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
