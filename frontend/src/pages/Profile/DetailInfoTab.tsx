import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../../config';

type Props = {
  userId?: string;
  isEditable?: boolean;
};

// --- アイコン群 ---
function DocumentIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
      <polyline points="10 9 9 9 8 9"></polyline>
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-30 flex-shrink-0">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// --- セクションタイトル ---
function SectionTitle({ title }: { title: string }) {
  return (
    <h3 className="text-[10px] font-semibold tracking-widest uppercase text-gray-400 mt-8 mb-2 px-3 pb-2 border-b border-gray-100 first:mt-0">
      {title}
    </h3>
  );
}

// --- 📱 レスポンシブ対応の回答行コンポーネント ---
function FormResponseRow({ response, onClick }: { response: any, onClick: () => void }) {
  // 提出日のフォーマット (例: 2026/04/24)
  const date = new Date(response.submitted_at);
  const formattedDate = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;

  return (
    <div
      onClick={onClick}
      className="group flex px-3 py-3 md:py-4 border-b border-gray-100 transition-colors cursor-pointer hover:bg-blue-50 items-center"
    >
      <div className="mr-3 md:mr-4 flex-shrink-0 bg-blue-100 p-2 rounded-lg">
        <DocumentIcon />
      </div>

      {/* 🌟 スマホの時は縦、PCの時は横並び */}
      <div className="flex-1 flex flex-col md:flex-row md:items-center min-w-0 gap-1 md:gap-4">
        {/* 左側：フォームのタイトル */}
        <span className="text-[13px] md:text-[14px] font-bold text-gray-800 w-full md:w-2/3 flex-shrink-0 truncate group-hover:text-blue-700 transition-colors">
          {response.form_title}
        </span>

        {/* 右側：提出日 */}
        <div className="flex-1 w-full pl-0 md:pl-2 text-gray-400 text-[11px] md:text-[12px] font-medium">
          Submitted: {formattedDate}
        </div>
      </div>

      <div className="flex items-center ml-2 flex-shrink-0 transition-transform group-hover:translate-x-1">
        <ChevronRightIcon />
      </div>
    </div>
  );
}

// --- メインコンポーネント ---
export default function DetailInfoTab({ userId, isEditable = false }: Props) {
  const navigate = useNavigate();
  console.log(`TODO: Use isEditable: ${isEditable} later`)
  const [responses, setResponses] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!userId) return;

    const fetchResponses = async () => {
      try {
        setIsLoading(true);
        // 新しく作成したバックエンドAPIを叩く
        const res = await fetch(`${API_BASE_URL}/api/users/${userId}/form-responses`);
        const data = await res.json();
        setResponses(data || []);
      } catch (error) {
        console.error('フォーム回答の取得エラー:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchResponses();
  }, [userId]);

  const handleRowClick = (responseId: string) => {
    navigate(`/form-responses/${responseId}`);
  };

  return (
    <div className="w-full px-4 md:px-6 py-6 pb-20">
      <SectionTitle title="Submitted Forms" />

      {isLoading ? (
        <div className="px-3 py-6 text-sm text-gray-400 animate-pulse">Loading responses...</div>
      ) : responses.length === 0 ? (
        <div className="px-3 py-8 text-center bg-gray-50 rounded-xl border border-gray-100">
          <DocumentIcon />
          <p className="text-sm text-gray-500 mt-2">まだ回答したフォームはありません。</p>
        </div>
      ) : (
        <div className="flex flex-col">
          {responses.map((res) => (
            <FormResponseRow
              key={res.id}
              response={res}
              onClick={() => handleRowClick(res.id)}
            />
          ))}
        </div>
      )}

      <div className="h-16" />
    </div>
  );
}