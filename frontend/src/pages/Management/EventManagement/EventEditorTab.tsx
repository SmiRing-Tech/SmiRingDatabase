import React, { useState, useEffect } from 'react';
import {
  Plus,
  MoreVertical,
  Trash2,
  Calendar,
  User,
  Loader2,
  FileEdit,
  Globe,
  Archive,
} from 'lucide-react';
import type { EventItem } from '../../Events/eventDummyData';
import EventEditorForm from './EventEditorForm';
import { apiClient } from '../../../lib/apiClient';
import { useFeedback } from '../../../context/FeedbackContext';

interface EventEditorTabProps {
  events: EventItem[];
  isLoading: boolean;
  onRefresh: () => Promise<void>;
  initialEditingId?: string | null;
  onClearInitialEditingId?: () => void;
}

export default function EventEditorTab({
  events,
  isLoading,
  onRefresh,
  initialEditingId,
  onClearInitialEditingId,
}: EventEditorTabProps) {
  const { showFeedback } = useFeedback();
  const [editingEventId, setEditingEventId] = useState<string | null>(initialEditingId || null);
  const [activeMenuEventId, setActiveMenuEventId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (initialEditingId) {
      setEditingEventId(initialEditingId);
      onClearInitialEditingId?.();
    }
  }, [initialEditingId, onClearInitialEditingId]);

  // 新規イベント作成 (DBにはまだ作成せずエディターを開く)
  const handleCreateNewEvent = () => {
    setEditingEventId('new');
  };

  // イベント削除
  const handleDeleteEvent = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveMenuEventId(null);
    if (!window.confirm('このイベントを削除してもよろしいですか？この操作は取り消せません。')) {
      return;
    }

    setDeletingId(id);
    try {
      const res = await apiClient.delete(`/api/events/${id}`);
      if (!res.ok) throw new Error('削除に失敗しました');

      showFeedback('イベントを削除しました', { type: 'success', mode: 'toast' });
      await onRefresh();
    } catch (err: any) {
      console.error('[EventEditorTab] Delete failed:', err);
      showFeedback(`削除エラー: ${err.message}`, { type: 'error', mode: 'banner' });
    } finally {
      setDeletingId(null);
    }
  };

  // 編集画面モードの場合
  if (editingEventId) {
    return (
      <EventEditorForm
        eventId={editingEventId}
        onBack={() => {
          setEditingEventId(null);
          onRefresh();
        }}
        onSaved={onRefresh}
      />
    );
  }

  // ステータスバッジのスタイルヘルパー
  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'published':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-sky-50 text-sky-700 border border-sky-100">
            <Globe className="w-3 h-3 text-sky-500" />
            <span>公開中</span>
          </span>
        );
      case 'archived':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-100">
            <Archive className="w-3 h-3 text-amber-500" />
            <span>アーカイブ</span>
          </span>
        );
      case 'draft':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-100 text-slate-700">
            <FileEdit className="w-3 h-3 text-slate-500" />
            <span>作成中</span>
          </span>
        );
    }
  };

  return (
    <div className="space-y-6 pb-20">
      
      {/* 上部アクションバー */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-3xl border border-slate-100 shadow-xs">
        <div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight">
            イベント一覧
          </h2>
          <p className="text-xs text-slate-400 font-medium mt-0.5">
            最近更新された順に表示されています。クリックして編集を開始できます。
          </p>
        </div>

        <button
          type="button"
          onClick={handleCreateNewEvent}
          className="px-5 py-2.5 bg-[#0284c7] hover:bg-[#0369a1] active:scale-95 text-white font-black text-xs sm:text-sm rounded-xl shadow-md transition-all flex items-center gap-2 cursor-pointer self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          <span>新規イベント作成</span>
        </button>
      </div>

      {/* イベントリスト */}
      {isLoading ? (
        <div className="space-y-3 animate-pulse">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 bg-white rounded-2xl border border-slate-100" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-100 p-12 text-center text-slate-400 space-y-3">
          <p className="text-sm font-bold">イベントがまだ登録されていません</p>
          <button
            type="button"
            onClick={handleCreateNewEvent}
            className="px-4 py-2 bg-sky-50 text-sky-600 hover:bg-sky-100 font-bold text-xs rounded-xl transition-colors inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>最初のイベントを作成する</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((event) => {
            const isMenuOpen = activeMenuEventId === event.id;
            const isDeleting = deletingId === event.id;

            return (
              <div
                key={event.id}
                onClick={() => setEditingEventId(event.id)}
                className="bg-white rounded-2xl md:rounded-3xl border border-slate-100/90 hover:border-sky-200 hover:shadow-md transition-all duration-200 p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 cursor-pointer group relative"
              >
                {/* 左側: サムネイル + タイトル + 補足情報 */}
                <div className="flex items-center gap-4 min-w-0 flex-1">
                  
                  {/* サムネイル画像 */}
                  <div
                    className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden bg-gradient-to-br from-sky-50 to-slate-100 shrink-0 flex items-center justify-center border border-slate-150/60 p-2"
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
                        className="w-10 h-10 object-contain drop-shadow-xs"
                      />
                    )}
                  </div>

                  {/* テキスト情報 */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {getStatusBadge((event as any).status)}
                    </div>

                    <h3 className="font-bold text-slate-900 text-sm sm:text-base group-hover:text-sky-600 transition-colors truncate">
                      {event.title || '無題のイベント'}
                    </h3>

                    <div className="flex items-center gap-4 text-xs text-slate-400 flex-wrap pt-0.5">
                      <span className="flex items-center gap-1 font-medium">
                        <Calendar className="w-3.5 h-3.5 text-slate-400" />
                        <span>{event.event_date_text || '日時未設定'}</span>
                      </span>

                      {event.host?.name && (
                        <span className="flex items-center gap-1 font-medium">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          <span>{event.host.name}</span>
                        </span>
                      )}
                    </div>
                  </div>

                </div>

                {/* 右側: 更新日時 + メニューボタン */}
                <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-50">
                  <div className="text-[11px] text-slate-400">
                    {event.metadata?.updated_at || (event as any).updated_at ? (
                      <span>更新: {new Date((event as any).updated_at || event.metadata?.updated_at).toLocaleDateString()}</span>
                    ) : null}
                  </div>

                  {/* 「...」メニューボタン */}
                  <div className="relative">
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuEventId(isMenuOpen ? null : event.id);
                      }}
                      className="w-8 h-8 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer"
                      title="メニューを開く"
                    >
                      {isDeleting ? (
                        <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
                      ) : (
                        <MoreVertical className="w-4 h-4" />
                      )}
                    </button>

                    {/* ドロップダウンメニュー */}
                    {isMenuOpen && (
                      <div
                        className="absolute right-0 top-10 w-36 bg-white rounded-2xl shadow-xl border border-slate-100 py-1.5 z-20 animate-in fade-in zoom-in-95 duration-150"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={(e) => handleDeleteEvent(event.id, e)}
                          className="w-full px-3.5 py-2 text-left text-xs font-bold text-rose-600 hover:bg-rose-50 flex items-center gap-2 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>削除する</span>
                        </button>
                      </div>
                    )}
                  </div>

                </div>

              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
