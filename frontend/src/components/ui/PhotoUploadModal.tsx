import { useState, useRef, useCallback } from 'react';
import imageCompression from 'browser-image-compression';
import { convertHeicToJpeg, isHeicFile } from '../../lib/heicConverter';
import { supabase } from '../../lib/supabase';
import { API_BASE_URL } from '../../config';
import { CustomDropdown, type DropdownOption } from './CustomDropdown';
import { 
  Globe, 
  Users, 
  Building, 
  Lock, 
  User, 
  Image as ImageIcon, 
  Calendar, 
  Trophy, 
  GraduationCap, 
  Utensils, 
  Sun, 
  MoreHorizontal 
} from 'lucide-react';

// ==========================================
// 型定義
// ==========================================
export type UploadItemStatus = 'compressing' | 'ready' | 'error';

export type UploadItem = {
  id: string;
  originalFile: File;
  compressedFile: File | null;
  previewUrl: string;
  status: UploadItemStatus;
  imageType: string | null;   // null = 未選択
  visibility: string;
  description: string;
};

type UploadMode = 'avatar' | 'gallery';

type Props = {
  isOpen: boolean;
  mode: UploadMode;
  onClose: () => void;
  onSuccess: () => void;
};

const COMPRESSION_OPTIONS = {
  maxSizeMB: 1,
  maxWidthOrHeight: 1920,
  useWebWorker: true,
};

const IMAGE_TYPE_OPTIONS: DropdownOption[] = [
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
  { value: 'registered', label: '登録ユーザーのみ (Registered)', icon: <Users className="w-4 h-4" /> },
  { value: 'organization', label: '社員のみ (Organization)', icon: <Building className="w-4 h-4" /> },
  { value: 'team', label: 'チームのみ (Team)', icon: <Users className="w-4 h-4" /> },
  { value: 'individual', label: '自分のみ (Individual)', icon: <Lock className="w-4 h-4" /> },
];

// ==========================================
// ヘルパー: ファイルを圧縮して UploadItem を作る
// ==========================================
async function buildUploadItem(file: File): Promise<UploadItem> {
  const id = crypto.randomUUID();
  const previewUrl = URL.createObjectURL(file);
  const item: UploadItem = {
    id,
    originalFile: file,
    compressedFile: null,
    previewUrl,
    status: 'compressing',
    imageType: null,
    visibility: 'organization',
    description: '',
  };
  return item;
}

// ==========================================
// Bulk Settings 型
// ==========================================
type BulkSettings = {
  imageType: string | null;
  visibility: string;
  description: string;
};

const DEFAULT_BULK: BulkSettings = { imageType: null, visibility: 'organization', description: '' };

// ==========================================
// PhotoUploadModal (Step 2a: Bulk Edit UI)
// ==========================================
export default function PhotoUploadModal({ isOpen, mode, onClose, onSuccess }: Props) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [bulkSettings, setBulkSettings] = useState<BulkSettings>(DEFAULT_BULK);
  // 'bulk' = 一括設定画面, 'individual:id' = 個別設定画面
  const [activeView, setActiveView] = useState<string>('bulk');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isAvatarMode = mode === 'avatar';

  // ファイル追加 → 即時圧縮開始
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => {
      const type = f.type.toLowerCase();
      const name = f.name.toLowerCase();
      return type.startsWith('image/') || isHeicFile(f) || name.endsWith('.heic') || name.endsWith('.heif');
    });
    
    if (fileArray.length === 0) return;

    // アバターモードは1枚のみ
    const initialToProcess = isAvatarMode ? [fileArray[0]] : fileArray;

    // 🌟 HEIC 変換処理（heic2any → Canvas フォールバック）
    const toProcess = await Promise.all(initialToProcess.map(convertHeicToJpeg));

    // 新しいアイテムの個別設定は一括設定の値で初期化
    const pendingItems = await Promise.all(toProcess.map(async (file) => {
      const base = await buildUploadItem(file);
      return {
        ...base,
        imageType: bulkSettings.imageType,
        visibility: bulkSettings.visibility,
        description: bulkSettings.description,
      };
    }));
    setItems(prev => isAvatarMode ? pendingItems : [...prev, ...pendingItems]);
    // 一括設定画面を表示
    setActiveView('bulk');

    // バックグラウンドで各ファイルを圧縮
    for (const pending of pendingItems) {
      try {
        const compressed = await imageCompression(pending.originalFile, COMPRESSION_OPTIONS);
        setItems(prev => prev.map(it =>
          it.id === pending.id
            ? { ...it, compressedFile: compressed, status: 'ready' }
            : it
        ));
      } catch {
        setItems(prev => prev.map(it =>
          it.id === pending.id ? { ...it, status: 'error' } : it
        ));
      }
    }
  }, [isAvatarMode, bulkSettings]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  };

  const removeItem = (id: string) => {
    setItems(prev => {
      const item = prev.find(it => it.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter(it => it.id !== id);
    });
  };

  const updateItem = (id: string, patch: Partial<UploadItem>) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
  };

  // 一括設定を全アイテムに適用
  const applyBulk = (patch: Partial<BulkSettings>) => {
    const next = { ...bulkSettings, ...patch };
    setBulkSettings(next);
    setItems(prev => prev.map(it => ({
      ...it,
      ...(patch.imageType !== undefined ? { imageType: patch.imageType } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
    })));
  };

  // 全アイテムが ready かつ Type設定済みかどうか
  const allReady = items.length > 0
    && items.every(it => it.status === 'ready')
    && (isAvatarMode || items.every(it => it.imageType !== null));

  const handleUpload = async () => {
    if (!allReady) return;
    setIsUploading(true);
    setUploadProgress(0);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('ログインが必要です');

      let completed = 0;
      for (const item of items) {
        const formData = new FormData();
        formData.append('file', item.compressedFile!, item.originalFile.name);
        formData.append('image_type', isAvatarMode ? 'avatar' : (item.imageType!));
        formData.append('visibility', isAvatarMode ? 'public' : item.visibility);
        if (item.description) formData.append('description', item.description);

        const res = await fetch(`${API_BASE_URL}/api/gallery/upload`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
          body: formData,
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'アップロードに失敗しました');
        }
        const { gallery } = await res.json();

        // アバター更新
        if (isAvatarMode) {
          const patchRes = await fetch(`${API_BASE_URL}/api/basic_profile_info/me`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ avatar_id: gallery.id }),
          });
          if (!patchRes.ok) throw new Error('アバターの更新に失敗しました');
        }

        completed++;
        setUploadProgress(Math.round((completed / items.length) * 100));
      }

      onSuccess();
      handleClose();
    } catch (err: any) {
      setError(err.message || 'アップロードに失敗しました');
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    items.forEach(it => URL.revokeObjectURL(it.previewUrl));
    setItems([]);
    setBulkSettings(DEFAULT_BULK);
    setActiveView('bulk');
    setError(null);
    setIsUploading(false);
    setUploadProgress(0);
    onClose();
  };

  // 現在表示中のアイテム (個別表示時)
  const activeItem = activeView !== 'bulk'
    ? items.find(it => it.id === activeView) ?? null
    : null;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={handleClose}>
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl flex flex-col overflow-hidden max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <h2 className="text-lg font-bold text-gray-800">
            {isAvatarMode ? 'アバター写真を変更' : '写真を追加'}
          </h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          {error && (
            <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-red-600 text-sm font-medium">
              {error}
            </div>
          )}

        {/* メインコンテンツ: ファイル未選択 → ドロップゾーン, 選択済み → 設定UI */}
          {/* hidden file input (常にDOMに存在させる) */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple={!isAvatarMode}
            className="hidden"
            onChange={handleFileChange}
          />

          {items.length === 0 ? (
            // ── ドロップゾーン ──
            <div
              className="border-2 border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50 rounded-xl py-12 flex flex-col items-center gap-2 text-gray-400 cursor-pointer transition-colors"
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-sm font-medium text-gray-600">クリックまたはドラッグ＆ドロップ</p>
              <p className="text-xs">{isAvatarMode ? '1枚だけ選択' : '複数選択OK'} · PNG, JPG, WEBP</p>
            </div>
          ) : (
            // ── 設定UI ──
            <div className="flex flex-col gap-4">

              {/* 一括設定パネル or 個別設定パネル */}
              {activeView === 'bulk' ? (
                // 🌐 一括設定パネル
                <div className="space-y-3">
                  <p className="text-xs font-bold text-blue-600 uppercase tracking-wide">一括設定（全 {items.length} 枚に反映）</p>

                  {!isAvatarMode && (
                    <>
                      <div className="z-[30]">
                        <label className="block text-xs font-semibold text-gray-600 mb-1.5 ml-1">種類（必須）</label>
                        <CustomDropdown
                          options={IMAGE_TYPE_OPTIONS}
                          value={bulkSettings.imageType ?? ''}
                          onChange={val => applyBulk({ imageType: (val as string) || null })}
                          placeholder="選択してください"
                        />
                      </div>
                      <div className="z-[20]">
                        <label className="block text-xs font-semibold text-gray-600 mb-1.5 ml-1">公開設定</label>
                        <CustomDropdown
                          options={VISIBILITY_OPTIONS}
                          value={bulkSettings.visibility}
                          onChange={val => applyBulk({ visibility: val as string })}
                        />
                      </div>
                    </>
                  )}
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">説明文（任意）</label>
                    <input
                      type="text"
                      value={bulkSettings.description}
                      onChange={e => applyBulk({ description: e.target.value })}
                      placeholder="どんな写真ですか？（AI自動生成の参考にも使われます）"
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                    />
                  </div>
                </div>
              ) : activeItem ? (() => {
                  const activeIndex = items.findIndex(it => it.id === activeItem.id);
                  const canPrev = activeIndex > 0;
                  const canNext = activeIndex < items.length - 1;
                  const goTo = (idx: number) => setActiveView(items[idx].id);
                  return (
                    // 📷 個別設定パネル
                    <div className="space-y-3">
                      <p className="text-xs font-bold text-gray-600 uppercase tracking-wide">個別設定</p>
                      <div className="flex items-center justify-between">
                        <button onClick={() => setActiveView('bulk')} className="text-xs text-blue-500 hover:underline">← 一括設定に戻る</button>
                        <p className="text-xs text-gray-400">{activeIndex + 1} / {items.length}</p>
                      </div>

                      {/* プレビュー（左右矢印付き） */}
                      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-gray-100">
                        <img src={activeItem.previewUrl} alt="" className="w-full h-full object-cover" />
                        {canPrev && (
                          <button
                            onClick={() => goTo(activeIndex - 1)}
                            className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-black/50 hover:bg-black/70 text-white rounded-full flex items-center justify-center transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
                            </svg>
                          </button>
                        )}
                        {canNext && (
                          <button
                            onClick={() => goTo(activeIndex + 1)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-black/50 hover:bg-black/70 text-white rounded-full flex items-center justify-center transition-colors"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                        )}
                      </div>

                      <p className="text-xs text-gray-500 truncate">{activeItem.originalFile.name}</p>

                      {!isAvatarMode && (
                        <>
                          <div className="z-[30]">
                            <label className="block text-xs font-semibold text-gray-600 mb-1.5 ml-1">種類（必須）</label>
                            <CustomDropdown
                              options={IMAGE_TYPE_OPTIONS}
                              value={activeItem.imageType ?? ''}
                              onChange={val => updateItem(activeItem.id, { imageType: (val as string) || null })}
                              placeholder="選択してください"
                            />
                          </div>
                          <div className="z-[20]">
                            <label className="block text-xs font-semibold text-gray-600 mb-1.5 ml-1">公開設定</label>
                            <CustomDropdown
                              options={VISIBILITY_OPTIONS}
                              value={activeItem.visibility}
                              onChange={val => updateItem(activeItem.id, { visibility: val as string })}
                            />
                          </div>
                        </>
                      )}
                      <input
                        type="text"
                        value={activeItem.description}
                        onChange={e => updateItem(activeItem.id, { description: e.target.value })}
                        placeholder="説明文（任意）"
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                      />
                      <button
                        onClick={() => { removeItem(activeItem.id); setActiveView(canNext ? items[activeIndex + 1].id : canPrev ? items[activeIndex - 1].id : 'bulk'); }}
                        className="text-xs text-red-400 hover:underline"
                      >
                        この写真を削除
                      </button>
                    </div>
                  );
                })() : null}

              {/* サムネイルストリップ */}
              <div className="flex gap-2 overflow-x-auto pb-1 pt-2 border-t border-gray-100">
                {/* 一括設定ボタン */}
                <button
                  onClick={() => setActiveView('bulk')}
                  className={`flex-shrink-0 w-14 h-14 rounded-lg border-2 flex items-center justify-center text-xs font-bold transition-colors ${
                    activeView === 'bulk' ? 'border-blue-500 bg-blue-50 text-blue-600' : 'border-gray-200 bg-gray-50 text-gray-400 hover:border-gray-400'
                  }`}
                >
                  全体
                </button>

                {items.map(item => {
                  const isReady = item.status === 'ready' && item.imageType !== null;
                  const isActive = activeView === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveView(item.id)}
                      className={`relative flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition-all ${
                        isActive ? 'border-blue-500 scale-105' : 'border-transparent hover:border-gray-300'
                      }`}
                    >
                      <img src={item.previewUrl} alt="" className="w-full h-full object-cover" />
                      {item.status === 'compressing' && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                          <svg className="animate-spin w-4 h-4 text-white" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                        </div>
                      )}
                      {isReady && (
                        <div className="absolute top-0.5 right-0.5 w-4 h-4 bg-green-500 rounded-full flex items-center justify-center">
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                      )}
                    </button>
                  );
                })}

                {/* 追加ボタン（アバターモード以外） */}
                {!isAvatarMode && (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="flex-shrink-0 w-14 h-14 rounded-lg border-2 border-dashed border-gray-300 hover:border-blue-400 flex items-center justify-center text-gray-400 hover:text-blue-400 transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                )}
              </div>

            </div>
          )}
        </div>

        {/* フッター */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex-shrink-0">

          {/* ステータスサマリー（ファイル選択済みの場合のみ） */}
          {items.length > 0 && !isUploading && (() => {
            const compressing = items.filter(it => it.status === 'compressing').length;
            const noType = items.filter(it => it.status === 'ready' && it.imageType === null && !isAvatarMode).length;
            const errors = items.filter(it => it.status === 'error').length;
            if (compressing > 0) return <p className="text-xs text-blue-500 font-medium mb-3">⏳ {compressing}枚を圧縮中... しばらくお待ちください</p>;
            if (errors > 0) return <p className="text-xs text-red-500 font-medium mb-3">⚠ {errors}枚の圧縮に失敗しました。削除して再度追加してください。</p>;
            if (noType > 0) return <p className="text-xs text-orange-500 font-medium mb-3">📋 {noType}枚の「種類」が未設定です。各写真に設定してください。</p>;
            return <p className="text-xs text-green-600 font-medium mb-3">✅ {items.length}枚すべてアップロード準備完了！</p>;
          })()}

          <div className="flex justify-end gap-3">
            <button
              onClick={handleClose}
              disabled={isUploading}
              className="px-5 py-2.5 text-sm font-bold text-gray-600 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              onClick={handleUpload}
              disabled={!allReady || isUploading}
              className="px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {items.length === 0
                ? 'アップロード'
                : items.length === 1
                ? '1枚をアップロード'
                : `${items.length}枚をアップロード`}
            </button>
          </div>
        </div>

        {/* アップロード中オーバーレイ */}
        {isUploading && (
          <div className="absolute inset-0 bg-white/90 flex flex-col items-center justify-center gap-4 rounded-2xl">
            <svg className="animate-spin w-10 h-10 text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="text-gray-700 font-bold">アップロード中... {uploadProgress}%</p>
            <div className="w-48 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
