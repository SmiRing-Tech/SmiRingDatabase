// src/components/Answer/FormAnswerPage.tsx

import { useEffect, useState } from 'react';
import { useFeedback } from '../../../context/FeedbackContext';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import type { QuestionData } from '../FormEditor/FormEditorPage';
import FormAnswerUI from './components/FormAnswerUI';
import { supabase } from '../../../lib/supabase';
import { CheckCircle2, Home, Edit2, PlusCircle } from 'lucide-react';
import { API_BASE_URL } from '../../../config';

export default function FormAnswerPage() {
  const { showFeedback } = useFeedback();
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPreviewMode = searchParams.get('mode') === 'preview';
  const currentMode = isPreviewMode ? 'preview' : 'live';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [questions, setQuestions] = useState<QuestionData[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(true);
  
  // 🌟 新しいステート群
  const [isSubmitted, setIsSubmitted] = useState(false);       // 今回送信成功したか
  const [isSaving, setIsSaving] = useState(false);             // 自動保存中か
  const [lastSavedTime, setLastSavedTime] = useState<Date | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [timezone, setTimezone] = useState<string>('Asia/Tokyo');

  // 🌟 複数回答・編集のための追加ステート
  const [responseId, setResponseId] = useState<string | null>(null);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [allowEdit, setAllowEdit] = useState(true);
  const [guardState, setGuardState] = useState<'none' | 'blocked' | 'choice'>('none');
  const [pastResponses, setPastResponses] = useState<any[]>([]);

  // 1. フォームデータ ＆ 自分の回答状況の取得
  const cleanAnswers = (qs: QuestionData[], rawAns: Record<string, any>) => {
    let isChanged = false;
    const cleaned: Record<string, any> = {};

    Object.entries(rawAns).forEach(([qId, ans]) => {
      if (ans === undefined || ans === null) return;
      const q = qs.find(q => q.id === qId);
      if (!q) { isChanged = true; return; }

      if (q.type === 'radio' || q.type === 'dropdown') {
        if (!q.options.some(opt => opt.text === ans)) isChanged = true;
        else cleaned[qId] = ans;
      } else if (q.type === 'checkbox') {
        if (Array.isArray(ans)) {
          const filtered = ans.filter(val => q.options.some(opt => opt.text === val));
          if (filtered.length !== ans.length) isChanged = true;
          if (filtered.length > 0) cleaned[qId] = filtered;
        } else { isChanged = true; }
      } else if (q.type === 'grid_radio') {
        const newGridAns: Record<string, any> = {};
        const validRows = new Set(q.gridRows.map(r => r.text));
        const validCols = new Set(q.gridCols.map(c => c.text));
        let gridChanged = false;
        
        Object.entries(ans).forEach(([row, col]) => {
          if (validRows.has(row)) {
            if (typeof col === 'string' && validCols.has(col)) {
              newGridAns[row] = col;
            } else if (Array.isArray(col)) {
              const fCol = col.filter((c: any) => validCols.has(c));
              if (fCol.length > 0) newGridAns[row] = fCol;
              if (fCol.length !== col.length) gridChanged = true;
            } else { gridChanged = true; }
          } else { gridChanged = true; }
        });
        if (gridChanged) isChanged = true;
        if (Object.keys(newGridAns).length > 0) cleaned[qId] = newGridAns;
      } else {
        cleaned[qId] = ans;
      }
    });
    return { cleaned, isChanged };
  };

  const loadAnswersWithCleanup = (rawAns: Record<string, any>, qs: QuestionData[] = questions) => {
    const { cleaned, isChanged } = cleanAnswers(qs, rawAns || {});
    setAnswers(cleaned);
    if (isChanged) setHasUnsavedChanges(true);
  };

  useEffect(() => {
    const fetchAllData = async () => {
      if (!id) return;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const userId = session?.user?.id;

        // 🌟 修正：Promise.all を使って並列でリクエストを投げる
        const [formRes, draftRes] = await Promise.all([
          fetch(`${API_BASE_URL}/api/forms/${id}`),
          userId && !isPreviewMode 
            ? fetch(`${API_BASE_URL}/api/forms/${id}/my-responses`, {
                headers: { 'Authorization': `Bearer ${session.access_token}` }
              })
            : Promise.resolve(null)
        ]);

        if (!formRes.ok) throw new Error('フォームの取得に失敗しました');
        const formData = await formRes.json();
        
        let pResponses = [];
        if (draftRes && draftRes.ok) {
          pResponses = await draftRes.json();
        }

        // 1. まずフォームの基本情報をセット
        setTitle(formData.title || '');
        setDescription(formData.description || '');
        setTimezone(formData.timezone || 'Asia/Tokyo');
        // 削除済みでない質問のみを表示し、UI用のIDを付与する
        const filteredQuestions = (formData.questions || []).filter((q: any) => !q.isDeleted);
        const mappedQuestions = filteredQuestions.map((q: any) => ({
          ...q,
          options: Array.isArray(q.options) 
            ? q.options.map((c: any) => typeof c === 'string' ? { id: crypto.randomUUID(), text: c } : c)
            : [],
          gridRows: Array.isArray(q.gridRows)
            ? q.gridRows.map((r: any) => typeof r === 'string' ? { id: crypto.randomUUID(), text: r } : r)
            : [],
          gridCols: Array.isArray(q.gridCols)
            ? q.gridCols.map((c: any) => typeof c === 'string' ? { id: crypto.randomUUID(), text: c } : c)
            : []
        }));
        setQuestions(mappedQuestions);
        
        const allowMult = formData.allow_multiple_responses || false;
        const allowEd = formData.allow_edit_responses !== false; // default true
        setAllowMultiple(allowMult);
        setAllowEdit(allowEd);

        setPastResponses(pResponses);
        
        const hasSubmitted = pResponses.some((r: any) => r.status === 'submitted');
        const latestDraft = pResponses.find((r: any) => r.status === 'draft');

        if (latestDraft) {
          // 🌟 最優先：書きかけの下書きがある場合は即座に読み込む
          setResponseId(latestDraft.id);
          loadAnswersWithCleanup(latestDraft.content, mappedQuestions);
        } else if (hasSubmitted) {
          // 下書きがなく、送信済みがある場合のみ選択画面かブロックを表示
          if (allowMult || allowEd) {
            setGuardState('choice');
          } else {
            setGuardState('blocked');
          }
        }


      } catch (error) {
        console.error('読み込み失敗:', error);
      } finally {
        // 🌟 最後に1回だけLoadingを解除する
        setIsLoading(false);
      }
    };
    fetchAllData();
  }, [id, isPreviewMode]);

  // 🌟 2. 自動保存（下書き）のロジック
  useEffect(() => {
    // プレビューモード、未変更、またはすでに送信済み（編集不可/新規作成中ではない）の場合は自動保存しない
    // ガード画面（choice/blocked）の間も保存しない
    // さらに、既に「提出済み（submitted）」の回答を編集している場合も自動保存をスキップする
    const isEditingSubmittedResponse = pastResponses.find(r => r.id === responseId)?.status === 'submitted';
    if (isPreviewMode || !hasUnsavedChanges || isSubmitted || guardState !== 'none' || isEditingSubmittedResponse) return;

    // ユーザーの入力が止まってから1.5秒後に保存を走らせる
    const timer = setTimeout(async () => {
      setIsSaving(true);
      setHasUnsavedChanges(false); // 次の変更が来るまでフラグをオフ

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.user?.id) return; // 匿名の場合は下書き保存スキップ（必要に応じて調整）

        const res = await fetch(`${API_BASE_URL}/api/forms/${id}/responses/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
          },
          body: JSON.stringify({
            response_id: responseId,
            content: answers,
          })
        });

        if (res.ok) {
          const resData = await res.json();
          if (resData.response_id && !responseId) {
            setResponseId(resData.response_id); // 新規下書き時にIDをセット
          }
          setLastSavedTime(new Date());
        }
      } catch (err) {
        console.error('自動保存エラー:', err);
      } finally {
        setIsSaving(false);
      }
    }, 1500);

    return () => clearTimeout(timer); // 1.5秒以内に入力があったらタイマーをキャンセル
  }, [answers, hasUnsavedChanges, id, isPreviewMode, isSubmitted, guardState, responseId]);


  // 3. 送信ボタンを押した時のメイン処理
  const handleSubmit = async (turnstileToken: string, finalAnswers?: Record<string, any>) => {
    const answersToSubmit = finalAnswers || answers;
    if (isPreviewMode) {
      showFeedback('👀 プレビューモードのため送信されません。\n\n【回答データ】\n' + JSON.stringify(answersToSubmit, null, 2), { type: 'info', mode: 'toast', duration: 6000 });
      return;
    }

    setIsLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      const response = await fetch(`${API_BASE_URL}/api/forms/${id}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`
        },
        body: JSON.stringify({
          response_id: responseId,
          answers: answersToSubmit,
          turnstileToken,
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '送信に失敗しました');
      }

      showFeedback('回答ありがとうございました！', { mode: 'splash', type: 'success', emoji: '🎉' });
      setIsSubmitted(true);
    } catch (err: any) {
      showFeedback(err.message || 'エラーが発生しました。もう一度お試しください。', { type: 'error', mode: 'banner' });
    } finally {
      setIsLoading(false);
    }
  };


  const handleEditChoice = () => {
    const latestResponse = pastResponses.find(r => r.status === 'draft') || pastResponses.find(r => r.status === 'submitted');
    if (latestResponse) {
      setResponseId(latestResponse.id);
      loadAnswersWithCleanup(latestResponse.content);
    }
    setGuardState('none');
  };

  const handleNewChoice = () => {
    setResponseId(null);
    setAnswers({});
    setGuardState('none');
  };

  // ----------------------------------------------------
  // UIのレンダリング
  // ----------------------------------------------------

  // 🌟 A-1. ガード画面: 選択画面 (Edit or New)
  if (guardState === 'choice') {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-gray-50 p-6">
        <div className="bg-white p-10 rounded-3xl shadow-xl text-center max-w-md">
          <div className="w-20 h-20 bg-blue-100 text-blue-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-12 h-12" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">すでに回答済みです</h2>
          <p className="text-gray-500 mb-8 leading-relaxed whitespace-pre-wrap">
            {allowEdit && allowMultiple 
              ? "このフォームは回答の編集と\n複数回の回答が許可されています。"
              : allowEdit 
                ? "以前の回答を編集することができます。"
                : "このフォームは複数回の回答が可能です。"}
          </p>
          <div className="flex flex-col gap-3">
            {allowEdit && (
              <button 
                onClick={handleEditChoice}
                className="w-full py-4 bg-gray-800 text-white rounded-xl font-bold hover:bg-gray-900 transition-all shadow-md flex items-center justify-center gap-2"
              >
                <Edit2 className="w-5 h-5" />
                前回の回答を編集する
              </button>
            )}
            {allowMultiple && (
              <button 
                onClick={handleNewChoice}
                className="w-full py-4 bg-white border-2 border-gray-200 text-gray-700 rounded-xl font-bold hover:bg-gray-50 transition-all flex items-center justify-center gap-2"
              >
                <PlusCircle className="w-5 h-5" />
                新しく回答する
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 🌟 A-2. ガード画面: ブロック (Both disabled)
  if (guardState === 'blocked') {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-gray-50 p-6">
        <div className="bg-white p-10 rounded-3xl shadow-xl text-center max-w-md">
          <div className="w-20 h-20 bg-gray-100 text-gray-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-12 h-12" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">回答済みです</h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            このフォームにはすでに回答しています。<br/>重複して回答することはできません。
          </p>
          <button 
            onClick={() => navigate('/home')}
            className="w-full py-4 bg-gray-800 text-white rounded-xl font-bold hover:bg-gray-900 transition-all shadow-md flex items-center justify-center gap-2"
          >
            <Home className="w-5 h-5" />
            ホームに戻る
          </button>
        </div>
      </div>
    );
  }

  // B. 送信完了後のサンクス画面
  if (isSubmitted) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-blue-50 p-6">
        <div className="bg-white p-10 rounded-3xl shadow-xl text-center max-w-md">
          <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-12 h-12" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">回答ありがとうございました！</h2>
          <p className="text-gray-500 mb-8 leading-relaxed">
            フォームへの回答が正常に送信されました。<br/>ご協力ありがとうございました。
          </p>
          <button 
            onClick={() => navigate('/home')}
            className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg hover:shadow-blue-200 flex items-center justify-center gap-2"
          >
            <Home className="w-5 h-5" />
            ホームに戻る
          </button>
        </div>
      </div>
    );
  }

  // C. ローディング画面
  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center bg-blue-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
        <p className="text-gray-500 font-medium">読み込み中...</p>
      </div>
    );
  }

  // D. メインの回答画面
  return (
    <div className="min-h-screen w-full bg-blue-50 overflow-y-auto">
      <FormAnswerUI 
        title={title}
        description={description}
        questions={questions}
        answers={answers}
        onAnswerChange={(qid, val) => {
          setAnswers(prev => ({ ...prev, [qid]: val }));
          setHasUnsavedChanges(true); // 🌟 変更があったらフラグを立てる！
        }}
        onSubmit={handleSubmit}
        mode={currentMode}
        isLoading={isLoading}
        onClearAnswers={() => {
          if(confirm('入力内容をすべて消去しますか？')) {
            setAnswers({});
            setHasUnsavedChanges(true);
          }
        }}
        isSaving={isSaving}           // 🌟 追加
        lastSavedTime={lastSavedTime} // 🌟 追加
        timezone={timezone}
        onTimezoneChange={setTimezone}
        formId={id}
      />
    </div>
  );
}