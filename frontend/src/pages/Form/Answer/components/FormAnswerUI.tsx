import { useState } from 'react';
import type { QuestionData } from '../../FormEditor/FormEditorPage';
import { richTextStyles } from '../../../../components/ui/RichTextEditor';
import AnswerBox from './AnswerBox';
import { Send, ExternalLink, User } from 'lucide-react';
import { Turnstile } from '@marsidev/react-turnstile';

type ReadonlyInfo = {
  displayName: string;
  submittedAt: string;
  avatarLink?: string | null;
};

type Props = {
  title: string;
  description: string;
  questions: QuestionData[];
  answers: Record<string, any>;
  onAnswerChange: (questionId: string, value: any) => void;
  onSubmit?: (turnstileToken: string) => void;
  mode: 'preview' | 'live' | 'readonly';
  isLoading?: boolean;
  onOpenFullScreen?: () => void;
  onClearAnswers?: () => void;
  isSaving?: boolean;
  lastSavedTime?: Date | null;
  readonlyInfo?: ReadonlyInfo;
  timezone?: string;
};

export default function FormAnswerUI({ 
  title, description, questions, answers,
  onAnswerChange, onSubmit, mode, isLoading = false,
  onOpenFullScreen, onClearAnswers,
  isSaving = false, lastSavedTime = null,
  readonlyInfo, timezone,
}: Props) {

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileError, setTurnstileError] = useState(false);

  const handleValidateAndSubmit = () => {
    const newErrors: Record<string, string> = {};
    questions.forEach((q) => {
      const ans = answers[q.id];
      const isEmpty = ans === undefined || ans === null || ans === '' || (Array.isArray(ans) && ans.length === 0);
      if (q.isRequired && isEmpty) { newErrors[q.id] = 'この質問は必須項目です'; return; }
      if (!isEmpty && q.type === 'short_text' && q.shortTextValidation?.enabled) {
        const val = String(ans); const v = q.shortTextValidation;
        if (v.type === 'number') {
          const num = Number(val);
          if (isNaN(num)) newErrors[q.id] = '数値を入力してください';
          else if (v.condition === 'between' && (num < Number(v.value1) || num > Number(v.value2))) newErrors[q.id] = v.errorMsg || `${v.value1}から${v.value2}の間で入力してください`;
          else if (v.condition === 'greater' && num <= Number(v.value1)) newErrors[q.id] = v.errorMsg || `${v.value1}より大きい数値を入力してください`;
          else if (v.condition === 'less' && num >= Number(v.value1)) newErrors[q.id] = v.errorMsg || `${v.value1}より小さい数値を入力してください`;
        } else if (v.type === 'text') {
          if (v.condition === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) newErrors[q.id] = v.errorMsg || '有効なメールアドレスを入力してください';
          else if (v.condition === 'url' && !/^https?:\/\/.*/.test(val)) newErrors[q.id] = v.errorMsg || '有効なURL(http/https)を入力してください';
          else if (v.condition === 'contains' && !val.includes(v.value1)) newErrors[q.id] = v.errorMsg || `「${v.value1}」を含めてください`;
          else if (v.condition === 'not_contains' && val.includes(v.value1)) newErrors[q.id] = v.errorMsg || `「${v.value1}」を含めないでください`;
        } else if (v.type === 'regex') {
          try {
            const regex = new RegExp(v.value1);
            if (v.condition === 'match' && !regex.test(val)) newErrors[q.id] = v.errorMsg || '指定された形式で入力してください';
            if (v.condition === 'not_match' && regex.test(val)) newErrors[q.id] = v.errorMsg || '指定された形式は使用できません';
          } catch (e) {}
        }
      }
    });
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      setTimeout(() => {
        const firstErrorId = Object.keys(newErrors)[0];
        document.getElementById(`question-${firstErrorId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
      return;
    }
    if (!turnstileToken) {
      setTurnstileError(true);
      document.getElementById('turnstile-widget')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setErrors({}); setTurnstileError(false);
    onSubmit?.(turnstileToken);
  };
  
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-20">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4" />
        <p className="text-gray-500 font-medium text-sm">読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col items-center relative pb-10">

      {/* ── モードバナー ── */}
      {mode === 'preview' && (
        <div className="w-full bg-orange-50 border-b border-orange-100 text-orange-700 px-4 py-2 flex items-center sticky top-0 z-20">
          <div className="w-8" />
          <span className="flex-1 text-center text-xs font-bold">👀 これはプレビューです。回答は保存されません。</span>
          {onOpenFullScreen && (
            <button onClick={onOpenFullScreen} className="p-1 hover:bg-orange-200 rounded-md transition-colors" title="全画面でプレビューを開く">
              <ExternalLink className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {mode === 'readonly' && readonlyInfo && (
        <div className="w-full bg-gray-100 border-b border-gray-200 px-4 py-3 flex items-center gap-3 sticky top-0 z-20">
          <div className="w-8 h-8 rounded-full bg-gray-300 overflow-hidden flex-shrink-0 flex items-center justify-center">
            {readonlyInfo.avatarLink
              ? <img src={readonlyInfo.avatarLink} className="w-full h-full object-cover" alt="" />
              : <User className="w-4 h-4 text-gray-500" />
            }
          </div>
          <div>
            <p className="text-sm font-bold text-gray-800">{readonlyInfo.displayName} の回答</p>
            <p className="text-xs text-gray-500">
              {new Date(readonlyInfo.submittedAt).toLocaleString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 提出
            </p>
          </div>
        </div>
      )}

      <div className="w-full max-w-3xl py-10 px-4 md:px-8 space-y-6">
        {/* タイトルカード */}
        <div className="border-t-[10px] border-blue-700 rounded-xl bg-white p-8 shadow-sm">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">{title || '無題のフォーム'}</h1>
          {description && (
            <div className={richTextStyles} dangerouslySetInnerHTML={{ __html: description }} />
          )}
          {mode !== 'preview' && mode !== 'readonly' && (
            <div className="mt-6 flex items-center justify-between border-t border-gray-100 pt-4">
              <div className="text-[11px] text-red-500 font-bold">* 必須項目</div>
              <div className="text-[10px] md:text-xs font-bold text-gray-400">
                {isSaving ? (
                  <span className="flex items-center gap-1"><span className="animate-spin text-blue-500">⏳</span> 保存中...</span>
                ) : lastSavedTime ? (
                  <span className="text-green-600">✓ {lastSavedTime.toLocaleTimeString()} に保存済み</span>
                ) : (
                  <span>自動保存が有効です</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 質問一覧 */}
        <div className={mode === 'readonly' ? 'pointer-events-none' : ''}>
          {questions.map((q) => (
            <div key={q.id} className="mb-6">
              <AnswerBox
                question={q}
                answer={answers[q.id]}
                onChange={(value) => {
                  onAnswerChange(q.id, value);
                  if (errors[q.id]) setErrors(prev => { const n = {...prev}; delete n[q.id]; return n; });
                }}
                error={errors[q.id]}
                timezone={timezone}
              />
            </div>
          ))}
        </div>

        {/* Turnstile + 送信ボタン（live/previewのみ） */}
        {mode !== 'readonly' && (
          <>
            <div id="turnstile-widget" className="pt-4 flex flex-col items-end">
              <Turnstile
                siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
                onSuccess={(token) => { setTurnstileToken(token); setTurnstileError(false); }}
                options={{ theme: 'light' }}
              />
              {turnstileError && (
                <span className="text-red-500 text-sm font-bold mt-2 animate-pulse">Botでないことを確認してください</span>
              )}
            </div>
            <div className="pt-6 flex flex-col md:flex-row justify-between items-center gap-6">
              <button onClick={onClearAnswers} className="text-sm text-gray-400 hover:text-gray-600 font-medium transition-colors">
                回答をクリア
              </button>
              <button
                onClick={handleValidateAndSubmit}
                className="w-full md:w-auto bg-blue-600 text-white px-10 py-3.5 rounded-xl font-bold shadow-lg hover:bg-blue-700 transition-all transform active:scale-95 flex items-center justify-center gap-2"
              >
                <Send className="w-5 h-5" />
                {mode === 'preview' ? '送信テスト' : '回答を送信'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}