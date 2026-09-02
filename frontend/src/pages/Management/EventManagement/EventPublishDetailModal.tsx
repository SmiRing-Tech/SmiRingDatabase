import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, LayoutGrid, Globe, FileEdit, Archive, ChevronDown, Maximize2 } from 'lucide-react';
import type { EventItem } from '../../Events/eventDummyData';
import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';
import { richTextStyles } from '../../../components/ui/RichTextEditor';
import PhotoViewModal from '../../../components/ui/PhotoViewModal';

interface EventPublishDetailModalProps {
  event: EventItem | null;
  onClose: () => void;
  onStatusChange: (eventId: string, newStatus: 'draft' | 'published' | 'archived') => Promise<void>;
  onEdit?: (eventId: string) => void;
}

export default function EventPublishDetailModal({
  event,
  onClose,
  onStatusChange,
  onEdit,
}: EventPublishDetailModalProps) {
  const navigate = useNavigate();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isPhotoViewOpen, setIsPhotoViewOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isPhotoViewOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isPhotoViewOpen]);

  if (!event) return null;

  const handleHostClick = () => {
    onClose();
    if (event.host?.id) {
      navigate(`/members/${event.host.id}`);
    } else {
      navigate('/profile');
    }
  };

  // 開始日時（日本時間）が過ぎているかどうかの判定
  const isPast = event.start_datetime ? new Date(event.start_datetime).getTime() < Date.now() : false;
  const currentStatus = event.metadata?.status || (event as any).status || 'draft';

  // デフォルトの推奨アクション決定
  let defaultAction: { status: 'draft' | 'published' | 'archived'; label: string; color: string } = {
    status: 'draft',
    label: '作成中にする',
    color: 'bg-slate-700 hover:bg-slate-800',
  };

  if (currentStatus === 'draft') {
    defaultAction = {
      status: 'published',
      label: '公開する',
      color: 'bg-sky-600 hover:bg-sky-700',
    };
  } else if (currentStatus === 'published' && isPast) {
    defaultAction = {
      status: 'archived',
      label: 'アーカイブ',
      color: 'bg-amber-600 hover:bg-amber-700',
    };
  } else {
    defaultAction = {
      status: 'draft',
      label: '作成中にする',
      color: 'bg-slate-700 hover:bg-slate-800',
    };
  }

  const handleApplyStatus = async (newStatus: 'draft' | 'published' | 'archived') => {
    setIsUpdating(true);
    try {
      await onStatusChange(event.id, newStatus);
    } finally {
      setIsUpdating(false);
    }
  };

  const statusOptions: DropdownOption[] = [
    { label: '公開中にする', value: 'published', icon: <Globe className="w-4 h-4 text-sky-500" /> },
    { label: '作成中にする', value: 'draft', icon: <FileEdit className="w-4 h-4 text-slate-500" /> },
    { label: 'アーカイブにする', value: 'archived', icon: <Archive className="w-4 h-4 text-amber-500" /> },
  ];

  const isHtmlDescription = event.description.includes('<p>') || event.description.includes('<h') || event.description.includes('<ul>');

  const displayImageUrl = event.image_url || '/assets/images/SmiRing_logo_temp.png';

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 md:p-8 animate-in fade-in duration-200">
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity"
          onClick={onClose}
        />

        <div className="bg-white rounded-3xl shadow-2xl border border-sky-100 w-full max-w-2xl max-h-[92vh] flex flex-col relative z-10 overflow-hidden animate-in zoom-in-95 duration-200">
          
          {/* 閉じるボタン（右上） */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-20 w-9 h-9 rounded-full bg-white/90 text-slate-700 shadow-md flex items-center justify-center hover:bg-white hover:scale-105 active:scale-95 transition-all cursor-pointer"
            aria-label="閉じる"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="overflow-y-auto flex-1">
            {/* ヘッダー画像 (実画像またはSmiRingロゴ大きく表示・タップで画像拡大) */}
            <div
              onClick={() => setIsPhotoViewOpen(true)}
              className="w-full h-56 sm:h-72 relative overflow-hidden flex items-center justify-center select-none shrink-0 bg-gradient-to-br from-sky-50 via-blue-50/60 to-slate-100 cursor-pointer group"
              title="クリックして画像を拡大表示"
              style={{
                background: event.image_url
                  ? `url(${event.image_url}) center/cover no-repeat`
                  : undefined,
              }}
            >
              {!event.image_url && (
                <img
                  src="/assets/images/SmiRing_logo_temp.png"
                  alt="SmiRing"
                  className="w-28 h-28 sm:w-36 sm:h-36 object-contain drop-shadow-sm group-hover:scale-105 transition-transform duration-300"
                />
              )}

              {/* ホバー時の拡大アイコンインジケーター */}
              <div className="absolute bottom-3 right-3 px-3 py-1.5 rounded-full bg-slate-900/60 hover:bg-slate-900/80 text-white font-bold text-[11px] backdrop-blur-md flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shadow-md">
                <Maximize2 className="w-3.5 h-3.5" />
                <span>画像を拡大</span>
              </div>
            </div>

          <div className="p-6 sm:p-8 space-y-5">
            {/* 開催日時 */}
            <div className="text-xs sm:text-sm font-bold text-sky-600 tracking-wide">
              {event.event_date_text}
            </div>

            {/* ホスト情報 */}
            {event.host && (
              <div className="inline-flex">
                <button
                  type="button"
                  onClick={handleHostClick}
                  className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-sky-50 hover:bg-sky-100/80 border border-sky-100 text-slate-800 font-bold text-xs sm:text-sm transition-all duration-200 cursor-pointer shadow-xs active:scale-95 group"
                  title={`${event.host.name}のプロフィールを見る`}
                >
                  {event.host.avatar_url ? (
                    <img
                      src={event.host.avatar_url}
                      alt={event.host.name}
                      className="w-5 h-5 rounded-md object-cover"
                    />
                  ) : (
                    <div className="w-5 h-5 rounded-md bg-sky-200/70 text-sky-700 flex items-center justify-center group-hover:bg-sky-300/70 transition-colors">
                      <LayoutGrid className="w-3.5 h-3.5" />
                    </div>
                  )}
                  <span>{event.host.name}</span>
                </button>
              </div>
            )}

            {/* タイトル & 上下サブタイトル */}
            <div className="space-y-1 pt-1">
              {event.upper_subtitle && (
                <p className="text-xs sm:text-sm font-bold text-sky-600 leading-tight">
                  {event.upper_subtitle}
                </p>
              )}

              <h2 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight leading-snug">
                {event.title}
              </h2>

              {event.lower_subtitle && (
                <p className="text-xs sm:text-sm font-bold text-slate-500 leading-tight pt-0.5">
                  {event.lower_subtitle}
                </p>
              )}
            </div>

            {/* ディスクリプション（マークダウン/リッチテキスト対応） */}
            {isHtmlDescription ? (
              <div
                className={`pt-2 text-slate-600 leading-relaxed font-medium ${richTextStyles}`}
                dangerouslySetInnerHTML={{ __html: event.description }}
              />
            ) : (
              <div className="pt-2 text-xs sm:text-sm text-slate-600 leading-relaxed font-medium whitespace-pre-wrap">
                {event.description}
              </div>
            )}

            {/* 参加条件ボックス */}
            {event.requirements && (
              <div className="rounded-2xl p-4 bg-sky-50/70 border border-sky-100/80 space-y-1 mt-6">
                <div className="text-[11px] font-bold text-slate-400">
                  参加条件
                </div>
                <div className="text-xs sm:text-sm font-bold text-slate-800">
                  {event.requirements}
                </div>
              </div>
            )}

            {/* 下部アクションボタン列（左: 編集する / 右: 公開設定 Split Button） */}
            <div className="flex items-center justify-between gap-3 pt-6 pb-2 border-t border-slate-100">
              {/* 「編集する」ボタン */}
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onEdit?.(event.id);
                }}
                className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200/80 text-slate-700 font-bold text-xs sm:text-sm rounded-xl transition-all duration-200 flex items-center gap-2 cursor-pointer active:scale-95 shadow-xs"
              >
                <FileEdit className="w-4 h-4 text-slate-500" />
                <span>編集する</span>
              </button>

              {/* 公開設定 Split Button */}
              <div className="inline-flex rounded-xl shadow-md overflow-visible border border-slate-200/40">
                {/* メインの推奨アクションボタン */}
                <button
                  type="button"
                  disabled={isUpdating}
                  onClick={() => handleApplyStatus(defaultAction.status)}
                  className={`px-6 py-2.5 text-white font-bold text-xs sm:text-sm rounded-l-xl transition-all duration-200 flex items-center gap-2 cursor-pointer disabled:opacity-50 ${defaultAction.color}`}
                >
                  <span>{defaultAction.label}</span>
                </button>

                {/* 連結ドロップダウン */}
                <div className="border-l border-white/20 bg-slate-700 hover:bg-slate-800 rounded-r-xl flex items-center justify-center transition-colors">
                  <CustomDropdown
                    options={statusOptions}
                    value={currentStatus}
                    onChange={(val) => handleApplyStatus(val as any)}
                    placeholder=""
                    minMenuWidth={180}
                    customTrigger={(isOpen) => (
                      <button
                        type="button"
                        aria-label="ステータス変更メニューを開く"
                        className="w-10 h-full py-2.5 flex items-center justify-center text-white/90 hover:text-white transition-colors cursor-pointer"
                      >
                        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                    )}
                  />
                </div>
              </div>
            </div>

          </div>
        </div>

      </div>
    </div>

      {/* 🖼️ 画像拡大表示モーダル */}
      <PhotoViewModal
        isOpen={isPhotoViewOpen}
        onClose={() => setIsPhotoViewOpen(false)}
        imageUrl={displayImageUrl}
        description={event.title}
      />
    </>
  );
}
