import { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, Search, X } from 'lucide-react';

export const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '🙏', '👏', '💯'];

interface EmojiCategory {
  id: string;
  name: string;
  icon: string;
  emojis: string[];
}

const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: 'smileys',
    name: '表情・感情',
    icon: '😊',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉',
      '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😋', '😛',
      '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨',
      '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔',
      '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵',
      '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐', '😕',
      '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨',
      '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩',
      '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '💩',
    ],
  },
  {
    id: 'gestures',
    name: 'ジェスチャー・人',
    icon: '👍',
    emojis: [
      '👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲',
      '🤝', '🙏', '✍️', '💅', '🤳', '💪', '👈', '👉', '👆', '👇',
      '☝️', '✋', '🤚', '🖐️', '🖖', '👋', '🤙', '🤞', '🤟', '🤘',
      '👌', '🤏', '✌️', '🫰', '🙋', '🙆', '🙅', '🤷', '🤦', '🙇',
    ],
  },
  {
    id: 'hearts',
    name: 'ハート・気持ち',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝',
      '💟', '💌', '💐', '🌸', '💮', '✨', '⭐', '🌟', '💫', '💥',
    ],
  },
  {
    id: 'celebration',
    name: '祝・記号',
    icon: '🎉',
    emojis: [
      '🎉', '🎊', '🎈', '🎁', '🎂', '🏆', '🥇', '🥈', '🥉', '🎖️',
      '🔥', '💯', '✨', '⚡', '💡', '🔔', '📣', '📢', '🎯', '🚀',
      '☀️', '🌙', '🌈', '🍀', '🍕', '🍻', '☕', '👀', '💬', '✅',
    ],
  },
];

interface EmojiPickerPopoverProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  placement?: 'top' | 'bottom';
  align?: 'left' | 'right';
}

export default function EmojiPickerPopover({
  onSelect,
  onClose,
  placement = 'top',
  align = 'left',
}: EmojiPickerPopoverProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>(EMOJI_CATEGORIES[0].id);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Focus search input on expand
  useEffect(() => {
    if (isExpanded) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [isExpanded]);

  // Filter emojis if searching
  const filteredEmojis = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const all = EMOJI_CATEGORIES.flatMap((c) => c.emojis);
    // Simple filter or exact match
    return all.filter((emoji) => emoji.includes(q));
  }, [searchQuery]);

  const currentCategoryEmojis = useMemo(() => {
    const cat = EMOJI_CATEGORIES.find((c) => c.id === activeCategory);
    return cat ? cat.emojis : EMOJI_CATEGORIES[0].emojis;
  }, [activeCategory]);

  return (
    <div
      ref={popoverRef}
      className={`absolute z-40 ${
        placement === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
      } ${align === 'right' ? 'right-0' : 'left-0'} animate-in fade-in zoom-in-95 duration-150 select-none`}
    >
      {!isExpanded ? (
        /* Quick Emoji Bar */
        <div className="flex items-center gap-1 bg-gray-900/95 backdrop-blur-md border border-gray-700/90 rounded-full px-2 py-1 shadow-2xl">
          {QUICK_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onSelect(emoji)}
              className="p-1 text-base hover:scale-125 active:scale-95 transition-transform rounded-full hover:bg-gray-800"
              title={emoji}
            >
              {emoji}
            </button>
          ))}
          <div className="h-4 w-px bg-gray-700 mx-0.5" />
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="p-1.5 rounded-full hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
            title="すべての絵文字を見る"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      ) : (
        /* Full Emoji Palette */
        <div className="w-72 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-100">
          {/* Header & Search */}
          <div className="p-2 border-b border-gray-800 flex items-center gap-1.5 bg-gray-950/60">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="絵文字を検索..."
                className="w-full bg-gray-800 text-xs text-white pl-8 pr-2 py-1.5 rounded-xl outline-none focus:ring-1 focus:ring-sky-500 border border-gray-700/60 placeholder:text-gray-500"
              />
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Category Tabs (if not searching) */}
          {!searchQuery && (
            <div className="flex items-center justify-around border-b border-gray-800/80 bg-gray-950/40 px-1 py-1">
              {EMOJI_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  className={`px-2 py-1 rounded-lg text-xs transition-colors ${
                    activeCategory === cat.id
                      ? 'bg-gray-800 text-white shadow-xs font-bold'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
                  }`}
                  title={cat.name}
                >
                  <span className="text-sm">{cat.icon}</span>
                </button>
              ))}
            </div>
          )}

          {/* Emoji Grid Area */}
          <div className="p-2 max-h-56 overflow-y-auto grid grid-cols-7 gap-1">
            {filteredEmojis ? (
              filteredEmojis.length > 0 ? (
                filteredEmojis.map((emoji, i) => (
                  <button
                    key={`${emoji}-${i}`}
                    type="button"
                    onClick={() => onSelect(emoji)}
                    className="w-8 h-8 flex items-center justify-center text-lg rounded-lg hover:bg-gray-800 hover:scale-120 active:scale-95 transition-all"
                  >
                    {emoji}
                  </button>
                ))
              ) : (
                <div className="col-span-7 py-6 text-center text-xs text-gray-500">
                  絵文字が見つかりませんでした
                </div>
              )
            ) : (
              currentCategoryEmojis.map((emoji, i) => (
                <button
                  key={`${emoji}-${i}`}
                  type="button"
                  onClick={() => onSelect(emoji)}
                  className="w-8 h-8 flex items-center justify-center text-lg rounded-lg hover:bg-gray-800 hover:scale-120 active:scale-95 transition-all"
                >
                  {emoji}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
