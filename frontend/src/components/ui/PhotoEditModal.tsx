import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { API_BASE_URL } from '../../config';
import { CustomDropdown, type DropdownOption } from './CustomDropdown';
import { 
  Globe, 
  Users, 
  Building, 
  Lock, 
  User, 
  UserCircle,
  Image as ImageIcon, 
  Calendar, 
  Trophy, 
  GraduationCap, 
  Utensils, 
  Sun, 
  MoreHorizontal,
  UserCheck
} from 'lucide-react';

const IMAGE_TYPE_OPTIONS: DropdownOption[] = [
  { value: 'avatar', label: 'アバター', icon: <UserCircle className="w-4 h-4" /> },
  { value: 'portrait', label: '人物', icon: <User className="w-4 h-4" /> },
  { value: 'landscape', label: '風景', icon: <ImageIcon className="w-4 h-4" /> },
  { value: 'event', label: 'イベント', icon: <Calendar className="w-4 h-4" /> },
  { value: 'extracurricular', label: '課外活動', icon: <Trophy className="w-4 h-4" /> },
  { value: 'academic', label: '学業', icon: <GraduationCap className="w-4 h-4" /> },
  { value: 'food', label: '食事', icon: <Utensils className="w-4 h-4" /> },
  { value: 'daily', label: '日常', icon: <Sun className="w-4 h-4" /> },
  { value: 'other', label: 'その他', icon: <MoreHorizontal className="w-4 h-4" /> },
];

const VISIBILITY_OPTIONS: DropdownOption[] = [
  { value: 'public', label: '全体公開 (Public)', icon: <Globe className="w-4 h-4" /> },
  { value: 'registered', label: '登録ユーザーのみ (Registered)', icon: <UserCheck className="w-4 h-4" /> },
  { value: 'organization', label: '社員のみ (Organization)', icon: <Building className="w-4 h-4" /> },
  { value: 'team', label: 'チームのみ (Team)', icon: <Users className="w-4 h-4" /> },
  { value: 'individual', label: '自分のみ (Individual)', icon: <Lock className="w-4 h-4" /> },
];

type PhotoEditModalProps = {
  isOpen: boolean;
  onClose: () => void;
  photo: {
    id: string;
    image_type: string | null;
    visibility: string;
    description: string | null;
    view_url: string;
  } | null;
  onSuccess: () => void;
};

export default function PhotoEditModal({ isOpen, onClose, photo, onSuccess }: PhotoEditModalProps) {
  const [imageType, setImageType] = useState<string>('');
  const [visibility, setVisibility] = useState<string>('organization');
  const [description, setDescription] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (photo) {
      setImageType(photo.image_type || '');
      setVisibility(photo.visibility || 'organization');
      setDescription(photo.description || '');
      setError(null);
    }
  }, [photo, isOpen]);

  const handleSubmit = async () => {
    if (!photo) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('認証トークンがありません');

      const response = await fetch(`${API_BASE_URL}/api/gallery/${photo.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          image_type: imageType || null,
          visibility,
          description: description || null,
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '更新に失敗しました');
      }

      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新に失敗しました');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen || !photo) return null;

  return (
    <div 
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm cursor-pointer"
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] cursor-default"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
          <h2 className="text-xl font-bold text-gray-800">写真情報の編集</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-200 rounded-full text-gray-500 transition-colors"
            disabled={isSubmitting}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {error && (
            <div className="p-4 bg-red-50 text-red-600 rounded-lg text-sm mb-4">
              {error}
            </div>
          )}

          {/* Photo Preview (Small) */}
          <div className="flex justify-center mb-4">
            <img src={photo.view_url} alt="Preview" className="h-40 rounded-lg object-contain bg-gray-100" />
          </div>

          <div className="space-y-4">
            <div className="z-[30]">
              <label className="block text-xs font-semibold text-gray-600 mb-1.5 ml-1">種類（必須）</label>
              <CustomDropdown
                options={IMAGE_TYPE_OPTIONS}
                value={imageType}
                onChange={(val) => setImageType(val as string)}
                placeholder="選択してください"
              />
            </div>

            <div className="z-[20]">
              <label className="block text-xs font-semibold text-gray-600 mb-1.5 ml-1">公開設定</label>
              <CustomDropdown
                options={VISIBILITY_OPTIONS}
                value={visibility}
                onChange={(val) => setVisibility(val as string)}
              />
            </div>

            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="説明文（任意）"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none h-24"
              disabled={isSubmitting}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-6 py-2.5 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded-xl transition-colors"
            disabled={isSubmitting}
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            className="px-6 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <>
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                保存中...
              </>
            ) : (
              '保存する'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
