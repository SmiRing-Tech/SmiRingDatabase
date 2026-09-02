import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, DoorOpen, Plus, Trash2 } from 'lucide-react';

interface BreakoutRoomDraft {
  id: string;
  name: string;
}

export interface BreakoutRoomCreateInput {
  name: string;
}

interface BreakoutRoomCreateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (rooms: BreakoutRoomCreateInput[], allowParticipantSelfAssign: boolean) => void | Promise<void>;
}

let nextDraftId = 1;
const makeDraft = (name: string): BreakoutRoomDraft => ({ id: `room_${nextDraftId++}`, name });

/**
 * Mini-room (breakout room) creation form, used by MiniRoomPanel for the initial
 * batch of a session (before any mini room exists). Only rendered for hosts (currently:
 * smiring_member), so there's no per-room host picker here: who is allowed to create
 * mini rooms (and later, per-room capabilities like recording or forced screen share)
 * is a call-wide "host" permission, not something assigned per room.
 */
export default function BreakoutRoomCreateDialog({
  isOpen,
  onClose,
  onCreate,
}: BreakoutRoomCreateDialogProps) {
  // Mounted fresh on every open (and unmounted on close), so the draft below
  // naturally starts blank each time instead of needing a reset effect.
  if (!isOpen || typeof document === 'undefined') return null;
  return <DialogContent onClose={onClose} onCreate={onCreate} />;
}

function DialogContent({
  onClose,
  onCreate,
}: Pick<BreakoutRoomCreateDialogProps, 'onClose' | 'onCreate'>) {
  const [rooms, setRooms] = useState<BreakoutRoomDraft[]>(() => [makeDraft('ルーム1'), makeDraft('ルーム2')]);
  const [allowSelfAssign, setAllowSelfAssign] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const updateRoomName = (id: string, name: string) => {
    setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, name } : r)));
  };

  const addRoom = () => {
    setRooms((prev) => [...prev, makeDraft(`ルーム${prev.length + 1}`)]);
  };

  const removeRoom = (id: string) => {
    setRooms((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
  };

  const canCreate = rooms.every((r) => r.name.trim().length > 0);

  const handleCreate = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await onCreate(
        rooms.map((r) => ({ name: r.name.trim() })),
        allowSelfAssign,
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '作成に失敗しました');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      />

      {/* Dialog Card */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-3xl shadow-2xl p-6 text-white space-y-5 animate-in zoom-in-95 duration-200 z-10 max-h-[85vh] overflow-y-auto"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title="閉じる"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3 pr-6">
          <div className="w-11 h-11 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
            <DoorOpen className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-black tracking-tight text-gray-100">ミニルームを作成</h3>
            <p className="text-[11px] text-gray-400 leading-relaxed">作成するルームを入力してください</p>
          </div>
        </div>

        <div className="space-y-2.5">
          {rooms.map((room, idx) => (
            <div
              key={room.id}
              className="flex items-center gap-2 bg-gray-800/60 border border-gray-700/60 rounded-xl p-2.5"
            >
              <input
                type="text"
                value={room.name}
                onChange={(e) => updateRoomName(room.id, e.target.value)}
                placeholder={`ルーム${idx + 1}`}
                className="flex-1 min-w-0 bg-transparent text-sm font-bold text-gray-100 placeholder-gray-500 focus:outline-none"
              />
              <button
                onClick={() => removeRoom(room.id)}
                disabled={rooms.length <= 1}
                className="p-1.5 rounded-lg text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors shrink-0"
                title="ルームを削除"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          <button
            onClick={addRoom}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600 text-xs font-bold transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>ルームを追加</span>
          </button>
        </div>

        <label className="flex items-start gap-2.5 px-1 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allowSelfAssign}
            onChange={(e) => setAllowSelfAssign(e.target.checked)}
            className="mt-0.5 w-3.5 h-3.5 rounded accent-indigo-500"
          />
          <span className="text-xs text-gray-300 leading-relaxed">
            ルーム作成後、参加者が自分で入るルームを選べるようにする
          </span>
        </label>

        {error && <p className="text-xs text-rose-400 leading-relaxed">{error}</p>}

        <div className="flex gap-2.5 pt-1">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-1 py-2.5 px-4 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-bold text-xs rounded-xl border border-gray-700 transition-all active:scale-95 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canCreate || submitting}
            className="flex-1 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white font-bold text-xs rounded-xl shadow-lg shadow-indigo-950/50 transition-all active:scale-95"
          >
            {submitting ? '作成中...' : '作成'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
