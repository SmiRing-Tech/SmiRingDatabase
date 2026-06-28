import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronDown, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// --- 型定義 ---
export type DropdownOption = {
  label: string;
  isLabel?: boolean;
  value?: string;
  icon?: React.ReactNode;
  description?: string; // 🌟 説明文を追加
};

// Genericsを使って、multipleの値によってvalueとonChangeの型を動的に変える
interface CustomDropdownProps<T extends boolean> {
  options?: DropdownOption[];
  multiple?: T;
  value: T extends true ? string[] : string;
  onChange: (value: T extends true ? string[] : string) => void;
  searchable?: boolean;
  placeholder?: string;
  className?: string;
  fontSize?: string; // 🌟 文字サイズを指定できるように
}
// -------------

export const CustomDropdown = <T extends boolean = false>({
  options = [],
  multiple,
  value,
  onChange,
  searchable = false,
  placeholder = "選択してください",
  className = "",
  fontSize = "text-sm" // デフォルトは従来通りのサイズ
}: CustomDropdownProps<T>) => {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [coords, setCoords] = useState({ top: 0, bottom: 0, left: 0, width: 0, isBottomHalf: false });
  const [tempValues, setTempValues] = useState<string[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // clickOutsideで最新のtempValuesを取得するためのRef
  const tempValuesRef = useRef<string[]>([]);
  useEffect(() => {
    tempValuesRef.current = tempValues;
  }, [tempValues]);

  // メニューの位置を計算
  const updateCoords = () => {
    if (dropdownRef.current) {
      const rect = dropdownRef.current.getBoundingClientRect();
      setCoords({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        isBottomHalf: rect.top > window.innerHeight / 2
      });
    }
  };

  useEffect(() => {
    if (isOpen) {
      updateCoords();
      // スクロール時（モーダル内含む）やリサイズ時に位置を再計算
      window.addEventListener('scroll', updateCoords, true);
      window.addEventListener('resize', updateCoords);

      // オープン時に現在の選択値で初期化
      if (multiple) {
        setTempValues((value as string[]) || []);
      }
    }
    return () => {
      window.removeEventListener('scroll', updateCoords, true);
      window.removeEventListener('resize', updateCoords);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const isDropdownClick = dropdownRef.current && dropdownRef.current.contains(event.target as Node);
      const isMenuClick = menuRef.current && menuRef.current.contains(event.target as Node);

      if (!isDropdownClick && !isMenuClick) {
        if (multiple) {
          // クリック枠外で閉じる時も選択内容を保存して閉じる
          onChange(tempValuesRef.current as any);
        }
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, multiple, onChange]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen]);

  const filteredOptions = useMemo(() => {
    if (!searchQuery) return options;

    const query = searchQuery.toLowerCase();
    const result: DropdownOption[] = [];

    let isCurrentGroupMatching = false;
    let pendingLabel: DropdownOption | null = null;

    options.forEach(opt => {
      if (opt.isLabel) {
        pendingLabel = opt;
        // ラベル（グループ名）自体が検索クエリにヒットするかチェック
        isCurrentGroupMatching = opt.label.toLowerCase().includes(query);

        if (isCurrentGroupMatching) {
          result.push(opt);
          pendingLabel = null; // 既に追加したので保留解除
        }
      } else {
        const itemMatches = opt.label.toLowerCase().includes(query);

        // グループ名がヒットしている、またはアイテム自体がヒットしている場合に表示
        if (isCurrentGroupMatching || itemMatches) {
          if (pendingLabel) {
            // グループ名はヒットしていないがアイテムがヒットした際、親ラベルを1度だけ表示
            result.push(pendingLabel);
            pendingLabel = null;
          }
          result.push(opt);
        }
      }
    });
    return result;
  }, [options, searchQuery]);

  const handleSelect = (opt: DropdownOption) => {
    if (opt.isLabel || !opt.value) return;

    if (multiple) {
      // 複数選択時はローカルステートのみを更新
      const isSelected = tempValues.includes(opt.value);
      const newTemp = isSelected
        ? tempValues.filter(v => v !== opt.value)
        : [...tempValues, opt.value];
      setTempValues(newTemp);
    } else {
      // 単一選択時は即時決定
      onChange(opt.value as any);
      setIsOpen(false);
    }
  };

  const getDisplayText = () => {
    if (multiple) {
      const currentValues = (value as string[]) || [];
      if (currentValues.length === 0) return placeholder;
      const selectedLabels = currentValues
        .map(val => options.find(o => o.value === val)?.label)
        .filter(Boolean);
      return `[${currentValues.length}件] ${selectedLabels.join('、')}`;
    } else {
      if (!value) return placeholder;
      return options.find(o => o.value === value)?.label || placeholder;
    }
  };

  return (
    <div className={`relative w-full ${fontSize}`} ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full bg-white border border-gray-300 rounded-xl text-left px-4 py-2.5 flex justify-between items-center shadow-sm hover:border-gray-400 hover:shadow transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${className}`}
      >
        <span className="truncate pr-4 select-none text-gray-700">
          {getDisplayText()}
        </span>
        <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* ポータルを使用してメニューを body 直下にレンダリング */}
      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              key="dropdown-menu"
              ref={menuRef}
              initial={{ opacity: 0, y: coords.isBottomHalf ? 10 : -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: coords.isBottomHalf ? 10 : -10 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              style={{
                position: 'fixed',
                ...(coords.isBottomHalf
                  ? { bottom: window.innerHeight - coords.top + 8 }
                  : { top: coords.bottom + 8 }),
                left: coords.left,
                width: coords.width,
                zIndex: 9999,
              }}
              className={`bg-white/95 backdrop-blur-md border border-gray-200 rounded-xl shadow-lg overflow-hidden flex flex-col ${fontSize}`}
            >

              {searchable && (
                <div className="p-2 border-b border-gray-100 bg-white/50 sticky top-0">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="text"
                      // デザイン改善: 検索バーの角丸とフォーカスリング
                      className="w-full pl-9 pr-3 py-1.5 bg-gray-50/50 border border-transparent rounded-lg focus:outline-none focus:bg-white focus:border-blue-300 focus:ring-2 focus:ring-blue-500/10 transition-all"
                      placeholder="検索..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {/* スクロールバーのカスタマイズ: 細く、角を丸く、背景を透明に */}
              <div className="max-h-[280px] overflow-y-auto py-1 
              [&::-webkit-scrollbar]:w-1.5
              [&::-webkit-scrollbar-track]:bg-transparent
              [&::-webkit-scrollbar-thumb]:bg-gray-200
              [&::-webkit-scrollbar-thumb]:rounded-full
              hover:[&::-webkit-scrollbar-thumb]:bg-gray-300
              transition-colors"
              >
                {filteredOptions.length === 0 ? (
                  <div className={`px-4 py-3 text-gray-500 text-center ${fontSize}`}>見つかりませんでした</div>
                ) : (
                  filteredOptions.map((opt, index) => {
                    const itemKey = opt.isLabel ? `label-${index}` : opt.value;
                    const isSelected = multiple
                      ? tempValues.includes(opt.value!)
                      : value === opt.value;

                    if (opt.isLabel) {
                      return (
                        <div key={itemKey} className="px-4 py-1.5 mt-1 text-xs font-bold text-blue-400 uppercase tracking-wider select-none">
                          {opt.label}
                        </div>
                      );
                    }

                    return (
                      <div
                        key={itemKey}
                        onClick={() => handleSelect(opt)}
                        // デザイン改善: プレミアムなホバーエフェクト (bg-blue-500/10)
                        className="flex items-center px-4 py-2.5 cursor-pointer hover:bg-blue-500/10 hover:text-blue-700 transition-colors group"
                      >
                        {multiple && (
                          <div className={`w-4 h-4 mr-3 border rounded flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-300 group-hover:border-blue-400'}`}>
                            {isSelected && <Check className="w-3 h-3 text-white" />}
                          </div>
                        )}

                        {opt.icon && (
                          <div className={`mr-2 flex-shrink-0 transition-colors ${isSelected ? 'text-blue-500' : 'text-gray-400 group-hover:text-blue-500'}`}>
                            {opt.icon}
                          </div>
                        )}

                        <div className="flex flex-col truncate">
                          <span className={`truncate select-none ${isSelected && !multiple ? 'font-bold text-blue-600' : 'text-gray-700 font-medium'}`}>
                            {opt.label}
                          </span>
                          {opt.description && (
                            <span className="opacity-60 line-clamp-1 text-[0.9em] leading-tight mt-0.5">
                              {opt.description}
                            </span>
                          )}
                        </div>

                        {!multiple && isSelected && (
                          <Check className="w-4 h-4 text-blue-500 ml-auto flex-shrink-0" />
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {multiple && (
                <div className="border-t border-gray-100 p-2 bg-white/50 flex justify-end sticky bottom-0">
                  <button
                    type="button"
                    onClick={() => {
                      onChange(tempValues as any);
                      setIsOpen(false);
                    }}
                    className="px-4 py-1.5 bg-gray-900 hover:bg-black text-white text-sm font-medium rounded-lg shadow-sm transition-colors"
                  >
                    完了
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
};