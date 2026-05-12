import { useState, useEffect, useMemo } from 'react';
import { ArrowLeft, Send, Search, Users, Square, X, Settings } from 'lucide-react';
import { API_BASE_URL } from '../../../../config';
import { SmartDateTimePicker } from '../../../../components/ui/SmartDateTimePicker';
import countries from 'i18n-iso-countries';
import jaLocale from 'i18n-iso-countries/langs/ja.json';
import enLocale from 'i18n-iso-countries/langs/en.json';
import { BASIC_INFO_FIELDS } from '../../../Profile/basicInfoFields';

countries.registerLocale(jaLocale);
countries.registerLocale(enLocale);

const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const deptOptions = BASIC_INFO_FIELDS.smiring_department.options;

function normalizeCountry(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/^the\s+/i, '');
  const code = countries.getAlpha2Code(trimmed, 'ja') ?? countries.getAlpha2Code(trimmed, 'en');
  return code ? (countries.getName(code, 'en') ?? raw.trim()) : raw.trim();
}

function normalizeDepartments(raw: any): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map(v => deptOptions.find(o => o.id === v || o.text === v)?.text ?? null)
            .filter((v): v is string => !!v);
}

type Member = {
  id: string;
  name_english: string;
  avatar_link?: string;
  study_abroad_country?: string;
  smiring_department?: any;
  last_login_at?: string | null;
};

type Props = {
  onBackToEdit: () => void;
  onSend: (settings: {
    assignedUsers: string[],
    dueDate: string,
    dueTime: string,
    isAnonymous: boolean,
    timezone: string,
    allowMultipleResponses: boolean,
    allowEditResponses: boolean
  }) => void;
  initialTimezone?: string;
  isPublished?: boolean;
  initialAssignedUsers?: string[];
  initialDueDate?: string;
  initialIsAnonymous?: boolean;
  initialAllowMultipleResponses?: boolean;
  initialAllowEditResponses?: boolean;
};

export default function SendSettings({
  onBackToEdit, onSend,
  isPublished = false,
  initialAssignedUsers = [],
  initialDueDate = '',
  initialIsAnonymous = false,
  initialTimezone,
  initialAllowMultipleResponses = false,
  initialAllowEditResponses = true
}: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterDepartment, setFilterDepartment] = useState('');
  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'non-active'>('all');

  // --- 🌟 初期値の正規化 (比較用) ---
  const initialValues = useMemo(() => {
    if (!initialDueDate) return { date: '', time: '23:59', hasDeadline: false };
    try {
      const dateObj = new Date(initialDueDate);
      const formatter = new Intl.DateTimeFormat('sv-SE', {
        timeZone: initialTimezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
      const parts = formatter.formatToParts(dateObj);
      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const d = parts.find(p => p.type === 'day')?.value;
      const hh = parts.find(p => p.type === 'hour')?.value;
      const mm = parts.find(p => p.type === 'minute')?.value;
      return {
        date: `${y}-${m}-${d}`,
        time: `${hh}:${mm}`,
        hasDeadline: true
      };
    } catch (e) {
      return { date: '', time: '23:59', hasDeadline: false };
    }
  }, [initialDueDate, initialTimezone]);

  // --- 🌟 状態管理 ---
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>(initialAssignedUsers);
  const [isAnonymous, setIsAnonymous] = useState(initialIsAnonymous);
  const [allowMultipleResponses, setAllowMultipleResponses] = useState(initialAllowMultipleResponses);
  const [allowEditResponses, setAllowEditResponses] = useState(initialAllowEditResponses);
  const [isLoading, setIsLoading] = useState(true);

  // --- 🌟 追加：デフォルトのタイムゾーンを固定 ---
  const defaultTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  // タイムゾーンの初期値: 保存された値 > ブラウザの判定
  const [selectedTimezone, setSelectedTimezone] = useState(
    initialTimezone || defaultTimezone
  );

  const [hasDeadline, setHasDeadline] = useState(initialValues.hasDeadline);

  // --- 🌟 修正：Dateオブジェクトの安全な初期化関数 ---
  const getSafeInitialDate = () => {
    if (!initialValues.hasDeadline || !initialValues.date) {
      // 期限未設定時は今日の23:59をデフォルトにしておく
      const d = new Date();
      d.setHours(23, 59, 0, 0);
      return d;
    }
    // 'YYYY-MM-DD' のUTCパーストーラップを回避するため、数値に分割してローカル時刻として生成
    const [y, m, d] = initialValues.date.split('-').map(Number);
    const [h, min] = initialValues.time.split(':').map(Number);
    return new Date(y, m - 1, d, h, min, 0, 0);
  };

  const [deadlineDate, setDeadlineDate] = useState<Date>(getSafeInitialDate);

  useEffect(() => {
    const fetchMembers = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/basic_profile_info`);
        if (response.ok) setMembers(await response.json());
      } catch (error) {
        console.error(error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchMembers();
  }, []);

  useEffect(() => {
    if (initialValues.hasDeadline && initialValues.date) {
      const [y, m, d] = initialValues.date.split('-').map(Number);
      const [h, min] = initialValues.time.split(':').map(Number);
      setDeadlineDate(new Date(y, m - 1, d, h, min, 0, 0));
    }
  }, [initialValues]);

  // 🌟 メンバーを「選択済み」と「未選択」に分離
  const selectedMembers = members.filter(m => selectedUserIds.includes(m.id));
  const unselectedMembers = members.filter(m => !selectedUserIds.includes(m.id));

  // フィルター選択肢（動的生成）
  const availableCountries = useMemo(() =>
    [...new Set(
      members.map(m => normalizeCountry(m.study_abroad_country)).filter(Boolean) as string[]
    )].sort()
  , [members]);

  const availableDepartments = useMemo(() =>
    [...new Set(members.flatMap(m => normalizeDepartments(m.smiring_department)))].sort()
  , [members]);

  const filteredUnselected = unselectedMembers.filter(m => {
    const matchesSearch = (m.name_english || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCountry = !filterCountry || normalizeCountry(m.study_abroad_country) === filterCountry;
    const matchesDept = !filterDepartment || normalizeDepartments(m.smiring_department).includes(filterDepartment);
    const active = m.last_login_at
      ? Date.now() - new Date(m.last_login_at).getTime() < SIX_MONTHS_MS
      : false;
    const matchesActive =
      filterActive === 'active' ? active :
      filterActive === 'non-active' ? !active : true;
    return matchesSearch && matchesCountry && matchesDept && matchesActive;
  });

  const addAllFiltered = () => {
    const ids = filteredUnselected.map(m => m.id);
    setSelectedUserIds(prev => [...new Set([...prev, ...ids])]);
  };

  const toggleUser = (userId: string) => {
    setSelectedUserIds(prev => prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]);
  };

  const currentDueDate = `${deadlineDate.getFullYear()}-${String(deadlineDate.getMonth() + 1).padStart(2, '0')}-${String(deadlineDate.getDate()).padStart(2, '0')}`;
  const currentDueTime = `${String(deadlineDate.getHours()).padStart(2, '0')}:${String(deadlineDate.getMinutes()).padStart(2, '0')}`;

  const hasChanges =
    JSON.stringify([...selectedUserIds].sort()) !== JSON.stringify([...initialAssignedUsers].sort()) ||
    hasDeadline !== initialValues.hasDeadline ||
    (hasDeadline && (currentDueDate !== initialValues.date || currentDueTime !== initialValues.time)) ||
    selectedTimezone !== (initialTimezone || defaultTimezone) ||
    isAnonymous !== initialIsAnonymous ||
    allowMultipleResponses !== initialAllowMultipleResponses ||
    allowEditResponses !== initialAllowEditResponses;

  const isButtonDisabled = isPublished
    ? !hasChanges
    : selectedUserIds.length === 0;

  return (
    <div className="w-full h-full bg-white p-8 border-l border-gray-200 flex flex-col overflow-y-auto">
      <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-3 mb-8">
        <span className={`w-2 h-8 rounded-full inline-block ${isPublished ? 'bg-green-500' : 'bg-blue-600'}`} />
        {isPublished ? '公開設定の変更' : '送信設定'}
      </h2>

      <div className="space-y-8 flex-1">

        {/* --- 🌟 追加済みのメンバー一覧 (上部) --- */}
        <div className="space-y-3">
          <label className="text-sm font-bold text-gray-700 flex items-center gap-2">
            <Users className="w-4 h-4 text-blue-600" />
            回答を依頼するメンバー ({selectedUserIds.length}人)
          </label>

          {selectedMembers.length > 0 && (
            <div className="flex flex-wrap gap-2 p-3 bg-blue-50 rounded-xl border border-blue-100">
              {selectedMembers.map(member => (
                <div key={member.id} className="flex items-center gap-2 bg-white border border-blue-200 px-3 py-1.5 rounded-full text-sm font-medium shadow-sm transition-all group">
                  <div className="w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center text-[10px] text-blue-700 font-bold overflow-hidden">
                    {member.avatar_link ? <img src={member.avatar_link} className="w-full h-full object-cover" alt="" /> : member.name_english?.charAt(0)}
                  </div>
                  <span className="text-blue-900">{member.name_english}</span>
                  <button onClick={() => toggleUser(member.id)} className="text-blue-300 hover:text-red-500 transition-colors ml-1 focus:outline-none">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* --- 未選択メンバーの検索とリスト (下部) --- */}
        <div className="space-y-3">

          {/* フィルター行 */}
          <div className="flex flex-wrap gap-2">
            {/* 国 */}
            <select
              value={filterCountry}
              onChange={(e) => setFilterCountry(e.target.value)}
              className="flex-1 min-w-[120px] px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
            >
              <option value="">🌏 国 (全て)</option>
              {availableCountries.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>

            {/* 部署 */}
            <select
              value={filterDepartment}
              onChange={(e) => setFilterDepartment(e.target.value)}
              className="flex-1 min-w-[120px] px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all"
            >
              <option value="">🏢 部署 (全て)</option>
              {availableDepartments.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>

            {/* Active / Non-active トグル */}
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-bold">
              {(['all', 'active', 'non-active'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setFilterActive(v)}
                  className={`px-3 py-2 transition-colors ${filterActive === v ? 'bg-blue-600 text-white' : 'bg-gray-50 text-gray-500 hover:bg-gray-100'}`}
                >
                  {v === 'all' ? '全員' : v === 'active' ? 'Active' : 'Non-active'}
                </button>
              ))}
            </div>
          </div>

          {/* 検索バー + 全員に追加 */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="メンバーを検索して追加..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-all text-sm"
              />
            </div>
            <button
              type="button"
              onClick={addAllFiltered}
              disabled={filteredUnselected.length === 0}
              className="px-4 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 text-xs font-bold rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap flex items-center gap-1.5"
            >
              <Users className="w-4 h-4" />
              全員に追加
            </button>
          </div>

          <div className="border border-gray-200 rounded-xl overflow-hidden bg-white h-48 overflow-y-auto shadow-inner">
            {isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">読み込み中...</div>
            ) : unselectedMembers.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">すべてのメンバーを追加済みです！🎉</div>
            ) : filteredUnselected.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">見つかりませんでした</div>
            ) : (
              <div className="divide-y divide-gray-100">
                {filteredUnselected.map(member => {
                  const active = member.last_login_at
                    ? Date.now() - new Date(member.last_login_at).getTime() < SIX_MONTHS_MS
                    : false;
                  return (
                    <label key={member.id} className="flex items-center gap-4 p-3 cursor-pointer transition-colors hover:bg-gray-50">
                      <button type="button" onClick={() => toggleUser(member.id)} className="flex-shrink-0 focus:outline-none">
                        <Square className="w-5 h-5 text-gray-300" />
                      </button>
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-xs overflow-hidden flex-shrink-0">
                          {member.avatar_link ? <img src={member.avatar_link} className="w-full h-full object-cover" alt="" /> : member.name_english?.charAt(0)}
                        </div>
                        <span className="text-sm font-medium text-gray-700 truncate">{member.name_english}</span>
                        <span className={`ml-auto flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-500' : 'bg-gray-400'}`} />
                          {active ? 'Active' : 'Non-active'}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* --- 締切設定トグル --- */}
        <div className="space-y-4">
          <label className="flex items-start gap-3 cursor-pointer p-4 bg-gray-50 rounded-xl border border-gray-200 hover:border-blue-300 transition-colors group">
            <input
              type="checkbox"
              checked={hasDeadline}
              // 💡 ここを修正！単に bool を変えるだけでなく、日付の計算を挟む
              onChange={(e) => {
                const isChecked = e.target.checked;
                setHasDeadline(isChecked);
                
                // もし「オン」にして、かつ「元々の期限が設定されていなかった」場合
                if (isChecked && !initialValues.hasDeadline) {
                  const nextWeek = new Date();
                  nextWeek.setDate(nextWeek.getDate() + 7); // 7日後にする
                  nextWeek.setHours(23, 59, 0, 0);          // 23:59にセット
                  setDeadlineDate(nextWeek);
                }
              }}
              className="w-5 h-5 accent-blue-600 mt-0.5 flex-shrink-0"
            />
            <div className="flex-1">
              <span className="block text-sm font-bold text-gray-700 group-hover:text-blue-900 transition-colors">回答期限を設定する</span>
              <span className="block text-xs text-gray-500 mt-0.5">期限を過ぎると回答の新規受付を停止します。</span>
            </div>
          </label>

          {hasDeadline && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-200 space-y-4 ml-2 pl-6 border-l-2 border-blue-100">
              <SmartDateTimePicker
                value={deadlineDate}
                onChange={setDeadlineDate}
                timezone={selectedTimezone}
                onTimezoneChange={setSelectedTimezone}
                format={{ year: true, month: true, date: true, hour: true, minute: true, timezone: true }}
                is24h={true}
                defaultFocus="date"
              />
            </div>
          )}
        </div>

        <label className="flex items-start gap-3 cursor-pointer p-4 bg-gray-50 rounded-xl border border-gray-200 hover:border-blue-300 transition-colors group">
          <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} className="w-5 h-5 accent-blue-600 mt-0.5 flex-shrink-0" />

          <div className="flex-1">
            <span className="block text-sm font-bold text-gray-700 group-hover:text-blue-900 transition-colors">匿名回答に設定する</span>
            <span className="block text-xs text-gray-500 mt-0.5">このフォームは匿名フォームとして設定されます。全ての回答者が匿名になります。</span>
            {isAnonymous && (
              <span className="inline-flex items-center gap-1 mt-2 px-2 py-0.5 bg-gray-800 text-white text-[10px] font-bold rounded-full">
                🕶 匿名フォーム
              </span>
            )}
          </div>
        </label>

        {/* 🌟 複数回答の許可設定 */}
        <label className="flex items-start gap-3 cursor-pointer p-4 bg-gray-50 rounded-xl border border-gray-200 hover:border-blue-300 transition-colors group">
          <input type="checkbox" checked={allowMultipleResponses} onChange={(e) => setAllowMultipleResponses(e.target.checked)} className="w-5 h-5 accent-blue-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <span className="block text-sm font-bold text-gray-700 group-hover:text-blue-900 transition-colors">複数回答を許可する</span>
            <span className="block text-xs text-gray-500 mt-0.5">同じユーザーが何度も新しく回答できるようになります。</span>
          </div>
        </label>

        {/* 🌟 編集の許可設定 */}
        <label className="flex items-start gap-3 cursor-pointer p-4 bg-gray-50 rounded-xl border border-gray-200 hover:border-blue-300 transition-colors group">
          <input type="checkbox" checked={allowEditResponses} onChange={(e) => setAllowEditResponses(e.target.checked)} className="w-5 h-5 accent-blue-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <span className="block text-sm font-bold text-gray-700 group-hover:text-blue-900 transition-colors">送信後の編集を許可する</span>
            <span className="block text-xs text-gray-500 mt-0.5">ユーザーは一度送信した自分の回答を後から修正できるようになります。</span>
          </div>
        </label>
      </div>

      {/* --- 🌟 ボタンエリアのテキスト変更 --- */}
      <div className="pt-8 mt-4 flex gap-3 border-t border-gray-100">
        <button onClick={onBackToEdit} className="flex-1 bg-white border border-gray-200 text-gray-600 py-3.5 rounded-xl font-bold hover:bg-gray-50 transition-all flex justify-center items-center gap-2">
          <ArrowLeft className="w-5 h-5" />戻る
        </button>
        <button
          onClick={() => onSend({
            assignedUsers: selectedUserIds,
            dueDate: hasDeadline ? `${deadlineDate.getFullYear()}-${String(deadlineDate.getMonth() + 1).padStart(2, '0')}-${String(deadlineDate.getDate()).padStart(2, '0')}` : '',
            dueTime: hasDeadline ? `${String(deadlineDate.getHours()).padStart(2, '0')}:${String(deadlineDate.getMinutes()).padStart(2, '0')}` : '',
            isAnonymous,
            timezone: selectedTimezone,
            allowMultipleResponses,
            allowEditResponses
          })}
          disabled={isButtonDisabled}
          className={`flex-[2] text-white py-3.5 rounded-xl font-bold shadow-md transition-all transform hover:scale-[1.02] flex justify-center items-center gap-2 disabled:opacity-50 disabled:hover:scale-100 disabled:cursor-not-allowed ${isPublished ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
        >
          {isPublished ? (
            <><Settings className="w-5 h-5" />設定を更新</>
          ) : (
            <><Send className="w-5 h-5" />{selectedUserIds.length > 0 ? `${selectedUserIds.length}人に送信する` : '送信先を選択'}</>
          )}
        </button>
      </div>
    </div>
  );
}