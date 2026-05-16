import { useState, useEffect } from 'react';
import FormAnswerUI from './components/FormAnswerUI';
import { API_BASE_URL } from '../../../config';
import { useFeedback } from '../../../context/FeedbackContext';
import { supabase } from '../../../lib/supabase';

const FORM_ID = 'd39c8fee-ec64-474b-bcc9-b7725607ec67';

export default function FeedbackPage() {
  const { showFeedback } = useFeedback();
  const [form, setForm] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadForm = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/forms/${FORM_ID}`);
        if (!res.ok) throw new Error('フォームの取得に失敗しました');
        const data = await res.json();
        setForm(data);
      } catch (err: any) {
        showFeedback(err.message, { type: 'error' });
      } finally {
        setIsLoading(false);
      }
    };
    loadForm();
  }, []);

  const handleSubmit = async (turnstileToken: string, finalAnswers?: Record<string, any>) => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('認証が必要です');

      const res = await fetch(`${API_BASE_URL}/api/forms/${FORM_ID}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          answers: finalAnswers || answers,
          turnstileToken
        })
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || '送信に失敗しました');
      }

      showFeedback('フィードバックを送信しました！ありがとうございます。', { type: 'success', mode: 'splash', emoji: '🎉' });
      setAnswers({}); // フォームをクリア
    } catch (err: any) {
      showFeedback(err.message, { type: 'error', mode: 'banner' });
    }
  };

  const handleClearAnswers = () => {
    setAnswers({});
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4" />
        <p className="text-gray-500 font-medium text-sm">フォームを読み込み中...</p>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <p className="text-red-500 font-medium">フォームが見つかりませんでした。</p>
      </div>
    );
  }

  return (
    <FormAnswerUI
      title={form.title}
      description={form.description}
      questions={form.questions}
      answers={answers}
      onAnswerChange={(qid, val) => setAnswers(prev => ({ ...prev, [qid]: val }))}
      onSubmit={handleSubmit}
      mode="live"
      onClearAnswers={handleClearAnswers}
      formId={FORM_ID}
    />
  );
}
