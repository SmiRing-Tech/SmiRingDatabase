import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  Upload,
  Trash2,
  Calendar,
  Clock,
  User,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Layers,
  Globe,
  FileEdit,
  Archive,
} from 'lucide-react';
import { apiClient } from '../../../lib/apiClient';
import { useFeedback } from '../../../context/FeedbackContext';
import { SmartDateTimePicker } from '../../../components/ui/SmartDateTimePicker';
import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';
import RichTextEditor from '../../../components/ui/RichTextEditor';
import imageCompression from 'browser-image-compression';

interface EventEditorFormProps {
  eventId: string;
  onBack: () => void;
  onSaved?: () => void;
}

export default function EventEditorForm({
  eventId,
  onBack,
  onSaved,
}: EventEditorFormProps) {
  const { showFeedback } = useFeedback();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 内部で保持するイベントID (新規作成時は最初はnull)
  const [currentEventId, setCurrentEventId] = useState<string | null>(
    eventId === 'new' ? null : eventId
  );

  // フォームステート
  const [title, setTitle] = useState('');
  const [upperSubtitle, setUpperSubtitle] = useState('');
  const [lowerSubtitle, setLowerSubtitle] = useState('');
  const [description, setDescription] = useState('');
  const [requirements, setRequirements] = useState('');
  const [startDatetime, setStartDatetime] = useState<Date | null>(null);
  const [endDatetime, setEndDatetime] = useState<Date | null>(null);
  const [hostId, setHostId] = useState<string>('');
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'draft' | 'published' | 'archived'>('draft');

  // ホスト選択用メンバー一覧（SmiRingMemberのみ）
  const [memberOptions, setMemberOptions] = useState<DropdownOption[]>([]);

  // 保存ステート
  const [isInitialLoading, setIsInitialLoading] = useState(eventId !== 'new');
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [lastSavedTime, setLastSavedTime] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 1. 初期データ読み込み
  useEffect(() => {
    const loadEventAndMembers = async () => {
      try {
        // SmiRingMemberのみを効率的に取得
        const membersRes = await apiClient.get('/api/events/hosts');
        if (membersRes.ok) {
          const membersData = await membersRes.json();
          const options: DropdownOption[] = (membersData || []).map((m: any) => ({
            value: m.id,
            label: m.name_kanji ? `${m.name_kanji} (${m.name_english || ''})` : (m.name_english || '名前未設定'),
            description: m.current_school || undefined,
          }));
          setMemberOptions(options);
        }

        // 新規作成でない場合のみイベント詳細を取得
        if (eventId && eventId !== 'new') {
          const eventRes = await apiClient.get('/api/events/all');
          if (eventRes.ok) {
            const allEvents = await eventRes.json();
            const current = (allEvents || []).find((e: any) => e.id === eventId);
            if (current) {
              setTitle(current.title || '');
              setUpperSubtitle(current.upper_subtitle || '');
              setLowerSubtitle(current.lower_subtitle || '');
              setDescription(current.description || current.discription || '');
              setRequirements(current.requirements || current.metadata?.requirements || '');
              setStartDatetime(current.start_datetime ? new Date(current.start_datetime) : null);
              setEndDatetime(current.end_datetime ? new Date(current.end_datetime) : null);
              setHostId(current.host?.id || current.host || '');
              setImagePath(current.image_path || null);
              setImageUrl(current.image_url || null);
              setStatus(current.status || 'draft');
            }
          }
        }
      } catch (err) {
        console.error('[EventEditor] Load error:', err);
        showFeedback('イベントの読み込みに失敗しました', { type: 'error', mode: 'toast' });
      } finally {
        setIsInitialLoading(false);
      }
    };

    loadEventAndMembers();
  }, [eventId]);

  const handleStatusChange = (newStatus: 'draft' | 'published' | 'archived') => {
    setStatus(newStatus);
    setHasUnsavedChanges(true);
    showFeedback(
      newStatus === 'published' ? 'ステータスを「公開中」に変更しました' : newStatus === 'archived' ? 'ステータスを「アーカイブ」に変更しました' : 'ステータスを「作成中」に変更しました',
      { type: 'info', mode: 'toast' }
    );
  };

  const statusOptions: DropdownOption[] = [
    { label: '公開中にする', value: 'published', icon: <Globe className="w-4 h-4 text-sky-500" /> },
    { label: '作成中にする', value: 'draft', icon: <FileEdit className="w-4 h-4 text-slate-500" /> },
    { label: 'アーカイブにする', value: 'archived', icon: <Archive className="w-4 h-4 text-amber-500" /> },
  ];

  // 2. 自動保存ロジック（debounce 1000ms）
  const saveEvent = useCallback(async () => {
    if (isInitialLoading) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      // 日本時間のローカルISO形式文字列に変換
      const formatToLocalISO = (d: Date | null) => {
        if (!d) return null;
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
      };

      const payload = {
        title: title.trim() || '無題のイベント',
        upper_subtitle: upperSubtitle || null,
        lower_subtitle: lowerSubtitle || null,
        description,
        requirements: requirements || null,
        start_datetime: formatToLocalISO(startDatetime),
        end_datetime: formatToLocalISO(endDatetime),
        host: hostId || null,
        image_path: imagePath,
        status,
      };

      if (!currentEventId) {
        // まだDBに存在しない場合は初回作成 (POST)
        const res = await apiClient.post('/api/events', payload);
        if (!res.ok) throw new Error('イベントの作成に失敗しました');
        const created = await res.json();
        setCurrentEventId(created.id);
      } else {
        // 既存イベントの更新 (PATCH)
        const res = await apiClient.patch(`/api/events/${currentEventId}`, payload);
        if (!res.ok) throw new Error('自動保存に失敗しました');
      }

      setLastSavedTime(new Date());
      setHasUnsavedChanges(false);
      onSaved?.();
    } catch (err: any) {
      console.error('[EventEditor] Auto-save failed:', err);
      setSaveError(err.message || '保存に失敗しました');
    } finally {
      setIsSaving(false);
    }
  }, [
    currentEventId,
    isInitialLoading,
    title,
    upperSubtitle,
    lowerSubtitle,
    description,
    requirements,
    startDatetime,
    endDatetime,
    hostId,
    imagePath,
    status,
    onSaved,
  ]);

  useEffect(() => {
    if (!hasUnsavedChanges || isInitialLoading) return;
    const timer = setTimeout(() => {
      saveEvent();
    }, 1000);
    return () => clearTimeout(timer);
  }, [hasUnsavedChanges, saveEvent, isInitialLoading]);

  // 入力変更ハンドラー
  const handleFieldChange = (setter: React.Dispatch<React.SetStateAction<any>>, value: any) => {
    setter(value);
    setHasUnsavedChanges(true);
  };

  // 3. 画像アップロード処理 (R2 events/ 配下)
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingImage(true);
    try {
      // 🌟 ブラウザ側で高速圧縮（最大3MB、最大2400px）
      let fileToUpload = file;
      try {
        fileToUpload = await imageCompression(file, {
          maxSizeMB: 3,
          maxWidthOrHeight: 2400,
          useWebWorker: true,
        });
      } catch (compErr) {
        console.warn('[EventEditor] Compression skipped, uploading original:', compErr);
      }

      const formData = new FormData();
      formData.append('image', fileToUpload, file.name);

      const res = await apiClient.post('/api/events/upload-image', formData);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || '画像のアップロードに失敗しました');
      }

      const data = await res.json();
      setImagePath(data.storage_path);
      setImageUrl(data.view_url);
      setHasUnsavedChanges(true);
      showFeedback('画像をアップロードしました', { type: 'success', mode: 'toast' });
    } catch (err: any) {
      console.error('[EventEditor] Upload failed:', err);
      showFeedback(`画像アップロードエラー: ${err.message}`, { type: 'error', mode: 'banner' });
    } finally {
      setIsUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveImage = () => {
    setImagePath(null);
    setImageUrl(null);
    setHasUnsavedChanges(true);
  };

  if (isInitialLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-slate-400">
        <Loader2 className="w-8 h-8 animate-spin text-sky-500 mb-3" />
        <p className="text-sm font-bold">イベント情報を読み込み中...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto pb-24 animate-in fade-in duration-200">
      
      {/* ツールバー */}
      <div className="sticky top-0 z-30 bg-white/90 backdrop-blur-md border-b border-slate-100 py-3.5 px-4 mb-6 rounded-2xl shadow-xs flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 text-xs sm:text-sm font-bold text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-xl hover:bg-slate-100 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>一覧に戻る</span>
        </button>

        {/* 自動保存ステータスインジケーター */}
        <div className="flex items-center gap-2 text-xs font-bold">
          {isSaving ? (
            <span className="inline-flex items-center gap-1.5 text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-500" />
              <span>保存中...</span>
            </span>
          ) : saveError ? (
            <span className="inline-flex items-center gap-1.5 text-rose-500">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>保存失敗 (再試行中)</span>
            </span>
          ) : lastSavedTime ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-600">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{lastSavedTime.toLocaleTimeString()} に保存済み</span>
            </span>
          ) : (
            <span className="text-slate-400">自動保存されます</span>
          )}
        </div>
      </div>

      {/* メインエディターカード（モーダル風 Hero レイアウト） */}
      <div className="bg-white rounded-3xl border border-slate-150 shadow-sm overflow-hidden space-y-8">
        
        {/* ==========================================
            Hero 画像エリア (デフォルトはSmiRingロゴを大きく表示)
        ========================================== */}
        <div className="relative w-full h-64 sm:h-80 bg-gradient-to-br from-sky-50 via-blue-50/60 to-slate-100 flex items-center justify-center overflow-hidden group">
          
          {/* 🌟 ステータス変更チップ（左上・大きめ丸っこいボタン） */}
          <div className="absolute top-4 left-4 z-20">
            <CustomDropdown
              options={statusOptions}
              value={status}
              onChange={(val) => handleStatusChange(val as any)}
              placeholder=""
              minMenuWidth={180}
              customTrigger={() => (
                <button
                  type="button"
                  title="クリックして公開ステータスを変更"
                  className={`px-4 py-2 rounded-full font-black text-xs sm:text-sm shadow-md backdrop-blur-md transition-all flex items-center gap-2 cursor-pointer hover:scale-105 active:scale-95 border ${
                    status === 'published'
                      ? 'bg-sky-500/95 hover:bg-sky-600 text-white border-sky-400/40 shadow-sky-500/20'
                      : status === 'archived'
                      ? 'bg-amber-600/95 hover:bg-amber-700 text-white border-amber-500/40 shadow-amber-600/20'
                      : 'bg-slate-800/85 hover:bg-slate-900 text-white border-slate-700/50 shadow-slate-900/20'
                  }`}
                >
                  {status === 'published' ? (
                    <Globe className="w-4 h-4" />
                  ) : status === 'archived' ? (
                    <Archive className="w-4 h-4" />
                  ) : (
                    <FileEdit className="w-4 h-4" />
                  )}
                  <span>
                    {status === 'published' ? '公開中' : status === 'archived' ? 'アーカイブ' : '作成中'}
                  </span>
                </button>
              )}
            />
          </div>

          {imageUrl ? (
            <img
              src={imageUrl}
              alt="イベント画像"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center justify-center p-6 text-center select-none">
              <img
                src="/assets/images/SmiRing_logo_temp.png"
                alt="SmiRing"
                className="w-28 h-28 sm:w-36 sm:h-36 object-contain drop-shadow-sm transition-transform duration-300 group-hover:scale-105"
              />
              <p className="text-xs font-bold text-slate-400 mt-2">
                カバー画像未設定（SmiRingロゴが表示されます）
              </p>
            </div>
          )}

          {/* アップロード中のローディングオーバーレイ */}
          {isUploadingImage && (
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center text-white z-20">
              <Loader2 className="w-8 h-8 animate-spin text-sky-400 mb-2" />
              <span className="text-xs font-bold ml-2">アップロード中...</span>
            </div>
          )}

          {/* 画像操作ボタン（右上） */}
          <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploadingImage}
              className="px-4 py-2 bg-white/90 hover:bg-white text-slate-700 font-bold text-xs rounded-xl shadow-md backdrop-blur-xs transition-all flex items-center gap-2 cursor-pointer hover:scale-105 active:scale-95 disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5 text-sky-500" />
              <span>{imageUrl ? '画像を変更' : '画像をアップロード'}</span>
            </button>

            {imageUrl && (
              <button
                type="button"
                onClick={handleRemoveImage}
                className="p-2 bg-white/90 hover:bg-rose-50 text-rose-600 rounded-xl shadow-md backdrop-blur-xs transition-all cursor-pointer hover:scale-105 active:scale-95"
                title="画像を削除"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />
          </div>
        </div>

        {/* ==========================================
            入力フォームエリア
        ========================================== */}
        <div className="p-6 sm:p-10 space-y-7">
          
          {/* 日時設定（日本時間固定） */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 p-5 bg-slate-50/70 rounded-2xl border border-slate-150">
            {/* 開始日時 */}
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-600 flex items-center gap-1.5">
                <Calendar className="w-3.5 h-3.5 text-sky-500" />
                <span>開始日時（日本時間）</span>
              </label>
              <SmartDateTimePicker
                value={startDatetime}
                onChange={(date) => handleFieldChange(setStartDatetime, date)}
                timezone="Asia/Tokyo"
                placeholder="開始日時を選択"
              />
            </div>

            {/* 終了日時 */}
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-600 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-sky-500" />
                <span>終了日時（日本時間）</span>
              </label>
              <SmartDateTimePicker
                value={endDatetime}
                onChange={(date) => handleFieldChange(setEndDatetime, date)}
                timezone="Asia/Tokyo"
                placeholder="終了日時を選択"
              />
            </div>
          </div>

          {/* ホストメンバー選択（検索バー付き） */}
          <div className="space-y-2">
            <label className="text-xs font-black text-slate-600 uppercase tracking-wider flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-sky-500" />
              <span>ホストメンバー</span>
            </label>
            <CustomDropdown
              options={memberOptions}
              value={hostId}
              onChange={(val) => handleFieldChange(setHostId, val)}
              searchable={true}
              placeholder="ホストメンバーを検索・選択"
              className="w-full"
            />
          </div>

          {/* タイトル & 上下サブタイトル */}
          <div className="space-y-4 pt-2">
            {/* 上サブタイトル */}
            <div className="space-y-1.5">
              <label className="text-xs font-black text-sky-600 uppercase tracking-wider">
                上サブタイトル（任意）
              </label>
              <input
                type="text"
                value={upperSubtitle}
                onChange={(e) => handleFieldChange(setUpperSubtitle, e.target.value)}
                placeholder="例: 先輩留学生と直接話せる"
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm font-bold text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-400/50 focus:border-sky-400 focus:bg-white transition-all placeholder:text-slate-300"
              />
            </div>

            {/* メインタイトル */}
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-700 uppercase tracking-wider">
                メインタイトル
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => handleFieldChange(setTitle, e.target.value)}
                placeholder="例: 秋の留学フェア2026"
                className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-base sm:text-lg font-black text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-400/50 focus:border-sky-400 transition-all placeholder:text-slate-300"
              />
            </div>

            {/* 下サブタイトル */}
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-500 uppercase tracking-wider">
                下サブタイトル（任意）
              </label>
              <input
                type="text"
                value={lowerSubtitle}
                onChange={(e) => handleFieldChange(setLowerSubtitle, e.target.value)}
                placeholder="例: 初めての受験でも安心のレベル別構成"
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm font-bold text-slate-600 focus:outline-none focus:ring-2 focus:ring-sky-400/50 focus:border-sky-400 focus:bg-white transition-all placeholder:text-slate-300"
              />
            </div>
          </div>

          {/* ディスクリプション（マークダウン/リッチテキスト） */}
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-700 uppercase tracking-wider">
              イベント詳細・説明文
            </label>
            <div className="bg-slate-50 border border-slate-200 rounded-2xl overflow-hidden focus-within:ring-2 focus-within:ring-sky-400/50 focus-within:border-sky-400 focus-within:bg-white transition-all">
              <RichTextEditor
                value={description}
                onChange={(html) => handleFieldChange(setDescription, html)}
                placeholder="イベントの趣旨、タイムスケジュール、準備物などを入力してください"
              />
            </div>
          </div>

          {/* 参加条件 */}
          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-700 uppercase tracking-wider">
              参加条件（任意）
            </label>
            <input
              type="text"
              value={requirements}
              onChange={(e) => handleFieldChange(setRequirements, e.target.value)}
              placeholder="例: SmiRing会員限定、大学生・大学院生対象など"
              className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-400/50 focus:border-sky-400 focus:bg-white transition-all placeholder:text-slate-300"
            />
          </div>

          {/* ==========================================
              拡張情報エリア（Coming Soon）
          ========================================== */}
          <div className="pt-6 border-t border-slate-150 space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-sky-500" />
              <h3 className="text-sm font-black text-slate-800 tracking-tight">
                イベント詳細設定
              </h3>
              <span className="text-[10px] font-black uppercase tracking-wider bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full">
                Coming Soon
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl bg-slate-50 border border-dashed border-slate-200 text-slate-400 space-y-1.5 opacity-80">
                <div className="flex items-center gap-2 text-slate-600 font-bold text-xs">
                  <Clock className="w-4 h-4 text-slate-400" />
                  <span>タイムスケジュール設定</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  当日の分刻み進行表や登壇者割り当てを設定できます。
                </p>
              </div>

              <div className="p-4 rounded-2xl bg-slate-50 border border-dashed border-slate-200 text-slate-400 space-y-1.5 opacity-80">
                <div className="flex items-center gap-2 text-slate-600 font-bold text-xs">
                  <Layers className="w-4 h-4 text-slate-400" />
                  <span>スライド・台本管理</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  スライド資料ごとのトークスクリプトや補足メモを紐づけられます。
                </p>
              </div>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
