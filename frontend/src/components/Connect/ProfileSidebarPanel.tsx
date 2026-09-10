import { useState, useEffect } from 'react';
import { User, X, ArrowLeft, Loader2, Globe } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { BASIC_INFO_FIELDS } from '../../pages/Profile/basicInfoFields';

interface ProfileSidebarPanelProps {
  userId: string;
  onClose: () => void;
}

/** Helper to format profile field values using BASIC_INFO_FIELDS configuration */
function formatFieldValue(key: string, value: any): string | string[] | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value) && value.length === 0) return null;

  const fieldDef = BASIC_INFO_FIELDS[key];

  if (Array.isArray(value)) {
    return value.map((v) => {
      if (typeof v === 'object' && v !== null && 'text' in v) return String(v.text);
      if (fieldDef?.options) {
        const opt = fieldDef.options.find((o) => o.id === v || o.text === v);
        if (opt) return opt.text;
      }
      return String(v);
    });
  }

  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String(value.text);
  }

  // Date formatting
  if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/)) {
    try {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
      }
    } catch {
      // ignore
    }
  }

  if (fieldDef?.options) {
    const opt = fieldDef.options.find((o) => o.id === value || o.text === value);
    if (opt) return opt.text;
  }

  return String(value);
}

interface ProfileFieldItemProps {
  label: string;
  fieldKey: string;
  data: Record<string, any>;
}

function ProfileFieldItem({ label, fieldKey, data }: ProfileFieldItemProps) {
  const formatted = formatFieldValue(fieldKey, data[fieldKey]);
  if (!formatted) return null;

  return (
    <div className="py-2.5 px-3 bg-gray-900/60 rounded-xl border border-gray-800/80 space-y-1">
      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">
        {label}
      </span>
      {Array.isArray(formatted) ? (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {formatted.map((val, i) => (
            <span
              key={i}
              className="text-xs px-2 py-0.5 bg-gray-800 text-gray-200 rounded-md font-medium border border-gray-700/60"
            >
              {val}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-100 font-medium whitespace-pre-wrap leading-relaxed">
          {formatted}
        </p>
      )}
    </div>
  );
}

export default function ProfileSidebarPanel({ userId, onClose }: ProfileSidebarPanelProps) {
  const [profileData, setProfileData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    const loadProfile = async () => {
      try {
        const res = await apiClient.get(`/api/basic_profile_info/${encodeURIComponent(userId)}`);
        if (!isMounted) return;
        if (!res.ok) {
          throw new Error(`プロフィールの取得に失敗しました (${res.status})`);
        }
        const data = await res.json();
        if (isMounted) {
          setProfileData(data);
        }
      } catch (e: any) {
        if (isMounted) {
          setError(e?.message || 'プロフィールの読み込み中にエラーが発生しました');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadProfile();
    return () => {
      isMounted = false;
    };
  }, [userId]);

  const avatarUrl = profileData?.avatar_link || null;
  const nameEnglish = profileData?.name_english?.trim() || '';
  const nameKanji = profileData?.name_kanji?.trim() || '';
  const activeStage = profileData?.active_stage_role_id || null;

  return (
    <div className="h-full flex flex-col bg-gray-950 text-white">
      {/* Panel Navigation Bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3.5 border-b border-gray-800/80">
        <button
          onClick={onClose}
          className="sm:hidden p-1.5 -ml-1 rounded-lg hover:bg-gray-800 text-gray-300 transition-colors"
          title="通話に戻る"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <User className="w-4 h-4 text-sky-400 shrink-0" />
        <h2 className="font-bold text-sm flex-1">プロフィール</h2>
        <button
          onClick={onClose}
          className="hidden sm:flex p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
          title="閉じる"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Panel Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {loading && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 space-y-3">
            <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
            <p className="text-xs">プロフィールを読み込み中...</p>
          </div>
        )}

        {error && !loading && (
          <div className="p-4 bg-rose-950/40 border border-rose-500/30 rounded-2xl text-center space-y-2">
            <p className="text-xs text-rose-300">{error}</p>
            <button
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  const res = await apiClient.get(`/api/basic_profile_info/${encodeURIComponent(userId)}`);
                  if (!res.ok) throw new Error(`プロフィールの取得に失敗しました (${res.status})`);
                  const data = await res.json();
                  setProfileData(data);
                } catch (e: any) {
                  setError(e?.message || 'エラーが発生しました');
                } finally {
                  setLoading(false);
                }
              }}
              className="text-xs font-bold text-sky-400 hover:underline"
            >
              再試行
            </button>
          </div>
        )}

        {!loading && !error && profileData && (
          <>
            {/* Header: Avatar & Name (English priority, Kanji small; or Kanji large) */}
            <div className="flex flex-col items-center text-center pt-2 pb-1 space-y-3">
              <div className="w-20 h-20 rounded-full border-2 border-slate-700/80 overflow-hidden bg-slate-800 shadow-xl flex items-center justify-center shrink-0">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <User className="w-10 h-10 text-gray-400" />
                )}
              </div>

              <div className="space-y-0.5 max-w-full px-2">
                {nameEnglish ? (
                  <>
                    <h3 className="text-lg font-black tracking-tight text-gray-100 truncate">
                      {nameEnglish}
                    </h3>
                    {nameKanji && (
                      <p className="text-xs text-gray-400 font-medium truncate">
                        {nameKanji}
                      </p>
                    )}
                  </>
                ) : nameKanji ? (
                  <h3 className="text-lg font-black tracking-tight text-gray-100 truncate">
                    {nameKanji}
                  </h3>
                ) : (
                  <h3 className="text-sm font-semibold text-gray-400 italic">
                    名前未設定
                  </h3>
                )}
              </div>
            </div>

            {/* Basic Profile Section (Excluding names) */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 pb-1 border-b border-gray-800/80">
                <User className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-xs font-bold text-gray-200">基本情報</span>
              </div>
              <div className="space-y-2">
                <ProfileFieldItem label="誕生日" fieldKey="birthday" data={profileData} />
                <ProfileFieldItem label="出身地" fieldKey="hometown" data={profileData} />
                <ProfileFieldItem label="学年" fieldKey="grade_level" data={profileData} />
                <ProfileFieldItem label="自分の強み・特徴" fieldKey="personality" data={profileData} />
                <ProfileFieldItem label="大切にしている価値観" fieldKey="important_values" data={profileData} />
                <ProfileFieldItem label="将来の展望" fieldKey="future_image" data={profileData} />
              </div>
            </div>

            {/* Study Abroad / Stage Profile Section */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center gap-1.5 pb-1 border-b border-gray-800/80">
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-xs font-bold text-gray-200">留学プロフィール</span>
              </div>

              <div className="space-y-2">
                <ProfileFieldItem label="現在の状況" fieldKey="active_stage_role_id" data={profileData} />

                {/* Pre-study abroad */}
                {activeStage === '留学前' && (
                  <>
                    <ProfileFieldItem label="留学への関心度" fieldKey="study_abroad_interest_level" data={profileData} />
                    <ProfileFieldItem label="希望時期" fieldKey="expected_timing" data={profileData} />
                    <ProfileFieldItem label="興味のある国" fieldKey="interested_countries" data={profileData} />
                    <ProfileFieldItem label="興味のある地域" fieldKey="interested_areas" data={profileData} />
                    <ProfileFieldItem label="希望する留学形態" fieldKey="interested_study_abroad_types" data={profileData} />
                    <ProfileFieldItem label="興味のある専攻" fieldKey="interested_majors" data={profileData} />
                  </>
                )}

                {/* Currently abroad */}
                {activeStage === '留学中' && (
                  <>
                    <ProfileFieldItem label="留学先（国）" fieldKey="study_abroad_country" data={profileData} />
                    <ProfileFieldItem label="留学先（都市）" fieldKey="study_abroad_city" data={profileData} />
                    <ProfileFieldItem label="留学形態" fieldKey="study_abroad_type" data={profileData} />
                    <ProfileFieldItem label="留学歴" fieldKey="study_abroad_history" data={profileData} />
                    <ProfileFieldItem label="語学学校" fieldKey="english_school" data={profileData} />
                    <ProfileFieldItem label="現在の学校" fieldKey="current_school" data={profileData} />
                    <ProfileFieldItem label="学歴" fieldKey="school_history" data={profileData} />
                    <ProfileFieldItem label="専攻" fieldKey="majors" data={profileData} />
                    <ProfileFieldItem label="副専攻" fieldKey="minors" data={profileData} />
                    <ProfileFieldItem label="専攻歴" fieldKey="major_history" data={profileData} />
                  </>
                )}

                {/* Post-study abroad */}
                {activeStage === '留学後' && (
                  <>
                    <ProfileFieldItem label="留学先（国）" fieldKey="study_abroad_country" data={profileData} />
                    <ProfileFieldItem label="留学先（都市）" fieldKey="study_abroad_city" data={profileData} />
                    <ProfileFieldItem label="留学形態" fieldKey="study_abroad_type" data={profileData} />
                    <ProfileFieldItem label="留学歴" fieldKey="study_abroad_history" data={profileData} />
                    <ProfileFieldItem label="語学学校" fieldKey="english_school" data={profileData} />
                    <ProfileFieldItem label="卒業した海外大学" fieldKey="last_overseas_university" data={profileData} />
                    <ProfileFieldItem label="学歴" fieldKey="school_history" data={profileData} />
                    <ProfileFieldItem label="専攻" fieldKey="majors" data={profileData} />
                    <ProfileFieldItem label="副専攻" fieldKey="minors" data={profileData} />
                    <ProfileFieldItem label="専攻歴" fieldKey="major_history" data={profileData} />
                  </>
                )}

                {/* Guardian */}
                {activeStage === '保護者' && (
                  <>
                    <ProfileFieldItem label="お子様のユーザーID" fieldKey="child_id" data={profileData} />
                    <ProfileFieldItem label="懸念点・関心事" fieldKey="concerns" data={profileData} />
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
