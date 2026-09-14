import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Trash2, X } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { usePermission } from '../../hooks/usePermission';
import { CustomDropdown, type DropdownOption } from '../ui/CustomDropdown';

interface ViewerCandidate {
  id: string;
  name: string;
}

interface RecordingReviewModalProps {
  /** The pending_review recording to resolve, or null to keep the modal closed. */
  recordingId: string | null;
  /** Prefills the title field — the meeting's own title, usually. */
  defaultTitle: string;
  /** Called once the recording has been saved or discarded, or the user picks "later"
   *  (it just stays pending_review, reachable again from the recordings list or the
   *  in-room chevron menu). `resolved` is true for save/discard (the recording is no longer
   *  pending — callers should stop tracking it), false for "later"/close (still
   *  pending_review — callers should keep offering a way back in, e.g. the chevron menu). */
  onDone: (resolved: boolean) => void;
}

function toOptions(candidates: ViewerCandidate[]): DropdownOption[] {
  return candidates.map((c) => ({ label: c.name, value: c.id }));
}

/**
 * "録画が完了しました" — shown only to whoever stopped (or, on the end-of-call safety net,
 * started) a recording, letting them name it and choose who can watch it before it's
 * composited, or throw it away outright. Reused by CallRoomPage (right after stopping, and
 * from the in-room chevron menu for one left pending), and RecordingsListPage (resolving one
 * left pending from a call that ended without anyone deciding).
 */
export default function RecordingReviewModal({ recordingId, defaultTitle, onDone }: RecordingReviewModalProps) {
  const canAct = usePermission('connect_recording', 'write');
  const [title, setTitle] = useState(defaultTitle);
  const [step, setStep] = useState<'review' | 'confirmDiscard'>('review');
  const [loading, setLoading] = useState<'save' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Viewer candidates, split into this meeting's own audience (default: everyone in it can
  // watch) and everyone else (default: nobody, opt-in).
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [roomAudience, setRoomAudience] = useState<ViewerCandidate[]>([]);
  const [others, setOthers] = useState<ViewerCandidate[]>([]);
  const [roomAudienceIds, setRoomAudienceIds] = useState<string[]>([]);
  const [otherIds, setOtherIds] = useState<string[]>([]);

  // Reset local state every time a new recording comes up for review.
  useEffect(() => {
    setTitle(defaultTitle);
    setStep('review');
    setError(null);
    setLoading(null);
    setRoomAudience([]);
    setOthers([]);
    setRoomAudienceIds([]);
    setOtherIds([]);

    if (!recordingId || !canAct) return;
    setLoadingCandidates(true);
    apiClient
      .get(`/api/connect/recordings/${recordingId}/viewer-candidates`)
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const body = await res.json();
        const audience: ViewerCandidate[] = body.roomAudience ?? [];
        setRoomAudience(audience);
        setOthers(body.others ?? []);
        // Default: everyone this meeting is already visible to can also watch its recording.
        setRoomAudienceIds(audience.map((m) => m.id));
      })
      .catch(() => {
        // Non-fatal — the dropdowns just come up empty, and confirm still works (the recording
        // simply ends up visible only to its owners until someone edits the list later).
      })
      .finally(() => setLoadingCandidates(false));
  }, [recordingId, defaultTitle, canAct]);

  if (!recordingId || typeof document === 'undefined') return null;

  const handleSave = async () => {
    setLoading('save');
    setError(null);
    try {
      const res = await apiClient.post(`/api/connect/recordings/${recordingId}/confirm`, {
        title,
        viewerIds: [...roomAudienceIds, ...otherIds],
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? '録画の保存に失敗しました');
      }
      onDone(true);
    } catch (e: any) {
      setError(e.message ?? '録画の保存に失敗しました');
      setLoading(null);
    }
  };

  const handleDiscard = async () => {
    setLoading('discard');
    setError(null);
    try {
      const res = await apiClient.post(`/api/connect/recordings/${recordingId}/discard`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? '録画の破棄に失敗しました');
      }
      onDone(true);
    } catch (e: any) {
      setError(e.message ?? '録画の破棄に失敗しました');
      setLoading(null);
    }
  };

  const busy = loading !== null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        onClick={() => {
          if (!busy) onDone(false);
        }}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      />

      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-3xl shadow-2xl p-6 text-white space-y-4 animate-in zoom-in-95 duration-200 z-10 max-h-[90vh] overflow-y-auto"
      >
        <button
          onClick={() => {
            if (!busy) onDone(false);
          }}
          disabled={busy}
          className="absolute top-4 right-4 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          title="後で決める"
        >
          <X className="w-4 h-4" />
        </button>

        {step === 'review' ? (
          <>
            <div className="flex flex-col items-center text-center space-y-1.5">
              <div className="w-14 h-14 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shadow-lg shadow-sky-950/40 mb-1">
                <CheckCircle2 className="w-7 h-7" />
              </div>
              <h3 className="text-lg font-black tracking-tight text-gray-100">録画が完了しました！</h3>
              <p className="text-xs text-gray-400 leading-relaxed max-w-[300px]">
                保存するとタイトル・閲覧できる人を設定して動画の合成を開始します。不要であれば破棄できます。
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="recording-review-title" className="block text-[11px] font-bold text-gray-400">
                タイトル
              </label>
              <input
                id="recording-review-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy || !canAct}
                maxLength={200}
                placeholder="ミーティング"
                className="w-full px-3 py-2.5 bg-gray-800/80 border border-gray-700 rounded-xl text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-500/50 disabled:opacity-50"
              />
            </div>

            {canAct && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-bold text-gray-400">
                    このミーティングに表示されている人のうち、見れる人
                  </label>
                  <CustomDropdown
                    multiple
                    searchable
                    options={toOptions(roomAudience)}
                    value={roomAudienceIds}
                    onChange={setRoomAudienceIds}
                    placeholder={loadingCandidates ? '読み込み中...' : '誰も対象がいません'}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-bold text-gray-400">それ以外で見れる人を追加</label>
                  <CustomDropdown
                    multiple
                    searchable
                    options={toOptions(others)}
                    value={otherIds}
                    onChange={setOtherIds}
                    placeholder={loadingCandidates ? '読み込み中...' : '追加する人を選択（任意）'}
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="text-xs font-semibold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">
                {error}
              </p>
            )}

            {!canAct && (
              <p className="text-xs font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
                この録画の保存・破棄には権限が必要です。権限を持つホストに依頼してください。
              </p>
            )}

            <div className="space-y-2 pt-1">
              <button
                type="button"
                disabled={busy || !canAct}
                onClick={handleSave}
                className="w-full py-2.5 px-4 bg-sky-600 hover:bg-sky-500 disabled:opacity-75 disabled:cursor-not-allowed text-white font-bold text-xs rounded-xl shadow-lg shadow-sky-950/50 transition-all active:scale-95 flex items-center justify-center gap-1.5"
              >
                {loading === 'save' ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>保存中...</span>
                  </>
                ) : (
                  <span>保存する</span>
                )}
              </button>
              <div className="flex gap-2.5">
                <button
                  type="button"
                  disabled={busy || !canAct}
                  onClick={() => setStep('confirmDiscard')}
                  className="flex-1 py-2.5 px-4 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-300 hover:text-rose-300 font-bold text-xs rounded-xl border border-gray-700 transition-all active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>破棄する</span>
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDone(false)}
                  className="flex-1 py-2.5 px-4 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-300 hover:text-white font-bold text-xs rounded-xl border border-gray-700 transition-all active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span>あとで決める</span>
                </button>
              </div>
              <p className="text-[10px] text-gray-500 text-center leading-relaxed pt-0.5">
                あとで決めた場合も、下部メニューまたは録画一覧からいつでも設定できます
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col items-center text-center space-y-1.5">
              <div className="w-14 h-14 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-500 shadow-lg shadow-rose-950/40 mb-1">
                <AlertTriangle className="w-7 h-7" />
              </div>
              <h3 className="text-lg font-black tracking-tight text-gray-100">本当に破棄しますか？</h3>
              <p className="text-xs text-gray-400 leading-relaxed max-w-[260px]">
                この録画の動画データはすべて削除され、元に戻せません。
              </p>
            </div>

            {error && (
              <p className="text-xs font-semibold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-xl px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex gap-2.5 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep('review')}
                className="flex-1 py-2.5 px-4 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-300 hover:text-white font-bold text-xs rounded-xl border border-gray-700 transition-all active:scale-95"
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleDiscard}
                className="flex-1 py-2.5 px-4 bg-rose-600 hover:bg-rose-500 disabled:opacity-75 disabled:cursor-not-allowed text-white font-bold text-xs rounded-xl shadow-lg shadow-rose-950/50 transition-all active:scale-95 flex items-center justify-center gap-1.5"
              >
                {loading === 'discard' ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>破棄中...</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>破棄する</span>
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
