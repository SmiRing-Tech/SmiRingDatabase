import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ClipboardList, Loader2, Play, Square, CheckCircle2, Circle, Globe, Eye, Check } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import type { UseConnectSurveyResult } from '../../hooks/useConnectSurvey';
import FormAnswerPage from '../../pages/Form/Answer/FormAnswerPage';

interface SurveyFormOption {
  id: string;
  title: string;
  access_mode: 'members' | 'public';
}

interface SurveyProgress {
  total: number;
  answered: number;
  participants: { identity: string; name: string; answered: boolean }[];
  anonymous: boolean;
}

const PROGRESS_POLL_MS = 4000;

/** Host-only: pick one of your forms to show everyone, then watch who has answered. */
export default function SurveyHostPanel({
  isOpen,
  onClose,
  mainRoomId,
  survey,
}: {
  isOpen: boolean;
  onClose: () => void;
  mainRoomId: string;
  survey: UseConnectSurveyResult;
}) {
  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div onClick={onClose} className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200" />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md h-[540px] max-h-[85vh] bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-3xl shadow-2xl p-6 text-white flex flex-col animate-in zoom-in-95 duration-200 z-10"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title="閉じる"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3 pr-6 shrink-0 mb-4">
          <div className="w-11 h-11 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
            <ClipboardList className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="font-black text-base">アンケート</h3>
            <p className="text-[11px] text-gray-400 font-semibold truncate">
              {survey.activeSurvey ? `実施中: ${survey.activeSurvey.form_title}` : '参加者全員の画面にフォームを表示します'}
            </p>
          </div>
        </div>

        {survey.activeSurvey ? (
          <ProgressView mainRoomId={mainRoomId} surveyId={survey.activeSurvey.id} onEnd={survey.end} />
        ) : (
          <FormPickerView mainRoomId={mainRoomId} onStart={survey.start} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function FormPickerView({ mainRoomId, onStart }: { mainRoomId: string; onStart: (formId: string) => Promise<void> }) {
  const [forms, setForms] = useState<SurveyFormOption[] | null>(null);
  const [requiresPublic, setRequiresPublic] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewForm, setPreviewForm] = useState<SurveyFormOption | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let isMounted = true;
    apiClient
      .get(`/api/connect/rooms/${encodeURIComponent(mainRoomId)}/survey-forms`)
      .then(async (res) => {
        if (!isMounted) return;
        if (!res.ok) throw new Error('フォーム一覧の取得に失敗しました');
        const body = await res.json();
        setForms(body.forms ?? []);
        setRequiresPublic(!!body.requiresPublic);
      })
      .catch((e) => isMounted && setError(e.message));
    return () => {
      isMounted = false;
    };
  }, [mainRoomId]);

  const handleStart = async () => {
    if (!selectedId) return;
    setStarting(true);
    setError('');
    try {
      await onStart(selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'アンケートの開始に失敗しました');
    } finally {
      setStarting(false);
    }
  };

  return (
    <>
      <p className="text-[11px] text-gray-400 font-semibold mb-2 shrink-0">
        {requiresPublic
          ? '外部ミーティングのため、ログインなしで回答できる（外部公開の）フォームだけを表示しています。'
          : '自分が作成した公開済みのフォームから選べます。'}
      </p>

      <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-1.5">
        {forms === null && !error ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
          </div>
        ) : forms && forms.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-10 leading-relaxed">
            選べるフォームがありません。
            <br />
            フォームを作成・公開してから開いてください。
          </p>
        ) : (
          forms?.map((f) => (
            <div
              key={f.id}
              className={`flex items-stretch rounded-xl border text-xs font-bold transition-colors ${
                selectedId === f.id
                  ? 'bg-sky-600/25 border-sky-500/60 text-white'
                  : 'bg-gray-800/40 border-gray-700/60 text-gray-200 hover:bg-gray-800'
              }`}
            >
              <button
                type="button"
                onClick={() => setSelectedId(f.id)}
                className="flex-1 min-w-0 flex items-center gap-2.5 pl-3 py-2.5 text-left"
              >
                <span className="flex-1 min-w-0 truncate">{f.title || '無題のフォーム'}</span>
                {f.access_mode === 'public' && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-sky-300 shrink-0">
                    <Globe className="w-3 h-3" />
                    外部公開
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setPreviewForm(f)}
                title="プレビュー"
                className="flex items-center gap-1 px-3 text-[10px] text-gray-400 hover:text-white shrink-0"
              >
                <Eye className="w-3.5 h-3.5" />
                プレビュー
              </button>
            </div>
          ))
        )}
      </div>

      {previewForm && (
        <FormPreviewModal
          form={previewForm}
          onClose={() => setPreviewForm(null)}
          onSelect={() => {
            setSelectedId(previewForm.id);
            setPreviewForm(null);
          }}
        />
      )}

      {error && <p className="text-xs text-rose-400 font-semibold mt-3 shrink-0">{error}</p>}

      <button
        onClick={handleStart}
        disabled={!selectedId || starting}
        className="mt-4 w-full py-2.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm rounded-xl transition-all active:scale-95 flex items-center justify-center gap-1.5 shrink-0"
      >
        {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        <span>参加者に表示する</span>
      </button>
    </>
  );
}

function ProgressView({
  mainRoomId,
  surveyId,
  onEnd,
}: {
  mainRoomId: string;
  surveyId: string;
  onEnd: () => Promise<void>;
}) {
  const [progress, setProgress] = useState<SurveyProgress | null>(null);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let isMounted = true;
    const load = async () => {
      try {
        const res = await apiClient.get(
          `/api/connect/rooms/${encodeURIComponent(mainRoomId)}/surveys/${surveyId}/progress`,
        );
        if (res.ok && isMounted) setProgress(await res.json());
      } catch (e) {
        console.error('[Connect] Failed to load survey progress:', e);
      }
    };
    void load();
    const interval = setInterval(load, PROGRESS_POLL_MS);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [mainRoomId, surveyId]);

  const handleEnd = async () => {
    if (!window.confirm('アンケートを終了して、参加者の画面から閉じますか？')) return;
    setEnding(true);
    setError('');
    try {
      await onEnd();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'アンケートの終了に失敗しました');
    } finally {
      setEnding(false);
    }
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.answered / progress.total) * 100) : 0;

  return (
    <>
      <div className="shrink-0 mb-4">
        <div className="flex items-end justify-between mb-2">
          <span className="text-3xl font-black tabular-nums">{progress ? `${percent}%` : '—'}</span>
          <span className="text-xs text-gray-400 font-bold tabular-nums">
            {progress ? `${progress.answered} / ${progress.total} 人が回答済み` : '集計中...'}
          </span>
        </div>
        <div className="h-2 w-full bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${percent}%` }} />
        </div>
        <p className="text-[10px] text-gray-500 font-semibold mt-1.5">
          ホストを除く、いま通話中（ミニルーム含む）の参加者が対象です
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 space-y-1">
        {progress?.anonymous && (
          <p className="text-xs text-gray-400 text-center py-10 leading-relaxed">
            匿名フォームのため、誰が回答したかは表示されません。
          </p>
        )}
        {progress?.participants.map((p) => (
          <div key={p.identity} className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-gray-800/40 text-xs font-bold">
            {p.answered ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <Circle className="w-4 h-4 text-gray-500 shrink-0" />
            )}
            <span className={`flex-1 min-w-0 truncate ${p.answered ? 'text-gray-300' : 'text-white'}`}>{p.name}</span>
            <span className={`text-[10px] shrink-0 ${p.answered ? 'text-emerald-400' : 'text-gray-500'}`}>
              {p.answered ? '回答済み' : '未回答'}
            </span>
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-rose-400 font-semibold mt-3 shrink-0">{error}</p>}

      <button
        onClick={handleEnd}
        disabled={ending}
        className="mt-4 w-full py-2.5 bg-gray-800 hover:bg-rose-950/80 border border-gray-700 hover:border-rose-500/50 text-gray-200 hover:text-rose-200 disabled:opacity-40 font-bold text-sm rounded-xl transition-all active:scale-95 flex items-center justify-center gap-1.5 shrink-0"
      >
        {ending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
        <span>アンケートを終了する</span>
      </button>
    </>
  );
}

/** Read-only look at a form before showing it to everyone: preview mode never saves or submits. */
function FormPreviewModal({
  form,
  onClose,
  onSelect,
}: {
  form: SurveyFormOption;
  onClose: () => void;
  onSelect: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4">
      <div onClick={onClose} className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200" />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-3xl h-full max-h-[92vh] bg-blue-50 rounded-3xl shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 z-10"
      >
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 bg-gray-900 text-white">
          <Eye className="w-4 h-4 text-sky-400 shrink-0" />
          <span className="flex-1 min-w-0 truncate text-xs font-bold">プレビュー: {form.title || '無題のフォーム'}</span>
          <button
            onClick={onSelect}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-sky-600 hover:bg-sky-500 transition-colors shrink-0"
          >
            <Check className="w-3.5 h-3.5" />
            このフォームを選ぶ
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 transition-colors shrink-0"
            title="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <FormAnswerPage formId={form.id} preview embedded={{ onClose }} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
