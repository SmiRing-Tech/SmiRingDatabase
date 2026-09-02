import React, { useState } from 'react';
import { ChevronDown, FileEdit, Globe, Archive } from 'lucide-react';
import type { EventItem } from '../../Events/eventDummyData';
import EventPublishDetailModal from './EventPublishDetailModal';

interface EventPublishTabProps {
  events: EventItem[];
  isLoading: boolean;
  onRefresh: () => Promise<void>;
  onStatusChange: (eventId: string, newStatus: 'draft' | 'published' | 'archived') => Promise<void>;
  onEditEvent?: (eventId: string) => void;
}

export default function EventPublishTab({
  events,
  isLoading,
  onStatusChange,
  onEditEvent,
}: EventPublishTabProps) {
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);

  // 3つのセクションのアコーディオン開閉状態（デフォルトはすべて開く）
  const [openSections, setOpenSections] = useState({
    draft: true,
    published: true,
    archived: true,
  });

  const toggleSection = (key: 'draft' | 'published' | 'archived') => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const draftEvents = events.filter(e => (e as any).status === 'draft' || !((e as any).status));
  const publishedEvents = events.filter(e => (e as any).status === 'published');
  const archivedEvents = events.filter(e => (e as any).status === 'archived');

  const handleModalStatusChange = async (eventId: string, newStatus: 'draft' | 'published' | 'archived') => {
    await onStatusChange(eventId, newStatus);
    setSelectedEvent(null);
  };

  return (
    <div className="space-y-8 pb-16">
      
      {/* 1. 作成中（Draft）セクション */}
      <AccordionSection
        title="作成中"
        count={draftEvents.length}
        icon={<FileEdit className="w-5 h-5 text-slate-500" />}
        badgeColor="bg-slate-100 text-slate-700"
        isOpen={openSections.draft}
        onToggle={() => toggleSection('draft')}
        isLoading={isLoading}
        events={draftEvents}
        emptyMessage="現在、作成中のイベントはありません。"
        onEventClick={(event) => setSelectedEvent(event)}
      />

      {/* 2. 公開中（Published）セクション */}
      <AccordionSection
        title="公開中"
        count={publishedEvents.length}
        icon={<Globe className="w-5 h-5 text-sky-500" />}
        badgeColor="bg-sky-50 text-sky-700 border border-sky-100"
        isOpen={openSections.published}
        onToggle={() => toggleSection('published')}
        isLoading={isLoading}
        events={publishedEvents}
        emptyMessage="現在、公開中のイベントはありません。"
        onEventClick={(event) => setSelectedEvent(event)}
      />

      {/* 3. アーカイブ（Archived）セクション */}
      <AccordionSection
        title="アーカイブ"
        count={archivedEvents.length}
        icon={<Archive className="w-5 h-5 text-amber-500" />}
        badgeColor="bg-amber-50 text-amber-700 border border-amber-100"
        isOpen={openSections.archived}
        onToggle={() => toggleSection('archived')}
        isLoading={isLoading}
        events={archivedEvents}
        emptyMessage="アーカイブされたイベントはありません。"
        onEventClick={(event) => setSelectedEvent(event)}
      />

      {/* 公開設定詳細モーダル */}
      {selectedEvent && (
        <EventPublishDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onStatusChange={handleModalStatusChange}
          onEdit={onEditEvent}
        />
      )}

    </div>
  );
}

// ==========================================
// 📂 アコーディオンセクションコンポーネント
// ==========================================
interface AccordionSectionProps {
  title: string;
  count: number;
  icon: React.ReactNode;
  badgeColor: string;
  isOpen: boolean;
  onToggle: () => void;
  isLoading: boolean;
  events: EventItem[];
  emptyMessage: string;
  onEventClick: (event: EventItem) => void;
}

function AccordionSection({
  title,
  count,
  icon,
  badgeColor,
  isOpen,
  onToggle,
  isLoading,
  events,
  emptyMessage,
  onEventClick,
}: AccordionSectionProps) {
  return (
    <div className="bg-white rounded-3xl border border-slate-100 shadow-xs overflow-hidden transition-all duration-300">
      
      {/* アコーディオンヘッダー */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-6 py-5 flex items-center justify-between hover:bg-slate-50/70 transition-colors cursor-pointer select-none text-left"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-slate-50 border border-slate-150/60">
            {icon}
          </div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight">
            {title}
          </h2>
          <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${badgeColor}`}>
            {count}
          </span>
        </div>

        <div className={`p-1.5 rounded-full text-slate-400 hover:text-slate-700 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}>
          <ChevronDown className="w-5 h-5" />
        </div>
      </button>

      {/* アコーディオンボディ */}
      {isOpen && (
        <div className="p-6 pt-2 border-t border-slate-50">
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 py-4 animate-pulse">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-64 bg-slate-100 rounded-2xl" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-xs sm:text-sm font-medium">
              {emptyMessage}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 pt-3">
              {events.map((event) => (
                <PublishEventCard
                  key={event.id}
                  event={event}
                  onClick={() => onEventClick(event)}
                />
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// ==========================================
// 💳 カードコンポーネント
// ==========================================
function PublishEventCard({ event, onClick }: { event: EventItem; onClick: () => void }) {
  const plainDescription = event.description.replace(/<[^>]*>?/gm, '');

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-2xl md:rounded-3xl border border-sky-100/70 shadow-xs hover:shadow-xl hover:border-sky-200 hover:-translate-y-1 transition-all duration-300 cursor-pointer overflow-hidden flex flex-col h-full group select-none"
    >
      {/* 上部: 画像エリア */}
      <div
        className="w-full h-48 sm:h-56 relative overflow-hidden flex items-center justify-center select-none shrink-0 bg-gradient-to-br from-sky-50 via-blue-50/60 to-slate-100"
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
            className="w-20 h-20 sm:w-24 sm:h-24 object-contain drop-shadow-sm group-hover:scale-105 transition-transform duration-300"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-slate-900/20 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
      </div>

      {/* 下部: 情報エリア */}
      <div className="p-4 sm:p-5 flex-1 flex flex-col justify-between space-y-2.5 bg-white">
        <div className="space-y-1">
          {event.upper_subtitle && (
            <p className="text-[11px] font-bold text-sky-600 leading-tight">
              {event.upper_subtitle}
            </p>
          )}

          <h3 className="font-bold text-slate-900 text-sm sm:text-base leading-snug group-hover:text-sky-600 transition-colors">
            {event.title}
          </h3>

          {event.lower_subtitle && (
            <p className="text-[11px] font-bold text-slate-500 leading-tight">
              {event.lower_subtitle}
            </p>
          )}

          <p className="text-xs text-slate-500 leading-relaxed line-clamp-2 pt-0.5 font-medium">
            {plainDescription}
          </p>
        </div>

        <div className="pt-2 border-t border-slate-50">
          <p className="text-xs font-bold text-sky-600 tracking-wide">
            {event.event_date_text}
          </p>
        </div>
      </div>
    </div>
  );
}
