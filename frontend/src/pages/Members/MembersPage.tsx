import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../../lib/apiClient';

// ==========================================
// 💀 新しい縦型カード用スケルトン
// ==========================================
function MembersSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6 pb-12 animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col h-full">
          {/* 上部: 写真 (正方形) */}
          <div className="w-full aspect-square bg-gray-200" />
          {/* 下部: 情報 (フレキシブル) */}
          <div className="flex-1 p-4 md:p-5 flex flex-col space-y-3">
            <div className="h-5 bg-gray-200 rounded w-3/4" />
            <div className="space-y-2 mt-auto pt-2">
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="h-3 bg-gray-100 rounded w-2/3" />
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
export default function MembersPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // スマホ用サイドバー開閉

  // --- フィルター用State ---
  const [searchQuery, setSearchQuery] = useState('');
  const [showOnlyActive, setShowOnlyActive] = useState(true);
  const [selectedSchools, setSelectedSchools] = useState<string[]>([]);
  const [selectedMajors, setSelectedMajors] = useState<string[]>([]);

  // --- フィルターの選択肢（動的に生成） ---
  const [availableSchools, setAvailableSchools] = useState<string[]>([]);
  const [availableMajors, setAvailableMajors] = useState<string[]>([]);

  useEffect(() => {
    const fetchMembers = async () => {
      try {
        const response = await apiClient.get('/api/basic_profile_info?role=smiring_member');
        const data = await response.json();
        setMembers(data);

        // 🌟 大学の出現回数をカウントして、多い順にソート
        const schoolCounts = data.reduce((acc: any, m: any) => {
          if (m.current_school) {
            acc[m.current_school] = (acc[m.current_school] || 0) + 1;
          }
          return acc;
        }, {});

        const sortedSchools = Object.keys(schoolCounts).sort((a, b) => schoolCounts[b] - schoolCounts[a]);
        setAvailableSchools(sortedSchools);

        // 🌟 専攻の出現回数をカウントして、多い順にソート（配列対応）
        const majorCounts = data.reduce((acc: any, m: any) => {
          if (!m.majors) return acc;

          // APIのデータが配列 ['CS', 'Math'] でも、文字列 'CS' でも処理できるように正規化
          const majorArray = Array.isArray(m.majors) ? m.majors : [m.majors];

          majorArray.forEach((major: string) => {
            acc[major] = (acc[major] || 0) + 1;
          });
          return acc;
        }, {});

        const sortedMajors = Object.keys(majorCounts).sort((a, b) => majorCounts[b] - majorCounts[a]);
        setAvailableMajors(sortedMajors);

      } catch (error) {
        console.error('メンバー取得エラー:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchMembers();
  }, []);

  // --- 🌟 フィルタリング処理 ---
  const filteredMembers = members.filter(member => {
    // 1. 検索バーの判定
    const searchTarget = `${member.name_english || ''} ${member.name_kanji || ''}`.toLowerCase();
    const matchesSearch = searchTarget.includes(searchQuery.toLowerCase());

    // 2. 大学の判定（何も選ばれていなければ全てOK）
    const matchesSchool = selectedSchools.length === 0 || selectedSchools.includes(member.current_school);

    // 3. 専攻の判定（🌟 配列と文字列の両方に対応）
    const matchesMajor = selectedMajors.length === 0 || (
      member.majors && (
        Array.isArray(member.majors)
          // 配列の場合：持っている専攻のうち、どれか1つでも選択リスト(selectedMajors)に含まれていればOK
          ? member.majors.some((major: string) => selectedMajors.includes(major))
          // 文字列の場合：今まで通りの判定
          : selectedMajors.includes(member.majors)
      )
    );

    // 4. アクティブ判定（トグルがオンの場合のみアクティブユーザーに絞る）
    const matchesActive = !showOnlyActive || isActive(member.last_sign_in_at);

    return matchesSearch && matchesSchool && matchesMajor && matchesActive;
  });

  const toggleFilter = (value: string, currentList: string[], setList: React.Dispatch<React.SetStateAction<string[]>>) => {
    if (currentList.includes(value)) {
      setList(currentList.filter(item => item !== value));
    } else {
      setList([...currentList, value]);
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-gray-50">

      {/* ==========================================
          左側：サイドバー (フィルター)
      ========================================== */}
      <div className={`
        fixed inset-y-0 left-0 z-40 w-72 bg-white border-r border-gray-200 transform transition-transform duration-300 ease-in-out flex flex-col
        md:relative md:translate-x-0
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        <div className="p-6 border-b border-gray-100 flex justify-between items-center">
          <h2 className="text-xl font-bold text-gray-800">Filters</h2>
          <button onClick={() => setIsSidebarOpen(false)} className="md:hidden text-gray-400 hover:text-gray-600">
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">

          {/* 名前検索 */}
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-gray-700">名前検索</h3>
            <div className="relative">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
                placeholder="Name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* 大学フィルター */}
          {availableSchools.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-gray-700">大学 (University)</h3>
              <div className="space-y-2">
                {availableSchools.map(school => (
                  <label key={school} className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      checked={selectedSchools.includes(school)}
                      onChange={() => toggleFilter(school, selectedSchools, setSelectedSchools)}
                    />
                    <span className="text-sm text-gray-600 group-hover:text-gray-900 truncate">{school}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 専攻フィルター */}
          {availableMajors.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-gray-700">専攻 (Major)</h3>
              <div className="space-y-2">
                {availableMajors.map(major => (
                  <label key={major} className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      checked={selectedMajors.includes(major)}
                      onChange={() => toggleFilter(major, selectedMajors, setSelectedMajors)}
                    />
                    <span className="text-sm text-gray-600 group-hover:text-gray-900 truncate">{major}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* スマホ用サイドバー背景オーバーレイ */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-30 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* ==========================================
          右側：メイングリッド
      ========================================== */}
      <div className="flex-1 p-6 md:p-8 h-full overflow-y-auto">

        {/* ヘッダーエリア */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Our Members</h1>
            <p className="text-sm text-gray-500 mt-1">{filteredMembers.length} members found</p>
          </div>

          <div className="flex items-center gap-4">
            {/* アクティブメンバーのみのトグル */}
            <label className="flex items-center gap-2.5 cursor-pointer select-none bg-white border border-gray-200 px-4 py-2.5 rounded-xl shadow-sm hover:bg-gray-50 hover:border-gray-300 transition-all text-sm font-bold text-gray-600">
              <input
                type="checkbox"
                checked={showOnlyActive}
                onChange={(e) => setShowOnlyActive(e.target.checked)}
                className="sr-only peer"
              />
              <div className="relative w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-green-500"></div>
              <span>Activeのみ表示</span>
            </label>

            {/* スマホ表示の時にだけ出る「フィルターを開く」ボタン */}
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="md:hidden p-2 text-gray-600 bg-white border border-gray-200 shadow-sm hover:bg-gray-50 rounded-lg flex items-center gap-2"
            >
              <FilterIcon />
              <span className="text-sm font-bold">Filter</span>
            </button>
          </div>
        </div>

        {/* メンバーグリッド */}
        {isLoading ? (
          <MembersSkeleton />
        ) : filteredMembers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <SearchIcon className="w-12 h-12 mb-4 text-gray-300" />
            <p>条件に一致するメンバーが見つかりませんでした。</p>
            <button
              onClick={() => { setSearchQuery(''); setSelectedSchools([]); setSelectedMajors([]); setShowOnlyActive(false); }}
              className="mt-4 text-blue-600 font-bold hover:underline"
            >
              フィルターをクリアする
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4 md:gap-6 pb-12">
            {filteredMembers.map((member) => (
              <VerticalMemberCard key={member.id} member={member} />
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

// ==========================================
// 💳 縦型プロフィールカードコンポーネント (2:1比率)
// ==========================================
const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

function isActive(lastLoginAt: string | null): boolean {
  if (!lastLoginAt) return false;
  return Date.now() - new Date(lastLoginAt).getTime() < SIX_MONTHS_MS;
}

function VerticalMemberCard({ member }: { member: any }) {
  const nameEnglish = member.name_english || 'No Name';
  const nameKanji = member.name_kanji || '';
  const avatarUrl = member.avatar_link || '/assets/images/profile_photo_empty.png';
  const active = isActive(member.last_sign_in_at);

  // 専攻を配列化（バッジ表示用）
  const majorsArray = member.majors
    ? (Array.isArray(member.majors) ? member.majors : [member.majors])
    : [];

  const navigate = useNavigate();

  return (
    <div
      className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-lg hover:border-blue-200 hover:-translate-y-1 transition-all duration-300 cursor-pointer flex flex-col h-full group"
      onClick={() => navigate(`/members/${member.id}`)}
    >
      {/* 上部: 写真エリア (正方形で切り抜き) */}
      <div className="w-full aspect-square relative bg-gray-100 overflow-hidden shrink-0">
        <img
          src={avatarUrl}
          alt={nameEnglish}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
        />
        {/* 背景のグラデーション（オプション: 写真下部の影でテキストを見やすくする） */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      </div>

      {/* 下部: 情報エリア (内容に応じて伸びる) */}
      <div className="flex-1 p-4 md:p-5 flex flex-col bg-white">
        <div className="flex items-start gap-2 flex-wrap">
          <h3 className="font-bold text-gray-900 text-base md:text-lg leading-tight line-clamp-2 group-hover:text-blue-600 transition-colors">
            {nameEnglish}
          </h3>
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold mt-0.5 flex-shrink-0 ${active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-500' : 'bg-gray-400'}`} />
            {active ? 'Active' : 'Non-active'}
          </span>
        </div>
        {nameKanji && (
          <p className="text-xs md:text-sm text-gray-400 mt-1 line-clamp-1">{nameKanji}</p>
        )}

        <div className="mt-auto pt-4 space-y-2">
          {member.current_school && (
            <IconText icon={<SchoolIcon />} text={member.current_school} />
          )}
          {majorsArray.length > 0 && (
            <div className="flex items-start text-xs md:text-sm text-gray-500">
              <div className="w-4 h-4 mr-1.5 mt-0.5 flex items-center justify-center text-gray-400 shrink-0">
                <WorkIcon />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {majorsArray.map((major: string, idx: number) => (
                  <span key={idx} className="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-md text-[10px] md:text-xs font-bold border border-blue-100">
                    {major}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- ヘルパー: アイコンとテキストを並べる ---
function IconText({ icon, text }: { icon: React.ReactNode, text: string }) {
  return (
    <div className="flex items-center text-xs md:text-sm text-gray-500">
      <div className="w-4 h-4 mr-1.5 flex items-center justify-center text-gray-400 shrink-0">
        {icon}
      </div>
      <span className="line-clamp-2">{text}</span>
    </div>
  );
}

// --- SVGアイコン群 ---
const SearchIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
);

const FilterIcon = () => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const SchoolIcon = () => (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path d="M12 14l9-5-9-5-9 5 9 5z" />
    <path d="M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14zm-4 6v-7.5l4-2.222" />
  </svg>
);

const WorkIcon = () => (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);