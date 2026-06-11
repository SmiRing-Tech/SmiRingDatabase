import { useEffect, useState, useCallback } from 'react';
import GallerySidebar from './components/GallerySidebar';
import PhotoViewModal from '../../components/ui/PhotoViewModal';
import PhotoUploadModal from '../../components/ui/PhotoUploadModal';
import { supabase } from '../../lib/supabase';
import { API_BASE_URL } from '../../config';
import { Plus, User } from 'lucide-react';

export type GalleryItem = {
  id: string;
  user_id: string;
  storage_path: string;
  image_type: string | null;
  tags: string[];
  created_at: string;
  description: string | null;
  visibility: string;
  basic_profile_info: {
    id: string;
    name_kanji: string | null;
    name_english: string | null;
  };
  view_url: string;
  thumbnail_url: string;
};

export default function GalleryPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string[]>([]);
  const [filterPerson, setFilterPerson] = useState<string[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [photos, setPhotos] = useState<GalleryItem[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // スマホ用サイドバー開閉

  // ページネーション状態
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const LIMIT = 50;

  const fetchPhotos = useCallback(async (currentOffset = 0, isInit = false) => {
    try {
      if (isInit) {
        setIsLoading(true);
        setHasMore(true);
      } else {
        setIsFetchingMore(true);
      }

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      setCurrentUserId(session.user.id);

      const params = new URLSearchParams();
      params.append('includeAvatars', 'true');
      params.append('limit', LIMIT.toString());
      params.append('offset', currentOffset.toString());
      
      if (filterPerson.length > 0) {
        params.append('userIds', filterPerson.join(','));
      }
      if (filterType.length > 0) {
        params.append('imageTypes', filterType.join(','));
      }
      if (searchQuery.trim()) {
        params.append('search', searchQuery.trim());
      }

      const response = await fetch(`${API_BASE_URL}/api/gallery?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.ok) {
        const data = await response.json();
        if (isInit) {
          setPhotos(data);
        } else {
          setPhotos(prev => [...prev, ...data]);
        }

        if (data.length < LIMIT) {
          setHasMore(false);
        }
      }
    } catch (error) {
      console.error('ギャラリーの取得に失敗しました:', error);
    } finally {
      setIsLoading(false);
      setIsFetchingMore(false);
    }
  }, [filterPerson, filterType, searchQuery]);

  const handleClearFilters = () => {
    setSearchQuery('');
    setFilterType([]);
    setFilterPerson([]);
  };

  // フィルター変更時の初期化
  useEffect(() => {
    setOffset(0);
    fetchPhotos(0, true);
  }, [searchQuery, filterType, filterPerson, fetchPhotos]);

  const loadMore = () => {
    if (isLoading || isFetchingMore || !hasMore) return;
    const nextOffset = offset + LIMIT;
    setOffset(nextOffset);
    fetchPhotos(nextOffset, false);
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-white">
      {/* 左側のフィルター */}
      <GallerySidebar
        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        filterType={filterType} setFilterType={setFilterType}
        filterPerson={filterPerson} setFilterPerson={setFilterPerson}
        photos={photos}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        onClear={handleClearFilters}
      />

      {/* スマホ用サイドバー背景オーバーレイ */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-30 md:hidden animate-in fade-in duration-200"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}
      
      {/* 右側のグリッド */}
      <GalleryGrid
        photos={photos}
        isLoading={isLoading}
        isFetchingMore={isFetchingMore}
        hasMore={hasMore}
        currentUserId={currentUserId}
        onLoadMore={loadMore}
        setIsSidebarOpen={setIsSidebarOpen}
        onClearFilters={handleClearFilters}
        onRefresh={() => fetchPhotos(0, true)}
      />
    </div>
  );
}

type GridProps = {
  photos: GalleryItem[];
  isLoading: boolean;
  isFetchingMore: boolean;
  hasMore: boolean;
  currentUserId: string | null;
  onLoadMore: () => void;
  setIsSidebarOpen: (val: boolean) => void;
  onClearFilters: () => void;
  onRefresh: () => void;
};

function GalleryGrid({ 
  photos, 
  isLoading, 
  isFetchingMore, 
  hasMore, 
  currentUserId, 
  onLoadMore, 
  setIsSidebarOpen, 
  onClearFilters, 
  onRefresh 
}: GridProps) {
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<{ url: string; description: string | null; isOwner: boolean; photo: GalleryItem } | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (
      target.scrollHeight - target.scrollTop <= target.clientHeight + 150 &&
      !isLoading &&
      !isFetchingMore &&
      hasMore
    ) {
      onLoadMore();
    }
  };

  return (
    // flex-1 で残りのスペース(右側)を全部埋めます
    <div onScroll={handleScroll} className="flex-1 p-6 md:p-8 h-full overflow-y-auto bg-white">
      
      {/* ヘッダーエリア */}
      <div className="flex flex-col gap-4 mb-8">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900">Photo Gallery</h1>
          
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setUploadModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-md transition-all font-bold text-sm"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Add Photo</span>
            </button>
            {/* スマホ表示の時にだけ出る「フィルターを開く」ボタン */}
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="md:hidden p-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-6 animate-pulse">
          {Array.from({ length: 16 }).map((_, i) => (
            <div key={i} className="aspect-square rounded-xl bg-gray-200" />
          ))}
        </div>
      ) : photos.length > 0 ? (
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {photos.map((photo) => (
              <div 
                key={photo.id} 
                className="aspect-square rounded-xl overflow-hidden bg-gray-100 cursor-pointer group relative shadow-sm hover:shadow-md transition-all"
                onClick={() => {
                  setSelectedPhoto({ 
                    url: photo.view_url, 
                    description: photo.description, 
                    isOwner: photo.user_id === currentUserId,
                    photo: photo
                  });
                  setViewModalOpen(true);
                }}
              >
                <img 
                  src={photo.thumbnail_url || photo.view_url} 
                  alt={photo.image_type || '写真'} 
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" 
                  loading="lazy"
                />
                {photo.image_type === 'avatar' && (
                  <div className="absolute top-2 right-2 bg-white/90 p-1.5 rounded-md shadow-sm backdrop-blur-sm z-10" title="アバター写真">
                    <User className="w-4 h-4 text-gray-500" />
                  </div>
                )}
                {photo.description && (
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4 translate-y-full group-hover:translate-y-0 transition-transform duration-300">
                    <span className="text-white text-sm font-medium truncate block">
                      {photo.description}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
          
          {/* 追加ロードスピナー */}
          {isFetchingMore && (
            <div className="flex justify-center items-center py-8">
              <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {/* これ以上データがない場合の控えめな表示 */}
          {!hasMore && photos.length > 10 && (
            <div className="text-center text-xs text-gray-400 py-8 font-bold">
              すべての写真を表示しました
            </div>
          )}
        </div>
      ) : (
        <div className="w-full py-16 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center gap-4">
          <p>条件に一致する写真がありません</p>
          <button 
            onClick={onClearFilters}
            className="text-blue-600 font-bold hover:underline text-sm"
          >
            フィルターをクリアする
          </button>
        </div>
      )}

      {/* 写真拡大表示モーダル */}
      <PhotoViewModal
        isOpen={viewModalOpen}
        imageUrl={selectedPhoto?.url ?? null}
        description={selectedPhoto?.description}
        isOwner={selectedPhoto?.isOwner}
        photo={selectedPhoto?.photo}
        onPhotoUpdated={onRefresh}
        onPhotoDeleted={onRefresh}
        onClose={() => setViewModalOpen(false)}
        photos={photos}
        initialPhotoId={selectedPhoto?.photo?.id}
        currentUserId={currentUserId}
      />

      {/* 写真アップロードモーダル */}
      <PhotoUploadModal
        isOpen={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onSuccess={onRefresh}
        mode="gallery"
      />
    </div>
  );
}