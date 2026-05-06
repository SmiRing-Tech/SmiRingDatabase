import React from 'react';
import { X, Settings } from 'lucide-react';
import type { QuestionData } from '../FormEditorPage';
import { getQuestionSettingsErrors } from '../formValidation';
import { CustomDropdown} from '../../../../components/ui/CustomDropdown';

type Props = {
  question: QuestionData;
  onChange: (updates: Partial<QuestionData>) => void;
  onClose: () => void;
};

// =====================
// 共通トグルスイッチ
// =====================
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center cursor-pointer">
      <div className="relative">
        <input type="checkbox" className="sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
        <div className={`block w-11 h-6 rounded-full transition-colors duration-200 ${checked ? 'bg-blue-500' : 'bg-gray-300'}`} />
        <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full shadow transition-transform duration-200 ${checked ? 'translate-x-5' : ''}`} />
      </div>
    </label>
  );
}

// =====================
// セクションヘッダー
// =====================
function SectionHeader({ label }: { label: string }) {
  return (
    <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3 mt-5 first:mt-0">
      {label}
    </p>
  );
}

// =====================
// 設定行
// =====================
function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-gray-100 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-700">{label}</p>
        {description && <p className="text-xs text-gray-400 mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

export default function QuestionSettingsModal({ question, onChange, onClose }: Props) {
  const [dragHandle, setDragHandle] = React.useState<'start' | 'end' | null>(null);
  const sliderRef = React.useRef<HTMLDivElement>(null);

  // ドラッグ操作の監視
  React.useEffect(() => {
    if (!dragHandle) return;

    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!sliderRef.current) return;
      
      const rect = sliderRef.current.getBoundingClientRect();
      const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
      const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
      const i = Math.round((x / rect.width) * 5);

      const units = ['year', 'month', 'date', 'hour', 'minute', 'second'];
      const startIdx = units.indexOf(units.find(un => (question.dateTimeSettings.format as any)[un]) || 'year');
      const endIdx = units.indexOf([...units].reverse().find(un => (question.dateTimeSettings.format as any)[un]) || 'minute');

      let newStart = startIdx;
      let newEnd = endIdx;

      if (dragHandle === 'start') {
        newStart = Math.min(i, endIdx);
      } else {
        newEnd = Math.max(i, startIdx);
      }

      if (newStart !== startIdx || newEnd !== endIdx) {
        const newFormat = { ...question.dateTimeSettings.format };
        units.forEach((un, idx) => {
          (newFormat as any)[un] = idx >= newStart && idx <= newEnd;
        });
        const newIs24h = newFormat.hour ? question.dateTimeSettings.is24h : true;
        onChange({ dateTimeSettings: { ...question.dateTimeSettings, format: newFormat, is24h: newIs24h } });
      }
    };

    const handleEnd = () => setDragHandle(null);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleEnd);
    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('touchend', handleEnd);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleEnd);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
    };
  }, [dragHandle, question.dateTimeSettings, onChange]);

  const isRadioOrCheckbox = question.type === 'radio' || question.type === 'checkbox';
  const isCheckbox = question.type === 'checkbox';
  const isShortText = question.type === 'short_text';
  const isDropdown = question.type === 'dropdown';
  const isDateTime = question.type === 'date_time';

  // 設定の矛盾エラーを取得
  const settingsErrors = getQuestionSettingsErrors(question);
  const getError = (field: string) => settingsErrors.find(e => e.field === field);

  // どの設定項目も存在しないタイプか確認
  const hasNoSettings = !isRadioOrCheckbox && !isShortText && !isDateTime && !isDropdown;

  return (
    // 背景オーバーレイ
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* モーダル本体 */}
      <div
        className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
              <Settings className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <h3 className="font-bold text-gray-800">回答設定</h3>
              <p className="text-xs text-gray-400 truncate max-w-[220px]">
                {question.title || '無題の質問'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 設定内容 */}
        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {hasNoSettings ? (
            <div className="py-10 text-center text-gray-400">
              <Settings className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">この質問形式には<br />追加の設定項目はありません</p>
            </div>
          ) : (
            <>
              {/* ===== ラジオ・チェックボックス共通設定 ===== */}
              {isRadioOrCheckbox && (
                <>
                  <SectionHeader label="選択肢の設定" />
                  <SettingRow
                    label="カスタム回答を許可する"
                    description="回答者が選択肢以外の自由なテキストを入力できるようになります"
                  >
                    <Toggle
                      checked={question.allowCustomAnswer || false}
                      onChange={v => onChange({ allowCustomAnswer: v })}
                    />
                  </SettingRow>
                </>
              )}

              {/* ===== チェックボックス専用: 選択数の制限 ===== */}
              {isCheckbox && (
                <>
                  <SectionHeader label="回答の検証" />
                  <SettingRow
                    label="選択数を制限する"
                    description="チェックできる最小・最大数を設定します"
                  >
                    <Toggle
                      checked={question.checkboxValidation?.enabled || false}
                      onChange={v => onChange({
                        checkboxValidation: {
                          ...(question.checkboxValidation || { min: '', max: '', errorMsg: '' }),
                          enabled: v
                        }
                      })}
                    />
                  </SettingRow>

                  {question.checkboxValidation?.enabled && (
                    <div className="mt-3 p-4 bg-blue-50 rounded-xl border border-blue-100 space-y-3">
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <label className="text-xs font-bold text-gray-500 block mb-1">最小選択数</label>
                          <input
                            type="number" min="0" placeholder="制限なし"
                            value={question.checkboxValidation.min}
                            onChange={e => onChange({ checkboxValidation: { ...question.checkboxValidation, min: e.target.value ? Number(e.target.value) : '' } })}
                            className={`w-full p-2 border rounded-lg text-sm focus:outline-none focus:ring-2 bg-white ${
                              getError('checkboxValidation') ? 'border-red-400 focus:ring-red-400' : 'border-gray-200 focus:ring-blue-400'
                            }`}
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs font-bold text-gray-500 block mb-1">最大選択数</label>
                          <input
                            type="number" min="0" placeholder="制限なし"
                            value={question.checkboxValidation.max}
                            onChange={e => onChange({ checkboxValidation: { ...question.checkboxValidation, max: e.target.value ? Number(e.target.value) : '' } })}
                            className={`w-full p-2 border rounded-lg text-sm focus:outline-none focus:ring-2 bg-white ${
                              getError('checkboxValidation') ? 'border-red-400 focus:ring-red-400' : 'border-gray-200 focus:ring-blue-400'
                            }`}
                          />
                        </div>
                      </div>
                      {getError('checkboxValidation') && (
                        <p className="text-xs text-red-500 font-bold animate-in fade-in">{getError('checkboxValidation')!.message}</p>
                      )}
                      <div>
                        <label className="text-xs font-bold text-gray-500 block mb-1">エラーメッセージ（任意）</label>
                        <input
                          type="text" placeholder="条件を満たしていない場合のメッセージ"
                          value={question.checkboxValidation.errorMsg}
                          onChange={e => onChange({ checkboxValidation: { ...question.checkboxValidation, errorMsg: e.target.value } })}
                          className="w-full p-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ===== 短文入力専用設定 ===== */}
              {isShortText && (
                <>
                  <SectionHeader label="入力形式" />
                  <SettingRow
                    label="複数回答を許可する"
                    description="回答者が複数の短文を追加入力できるようになります"
                  >
                    <Toggle
                      checked={question.shortTextMultiple?.enabled || false}
                      onChange={v => onChange({
                        shortTextMultiple: {
                          ...(question.shortTextMultiple || { style: 'bullet' }),
                          enabled: v
                        }
                      })}
                    />
                  </SettingRow>

                  {question.shortTextMultiple?.enabled && (
                    <div className="mt-3 p-4 bg-blue-50 rounded-xl border border-blue-100">
                      <label className="text-xs font-bold text-gray-500 block mb-2">リストスタイル</label>
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          { value: 'none', label: 'なし' },
                          { value: 'bullet', label: '・ 箇条書き' },
                          { value: 'number', label: '1. 番号付き' },
                          { value: 'arrow', label: '→ 矢印' },
                        ] as const).map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => onChange({ shortTextMultiple: { ...question.shortTextMultiple, style: opt.value } })}
                            className={`px-3 py-2 text-sm font-medium rounded-lg border-2 transition-all ${
                              question.shortTextMultiple.style === opt.value
                                ? 'border-blue-500 bg-blue-500 text-white'
                                : 'border-gray-200 bg-white text-gray-600 hover:border-blue-300'
                            }`}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <SectionHeader label="回答の検証" />
                  <SettingRow
                    label="フォーマットを指定する"
                    description="数値・テキスト・日付・正規表現で入力を制限できます"
                  >
                    <Toggle
                      checked={question.shortTextValidation.enabled}
                      onChange={v => onChange({ shortTextValidation: { ...question.shortTextValidation, enabled: v } })}
                    />
                  </SettingRow>

                  {question.shortTextValidation.enabled && (
                    <div className="mt-3 p-4 bg-blue-50 rounded-xl border border-blue-100 space-y-3">
                      {/* タイプ選択 */}
                      <div>
                        <label className="text-xs font-bold text-gray-500 block mb-1">検証タイプ</label>
                        <CustomDropdown
                          options={[
                            { value: 'number', label: '数値' },
                            { value: 'text', label: 'テキスト' },
                            { value: 'regex', label: '正規表現' },
                          ]}
                          value={question.shortTextValidation.type}
                          onChange={(val) => onChange({
                            shortTextValidation: {
                              ...question.shortTextValidation,
                              type: val as string,
                              condition: val === 'number' ? 'between'
                                : val === 'text' ? 'contains'
                                : val === 'regex' ? 'match' : '',
                              value1: '',
                              value2: '',
                            }
                          })}
                          className="!py-2 !text-sm"
                        />
                      </div>

                      {/* 条件選択 */}
                      {question.shortTextValidation.type === 'number' && (
                        <div>
                          <label className="text-xs font-bold text-gray-500 block mb-1">条件</label>
                          <CustomDropdown
                            options={[
                              { value: 'between', label: '次の間にある' },
                              { value: 'greater', label: '次の値より大きい' },
                              { value: 'less', label: '次の値より小さい' },
                            ]}
                            value={question.shortTextValidation.condition}
                            onChange={(val) => onChange({ shortTextValidation: { ...question.shortTextValidation, condition: val as string, value1: '', value2: '' } })}
                            className="!py-2 !text-sm"
                          />
                        </div>
                      )}
                      {question.shortTextValidation.type === 'text' && (
                        <div>
                          <label className="text-xs font-bold text-gray-500 block mb-1">条件</label>
                          <CustomDropdown
                            options={[
                              { value: 'contains', label: '次を含む' },
                              { value: 'not_contains', label: '次を含まない' },
                              { value: 'email', label: 'メールアドレス' },
                              { value: 'url', label: 'URL' },
                            ]}
                            value={question.shortTextValidation.condition}
                            onChange={(val) => onChange({ shortTextValidation: { ...question.shortTextValidation, condition: val as string } })}
                            className="!py-2 !text-sm"
                          />
                        </div>
                      )}
                      {question.shortTextValidation.type === 'regex' && (
                        <div>
                          <label className="text-xs font-bold text-gray-500 block mb-1">条件</label>
                          <CustomDropdown
                            options={[
                              { value: 'match', label: '一致する' },
                              { value: 'not_match', label: '一致しない' },
                            ]}
                            value={question.shortTextValidation.condition}
                            onChange={(val) => onChange({ shortTextValidation: { ...question.shortTextValidation, condition: val as string } })}
                            className="!py-2 !text-sm"
                          />
                        </div>
                      )}

                      {/* 値の入力 */}
                      {question.shortTextValidation.type !== 'date' && !['email', 'url'].includes(question.shortTextValidation.condition) && (
                        <div className="flex gap-2">
                          <div className="flex-1">
                            <label className="text-xs font-bold text-gray-500 block mb-1">
                              {question.shortTextValidation.condition === 'between' ? '最小値' : '値'}
                            </label>
                            <input
                              type="text"
                              placeholder={question.shortTextValidation.type === 'regex' ? 'パターン例: ^[A-Z]' : '値'}
                              value={question.shortTextValidation.value1}
                              onChange={e => onChange({ shortTextValidation: { ...question.shortTextValidation, value1: e.target.value } })}
                              className={`w-full p-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 ${
                                getError('shortTextValidation_value1') ? 'border-red-400 focus:ring-red-400' : 'border-gray-200 focus:ring-blue-400'
                              }`}
                            />
                            {getError('shortTextValidation_value1') && (
                              <p className="text-xs text-red-500 font-bold mt-1 animate-in fade-in">{getError('shortTextValidation_value1')!.message}</p>
                            )}
                          </div>
                          {question.shortTextValidation.type === 'number' && question.shortTextValidation.condition === 'between' && (
                            <div className="flex-1">
                              <label className="text-xs font-bold text-gray-500 block mb-1">最大値</label>
                              <input
                                type="text" placeholder="値"
                                value={question.shortTextValidation.value2}
                                onChange={e => onChange({ shortTextValidation: { ...question.shortTextValidation, value2: e.target.value } })}
                                className={`w-full p-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 ${
                                  getError('shortTextValidation_value2') ? 'border-red-400 focus:ring-red-400' : 'border-gray-200 focus:ring-blue-400'
                                }`}
                              />
                              {getError('shortTextValidation_value2') && (
                                <p className="text-xs text-red-500 font-bold mt-1 animate-in fade-in">{getError('shortTextValidation_value2')!.message}</p>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* エラーメッセージ */}
                      <div>
                        <label className="text-xs font-bold text-gray-500 block mb-1">エラーメッセージ（任意）</label>
                        <input
                          type="text" placeholder="条件を満たしていない場合のメッセージ"
                          value={question.shortTextValidation.errorMsg}
                          onChange={e => onChange({ shortTextValidation: { ...question.shortTextValidation, errorMsg: e.target.value } })}
                          className="w-full p-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ===== ドロップダウン専用設定 ===== */}
              {isDropdown && (
                <>
                  <SectionHeader label="ドロップダウンの設定" />
                  <div className="mt-2 space-y-3">
                    <SettingRow
                      label="検索を許可する"
                      description="選択肢が多い場合に、キーワードで絞り込みができるようになります"
                    >
                      <Toggle
                        checked={question.dropdownSettings?.searchable || false}
                        onChange={v => onChange({ dropdownSettings: { ...question.dropdownSettings, searchable: v } })}
                      />
                    </SettingRow>
                    <SettingRow
                      label="複数選択を許可する"
                      description="回答者が一度に複数の項目を選択できるようになります"
                    >
                      <Toggle
                        checked={question.dropdownSettings?.multiple || false}
                        onChange={v => onChange({ dropdownSettings: { ...question.dropdownSettings, multiple: v } })}
                      />
                    </SettingRow>
                  </div>
                </>
              )}

              {/* ===== 日時選択専用設定 ===== */}
              {isDateTime && (
                <>
                  <SectionHeader label="精度の設定（範囲）" />
                  <div className="mt-2 p-5 bg-gray-50 rounded-[2rem] border border-gray-100 shadow-inner">
                    
                    {/* 統合されたレンジピッカーパネル（白いカード） */}
                    <div className="bg-white rounded-[1.5rem] border border-gray-100 shadow-sm overflow-hidden">
                      {/* 上部：ビジュアルプレビュー */}
                      <div className="flex flex-wrap items-center justify-center gap-y-3 gap-x-1 sm:gap-x-2 p-6 pb-2">
                        {[
                          { key: 'year', label: '年', dummy: '2024' },
                          { key: 'month', label: '月', dummy: '05' },
                          { key: 'date', label: '日', dummy: '06' },
                          { key: 'hour', label: '時', dummy: '12' },
                          { key: 'minute', label: '分', dummy: '30' },
                          { key: 'second', label: '秒', dummy: '00' },
                        ].map((u, i) => {
                          const units = ['year', 'month', 'date', 'hour', 'minute', 'second'];
                          const isActive = (question.dateTimeSettings.format as any)[u.key === 'minute' ? 'minute' : u.key];
                          
                          return (
                            <button
                              key={u.key}
                              type="button"
                              onClick={() => {
                                const startIndex = units.indexOf(units.find(un => (question.dateTimeSettings.format as any)[un === 'minute' ? 'minute' : un]) || 'year');
                                const endIndex = units.indexOf([...units].reverse().find(un => (question.dateTimeSettings.format as any)[un === 'minute' ? 'minute' : un]) || 'minute');
                                
                                let newStart = startIndex;
                                let newEnd = endIndex;
                                if (i < startIndex) newStart = i;
                                else if (i > endIndex) newEnd = i;
                                else {
                                  if (Math.abs(i - startIndex) < Math.abs(i - endIndex)) newStart = i;
                                  else newEnd = i;
                                }

                                const newFormat = { ...question.dateTimeSettings.format };
                                units.forEach((un, idx) => {
                                  (newFormat as any)[un === 'minute' ? 'minute' : un] = idx >= newStart && idx <= newEnd;
                                });
                                const newIs24h = newFormat.hour ? question.dateTimeSettings.is24h : true;
                                onChange({ dateTimeSettings: { ...question.dateTimeSettings, format: newFormat, is24h: newIs24h } });
                              }}
                              className={`group relative flex flex-col items-center transition-all ${isActive ? 'scale-105' : 'opacity-30 hover:opacity-50'}`}
                            >
                              <div className={`px-2 py-1 rounded-lg font-mono font-bold text-lg ${isActive ? 'text-blue-600 bg-blue-50' : 'text-gray-400'}`}>
                                {u.dummy}
                              </div>
                              <div className={`text-[10px] font-black uppercase tracking-tighter ${isActive ? 'text-blue-400' : 'text-gray-300'}`}>
                                {u.label}
                              </div>
                              {i < 5 && (
                                <div className="absolute -right-1.5 top-4 text-gray-200 font-bold hidden sm:block">.</div>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {/* 下部：レンジスライダー */}
                      <div className="px-8 pt-2 pb-8 select-none">
                        <div ref={sliderRef} className="relative h-2 bg-gray-100 rounded-full">
                          {/* トラックバー */}
                          {(() => {
                            const units = ['year', 'month', 'date', 'hour', 'minute', 'second'];
                            const startIdx = units.indexOf(units.find(un => (question.dateTimeSettings.format as any)[un === 'minute' ? 'minute' : un]) || 'year');
                            const endIdx = units.indexOf([...units].reverse().find(un => (question.dateTimeSettings.format as any)[un === 'minute' ? 'minute' : un]) || 'minute');
                            const left = (startIdx / 5) * 100;
                            const width = ((endIdx - startIdx) / 5) * 100;
                            return (
                              <div className="absolute h-full bg-blue-500 rounded-full transition-all duration-300" style={{ left: `${left}%`, width: `${width}%` }} />
                            );
                          })()}

                          {/* ステップドット & ハンドル */}
                          {['year', 'month', 'date', 'hour', 'minute', 'second'].map((u, i) => {
                            const units = ['year', 'month', 'date', 'hour', 'minute', 'second'];
                            const startUnit = units.find(un => (question.dateTimeSettings.format as any)[un === 'minute' ? 'minute' : un]) || 'year';
                            const endUnit = [...units].reverse().find(un => (question.dateTimeSettings.format as any)[un === 'minute' ? 'minute' : un]) || 'minute';
                            const startIdx = units.indexOf(startUnit);
                            const endIdx = units.indexOf(endUnit);
                            const isStart = i === startIdx;
                            const isEnd = i === endIdx;
                            const inRange = i >= startIdx && i <= endIdx;
                            
                            return (
                              <div 
                                key={u} 
                                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 cursor-pointer group"
                                style={{ left: `${(i / 5) * 100}%` }}
                                onClick={() => {
                                  let newStart = startIdx;
                                  let newEnd = endIdx;
                                  if (Math.abs(i - startIdx) <= Math.abs(i - endIdx)) newStart = i;
                                  else newEnd = i;
                                  if (newStart > newEnd) { const t = newStart; newStart = newEnd; newEnd = t; }
                                  const newFormat = { ...question.dateTimeSettings.format };
                                  units.forEach((un, idx) => { (newFormat as any)[un === 'minute' ? 'minute' : un] = idx >= newStart && idx <= newEnd; });
                                  const newIs24h = newFormat.hour ? question.dateTimeSettings.is24h : true;
                                  onChange({ dateTimeSettings: { ...question.dateTimeSettings, format: newFormat, is24h: newIs24h } });
                                }}
                              >
                                <div className={`w-3 h-3 rounded-full border-2 transition-all ${inRange ? 'bg-white border-blue-500' : 'bg-gray-200 border-transparent'}`} />
                                {(isStart || isEnd) && (
                                  <div 
                                    className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white border-2 border-blue-500 rounded-full shadow-lg z-20 flex items-center justify-center cursor-grab active:cursor-grabbing transition-transform ${dragHandle ? 'scale-110' : 'hover:scale-110'}`}
                                    onMouseDown={(e) => { e.stopPropagation(); setDragHandle(isStart ? 'start' : 'end'); }}
                                    onTouchStart={(e) => { e.stopPropagation(); setDragHandle(isStart ? 'start' : 'end'); }}
                                  >
                                    <div className="w-2 h-2 bg-blue-500 rounded-full" />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-400 text-center mt-4 tracking-wider">※ ハンドルをドラッグして精度（表示範囲）を調整してください</p>
                  </div>

                  <SectionHeader label="その他の設定" />
                  <div className={`mt-2 p-5 bg-gray-50 rounded-[2rem] border border-gray-100 space-y-4 ${!question.dateTimeSettings.format.hour ? 'opacity-50 grayscale' : ''}`}>
                    <SettingRow 
                      label="タイムゾーンを表示する"
                      description={!question.dateTimeSettings.format.hour ? "時刻が選択されていないため無効です" : "回答者がタイムゾーンを選択できるようになります"}
                    >
                      <Toggle
                        checked={question.dateTimeSettings.format.timezone}
                        onChange={v => onChange({ dateTimeSettings: { ...question.dateTimeSettings, format: { ...question.dateTimeSettings.format, timezone: v } } })}
                      />
                    </SettingRow>
                    
                    <SettingRow 
                      label="午前/午後を使用する"
                      description={!question.dateTimeSettings.format.hour ? "時刻が選択されていないため無効です" : "時刻を午前/午後の形式で表示します"}
                    >
                      <Toggle
                        checked={!question.dateTimeSettings.is24h}
                        onChange={v => onChange({ dateTimeSettings: { ...question.dateTimeSettings, is24h: !v } })}
                      />
                    </SettingRow>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* フッター */}
        <div className="p-4 border-t border-gray-100 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-blue-600 text-white text-sm font-bold rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
          >
            完了
          </button>
        </div>
      </div>
    </div>
  );
}
