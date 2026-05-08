import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import FormAnswerUI from '../Answer/components/FormAnswerUI';
import { API_BASE_URL } from '../../../config';

export default function FormResponseDetailPage() {
  const { responseId } = useParams();
  const navigate = useNavigate();

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [questions, setQuestions] = useState<any[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [readonlyInfo, setReadonlyInfo] = useState<{ displayName: string, submittedAt: string, avatarLink: string | null } | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const fetchDetail = async () => {
      if (!responseId) return;
      setIsLoading(true);
      setError(null);
      
      try {
        const res = await fetch(`${API_BASE_URL}/api/form-responses/${responseId}`);
        if (!res.ok) {
           if (res.status === 404) {
             throw new Error('回答が見つかりませんでした');
           }
           throw new Error('回答の詳細取得に失敗しました');
        }
        const data = await res.json();
        
        setFormTitle(data.form_title);
        setFormDescription(data.form_description);
        setUserId(data.user?.id || null);

        // 質問データのマッピング
        const mappedQuestions = (data.questions || []).map((q: any) => ({
          ...q,
          // バックエンドのキー名をフロントエンドの期待（isRequired）に合わせる
          isRequired: q.is_required,
        }));
        setQuestions(mappedQuestions);

        // 回答データの抽出
        const answersMap: Record<string, any> = {};
        mappedQuestions.forEach((q: any) => {
          if (q.answer !== undefined && q.answer !== null) {
            answersMap[q.id] = q.answer;
          }
        });
        setAnswers(answersMap);

        // 閲覧情報
        setReadonlyInfo({
          displayName: data.user?.name_english || data.user?.name_kanji || '不明なユーザー',
          submittedAt: data.submitted_at,
          avatarLink: data.user?.avatar_link || null,
        });

      } catch (err: any) {
        setError(err.message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchDetail();
  }, [responseId]);

  const handleBack = () => {
    // 履歴がある場合は戻る
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      // 直接開いた場合などは、該当ユーザーのプロフィール詳細タブへ戻る
      navigate(`/members/${userId}?tab=detail`);
    }
  };

  return (
    <div className="h-full w-full bg-blue-50 flex flex-col overflow-hidden animate-in fade-in duration-200">
      
      {/* ツールバー */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between sticky top-0 z-50 shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          <button 
            onClick={handleBack}
            className="flex items-center gap-1 px-3 py-1.5 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors font-medium text-sm"
          >
            <ChevronLeft className="w-4 h-4" />
            戻る
          </button>
          <span className="font-bold text-gray-800 truncate">
            {formTitle}
          </span>
        </div>
      </div>

      {/* メインコンテンツ */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center h-full gap-4 text-gray-400 mt-20">
             <div className="w-10 h-10 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin" />
             <p className="text-sm font-medium">回答データを読み込み中...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full mt-20 text-gray-500">
            <div className="w-16 h-16 bg-red-50 text-red-400 rounded-full flex items-center justify-center mb-4">
               ⚠️
            </div>
            <p className="font-medium text-lg text-gray-700 mb-2">エラーが発生しました</p>
            <p className="text-sm">{error}</p>
          </div>
        ) : (
          <FormAnswerUI
            title={formTitle}
            description={formDescription}
            questions={questions}
            answers={answers}
            onAnswerChange={() => {}}
            mode="readonly"
            readonlyInfo={readonlyInfo || undefined}
          />
        )}
      </div>
    </div>
  );
}
