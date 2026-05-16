import { useState, useEffect, useRef } from 'react';
import { useFeedback } from '../../../context/FeedbackContext';
import { useNavigate, useSearchParams, useParams, useBlocker } from 'react-router-dom';
import QuestionBox from './components/QuestionBox';
import { FileText, Eye, Send, Globe, AlertTriangle, Users, X } from 'lucide-react';
import SendSettings from './components/SendSettings';
import { supabase } from '../../../lib/supabase';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import FormAnswerUI from '../Answer/components/FormAnswerUI';
import { validateFormCritical } from './formValidation';

// 分離したコンポーネントのimport
import TitleBox from './components/TitleBox';
import InsertDivider from './components/InsertDivider';
import FormEditorSkeleton from './components/FormEditorSkeleton';

// Responseビューのimport
import FormResponsesView from '../Response/FormResponsesView';
import { API_BASE_URL } from '../../../config';

export type QuestionData = {
  id: string;
  title: string;
  description: string;
  type: string;
  isRequired?: boolean;
  options: { id: number; text: string; lucideIcon?: string; isLabel?: boolean }[];
  allowCustomAnswer?: boolean;
  scale: { min: number; max: number; minLabel: string; maxLabel: string };
  gridRows: { id: number; text: string; lucideIcon?: string; isLabel?: boolean }[];
  gridCols: { id: number; text: string; lucideIcon?: string; isLabel?: boolean }[];
  gridInputType: 'radio' | 'checkbox';
  shortTextValidation: {
    enabled: boolean;
    type: string;
    condition: string;
    value1: string;
    value2: string;
    errorMsg: string;
  };
  checkboxValidation: {
    enabled: boolean;
    min: number | '';
    max: number | '';
    errorMsg: string;
  };
  shortTextMultiple: {
    enabled: boolean;
    style: 'none' | 'bullet' | 'number' | 'arrow';
  };
  dateTimeSettings: {
    format: {
      year: boolean;
      month: boolean;
      date: boolean;
      hour: boolean;
      minute: boolean;
      second: boolean;
      timezone: boolean;
    };
    is24h: boolean;
  };
  dropdownSettings: {
    searchable: boolean;
    multiple: boolean;
  };
  fileUploadSettings: {
    maxFiles: number;
    maxSizeMB: number;
    allowedTypes: string[];
    autoGallery?: boolean;
  };
};

const createDefaultQuestion = (): QuestionData => ({
  id: crypto.randomUUID(),
  title: '',
  description: '',
  type: 'radio',
  isRequired: false,
  options: [{ id: 1, text: '', lucideIcon: '' }, { id: 2, text: '', lucideIcon: '' }],
  allowCustomAnswer: false,
  scale: { min: 1, max: 5, minLabel: '', maxLabel: '' },
  gridRows: [{ id: 1, text: '', lucideIcon: '' }],
  gridCols: [{ id: 1, text: '', lucideIcon: '' }],
  gridInputType: 'radio',
  shortTextValidation: { enabled: false, type: 'number', condition: 'between', value1: '', value2: '', errorMsg: '' },
  checkboxValidation: { enabled: false, min: '', max: '', errorMsg: '' },
  shortTextMultiple: { enabled: false, style: 'bullet' },
  dateTimeSettings: {
    format: {
      year: true, month: true, date: true,
      hour: true, minute: true, second: false,
      timezone: false
    },
    is24h: true
  },
  dropdownSettings: {
    searchable: false,
    multiple: false
  },
  fileUploadSettings: {
    maxFiles: 1,
    maxSizeMB: 10,
    allowedTypes: ['image', 'pdf'],
    autoGallery: true
  }
});

export default function FormEditorPage() {
  const { showFeedback } = useFeedback();
  const navigate = useNavigate();
  const { id: urlId } = useParams();
  const [formId] = useState(urlId || crypto.randomUUID());
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [lastSavedTime, setLastSavedTime] = useState<Date | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const viewMode = searchParams.get('mode') || 'edit';
  const [testAnswers, setTestAnswers] = useState<Record<string, any>>({});
  const editorScrollRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const scrollingPane = useRef<'editor' | 'preview' | null>(null);
  const [formStatus, setFormStatus] = useState('draft');
  const [currentDueDate, setCurrentDueDate] = useState('');
  const [currentIsAnonymous, setCurrentIsAnonymous] = useState(false);
  const [currentAssignedUsers, setCurrentAssignedUsers] = useState<string[]>([]);
  const [currentAllowMultiple, setCurrentAllowMultiple] = useState(false);
  const [currentAllowEdit, setCurrentAllowEdit] = useState(true);
  const [currentTimezone, setCurrentTimezone] = useState<string | undefined>(undefined);
  const [initialDefaultQuestion] = useState(() => createDefaultQuestion());
  const [questions, setQuestions] = useState<QuestionData[]>([initialDefaultQuestion]);
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(initialDefaultQuestion.id);
  const [responseCount, setResponseCount] = useState<number | null>(null);
  // 公開済フォームで致命的エラーがあり自動保存を一時停止しているかどうか
  const [saveBlocked, setSaveBlocked] = useState(false);

  // 未回答者/回答済みモーダル
  const [respondentsModal, setRespondentsModal] = useState(false);
  const [respondentsTab, setRespondentsTab] = useState<'non' | 'done'>('non');
  const [nonRespondents, setNonRespondents] = useState<any[]>([]);
  const [respondents, setRespondents] = useState<any[]>([]);
  const [isRespondentsLoading, setIsRespondentsLoading] = useState(false);

  const openRespondentsModal = async (tab: 'non' | 'done') => {
    setRespondentsTab(tab);
    setRespondentsModal(true);
    setIsRespondentsLoading(true);
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) { setIsRespondentsLoading(false); return; }
    const [nonRes, doneRes] = await Promise.all([
      fetch(`${API_BASE_URL}/api/forms/${formId}/non-respondents`, { headers: { 'Authorization': `Bearer ${token}` } }),
      fetch(`${API_BASE_URL}/api/forms/${formId}/responses`, { headers: { 'Authorization': `Bearer ${token}` } }),
    ]);
    setNonRespondents(await nonRes.json());
    setRespondents(await doneRes.json());
    setIsRespondentsLoading(false);
  };
  // 質問自体の並べ替え中かどうか
  const [isSortingQuestions, setIsSortingQuestions] = useState(false);
  const [sortingQuestionId, setSortingQuestionId] = useState<string | null>(null);

  // 回答数をバックグラウンドで取得
  useEffect(() => {
    const fetchCount = async () => {
      if (!urlId) return;
      try {
        const response = await fetch(`${API_BASE_URL}/api/forms/${urlId}/responses/count`);
        if (response.ok) {
          const data = await response.json();
          setResponseCount(data.count);
        }
      } catch (err) {
        console.error("回答数取得エラー:", err);
      }
    };
    fetchCount();
  }, [urlId, viewMode]);

  // ==========================================
  // viewMode の制御
  // ==========================================

  // 'edit'/'preview' 系のモード判定
  const isEditorMode = viewMode === 'edit' || viewMode === 'preview';
  // 'responses' 系のモード判定
  const isResponsesMode = viewMode === 'responses';

  const setViewMode = (mode: 'edit' | 'preview' | 'send' | 'responses') => {
    if (mode === 'edit') {
      setSearchParams({});
    } else if (mode === 'responses') {
      // 'responses'に切り替える時はデフォルトタブ(sheet)を設定
      const currentTab = searchParams.get('tab') || 'sheet';
      setSearchParams({ mode: 'responses', tab: currentTab });
    } else {
      setSearchParams({ mode });
    }
  };

  // ==========================================
  // スクロール同期
  // ==========================================

  const handleScrollSelection = () => {
    const container = editorScrollRef.current;
    if (!container) return;
    const containerCenter = container.getBoundingClientRect().top + container.clientHeight / 2;

    let closestId = null;
    let minDistance = Infinity;

    questions.forEach((q) => {
      const el = document.getElementById(`box-${q.id}`);
      if (el) {
        const rect = el.getBoundingClientRect();
        const elementCenter = rect.top + rect.height / 2;
        const distance = Math.abs(containerCenter - elementCenter);
        if (distance < minDistance) {
          minDistance = distance;
          closestId = q.id;
        }
      }
    });

    if (closestId) setActiveQuestionId(closestId);
  };

  const clearAnswers = () => setTestAnswers({});

  const openFullPreview = () => {
    window.open(`/form-preview/${formId}?mode=preview`, '_blank');
  };

  // ==========================================
  // データ読み込み
  // ==========================================

  useEffect(() => {
    const loadForm = async () => {
      if (!urlId) {
        setIsInitialLoading(false);
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}/api/forms/${urlId}?includeDeleted=true`);
        if (!response.ok) throw new Error('フォームの取得に失敗しました');
        const form = await response.json();

        if (form) {
          setTitle(form.title || '');
          setDescription(form.description || '');
          setFormStatus(form.status || 'draft');
          setCurrentDueDate(form.due_date || '');
          setCurrentIsAnonymous(form.allow_anonymous || false);
          setCurrentAssignedUsers(form.publish_settings?.assigned_user_ids || []);
          setCurrentAllowMultiple(form.allow_multiple_responses || false);
          setCurrentAllowEdit(form.allow_edit_responses !== false); // default to true if undefined
          setCurrentTimezone(form.timezone || form.publish_settings?.timezone);

          if (form.questions && form.questions.length > 0) {
            const loadedQuestions = (form.questions as any[]).map((q: any) => {
              return {
                id: q.id,
                title: q.title || '',
                description: q.description || '',
                type: q.type || 'radio',
                isRequired: q.isRequired || false,
                options: Array.isArray(q.options)
                  ? q.options.map((c: any, idx: number) =>
                    typeof c === 'string' ? { id: Date.now() + idx, text: c } : c
                  )
                  : [{ id: Date.now(), text: '' }, { id: Date.now() + 1, text: '' }],
                allowCustomAnswer: q.allowCustomAnswer || false,
                scale: q.scale || { min: 1, max: 5, minLabel: '', maxLabel: '' },
                gridRows: Array.isArray(q.gridRows)
                  ? q.gridRows.map((r: any, idx: number) =>
                    typeof r === 'string' ? { id: Date.now() + idx, text: r } : r
                  )
                  : [{ id: Date.now(), text: '' }],
                gridCols: Array.isArray(q.gridCols)
                  ? q.gridCols.map((c: any, idx: number) =>
                    typeof c === 'string' ? { id: Date.now() + idx, text: c } : c
                  )
                  : [{ id: Date.now(), text: '' }],
                gridInputType: q.gridInputType || 'radio',
                shortTextValidation: q.shortTextValidation || { enabled: false, type: 'number', condition: 'between', value1: '', value2: '', errorMsg: '' },
                checkboxValidation: q.checkboxValidation || { enabled: false, min: '', max: '', errorMsg: '' },
                shortTextMultiple: q.shortTextMultiple || { enabled: false, style: 'bullet' },
                dateTimeSettings: q.dateTimeSettings || {
                  format: { year: true, month: true, date: true, hour: true, minute: true, second: false, timezone: false },
                  is24h: true
                },
                dropdownSettings: q.dropdownSettings || { searchable: false, multiple: false },
                fileUploadSettings: q.fileUploadSettings || {
                  maxFiles: 1,
                  maxSizeMB: 10,
                  allowedTypes: ['image', 'pdf']
                }
              };
            });
            setQuestions(loadedQuestions);
            setActiveQuestionId(loadedQuestions[0].id);
          }
        }
      } catch (err) {
        console.error("読み込みエラー:", err);
      } finally {
        setIsInitialLoading(false);
      }
    };
    loadForm();
  }, [urlId]);

  // ==========================================
  // 自動保存
  // ==========================================

  useEffect(() => {
    if (!hasUnsavedChanges) return;

    const timer = setTimeout(async () => {
      // 公開済みの場合は致命的エラーをチェックし、あれば保存をスキップする
      if (formStatus === 'published') {
        const criticalErrors = validateFormCritical(title, questions);
        if (criticalErrors.length > 0) {
          setSaveBlocked(true);
          setHasUnsavedChanges(false); // リトライルループ防止
          return;
        }
      }
      setSaveBlocked(false);
      setHasUnsavedChanges(false);
      setIsSaving(true);
      try {
        console.log(`[Auto Save] バックエンドに保存中...`);

        const { data: { session } } = await supabase.auth.getSession();
        const userId = session?.user?.id;

        // 保存用にデータを整形（options, gridRows, gridCols を文字列配列に変換）
        const strippedQuestions = questions.map(q => ({
          ...q,
          options: q.options,
          gridRows: q.gridRows,
          gridCols: q.gridCols,
        }));

        const response = await fetch(`${API_BASE_URL}/api/forms/${formId}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, questions: strippedQuestions, created_by: userId, allow_multiple_responses: currentAllowMultiple, allow_edit_responses: currentAllowEdit })
        });

        if (!response.ok) throw new Error('保存に失敗しました');

        console.log(`[Auto Save] 保存完了: ${new Date().toLocaleTimeString()}`);
        setLastSavedTime(new Date());
      } catch (err) {
        console.error("保存エラー:", err);
        setHasUnsavedChanges(true);
      } finally {
        setIsSaving(false);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [title, description, questions, hasUnsavedChanges, formStatus]);

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    setHasUnsavedChanges(true);
  };

  const handleDescriptionChange = (newDescription: string) => {
    setDescription(newDescription);
    setHasUnsavedChanges(true);
  };

  const insertQuestionAt = (index: number) => {
    const newQuestions = [...questions];
    newQuestions.splice(index, 0, createDefaultQuestion());
    setQuestions(newQuestions);
    setHasUnsavedChanges(true);
  };

  const deleteQuestion = (idToDelete: string) => {
    setQuestions(questions.filter(q => q.id !== idToDelete));
    setHasUnsavedChanges(true);
  };

  const handleQuestionChange = (questionId: string, updates: Partial<QuestionData>) => {
    setQuestions(questions.map(q =>
      q.id === questionId ? { ...q, ...updates } : q
    ));
    setHasUnsavedChanges(true);
  };

  // --- 質問の並べ替えハンドラ ---
  const handleDragEnd = (result: DropResult) => {
    setIsSortingQuestions(false);
    setSortingQuestionId(null);
    if (!result.destination) return;

    const { source, destination, draggableId } = result;

    // 移動の有無に関わらず、ドラッグしていた質問に瞬時にフォーカスを合わせる関数
    const jumpToItem = () => {
      setActiveQuestionId(draggableId);
      // 縮小から拡大へのCSSアニメーション（duration-150に変更）に合わせて短い時間でスムーズスクロール
      setTimeout(() => {
        const el = document.getElementById(`box-${draggableId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 150);
    };

    // 元の位置に戻しただけの場合もスクロールさせる
    if (source.index === destination.index) {
      jumpToItem();
      return;
    }

    const newQuestions = Array.from(questions);
    const [moved] = newQuestions.splice(source.index, 1);
    newQuestions.splice(destination.index, 0, moved);
    setQuestions(newQuestions);
    setHasUnsavedChanges(true);

    jumpToItem();
  };

  // --- ドラッグ開始時のスクロール固定（スクロールアンカー） ---
  const handleStartSorting = (questionId: string) => {
    const scrollContainer = editorScrollRef.current;
    const el = document.getElementById(`box-${questionId}`);

    // 縮小アニメーションが始まる前のボックスの位置を記憶する
    const originalRectTop = el?.getBoundingClientRect().top ?? 0;

    setIsSortingQuestions(true);
    setSortingQuestionId(questionId);

    if (scrollContainer && el) {
      const startTime = performance.now();

      // アニメーション中、ボックスが『元の位置』からずれた分だけスクロールで打ち消す
      const updateScroll = (time: number) => {
        const rect = el.getBoundingClientRect();
        // ボックスが元の位置からどれだけずれたか（上にずれた場合 diff < 0）
        const diff = rect.top - originalRectTop;

        if (Math.abs(diff) > 0.5) {
          // 上にずれた分だけスクロール上を減らして元の位置に戻す
          scrollContainer.scrollTop += diff;
        }

        if (time - startTime < 200) { // duration-150 より少し長めに追従
          requestAnimationFrame(updateScroll);
        }
      };
      requestAnimationFrame(updateScroll);
    }
  };

  const handleEditorScroll = () => {
    if (scrollingPane.current === 'preview') return;
    handleScrollSelection();

    const editor = editorScrollRef.current;
    const preview = previewScrollRef.current;
    if (!editor || !preview) return;

    const scrollPercentage = editor.scrollTop / (editor.scrollHeight - editor.clientHeight);
    preview.scrollTop = scrollPercentage * (preview.scrollHeight - preview.clientHeight);
  };

  const handlePreviewScroll = () => {
    if (scrollingPane.current !== 'preview') return;

    const editor = editorScrollRef.current;
    const preview = previewScrollRef.current;
    if (!editor || !preview) return;

    const scrollPercentage = preview.scrollTop / (preview.scrollHeight - preview.clientHeight);
    editor.scrollTop = scrollPercentage * (editor.scrollHeight - editor.clientHeight);
    handleScrollSelection();
  };

  // ==========================================
  // 送信設定ハンドラ
  // ==========================================

  const handlePublish = async (settings: {
    assignedUsers: string[],
    dueDate: string,
    dueTime: string,
    isAnonymous: boolean,
    timezone: string,
    allowMultipleResponses: boolean,
    allowEditResponses: boolean
  }) => {
    setIsSaving(true);
    try {
      let finalDeadline = null;
      if (settings.dueDate) {
        const timeStr = settings.dueTime || "23:59:59";
        const localDateTime = `${settings.dueDate}T${timeStr}`;
        try {
          const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: settings.timezone,
            timeZoneName: 'shortOffset',
          });
          const parts = formatter.formatToParts(new Date(localDateTime));
          const offsetPart = parts.find(p => p.type === 'timeZoneName');
          const offset = offsetPart?.value || 'GMT';
          const formattedOffset = offset === 'GMT' ? '+00:00' : offset.replace('GMT', '').replace(':', '') + ':00';
          const isoWithOffset = `${localDateTime}:00${formattedOffset.startsWith('+') || formattedOffset.startsWith('-') ? formattedOffset : '+' + formattedOffset}`;
          finalDeadline = isoWithOffset;
        } catch (e) {
          console.warn("Timezone offset calculation failed, falling back to local string", e);
          finalDeadline = localDateTime;
        }
      }
      const newStatus = settings.assignedUsers.length === 0 ? 'draft' : 'published';

      const response = await fetch(`${API_BASE_URL}/api/forms/${formId}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assigned_user_ids: settings.assignedUsers,
          due_date: finalDeadline,
          allow_anonymous: settings.isAnonymous,
          allow_multiple_responses: settings.allowMultipleResponses,
          allow_edit_responses: settings.allowEditResponses,
          timezone: settings.timezone,
          status: newStatus
        })
      });

      if (!response.ok) throw new Error('更新に失敗しました');

      setFormStatus(newStatus);
      setCurrentAssignedUsers(settings.assignedUsers);
      setCurrentDueDate(finalDeadline || '');
      setCurrentIsAnonymous(settings.isAnonymous);
      setCurrentAllowMultiple(settings.allowMultipleResponses);
      setCurrentAllowEdit(settings.allowEditResponses);
      setCurrentTimezone(settings.timezone);

      const message = newStatus === 'draft'
        ? '全員を削除したため、下書きに戻しました。'
        : (formStatus === 'published' ? '設定を更新しました！' : '🚀 フォームを公開しました！');

      const isPublished = newStatus === 'published' && formStatus !== 'published';
      showFeedback(message, { 
        mode: isPublished ? 'splash' : 'toast', 
        type: 'success',
        emoji: isPublished ? '🚀' : undefined
      });
      setViewMode('edit');
    } catch (err) {
      console.error('Publish error:', err);
      showFeedback('エラーが発生しました', { type: 'error', mode: 'banner' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleShowErrors = () => {
    const errors = validateFormCritical(title, questions);
    if (errors.length > 0) {
      const errorList = errors.map(e => `・ ${e.message}`).join('\n');
      showFeedback(`以下の不備を修正してください。\n\n${errorList}`, { type: 'error', mode: 'banner' });
      // 最初のエラーのある質問に自動スクロール
      if (errors[0].questionId) {
        const el = document.getElementById(`box-${errors[0].questionId}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return true; // エラーあり
    }
    return false; // エラーなし
  };

  // ==========================================
  // ページ離脱・タブ閉じのブロック処理
  // ==========================================

  // 1. タブを閉じようとしたり、リロードしようとした時のブロック（ブラウザ標準の警告）
  useEffect(() => {
    if (!saveBlocked && !hasUnsavedChanges) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // これを設定するとブラウザ標準の確認ダイアログが出ます
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [saveBlocked]);

  // 2. サイト内での別ページへの遷移（React Routerの機能）をブロック
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (saveBlocked || hasUnsavedChanges) && currentLocation.pathname !== nextLocation.pathname
  );

  useEffect(() => {
    if (blocker.state === 'blocked') {
      // 遷移しようとした瞬間にエラーダイアログを出し、スクロールさせる
      handleShowErrors();
      // 遷移自体はキャンセルして今のページにとどまる
      blocker.reset();
    }
  }, [blocker.state, blocker.reset]);

  // ==========================================
  // ローディング
  // ==========================================

  if (isInitialLoading) {
    return <FormEditorSkeleton />;
  }

  // ==========================================
  // 送信設定モード（全画面）
  // ==========================================

  if (viewMode === 'send') {
    return (
      <div className="h-full w-full flex bg-blue-50 overflow-hidden animate-in fade-in duration-300">
        <div className="hidden md:block flex-[1.5] h-full overflow-y-auto shadow-xl z-10 bg-blue-50 border-r border-gray-200">
          <FormAnswerUI
            title={title}
            description={description}
            questions={questions}
            answers={testAnswers}
            onAnswerChange={(qid, val) => setTestAnswers(prev => ({ ...prev, [qid]: val }))}
            onSubmit={() => showFeedback("これはプレビューです。設定を完了して送信してください。", { type: 'info', mode: 'toast' })}
            mode="preview"
            onClearAnswers={clearAnswers}
            timezone={currentTimezone}
            onTimezoneChange={setCurrentTimezone}
            formId={formId}
          />
        </div>

        {/* 右側：送信設定パネル */}
        <div className="flex-1 h-full">
          <SendSettings
            onBackToEdit={() => setViewMode('edit')}
            isPublished={formStatus === 'published'}
            initialAssignedUsers={currentAssignedUsers}
            initialDueDate={currentDueDate}
            initialIsAnonymous={currentIsAnonymous}
            initialAllowMultipleResponses={currentAllowMultiple}
            initialAllowEditResponses={currentAllowEdit}
            initialTimezone={currentTimezone}
            onSend={handlePublish}
          />
        </div>
      </div>
    );
  }

  // ==========================================
  // 共通ツールバー（edit / preview / responses で共有）
  // ==========================================

  const toolbar = (
    <div className="bg-white border-b border-gray-200 px-4 md:px-6 py-0 flex items-stretch justify-between sticky top-0 z-50 shadow-sm flex-shrink-0 h-14">

      {/* 左側: 戻るボタン ＆ フォーム名 */}
      <div className="flex items-center gap-3 min-w-0 flex-1 pr-5">
        <button
          onClick={() => navigate('/form-list')}
          className="flex flex-col items-center px-2 py-1 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors flex-shrink-0"
          title="フォーム一覧へ戻る"
        >
          <FileText className="w-5 h-5" />
          <span className="text-[8px] font-medium text-gray-400 leading-none mt-0.5">フォーム一覧</span>
        </button>
        <span className="hidden md:block font-bold text-gray-800 truncate md:text-lg">
          {title || '無題のフォーム'}
        </span>
      </div>

      {/* 中央: 質問 / 回答 タブ (Google Forms風) */}
      <div className="flex items-stretch gap-0 h-full flex-shrink-0">
        {/* 「質問」タブ */}
        <button
          onClick={() => setViewMode(viewMode === 'preview' ? 'preview' : 'edit')}
          className={`
            px-6 text-sm font-bold border-b-2 transition-all duration-200
            ${isEditorMode
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }
          `}
        >
          質問
        </button>

        {/* 「回答」タブ */}
        <button
          onClick={() => setViewMode('responses')}
          className={`
            px-5 text-sm font-bold border-b-2 transition-all duration-200 flex items-center gap-1.5
            ${isResponsesMode
              ? 'border-purple-600 text-purple-700'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }
          `}
        >
          回答
          {responseCount !== null && responseCount > 0 && (
            <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded-full min-w-[18px] text-center leading-none ${isResponsesMode ? 'bg-purple-200 text-purple-800' : 'bg-gray-200 text-gray-600'
              }`}>
              {responseCount}
            </span>
          )}
        </button>
      </div>

      {/* 右側: 保存ステータス ＆ アクションボタン（質問モードの時だけ表示） */}
      <div className="flex items-center gap-3 md:gap-5 flex-1 justify-end min-w-0 pl-5">
        {isEditorMode && (
          <>
            <div className="hidden md:block text-xs font-medium truncate text-right">
              {isSaving ? (
                <span className="flex items-center gap-1 text-gray-500 justify-end"><span className="animate-spin text-blue-500">⏳</span> 保存中...</span>
              ) : saveBlocked ? (
                <button
                  onClick={handleShowErrors}
                  className="flex items-center gap-1 text-orange-500 font-bold hover:text-orange-600 transition-colors"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />不備あり
                </button>
              ) : lastSavedTime ? (
                <span className="text-green-600">✓ {lastSavedTime.toLocaleTimeString()}に保存</span>
              ) : (
                <span className="text-gray-500">自動保存されます</span>
              )}
            </div>

            <div className="hidden md:block w-px h-6 bg-gray-200" />

            {/* アクションボタン群 */}
            <div className="flex items-center gap-1 md:gap-2">
              <button
                onClick={() => setViewMode(viewMode === 'preview' ? 'edit' : 'preview')}
                className={`flex p-2 rounded-full transition-colors ${viewMode === 'preview' ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}
                title="プレビュー"
              >
                <Eye className="w-5 h-5" />
              </button>

              {formStatus === 'published' && (
                <button
                  onClick={() => openRespondentsModal('non')}
                  className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
                  title="未回答者 / 回答済み"
                >
                  <Users className="w-5 h-5" />
                </button>
              )}

              <button
                onClick={() => {
                  const hasErrors = handleShowErrors();
                  if (!hasErrors) {
                    setViewMode('send');
                  }
                }}
                className={`p-2 md:px-4 py-2 rounded-lg font-bold flex items-center gap-2 transition-colors shadow-sm text-white text-sm whitespace-nowrap ${formStatus === 'published' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                {formStatus === 'published' ? (
                  <>
                    <Globe className="w-4 h-4 md:w-5 md:h-5 lg:w-4 lg:h-4" />
                    <span className="hidden lg:inline">公開済み</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 md:w-5 md:h-5 lg:w-4 lg:h-4" />
                    <span className="hidden lg:inline">送信</span>
                  </>
                )}
              </button>
            </div>
          </>
        )}

        {/* 回答モードの時のみ: 保存ステータスを薄く表示 */}
        {isResponsesMode && (
          <div className="hidden md:block text-xs font-medium text-gray-400">
            {isSaving ? '保存中...' : lastSavedTime ? `✓ 保存済み` : ''}
          </div>
        )}
      </div>
    </div>
  );

  // ==========================================
  // 未回答者 / 回答済みモーダル
  // ==========================================

  const respondentsModalJSX = respondentsModal && (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setRespondentsModal(false)}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>

        {/* ヘッダー */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setRespondentsTab('non')}
              className={`px-4 py-1.5 rounded-md text-sm font-bold transition-colors ${respondentsTab === 'non' ? 'bg-white shadow text-orange-600' : 'text-gray-500 hover:text-gray-700'}`}
            >
              未回答者 {!isRespondentsLoading && `(${nonRespondents.length})`}
            </button>
            <button
              onClick={() => setRespondentsTab('done')}
              className={`px-4 py-1.5 rounded-md text-sm font-bold transition-colors ${respondentsTab === 'done' ? 'bg-white shadow text-green-600' : 'text-gray-500 hover:text-gray-700'}`}
            >
              回答済み {!isRespondentsLoading && `(${respondents.length})`}
            </button>
          </div>
          <button onClick={() => setRespondentsModal(false)} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* リスト */}
        <div className="overflow-y-auto flex-1 p-4">
          {isRespondentsLoading ? (
            <div className="space-y-3 animate-pulse">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-gray-200 flex-shrink-0" />
                  <div className="space-y-1.5 flex-1">
                    <div className="h-3.5 bg-gray-200 rounded w-1/2" />
                    <div className="h-3 bg-gray-100 rounded w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : respondentsTab === 'non' ? (
            nonRespondents.length === 0 ? (
              <div className="py-10 text-center text-gray-400 text-sm">全員が回答済みです 🎉</div>
            ) : (
              <ul className="space-y-1">
                {nonRespondents.map((m: any) => (
                  <li key={m.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-gray-50">
                    <div className="w-9 h-9 rounded-full overflow-hidden bg-blue-100 flex-shrink-0 flex items-center justify-center text-blue-700 font-bold text-sm">
                      {m.avatar_link ? <img src={m.avatar_link} className="w-full h-full object-cover" alt="" /> : m.name_english?.charAt(0)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-800">{m.name_english}</p>
                      {m.name_kanji && <p className="text-xs text-gray-400">{m.name_kanji}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : (
            respondents.length === 0 ? (
              <div className="py-10 text-center text-gray-400 text-sm">まだ回答がありません</div>
            ) : (
              <ul className="space-y-1">
                {respondents.map((r: any) => (
                  <li key={r.id} className="flex items-center gap-3 p-2 rounded-xl hover:bg-gray-50">
                    <div className="w-9 h-9 rounded-full overflow-hidden bg-green-100 flex-shrink-0 flex items-center justify-center text-green-700 font-bold text-sm">
                      {r.is_anonymous ? '?' : r.avatar_link ? <img src={r.avatar_link} className="w-full h-full object-cover" alt="" /> : r.name_english?.charAt(0)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-800">{r.is_anonymous ? '匿名' : r.name_english}</p>
                      {!r.is_anonymous && r.name_kanji && <p className="text-xs text-gray-400">{r.name_kanji}</p>}
                      {r.submitted_at && <p className="text-xs text-gray-400">{new Date(r.submitted_at).toLocaleDateString()}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </div>
    </div>
  );

  // ==========================================
  // 回答閲覧モード
  // ==========================================

  if (isResponsesMode) {
    return (
      <>
        <div className="h-full w-full bg-gray-50 flex flex-col overflow-hidden animate-in fade-in duration-200">
          {toolbar}
          <FormResponsesView formId={formId} />
        </div>
        {respondentsModalJSX}
      </>
    );
  }

  // ==========================================
  // 通常編集モード（edit / preview）
  // ==========================================

  return (
    <div className="h-full w-full bg-blue-50 flex flex-col overflow-hidden">

      <DragDropContext
        onDragEnd={handleDragEnd}
      >
        {toolbar}

        {/* --- メインエリア (分割対応) --- */}
        <div className="flex-1 flex overflow-hidden relative">

          {/* 左側のペイン：編集画面 */}
          <div
            ref={editorScrollRef}
            onScroll={handleEditorScroll}
            onMouseEnter={() => scrollingPane.current = 'editor'}
            className={`
            flex-1 overflow-y-auto transition-all duration-500
            ${viewMode === 'preview' ? 'hidden md:block md:flex-[1.2]' : 'block'}
          `}
          >
            <div className="py-10 flex flex-col items-center pb-48">
              <div className={`w-full px-4 ${viewMode === 'preview' ? 'md:max-w-[80%]' : 'md:max-w-[80%] lg:max-w-3xl'}`}>

                <TitleBox
                  title={title}
                  description={description}
                  onTitleChange={handleTitleChange}
                  onDescriptionChange={handleDescriptionChange}
                />

                <Droppable droppableId="questions-list" type="questions">
                  {(provided) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className="space-y-0"
                    >
                      {questions.map((question, index) => (
                        <Draggable key={question.id} draggableId={question.id} index={index}>
                          {(dragProvided, snapshot) => (
                            <div
                              ref={dragProvided.innerRef}
                              {...dragProvided.draggableProps}
                              className={`w-full relative ${snapshot.isDragging ? 'z-50' : ''}`}
                            >
                              {/* 並べ替え中はインサート用の仕切りを隠す */}
                              {!isSortingQuestions && (
                                <InsertDivider onInsert={() => insertQuestionAt(index)} />
                              )}
                              <div
                                id={`box-${question.id}`}
                                onClick={() => setActiveQuestionId(question.id)}
                                className="w-full relative"
                              >
                                <QuestionBox
                                  question={question}
                                  isActive={activeQuestionId === question.id}
                                  isSortingGlobal={isSortingQuestions}
                                  isDragging={snapshot.isDragging || sortingQuestionId === question.id}
                                  dragHandleProps={dragProvided.dragHandleProps}
                                  onStartSorting={() => handleStartSorting(question.id)}
                                  onCancelSorting={() => { setIsSortingQuestions(false); setSortingQuestionId(null); }}
                                  onChange={(updates) => handleQuestionChange(question.id, updates)}
                                  onDelete={() => deleteQuestion(question.id)}
                                  formTimezone={currentTimezone}
                                />
                              </div>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>

                {!isSortingQuestions && (
                  <div className="flex justify-center mt-8">
                    <button
                      onClick={() => insertQuestionAt(questions.length)}
                      className="w-14 h-14 bg-white rounded-full shadow-md flex items-center justify-center text-blue-600 hover:bg-blue-600 hover:text-white transition-all transform hover:scale-110 border border-gray-100"
                      title="一番下に質問を追加"
                    >
                      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* --- 左側ペインここまで --- */}

          {/* 右側のペイン：プレビューの時だけ表示 */}
          {viewMode === 'preview' && (
            <div
              ref={previewScrollRef}
              onScroll={handlePreviewScroll}
              onMouseEnter={() => scrollingPane.current = 'preview'}
              className="w-full lg:w-[45%] h-full relative animate-in lg:slide-in-from-right duration-300 bg-blue-50 overflow-y-auto lg:border-l border-gray-200 shadow-inner"
            >
              <FormAnswerUI
                title={title}
                description={description}
                questions={questions}
                answers={testAnswers}
                onAnswerChange={(qid, val) => setTestAnswers(prev => ({ ...prev, [qid]: val }))}
                onSubmit={(_) => {
                  showFeedback("プレビュー送信テスト:\n" + JSON.stringify(testAnswers, null, 2), { mode: 'splash', emoji: '🧪' });
                }}
                mode="preview"
                onOpenFullScreen={openFullPreview}
                onClearAnswers={clearAnswers}
                timezone={currentTimezone}
                onTimezoneChange={setCurrentTimezone}
              />
            </div>
          )}

        </div>
      </DragDropContext>
      {respondentsModalJSX}
    </div>
  );
}