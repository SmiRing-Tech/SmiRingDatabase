import { useEffect } from 'react';
import { X, MapPin, GraduationCap, School, BookOpen, User, Sparkles } from 'lucide-react';

interface StudyInfoDetailModalProps {
  member: any | null;
  onClose: () => void;
}

export default function StudyInfoDetailModal({ member, onClose }: StudyInfoDetailModalProps) {
  // ESCキーでモーダルを閉じる
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!member) return null;

  const nameEnglish = member.name_english || 'No Name';
  const nameKanji = member.name_kanji || '';
  const avatarUrl = member.avatar_link || '/assets/images/profile_photo_empty.png';

  const majorsArray = member.majors
    ? (Array.isArray(member.majors) ? member.majors : [member.majors])
    : [];

  const minorsArray = member.minors
    ? (Array.isArray(member.minors) ? member.minors : [member.minors])
    : [];

  // 詳細情報リスト（値が存在するもののみ表示）
  const infoItems = [
    { label: '学年・所属', value: member.grade_level, icon: User },
    { label: '出身地', value: member.hometown, icon: MapPin },
    { label: '現在の学校 / 留学先', value: member.current_school || member.english_school, icon: School },
    { label: '留学先 国', value: member.study_abroad_country, icon: MapPin },
    { label: '留学先 都市', value: member.study_abroad_city, icon: MapPin },
    { label: '留学形態', value: member.study_abroad_type, icon: GraduationCap },
    { label: '専攻', value: majorsArray.length > 0 ? majorsArray.join('、') : null, icon: BookOpen },
    { label: '副専攻', value: minorsArray.length > 0 ? minorsArray.join('、') : null, icon: BookOpen },
  ].filter(item => Boolean(item.value));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 md:p-8 animate-in fade-in duration-200">
      {/* 背景オーバーレイ */}
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* モーダルコンテンツ本体 */}
      <div className="bg-white rounded-3xl shadow-2xl border border-sky-100 w-full max-w-4xl max-h-[90vh] flex flex-col md:flex-row relative z-10 overflow-hidden animate-in zoom-in-95 duration-200">
        
        {/* 左半分（スマホ: 上部）: 写真 & タイトルエリア */}
        <div className="w-full md:w-[42%] h-64 md:h-auto min-h-[260px] relative bg-gradient-to-br from-sky-100 via-blue-50 to-indigo-100 flex flex-col shrink-0 overflow-hidden">
          <img
            src={avatarUrl}
            alt={nameEnglish}
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLElement).style.display = 'none';
            }}
          />

          {/* グラデーションオーバーレイ（テキスト視認性向上） */}
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/30 to-transparent" />

          {/* 閉じるボタン（スマホ表示用） */}
          <button
            onClick={onClose}
            className="md:hidden absolute top-4 right-4 z-20 w-9 h-9 rounded-full bg-black/40 text-white flex items-center justify-center hover:bg-black/60 transition-colors backdrop-blur-xs"
            aria-label="閉じる"
          >
            <X className="w-5 h-5" />
          </button>

          {/* 写真下部の名前情報 */}
          <div className="absolute bottom-5 left-5 right-5 z-10 text-white">
            {member.study_abroad_country && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-sky-500/90 text-white text-[11px] font-bold mb-2 backdrop-blur-xs shadow-sm">
                <MapPin className="w-3 h-3" />
                <span>{member.study_abroad_country}</span>
              </div>
            )}
            <h3 className="text-2xl md:text-3xl font-black tracking-tight drop-shadow-md">
              {nameEnglish}
            </h3>
            {nameKanji && (
              <p className="text-sm font-semibold text-sky-200/90 mt-0.5 drop-shadow">
                {nameKanji}
              </p>
            )}
          </div>
        </div>

        {/* 右半分（スマホ: 下部）: 詳細情報 & メッセージエリア */}
        <div className="w-full md:w-[58%] flex-1 flex flex-col min-h-0 bg-white">
          
          {/* ヘッダー・タグエリア */}
          <div className="p-5 md:p-6 pb-4 border-b border-slate-100 flex items-center justify-between shrink-0">
            <div className="flex flex-wrap gap-1.5 md:gap-2">
              {member.current_school && (
                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-sky-50 text-sky-700 border border-sky-100">
                  <School className="w-3 h-3" />
                  {member.current_school}
                </span>
              )}
              {majorsArray[0] && (
                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-100">
                  <GraduationCap className="w-3 h-3" />
                  {majorsArray[0]}
                </span>
              )}
            </div>

            {/* 閉じるボタン（PC表示用） */}
            <button
              onClick={onClose}
              className="hidden md:flex p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full transition-all duration-200 cursor-pointer"
              aria-label="閉じる"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* 詳細スクロールエリア */}
          <div className="flex-1 overflow-y-auto p-5 md:p-6 space-y-5">
            
            {/* 詳細情報カード */}
            <div className="rounded-2xl border border-slate-150 bg-slate-50/70 p-4 space-y-3">
              <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-widest">
                Profile Details
              </h4>
              <div className="divide-y divide-slate-200/60">
                {infoItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="py-2.5 flex items-start gap-3 text-xs md:text-sm first:pt-1 last:pb-1">
                      <div className="w-4 h-4 text-sky-500 shrink-0 mt-0.5">
                        <Icon className="w-4 h-4" />
                      </div>
                      <span className="text-slate-400 font-semibold w-24 md:w-28 shrink-0">
                        {item.label}
                      </span>
                      <span className="text-slate-800 font-bold flex-1">
                        {item.value}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 一言メッセージ（short_message） */}
            {member.short_message && (
              <div className="rounded-2xl p-5 bg-gradient-to-br from-sky-50 to-blue-50/50 border border-sky-100 shadow-xs relative overflow-hidden">
                <div className="flex items-center gap-1.5 text-sky-600 mb-2">
                  <Sparkles className="w-4 h-4" />
                  <h4 className="text-xs font-black uppercase tracking-wider">
                    留学生からのメッセージ
                  </h4>
                </div>
                <p className="text-xs md:text-sm text-slate-700 font-bold leading-relaxed whitespace-pre-wrap">
                  {member.short_message}
                </p>
              </div>
            )}
          </div>

          {/* フッター */}
          <div className="p-4 md:p-5 border-t border-slate-100 bg-slate-50/50 flex justify-end shrink-0">
            <button
              onClick={onClose}
              className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl transition-all duration-200 shadow-sm active:scale-95 cursor-pointer"
            >
              閉じる
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
