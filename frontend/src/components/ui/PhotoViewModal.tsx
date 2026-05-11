import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useNavigate } from 'react-router-dom';
import { API_BASE_URL } from '../../config';
import PhotoEditModal from './PhotoEditModal';
import { Sparkles, FileText, ChevronDown, ChevronUp } from 'lucide-react';

type Props = {
  isOpen: boolean;
  imageUrl: string | null;
  onClose: () => void;
  description?: string | null;
  isOwner?: boolean; // 自分が投稿した写真かどうか
  photo?: {
    id: string;
    image_type: string | null;
    visibility: string;
    description: string | null;
    description_generated?: string[] | null;
    view_url: string;
    basic_profile_info?: {
      id: string;
      name_kanji: string | null;
      name_english: string | null;
      avatar_url?: string | null;
    } | null;
  } | null;
  onPhotoUpdated?: () => void;
  onPhotoDeleted?: () => void;
};

export default function PhotoViewModal({ isOpen, imageUrl, onClose, description, isOwner, photo, onPhotoUpdated, onPhotoDeleted }: Props) {
  const navigate = useNavigate();
  
  // 編集モーダルと削除確認モーダルの状態
  const [isVisible, setIsVisible] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showAIDesc, setShowAIDesc] = useState(false);

  // stale closure を防ぐため、最新の onClose を ref で保持する
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // モーダルの開閉に応じて URL ハッシュと body スクロールを制御する
  useEffect(() => {
    if (isOpen) {
      setIsVisible(true);
      setShowAIDesc(false); // 新しい写真を開くときはAI解説を閉じておく
      document.body.style.overflow = 'hidden';

      // まだ #photo が付いていない場合のみ履歴を積む
      if (window.location.hash !== '#photo') {
        window.history.pushState(
          { modal: 'photoView' },
          '',
          window.location.pathname + window.location.search + '#photo'
        );
      }
    } else {
      setIsVisible(false);
      document.body.style.overflow = 'unset';
    }

    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  // 戻るボタン（popstate）でモーダルを閉じる
  useEffect(() => {
    const handlePopState = () => {
      // ハッシュが #photo でなくなったら閉じる
      if (window.location.hash !== '#photo') {
        onCloseRef.current();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []); // 依存配列は空 → マウント時に1回だけ登録し、ref で最新の onClose を参照

  // × ボタン: ハッシュを外すだけ（popstate が発火して上の処理で onClose が呼ばれる）
  const handleCloseButton = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.location.hash === '#photo') {
      // history.back() は使わず、ハッシュだけ書き換える
      // → 前のページに飛ばずに、popstate だけ発火させる
      window.history.back();
    } else {
      onCloseRef.current();
    }
  };

  const handleDeleteConfirm = async () => {
    if (!photo) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('認証トークンがありません');

      const response = await fetch(`${API_BASE_URL}/api/gallery/${photo.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '削除に失敗しました');
      }

      setIsDeleteConfirmOpen(false);
      if (onPhotoDeleted) onPhotoDeleted();
      onClose(); // モーダルも閉じる
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : '削除に失敗しました');
    } finally {
      setIsDeleting(false);
    }
  };

  if (!isOpen || !imageUrl) return null;

  return (
    // 背景クリックは何もしない
    <div
      className={`fixed inset-0 z-[100] bg-white/95 backdrop-blur-sm transition-opacity duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* 1. 閉じるボタン (スクロール層の外に配置して完全に固定) */}
      <button
        onClick={handleCloseButton}
        className="fixed top-6 right-6 p-2 bg-gray-100/50 hover:bg-gray-200 rounded-full text-gray-600 transition-colors z-[120] shadow-sm backdrop-blur-md"
        aria-label="閉じる"
      >
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* 2. スクロール可能なエリア */}
      <div
        onClick={handleCloseButton}
        className="fixed inset-0 overflow-y-auto cursor-pointer flex flex-col items-center p-6 md:p-12 lg:p-20"
      >
        {/* 3. 画像・コンテンツ本体 (my-auto で中央配置を実現) */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-4xl my-auto flex flex-col items-center animate-in zoom-in-95 duration-300 group cursor-default"
        >
          <div className="relative flex-shrink-0">
            <img
              src={imageUrl}
              alt="View"
            className="max-w-full max-h-[65vh] object-contain rounded-lg shadow-2xl"
          />

          {/* 自分の写真の場合のみ、編集・削除ボタンを表示（スマホは常時、PCはホバー時） */}
          {isOwner && (
            <div className="absolute top-4 right-4 flex items-center gap-2 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200">
              {/* 編集ボタン */}
              <button
                onClick={() => setIsEditModalOpen(true)}
                className="p-2 bg-white/90 hover:bg-white text-blue-600 rounded-lg shadow-sm backdrop-blur-sm transition-colors"
                title="編集"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              {/* 削除ボタン */}
              <button
                onClick={() => setIsDeleteConfirmOpen(true)}
                className="p-2 bg-white/90 hover:bg-white text-red-600 rounded-lg shadow-sm backdrop-blur-sm transition-colors"
                title="削除"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* 投稿者情報タイル（写真の下、説明文の上） */}
        {photo?.basic_profile_info && (
          <div 
            onClick={(e) => {
              e.stopPropagation();
              onClose(); // モーダルを閉じる
              navigate(`/members/${photo.basic_profile_info?.id}`);
            }}
            className="mt-4 flex items-center gap-3 bg-white/60 backdrop-blur-md px-4 py-2.5 rounded-2xl border border-white/40 shadow-sm hover:bg-white/80 hover:shadow-md hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer group/tile"
          >
            <div className="w-8 h-8 rounded-full overflow-hidden bg-gray-200 border-2 border-white shadow-sm flex-shrink-0">
              <img
                src={photo.basic_profile_info.avatar_url || '/assets/images/profile_photo_empty.png'}
                alt=""
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = '/assets/images/profile_photo_empty.png';
                }}
              />
            </div>
            <div className="flex flex-col">
              <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider leading-none mb-0.5 group-hover/tile:text-blue-500 transition-colors">Uploaded by</span>
              <span className="text-sm font-bold text-gray-700 leading-none group-hover/tile:text-blue-600 transition-colors">
                {photo.basic_profile_info.name_english || photo.basic_profile_info.name_kanji || 'Unknown'}
              </span>
            </div>
          </div>
        )}

        {/* 説明文 */}
        {(description || (photo?.description_generated && photo.description_generated.length > 0)) && (
          <div className="mt-4 w-full max-w-2xl bg-white/80 backdrop-blur-md rounded-2xl shadow-sm border border-white/40 overflow-hidden">
            {/* ユーザー説明文 & AI切り替えボタン */}
            <div className="flex items-center justify-between px-5 py-3 gap-4">
              <p className="flex-1 text-gray-800 font-bold text-base text-left">
                {description || 'No description'}
              </p>
              
              {photo?.description_generated && photo.description_generated.length > 0 && (
                <button
                  onClick={() => setShowAIDesc(!showAIDesc)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl transition-all duration-300 flex-shrink-0 ${
                    showAIDesc 
                      ? 'bg-blue-500 text-white shadow-md' 
                      : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                  }`}
                  title="AIによる詳細解説を表示"
                >
                  <Sparkles className={`w-4 h-4 ${showAIDesc ? 'animate-pulse' : ''}`} />
                  <span className="text-[11px] font-bold uppercase tracking-wider">AI Analysis</span>
                  {showAIDesc ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
              )}
            </div>

            {/* AI詳細解説（アコーディオン） */}
            {showAIDesc && photo?.description_generated && (
              <div className="px-5 pb-5 pt-1 animate-in slide-in-from-top-2 duration-300">
                <div className="p-4 bg-blue-50/50 rounded-xl border border-blue-100/50 space-y-2">
                  {photo.description_generated.map((line, idx) => (
                    <div key={idx} className="flex gap-2 text-sm text-gray-700 leading-relaxed">
                      <span className="text-blue-400 font-bold shrink-0">•</span>
                      <p>{line}</p>
                    </div>
                  ))}
                  <div className="pt-2 flex justify-end">
                    <span className="text-[9px] text-blue-300 font-bold uppercase tracking-widest flex items-center gap-1">
                      Powered by Gemini 3.1 Flash
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div> {/* 3. Content Wrapper */}
    </div> {/* 2. Scrollable Area */}

      {/* 削除確認モーダル */}
      {isDeleteConfirmOpen && (
        <div 
          onClick={(e) => {
            e.stopPropagation();
            setIsDeleteConfirmOpen(false);
          }}
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200 cursor-pointer"
        >
          <div 
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden flex flex-col p-6 text-center cursor-default"
          >
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
              <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-2">削除しますか？</h3>
            <div className="mt-2 text-sm text-gray-500 mb-6 text-left space-y-2">
              <p>この操作は取り消せません。</p>
              <p>写真データは完全に削除され、このアプリ内で使われているすべての場所から消去されます。</p>
            </div>
            
            {deleteError && (
              <p className="text-red-500 text-sm mb-4">{deleteError}</p>
            )}

            <div className="flex gap-3 justify-center">
              <button
                type="button"
                className="w-full inline-flex justify-center rounded-xl border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:text-sm transition-colors"
                onClick={() => setIsDeleteConfirmOpen(false)}
                disabled={isDeleting}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="w-full inline-flex justify-center rounded-xl border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 sm:text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed items-center gap-2"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    削除中...
                  </>
                ) : (
                  '削除する'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 編集モーダル */}
      <PhotoEditModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        photo={photo ?? null}
        onSuccess={() => {
          if (onPhotoUpdated) onPhotoUpdated();
          onClose(); // 更新後、表示用モーダルも閉じるか、そのままにするか。今回は閉じる。
        }}
      />
    </div>
  );
}
