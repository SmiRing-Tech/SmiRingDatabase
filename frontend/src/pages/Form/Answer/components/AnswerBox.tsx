import React from 'react';
import type { QuestionData } from '../../FormEditor/FormEditorPage';
import RichTextEditor, { richTextStyles } from '../../../../components/ui/RichTextEditor';
import * as Icons from 'lucide-react';
import { CustomDropdown, type DropdownOption } from '../../../../components/ui/CustomDropdown';

const LucideIcon = ({ name, className }: { name: string, className?: string }) => {
  const Icon = (Icons as any)[name];
  if (!Icon) return null;
  return <Icon className={className} />;
};

type Props = {
  question: QuestionData;
  answer: any;
  onChange: (newAnswer: any) => void;
  error?: string;
};

export default function AnswerBox({ question, answer, onChange, error }: Props) {

  // --- 各質問タイプの入力UI ---

  const renderRadio = () => (
    <div className="space-y-3 pt-2">
      {question.options.map((opt) => (
        <label key={opt.id} className="flex items-center gap-3 cursor-pointer group">
          <div className="relative flex items-center justify-center">
            <input
              type="radio"
              name={`q-${question.id}`}
              value={opt.text}
              checked={answer === opt.text}
              onChange={() => onChange(opt.text)}
              className="peer sr-only"
            />
            <div className="w-5 h-5 rounded-full border-2 border-gray-300 peer-checked:border-blue-600 peer-checked:bg-blue-600 transition-colors" />
            <div className="absolute w-2 h-2 bg-white rounded-full opacity-0 peer-checked:opacity-100 transition-opacity" />
          </div>
          <span className="text-gray-700 group-hover:text-blue-900 transition-colors flex items-center gap-2">
            {opt.lucideIcon && <LucideIcon name={opt.lucideIcon} className="w-4 h-4 text-blue-500" />}
            {opt.text}
          </span>
        </label>
      ))}

      {question.allowCustomAnswer && (
        <div className="flex items-center gap-3 mt-2">
          <label className="flex items-center gap-3 cursor-pointer group">
            <div className="relative flex items-center justify-center">
              <input
                type="radio"
                name={`q-${question.id}`}
                checked={answer !== undefined && answer !== null && answer !== '' && !question.options.some(o => o.text === answer)}
                onChange={() => onChange(' ')}
                className="peer sr-only"
              />
              <div className="w-5 h-5 rounded-full border-2 border-gray-300 peer-checked:border-blue-600 peer-checked:bg-blue-600 transition-colors" />
              <div className="absolute w-2 h-2 bg-white rounded-full opacity-0 peer-checked:opacity-100 transition-opacity" />
            </div>
            <span className={`transition-colors ${answer !== undefined && answer !== null && answer !== '' && !question.options.some(o => o.text === answer) ? 'font-bold text-blue-700' : 'text-blue-500 font-medium'}`}>カスタム回答</span>
          </label>

          {(answer !== undefined && answer !== null && answer !== '' && !question.options.some(o => o.text === answer)) || (answer === ' ') ? (
            <input
              type="text"
              value={answer === ' ' ? '' : answer}
              onChange={(e) => onChange(e.target.value || ' ')}
              placeholder="回答を入力"
              className="flex-1 border-b-2 border-blue-500 py-1 outline-none text-sm bg-transparent animate-in fade-in slide-in-from-left-2"
              autoFocus
            />
          ) : null}
        </div>
      )}
    </div>
  );

  const renderCheckbox = () => {
    // チェックボックスは複数選択なので、配列で管理します
    const currentAnswers: string[] = Array.isArray(answer) ? answer : [];
    const validation = question.checkboxValidation;

    const currentValidAnswers = currentAnswers.filter(a =>
      question.options.some(opt => opt.text === a)
    );
    const currentCustomAnswers = currentAnswers.filter(a =>
      !question.options.some(opt => opt.text === a)
    );

    const handleToggle = (text: string) => {
      let newAnswers = [];
      if (currentValidAnswers.includes(text)) {
        newAnswers = currentValidAnswers.filter(a => a !== text);
      } else {
        newAnswers = [...currentValidAnswers, text];
      }

      if (question.allowCustomAnswer) {
        onChange([...newAnswers, ...currentCustomAnswers]);
      } else {
        onChange(newAnswers);
      }
    };

    const handleAddCustom = () => {
      onChange([...currentValidAnswers, ...currentCustomAnswers, ' ']);
    };

    const handleCustomChange = (index: number, newText: string) => {
      const newCustomAnswers = [...currentCustomAnswers];
      newCustomAnswers[index] = newText || ' ';
      onChange([...currentValidAnswers, ...newCustomAnswers]);
    };

    const handleRemoveCustom = (index: number) => {
      const newCustomAnswers = currentCustomAnswers.filter((_, i) => i !== index);
      onChange([...currentValidAnswers, ...newCustomAnswers]);
    };

    let errorMsg = null;
    if (validation?.enabled) {
      if (validation.min && currentAnswers.length < Number(validation.min)) {
        errorMsg = validation.errorMsg || `最低 ${validation.min} 個選択してください`;
      }
      if (validation.max && currentAnswers.length > Number(validation.max)) {
        errorMsg = validation.errorMsg || `最大 ${validation.max} 個まで選択できます`;
      }
    }

    return (
      <div className="space-y-3 pt-2">
        {question.options.map((opt) => {
          const isChecked = currentAnswers.includes(opt.text);
          const isDisabled = validation?.enabled && validation.max && !isChecked && currentAnswers.length >= Number(validation.max);

          return (
            <label key={opt.id} className={`flex items-center gap-3 group ${isDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
              <div className="relative flex items-center justify-center">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => { if (!isDisabled) handleToggle(opt.text); }}
                  disabled={isDisabled as boolean}
                  className="peer sr-only"
                />
                <div className={`w-5 h-5 rounded border-2 ${isDisabled ? 'border-gray-200' : 'border-gray-300 peer-checked:border-blue-600 peer-checked:bg-blue-600'} transition-colors`} />
                <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className={`text-gray-700 transition-colors flex items-center gap-2 ${!isDisabled && 'group-hover:text-blue-900'}`}>
                {opt.lucideIcon && <LucideIcon name={opt.lucideIcon} className="w-4 h-4 text-blue-500" />}
                {opt.text}
              </span>
            </label>
          );
        })}

        {question.allowCustomAnswer && currentCustomAnswers.map((customText, index) => (
          <div key={`custom-${index}`} className="flex items-center gap-3 animate-in fade-in slide-in-from-left-2">
            <div className="relative flex items-center justify-center">
              <input
                type="checkbox"
                checked={true}
                onChange={() => handleRemoveCustom(index)}
                className="peer sr-only"
              />
              <div className="w-5 h-5 rounded border-2 border-blue-600 bg-blue-600 transition-colors" />
              <svg className="absolute w-3 h-3 text-white transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </div>

            <input
              type="text"
              value={customText === ' ' ? '' : customText}
              onChange={(e) => handleCustomChange(index, e.target.value)}
              placeholder="回答を入力"
              className="flex-1 border-b-2 border-blue-500 py-1 outline-none text-sm bg-transparent"
              autoFocus={customText === ' '}
            />

            <button
              onClick={() => handleRemoveCustom(index)}
              className="text-gray-300 hover:text-red-500 transition-colors"
            >
              ✕
            </button>
          </div>
        ))}

        {question.allowCustomAnswer && (
          <div className="pt-2">
            <button
              onClick={handleAddCustom}
              className="flex items-center gap-1 text-sm font-bold text-blue-500 hover:text-blue-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
              カスタム回答
            </button>
          </div>
        )}
        {errorMsg && (
          <p className="text-red-500 text-xs mt-2 flex items-center gap-1 font-bold animate-in fade-in slide-in-from-top-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {errorMsg}
          </p>
        )}
      </div>
    );
  };

  const renderShortText = () => {
    const isMultiple = question.shortTextMultiple?.enabled;
    const listStyle = question.shortTextMultiple?.style || 'none';

    // 単一入力の場合は文字列、複数入力の場合は文字列の配列として扱う
    const valArray: string[] = isMultiple ? (Array.isArray(answer) ? answer : (answer ? [answer] : [''])) : [answer || ''];

    const validation = question.shortTextValidation;
    let errorMsg: string | null = null;

    // 各行についてバリデーションチェックを行う
    if (validation?.enabled) {
      for (const val of valArray) {
        if (!val) continue; // 空の場合はスキップ（必須チェックは別）

        if (validation.type === 'number') {
          const num = Number(val);
          if (isNaN(num)) { errorMsg = '数値を入力してください'; break; }
          else if (validation.condition === 'between') {
            const min = Math.min(Number(validation.value1), Number(validation.value2));
            const max = Math.max(Number(validation.value1), Number(validation.value2));
            if (num < min || num > max) { errorMsg = validation.errorMsg || `${min}から${max}の間で入力してください`; break; }
          }
          else if (validation.condition === 'greater' && num <= Number(validation.value1)) { errorMsg = validation.errorMsg || `${validation.value1}より大きい数値を入力してください`; break; }
          else if (validation.condition === 'less' && num >= Number(validation.value1)) { errorMsg = validation.errorMsg || `${validation.value1}より小さい数値を入力してください`; break; }
        } else if (validation.type === 'text') {
          if (validation.condition === 'contains' && !val.includes(validation.value1)) { errorMsg = validation.errorMsg || `「${validation.value1}」を含めてください`; break; }
          if (validation.condition === 'not_contains' && val.includes(validation.value1)) { errorMsg = validation.errorMsg || `「${validation.value1}」を含めないでください`; break; }
          if (validation.condition === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { errorMsg = validation.errorMsg || '有効なメールアドレスを入力してください'; break; }
          if (validation.condition === 'url' && !/^https?:\/\/.*/.test(val)) { errorMsg = validation.errorMsg || '有効なURL(http/https)を入力してください'; break; }
        } else if (validation.type === 'regex') {
          try {
            const regex = new RegExp(validation.value1);
            const isMatch = regex.test(val);
            if (validation.condition === 'match' && !isMatch) { errorMsg = validation.errorMsg || '指定された形式で入力してください: ' + validation.value1; break; }
            if (validation.condition === 'not_match' && isMatch) { errorMsg = validation.errorMsg || '指定された形式は使用できません: ' + validation.value1; break; }
          } catch (e) {
            // 正規表現が壊れている場合は無視
          }
        }
      }
    }

    const isDate = validation?.enabled && validation.type === 'date';

    const handleArrayChange = (index: number, newValue: string) => {
      const newArray = [...valArray];
      newArray[index] = newValue;
      onChange(newArray);
    };

    const handleAddRow = () => {
      onChange([...valArray, '']);
    };

    const handleRemoveRow = (index: number) => {
      const newArray = valArray.filter((_, i) => i !== index);
      onChange(newArray.length > 0 ? newArray : ['']);
    };

    const renderPrefix = (index: number) => {
      if (!isMultiple) return null;
      if (listStyle === 'bullet') return <span className="text-gray-800 mr-2 font-bold">•</span>;
      if (listStyle === 'number') return <span className="text-gray-400 mr-2 font-bold">{index + 1}.</span>;
      if (listStyle === 'arrow') return null;
      return null;
    };

    return (
      <div className="pt-2 space-y-3">
        {valArray.map((val, index) => (
          <React.Fragment key={index}>
            {index > 0 && isMultiple && listStyle === 'arrow' && (
              <div className="flex justify-start pl-4 opacity-50 py-1">
                <Icons.ArrowDown className="text-gray-800 font-bold text-lg" />
              </div>
            )}
            <div className="flex items-center group/input">
              {renderPrefix(index)}
              <input
                type={isDate ? "date" : "text"}
                value={val}
                onChange={(e) => isMultiple ? handleArrayChange(index, e.target.value) : onChange(e.target.value)}
                placeholder={isDate ? "" : "回答を入力"}
                className={`flex-1 md:w-2/3 border-b-2 py-2 outline-none transition-colors bg-transparent
                ${errorMsg ? 'border-red-500 focus:border-red-600' : 'border-gray-200 focus:border-blue-600'}
              `}
              />
              {isMultiple && valArray.length > 1 && (
                <button
                  onClick={() => handleRemoveRow(index)}
                  className="ml-3 text-gray-300 hover:text-red-500 opacity-0 group-hover/input:opacity-100 transition-opacity"
                >
                  ✕
                </button>
              )}
            </div>
          </React.Fragment>
        ))}

        {isMultiple && (
          <button
            onClick={handleAddRow}
            className="flex items-center gap-1 mt-2 text-sm text-blue-500 hover:text-blue-700 font-bold transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
            追加
          </button>
        )}

        {/* エラーメッセージの表示 */}
        {errorMsg && (
          <p className="text-red-500 text-xs mt-2 flex items-center gap-1 font-bold animate-in fade-in slide-in-from-top-1">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            {errorMsg}
          </p>
        )}
      </div>
    );
  };

  const renderGrid = () => {
    // 答えの形式: { "Row1 text": "Col1 text", "Row2 text": ["Col1 text", "Col2 text"] }
    const gridAnswer = answer || {};

    const handleGridChange = (rowText: string, colText: string) => {
      if (question.gridInputType === 'radio') {
        onChange({ ...gridAnswer, [rowText]: colText });
      } else {
        const rawAnswers = Array.isArray(gridAnswer[rowText]) ? gridAnswer[rowText] : [];
        // 現在の列設定(gridCols)に存在する有効な回答だけを抽出する
        const currentValidAnswers = rawAnswers.filter((t: string) =>
          question.gridCols.some(col => col.text === t)
        );

        if (currentValidAnswers.includes(colText)) {
          onChange({ ...gridAnswer, [rowText]: currentValidAnswers.filter((t: string) => t !== colText) });
        } else {
          onChange({ ...gridAnswer, [rowText]: [...currentValidAnswers, colText] });
        }
      }
    };

    return (
      <div className="pt-4 overflow-x-auto pb-4">
        <table className="text-sm text-left min-w-max border-separate border-spacing-y-2 mx-auto">
          <thead>
            <tr>
              <th key="empty-header" className="pb-2"></th>
              {question.gridCols.map(col => (
                <th key={col.id} className="pb-2 px-4 text-center font-bold text-gray-600 w-24">
                  {col.text || <span className="text-gray-300 italic">列</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {question.gridRows.map((row, rowIndex) => (
              <tr key={row.id} className={`${rowIndex % 2 === 0 ? 'bg-gray-50' : 'bg-white'}`}>
                <td key="row-label" className="py-3 px-4 rounded-l-lg font-medium text-gray-700 max-w-[200px] break-words whitespace-normal">
                  {row.text || <span className="text-gray-300 italic">行</span>}
                </td>
                {question.gridCols.map((col, colIndex) => {
                  const isChecked = question.gridInputType === 'radio'
                    ? gridAnswer[row.text] === col.text
                    : (Array.isArray(gridAnswer[row.text]) ? gridAnswer[row.text] : []).includes(col.text);

                  return (
                    <td key={col.id} className={`py-3 px-4 text-center ${colIndex === question.gridCols.length - 1 ? 'rounded-r-lg' : ''}`}>
                      <label className="flex items-center justify-center w-full h-full cursor-pointer">
                        <div className="relative flex items-center justify-center">
                          <input
                            type={question.gridInputType === 'radio' ? 'radio' : 'checkbox'}
                            name={`grid-${question.id}-${row.id}`}
                            checked={isChecked}
                            onChange={() => handleGridChange(row.text, col.text)}
                            className="peer sr-only"
                          />
                          <div className={`w-5 h-5 border-2 border-gray-300 peer-checked:border-blue-600 peer-checked:bg-blue-600 transition-colors ${question.gridInputType === 'radio' ? 'rounded-full' : 'rounded'}`} />
                          {question.gridInputType === 'radio' ? (
                            <div className="absolute w-2 h-2 bg-white rounded-full opacity-0 peer-checked:opacity-100 transition-opacity" />
                          ) : (
                            <svg className="absolute w-3 h-3 text-white opacity-0 peer-checked:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                          )}
                        </div>
                      </label>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderLongText = () => (
    <div className="pt-2 border border-gray-200 rounded-lg focus-within:ring-2 focus-within:ring-blue-200 focus-within:border-blue-500 transition-all bg-white">
      <RichTextEditor
        value={answer || ''}
        onChange={(html) => onChange(html)}
        placeholder="詳細を入力してください..."
      />
    </div>
  );

  const renderDropdown = () => {
    const dropdownOptions: DropdownOption[] = question.options.map(opt => ({
      value: opt.text,
      label: opt.text,
      isLabel: opt.isLabel,
      icon: opt.lucideIcon ? <LucideIcon name={opt.lucideIcon} className="w-4 h-4" /> : undefined
    }));

    return (
      <div className="pt-2">
        <div className="w-full md:w-2/3">
          <CustomDropdown
            options={dropdownOptions}
            value={answer || ''}
            onChange={(val) => onChange(val as string)}
            placeholder="選択してください"
            searchable={question.options.length > 10} // 10項目以上あれば検索可能にする
          />
        </div>
      </div>
    );
  };

  const renderScale = () => (
    <div className="pt-4">
      <div className="flex justify-between md:justify-center items-end gap-2 md:gap-8">
        {question.scale.minLabel && <span className="text-sm text-gray-500 pb-1">{question.scale.minLabel}</span>}

        <div className="flex gap-4 md:gap-8">
          {Array.from({ length: question.scale.max - question.scale.min + 1 }).map((_, i) => {
            const num = question.scale.min + i;
            return (
              <label key={num} className="flex flex-col items-center gap-3 cursor-pointer group">
                <span className={`text-sm font-bold ${answer === num ? 'text-blue-700' : 'text-gray-500 group-hover:text-blue-500'}`}>
                  {num}
                </span>
                <div className="relative flex items-center justify-center">
                  <input
                    type="radio"
                    name={`scale-${question.id}`}
                    value={num}
                    checked={answer === num}
                    onChange={() => onChange(num)}
                    className="peer sr-only"
                  />
                  <div className="w-6 h-6 rounded-full border-2 border-gray-300 peer-checked:border-blue-600 peer-checked:bg-blue-600 transition-colors shadow-sm" />
                  <div className="absolute w-2.5 h-2.5 bg-white rounded-full opacity-0 peer-checked:opacity-100 transition-opacity" />
                </div>
              </label>
            );
          })}
        </div>

        {question.scale.maxLabel && <span className="text-sm text-gray-500 pb-1">{question.scale.maxLabel}</span>}
      </div>
    </div>
  );

  return (
    <div
      id={`question-${question.id}`} // 🌟 追加：自動スクロールの目的地
      className={`bg-white p-6 md:p-8 rounded-xl shadow-sm border space-y-4 transition-all
        ${error ? 'border-red-400 ring-2 ring-red-50' : 'border-gray-200 hover:border-blue-200'} 
      `}
    >
      <div className="flex gap-2 mb-2 items-center">
        <h3 className="font-bold text-gray-800 text-lg leading-relaxed">{question.title || '無題の質問'}</h3>
        {/* 必須マークの表示 */}
        {question.isRequired && <span className="text-red-500 font-bold">*</span>}
      </div>

      {question.description && (
        <div
          className={richTextStyles}
          dangerouslySetInnerHTML={{ __html: question.description }}
        />
      )}

      {error && (
        <div className="text-red-600 text-sm font-bold flex items-center gap-1.5 bg-red-50 p-3 rounded-lg border border-red-100 animate-in fade-in slide-in-from-top-1">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          {error}
        </div>
      )}

      <div className="pt-2">
        {question.type === 'radio' && renderRadio()}
        {question.type === 'checkbox' && renderCheckbox()}
        {question.type === 'short_text' && renderShortText()}
        {question.type === 'long_text_md' && renderLongText()}
        {question.type === 'dropdown' && renderDropdown()}
        {question.type === 'scale' && renderScale()}
        {question.type === 'grid_radio' && renderGrid()}
      </div>
    </div>
  );
}