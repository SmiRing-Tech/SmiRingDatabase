import React, { useState, useEffect } from 'react';
import { apiClient } from '../../lib/apiClient';
import StudyInfoDetailModal from './StudyInfoDetailModal';
import {
  Search,
  Filter,
  X,
  School,
  BookOpen,
  MapPin,
  GraduationCap,
} from 'lucide-react';

// ==========================================
// 💀 スケルトンローディングコンポーネント
// ==========================================
function StudyInfoSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6 pb-12 animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden flex flex-col h-full">
          <div className="w-full aspect-square bg-slate-200" />
          <div className="flex-1 p-4 md:p-5 flex flex-col space-y-3">
            <div className="h-5 bg-slate-200 rounded w-3/4" />
            <div className="space-y-2 mt-auto pt-2">
              <div className="h-3 bg-slate-100 rounded w-full" />
              <div className="h-3 bg-slate-100 rounded w-2/3" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ==========================================
// 📱 メインページコンポーネント
// ==========================================
export default function StudyInfoPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<any | null>(null);

  // --- フィルター用State ---
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [selectedSchools, setSelectedSchools] = useState<string[]>([]);
  const [selectedMajors, setSelectedMajors] = useState<string[]>([]);

  // --- フィルターの選択肢（動的生成） ---
  const [availableCountries, setAvailableCountries] = useState<string[]>([]);
  const [availableSchools, setAvailableSchools] = useState<string[]>([]);
  const [availableMajors, setAvailableMajors] = useState<string[]>([]);

  useEffect(() => {
    const fetchMembers = async () => {
      try {
        const response = await apiClient.get('/api/basic_profile_info?role=smiring_member');
        const data = await response.json();
        setMembers(data || []);

        // 国の出現頻度カウント & ソート
        const countryCounts = (data || []).reduce((acc: any, m: any) => {
          if (m.study_abroad_country) {
            acc[m.study_abroad_country] = (acc[m.study_abroad_country] || 0) + 1;
          }
          return acc;
        }, {});
        setAvailableCountries(Object.keys(countryCounts).sort((a, b) => countryCounts[b] - countryCounts[a]));

        // 大学の出現頻度カウント & ソート
        const schoolCounts = (data || []).reduce((acc: any, m: any) => {
          if (m.current_school) {
            acc[m.current_school] = (acc[m.current_school] || 0) + 1;
          }
          return acc;
        }, {});
        setAvailableSchools(Object.keys(schoolCounts).sort((a, b) => schoolCounts[b] - schoolCounts[a]));

        // 専攻の出現頻度カウント & ソート
        const majorCounts = (data || []).reduce((acc: any, m: any) => {
          if (!m.majors) return acc;
          const majorArray = Array.isArray(m.majors) ? m.majors : [m.majors];
          majorArray.forEach((major: string) => {
            acc[major] = (acc[major] || 0) + 1;
          });
          return acc;
        }, {});
        setAvailableMajors(Object.keys(majorCounts).sort((a, b) => majorCounts[b] - majorCounts[a]));

      } catch (error) {
        console.error('メンバー取得エラー:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchMembers();
  }, []);

  // --- フィルタリング処理 ---
  const filteredMembers = members.filter(member => {
    // 1. 検索バー判定（名前・漢字・大学・国）
    const searchTarget = `${member.name_english || ''} ${member.name_kanji || ''} ${member.current_school || ''} ${member.study_abroad_country || ''}`.toLowerCase();
    const matchesSearch = searchTarget.includes(searchQuery.toLowerCase());

    // 2. 留学先国判定
    const matchesCountry = selectedCountries.length === 0 || selectedCountries.includes(member.study_abroad_country);

    // 3. 大学判定
    const matchesSchool = selectedSchools.length === 0 || selectedSchools.includes(member.current_school);

    // 4. 専攻判定
    const matchesMajor = selectedMajors.length === 0 || (
      member.majors && (
        Array.isArray(member.majors)
          ? member.majors.some((major: string) => selectedMajors.includes(major))
          : selectedMajors.includes(member.majors)
      )
    );

    return matchesSearch && matchesCountry && matchesSchool && matchesMajor;
  });

  const toggleFilter = (value: string, currentList: string[], setList: React.Dispatch<React.SetStateAction<string[]>>) => {
    if (currentList.includes(value)) {
      setList(currentList.filter(item => item !== value));
    } else {
      setList([...currentList, value]);
    }
  };

  const clearAllFilters = () => {
    setSearchQuery('');
    setSelectedCountries([]);
    setSelectedSchools([]);
    setSelectedMajors([]);
  };

  const hasActiveFilters = searchQuery !== '' || selectedCountries.length > 0 || selectedSchools.length > 0 || selectedMajors.length > 0;

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50/50">

      {/* ==========================================
          左側：フィルターサイドバー
      ========================================== */}
      <div className={`
        fixed inset-y-0 left-0 z-40 w-80 bg-white border-r border-slate-100 shadow-2xl md:shadow-none transform transition-transform duration-300 ease-in-out flex flex-col
        md:relative md:translate-x-0 md:z-0
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="p-6 border-b border-slate-100 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-sky-500" />
            <h2 className="text-lg font-black text-slate-800">絞り込み検索</h2>
          </div>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="md:hidden p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-7">
          
          {/* 名前・キーワード検索 */}
          <div className="space-y-2.5">
            <label className="text-xs font-black text-slate-500 uppercase tracking-wider">
              キーワード検索
            </label>
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="名前、大学、国名など"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm
                           focus:outline-none focus:ring-2 focus:ring-sky-400/50 focus:border-sky-400 focus:bg-white
                           transition-all placeholder:text-slate-400 font-medium"
              />
            </div>
          </div>

          {/* 留学先 国 フィルター */}
          {availableCountries.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-black text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-sky-500" />
                  留学先 国
                </label>
                {selectedCountries.length > 0 && (
                  <button
                    onClick={() => setSelectedCountries([])}
                    className="text-[11px] text-sky-500 font-bold hover:underline"
                  >
                    クリア
                  </button>
                )}
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {availableCountries.map(country => (
                  <label key={country} className="flex items-center gap-2.5 p-1.5 hover:bg-sky-50/50 rounded-lg cursor-pointer transition-colors group">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-slate-300 text-sky-500 focus:ring-sky-400"
                      checked={selectedCountries.includes(country)}
                      onChange={() => toggleFilter(country, selectedCountries, setSelectedCountries)}
                    />
                    <span className="text-xs text-slate-700 font-bold group-hover:text-sky-600 truncate">
                      {country}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 留学先 大学 フィルター */}
          {availableSchools.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-black text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <School className="w-3.5 h-3.5 text-sky-500" />
                  大学・学校
                </label>
                {selectedSchools.length > 0 && (
                  <button
                    onClick={() => setSelectedSchools([])}
                    className="text-[11px] text-sky-500 font-bold hover:underline"
                  >
                    クリア
                  </button>
                )}
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {availableSchools.map(school => (
                  <label key={school} className="flex items-center gap-2.5 p-1.5 hover:bg-sky-50/50 rounded-lg cursor-pointer transition-colors group">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-slate-300 text-sky-500 focus:ring-sky-400"
                      checked={selectedSchools.includes(school)}
                      onChange={() => toggleFilter(school, selectedSchools, setSelectedSchools)}
                    />
                    <span className="text-xs text-slate-700 font-bold group-hover:text-sky-600 truncate">
                      {school}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 専攻 フィルター */}
          {availableMajors.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-black text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5 text-sky-500" />
                  専攻
                </label>
                {selectedMajors.length > 0 && (
                  <button
                    onClick={() => setSelectedMajors([])}
                    className="text-[11px] text-sky-500 font-bold hover:underline"
                  >
                    クリア
                  </button>
                )}
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {availableMajors.map(major => (
                  <label key={major} className="flex items-center gap-2.5 p-1.5 hover:bg-sky-50/50 rounded-lg cursor-pointer transition-colors group">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-slate-300 text-sky-500 focus:ring-sky-400"
                      checked={selectedMajors.includes(major)}
                      onChange={() => toggleFilter(major, selectedMajors, setSelectedMajors)}
                    />
                    <span className="text-xs text-slate-700 font-bold group-hover:text-sky-600 truncate">
                      {major}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {hasActiveFilters && (
            <button
              onClick={clearAllFilters}
              className="w-full py-2 px-3 text-xs font-bold text-slate-500 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
            >
              すべてのフィルターをクリア
            </button>
          )}

        </div>
      </div>

      {/* スマホ用サイドバーオーバーレイ */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-slate-900/30 backdrop-blur-[2px] z-30 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* ==========================================
          右側：メインコンテンツエリア
      ========================================== */}
      <div className="flex-1 p-6 md:p-8 h-full overflow-y-auto">

        {/* ページタイトル & コントロール */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-black tracking-[0.2em] uppercase text-sky-500 bg-sky-50 px-2.5 py-0.5 rounded-full border border-sky-100">
                Study Abroad
              </span>
            </div>
            <h1 className="text-2xl md:text-3xl font-black text-slate-900">
              先輩留学生の留学情報
            </h1>
            <p className="text-xs md:text-sm text-slate-500 mt-1">
              {filteredMembers.length} 名の留学生が見つかりました（カードをクリックすると詳細が表示されます）
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* スマホ用フィルター開閉ボタン */}
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="md:hidden px-4 py-2 text-slate-700 bg-white border border-slate-200 shadow-xs hover:bg-slate-50 rounded-xl flex items-center gap-2 text-xs font-bold"
            >
              <Filter className="w-4 h-4 text-sky-500" />
              <span>フィルター</span>
            </button>
          </div>
        </div>

        {/* メンバーカード一覧 */}
        {isLoading ? (
          <StudyInfoSkeleton />
        ) : filteredMembers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center text-slate-400 bg-white rounded-3xl border border-slate-100 shadow-xs p-8">
            <GraduationCap className="w-12 h-12 mb-3 text-slate-300" />
            <p className="text-sm font-bold text-slate-600">条件に一致する留学生が見つかりませんでした。</p>
            <p className="text-xs text-slate-400 mt-1">検索条件を変更するか、フィルターをクリアしてください。</p>
            {hasActiveFilters && (
              <button
                onClick={clearAllFilters}
                className="mt-4 px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white text-xs font-bold rounded-xl transition-colors shadow-xs"
              >
                フィルターをクリア
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 md:gap-6 pb-12">
            {filteredMembers.map((member) => (
              <StudyInfoCard
                key={member.id}
                member={member}
                onClick={() => setSelectedMember(member)}
              />
            ))}
          </div>
        )}

      </div>

      {/* ==========================================
          ポップアップ詳細モーダル
      ========================================== */}
      {selectedMember && (
        <StudyInfoDetailModal
          member={selectedMember}
          onClose={() => setSelectedMember(null)}
        />
      )}

    </div>
  );
}

// ==========================================
// 💳 留学生カードコンポーネント
// ==========================================
function StudyInfoCard({ member, onClick }: { member: any; onClick: () => void }) {
  const nameEnglish = member.name_english || 'No Name';
  const nameKanji = member.name_kanji || '';
  const avatarUrl = member.avatar_link || '/assets/images/profile_photo_empty.png';

  const majorsArray = member.majors
    ? (Array.isArray(member.majors) ? member.majors : [member.majors])
    : [];

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-2xl shadow-xs border border-slate-100 overflow-hidden hover:shadow-xl hover:border-sky-200 hover:-translate-y-1 transition-all duration-300 cursor-pointer flex flex-col h-full group select-none"
    >
      {/* 上部: 写真エリア */}
      <div className="w-full aspect-square relative bg-slate-100 overflow-hidden shrink-0">
        <img
          src={avatarUrl}
          alt={nameEnglish}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          onError={(e) => {
            (e.target as HTMLElement).style.display = 'none';
          }}
        />

        {/* 留学先国バッジ（写真上） */}
        {member.study_abroad_country && (
          <div className="absolute top-2.5 left-2.5 z-10">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-slate-900/75 text-white backdrop-blur-xs shadow-xs">
              <MapPin className="w-2.5 h-2.5 text-sky-400" />
              {member.study_abroad_country}
            </span>
          </div>
        )}

        {/* グラデーションオーバーレイ */}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-900/40 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      </div>

      {/* 下部: 情報エリア */}
      <div className="flex-1 p-4 md:p-5 flex flex-col bg-white">
        <h3 className="font-bold text-slate-900 text-sm md:text-base leading-tight line-clamp-1 group-hover:text-sky-600 transition-colors">
          {nameEnglish}
        </h3>
        {nameKanji && (
          <p className="text-[11px] md:text-xs text-slate-400 mt-0.5 line-clamp-1">{nameKanji}</p>
        )}

        <div className="mt-auto pt-3 space-y-1.5">
          {member.current_school && (
            <div className="flex items-center text-[11px] md:text-xs text-slate-600 font-medium">
              <School className="w-3.5 h-3.5 mr-1.5 text-sky-400 shrink-0" />
              <span className="line-clamp-1">{member.current_school}</span>
            </div>
          )}

          {majorsArray.length > 0 && (
            <div className="flex items-start text-[11px] md:text-xs text-slate-500 pt-1">
              <BookOpen className="w-3.5 h-3.5 mr-1.5 mt-0.5 text-slate-400 shrink-0" />
              <div className="flex flex-wrap gap-1">
                {majorsArray.slice(0, 2).map((major: string, idx: number) => (
                  <span key={idx} className="bg-sky-50 text-sky-700 px-1.5 py-0.5 rounded text-[10px] font-bold border border-sky-100 line-clamp-1">
                    {major}
                  </span>
                ))}
                {majorsArray.length > 2 && (
                  <span className="text-[10px] text-slate-400 self-center">
                    +{majorsArray.length - 2}
                  </span>
                )}
              </div>
            </div>
          )}

          {member.short_message && (
            <div className="pt-2 border-t border-slate-100">
              <p className="text-[10px] md:text-[11px] text-slate-500 line-clamp-2 leading-snug">
                "{member.short_message}"
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
