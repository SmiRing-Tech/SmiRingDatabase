import { useState } from 'react';
import { useFeedback } from '../../../../context/FeedbackContext';
import type { QuestionData } from '../../FormEditor/FormEditorPage';
import { richTextStyles } from '../../../../components/ui/RichTextEditor';
import AnswerBox from './AnswerBox';
import { Send, ExternalLink, User, Loader2 } from 'lucide-react';
import { Turnstile } from '@marsidev/react-turnstile';
import type { FileItem } from './FileUploadField';
import { supabase } from '../../../../lib/supabase';
import { apiClient } from '../../../../lib/apiClient';

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
  onSubmit?: (turnstileToken: string, finalAnswers?: Record<string, any>) => void;
  mode: 'preview' | 'live' | 'readonly';
  isLoading?: boolean;
  onOpenFullScreen?: () => void;
  onClearAnswers?: () => void;
  isSaving?: boolean;
  lastSavedTime?: Date | null;
  readonlyInfo?: ReadonlyInfo;
  timezone?: string;
  onTimezoneChange?: (timezone: string) => void;
  formId?: string;
};

export default function FormAnswerUI({ 
  title, description, questions, answers,
  onAnswerChange, onSubmit, mode, isLoading = false,
  onOpenFullScreen, onClearAnswers,
  isSaving = false, lastSavedTime = null,
  readonlyInfo, timezone, onTimezoneChange, formId,
}: Props) {
  const { showFeedback } = useFeedback();

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileError, setTurnstileError] = useState(false);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);

  const handleValidateAndSubmit = async () => {
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

      // --- ファイルアップロードのバリデーション ---
      if (!isEmpty && q.type === 'file_upload') {
        const files = (ans || []) as any[];
        const settings = q.fileUploadSettings || { maxFiles: 1, maxSizeMB: 10, allowedTypes: ['image', 'pdf'] };
        
        if (files.length > settings.maxFiles) {
          newErrors[q.id] = `最大 ${settings.maxFiles} 個までです（現在 ${files.length} 個選択中）`;
        } else if (files.some(f => f.error)) {
          newErrors[q.id] = '一部のファイルにエラーがあります';
        } else if (files.some(f => !f.path && !f.file && !f.error)) {
          // path も file も error もないという、本当に異常なケースのみブロック
          newErrors[q.id] = 'ファイルの情報が正しくありません';
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

    // 🌟 アップロードが必要なファイルを処理
    setIsUploadingFiles(true);
    try {
      const finalAnswers = { ...answers };
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('認証が必要です');

      for (const q of questions) {
        if (q.type === 'file_upload' && Array.isArray(finalAnswers[q.id])) {
          const items = finalAnswers[q.id] as FileItem[];
          const uploadedItems: any[] = [];

          for (const item of items) {
            // すでに path がある、またはエラーがある場合はスキップ/そのまま
            if (item.path || item.error) {
              uploadedItems.push({
                path: item.path,
                name: item.name,
                type: item.type,
                size: item.size
              });
              continue;
            }

            // file オブジェクトがある場合はアップロード実行
            if (item.file) {
              const formData = new FormData();
              formData.append('file', item.file);
              formData.append('form_id', formId || '');
              formData.append('auto_gallery', q.fileUploadSettings?.autoGallery !== false ? 'true' : 'false');

              const res = await apiClient.post('/api/forms/attachments/upload', formData);

              if (!res.ok) {
                const errData = await res.json();
                throw new Error(`${item.name} のアップロードに失敗しました: ${errData.error}`);
              }

              const data = await res.json();
              uploadedItems.push({
                path: data.path,
                thumbnailPath: data.thumbnailPath,
                galleryId: data.galleryId,
                name: data.filename,
                type: data.mimetype,
                size: data.size
              });
            }
          }
          finalAnswers[q.id] = uploadedItems;
        }
      }

      // 最終的な回答データで onSubmit を呼ぶ
      // onSubmit は FormAnswerPage.tsx の handleSubmit
      // そこでも isLoading がセットされるが、ここではアップロード分を先に終わらせる
      await onSubmit?.(turnstileToken, finalAnswers);
    } catch (err: any) {
      showFeedback(err.message || 'エラーが発生しました', { type: 'error', mode: 'banner' });
    } finally {
      setIsUploadingFiles(false);
    }
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
        <div className="">
          {questions.map((q) => (
            <div key={q.id} id={`question-${q.id}`} className="mb-6 scroll-mt-20">
              <AnswerBox
                question={q}
                answer={answers[q.id]}
                onChange={(value) => {
                  onAnswerChange(q.id, value);
                  if (errors[q.id]) setErrors(prev => { const n = {...prev}; delete n[q.id]; return n; });
                }}
                error={errors[q.id]}
                timezone={timezone}
                onTimezoneChange={onTimezoneChange}
                formId={formId}
                readOnly={!!readonlyInfo}
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
                disabled={isUploadingFiles}
                className="w-full md:w-auto bg-blue-600 text-white px-10 py-3.5 rounded-xl font-bold shadow-lg hover:bg-blue-700 transition-all transform active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isUploadingFiles ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    送信中...
                  </>
                ) : (
                  <>
                    <Send className="w-5 h-5" />
                    {mode === 'preview' ? '送信テスト' : '回答を送信'}
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}