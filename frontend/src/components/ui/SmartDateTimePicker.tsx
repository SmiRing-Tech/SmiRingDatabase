import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Calendar as CalendarIcon, Clock, ChevronLeft, ChevronRight, Search, MapPin } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { WorldLocations } from '../../lib/timezones';

// --- 型定義 ---
export interface DateTimeFormat {
  year?: boolean;
  month?: boolean;
  date?: boolean;
  hour?: boolean;
  minute?: boolean;
  second?: boolean;
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
  defaultFocus?: FieldType;
}

type FieldType = 'timezone' | 'year' | 'month' | 'date' | 'hour' | 'minute' | 'second';

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
  format = { year: true, month: true, date: true, hour: true, minute: true, second: false, timezone: false },
  is24h = true,
  placeholder = "日時を選択",
  defaultFocus = 'date'
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 現在選択中のフィールド（タブ）
  const [activeTab, setActiveTab] = useState<FieldType | null>(null);

  // タイムゾーン検索用
  const [timezoneSearchQuery, setTimezoneSearchQuery] = useState('');

  // 内部State（Dateオブジェクトを分解して管理）
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [month, setMonth] = useState<number>(new Date().getMonth() + 1);
  const [date, setDate] = useState<number>(new Date().getDate());
  const [hour, setHour] = useState<number>(0);
  const [minute, setMinute] = useState<number>(0);
  const [second, setSecond] = useState<number>(0);
  const [localTimezone, setLocalTimezone] = useState<string>(timezone || 'Asia/Tokyo');

  // スクロールコンテナのRef
  const hourScrollRef = useRef<HTMLDivElement>(null);
  const minScrollRef = useRef<HTMLDivElement>(null);
  const secScrollRef = useRef<HTMLDivElement>(null);
  const ampmScrollRef = useRef<HTMLDivElement>(null);

  const isPM = hour >= 12;

  // 初回表示時にスクロール位置を同期する
  useEffect(() => {
    if (isOpen && activeTab && ['hour', 'minute', 'second', 'ampm'].includes(activeTab)) {
      setTimeout(() => {
        const itemHeight = 40;
        if (hourScrollRef.current) hourScrollRef.current.scrollTop = (is24h ? hour : (hour % 12 || 12) - (is24h ? 0 : 1)) * itemHeight;
        if (minScrollRef.current) minScrollRef.current.scrollTop = minute * itemHeight;
        if (secScrollRef.current) secScrollRef.current.scrollTop = second * itemHeight;
        if (ampmScrollRef.current && !is24h) ampmScrollRef.current.scrollTop = (isPM ? 1 : 0) * itemHeight;
      }, 50);
    }
  }, [isOpen, activeTab]);

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
      setMinute(d.getMinutes());
      setSecond(d.getSeconds());
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
    if (format.minute) fields.push('minute');
    if (format.second) fields.push('second');
    return fields;
  }, [format]);

  // モーダルが開いた時の初期タブ設定
  useEffect(() => {
    if (isOpen) {
      if (!activeTab && availableFields.length > 0) {
        if (defaultFocus && availableFields.includes(defaultFocus)) {
          setActiveTab(defaultFocus);
        } else {
          setActiveTab(availableFields[0]);
        }
      }
    } else {
      setActiveTab(null);
      setInputBuffer('');
    }
  }, [isOpen, availableFields, defaultFocus]);

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

  const handleConfirm = () => {
    const maxDate = getDaysInMonth(year, month);
    const safeDate = date > maxDate ? maxDate : (date < 1 ? 1 : date);
    const newDate = new Date(year, month - 1, safeDate, hour, minute, second);
    onChange(newDate);
    if (onTimezoneChange) onTimezoneChange(localTimezone);
    setIsOpen(false);
  };

  const advanceToNextTab = useCallback((currentTab: FieldType) => {
    const currentIndex = availableFields.indexOf(currentTab);
    if (currentIndex >= 0 && currentIndex < availableFields.length - 1) {
      setActiveTab(availableFields[currentIndex + 1]);
      setInputBuffer('');
    } else {
      setInputBuffer('');
    }
  }, [availableFields]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent, field: FieldType) => {
    if (e.key === 'Tab' || e.key === 'Enter' || e.key === 'Escape') return;
    e.preventDefault();
    if (e.key === 'Backspace') {
      setInputBuffer(prev => prev.slice(0, -1));
      return;
    }
    const halfChar = toHalfWidth(e.key);
    if (!/^[0-9]$/.test(halfChar)) return;
    const newBuffer = inputBuffer + halfChar;
    setInputBuffer(newBuffer);
    const numValue = parseInt(newBuffer, 10);
    const isMaxLength = (field === 'year' && newBuffer.length === 4) || (field !== 'year' && newBuffer.length === 2);

    switch (field) {
      case 'year': setYear(numValue); break;
      case 'month': setMonth(Math.min(12, Math.max(1, numValue))); break;
      case 'date': setDate(numValue); break;
      case 'hour':
        if (is24h) setHour(Math.min(23, Math.max(0, numValue)));
        else {
          const h12 = Math.min(12, Math.max(1, numValue));
          let h24 = h12 % 12;
          if (isPM) h24 += 12;
          setHour(h24);
        }
        break;
      case 'minute': setMinute(Math.min(59, Math.max(0, numValue))); break;
      case 'second': setSecond(Math.min(59, Math.max(0, numValue))); break;
    }
    if (isMaxLength) advanceToNextTab(field);
  }, [inputBuffer, advanceToNextTab, is24h, isPM]);

  const getDisplayText = () => {
    if (!value) return placeholder;
    const parts = [];
    const vYear = value.getFullYear();
    const vMonth = value.getMonth() + 1;
    const vDate = value.getDate();
    const vHour = value.getHours();
    const vMin = value.getMinutes();
    const vSec = value.getSeconds();

    if (format.year) parts.push(`${vYear}年`);
    if (format.month) parts.push(`${String(vMonth).padStart(2, '0')}月`);
    if (format.date) parts.push(`${String(vDate).padStart(2, '0')}日`);
    
    let timeStr = "";
    if (format.hour) {
      timeStr += (!is24h ? (vHour % 12 || 12) : String(vHour).padStart(2, '0')) + "時";
    }
    if (format.minute) {
      timeStr += String(vMin).padStart(2, '0') + "分";
    }
    if (format.second) {
      timeStr += String(vSec).padStart(2, '0') + "秒";
    }
    
    if (timeStr) {
      if (!is24h) timeStr += ` ${vHour >= 12 ? 'PM' : 'AM'}`;
      parts.push(timeStr);
    }
    return parts.join(' ');
  };

  const handlePrevMonth = () => {
    if (month === 1) { setYear(year - 1); setMonth(12); } else { setMonth(month - 1); }
  };
  const handleNextMonth = () => {
    if (month === 12) { setYear(year + 1); setMonth(1); } else { setMonth(month + 1); }
  };

  const renderCalendar = () => {
    const daysInMonth = getDaysInMonth(year, month);
    const firstDayOfMonth = new Date(year, month - 1, 1).getDay();
    const blanks = Array.from({ length: firstDayOfMonth }, (_, i) => <div key={`blank-${i}`} />);
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

    return (
      <div className="p-4 pb-2 flex flex-col items-center">
        <div className="w-full max-w-[320px]">
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
            {days.map(d => {
              const isToday = new Date().toDateString() === new Date(year, month - 1, d).toDateString();
              const isSelected = date === d;
              return (
                <button
                  key={d}
                  onClick={() => { setDate(d); advanceToNextTab('date'); }}
                  className={`rounded-full aspect-square flex items-center justify-center text-sm transition-colors ${isSelected ? 'bg-blue-600 text-white shadow-md font-medium' :
                      isToday ? 'border-2 border-gray-200 bg-gray-100 text-gray-800 font-bold hover:bg-blue-50' :
                        'hover:bg-blue-50 text-gray-700 font-medium'
                    }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const renderYearUI = () => {
    const startYear = Math.floor(year / 10) * 10;
    const years = Array.from({ length: 12 }, (_, i) => startYear - 1 + i); // 前後1年含む12個

    return (
      <div className="p-6 flex flex-col h-[280px]">
        <div className="flex justify-between items-center mb-4">
          <button onClick={() => setYear(year - 10)} className="p-2 hover:bg-gray-100 rounded-xl transition-colors"><ChevronLeft className="w-5 h-5" /></button>
          <span className="font-bold text-gray-800 text-lg">{startYear} - {startYear + 9}</span>
          <button onClick={() => setYear(year + 10)} className="p-2 hover:bg-gray-100 rounded-xl transition-colors"><ChevronRight className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-3 gap-3 flex-grow">
          {years.map(y => (
            <button
              key={y}
              onClick={() => { setYear(y); advanceToNextTab('year'); }}
              className={`rounded-xl flex items-center justify-center font-bold text-sm transition-all ${
                y === year ? 'bg-blue-600 text-white shadow-md' : 
                (y < startYear || y > startYear + 9) ? 'text-gray-300 hover:bg-gray-50' : 'text-gray-700 hover:bg-blue-50'
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
    <div className="p-6 h-[280px] flex flex-col justify-center">
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
          <button
            key={m}
            onClick={() => { setMonth(m); advanceToNextTab('month'); }}
            className={`aspect-[4/3] rounded-xl flex items-center justify-center font-bold text-sm transition-all ${
              m === month ? 'bg-blue-600 text-white shadow-md' : 'text-gray-700 hover:bg-blue-50'
            }`}
          >
            {m}月
          </button>
        ))}
      </div>
    </div>
  );

  const handleScroll = (e: React.UIEvent<HTMLDivElement>, type: string, max: number, setter: (val: number) => void, start: number = 0) => {
    const itemHeight = 40;
    const scrollTop = e.currentTarget.scrollTop;
    const index = Math.round(scrollTop / itemHeight);
    const val = Math.min(max - 1, Math.max(0, index)) + start;

    if (type === 'ampm') {
      const newIsPM = val === 1;
      if (newIsPM !== isPM) {
        if (newIsPM && hour < 12) setHour(hour + 12);
        else if (!newIsPM && hour >= 12) setHour(hour - 12);
      }
      return;
    }
    if (type === 'hour' && !is24h) {
      let h = val % 12;
      if (isPM) h += 12;
      setter(h);
    } else {
      setter(val);
    }
  };

  const renderScrollList = (type: string, max: number, currentValue: number, setter: (val: number) => void, start: number = 0, items?: string[]) => {
    const itemHeight = 40;
    const isActive = activeTab === (type as any);
    const ref = type === 'hour' ? hourScrollRef : type === 'minute' ? minScrollRef : type === 'second' ? secScrollRef : ampmScrollRef;

    return (
      <div className="relative flex-1 group">
        <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-gray-50 to-transparent z-10 pointer-events-none" />
        <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-gray-50 to-transparent z-10 pointer-events-none" />
        <div
          ref={ref}
          onScroll={(e) => handleScroll(e, type, max, setter, start)}
          className={`h-60 overflow-y-auto snap-y snap-mandatory scrollbar-hide py-[100px] transition-colors ${isActive ? 'bg-blue-50/30' : ''}`}
          style={{ scrollPaddingTop: '100px', scrollPaddingBottom: '100px' }}
        >
          {Array.from({ length: max }, (_, i) => i + start).map((val, i) => (
            <div
              key={val}
              onClick={() => {
                if (ref.current) ref.current.scrollTo({ top: i * itemHeight, behavior: 'smooth' });
                setActiveTab(type as any);
              }}
              className={`h-10 flex items-center justify-center snap-center snap-always cursor-pointer transition-all ${currentValue === val
                  ? 'text-xl font-black text-blue-600 scale-110'
                  : 'text-sm text-gray-400 hover:text-gray-600'
                }`}
            >
              {items ? items[i] : String(val).padStart(2, '0')}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderTimezoneUI = () => {
    const filteredLocations = WorldLocations.filter(loc =>
      loc.names.some(n => n.toLowerCase().includes(timezoneSearchQuery.toLowerCase()))
    );

    return (
      <div className="flex flex-col h-[280px]">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <Search className="w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="都市名で検索..."
            className="flex-1 text-sm bg-transparent outline-none"
            value={timezoneSearchQuery}
            onChange={e => setTimezoneSearchQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredLocations.map(loc => (
            <button
              key={loc.cityId}
              onClick={() => {
                setLocalTimezone(loc.cityId);
                setActiveTab('date');
              }}
              className={`w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors ${localTimezone === loc.cityId ? 'bg-blue-50' : ''}`}
            >
              <div className="flex items-center gap-3">
                <img src={`https://flagcdn.com/w40/${loc.countryCode}.png`} alt="flag" className="w-5 h-auto rounded-sm" />
                <div className="text-left">
                  <p className={`text-sm font-bold ${localTimezone === loc.cityId ? 'text-blue-600' : 'text-gray-700'}`}>{loc.names[0]}</p>
                  <p className="text-[10px] text-gray-400 uppercase">{loc.cityId}</p>
                </div>
              </div>
              {localTimezone === loc.cityId && <div className="w-2 h-2 bg-blue-500 rounded-full" />}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderTab = (type: FieldType, label: string, valueStr: string) => {
    const isActive = activeTab === type;
    return (
      <div
        onClick={() => setActiveTab(type)}
        onKeyDown={(e) => handleKeyDown(e, type)}
        tabIndex={0}
        className={`flex flex-col items-center cursor-pointer min-w-[40px] px-2 py-1.5 rounded-xl transition-all outline-none ${isActive ? 'bg-blue-500 text-white shadow-lg scale-105' : 'hover:bg-gray-100'}`}
      >
        <div className={`text-xl font-mono font-black ${(isActive && inputBuffer) ? 'animate-pulse' : ''}`}>
          {(isActive && inputBuffer) ? inputBuffer : valueStr}
        </div>
        <span className={`text-[10px] font-bold uppercase ${isActive ? 'text-blue-100' : 'text-gray-400'}`}>{label}</span>
      </div>
    );
  };

  return (
    <div className="relative w-full" ref={containerRef}>
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

      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setIsOpen(false)}
            />
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative w-full max-w-[400px] bg-white rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="p-6 pb-4">
                {format.timezone && (
                  <div className="mb-4">
                    <button
                      onClick={() => setActiveTab('timezone')}
                      className={`w-full flex items-center justify-between p-3 rounded-2xl border transition-all ${activeTab === 'timezone' ? 'border-blue-500 bg-blue-50/50' : 'border-gray-100 bg-gray-50'}`}
                    >
                      <div className="flex items-center gap-3">
                        <MapPin className="w-4 h-4 text-blue-500" />
                        <span className="text-sm font-bold text-gray-700">Timezone</span>
                        {localTimezone && <span className="text-[10px] text-gray-400 font-medium">({localTimezone})</span>}
                      </div>
                      <ChevronRight className={`w-4 h-4 transition-transform ${activeTab === 'timezone' ? 'rotate-90' : ''}`} />
                    </button>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider ml-1">Date & Time</label>
                  <div className="bg-gray-50/80 py-2 rounded-2xl border border-gray-100 overflow-x-auto scrollbar-hide">
                    <div className="flex items-center gap-1 w-max mx-auto px-4">
                      {format.year && renderTab('year', '年', String(year))}
                      {format.month && renderTab('month', '月', String(month).padStart(2, '0'))}
                      {format.date && renderTab('date', '日', String(date).padStart(2, '0'))}

                      {(format.year || format.month || format.date) && (format.hour || format.minute || format.second) && (
                        <div className="w-px h-6 bg-gray-200 mx-2" />
                      )}

                      {format.hour && renderTab('hour', '時', String(is24h ? hour : (hour % 12 || 12)).padStart(2, '0'))}
                      {format.minute && renderTab('minute', '分', String(minute).padStart(2, '0'))}
                      {format.second && renderTab('second', '秒', String(second).padStart(2, '0'))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white min-h-[280px]">
                {activeTab === 'timezone' && renderTimezoneUI()}
                {activeTab === 'year' && renderYearUI()}
                {activeTab === 'month' && renderMonthUI()}
                {activeTab === 'date' && renderCalendar()}
                {['hour', 'minute', 'second', 'ampm'].includes(activeTab || '') && (
                  <div className="p-6">
                    <div className="flex text-[10px] font-black text-gray-300 uppercase tracking-widest mb-2 px-2">
                      {!is24h && <div className="flex-1">AM/PM</div>}
                      {format.hour && <div className="flex-1">HOUR</div>}
                      {format.minute && <div className="flex-1">MIN</div>}
                      {format.second && <div className="flex-1">SEC</div>}
                    </div>
                    <div className="flex justify-center space-x-0 relative bg-gray-50/50 rounded-[2rem] border border-gray-100 shadow-inner overflow-hidden">
                      <div className="absolute top-1/2 left-0 right-0 h-10 -translate-y-1/2 border-y-2 border-blue-500/20 bg-blue-500/5 pointer-events-none z-0" />
                      {!is24h && renderScrollList('ampm', 2, isPM ? 1 : 0, () => { }, 0, ['AM', 'PM'])}
                      {format.hour && renderScrollList('hour', is24h ? 24 : 12, is24h ? hour : (hour % 12 || 12), setHour, is24h ? 0 : 1)}
                      {format.minute && renderScrollList('minute', 60, minute, setMinute)}
                      {format.second && renderScrollList('second', 60, second, setSecond)}
                    </div>
                  </div>
                )}
              </div>

              <div className="p-4 bg-gray-50 flex gap-3">
                <button
                  onClick={() => setIsOpen(false)}
                  className="flex-1 py-3 text-sm font-bold text-gray-500 hover:bg-gray-100 rounded-2xl transition-all"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleConfirm}
                  className="flex-[1.5] py-3 bg-blue-600 text-white text-sm font-bold rounded-2xl shadow-lg shadow-blue-200 hover:bg-blue-700 transition-all"
                >
                  設定する
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};