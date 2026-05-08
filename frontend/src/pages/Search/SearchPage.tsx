import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { type Member, memberMatchesQuery, HighlightedText } from './SearchBar';
import { apiClient } from '../../lib/apiClient';

type FilterTab = 'all' | 'members';

// ==========================================
// メインページ
// ==========================================

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [members, setMembers] = useState<Member[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [vectorResults, setVectorResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    apiClient.get('/api/basic_profile_info')
      .then(res => res.json())
      .then(data => setMembers(data))
      .catch(err => console.error('メンバー取得エラー:', err))
      .finally(() => setIsLoading(false));
  }, []);

  // URLのクエリパラメータが変わったら state に反映する（ブラウザの「戻る」対応）
  useEffect(() => {
    const q = searchParams.get('q') ?? '';
    if (q !== query) {
      setQuery(q);
    }
  }, [searchParams]);

  // 300msデバウンス → ME5でベクトル検索
  useEffect(() => {
    if (!query.trim()) {
      setVectorResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      try {
        // apiClient を使うことで、自動で Authorization ヘッダーが付き、リフレッシュも行われる
        const res = await apiClient.post('/api/search/instant', { query });
        const data = await res.json();
        setVectorResults(data.results || []);
        
        // 🚀 スコアを人間に見やすい形(100点満点)にしてコンソール表示
        console.log(`[Vector Search] 「${query}」: ${data.time_ms}ms / ${data.results?.length ?? 0}件`);
        if (data.results && data.results.length > 0) {
          data.results.forEach((r: any, i: number) => {
            // 🎯 スケーリング: 0.65を0点、0.95を100点とする
            const similarity = r.similarity || 0;
            const score = Math.max(0, Math.min(100, ((similarity - 0.65) / 0.3) * 100)).toFixed(2);
            const preview = (r.content || "").replace(/\n/g, " ").slice(0, 40);
            console.log(`  ${i + 1}. 【${score}点】(raw: ${similarity.toFixed(6)}) ${preview}...`);
          });
        }
      } catch (err) {
        console.error('ベクトル検索エラー:', err);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query]);

  const filteredMembers = members.filter(m => memberMatchesQuery(m, query));

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: 'all',     label: 'All',     count: filteredMembers.length + vectorResults.length },
    { key: 'members', label: 'Members', count: filteredMembers.length },
  ];

  const hasNoResults = filteredMembers.length === 0 && vectorResults.length === 0 && !isSearching;

  return (
    <div className="h-full w-full overflow-y-auto bg-white text-gray-900">
      <div className="max-w-3xl mx-auto px-4 py-8">

        {/* ---- 検索バー ---- */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-4 text-gray-900">Search</h1>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  setSearchParams({ q: query }, { replace: true });
                }
              }}
              placeholder="名前、大学、専攻、国などで検索..."
              autoFocus
              className="w-full pl-11 pr-10 py-3.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none shadow-sm transition-all text-sm"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute inset-y-0 right-0 pr-4 flex items-center text-gray-400 hover:text-gray-600"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* ---- フィルタータブ ---- */}
        <div className="flex gap-2 mb-6 border-b border-gray-100 pb-2 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all ${
                activeTab === tab.key
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${
                activeTab === tab.key ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-500'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* ---- 検索結果 ---- */}
        {isLoading ? (
          <LoadingSkeleton />
        ) : query === '' ? (
          <EmptyState />
        ) : hasNoResults ? (
          <NoResults query={query} />
        ) : (
          <div className="space-y-8">

            {/* Members セクション */}
            {(activeTab === 'all' || activeTab === 'members') && filteredMembers.length > 0 && (
              <section>
                <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Members</h2>
                <div className="space-y-2">
                  {filteredMembers.map(member => (
                    <MemberCard key={member.id} member={member} query={query} />
                  ))}
                </div>
              </section>
            )}

            {/* From Answers セクション（ベクトル検索結果） */}
            {activeTab === 'all' && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">From Answers</h2>
                  {isSearching && (
                    <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  )}
                </div>
                {vectorResults.length > 0 ? (
                  <div className="space-y-2">
                    {vectorResults.map(result => (
                      <VectorResultCard key={result.id} result={result} members={members} />
                    ))}
                  </div>
                ) : !isSearching && (
                  <p className="text-sm text-gray-400 py-4 text-center">関連する回答が見つかりませんでした</p>
                )}
              </section>
            )}

          </div>
        )}
      </div>
    </div>
  );
}

// ==========================================
// サブコンポーネント
// ==========================================

function LoadingSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-3 rounded-xl border border-gray-100">
          <div className="w-12 h-12 rounded-xl bg-gray-200 flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-gray-200 rounded w-1/3" />
            <div className="h-3 bg-gray-100 rounded w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center text-gray-400">
      <svg className="w-14 h-14 mb-4 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <p className="text-base font-bold text-gray-500 mb-1">メンバーを検索できます</p>
      <p className="text-sm">名前・大学・専攻・国などで絞り込み</p>
    </div>
  );
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center text-gray-400">
      <svg className="w-14 h-14 mb-4 text-gray-200" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p className="text-base font-bold text-gray-500 mb-1">「{query}」に一致するメンバーがいません</p>
      <p className="text-sm">別のキーワードで試してみてください</p>
    </div>
  );
}

function VectorResultCard({ result, members }: { result: any; members: Member[] }) {
  const navigate = useNavigate();
  const member = members.find(m => m.id === result.metadata?.user_id);
  const avatarUrl = member?.avatar_link || '/assets/images/profile_photo_empty.png';
  const name = member?.name_english || '不明なユーザー';
  const content = (result.content as string) || '';
  const lines = content.split('\n').filter(Boolean);
  const firstLine = lines[0] || '';
  const rest = lines.slice(1).join(' ').slice(0, 60);

  const handleClick = () => {
    if (result.source_type === 'form_answer' && result.metadata?.response_id) {
      const qId = result.metadata.question_id;
      navigate(`/form-responses/${result.metadata.response_id}${qId ? `?questionId=${qId}` : ''}`);
    } else if (member) {
      navigate(`/members/${member.id}`);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`flex items-start gap-3 p-3 rounded-xl border border-gray-100 transition-all shadow-sm ${
        (member || result.metadata?.response_id) ? 'hover:border-blue-200 hover:bg-blue-50 cursor-pointer group' : 'opacity-60'
      }`}
    >
      <img
        src={avatarUrl}
        alt={name}
        className="w-10 h-10 rounded-xl object-cover bg-gray-100 flex-shrink-0 border border-gray-200 mt-0.5"
      />
      <div className="flex-1 overflow-hidden">
        <p className="font-bold text-sm text-gray-900 group-hover:text-blue-700 transition-colors truncate">{name}</p>
        <p className="text-sm text-gray-700 truncate">{firstLine}</p>
        {rest && <p className="text-xs text-gray-400 truncate">{rest}…</p>}
      </div>
      <svg className="w-4 h-4 text-gray-300 group-hover:text-blue-400 flex-shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}

function MemberCard({ member, query }: { member: Member; query: string }) {
  const navigate = useNavigate();
  const avatarUrl = member.avatar_link || '/assets/images/profile_photo_empty.png';
  const majorsText = Array.isArray(member.majors) ? member.majors.join(', ') : member.majors;
  const subText = [member.current_school, member.study_abroad_country, majorsText].filter(Boolean).join(' · ');

  return (
    <div
      onClick={() => navigate(`/members/${member.id}`)}
      className="flex items-center gap-4 p-3 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 cursor-pointer transition-all group shadow-sm"
    >
      <img
        src={avatarUrl}
        alt={member.name_english}
        className="w-12 h-12 rounded-xl object-cover bg-gray-100 flex-shrink-0 border border-gray-200"
      />
      <div className="flex-1 overflow-hidden">
        <p className="font-bold text-gray-900 group-hover:text-blue-700 transition-colors truncate">
          <HighlightedText text={member.name_english || '(No Name)'} query={query} />
          {member.name_kanji && (
            <span className="ml-2 text-sm font-normal text-gray-500">
              <HighlightedText text={member.name_kanji} query={query} />
            </span>
          )}
        </p>
        <p className="text-xs text-gray-500 truncate">
          <HighlightedText text={subText} query={query} />
        </p>
      </div>
      <svg className="w-4 h-4 text-gray-300 group-hover:text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}
