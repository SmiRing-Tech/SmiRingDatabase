import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Sparkles, Search, Zap } from 'lucide-react';
import { CustomDropdown } from '../../components/ui/CustomDropdown';
import { API_BASE_URL } from '../../config';
import PhotoViewModal from '../../components/ui/PhotoViewModal';

export type Member = {
  id: string;
  name_english: string;
  name_kanji: string;
  birthday: string;
  hometown: string;
  study_abroad_country: string;
  study_aborad_city: string;
  study_abroad_type: string;
  study_abroad_history: string;
  english_school: string;
  current_school: string;
  school_history: string;
  grade_level: string;
  majors: string | string[];
  minors: string | string[];
  major_history: string;
  personality: string;
  important_values: string;
  future_image: string;
  smiring_department: string;
  smiring_join_date: string;
  avatar_link: string;
  last_sign_in_at: string | null;
};

export function memberMatchesQuery(m: Member, q: string): boolean {
  if (!q) return false;
  const toStr = (v: string | string[] | undefined | null) =>
    Array.isArray(v) ? v.join(' ') : (v || '');
  const haystack = [
    m.name_english, m.name_kanji, m.birthday, m.hometown,
    m.study_abroad_country, m.study_aborad_city, m.study_abroad_type,
    m.study_abroad_history, m.english_school, m.current_school,
    m.school_history, m.grade_level,
    toStr(m.majors), toStr(m.minors), m.major_history,
    m.personality, m.important_values, m.future_image,
    m.smiring_department, m.smiring_join_date,
  ].join(' ').toLowerCase();
  return haystack.includes(q.toLowerCase());
}

export function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;
  
  const keywords = query.trim().split(/[\s　]+/).filter(k => k.length > 0);
  if (keywords.length === 0) return <>{text}</>;

  const escapedKeywords = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedKeywords.join('|')})`, 'gi');
  const parts = text.split(regex);
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  return (
    <>
      {parts.map((part, i) => 
        lowerKeywords.includes(part.toLowerCase()) ? (
          <mark key={i} className="bg-blue-100 text-blue-900 rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

export function SnippetText({ text, query, maxLength = 60 }: { text: string; query: string, maxLength?: number }) {
  if (!text) return null;
  const cleanText = text.replace(/\n/g, ' '); // 改行を取り除いて1行にする
  if (!query) return <>{cleanText.slice(0, maxLength)}{cleanText.length > maxLength ? '...' : ''}</>;
  
  const keywords = query.trim().split(/[\s　]+/).filter(k => k.length > 0);
  if (keywords.length === 0) return <>{cleanText.slice(0, maxLength)}{cleanText.length > maxLength ? '...' : ''}</>;

  const lowerText = cleanText.toLowerCase();
  
  // 一番最初に登場するキーワードを見つける
  let firstIdx = -1;
  let matchedKeyword = '';
  for (const k of keywords) {
    const idx = lowerText.indexOf(k.toLowerCase());
    if (idx !== -1) {
      if (firstIdx === -1 || idx < firstIdx) {
        firstIdx = idx;
        matchedKeyword = k;
      }
    }
  }
  
  // キーワードが見つからない場合は、ただ先頭を切り出す（ベクトル検索など）
  if (firstIdx === -1) return <>{cleanText.slice(0, maxLength)}{cleanText.length > maxLength ? '...' : ''}</>;
  
  // 最初にヒットしたキーワードを中心に前後を切り出す
  const contextLength = Math.floor((maxLength - matchedKeyword.length) / 2);
  const start = Math.max(0, firstIdx - contextLength);
  const end = Math.min(cleanText.length, firstIdx + matchedKeyword.length + contextLength);
  const prefix = start > 0 ? '... ' : '';
  const suffix = end < cleanText.length ? ' ...' : '';
  
  const snippet = cleanText.slice(start, end);
  
  return (
    <>
      {prefix}
      <HighlightedText text={snippet} query={query} />
      {suffix}
    </>
  );
}

type SearchMode = 'smart' | 'keyword' | 'deep';

export default function HomeSearchBar() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [suggestions, setSuggestions] = useState<any[]>([]); // 🎯 型エラー回避のため any[] に変更
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<SearchMode>((searchParams.get('mode') as SearchMode) || 'smart');

  // 🌟 URLのパラメータが変わったら入力欄とモードに反映
  useEffect(() => {
    const q = searchParams.get('q') || '';
    const m = searchParams.get('mode') as SearchMode;
    setQuery(q);
    if (m) setSearchMode(m);
  }, [searchParams]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isPhotoModalOpen, setIsPhotoModalOpen] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<any>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const ignoreSuggestionsRef = React.useRef(false); // 🌟 エンター押下後にサジェストが届いても無視するためのフラグ
  const inputRef = React.useRef<HTMLInputElement>(null); // 🌟 入力欄のフォーカス制御用

  const handleSuggestionSelect = (s: any) => {
    setIsOpen(false);
    const profileInfo = s.basic_profile_info || s;
    const isImage = s.type === 'gallery_image' || s.source_type === 'gallery_image';
    
    // 一番スコアの高いマッチを確認
    let bestMatch = null;
    if (s.matches && s.matches.length > 0) {
      bestMatch = [...s.matches].sort((a: any, b: any) => b.score - a.score)[0];
    }
    
    // もしフォームの回答にマッチしていた場合は、そのフォームへ飛ぶ
    if (bestMatch && bestMatch.source_type === 'form_answer' && bestMatch.metadata?.response_id) {
      const qId = bestMatch.metadata.question_id;
      navigate(`/form-responses/${bestMatch.metadata.response_id}${qId ? `?questionId=${qId}` : ''}`);
    } else if (isImage) {
      setSelectedPhoto({
        id: s.gallery_id || s.id,
        view_url: s.view_url,
        description: s.description,
        description_generated: s.description_generated,
        user_id: s.user_id,
        image_type: s.image_type,
        visibility: s.visibility,
        basic_profile_info: profileInfo,
        matches: s.matches
      });
      setIsPhotoModalOpen(true);
    } else {
      navigate(`/members/${profileInfo.id || s.user_id || s.id}`);
    }
  };

  // 🔍 ハイブリッド検索ロジック (300ms デバウンス)
  useEffect(() => {
    const trimmed = query.trim();
    // 文字が空、またはドロップダウンが閉じている時は検索しない
    if (trimmed.length === 0 || !isOpen) {
      if (trimmed.length === 0) {
        setSuggestions([]);
        setIsLoading(false);
      }
      return;
    }

    const timer = setTimeout(async () => {
      setIsLoading(true);

      try {
        const response = await fetch(`${API_BASE_URL}/api/search/instant`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            query: trimmed,
            model: 'local',
            searchMode: searchMode
          })
        });

        if (response.ok) {
          const data = await response.json();
          
          // 🎯 統合された結果（photos + members）をフラットにして処理
          const allResults = [
            ...(data.results?.photos || []),
            ...(data.results?.members || [])
          ];

          // 🎯 スコア0.75以上のものを候補として採用
          const highScores = allResults.filter((r: any) => (r.similarity || r.total_score || 0) >= 0.75);

          // 🌟 エンターがすでに押されている場合は、結果を反映しない
          if (!ignoreSuggestionsRef.current) {
            setSuggestions(highScores.slice(0, 8));
          }
        } else {
          setSuggestions([]);
        }
      } catch (err) {
        console.error('Search error:', err);
        setSuggestions([]);
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, searchMode, isOpen]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const totalItems = suggestions.length + 1;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;

    if (!isOpen || suggestions.length === 0) {
      if (e.key === 'Enter') { 
        e.preventDefault(); // 🌟 デフォルトの挙動（フォーム送信等）を止める
        setIsOpen(false); 
        inputRef.current?.blur(); // 🌟 フォーカスを外す
        ignoreSuggestionsRef.current = true; // 🌟 エンターを押したので以後のサジェストを無視
        setSuggestions([]); // 🌟 画面に残らないようクリア
        navigate(`/search?q=${encodeURIComponent(query.trim())}&mode=${searchMode}`); 
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(prev => (prev + 1) % totalItems);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => (prev - 1 + totalItems) % totalItems);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      setIsOpen(false);
      inputRef.current?.blur(); // 🌟 フォーカスを外す
      ignoreSuggestionsRef.current = true; // 🌟 エンターを押したので以後のサジェストを無視
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        handleSuggestionSelect(suggestions[activeIndex]);
      } else {
        setSuggestions([]); // 🌟 画面に残らないようクリア
        navigate(`/search?q=${encodeURIComponent(query.trim())}&mode=${searchMode}`);
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setActiveIndex(-1);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setIsOpen(true);
    setActiveIndex(-1);
    ignoreSuggestionsRef.current = false; // 🌟 ユーザーが新しく文字を入力したらリセット
  };

  return (
    <div ref={wrapperRef} className="w-full max-w-2xl mx-auto mb-6 relative">
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
          <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => {
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="w-full pl-11 pr-44 py-3.5 rounded-full border border-gray-200 bg-gray-50 focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-400 outline-none shadow-sm transition-all text-sm"
          placeholder="名前、大学、専攻、国などで検索..."
        />

        <div className="absolute inset-y-0 right-0 flex items-center pr-3 gap-1.5">
          {/* 🚀 検索モードチップ */}
          <div className="w-[110px]">
            <CustomDropdown
              value={searchMode}
              onChange={(val) => setSearchMode(val as SearchMode)}
              fontSize="text-[10px]"
              options={[
                { label: 'スマート', value: 'smart', icon: <Sparkles className="w-3 h-3" />, description: 'AIが意味を解釈' },
                { label: 'キーワード', value: 'keyword', icon: <Search className="h-3 w-3" />, description: '文字一致を優先' },
                { label: 'ディープ', value: 'deep', icon: <Zap className="w-3 h-3" />, description: '深層・言い換え検索' }
              ]}
              className="!py-1.5 !px-2 !bg-white/60 hover:!bg-white !border-gray-200/50 hover:!border-blue-300 !rounded-xl shadow-sm font-bold"
            />
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate('/search/chat', { state: { q: query.trim() } });
            }}
            className="p-2 text-blue-500 hover:text-blue-700 transition-all hover:scale-110 relative"
            title="AIに相談する"
          >
            {isLoading ? (
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <div className="relative">
                <Sparkles className="w-5 h-5 fill-current opacity-20 group-hover:opacity-100 transition-opacity" />
                <Sparkles className="w-5 h-5 absolute inset-0 animate-pulse" />
              </div>
            )}
          </button>
        </div>
      </div>

      {/* 🎯 サジェストドロップダウン: オープン状態 ＋ 文字あり なら出す */}
      {isOpen && query.trim().length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl border border-gray-200 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 z-[100]">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-gray-400 font-bold flex items-center justify-center gap-2">
              <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              検索中...
            </div>
          ) : (
            <>
              {suggestions.length > 0 ? (
                suggestions.map((s, index) => {
                  const isImage = s.type === 'gallery_image' || s.source_type === 'gallery_image';
                  const isMember = !isImage && (s.type === 'member' || (!s.type && s.name_english));
                  
                  // バックエンドから返される basic_profile_info などを活用
                  const profileInfo = s.basic_profile_info || s; 
                  
                  const avatarUrl = isImage 
                    ? (s.thumbnail_url || s.view_url || '/assets/images/profile_photo_empty.png')
                    : (profileInfo.avatar_link || profileInfo.avatar_url || '/assets/images/profile_photo_empty.png');
                  
                  const title = isImage
                    ? (s.description || '画像の結果')
                    : (isMember ? s.name_english : (s.content || "").split('\n')[0]);
                  
                  const majorsText = Array.isArray(profileInfo.majors) ? profileInfo.majors.join(', ') : (profileInfo.majors || '');
                  
                  const defaultSubText = isImage
                    ? `画像 · ${profileInfo.name_english || '不明'}`
                    : (isMember 
                        ? [profileInfo.current_school, profileInfo.study_abroad_country, majorsText].filter(Boolean).join(' · ')
                        : `回答 by ${profileInfo.name_english || '不明'}`);

                  // 🌟 マッチしたテキストを抽出する
                  let matchedContent = '';
                  if (s.matches && s.matches.length > 0) {
                    // スコアが高い順にソートして一番良いマッチを取得
                    const bestMatch = [...s.matches].sort((a: any, b: any) => b.score - a.score)[0];
                    if (bestMatch && bestMatch.content) {
                      matchedContent = bestMatch.content;
                    }
                  }

                  const isActive = activeIndex === index;
                  return (
                    <div
                      key={s.id || index}
                      onMouseDown={() => handleSuggestionSelect(s)}
                      className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors ${isActive ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      <img src={avatarUrl} alt="" className="w-9 h-9 rounded-lg object-cover bg-gray-100 flex-shrink-0 border border-gray-200" />
                      <div className="flex-1 overflow-hidden">
                        <p className={`text-sm font-bold truncate transition-colors ${isActive ? 'text-blue-700' : 'text-gray-900'}`}>
                          <HighlightedText text={title} query={query.trim()} />
                          {isMember && s.name_kanji && (
                            <span className="ml-2 font-normal text-gray-500 text-xs">
                              <HighlightedText text={s.name_kanji} query={query.trim()} />
                            </span>
                          )}
                        </p>
                        <p className="text-[10px] text-gray-500 truncate">
                          {matchedContent ? (
                            <SnippetText text={matchedContent} query={query.trim()} />
                          ) : (
                            <HighlightedText text={defaultSubText} query={query.trim()} />
                          )}
                        </p>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="p-4 text-center text-sm text-gray-500">
                  候補が見つかりませんでした
                </div>
              )}

              {/* 全件検索へのリンク */}
              <div
                onMouseDown={() => { 
                  setIsOpen(false); 
                  navigate(`/search?q=${encodeURIComponent(query.trim())}&mode=${searchMode}`); 
                }}
                className={`flex items-center gap-2 px-4 py-3 border-t border-gray-100 cursor-pointer text-sm font-bold transition-colors ${
                  activeIndex === suggestions.length ? 'bg-gray-50 text-blue-700' : 'hover:bg-gray-50 text-blue-600'
                }`}
              >
                <Search className="w-4 h-4" />
                「{query}」ですべて検索
              </div>
            </>
          )}
        </div>
      )}

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
      />
    </div>
  );
}
