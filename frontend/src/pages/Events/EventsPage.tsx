import { useState, useEffect } from 'react';
import { apiClient } from '../../lib/apiClient';
import type { EventItem } from './eventDummyData';
import EventDetailModal from './EventDetailModal';

export default function EventsPage() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const response = await apiClient.get('/api/events');
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data)) {
            // 公開中（status === 'published'）のもののみ
            const publishedOnly = data.filter((e: any) => e.status === 'published' || !e.status);
            setEvents(publishedOnly);
          } else {
            setEvents([]);
          }
        } else {
          setEvents([]);
        }
      } catch (error) {
        console.error('[EventsPage] Failed to fetch events from API:', error);
        setEvents([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchEvents();
  }, []);

  return (
    <div className="min-h-full w-full bg-slate-50/40 p-6 md:p-10">
      
      {/* ページヘッダー */}
      <div className="mb-8">
        <h1 className="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">
          イベント
        </h1>
        <p className="text-xs md:text-sm text-slate-500 mt-1 font-medium">
          開催予定のイベントを掲載しています。タイルを押すと詳細が表示されます。
        </p>
      </div>

      {/* イベントグリッド一覧 */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pb-16 animate-pulse">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white rounded-2xl md:rounded-3xl border border-slate-150 overflow-hidden flex flex-col h-[400px]">
              <div className="w-full h-64 bg-slate-200" />
              <div className="p-5 flex-1 space-y-3">
                <div className="h-4 bg-slate-200 rounded w-1/3" />
                <div className="h-6 bg-slate-200 rounded w-3/4" />
                <div className="h-3 bg-slate-100 rounded w-full" />
                <div className="h-3 bg-slate-100 rounded w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100 p-16 text-center text-slate-400 space-y-2 max-w-lg mx-auto my-12 shadow-xs">
          <p className="text-base font-bold text-slate-600">現在、公開中のイベントはありません</p>
          <p className="text-xs text-slate-400">新しいイベントが公開されるまでしばらくお待ちください。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pb-16">
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              onClick={() => setSelectedEvent(event)}
            />
          ))}
        </div>
      )}

      {/* 詳細ポップアップモーダル */}
      {selectedEvent && (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}

    </div>
  );
}

// ==========================================
// 💳 イベントタイルコンポーネント（上部大部分が画像）
// ==========================================
function EventCard({ event, onClick }: { event: EventItem; onClick: () => void }) {
  const plainDescription = event.description.replace(/<[^>]*>?/gm, '');

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-2xl md:rounded-3xl border border-sky-100/70 shadow-xs hover:shadow-xl hover:border-sky-200 hover:-translate-y-1 transition-all duration-300 cursor-pointer overflow-hidden flex flex-col h-full group select-none"
    >
      {/* 上部: 画像エリア（全体の大部分を占める約70%比率） */}
      <div
        className="w-full h-64 sm:h-72 relative overflow-hidden flex items-center justify-center select-none shrink-0 bg-gradient-to-br from-sky-50 via-blue-50/60 to-slate-100"
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
            className="w-24 h-24 sm:w-28 sm:h-28 object-contain drop-shadow-sm group-hover:scale-105 transition-transform duration-300"
          />
        )}

        {/* ホバー時のオーバーレイ */}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-900/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      </div>

      {/* 下部: テキスト情報エリア */}
      <div className="p-5 flex-1 flex flex-col justify-between space-y-3 bg-white">
        
        <div className="space-y-1">
          {/* 上サブタイトル（青色） */}
          {event.upper_subtitle && (
            <p className="text-[11px] font-bold text-sky-600 leading-tight">
              {event.upper_subtitle}
            </p>
          )}

          {/* メインタイトル */}
          <h3 className="font-bold text-slate-900 text-base leading-snug group-hover:text-sky-600 transition-colors">
            {event.title}
          </h3>

          {/* 下サブタイトル（グレー） */}
          {event.lower_subtitle && (
            <p className="text-[11px] font-bold text-slate-500 leading-tight">
              {event.lower_subtitle}
            </p>
          )}

          {/* ディスクリプション（2行省略） */}
          <p className="text-xs text-slate-500 leading-relaxed line-clamp-2 pt-1 font-medium">
            {plainDescription}
          </p>
        </div>

        {/* 開催日時（青色） */}
        <div className="pt-2 border-t border-slate-50">
          <p className="text-xs font-bold text-sky-600 tracking-wide">
            {event.event_date_text}
          </p>
        </div>

      </div>
    </div>
  );
}

