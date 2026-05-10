import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { type Member, memberMatchesQuery, HighlightedText } from './SearchBar';
import { apiClient } from '../../lib/apiClient';
import { Sparkles, Send, Search, X, ChevronRight, ChevronDown } from 'lucide-react';

type AggregatedResult = { 
  user_id: string, 
  total_score: number, 
  matched_keywords: string[],
  matches?: any[]
};

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '');
  const [lastConfirmedQuery, setLastConfirmedQuery] = useState(() => searchParams.get('q') ?? '');
  const [members, setMembers] = useState<Member[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]); // 🎯 Member型からany[]（または汎用型）に変更
  const [isLoading, setIsLoading] = useState(true);
  const [vectorResults, setVectorResults] = useState<AggregatedResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false); // 🎯 フォーカス状態を管理
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null); // 🎯 inputへの参照を追加
  const lastExecutedQueryRef = useRef<string>(''); // 🎯 二重実行防止用
  const navigate = useNavigate();

  // メンバー情報の初期取得
  useEffect(() => {
    apiClient.get('/api/basic_profile_info')
      .then(res => res.json())
      .then(data => setMembers(data))
      .catch(err => console.error('メンバー取得エラー:', err))
      .finally(() => setIsLoading(false));
  }, []);

  // 🎯 初回マウント時、または遷移時にフォーカスを強制的に外す
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.blur();
    }
  }, [lastConfirmedQuery]); 

  // URLのクエリパラメータが変わったら state に反映
  useEffect(() => {
    const q = searchParams.get('q') ?? '';
    setQuery(q);
    setLastConfirmedQuery(q);
    if (q) {
      handleConfirmSearch(q, false);
    }
  }, [searchParams]);

  // クリック外でのサジェスト閉じ
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsSuggestionsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // 🔍 サジェスト用ハイブリッド検索 (300ms デバウンス)
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSuggestions([]);
      return;
    }

    if (trimmed === lastConfirmedQuery) {
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      const localMatches = members.filter(m => memberMatchesQuery(m, trimmed));
      
      if (localMatches.length >= 6) {
        setSuggestions(localMatches.slice(0, 6));
        setIsSearching(false);
        setIsSuggestionsOpen(true);
        return;
      }

      try {
        const res = await apiClient.post('/api/search/instant', { query: trimmed });
        const data = await res.json();
        
        // 🎯 スコア0.75以上のものを候補として採用（少し広めに）
        const highScores = (data.results || []).filter((r: any) => (r.similarity || 0) >= 0.75);
        
        const localIds = new Set(localMatches.map(m => m.id));
        const combinedSuggestions: any[] = localMatches.map(m => ({ ...m, type: 'member' }));
        
        for (const r of highScores) {
          const uId = r.metadata?.user_id || r.source_id;
          
          if (r.source_type === 'form_answer') {
            // フォーム回答をサジェストに追加
            combinedSuggestions.push({ ...r, type: 'form_answer' });
          } else {
            // プロフィール項目（人）の場合
            if (!localIds.has(uId) && !combinedSuggestions.some(s => s.id === uId)) {
              const m = members.find(m => m.id === uId);
              if (m) combinedSuggestions.push({ ...m, type: 'member' });
            }
          }
        }
        
        setSuggestions(combinedSuggestions.slice(0, 8));
        setIsSuggestionsOpen(true);
      } catch (err) {
        setSuggestions(localMatches.slice(0, 6));
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, members]);

  // 🚀 本検索 (確定処理)
  const handleConfirmSearch = async (targetQuery: string, updateUrl = true) => {
    const trimmed = targetQuery.trim();
    if (!trimmed) {
      setLastConfirmedQuery('');
      setVectorResults([]);
      setSearchParams({}, { replace: true });
      return;
    }

    // 🎯 全く同じクエリが連続で呼ばれたら無視する
    if (lastExecutedQueryRef.current === trimmed) return;
    lastExecutedQueryRef.current = trimmed;

    setLastConfirmedQuery(trimmed);
    if (updateUrl) {
      setSearchParams({ q: trimmed }, { replace: true });
    }
    
    setIsSuggestionsOpen(false);
    setIsSearching(true);

    try {
      const res = await apiClient.post('/api/search/instant', { 
        query: trimmed, 
        limit: 15, 
        model: 'groq' 
      });
      const data = await res.json();
      setVectorResults(data.results || []);
    } catch (err) {
      console.error('本検索エラー:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const filteredMembers = useMemo(() => {
    if (!lastConfirmedQuery) return [];
    return members.filter(m => memberMatchesQuery(m, lastConfirmedQuery));
  }, [members, lastConfirmedQuery]);

  const hasNoResults = lastConfirmedQuery !== '' && filteredMembers.length === 0 && vectorResults.length === 0 && !isSearching;

  return (
    <div className="h-full w-full overflow-y-auto bg-white text-gray-900">
      <div className="max-w-3xl mx-auto px-4 py-8">

        {/* ---- 検索バー ---- */}
        <div className="mb-6 relative z-50" ref={wrapperRef}>
          <h1 className="text-2xl font-bold mb-4 text-gray-900">Search</h1>
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input
              ref={inputRef}
              type="text"
              autoComplete="off"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setIsSuggestionsOpen(true);
              }}
              onFocus={() => {
                setIsFocused(true);
                if (query.trim().length > 0 && suggestions.length > 0) {
                  setIsSuggestionsOpen(true);
                }
              }}
              onBlur={() => {
                // 🎯 サジェスト内のクリックを先に反応させるため、少しだけ遅らせて閉じる
                setTimeout(() => setIsFocused(false), 200);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  handleConfirmSearch(query);
                }
              }}
              placeholder="名前、大学、専攻、国などで検索..."
              className="w-full pl-11 pr-12 py-3.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none shadow-sm transition-all text-sm"
            />
            
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 gap-2">
              {query && (
                <>
                  <button
                    onClick={() => {
                      setQuery('');
                      setSuggestions([]);
                      setLastConfirmedQuery('');
                      setVectorResults([]);
                      setSearchParams({}, { replace: true });
                    }}
                    className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                  <div className="w-[1px] h-4 bg-gray-200" />
                </>
              )}
              <button
                onClick={() => navigate('/search/chat', { state: { q: query.trim() } })}
                className="p-1 text-blue-500 hover:text-blue-700 transition-all hover:scale-110"
                title="AIに相談する"
              >
                {isSearching ? (
                  <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Sparkles className="h-5 w-5" />
                )}
              </button>
            </div>
          </div>

          {/* 🎯 サジェストドロップダウン: フォーカスあり ＋ 文字あり なら絶対出す */}
          {isFocused && query.trim().length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl border border-gray-200 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
              <div className="p-2 space-y-1">
                {isSearching ? (
                  <div className="p-4 text-center text-sm text-gray-400 font-bold flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    検索中...
                  </div>
                ) : (
                  <>
                    {suggestions.length > 0 ? (
                      suggestions.map((s, idx) => {
                        const isMember = s.type === 'member' || (!s.type && s.name_english);
                        const member = isMember ? s : members.find(m => m.id === (s.metadata?.user_id || s.source_id));
                        const avatarUrl = member?.avatar_link || '/assets/images/profile_photo_empty.png';
                        const title = isMember ? s.name_english : (s.content || "").split('\n')[0];
                        const subTitle = isMember 
                          ? [s.current_school, s.study_abroad_country].filter(Boolean).join(' · ')
                          : `回答 by ${member?.name_english || '不明'}`;

                        return (
                          <button
                            key={s.id || idx}
                            onClick={() => {
                              if (s.type === 'form_answer' && s.metadata?.response_id) {
                                const qId = s.metadata.question_id;
                                navigate(`/form-responses/${s.metadata.response_id}${qId ? `?questionId=${qId}` : ''}`);
                              } else {
                                navigate(`/members/${member?.id || s.id}`);
                              }
                            }}
                            className="w-full flex items-center gap-3 p-2 hover:bg-blue-50 rounded-xl transition-all group text-left"
                          >
                            <img 
                              src={avatarUrl} 
                              alt="" 
                              className="w-10 h-10 rounded-lg object-cover border border-gray-100 flex-shrink-0" 
                            />
                            <div className="flex-1 overflow-hidden">
                              <p className="font-bold text-sm text-gray-900 group-hover:text-blue-600 transition-colors truncate">
                                {title}
                              </p>
                              <p className="text-[10px] text-gray-500 truncate">
                                {subTitle}
                              </p>
                            </div>
                          </button>
                        );
                      })
                    ) : (
                      <button 
                        onClick={() => handleConfirmSearch(query)}
                        className="w-full p-4 text-center text-sm text-gray-500 font-bold hover:bg-gray-50 rounded-xl transition-colors flex flex-col items-center gap-1"
                      >
                        <span>「{query}」</span>
                        <span className="text-blue-500">エンターキーで詳細検索</span>
                      </button>
                    )}
                  </>
                )}
              </div>
              <div className="bg-gray-50 p-2 border-t border-gray-100">
                <button
                  onClick={() => handleConfirmSearch(query)}
                  className="w-full text-center py-2 text-xs font-bold text-blue-600 hover:text-blue-700 flex items-center justify-center gap-2"
                >
                  「{query}」のすべての結果を表示
                  <kbd className="px-1.5 py-0.5 rounded border border-blue-200 bg-white text-[10px] font-sans">Enter</kbd>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ---- 検索結果 ---- */}
        {isLoading || (isSearching && !isSuggestionsOpen) ? (
          <LoadingSkeleton />
        ) : lastConfirmedQuery === '' ? (
          <EmptyState />
        ) : hasNoResults ? (
          <NoResults query={lastConfirmedQuery} />
        ) : (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center justify-between mb-3 border-b border-gray-100 pb-2">
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Results</h2>
            </div>
            
            <div className="space-y-2">
              {(() => {
                const resultItems: { member: Member; keywords: string[]; matches: any[] }[] = [];
                const localIds = new Set<string>();

                // 1. 部分一致の結果を追加（キーワードなし）
                filteredMembers.forEach(m => {
                  resultItems.push({ member: m, keywords: [], matches: [] });
                  localIds.add(m.id);
                });

                // 2. ベクトル検索の結果を追加・マージ
                vectorResults.forEach(r => {
                  const m = members.find(m => m.id === r.user_id);
                  if (!m) {
                    console.warn(`⚠️ プロフィールが見つからないID: ${r.user_id}`);
                    return;
                  }

                  const existingIndex = resultItems.findIndex(item => item.member.id === r.user_id);
                  if (existingIndex === -1) {
                    // 新規追加
                    resultItems.push({ 
                      member: m, 
                      keywords: r.matched_keywords || [], 
                      matches: r.matches || [] 
                    });
                  } else {
                    // 既に部分一致（名前など）で追加されている場合は情報を補完
                    if (r.matched_keywords) {
                      resultItems[existingIndex].keywords = Array.from(new Set([...resultItems[existingIndex].keywords, ...r.matched_keywords]));
                    }
                    if (r.matches) {
                      resultItems[existingIndex].matches = r.matches;
                    }
                  }
                });

                return resultItems.map(({ member, keywords, matches }) => (
                  <MemberCard 
                    key={member.id} 
                    member={member} 
                    query={lastConfirmedQuery} 
                    matchedKeywords={keywords}
                    matches={matches}
                  />
                ));
              })()}
            </div>
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
      <Search className="w-14 h-14 mb-4 text-gray-200" />
      <p className="text-base font-bold text-gray-500 mb-1">メンバーを検索できます</p>
      <p className="text-sm">名前・大学・専攻・国などで絞り込み</p>
    </div>
  );
}

function NoResults({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center text-gray-400">
      <div className="relative mb-4">
        <Search className="w-14 h-14 text-gray-200" />
        <X className="w-6 h-6 text-red-300 absolute -bottom-1 -right-1 bg-white rounded-full p-0.5" />
      </div>
      <p className="text-base font-bold text-gray-500 mb-1">「{query}」に一致する結果はありません</p>
      <p className="text-sm">別のキーワードで試してみてください</p>
    </div>
  );
}

function MemberCard({ member, query, matchedKeywords = [], matches = [] }: { member: Member; query: string; matchedKeywords?: string[]; matches?: any[] }) {
  const navigate = useNavigate();
  const [isExpanded, setIsExpanded] = useState(false);
  const avatarUrl = member.avatar_link || '/assets/images/profile_photo_empty.png';
  const majorsText = Array.isArray(member.majors) ? member.majors.join(', ') : member.majors;
  const subText = [member.current_school, member.study_abroad_country, majorsText].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50/30 transition-all shadow-sm overflow-hidden group bg-white">
      {/* メインのカード部分 */}
      <div
        className="flex items-center gap-4 p-3 cursor-pointer"
        onClick={() => {
          if (matches.length > 0) {
            setIsExpanded(!isExpanded);
          } else {
            navigate(`/members/${member.id}`);
          }
        }}
      >
        <img
          src={avatarUrl}
          alt={member.name_english}
          className="w-12 h-12 rounded-xl object-cover bg-gray-100 flex-shrink-0 border border-gray-200"
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/members/${member.id}`);
          }}
        />
        <div className="flex-1 overflow-hidden">
          <p 
            className="font-bold text-gray-900 group-hover:text-blue-700 transition-colors truncate"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/members/${member.id}`);
            }}
          >
            <HighlightedText text={member.name_english || '(No Name)'} query={query} />
            {member.name_kanji && (
              <span className="ml-2 text-sm font-normal text-gray-500">
                <HighlightedText text={member.name_kanji} query={query} />
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500 truncate mb-1">
            <HighlightedText text={subText} query={query} />
          </p>
          
          {/* 🎯 AIがマッチしたと判断したキーワードのバッジ */}
          {matchedKeywords && matchedKeywords.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {matchedKeywords.map((kw, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded border border-blue-100 bg-blue-50 text-[10px] font-bold text-blue-600">
                  {kw}
                </span>
              ))}
            </div>
          )}
        </div>
        
        {/* トグルアイコン（マッチ情報がない場合はSendアイコンを出してそのままプロフィールへ） */}
        {matches.length > 0 ? (
          <div className="p-2 text-gray-400 hover:text-blue-500 rounded-full hover:bg-blue-100 transition-colors">
            {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
          </div>
        ) : (
          <div 
            className="p-2 text-gray-300 hover:text-blue-400 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/members/${member.id}`);
            }}
          >
            <Send className="w-4 h-4" />
          </div>
        )}
      </div>

      {/* 展開されるアコーディオン部分: マッチ詳細 */}
      {isExpanded && matches.length > 0 && (
        <div className="px-3 pb-3 pt-1 border-t border-blue-50 bg-blue-50/20">
          <div className="flex flex-col gap-2 mt-2">
            {matches.map((m, idx) => (
              <div 
                key={idx}
                onClick={() => {
                  if (m.source_type === 'form_answer' && m.metadata?.response_id) {
                    const qId = m.metadata.question_id;
                    navigate(`/form-responses/${m.metadata.response_id}${qId ? `?questionId=${qId}` : ''}`);
                  } else {
                    navigate(`/members/${member.id}`);
                  }
                }}
                className="flex flex-col gap-1 p-2 rounded-lg bg-white border border-blue-100 hover:border-blue-300 hover:shadow-sm cursor-pointer transition-all"
              >
                <div className="flex items-center gap-1.5">
                  <span className="px-1.5 py-0.5 rounded bg-blue-100 text-[10px] font-bold text-blue-700">
                    {m.keyword}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {m.source_type === 'form_answer' ? '📝 フォームの回答' : '👤 プロフィール'}
                  </span>
                </div>
                <p className="text-xs text-gray-700 line-clamp-2 leading-relaxed">
                  {m.content}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
