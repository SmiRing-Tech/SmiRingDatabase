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
  const isRadioOrCheckbox = question.type === 'radio' || question.type === 'checkbox';
  const isCheckbox = question.type === 'checkbox';
  const isShortText = question.type === 'short_text';

  // 設定の矛盾エラーを取得
  const settingsErrors = getQuestionSettingsErrors(question);
  const getError = (field: string) => settingsErrors.find(e => e.field === field);

  // どの設定項目も存在しないタイプか確認
  const hasNoSettings = !isRadioOrCheckbox && !isShortText;

  return (
    // 背景オーバーレイ
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200"
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
                            { value: 'date', label: '日付' },
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
