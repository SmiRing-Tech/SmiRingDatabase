import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Film, Loader2, Play, Trash2, Video } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { usePermission } from '../../hooks/usePermission';

interface Recording {
  id: string;
  roomId: string;
  roomTitle: string | null;
  status: 'recording' | 'processing' | 'completed' | 'failed';
  durationSeconds: number | null;
  createdAt: string;
  thumbnailUrl: string | null;
  /** 0-99 while compositing; null until the job reports its first step. */
  progress: number | null;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '';
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

const STATUS_LABEL: Record<Recording['status'], string> = {
  recording: '録画中',
  processing: '準備中',
  completed: '',
  failed: '失敗',
};

// Compositing takes minutes on a long call, so the list refreshes itself while anything is
// still being prepared rather than leaving a stalled-looking card until the page is reloaded.
const PROGRESS_POLL_MS = 5000;

export default function RecordingsListPage() {
  const navigate = useNavigate();
  const canDelete = usePermission('connect_recording', 'write');
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(
    () =>
      apiClient
        .get('/api/connect/recordings')
        .then(async (response) => {
          if (!response.ok) throw new Error('録画一覧の取得に失敗しました');
          const data = await response.json();
          setRecordings(data.recordings ?? []);
        })
        .catch((e: any) => setError(e.message ?? '録画一覧の取得に失敗しました')),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const isPreparing = recordings?.some((r) => r.status === 'recording' || r.status === 'processing') ?? false;
  useEffect(() => {
    if (!isPreparing) return;
    const timer = setInterval(load, PROGRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [isPreparing, load]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!window.confirm('この録画を削除してもよろしいですか？\nこの操作は取り消せません。')) {
      return;
    }
    setDeletingId(id);
    try {
      const res = await apiClient.delete(`/api/connect/recordings/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? '録画の削除に失敗しました');
      }
      setRecordings((prev) => (prev ? prev.filter((r) => r.id !== id) : []));
    } catch (err: any) {
      alert(err.message ?? '録画の削除に失敗しました');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-white to-blue-50 px-4 py-10 md:px-8">
      <div className="max-w-6xl mx-auto space-y-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2 text-sky-600 font-bold text-sm tracking-wide uppercase">
              <Film className="w-4 h-4" />
              <span>SmiRing Connect</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-black text-gray-900 tracking-tight">録画一覧</h1>
          </div>

          <button
            onClick={() => navigate('/connect')}
            className="self-start flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-600 font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all duration-200 active:scale-95"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Connectに戻る</span>
          </button>
        </div>

        {error && (
          <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-2xl text-sm font-semibold text-red-700 shadow-sm">
            {error}
          </div>
        )}

        {!recordings && !error && (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-sky-600" />
          </div>
        )}

        {recordings && recordings.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <Video className="w-10 h-10 mb-3" />
            <p className="text-sm font-semibold">録画はまだありません</p>
          </div>
        )}

        {recordings && recordings.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {recordings.map((recording) => {
              const isPlayable = recording.status === 'completed';
              return (
                <div
                  key={recording.id}
                  onClick={() => isPlayable && navigate(`/connect/recordings/${recording.id}`)}
                  className={`text-left bg-white border border-slate-100 rounded-3xl overflow-hidden shadow-sm hover:shadow-md hover:border-sky-200 transition-all duration-200 group ${
                    isPlayable ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'
                  }`}
                >
                  <div className="relative aspect-video bg-gray-100 flex items-center justify-center overflow-hidden">
                    {recording.thumbnailUrl ? (
                      <img
                        src={recording.thumbnailUrl}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Video className="w-8 h-8 text-gray-300" />
                    )}
                    {isPlayable && (
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                        <div className="w-11 h-11 rounded-full bg-white/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
                          <Play className="w-5 h-5 text-sky-600 ml-0.5" fill="currentColor" />
                        </div>
                      </div>
                    )}
                    {!isPlayable && (
                      <div className="absolute top-2 right-2 px-2 py-1 bg-black/60 rounded-lg text-[10px] font-bold text-white flex items-center gap-1">
                        {recording.status === 'processing' && <Loader2 className="w-3 h-3 animate-spin" />}
                        {STATUS_LABEL[recording.status]}
                        {recording.status === 'processing' && recording.progress != null && (
                          <span className="tabular-nums">{recording.progress}%</span>
                        )}
                      </div>
                    )}
                    {recording.status === 'processing' && (
                      <div className="absolute bottom-0 inset-x-0 h-1.5 bg-black/40">
                        <div
                          className="h-full bg-sky-400 transition-[width] duration-700 ease-out"
                          // Before the job reports anything there is still a visible sliver,
                          // so the bar reads as "started" rather than as not running at all.
                          style={{ width: `${Math.max(recording.progress ?? 0, 3)}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="p-4 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-black text-gray-900 text-sm line-clamp-1 flex-1">
                        {recording.roomTitle || recording.roomId}
                      </h3>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={(e) => handleDelete(e, recording.id)}
                          disabled={deletingId === recording.id}
                          className="p-1.5 -mr-1.5 -mt-1 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0 disabled:opacity-50"
                          title="録画を削除"
                        >
                          {deletingId === recording.id ? (
                            <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-gray-400 font-semibold">
                      <span>{new Date(recording.createdAt).toLocaleDateString('ja-JP')}</span>
                      {recording.durationSeconds && (
                        <>
                          <span>・</span>
                          <span>{formatDuration(recording.durationSeconds)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
