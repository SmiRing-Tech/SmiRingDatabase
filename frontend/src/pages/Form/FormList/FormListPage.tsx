import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../../lib/supabase';
import { API_BASE_URL } from '../../../config';
import { X, Users } from 'lucide-react';

export default function FormListPage() {
  const navigate = useNavigate();
  const [forms, setForms] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // モーダル
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalFormTitle, setModalFormTitle] = useState('');
  const [modalTab, setModalTab] = useState<'non' | 'done'>('non');
  const [nonRespondents, setNonRespondents] = useState<any[]>([]);
  const [respondents, setRespondents] = useState<any[]>([]);
  const [isModalLoading, setIsModalLoading] = useState(false);

  const openModal = async (e: React.MouseEvent, form: any) => {
    e.stopPropagation();
    setModalFormTitle(form.title || '無題のフォーム');
    setModalTab('non');
    setNonRespondents([]);
    setRespondents([]);
    setIsModalOpen(true);
    setIsModalLoading(true);

    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) { setIsModalLoading(false); return; }

    const [nonRes, doneRes] = await Promise.all([
      fetch(`${API_BASE_URL}/api/forms/${form.id}/non-respondents`, { headers: { 'Authorization': `Bearer ${token}` } }),
      fetch(`${API_BASE_URL}/api/forms/${form.id}/responses`, { headers: { 'Authorization': `Bearer ${token}` } }),
    ]);
    setNonRespondents(await nonRes.json());
    setRespondents(await doneRes.json());
    setIsModalLoading(false);
  };

  const handleCreateNewForm = () => {
    const newFormId = crypto.randomUUID();
    navigate(`/form-editor/${newFormId}`);
  };

  useEffect(() => {
    const fetchMyForms = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) return;
        const response = await fetch(`${API_BASE_URL}/api/my-forms`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (response.ok) setForms(await response.json());
      } catch (error) {
        console.error('フォーム一覧の取得に失敗しました:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchMyForms();
  }, []);

  return (
    <>
      <div className="min-h-full bg-gray-50 py-10 px-4 flex flex-col items-center">
        <div className="w-full max-w-3xl">

          <div className="flex justify-between items-center mb-8">
            <h1 className="text-2xl font-bold text-gray-800">マイフォーム</h1>
            <button
              onClick={handleCreateNewForm}
              className="bg-blue-600 text-white px-5 py-2.5 rounded-lg font-medium shadow-sm hover:bg-blue-700 hover:shadow transition-all flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              新規フォームを作成
            </button>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden min-h-[200px]">
            {isLoading ? (
              <ul className="divide-y divide-gray-100 animate-pulse">
                {Array.from({ length: 3 }).map((_, i) => (
                  <li key={i} className="p-4 flex justify-between items-center">
                    <div className="w-1/2 space-y-2">
                      <div className="h-5 bg-gray-200 rounded w-2/3" />
                      <div className="h-3 bg-gray-100 rounded w-1/3" />
                    </div>
                    <div className="h-6 w-16 bg-gray-200 rounded-full" />
                  </li>
                ))}
              </ul>
            ) : forms.length === 0 ? (
              <div className="py-16 text-center text-gray-400">
                <svg className="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p>まだフォームがありません。<br />右上のボタンから作成してみましょう！</p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {forms.map((form) => (
                  <li
                    key={form.id}
                    onClick={() => navigate(`/form-editor/${form.id}`)}
                    className="hover:bg-blue-50 transition-colors cursor-pointer p-4 flex justify-between items-center group"
                  >
                    <div>
                      <h3 className="font-semibold text-gray-800 group-hover:text-blue-700 transition-colors">
                        {form.title || '無題のフォーム'}
                      </h3>
                      <p className="text-sm text-gray-500 mt-1">最終更新: {new Date(form.updated_at).toLocaleDateString()}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {form.status === 'published' && (
                        <button
                          onClick={(e) => openModal(e, form)}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="回答状況を確認"
                        >
                          <Users className="w-4 h-4" />
                        </button>
                      )}
                      <div className={`font-medium text-sm px-3 py-1 rounded-full ${
                        form.status === 'published' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {form.status === 'published' ? '公開中' : '下書き'}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

        </div>
      </div>

      {/* 回答状況モーダル */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setIsModalOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>

            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setModalTab('non')}
                  className={`px-4 py-1.5 rounded-md text-sm font-bold transition-colors ${modalTab === 'non' ? 'bg-white shadow text-orange-600' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  未回答者 {!isModalLoading && `(${nonRespondents.length})`}
                </button>
                <button
                  onClick={() => setModalTab('done')}
                  className={`px-4 py-1.5 rounded-md text-sm font-bold transition-colors ${modalTab === 'done' ? 'bg-white shadow text-green-600' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  回答済み {!isModalLoading && `(${respondents.length})`}
                </button>
              </div>
              <button onClick={() => setIsModalOpen(false)} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="px-5 pt-3 text-xs text-gray-400 truncate">{modalFormTitle}</p>

            <div className="overflow-y-auto flex-1 p-4">
              {isModalLoading ? (
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
              ) : modalTab === 'non' ? (
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
      )}
    </>
  );
}
