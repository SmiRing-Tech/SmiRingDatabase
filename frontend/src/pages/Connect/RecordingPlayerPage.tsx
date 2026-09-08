import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Trash2 } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { usePermission } from '../../hooks/usePermission';

interface Recording {
  id: string;
  roomId: string;
  roomTitle: string | null;
  status: string;
  durationSeconds: number | null;
  createdAt: string;
  url: string | null;
  /** 0-99 while compositing; null until the job reports its first step. */
  progress: number | null;
}

export default function RecordingPlayerPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const canDelete = usePermission('connect_recording', 'write');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  // 画面遷移時にスクロール位置を最上部にリセット
  useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector('main')?.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    if (!id) return;
    apiClient
      .get(`/api/connect/recordings/${id}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? '録画の取得に失敗しました');
        }
        setRecording(await response.json());
      })
      .catch((e: any) => setError(e.message ?? '録画の取得に失敗しました'));
  }, [id]);

  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm('この録画を削除してもよろしいですか？\nこの操作は取り消せません。')) {
      return;
    }
    setIsDeleting(true);
    try {
      const res = await apiClient.delete(`/api/connect/recordings/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? '録画の削除に失敗しました');
      }
      navigate('/connect/recordings');
    } catch (err: any) {
      alert(err.message ?? '録画の削除に失敗しました');
      setIsDeleting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-white to-blue-50 px-4 py-8 md:px-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={() => navigate('/connect/recordings')}
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-700 font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all duration-200 active:scale-95"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>録画一覧に戻る</span>
          </button>

          {canDelete && (
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="flex items-center gap-2 px-4 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all duration-200 active:scale-95 disabled:opacity-50"
              title="録画を削除"
            >
              {isDeleting ? (
                <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              <span>削除</span>
            </button>
          )}
        </div>

        {error && (
          <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm font-semibold text-red-700 shadow-sm">
            {error}
          </div>
        )}

        {!recording && !error && (
          <div className="flex justify-center py-32">
            <Loader2 className="w-8 h-8 animate-spin text-sky-600" />
          </div>
        )}

        {recording && recording.url && (
          <div className="bg-white rounded-3xl p-5 md:p-6 shadow-sm border border-gray-100 space-y-4">
            <div className="rounded-2xl overflow-hidden shadow-lg bg-black aspect-video">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={recording.url} controls autoPlay className="w-full h-full object-contain" />
            </div>
            <div className="pt-2">
              <h1 className="text-xl md:text-2xl font-black text-gray-900 tracking-tight">
                {recording.roomTitle || recording.roomId}
              </h1>
              <p className="text-sm text-gray-500 font-semibold mt-1">
                {new Date(recording.createdAt).toLocaleString('ja-JP')}
              </p>
            </div>
          </div>
        )}

        {recording && !recording.url && (
          <div className="px-4 py-4 bg-gray-50 border border-gray-200 rounded-2xl text-sm font-semibold text-gray-600">
            {recording.status === 'failed'
              ? 'この録画は合成に失敗したため再生できません。'
              : recording.status === 'recording'
                ? 'この録画はまだ録画中です。'
                : `準備中です${recording.progress != null ? `（${recording.progress}%）` : ''}。完了するまでお待ちください。`}
          </div>
        )}
      </div>
    </div>
  );
}
