import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Calendar as CalendarIcon, Clock, ChevronLeft, ChevronRight, Search, X, MapPin } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { WorldLocations } from '../../lib/timezones';

// --- 型定義 ---
export interface DateTimeFormat {
  year?: boolean;
  month?: boolean;
  date?: boolean;
  hour?: boolean;
  min?: boolean;
  sec?: boolean;
  timezone?: boolean;
}

export interface SmartDateTimePickerProps {
  value?: Date | null;
  onChange: (date: Date) => void;
  timezone?: string;
  onTimezoneChange?: (timezone: string) => void;
  format?: DateTimeFormat;
  is24h?: boolean;
  placeholder?: string;
}

type FieldType = 'timezone' | 'year' | 'month' | 'date' | 'hour' | 'min' | 'sec';

// 全角数字を半角に変換するユーティリティ
const toHalfWidth = (str: string) => {
  return str.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
};

// その月の日数を取得するユーティリティ
const getDaysInMonth = (year: number, month: number) => {
  return new Date(year, month, 0).getDate();
};

export const SmartDateTimePicker: React.FC<SmartDateTimePickerProps> = ({
  value,
  onChange,
  timezone,
  onTimezoneChange,
  format = { year: true, month: true, date: true, hour: true, min: true, sec: false, timezone: true },
  is24h = true,
  placeholder = "日時を選択"
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 現在選択中のフィールド（タブ）
  const [activeTab, setActiveTab] = useState<FieldType | null>(null);

  // タイムゾーン検索用
  const [timezoneSearchQuery, setTimezoneSearchQuery] = useState('');

  // 内部State（Dateオブジェクトを分解して管理）
  // モーダル内での一時的な値を保持し、完了ボタン押下時にのみ親に通知する
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [month, setMonth] = useState<number>(new Date().getMonth() + 1);
  const [date, setDate] = useState<number>(new Date().getDate());
  const [hour, setHour] = useState<number>(0);
  const [min, setMin] = useState<number>(0);
  const [sec, setSec] = useState<number>(0);
  const [localTimezone, setLocalTimezone] = useState<string>(timezone || 'Asia/Tokyo');

  const isPM = hour >= 12;

  // キーボード入力の一時バッファ
  const [inputBuffer, setInputBuffer] = useState<string>('');

  // モーダルが開く時に、現在のプロップスの値を内部Stateに同期する
  useEffect(() => {
    if (isOpen) {
      const d = value || new Date();
      setYear(d.getFullYear());
      setMonth(d.getMonth() + 1);
      setDate(d.getDate());
      setHour(d.getHours());
      setMin(d.getMinutes());
      setSec(d.getSeconds());
      if (timezone) setLocalTimezone(timezone);
    }
  }, [isOpen, value, timezone]);

  // 存在するフィールドのリスト（Auto-advance用）
  const availableFields = useMemo(() => {
    const fields: FieldType[] = [];
    if (format.year) fields.push('year');
    if (format.month) fields.push('month');
    if (format.date) fields.push('date');
    if (format.hour) fields.push('hour');
    if (format.min) fields.push('min');
    if (format.sec) fields.push('sec');
    return fields;
  }, [format]);

  // モーダルが開いた時の初期タブ設定
  useEffect(() => {
    if (isOpen && activeTab === null) {
      setActiveTab(availableFields[0] || null);
    } else if (!isOpen) {
      setActiveTab(null);
    }
  }, [isOpen, availableFields]);

  // モーダル外クリックで閉じる
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // モーダルが開いた時、最初の有効なタブをアクティブにする
  useEffect(() => {
    if (isOpen && availableFields.length > 0 && !activeTab) {
      setActiveTab(availableFields[0]);
    }
    if (!isOpen) {
      setActiveTab(null);
      setInputBuffer('');
    }
  }, [isOpen, availableFields, activeTab]);

  // 値の確定処理（完了ボタン押下時に呼ぶ）
  const handleConfirm = () => {
    // 日付としての正当性チェック
    const maxDate = getDaysInMonth(year, month);
    const safeDate = date > maxDate ? maxDate : (date < 1 ? 1 : date);

    const newDate = new Date(year, month - 1, safeDate, hour, min, sec);
    onChange(newDate);
    if (onTimezoneChange) onTimezoneChange(localTimezone);
    setIsOpen(false);
  };

  // 次のタブへの移動（Auto-advance）
  const advanceToNextTab = useCallback((currentTab: FieldType) => {
    const currentIndex = availableFields.indexOf(currentTab);
    if (currentIndex >= 0 && currentIndex < availableFields.length - 1) {
      setActiveTab(availableFields[currentIndex + 1]);
      setInputBuffer('');
    } else {
      // 最後のフィールドならバッファをクリアするだけ
      setInputBuffer('');
    }
  }, [availableFields]);

  // キーボードイベントの監視
  const handleKeyDown = useCallback((e: React.KeyboardEvent, field: FieldType) => {
    // タブ移動やエンターキーなどの操作はブラウザに任せる
    if (e.key === 'Tab' || e.key === 'Enter' || e.key === 'Escape') return;

    e.preventDefault();

    if (e.key === 'Backspace') {
      setInputBuffer(prev => prev.slice(0, -1));
      return;
    }

    const halfChar = toHalfWidth(e.key);
    if (!/^[0-9]$/.test(halfChar)) return; // 数字以外は無視

    const newBuffer = inputBuffer + halfChar;
    setInputBuffer(newBuffer);

    const numValue = parseInt(newBuffer, 10);
    const isMaxLength = (field === 'year' && newBuffer.length === 4) || (field !== 'year' && newBuffer.length === 2);

    // 値の更新
    switch (field) {
      case 'year':
        setYear(numValue);
        break;
      case 'month':
        setMonth(Math.min(12, Math.max(1, numValue)));
        break;
      case 'date':
        // 日付の最大値は月によって違うが、ここでは一旦入力値を入れる（useEffectで補正される）
        setDate(numValue);
        break;
      case 'hour':
        if (is24h) {
          setHour(Math.min(23, Math.max(0, numValue)));
        } else {
          // 12時間制の場合、1-12を入力。内部的には0-23に変換。
          const h12 = Math.min(12, Math.max(1, numValue));
          let h24 = h12 % 12;
          if (isPM) h24 += 12;
          setHour(h24);
        }
        break;
      case 'min':
        setMin(Math.min(59, Math.max(0, numValue)));
        break;
      case 'sec':
        setSec(Math.min(59, Math.max(0, numValue)));
        break;
    }

    // 規定桁数に達したら次へ
    if (isMaxLength) {
      advanceToNextTab(field);
    }
  }, [inputBuffer, advanceToNextTab]);


  // --- UI描画用のヘルパー ---

  // トリガーボタン用のテキスト生成
  const getDisplayText = () => {
    if (!value) return placeholder;
    const parts = [];

    // 💡 内部のドラフトState（year, month等）ではなく、親から渡された確定済みの value を使う
    const vYear = value.getFullYear();
    const vMonth = value.getMonth() + 1;
    const vDate = value.getDate();
    const vHour = value.getHours();
    const vMin = value.getMinutes();
    const vSec = value.getSeconds();

    if (format.year) parts.push(`${vYear}年`);
    if (format.month) parts.push(`${String(vMonth).padStart(2, '0')}月`);
    if (format.date) parts.push(`${String(vDate).padStart(2, '0')}日`);

    const timeParts = [];
    if (format.hour) {
      const displayHour = is24h ? vHour : (vHour % 12 || 12);
      const ampm = is24h ? '' : (vHour >= 12 ? '午後' : '午前');
      timeParts.push(`${ampm}${String(displayHour).padStart(2, '0')}`);
    }
    if (format.min) timeParts.push(String(vMin).padStart(2, '0'));
    if (format.sec) timeParts.push(String(vSec).padStart(2, '0'));

    const dateStr = parts.join('');
    const timeStr = timeParts.join(':');

    return `${dateStr} ${timeStr}`.trim();
  };

  const isLocalTimezoneInList = useMemo(() =>
    WorldLocations.some(l => l.cityId === localTimezone),
    [localTimezone]);

  const renderTimezoneUI = () => {
    const filtered = WorldLocations.filter(loc =>
      loc.names.some(name => name.toLowerCase().includes(timezoneSearchQuery.toLowerCase())) ||
      loc.cityId.toLowerCase().includes(timezoneSearchQuery.toLowerCase())
    );

    return (
      <div className="flex flex-col h-64">
        <div className="p-3 border-b border-gray-100 bg-gray-50/50">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="地域名や都市名で検索..."
              className="w-full pl-9 pr-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
              value={timezoneSearchQuery}
              onChange={(e) => setTimezoneSearchQuery(e.target.value)}
              autoFocus
            />
          </div>
        </div>
        <div className="flex-grow overflow-y-auto p-1 custom-scrollbar">
          {localTimezone && !isLocalTimezoneInList && !timezoneSearchQuery && (
            <button
              key="special-selection"
              className="w-full flex items-center px-4 py-2.5 rounded-lg text-sm font-medium transition-all bg-blue-600 text-white shadow-md mb-2"
            >
              <MapPin className="w-5 h-5 mr-3" />
              <div className="flex flex-col items-start overflow-hidden">
                <span className="truncate w-full font-bold">現在の場所 / 設定</span>
                <span className="text-[10px] text-blue-100">{localTimezone}</span>
              </div>
            </button>
          )}

          {filtered.length === 0 && !(!isLocalTimezoneInList && !timezoneSearchQuery) ? (
            <div className="p-8 text-center text-gray-400 text-sm">見つかりませんでした</div>
          ) : (
            <div className="grid grid-cols-1 gap-0.5">
              {filtered.map(loc => (
                <button
                  key={loc.cityId}
                  onClick={() => {
                    setLocalTimezone(loc.cityId);
                    if (availableFields.length > 0) setActiveTab(availableFields[0]);
                  }}
                  className={`flex items-center px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${loc.cityId === localTimezone ? 'bg-blue-600 text-white shadow-md' : 'text-gray-700 hover:bg-blue-50'
                    }`}
                >
                  <img
                    src={`https://flagcdn.com/w40/${loc.countryCode}.png`}
                    alt={loc.names[0]}
                    className="w-6 h-auto rounded-sm mr-3 shadow-sm"
                  />
                  <div className="flex flex-col items-start overflow-hidden">
                    <span className="truncate w-full">{loc.names[0]}</span>
                    <span className={`text-[10px] ${loc.cityId === localTimezone ? 'text-blue-100' : 'text-gray-400'}`}>{loc.cityId}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  // 年選択用のUI（10年ごとのグリッド）
  const renderYearUI = () => {
    const startYear = Math.floor(year / 10) * 10;
    const years = Array.from({ length: 12 }, (_, i) => startYear - 1 + i); // 前後1年含む12個

    return (
      <div className="p-4 h-64 flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <button onClick={() => setYear(year - 10)} className="p-1 hover:bg-gray-100 rounded"><ChevronLeft className="w-5 h-5" /></button>
          <span className="font-bold">{startYear} - {startYear + 9}</span>
          <button onClick={() => setYear(year + 10)} className="p-1 hover:bg-gray-100 rounded"><ChevronRight className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-3 gap-2 flex-grow">
          {years.map(y => (
            <button
              key={y}
              onClick={() => { setYear(y); advanceToNextTab('year'); }}
              className={`rounded-lg flex items-center justify-center font-medium transition-colors ${y === year ? 'bg-blue-600 text-white' :
                (y < startYear || y > startYear + 9) ? 'text-gray-400 hover:bg-gray-50' : 'hover:bg-blue-50'
                }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>
    );
  };

  // 月選択用のUI（3x4のグリッド）
  const renderMonthUI = () => (
    <div className="p-4 h-64 grid grid-cols-4 gap-2">
      {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
        <button
          key={m}
          onClick={() => { setMonth(m); advanceToNextTab('month'); }}
          className={`rounded-lg flex items-center justify-center font-medium transition-colors ${m === month ? 'bg-blue-600 text-white' : 'hover:bg-blue-50'
            }`}
        >
          {m}月
        </button>
      ))}
    </div>
  );

  // カレンダーUI（日選択）
  const renderDateUI = () => {
    const daysInMonth = getDaysInMonth(year, month);
    const firstDayOfWeek = new Date(year, month - 1, 1).getDay(); // 0(Sun) - 6(Sat)

    // カレンダーの空白を埋める
    const blanks = Array.from({ length: firstDayOfWeek }, (_, i) => <div key={`blank-${i}`} />);
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

    const handlePrevMonth = () => {
      if (month === 1) { setMonth(12); setYear(year - 1); }
      else { setMonth(month - 1); }
    };
    const handleNextMonth = () => {
      if (month === 12) { setMonth(1); setYear(year + 1); }
      else { setMonth(month + 1); }
    };

    return (
      // 💡 修正1: h-64 を削除し、中央揃えにする
      <div className="p-4 pb-2 flex flex-col items-center">

        {/* 💡 修正2: max-w-[320px] を追加して、ボタンが巨大化するのを防ぐ */}
        <div className="w-full max-w-[320px] mb-2">

          <div className="flex justify-between items-center mb-3">
            <button onClick={handlePrevMonth} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><ChevronLeft className="w-5 h-5" /></button>
            <span className="font-bold text-gray-800">{year}年 {month}月</span>
            <button onClick={handleNextMonth} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><ChevronRight className="w-5 h-5" /></button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-gray-400 mb-2">
            {['日', '月', '火', '水', '木', '金', '土'].map(d => <div key={d}>{d}</div>)}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {blanks}
            {days.map(d => (
              <button
                key={d}
                onClick={() => { setDate(d); advanceToNextTab('date'); }}
                className={`rounded-full aspect-square flex items-center justify-center text-sm font-medium transition-colors ${d === date ? 'bg-blue-600 text-white shadow-md' : 'hover:bg-blue-50 text-gray-700'
                  }`}
              >
                {d}
              </button>
            ))}
          </div>

        </div>
      </div>
    );
  };

  // 連動型ドラムロール風UI（時間・分・秒）
  const renderTimeUI = () => {
    const renderScrollList = (type: FieldType, max: number, currentValue: number, setter: (val: number) => void, start: number = 0) => {
      const isActive = activeTab === type;
      return (
        <div className={`flex-1 h-56 overflow-y-auto snap-y snap-mandatory scrollbar-hide border border-transparent rounded-lg ${isActive ? 'bg-blue-50/50 border-blue-200' : ''}`}>
          <div className="h-20" /> {/* 余白 */}
          {Array.from({ length: max }, (_, i) => i + start).map(val => (
            <div
              key={val}
              onClick={() => { setter(val); setActiveTab(type); }}
              className={`h-10 flex items-center justify-center snap-center cursor-pointer transition-all ${val === currentValue ? 'text-2xl font-bold text-blue-600 scale-110' : 'text-lg text-gray-400 hover:text-gray-600'
                }`}
            >
              {String(val).padStart(2, '0')}
            </div>
          ))}
          <div className="h-20" /> {/* 余白 */}
        </div>
      );
    };

    return (
      <div className="p-4 h-64 flex flex-col justify-center">
        <div className="flex space-x-2 text-center text-xs font-bold text-gray-400 mb-2 px-4">
          {format.hour && <div className="flex-1">時</div>}
          {format.min && <div className="flex-1">分</div>}
          {format.sec && <div className="flex-1">秒</div>}
        </div>
        <div className="flex justify-center space-x-4 relative bg-gray-50/50 rounded-xl p-2 border border-gray-100 shadow-inner">
          {/* 選択されている行を示す視覚的なガイド（真ん中の線） */}
          <div className="absolute top-1/2 left-0 right-0 h-10 -translate-y-1/2 bg-white/60 border-y border-gray-200 pointer-events-none rounded" />

          {!is24h && (
            <div className="flex flex-col justify-center space-y-2 pr-2 border-r border-gray-200">
              {/* 午前ボタン */}
              <button
                onClick={() => { if (isPM) setHour(hour - 12); }} // 午後なら12引く
                className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${!isPM ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-gray-400 hover:bg-gray-100'}`}
              >
                午前
              </button>

              {/* 午後ボタン */}
              <button
                onClick={() => { if (!isPM) setHour(hour + 12); }} // 午前なら12足す
                className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${isPM ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-gray-400 hover:bg-gray-100'}`}
              >
                午後
              </button>
            </div>
          )}

          {format.hour && renderScrollList('hour', is24h ? 24 : 12, is24h ? hour : (hour % 12 || 12), (val) => {
            if (!is24h) {
              let h = val % 12;
              if (isPM) h += 12;
              setHour(h);
            } else {
              setHour(val);
            }
          }, is24h ? 0 : 1)}
          {format.min && renderScrollList('min', 60, min, setMin)}
          {format.sec && renderScrollList('sec', 60, sec, setSec)}
        </div>
      </div>
    );
  };

  // 上部の入力タブを描画
  const renderTab = (field: FieldType, label: string, valueStr: string) => {
    const isActive = activeTab === field;
    return (
      <div className="flex items-end">
        <div
          tabIndex={0}
          onFocus={() => { setActiveTab(field); setInputBuffer(''); }}
          onKeyDown={(e) => handleKeyDown(e, field)}
          className={`flex items-center justify-center min-w-[3rem] px-2 py-1.5 rounded-lg border-2 outline-none cursor-pointer transition-all font-mono text-lg font-bold shadow-sm ${isActive ? 'border-blue-500 bg-blue-50 text-blue-700 scale-105' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
        >
          {/* 入力中のバッファがあればそれを、なければ現在の値を表示 */}
          {(isActive && inputBuffer) ? inputBuffer : valueStr}
        </div>
        <span className="ml-1 mr-2 text-sm text-gray-500 font-medium mb-1">{label}</span>
      </div>
    );
  };

  return (
    <div className="relative w-full" ref={containerRef}>
      {/* トリガーボタン */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full bg-white border border-gray-300 rounded-xl px-4 py-3 flex items-center shadow-sm hover:border-blue-300 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500/20 group"
      >
        <div className="flex items-center gap-2 flex-1 overflow-hidden">
          {format.timezone && timezone && (
            <div className="flex items-center gap-2 pr-3 border-r border-gray-200 flex-shrink-0">
              {WorldLocations.find(l => l.cityId === timezone) ? (
                <img
                  src={`https://flagcdn.com/w40/${WorldLocations.find(l => l.cityId === timezone)?.countryCode}.png`}
                  alt="flag"
                  className="w-5 h-auto rounded-sm shadow-sm"
                />
              ) : (
                <MapPin className="w-4 h-4 text-blue-500" />
              )}
              <span className="text-[10px] text-gray-400 font-bold uppercase hidden sm:block">
                {WorldLocations.find(l => l.cityId === timezone)?.names[0] || 'Unknown'}
              </span>
            </div>
          )}
          <div className="flex items-center gap-3 truncate">
            {format.year || format.month || format.date ? <CalendarIcon className="w-5 h-5 text-blue-500 flex-shrink-0" /> : <Clock className="w-5 h-5 text-blue-500 flex-shrink-0" />}
            <span className={`text-base truncate ${!value ? 'text-gray-400' : 'text-gray-800 font-medium group-hover:text-blue-700 transition-colors'}`}>
              {getDisplayText()}
            </span>
          </div>
        </div>
        <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-all" />
      </button>

      {/* モーダル（中央表示） */}
      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            {/* 背景オーバーレイ */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm"
            />

            {/* モーダルコンテンツ */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="relative bg-white rounded-[2rem] shadow-2xl overflow-hidden w-full max-w-md border border-gray-100"
            >
              {/* ヘッダーエリア（アイコン等） */}
              <div className="px-6 pt-6 pb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center">
                    <CalendarIcon className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-800">日時・タイムゾーン設定</h3>
                    <p className="text-[10px] text-gray-400 font-medium uppercase tracking-widest">Schedule & Region</p>
                  </div>
                </div>
                <button onClick={() => setIsOpen(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
                  <X className="w-5 h-5 text-gray-400" />
                </button>
              </div>

              {/* 上部：入力エリア */}
              <div className="p-6 space-y-4">
                {/* タイムゾーン選択（上部に横長） */}
                {format.timezone && (
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Timezone</label>
                    <button
                      onClick={() => { setActiveTab('timezone'); setTimezoneSearchQuery(''); }}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-2xl border-2 transition-all font-bold text-sm shadow-sm ${activeTab === 'timezone' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-100 bg-gray-50 hover:border-gray-200 text-gray-700'
                        }`}
                    >
                      <div className="flex items-center gap-3">
                        {(() => {
                          const loc = WorldLocations.find(l => l.cityId === localTimezone);
                          return loc ? (
                            <img
                              src={`https://flagcdn.com/w40/${loc.countryCode}.png`}
                              alt="flag"
                              className="w-5 h-auto rounded-sm shadow-sm"
                            />
                          ) : (
                            <MapPin className="w-4 h-4 text-blue-500" />
                          );
                        })()}
                        <span>{localTimezone ? (WorldLocations.find(l => l.cityId === localTimezone)?.names[0] || localTimezone) : '未設定'}</span>
                        {localTimezone && <span className="text-[10px] text-gray-400 font-medium">({localTimezone})</span>}
                      </div>
                      <ChevronRight className={`w-4 h-4 transition-transform ${activeTab === 'timezone' ? 'rotate-90' : ''}`} />
                    </button>
                  </div>
                )}

                {/* 日時入力（すべて一行に並べる） */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Date & Time</label>
                  <div className="bg-gray-50/80 p-2 rounded-2xl border border-gray-100 flex items-center gap-1 overflow-x-auto scrollbar-hide">
                    {format.year && renderTab('year', '年', String(year))}
                    {format.month && renderTab('month', '月', String(month).padStart(2, '0'))}
                    {format.date && renderTab('date', '日', String(date).padStart(2, '0'))}

                    <div className="w-px h-6 bg-gray-200 mx-1" /> {/* 仕切り線 */}

                    {format.hour && renderTab('hour', ':', String(is24h ? hour : (hour % 12 || 12)).padStart(2, '0'))}
                    {format.min && renderTab('min', format.sec ? ':' : '', String(min).padStart(2, '0'))}
                    {format.sec && renderTab('sec', '', String(sec).padStart(2, '0'))}
                  </div>
                </div>
              </div>

              {/* 下部：操作UIエリア */}
              <div className="bg-white min-h-[280px]">
                {activeTab === 'timezone' && renderTimezoneUI()}
                {activeTab === 'year' && renderYearUI()}
                {activeTab === 'month' && renderMonthUI()}
                {activeTab === 'date' && renderDateUI()}
                {(activeTab === 'hour' || activeTab === 'min' || activeTab === 'sec') && renderTimeUI()}
              </div>

              {/* 完了ボタンエリア */}
              <div className="p-6 bg-gray-50/50 flex gap-3">
                <button
                  onClick={handleConfirm}
                  className="flex-1 py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl shadow-lg shadow-blue-500/20 transition-all transform active:scale-[0.98]"
                >
                  設定を完了する
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};