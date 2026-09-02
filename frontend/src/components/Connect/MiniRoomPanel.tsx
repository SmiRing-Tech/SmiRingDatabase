import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, DoorOpen, Plus, LogOut } from 'lucide-react';
import BreakoutRoomCreateDialog from './BreakoutRoomCreateDialog';
import type { UseMiniRoomsResult } from '../../hooks/useMiniRooms';

function getErrorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

interface MiniRoomPanelProps {
  isOpen: boolean;
  onClose: () => void;
  isHost: boolean;
  mainRoomId: string;
  miniRooms: UseMiniRoomsResult;
}

/**
 * Entry point opened by the control bar's "ミニルーム" button, for every participant
 * (host and non-host alike). Branches into three views:
 *  - host, no active session yet -> BreakoutRoomCreateDialog (the initial-batch form)
 *  - host, session active -> HostManagementView (add rooms, move people, close)
 *  - non-host -> ParticipantPickerView (join / return to main, per the session's
 *    allow_self_assign flag)
 */
export default function MiniRoomPanel({ isOpen, onClose, isHost, mainRoomId, miniRooms }: MiniRoomPanelProps) {
  // Host roster polling only runs while this panel is actually open.
  useEffect(() => {
    if (!isHost) return;
    miniRooms.setParticipantPollingEnabled(isOpen);
    return () => miniRooms.setParticipantPollingEnabled(false);
  }, [isOpen, isHost, miniRooms]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  if (isHost && miniRooms.rooms.length === 0) {
    return (
      <BreakoutRoomCreateDialog
        isOpen={isOpen}
        onClose={onClose}
        onCreate={(rooms, allowSelfAssign) => miniRooms.createRooms(rooms.map((r) => r.name), allowSelfAssign)}
      />
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      />

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
            <h3 className="text-base font-black tracking-tight text-gray-100">ミニルーム</h3>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              {isHost ? 'ルームの管理と参加者の移動ができます' : '参加するルームを選んでください'}
            </p>
          </div>
        </div>

        {isHost ? (
          <HostManagementView mainRoomId={mainRoomId} miniRooms={miniRooms} />
        ) : (
          <ParticipantPickerView mainRoomId={mainRoomId} miniRooms={miniRooms} onDone={onClose} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function HostManagementView({
  mainRoomId,
  miniRooms,
}: {
  mainRoomId: string;
  miniRooms: UseMiniRoomsResult;
}) {
  const [newRoomName, setNewRoomName] = useState('');
  const [allowSelfAssignDraft, setAllowSelfAssignDraft] = useState(miniRooms.allowSelfAssign);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAllowSelfAssignDraft(miniRooms.allowSelfAssign);
  }, [miniRooms.allowSelfAssign]);

  const participantCounts = useMemo(() => {
    const counts = new Map<string, number>();
    miniRooms.participants.forEach((p) => {
      counts.set(p.currentRoomId, (counts.get(p.currentRoomId) ?? 0) + 1);
    });
    return counts;
  }, [miniRooms.participants]);

  const destinationOptions = [{ id: mainRoomId, name: 'メインルーム' }, ...miniRooms.rooms];

  const handleAddRoom = async () => {
    const name = newRoomName.trim();
    if (!name) return;
    setError(null);
    setAdding(true);
    try {
      await miniRooms.createRooms([name], allowSelfAssignDraft);
      setNewRoomName('');
    } catch (e) {
      setError(getErrorMessage(e, 'ルームの追加に失敗しました'));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {miniRooms.rooms.map((room) => (
          <div
            key={room.id}
            className="flex items-center justify-between gap-2 bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5"
          >
            <div>
              <p className="text-sm font-bold text-gray-100">{room.name}</p>
              <p className="text-[10px] text-gray-500">{participantCounts.get(room.id) ?? 0}人</p>
            </div>
            <button
              onClick={() =>
                miniRooms.closeMiniRoom(room.id).catch((e) => setError(getErrorMessage(e, 'ルームの終了に失敗しました')))
              }
              className="text-[10px] font-bold text-gray-400 hover:text-rose-400 transition-colors"
            >
              終了
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newRoomName}
          onChange={(e) => setNewRoomName(e.target.value)}
          placeholder="新しいルーム名"
          className="flex-1 min-w-0 bg-gray-800/60 border border-gray-700/60 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none"
        />
        <button
          onClick={handleAddRoom}
          disabled={adding || !newRoomName.trim()}
          className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors shrink-0"
          title="ルームを追加"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <label className="flex items-start gap-2.5 px-1 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={allowSelfAssignDraft}
          onChange={(e) => setAllowSelfAssignDraft(e.target.checked)}
          className="mt-0.5 w-3.5 h-3.5 rounded accent-indigo-500"
        />
        <span className="text-xs text-gray-300 leading-relaxed">
          参加者が自分で入るルームを選べるようにする（次にルームを追加した時に反映されます）
        </span>
      </label>

      {miniRooms.participants.length > 0 && (
        <div className="space-y-1.5 pt-3 border-t border-gray-800">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">参加者</p>
          {miniRooms.participants.map((p) => (
            <div key={p.identity} className="flex items-center justify-between gap-2 py-1">
              <span className="text-xs font-semibold text-gray-200 truncate">{p.name}</span>
              <select
                value={p.currentRoomId}
                onChange={(e) =>
                  miniRooms
                    .moveOther(p.identity, e.target.value)
                    .catch((err) => setError(getErrorMessage(err, '移動に失敗しました')))
                }
                className="bg-gray-900/80 border border-gray-700/80 rounded-lg text-[11px] text-gray-200 px-2 py-1 focus:outline-none max-w-[8.5rem]"
              >
                {destinationOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-rose-400 leading-relaxed">{error}</p>}

      <button
        onClick={() =>
          miniRooms.closeSession().catch((e) => setError(getErrorMessage(e, 'セッションの終了に失敗しました')))
        }
        className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 text-xs font-bold transition-colors"
      >
        セッションを終了（全員をメインルームに戻す）
      </button>
    </div>
  );
}

function ParticipantPickerView({
  mainRoomId,
  miniRooms,
  onDone,
}: {
  mainRoomId: string;
  miniRooms: UseMiniRoomsResult;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMove = async (destinationRoomId: string) => {
    setError(null);
    setBusy(true);
    try {
      await miniRooms.moveSelf(destinationRoomId);
      onDone();
    } catch (e) {
      setError(getErrorMessage(e, '移動に失敗しました'));
    } finally {
      setBusy(false);
    }
  };

  const currentRoomName = miniRooms.rooms.find((r) => r.id === miniRooms.currentRoomId)?.name;

  return (
    <div className="space-y-3">
      {miniRooms.rooms.length === 0 ? (
        <p className="text-xs text-gray-400 leading-relaxed">現在ミニルームは開始されていません。</p>
      ) : miniRooms.allowSelfAssign ? (
        <div className="space-y-2">
          {miniRooms.rooms.map((room) => (
            <button
              key={room.id}
              onClick={() => handleMove(room.id)}
              disabled={busy || miniRooms.currentRoomId === room.id}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-800/60 hover:bg-gray-800 border border-gray-700/60 rounded-xl text-sm font-bold text-gray-100 disabled:opacity-40 transition-colors"
            >
              <span>{room.name}へ参加</span>
              {miniRooms.currentRoomId === room.id && (
                <span className="text-[10px] font-bold text-indigo-400">現在ここ</span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400 leading-relaxed">
          {miniRooms.isInMainRoom
            ? 'ホストがルームを割り当てるまでお待ちください。'
            : `現在「${currentRoomName ?? ''}」にいます。`}
        </p>
      )}

      {error && <p className="text-xs text-rose-400 leading-relaxed">{error}</p>}

      <button
        onClick={() => handleMove(mainRoomId)}
        disabled={busy || miniRooms.isInMainRoom}
        className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-gray-700 text-gray-300 hover:text-white hover:border-gray-600 disabled:opacity-40 text-xs font-bold transition-colors"
      >
        <LogOut className="w-3.5 h-3.5" />
        <span>メインルームに戻る</span>
      </button>
    </div>
  );
}
