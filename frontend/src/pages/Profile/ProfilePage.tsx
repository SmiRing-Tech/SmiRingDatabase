import { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import BasicInfoPage from './BasicInfoTab';
import DetailInfoTab from './DetailInfoTab';
import AccountSettingTab from './AccountSettingTab';
import PhotoUploadModal from '../../components/ui/PhotoUploadModal';
import PhotoViewModal from '../../components/ui/PhotoViewModal';
import { Settings, User } from 'lucide-react';
import { API_BASE_URL } from '../../config';

type GalleryItem = {
  id: string;
  storage_path: string;
  image_type: string | null;
  tags: string[];
  description: string | null;
  visibility: string;
  created_at: string;
  view_url: string;
  thumbnail_url: string;
};

export default function ProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as 'basic' | 'detail' | 'account') || 'basic';

  const setActiveTab = (tab: 'basic' | 'detail' | 'account') => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === 'basic') {
        next.delete('tab'); // デフォルトは消しておくときれい
      } else {
        next.set('tab', tab);
      }
      return next;
    }, { replace: true }); // 履歴を汚さないために replace: true
  };
  const [profileData, setProfileData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditable, setIsEditable] = useState(false);

  // ギャラリー
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [isGalleryLoading, setIsGalleryLoading] = useState(false);

  // 写真アップロードモーダル
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadModalMode, setUploadModalMode] = useState<'avatar' | 'gallery'>('avatar');

  // 写真拡大表示モーダル
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<GalleryItem | null>(null);

  const fetchProfile = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const myUserId = session?.user?.id;

      if (!token) return;

      let endpoint = '';
      let hasEditPermission = false;

      if (!id || id === myUserId) {
        endpoint = `${API_BASE_URL}/api/basic_profile_info/me`;
        hasEditPermission = true;
      } else {
        endpoint = `${API_BASE_URL}/api/basic_profile_info/${id}`;
        hasEditPermission = false;
      }

      setIsEditable(hasEditPermission);
      const response = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        throw new Error(`プロフィールの取得に失敗しました: ${response.statusText}`);
      }
      const data = await response.json();
      setProfileData(data);
      // プロフィール取得後にそのユーザーのギャラリーを取得する
      if (data && data.id) {
        fetchGallery(data.id);
      }
    } catch (error) {
      console.error('プロフィール取得エラー:', error);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  const fetchGallery = useCallback(async (targetUserId: string) => {
    setIsGalleryLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;

      const response = await fetch(`${API_BASE_URL}/api/gallery/user/${targetUserId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) return;
      const data = await response.json();
      setGalleryItems(data);
    } catch (error) {
      console.error('ギャラリー取得エラー:', error);
    } finally {
      setIsGalleryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const avatarUrl = profileData?.avatar_link
    ? profileData.avatar_link
    : '/assets/images/profile_photo_empty.png';

  const openAvatarModal = () => {
    if (!isEditable) return;
    setUploadModalMode('avatar');
    setUploadModalOpen(true);
  };

  const openGalleryModal = () => {
    setUploadModalMode('gallery');
    setUploadModalOpen(true);
  };

  const handleUploadSuccess = () => {
    fetchProfile();
    if (profileData?.id) {
      fetchGallery(profileData.id);
    }
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-gray-500">Loading...</div>;
  }

  return (
    <div className="flex flex-col md:flex-row h-full w-full bg-white text-gray-900 overflow-y-auto md:overflow-hidden">

      {/* ==========================================
          左側(PC) / 上部(スマホ)：プロフィールサマリー & 写真一覧
      ========================================== */}
      <div className="w-full md:w-80 lg:w-96 bg-gray-50 px-4 md:px-6 py-6 md:py-8 border-b md:border-b-0 md:border-r border-gray-200 flex flex-col items-center flex-shrink-0 md:overflow-y-auto relative">

        {/* 右上の歯車アイコン（自分のプロフィールを見ている時だけ表示） */}
        {isEditable && (
          <button
            onClick={() => setActiveTab(activeTab === 'account' ? 'basic' : 'account')}
            className={`absolute top-4 right-4 p-2 rounded-full transition-colors ${activeTab === 'account' ? 'bg-blue-100 text-blue-600' : 'text-gray-400 hover:bg-gray-200 hover:text-gray-700'}`}
            title="アカウント設定"
          >
            <Settings className="w-5 h-5" />
          </button>
        )}

        {/* 1. 大きな丸いプロフィール写真 */}
        <div
          className={`w-32 md:w-full max-w-[240px] aspect-square rounded-full border-4 border-gray-300 overflow-hidden relative group bg-gray-200 flex items-center justify-center flex-shrink-0 ${isEditable ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''
            }`}
          onClick={openAvatarModal}
        >
          <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />

          {isEditable && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="text-center text-white">
                <svg className="w-7 h-7 mx-auto mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="font-bold text-xs md:text-sm">写真を変更</span>
              </div>
            </div>
          )}
        </div>

        <h2 className="text-3xl mt-5 md:text-4xl font-bold mb-2 truncate">
          {profileData?.name_english ?? '名前未設定'}
        </h2>

        {/* Active / Non-active バッジ */}
        {(() => {
          const active = profileData?.last_sign_in_at &&
            Date.now() - new Date(profileData.last_sign_in_at).getTime() < 6 * 30 * 24 * 60 * 60 * 1000;
          return (
            <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold mb-6 md:mb-10 ${active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
              <span className={`w-2 h-2 rounded-full ${active ? 'bg-green-500' : 'bg-gray-400'}`} />
              {active ? 'Active' : 'Non-active'}
            </div>
          );
        })()}

        {/* 2. 写真一覧 (Photos)
             - 自分：公開設定に関わらず全て表示
             - 他人：Organization / Registered / Public のみ表示（API側でフィルタリング済み）
        */}
        <div className="w-full mt-6 md:mt-8">
          <div className="flex items-center justify-between mb-3 md:mb-4">
            <h3 className="font-bold text-base md:text-lg">写真ギャラリー</h3>
            {/* 追加ボタンは自分のプロフィールのみ */}
            {isEditable && (
              <button
                onClick={openGalleryModal}
                className="flex items-center gap-1 text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                追加
              </button>
            )}
          </div>

          {/* ギャラリーグリッド */}
          <div className="flex overflow-x-auto md:grid md:grid-cols-3 gap-2 pb-2 md:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {isGalleryLoading ? (
              // ローディング中はスケルトン表示
              Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="w-24 h-24 md:w-auto md:h-auto md:aspect-square flex-shrink-0 rounded-lg bg-gray-200 animate-pulse"
                />
              ))
            ) : galleryItems.length > 0 ? (
              galleryItems.map((item) => (
                <div
                  key={item.id}
                  className="w-24 h-24 md:w-auto md:h-auto md:aspect-square flex-shrink-0 rounded-lg overflow-hidden bg-gray-200 cursor-pointer hover:opacity-80 transition-opacity relative group"
                  title={item.description ?? undefined}
                  onClick={() => {
                    setSelectedPhoto(item);
                    setViewModalOpen(true);
                  }}
                >
                  <img
                    src={item.thumbnail_url || item.view_url}
                    alt={item.image_type ?? '写真'}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  {/* アバターマーク（GalleryPageと同じスタイル） */}
                  {item.image_type === 'avatar' && (
                    <div className="absolute top-2 right-2 bg-white/90 p-1.5 rounded-md shadow-sm backdrop-blur-sm z-10" title="アバター写真">
                      <User className="w-4 h-4 text-gray-500" />
                    </div>
                  )}
                </div>
              ))
            ) : (
              // 写真なしの空ステート
              <div className="col-span-3 py-8 text-center text-gray-400 text-sm">
                {isEditable ? (
                  <button
                    onClick={openGalleryModal}
                    className="flex flex-col items-center gap-2 mx-auto hover:text-blue-500 transition-colors"
                  >
                    <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                    </svg>
                    <span>写真を追加する</span>
                  </button>
                ) : (
                  <span>公開された写真はありません</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ==========================================
          右側(PC) / 下部(スマホ)：メインコンテンツ
      ========================================== */}
      <div className="flex-1 flex flex-col bg-white md:overflow-hidden min-w-0">

        {/* アカウント設定以外の時はタブヘッダーを表示 */}
        {activeTab !== 'account' && (
          <div className="px-4 md:px-10 pt-6 md:pt-10 border-b border-gray-200 flex-shrink-0 flex justify-between items-end">
            {/* 左側：横スクロール可能なタブ群 */}
            <div className="flex space-x-6 md:space-x-8 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] flex-1">
              <button
                className={`pb-3 font-medium text-base md:text-lg transition-colors relative whitespace-nowrap ${activeTab === 'basic' ? 'text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                onClick={() => setActiveTab('basic')}
              >
                基本情報
                {activeTab === 'basic' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600" />}
              </button>
              <button
                className={`pb-3 font-medium text-base md:text-lg transition-colors relative whitespace-nowrap ${activeTab === 'detail' ? 'text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}
                onClick={() => setActiveTab('detail')}
              >
                詳細情報
                {activeTab === 'detail' && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-blue-600" />}
              </button>
            </div>
          </div>
        )}

        {/* タブの中身 */}
        <div className="flex-1 md:overflow-y-auto">
          {activeTab === 'basic' && (
            <BasicInfoPage initialData={profileData} isEditable={isEditable} onDataChange={fetchProfile} />
          )}
          {activeTab === 'detail' && (
            <DetailInfoTab userId={profileData?.id} isEditable={isEditable} />
          )}
          {activeTab === 'account' && (
            <AccountSettingTab onBack={() => setActiveTab('basic')} />
          )}
        </div>
      </div>

      {/* 写真アップロードモーダル */}
      <PhotoUploadModal
        isOpen={uploadModalOpen}
        mode={uploadModalMode}
        onClose={() => setUploadModalOpen(false)}
        onSuccess={handleUploadSuccess}
      />

      {/* 写真拡大表示モーダル */}
      <PhotoViewModal
        isOpen={viewModalOpen}
        imageUrl={selectedPhoto?.view_url ?? null}
        description={selectedPhoto?.description}
        onClose={() => setViewModalOpen(false)}
        isOwner={isEditable}
        photo={selectedPhoto}
        onPhotoUpdated={() => fetchGallery(profileData.id)}
        onPhotoDeleted={() => fetchGallery(profileData.id)}
        photos={galleryItems}
        initialPhotoId={selectedPhoto?.id}
      />
    </div>
  );
}