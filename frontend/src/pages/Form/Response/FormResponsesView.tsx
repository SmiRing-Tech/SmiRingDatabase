import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import type { QuestionData } from '../FormEditor/FormEditorPage';
import type { ResponseSummary } from './types';
import SheetTab from './SheetTab';
import QuestionTab from './QuestionTab';
import IndividualTab from './IndividualTab';
import { API_BASE_URL } from '../../../config';
import { Table2, LayoutList, User as UserIcon, Inbox } from 'lucide-react';

type ResponseTab = 'sheet' | 'question' | 'individual';

const TABS: { id: ResponseTab; label: string; icon: any }[] = [
  { id: 'sheet',      label: 'シート',   icon: Table2 },
  { id: 'question',   label: '質問別',   icon: LayoutList },
  { id: 'individual', label: '個人別',   icon: UserIcon },
];

export default function FormResponsesView({ formId }: { formId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as ResponseTab) || 'sheet';

  const [isLoading, setIsLoading] = useState(true);
  const [questions, setQuestions] = useState<QuestionData[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [responses, setResponses] = useState<ResponseSummary[]>([]);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [indexMap, setIndexMap] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const fetchAll = async () => {
      setIsLoading(true);
      try {
        // 1. フォームの質問 & 匿名設定を取得
        const formRes = await fetch(`${API_BASE_URL}/api/forms/${formId}`);
        if (formRes.ok) {
          const formData = await formRes.json();
          setTitle(formData.title || '無題のフォーム');
          setDescription(formData.description || '');
          setIsAnonymous(formData.allow_anonymous ?? false);
          const mappedQuestions = (formData.questions ?? []).map((q: any) => ({
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
        }

        // 2. 回答一覧を取得（content付き、submitted_at ascending）
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const respRes = await fetch(`${API_BASE_URL}/api/forms/${formId}/responses`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        });
        if (respRes.ok) {
          const data: ResponseSummary[] = await respRes.json();
          setResponses(data);
          // 3. インデックスマップを生成（提出順 → 回答者番号）
          const map = new Map<string, number>();
          data.forEach((r, i) => map.set(r.user_id, i + 1));
          setIndexMap(map);
        }
      } catch (e) {
        console.error('Response data fetch error:', e);
      } finally {
        setIsLoading(false);
      }
    };
    fetchAll();
  }, [formId]);

  const handleTabChange = (tab: ResponseTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('mode', 'responses');
      next.set('tab', tab);
      // 他のパラメータ(questionId, userId)はタブ変更時にリセット
      next.delete('questionId');
      next.delete('userId');
      return next;
    });
  };

  const tabProps = { formId, title, description, questions, responses, indexMap, isAnonymous };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">

      {/* サブタブバー */}
      <div className="bg-white border-b border-gray-200 px-4 flex items-end justify-center gap-2 md:gap-8 flex-shrink-0">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
            className={`px-5 py-3 text-sm font-bold border-b-2 transition-all duration-200 flex items-center gap-2 ${
              activeTab === tab.id
                ? 'border-purple-600 text-purple-700'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? 'text-purple-600' : 'text-gray-400'}`} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* コンテンツエリア */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-gray-400">
            <div className="w-10 h-10 border-2 border-purple-300 border-t-purple-600 rounded-full animate-spin" />
            <p className="text-sm font-medium">回答データを読み込み中...</p>
          </div>
        </div>
      ) : responses.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-4">
          <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center text-gray-300">
            <Inbox className="w-10 h-10" />
          </div>
          <p className="text-lg font-bold text-gray-500">まだ回答がありません</p>
          <p className="text-sm">フォームを公開してメンバーに回答を依頼しましょう。</p>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          {activeTab === 'sheet'      && <SheetTab      {...tabProps} />}
          {activeTab === 'question'   && <QuestionTab   {...tabProps} />}
          {activeTab === 'individual' && <IndividualTab {...tabProps} />}
        </div>
      )}
    </div>
  );
}
