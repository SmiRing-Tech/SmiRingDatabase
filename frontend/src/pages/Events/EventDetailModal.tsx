import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, LayoutGrid, Maximize2 } from 'lucide-react';
import type { EventItem } from './eventDummyData';
import { useFeedback } from '../../context/FeedbackContext';
import { richTextStyles } from '../../components/ui/RichTextEditor';
import PhotoViewModal from '../../components/ui/PhotoViewModal';

interface EventDetailModalProps {
  event: EventItem | null;
  onClose: () => void;
}

export default function EventDetailModal({ event, onClose }: EventDetailModalProps) {
  const navigate = useNavigate();
  const { showFeedback } = useFeedback();
  const [isPhotoViewOpen, setIsPhotoViewOpen] = useState(false);

  // ESCキーでモーダルを閉じる
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
    // ホストの個別プロフィールページへ遷移
    if (event.host?.id) {
      navigate(`/members/${event.host.id}`);
    } else {
      navigate('/profile');
    }
  };

  const handleJoinEvent = () => {
    showFeedback(`「${event.title}」への参加登録を受け付けました！`, {
      type: 'success',
      mode: 'toast',
    });
    onClose();
  };

  const isHtmlDescription = event.description.includes('<p>') || event.description.includes('<h') || event.description.includes('<ul>');

  const displayImageUrl = event.image_url || '/assets/images/SmiRing_logo_temp.png';

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 md:p-8 animate-in fade-in duration-200">
        {/* 背景オーバーレイ */}
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity"
          onClick={onClose}
        />

        {/* モーダルコンテンツ本体 */}
        <div className="bg-white rounded-3xl shadow-2xl border border-sky-100 w-full max-w-2xl max-h-[92vh] flex flex-col relative z-10 overflow-hidden animate-in zoom-in-95 duration-200">
          
          {/* 閉じるボタン（右上） */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-20 w-9 h-9 rounded-full bg-white/90 text-slate-700 shadow-md flex items-center justify-center hover:bg-white hover:scale-105 active:scale-95 transition-all cursor-pointer"
            aria-label="閉じる"
          >
            <X className="w-5 h-5" />
          </button>

          {/* スクロール可能コンテナ */}
          <div className="overflow-y-auto flex-1">
            
            {/* ヘッダー画像エリア（タップで画像拡大モーダル表示） */}
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

          {/* 本文エリア */}
          <div className="p-6 sm:p-8 space-y-5">
            
            {/* 開催日時 */}
            <div className="text-xs sm:text-sm font-bold text-sky-600 tracking-wide">
              {event.event_date_text}
            </div>

            {/* ホスト情報（クリックでプロフィールページへ遷移） */}
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
              {/* 上サブタイトル（青色） */}
              {event.upper_subtitle && (
                <p className="text-xs sm:text-sm font-bold text-sky-600 leading-tight">
                  {event.upper_subtitle}
                </p>
              )}

              {/* メインタイトル */}
              <h2 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight leading-snug">
                {event.title}
              </h2>

              {/* 下サブタイトル（グレー） */}
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

            {/* 右下の目立つ「参加する」ボタン */}
            <div className="flex justify-end pt-4 pb-2">
              <button
                type="button"
                onClick={handleJoinEvent}
                className="px-8 py-3 bg-[#0284c7] hover:bg-[#0369a1] active:scale-95 text-white font-black text-sm rounded-xl transition-all duration-200 shadow-md hover:shadow-lg hover:shadow-sky-200 cursor-pointer"
              >
                参加する
              </button>
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
