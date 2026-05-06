import { useEffect, useState, useCallback } from 'react';
import GallerySidebar from './components/GallerySidebar';
import PhotoViewModal from '../../components/ui/PhotoViewModal';
import PhotoUploadModal from '../Profile/components/PhotoUploadModal';
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
};

export default function GalleryPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string[]>([]);
  const [filterPerson, setFilterPerson] = useState<string[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [photos, setPhotos] = useState<GalleryItem[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const fetchPhotos = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      setCurrentUserId(session.user.id);

      const response = await fetch(`${API_BASE_URL}/api/gallery?includeAvatars=true`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const data = await response.json();
        setPhotos(data);
      }
    } catch (error) {
      console.error('ギャラリーの取得に失敗しました:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPhotos();
  }, [fetchPhotos]);

  return (
    <div className="flex h-full w-full overflow-hidden bg-white">
      {/* 左側のフィルター */}
      <GallerySidebar
        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        filterType={filterType} setFilterType={setFilterType}
        filterPerson={filterPerson} setFilterPerson={setFilterPerson}
        photos={photos}
      />
      
      {/* 右側のグリッド */}
      <GalleryGrid
        photos={photos}
        isLoading={isLoading}
        currentUserId={currentUserId}
        searchQuery={searchQuery}
        filterType={filterType}
        filterPerson={filterPerson}
        fetchPhotos={fetchPhotos}
      />
    </div>
  );
}

type GridProps = {
  photos: GalleryItem[];
  isLoading: boolean;
  currentUserId: string | null;
  searchQuery: string;
  filterType: string[];
  filterPerson: string[];
  fetchPhotos: () => void;
};

function GalleryGrid({ photos, isLoading, currentUserId, searchQuery, filterType, filterPerson, fetchPhotos }: GridProps) {
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<{ url: string; description: string | null; isOwner: boolean; photo: GalleryItem } | null>(null);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

  return (
    // flex-1 で残りのスペース(右側)を全部埋めます
    <div className="flex-1 p-6 md:p-8 h-full overflow-y-auto bg-white">
      
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
            <button className="md:hidden p-2 text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 animate-pulse">
          {Array.from({ length: 15 }).map((_, i) => (
            <div key={i} className="aspect-square rounded-xl bg-gray-200" />
          ))}
        </div>
      ) : (() => {
        const filteredPhotos = photos.filter(photo => {
          const name = (photo.basic_profile_info as any)?.name_english || 'Unknown';
          const desc = photo.description || '';
          
          const matchType = filterType.length === 0 || (photo.image_type && filterType.includes(photo.image_type));
          const matchPerson = filterPerson.length === 0 || filterPerson.includes(photo.user_id);
          const matchSearch = !searchQuery || name.includes(searchQuery) || desc.includes(searchQuery);
          
          return matchType && matchPerson && matchSearch;
        });

        return filteredPhotos.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filteredPhotos.map((photo) => (
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
                <img src={photo.view_url} alt={photo.image_type || '写真'} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
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
        ) : (
          <div className="w-full py-16 text-center text-gray-400 border-2 border-dashed border-gray-200 rounded-xl">
            条件に一致する写真がありません
          </div>
        );
      })()}

      {/* 写真拡大表示モーダル */}
      <PhotoViewModal
        isOpen={viewModalOpen}
        imageUrl={selectedPhoto?.url ?? null}
        description={selectedPhoto?.description}
        isOwner={selectedPhoto?.isOwner}
        photo={selectedPhoto?.photo}
        onPhotoUpdated={fetchPhotos}
        onPhotoDeleted={fetchPhotos}
        onClose={() => setViewModalOpen(false)}
      />

      {/* 写真アップロードモーダル */}
      <PhotoUploadModal
        isOpen={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onSuccess={() => fetchPhotos()}
        mode="gallery"
      />
    </div>
  );
}