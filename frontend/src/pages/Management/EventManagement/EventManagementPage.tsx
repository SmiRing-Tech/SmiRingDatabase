import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Globe, FileEdit, BarChart3 } from 'lucide-react';
import { apiClient } from '../../../lib/apiClient';
import { useFeedback } from '../../../context/FeedbackContext';
import type { EventItem } from '../../Events/eventDummyData';
import EventPublishTab from './EventPublishTab';
import EventEditorTab from './EventEditorTab';
import EventOperationTab from './EventOperationTab';

type TabKey = 'publish' | 'edit' | 'operation';

export default function EventManagementPage() {
  const navigate = useNavigate();
  const { showFeedback } = useFeedback();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as TabKey) || 'publish';

  const setActiveTab = (tab: TabKey) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (tab === 'publish') {
          next.delete('tab');
        } else {
          next.set('tab', tab);
        }
        return next;
      },
      { replace: true }
    );
  };

  const [events, setEvents] = useState<EventItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedEditEventId, setSelectedEditEventId] = useState<string | null>(null);

  // 全イベントデータ取得
  const fetchAllEvents = useCallback(async () => {
    try {
      const res = await apiClient.get('/api/events/all');
      if (res.ok) {
        const data = await res.json();
        setEvents(data || []);
      } else {
        console.warn('[EventManagementPage] Failed to fetch events');
      }
    } catch (err) {
      console.error('[EventManagementPage] Error fetching events:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllEvents();
  }, [fetchAllEvents]);

  // 公開ステータス変更ハンドラー
  const handleStatusChange = async (
    eventId: string,
    newStatus: 'draft' | 'published' | 'archived'
  ) => {
    try {
      const res = await apiClient.patch(`/api/events/${eventId}`, {
        status: newStatus,
      });
      if (!res.ok) throw new Error('ステータスの更新に失敗しました');

      const statusLabels = {
        draft: '作成中にしました',
        published: '公開中に変更しました',
        archived: 'アーカイブに変更しました',
      };

      showFeedback(statusLabels[newStatus], { type: 'success', mode: 'toast' });
      await fetchAllEvents();
    } catch (err: any) {
      console.error('[EventManagementPage] Status change failed:', err);
      showFeedback(`更新エラー: ${err.message}`, { type: 'error', mode: 'banner' });
    }
  };

  // 公開設定モーダルから編集画面への遷移ハンドラー
  const handleGoToEdit = (eventId: string) => {
    setSelectedEditEventId(eventId);
    setActiveTab('edit');
  };

  return (
    <div className="min-h-full w-full bg-slate-50/40 p-6 md:p-10">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* ページヘッダー */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-black text-slate-900 tracking-tight">
              イベント管理
            </h1>
            <p className="text-xs md:text-sm text-slate-500 mt-1 font-medium">
              イベントの作成・編集、公開ステータスの設定、運営アナリティクスを管理できます。
            </p>
          </div>

          <button
            type="button"
            onClick={() => navigate('/apps')}
            className="self-start sm:self-auto flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-600 font-bold text-xs sm:text-sm rounded-xl shadow-xs transition-all duration-200 cursor-pointer active:scale-95"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>アプリ一覧へ戻る</span>
          </button>
        </div>

        {/* タブナビゲーション */}
        <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-150 p-2 shadow-xs flex items-center gap-2 overflow-x-auto">
          
          <button
            type="button"
            onClick={() => setActiveTab('publish')}
            className={`flex-1 min-w-[140px] py-3 px-4 rounded-xl font-black text-xs sm:text-sm transition-all flex items-center justify-center gap-2 cursor-pointer ${
              activeTab === 'publish'
                ? 'bg-sky-500 text-white shadow-md shadow-sky-200'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <Globe className="w-4 h-4" />
            <span>公開設定</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('edit')}
            className={`flex-1 min-w-[140px] py-3 px-4 rounded-xl font-black text-xs sm:text-sm transition-all flex items-center justify-center gap-2 cursor-pointer ${
              activeTab === 'edit'
                ? 'bg-sky-500 text-white shadow-md shadow-sky-200'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <FileEdit className="w-4 h-4" />
            <span>イベント作成・編集</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('operation')}
            className={`flex-1 min-w-[140px] py-3 px-4 rounded-xl font-black text-xs sm:text-sm transition-all flex items-center justify-center gap-2 cursor-pointer ${
              activeTab === 'operation'
                ? 'bg-sky-500 text-white shadow-md shadow-sky-200'
                : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span>運営</span>
            <span className={`text-[9px] px-1.5 py-0.2 rounded-full uppercase font-black ${
              activeTab === 'operation' ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
            }`}>
              Soon
            </span>
          </button>

        </div>

        {/* タブコンテンツ */}
        <div className="pt-2">
          {activeTab === 'publish' && (
            <EventPublishTab
              events={events}
              isLoading={isLoading}
              onRefresh={fetchAllEvents}
              onStatusChange={handleStatusChange}
              onEditEvent={handleGoToEdit}
            />
          )}

          {activeTab === 'edit' && (
            <EventEditorTab
              events={events}
              isLoading={isLoading}
              onRefresh={fetchAllEvents}
              initialEditingId={selectedEditEventId}
              onClearInitialEditingId={() => setSelectedEditEventId(null)}
            />
          )}

          {activeTab === 'operation' && (
            <EventOperationTab />
          )}
        </div>

      </div>
    </div>
  );
}
