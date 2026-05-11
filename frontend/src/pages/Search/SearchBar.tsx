import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { API_BASE_URL } from '../../config';

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
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 text-gray-900 rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function HomeSearchBar() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]); // 🎯 型エラー回避のため any[] に変更
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false); // 🎯 フォーカス状態を管理
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/basic_profile_info`)
      .then(res => res.json())
      .then(data => setMembers(data))
      .catch(() => {});
  }, []);

  // 🔍 ハイブリッド検索ロジック (300ms デバウンス)
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setSuggestions([]);
      setIsLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsLoading(true);

      // 1. まずは部分一致 (Keyword Search)
      const localMatches = members.filter(m => memberMatchesQuery(m, trimmed));
      
      if (localMatches.length >= 6) {
        setSuggestions(localMatches.slice(0, 6));
        setIsLoading(false);
        return;
      }

      // 2. 6件に満たない場合、ベクトル検索 (ME5) で補填
      try {
        const response = await fetch(`${API_BASE_URL}/api/search/instant`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: trimmed })
        });

        if (response.ok) {
          const data = await response.json();
          // 🎯 0.75以上のものを候補として採用
          const highScores = data.results.filter((r: any) => (r.similarity || 0) >= 0.75);
          
          const localIds = new Set(localMatches.map(m => m.id));
          const combinedSuggestions: any[] = localMatches.map(m => ({ ...m, type: 'member' }));
          
          for (const r of highScores) {
            const uId = r.metadata?.user_id || r.source_id;
            
            if (r.source_type === 'form_answer') {
              combinedSuggestions.push({ ...r, type: 'form_answer' });
            } else {
              if (!localIds.has(uId) && !combinedSuggestions.some(s => s.id === uId)) {
                const m = members.find(m => m.id === uId);
                if (m) combinedSuggestions.push({ ...m, type: 'member' });
              }
            }
          }

          setSuggestions(combinedSuggestions.slice(0, 8));
        } else {
          setSuggestions(localMatches.slice(0, 8));
        }
      } catch (err) {
        console.error('Vector search error:', err);
        setSuggestions(localMatches.slice(0, 6));
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [query, members]);

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
      if (e.key === 'Enter') { setIsOpen(false); navigate(`/search?q=${encodeURIComponent(query.trim())}`); }
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
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        navigate(`/members/${suggestions[activeIndex].id}`);
      } else {
        navigate(`/search?q=${encodeURIComponent(query.trim())}`);
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
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => {
            setIsFocused(true);
            setIsOpen(true);
          }}
          onBlur={() => {
            // サジェストクリックを優先するため少し遅らせる
            setTimeout(() => setIsFocused(false), 200);
          }}
          onKeyDown={handleKeyDown}
          className="w-full pl-11 pr-12 py-3 rounded-full border border-gray-200 bg-gray-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none shadow-sm transition-all text-sm"
          placeholder="Search members, photos, forms..."
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigate('/search/chat', { state: { q: query.trim() } });
          }}
          className="absolute inset-y-0 right-0 pr-4 flex items-center text-blue-500 hover:text-blue-700 transition-all hover:scale-110"
          title="AIに相談する"
        >
          {isLoading ? (
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Sparkles className="w-5 h-5 fill-current opacity-20 group-hover:opacity-100 transition-opacity" />
              <Sparkles className="w-5 h-5 absolute animate-pulse" />
            </>
          )}
        </button>
      </div>

      {/* 🎯 サジェストドロップダウン: フォーカスあり ＋ 文字あり なら絶対出す */}
      {isFocused && query.trim().length > 0 && (
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
                  const isMember = s.type === 'member' || (!s.type && s.name_english);
                  const member = isMember ? s : members.find(m => m.id === (s.metadata?.user_id || s.source_id));
                  const avatarUrl = member?.avatar_link || '/assets/images/profile_photo_empty.png';
                  const title = isMember ? s.name_english : (s.content || "").split('\n')[0];
                  const majorsText = isMember ? (Array.isArray(s.majors) ? s.majors.join(', ') : s.majors) : '';
                  const subText = isMember 
                    ? [s.current_school, s.study_abroad_country, majorsText].filter(Boolean).join(' · ')
                    : `回答 by ${member?.name_english || '不明'}`;

                  const isActive = activeIndex === index;
                  return (
                    <div
                      key={s.id || index}
                      onMouseDown={() => { 
                        setIsOpen(false); 
                        if (s.type === 'form_answer' && s.metadata?.response_id) {
                          const qId = s.metadata.question_id;
                          navigate(`/form-responses/${s.metadata.response_id}${qId ? `?questionId=${qId}` : ''}`);
                        } else {
                          navigate(`/members/${member?.id || s.id}`);
                        }
                      }}
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
                        <p className="text-[10px] text-gray-400 truncate">
                          <HighlightedText text={subText} query={query.trim()} />
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
                  navigate(`/search?q=${encodeURIComponent(query.trim())}`); 
                }}
                className={`flex items-center gap-2 px-4 py-3 border-t border-gray-100 cursor-pointer text-sm font-bold transition-colors ${
                  activeIndex === suggestions.length ? 'bg-gray-50 text-blue-700' : 'hover:bg-gray-50 text-blue-600'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                「{query}」ですべて検索
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
