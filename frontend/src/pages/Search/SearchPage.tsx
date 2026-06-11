import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import HomeSearchBar, { type Member, memberMatchesQuery, HighlightedText } from './SearchBar';
import { apiClient } from '../../lib/apiClient';
import { supabase } from '../../lib/supabase';
import { Search, Send, X, ChevronRight, ChevronDown } from 'lucide-react';
import PhotoViewModal from '../../components/ui/PhotoViewModal';

type AggregatedResult = { 
  total_score: number, 
  matched_keywords: string[],
  
  // 人・学校検索用
  user_id?: string, 
  matches?: any[],

  // 画像検索用
  gallery_id?: string,
  view_url?: string,
  thumbnail_url?: string,
  description?: string,
  image_type?: string,
  visibility?: string,
  basic_profile_info?: any
};

type SearchMode = 'smart' | 'keyword' | 'deep';

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [lastConfirmedQuery, setLastConfirmedQuery] = useState(() => searchParams.get('q') ?? '');
  const [members, setMembers] = useState<Member[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [vectorResults, setVectorResults] = useState<{ members: AggregatedResult[], photos: any[] }>({ members: [], photos: [] });
  const [isSearching, setIsSearching] = useState(false);
  const [isFinalSearching, setIsFinalSearching] = useState(false); // 🚀 確定検索中かどうかのフラグ
  const [activeTab, setActiveTab] = useState<'all' | 'member' | 'photo'>('all'); // 🎯 検索結果のタブ状態
  const [selectedPhoto, setSelectedPhoto] = useState<any>(null); // 🎯 拡大表示用の写真
  const [isPhotoModalOpen, setIsPhotoModalOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>(() => (searchParams.get('mode') as SearchMode) ?? 'smart'); // 🚀 検索モード
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const lastExecutedQueryRef = useRef<number>(0); // 🎯 二重実行防止用（時間ベース）

  // メンバー情報の初期取得とユーザーセッションの取得
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setCurrentUserId(session.user.id);
      }
    });

    apiClient.get('/api/basic_profile_info')
      .then(res => res.json())
      .then(data => setMembers(data))
      .catch(err => console.error('メンバー取得エラー:', err))
      .finally(() => setIsLoading(false));
  }, []);

  // URLのクエリパラメータが変わったら state に反映
  useEffect(() => {
    const q = searchParams.get('q') ?? '';
    const m = searchParams.get('mode') as SearchMode;
    setLastConfirmedQuery(q);
    if (m) setSearchMode(m);
    
    if (q) {
      handleConfirmSearch(q, false, m || searchMode);
    }
  }, [searchParams]);

  // 🚀 本検索 (確定処理)
  const handleConfirmSearch = async (targetQuery: string, updateUrl = true, overrideMode?: SearchMode) => {
    const trimmed = targetQuery.trim();
    if (!trimmed) {
      setLastConfirmedQuery('');
      setVectorResults({ members: [], photos: [] });
      setSearchParams({}, { replace: true });
      return;
    }

    const modeToUse = overrideMode || searchMode;

    // 🎯 500ms以内の連打は無視する（二重実行防止）
    const now = Date.now();
    if (now - lastExecutedQueryRef.current < 500) return;
    lastExecutedQueryRef.current = now;

    setLastConfirmedQuery(trimmed);
    if (updateUrl) {
      setSearchParams({ q: trimmed, mode: modeToUse }, { replace: true });
    }
    
    setVectorResults({ members: [], photos: [] });
    setIsFinalSearching(true); // 🚀 確定検索開始！
    setIsSearching(true);

    try {
      const res = await apiClient.post('/api/search/instant', { 
        query: trimmed, 
        limit: 15, 
        model: modeToUse === 'keyword' ? 'local' : 'groq', // 🚀 モードに応じてモデルを切り替え
        searchMode: modeToUse // 🚀 詳細なモードをバックエンドに伝える
      });
      const data = await res.json();
      setVectorResults(data.results || { members: [], photos: [] });

      // 🎯 AIの判定に合わせて初期タブを設定
      if (data.target === 'gallery_image') {
        setActiveTab('photo');
      } else if (data.target === 'person' || data.target === 'school') {
        setActiveTab('member');
      } else {
        setActiveTab('all');
      }
    } catch (err) {
      console.error('本検索エラー:', err);
    } finally {
      setIsFinalSearching(false); // 🚀 確定検索終了
      setIsSearching(false);
    }
  };

  const filteredMembers = useMemo(() => {
    if (!lastConfirmedQuery) return [];
    return members.filter(m => memberMatchesQuery(m, lastConfirmedQuery));
  }, [members, lastConfirmedQuery]);

  const mappedPhotos = useMemo(() => {
    return vectorResults.photos.map((r: any) => ({
      id: r.gallery_id,
      view_url: r.view_url,
      thumbnail_url: r.thumbnail_url || r.view_url,
      description: r.description,
      description_generated: r.description_generated,
      user_id: r.user_id,
      image_type: r.image_type,
      visibility: r.visibility,
      basic_profile_info: r.basic_profile_info,
      matches: r.matches
    }));
  }, [vectorResults.photos]);

  const hasNoResults = lastConfirmedQuery !== '' && 
    filteredMembers.length === 0 && 
    vectorResults.members.length === 0 && 
    vectorResults.photos.length === 0 && 
    !isSearching;

  return (
    <div className="h-full w-full overflow-y-auto bg-white text-gray-900">
      <div className="max-w-3xl mx-auto px-4 py-8">

        {/* ---- 検索バー & モードチップ ---- */}
        <h1 className="text-2xl font-bold mb-4 text-gray-900 font-outfit">Search</h1>
        <HomeSearchBar />

        {/* ---- 検索結果 ---- */}
        {isLoading || isFinalSearching || isSearching ? (
          <LoadingSkeleton />
        ) : lastConfirmedQuery === '' ? (
          <EmptyState />
        ) : hasNoResults ? (
          <NoResults query={lastConfirmedQuery} />
        ) : (
          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            
            {/* 🎯 検索結果のタブUI（今は見た目だけ） */}
            <div className="flex justify-center gap-3 mb-6 pt-2">
              <button
                onClick={() => setActiveTab('all')}
                className={`px-6 py-2 rounded-full text-sm font-bold transition-all duration-300 ${
                  activeTab === 'all'
                    ? 'bg-blue-400 text-white shadow-md scale-105'
                    : 'bg-white text-gray-500 hover:bg-gray-50 border border-gray-200'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setActiveTab('member')}
                className={`px-6 py-2 rounded-full text-sm font-bold transition-all duration-300 ${
                  activeTab === 'member'
                    ? 'bg-blue-400 text-white shadow-md scale-105'
                    : 'bg-white text-gray-500 hover:bg-gray-50 border border-gray-200'
                }`}
              >
                Member
              </button>
              <button
                onClick={() => setActiveTab('photo')}
                className={`px-6 py-2 rounded-full text-sm font-bold transition-all duration-300 ${
                  activeTab === 'photo'
                    ? 'bg-blue-400 text-white shadow-md scale-105'
                    : 'bg-white text-gray-500 hover:bg-gray-50 border border-gray-200'
                }`}
              >
                Photo
              </button>
            </div>

            <div className="flex items-center justify-between mb-3 border-b border-gray-100 pb-2">
              <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Results</h2>
            </div>
            
            <div className="space-y-6">
              {(() => {
                const { members: memberResults, photos: photoResults } = vectorResults;

                // 📸 写真グリッドの描画関数
                const renderPhotoGrid = (items: any[]) => (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {items.map((r: any) => (
                      <ImageResultCard 
                        key={r.gallery_id} 
                        result={r} 
                        onClick={() => {
                          const photoData = {
                            id: r.gallery_id,
                            view_url: r.view_url,
                            description: r.description,
                            description_generated: r.description_generated,
                            user_id: r.user_id,
                            image_type: r.image_type,
                            visibility: r.visibility,
                            basic_profile_info: r.basic_profile_info,
                            matches: r.matches // 🌟 マッチ詳細を渡す
                          };
                          setSelectedPhoto(photoData);
                          setIsPhotoModalOpen(true);
                        }}
                      />
                    ))}
                  </div>
                );

                // 👤 メンバーリストの描画関数
                const renderMemberList = (items: any[]) => {
                  const resultItems: { member: Member; keywords: string[]; matches: any[] }[] = [];
                  items.forEach((r: any) => {
                    const m = members.find(m => m.id === r.user_id);
                    if (m) {
                      resultItems.push({ 
                        member: m, 
                        keywords: r.matched_keywords || [], 
                        matches: r.matches || [] 
                      });
                    }
                  });
                  return (
                    <div className="space-y-2">
                      {resultItems.map(({ member, keywords, matches }) => (
                        <MemberCard 
                          key={member.id} 
                          member={member} 
                          query={lastConfirmedQuery} 
                          matchedKeywords={keywords}
                          matches={matches}
                        />
                      ))}
                    </div>
                  );
                };

                // --- タブごとの出し分け ---
                if (activeTab === 'photo') {
                  return photoResults.length > 0 ? renderPhotoGrid(photoResults) : !isSearching && <p className="text-center text-gray-400 py-10">No photos found</p>;
                }

                if (activeTab === 'member') {
                  return memberResults.length > 0 ? renderMemberList(memberResults) : !isSearching && <p className="text-center text-gray-400 py-10">No members found</p>;
                }

                // 「All」タブの場合
                return (
                  <div className="space-y-8">
                    {photoResults.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-sm font-bold text-gray-900">Photos</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{photoResults.length}</span>
                        </div>
                        {renderPhotoGrid(photoResults.slice(0, 6))}
                        {photoResults.length > 6 && (
                          <button onClick={() => setActiveTab('photo')} className="w-full mt-4 py-2 text-xs font-bold text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
                            Show all photos
                          </button>
                        )}
                      </div>
                    )}

                    {memberResults.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-sm font-bold text-gray-900">Members</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{memberResults.length}</span>
                        </div>
                        {renderMemberList(memberResults)}
                      </div>
                    )}

                    {photoResults.length === 0 && memberResults.length === 0 && !isSearching && (
                      <p className="text-center text-gray-400 py-10">No results found</p>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      {/* 🖼️ 写真拡大表示用モーダル */}
      <PhotoViewModal
        isOpen={isPhotoModalOpen}
        imageUrl={selectedPhoto?.view_url}
        onClose={() => {
          setIsPhotoModalOpen(false);
        }}
        description={selectedPhoto?.description}
        isOwner={false}
        photo={selectedPhoto}
        photos={mappedPhotos}
        initialPhotoId={selectedPhoto?.id}
        currentUserId={currentUserId}
      />
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

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;

function MemberCard({ member, query, matchedKeywords = [], matches = [] }: { member: Member; query: string; matchedKeywords?: string[]; matches?: any[] }) {
  const navigate = useNavigate();
  const [isExpanded, setIsExpanded] = useState(false);
  const avatarUrl = member.avatar_link || '/assets/images/profile_photo_empty.png';
  const majorsText = Array.isArray(member.majors) ? member.majors.join(', ') : member.majors;
  const subText = [member.current_school, member.study_abroad_country, majorsText].filter(Boolean).join(' · ');
  const active = member.last_sign_in_at
    ? Date.now() - new Date(member.last_sign_in_at).getTime() < SIX_MONTHS_MS
    : false;

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
          <div
            className="flex items-center gap-2 flex-wrap"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/members/${member.id}`);
            }}
          >
            <p className="font-bold text-gray-900 group-hover:text-blue-700 transition-colors truncate">
              <HighlightedText text={member.name_english || '(No Name)'} query={query} />
              {member.name_kanji && (
                <span className="ml-2 text-sm font-normal text-gray-500">
                  <HighlightedText text={member.name_kanji} query={query} />
                </span>
              )}
            </p>
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold flex-shrink-0 ${active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-500' : 'bg-gray-400'}`} />
              {active ? 'Active' : 'Non-active'}
            </span>
          </div>
          <p className="text-xs text-gray-500 truncate mb-1">
            <HighlightedText text={subText} query={query} />
          </p>
          
          {/* 🎯 AIがマッチしたと判断したキーワードのバッジ */}
          {matchedKeywords && matchedKeywords.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {(matchedKeywords || []).map((kw, i) => (
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

function ImageResultCard({ result, onClick }: { result: AggregatedResult; onClick: () => void }) {
  return (
    <div 
      onClick={onClick}
      className="relative aspect-square rounded-xl overflow-hidden cursor-pointer group hover:ring-2 hover:ring-blue-500 transition-all shadow-sm bg-gray-100"
    >
      <img 
        src={result.thumbnail_url || result.view_url} 
        alt={result.description || ''} 
        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-3">
        <p className="text-white text-[10px] font-bold truncate">
          {result.basic_profile_info?.name_english || 'Unknown'}
        </p>
        {result.description && (
          <p className="text-white/80 text-[8px] line-clamp-1 mt-0.5">
            {result.description}
          </p>
        )}
        <div className="flex flex-wrap gap-1 mt-1.5">
          {(result.matched_keywords || []).slice(0, 2).map((kw, i) => (
            <span key={i} className="px-1 py-0.5 rounded bg-blue-500/80 text-white text-[7px] font-bold">
              {kw}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
