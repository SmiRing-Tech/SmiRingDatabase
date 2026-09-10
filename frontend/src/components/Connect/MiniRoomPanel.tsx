import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, DoorOpen, Plus, LogOut, ChevronRight, ChevronDown } from 'lucide-react';
import BreakoutRoomCreateDialog from './BreakoutRoomCreateDialog';
import { CustomDropdown, type DropdownOption } from '../ui/CustomDropdown';
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
  const [justCreated, setJustCreated] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // Host roster polling only runs while this panel is actually open.
  useEffect(() => {
    if (!isHost) return;
    miniRooms.setParticipantPollingEnabled(isOpen);
    return () => miniRooms.setParticipantPollingEnabled(false);
  }, [isOpen, isHost, miniRooms]);

  useEffect(() => {
    if (!isOpen) {
      setJustCreated(false);
      setIsCreating(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  // 作成処理中（isCreating === true）は、roomsが更新されてもダイアログをアンマウントさせず、
  // 参加者割り振り・ホスト自身の移動が完全に完了するまでダイアログを維持する
  if (isHost && (miniRooms.rooms.length === 0 || isCreating)) {
    return (
      <BreakoutRoomCreateDialog
        isOpen={isOpen}
        onClose={onClose}
        onCreate={(rooms, allowSelfAssign) => miniRooms.createRooms(rooms.map((r) => r.name), allowSelfAssign)}
        miniRooms={miniRooms}
        mainRoomId={mainRoomId}
        onCreatingStart={() => setIsCreating(true)}
        onCreatingEnd={() => setIsCreating(false)}
        onSessionCreated={() => {
          setJustCreated(true);
        }}
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
        className="relative w-full max-w-md h-[520px] max-h-[85vh] bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-3xl shadow-2xl p-6 text-white flex flex-col animate-in zoom-in-95 duration-200 z-10"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title="閉じる"
        >
          <X className="w-4 h-4" />
        </button>

        {isHost ? (
          <HostManagementView
            mainRoomId={mainRoomId}
            miniRooms={miniRooms}
            initialExpandAll={justCreated}
          />
        ) : (
          <>
            <div className="flex items-center gap-3 pr-6 shrink-0">
              <div className="w-11 h-11 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
                <DoorOpen className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-black tracking-tight text-gray-100">ミニルーム</h3>
                <p className="text-[11px] text-gray-400 leading-relaxed">
                  参加するルームを選んでください
                </p>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 py-4">
              <ParticipantPickerView mainRoomId={mainRoomId} miniRooms={miniRooms} onDone={onClose} />
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function HostManagementView({
  mainRoomId,
  miniRooms,
  initialExpandAll = false,
}: {
  mainRoomId: string;
  miniRooms: UseMiniRoomsResult;
  initialExpandAll?: boolean;
}) {
  const [allowSelfAssignDraft, setAllowSelfAssignDraft] = useState(miniRooms.allowSelfAssign);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 作成画面から遷移してきた時のみ、すべてのルームのアコーディオンを開いて初期化
  const [expandedRooms, setExpandedRooms] = useState<Record<string, boolean>>(() => {
    if (initialExpandAll) {
      const all: Record<string, boolean> = { main: true };
      miniRooms.rooms.forEach((r) => {
        all[r.id] = true;
      });
      return all;
    }
    return {};
  });

  useEffect(() => {
    if (initialExpandAll && miniRooms.rooms.length > 0) {
      setExpandedRooms((prev) => {
        const next: Record<string, boolean> = { ...prev, main: true };
        miniRooms.rooms.forEach((r) => {
          next[r.id] = true;
        });
        return next;
      });
    }
  }, [initialExpandAll, miniRooms.rooms]);

  const toggleRoom = (id: string) => {
    setExpandedRooms((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  useEffect(() => {
    setAllowSelfAssignDraft(miniRooms.allowSelfAssign);
  }, [miniRooms.allowSelfAssign]);

  const participantsByRoom = useMemo(() => {
    const map = new Map<string, typeof miniRooms.participants>();
    map.set(mainRoomId, []);
    miniRooms.rooms.forEach((r) => map.set(r.id, []));

    miniRooms.participants.forEach((p) => {
      const list = map.get(p.currentRoomId) || [];
      list.push(p);
      map.set(p.currentRoomId, list);
    });
    return map;
  }, [mainRoomId, miniRooms.rooms, miniRooms.participants]);

  const destinationOptions: DropdownOption[] = useMemo(() => {
    return [
      { label: 'メインルーム', value: mainRoomId },
      ...miniRooms.rooms.map((r) => ({ label: r.name, value: r.id })),
    ];
  }, [mainRoomId, miniRooms.rooms]);

  const handleAddRoom = async () => {
    setError(null);
    setAdding(true);
    try {
      const nextNum = miniRooms.rooms.length + 1;
      await miniRooms.createRooms([`ルーム${nextNum}`], allowSelfAssignDraft);
    } catch (e) {
      setError(getErrorMessage(e, 'ルームの追加に失敗しました'));
    } finally {
      setAdding(false);
    }
  };

  const mainRoomParticipants = participantsByRoom.get(mainRoomId) ?? [];

  return (
    <>
      {/* Header (Fixed) */}
      <div className="flex items-center justify-between gap-3 pr-8 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
            <DoorOpen className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-black tracking-tight text-gray-100 truncate">ミニルーム</h3>
            <p className="text-[11px] text-gray-400 leading-relaxed truncate">
              ルームの管理と参加者の移動ができます
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleAddRoom}
          disabled={adding}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-400 hover:text-sky-300 text-xs font-bold transition-all shrink-0 active:scale-95 shadow-sm disabled:opacity-40"
          title="ルームを追加"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{adding ? '追加中...' : 'ルーム追加'}</span>
        </button>
      </div>

      {/* Room List (Scrollable Area) */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 py-4 space-y-2.5">
        {/* Main Room Tile (Fixed at top, non-deletable) */}
        <div className="bg-gray-800/70 border border-gray-700/70 rounded-xl overflow-hidden transition-all">
          <div
            onClick={() => toggleRoom('main')}
            className="flex items-center justify-between gap-2 p-2.5 cursor-pointer hover:bg-gray-800/90 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRoom('main');
                }}
                className="p-1 -m-1 rounded-lg text-gray-400 hover:text-white transition-colors shrink-0"
                title={expandedRooms['main'] ? '閉じる' : '参加者を表示'}
              >
                <ChevronRight
                  className={`w-4 h-4 transition-transform duration-200 ${
                    expandedRooms['main'] ? 'rotate-90 text-sky-400' : ''
                  }`}
                />
              </button>
              <span className="text-sm font-bold text-gray-100">メインルーム</span>
              <span className="text-xs font-bold text-sky-400">({mainRoomParticipants.length})</span>
            </div>
            <span className="text-[10px] font-semibold text-gray-400 px-2 py-0.5 rounded-full bg-gray-700/50">
              メイン
            </span>
          </div>

          {expandedRooms['main'] && (
            <div className="px-3 pb-2.5 pt-1 border-t border-gray-700/40 bg-gray-900/40">
              {mainRoomParticipants.length === 0 ? (
                <p className="text-[11px] text-gray-500 py-1 pl-6">参加者はいません</p>
              ) : (
                <div className="space-y-1.5 pl-2 pt-1">
                  {mainRoomParticipants.map((p) => (
                    <div key={p.identity} className="flex items-center justify-between gap-2 py-1 pl-2 pr-1">
                      <div className="flex items-center gap-2 min-w-0">
                        {p.avatarUrl ? (
                          <img src={p.avatarUrl} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                            {p.name.charAt(0)}
                          </div>
                        )}
                        <span className="font-medium text-xs text-gray-200 truncate">{p.name}</span>
                      </div>
                      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                        <CustomDropdown
                          options={destinationOptions}
                          value={p.currentRoomId}
                          onChange={(newRoomId) => {
                            miniRooms
                              .moveOther(p.identity, newRoomId)
                              .catch((err) => setError(getErrorMessage(err, '移動に失敗しました')));
                          }}
                          minMenuWidth={140}
                          fontSize="text-xs"
                          customTrigger={(isOpen) => (
                            <button
                              type="button"
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-700/60 hover:bg-gray-700 text-gray-300 hover:text-white text-[11px] font-medium transition-colors shrink-0"
                            >
                              <span>ルーム移動</span>
                              <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                            </button>
                          )}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Mini Room Tiles */}
        {miniRooms.rooms.map((room) => {
          const roomParticipants = participantsByRoom.get(room.id) ?? [];
          return (
            <div
              key={room.id}
              className="bg-gray-800/60 border border-gray-700/60 rounded-xl overflow-hidden transition-all"
            >
              <div
                onClick={() => toggleRoom(room.id)}
                className="flex items-center justify-between gap-2 p-2.5 cursor-pointer hover:bg-gray-800/80 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRoom(room.id);
                    }}
                    className="p-1 -m-1 rounded-lg text-gray-400 hover:text-white transition-colors shrink-0"
                    title={expandedRooms[room.id] ? '閉じる' : '参加者を表示'}
                  >
                    <ChevronRight
                      className={`w-4 h-4 transition-transform duration-200 ${
                        expandedRooms[room.id] ? 'rotate-90 text-sky-400' : ''
                      }`}
                    />
                  </button>
                  <span className="text-sm font-bold text-gray-100 truncate">{room.name}</span>
                  <span className="text-xs font-semibold text-gray-400 shrink-0">({roomParticipants.length})</span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    miniRooms
                      .closeMiniRoom(room.id)
                      .catch((err) => setError(getErrorMessage(err, 'ルームの終了に失敗しました')));
                  }}
                  className="text-[10px] font-bold text-gray-400 hover:text-rose-400 transition-colors px-2 py-1 rounded-lg hover:bg-rose-500/10 shrink-0"
                >
                  終了
                </button>
              </div>

              {expandedRooms[room.id] && (
                <div className="px-3 pb-2.5 pt-1 border-t border-gray-700/40 bg-gray-900/40">
                  {roomParticipants.length === 0 ? (
                    <p className="text-[11px] text-gray-500 py-1 pl-6">参加者はいません</p>
                  ) : (
                    <div className="space-y-1.5 pl-2 pt-1">
                      {roomParticipants.map((p) => (
                        <div key={p.identity} className="flex items-center justify-between gap-2 py-1 pl-2 pr-1">
                          <div className="flex items-center gap-2 min-w-0">
                            {p.avatarUrl ? (
                              <img src={p.avatarUrl} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-sky-500/20 text-sky-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                                {p.name.charAt(0)}
                              </div>
                            )}
                            <span className="font-medium text-xs text-gray-200 truncate">{p.name}</span>
                          </div>
                          <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                            <CustomDropdown
                              options={destinationOptions}
                              value={p.currentRoomId}
                              onChange={(newRoomId) => {
                                miniRooms
                                  .moveOther(p.identity, newRoomId)
                                  .catch((err) => setError(getErrorMessage(err, '移動に失敗しました')));
                              }}
                              minMenuWidth={140}
                              fontSize="text-xs"
                              customTrigger={(isOpen) => (
                                <button
                                  type="button"
                                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-700/60 hover:bg-gray-700 text-gray-300 hover:text-white text-[11px] font-medium transition-colors shrink-0"
                                >
                                  <span>ルーム移動</span>
                                  <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                                </button>
                              )}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer (Fixed) */}
      <div className="shrink-0 pt-3 border-t border-gray-800 space-y-3">
        {/* Toggle switch for allowSelfAssignDraft */}
        <div
          onClick={() => setAllowSelfAssignDraft(!allowSelfAssignDraft)}
          className="flex items-center justify-between gap-3 px-1 cursor-pointer select-none py-1 group"
        >
          <span className="text-xs text-gray-300 group-hover:text-gray-200 transition-colors leading-relaxed">
            参加者が自分で入るルームを選べるようにする（次にルームを追加した時に反映されます）
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={allowSelfAssignDraft}
            onClick={(e) => {
              e.stopPropagation();
              setAllowSelfAssignDraft(!allowSelfAssignDraft);
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              allowSelfAssignDraft ? 'bg-sky-500' : 'bg-gray-700'
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                allowSelfAssignDraft ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

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
    </>
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
                <span className="text-[10px] font-bold text-sky-400">現在ここ</span>
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
