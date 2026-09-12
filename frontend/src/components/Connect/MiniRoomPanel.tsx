import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, DoorOpen, Plus, LogOut, ChevronRight, ChevronDown, Pencil, Check, Loader2 } from 'lucide-react';
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
  const [isCreating, setIsCreating] = useState(false);

  // Host roster polling only runs while this panel is actually open.
  useEffect(() => {
    if (!isHost) return;
    miniRooms.setParticipantPollingEnabled(isOpen);
    return () => miniRooms.setParticipantPollingEnabled(false);
  }, [isOpen, isHost, miniRooms]);

  useEffect(() => {
    if (!isOpen) {
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
}: {
  mainRoomId: string;
  miniRooms: UseMiniRoomsResult;
}) {
  const [adding, setAdding] = useState(false);
  const [closingSession, setClosingSession] = useState(false);
  const [updatingSettings, setUpdatingSettings] = useState(false);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingRoomName, setEditingRoomName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 手動で開閉を切り替えたルームの記録（ユーザー操作を優先）
  const [manuallyToggled, setManuallyToggled] = useState<Record<string, boolean>>({});

  // 参加者（または移動案内中）が1人以上いればデフォルトで開く、0人なら閉じる
  const isRoomExpanded = (roomId: string, count: number) => {
    if (manuallyToggled[roomId] !== undefined) {
      return manuallyToggled[roomId];
    }
    return count > 0;
  };

  const toggleRoom = (roomId: string, currentExpanded: boolean) => {
    setManuallyToggled((prev) => ({ ...prev, [roomId]: !currentExpanded }));
  };

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

  // ミニルームへ案内中（移動待ち）の参加者
  const pendingByRoom = useMemo(() => {
    const map = new Map<string, typeof miniRooms.participants>();
    miniRooms.rooms.forEach((r) => map.set(r.id, []));

    miniRooms.participants.forEach((p) => {
      if (p.pendingRoomId && p.pendingRoomId !== p.currentRoomId) {
        const list = map.get(p.pendingRoomId) || [];
        list.push(p);
        map.set(p.pendingRoomId, list);
      }
    });
    return map;
  }, [miniRooms.rooms, miniRooms.participants]);

  const destinationOptions: DropdownOption[] = useMemo(() => {
    return [
      { label: 'メインルーム', value: mainRoomId },
      ...miniRooms.rooms.map((r) => ({ label: r.name, value: r.id })),
    ];
  }, [mainRoomId, miniRooms.rooms]);

  // 既存のルーム名の中から最大番号を探し、被りを避けて +1 で自動採番
  const handleAddRoom = async () => {
    setError(null);
    setAdding(true);
    try {
      let maxNum = 0;
      for (const r of miniRooms.rooms) {
        const matches = r.name.match(/\d+/g);
        if (matches) {
          for (const m of matches) {
            const n = parseInt(m, 10);
            if (!isNaN(n) && n > maxNum) {
              maxNum = n;
            }
          }
        }
      }
      const nextNum = maxNum > 0 ? maxNum + 1 : miniRooms.rooms.length + 1;
      await miniRooms.createRooms([`ルーム${nextNum}`], miniRooms.allowSelfAssign);
    } catch (e) {
      setError(getErrorMessage(e, 'ルームの追加に失敗しました'));
    } finally {
      setAdding(false);
    }
  };

  // 作成後のルーム名変更
  const handleSaveRoomName = async (miniRoomId: string) => {
    const trimmed = editingRoomName.trim();
    if (!trimmed) {
      setError('ルーム名を入力してください');
      return;
    }
    setError(null);
    try {
      await miniRooms.updateRoomName(miniRoomId, trimmed);
      setEditingRoomId(null);
    } catch (e) {
      setError(getErrorMessage(e, 'ルーム名の変更に失敗しました'));
    }
  };

  // 自由移動設定（allowSelfAssign）の即時変更
  const handleToggleAllowSelfAssign = async () => {
    setError(null);
    setUpdatingSettings(true);
    try {
      await miniRooms.updateAllowSelfAssign(!miniRooms.allowSelfAssign);
    } catch (e) {
      setError(getErrorMessage(e, '設定の更新に失敗しました'));
    } finally {
      setUpdatingSettings(false);
    }
  };

  // セッション終了
  const handleCloseSession = async () => {
    setError(null);
    setClosingSession(true);
    try {
      await miniRooms.closeSession();
    } catch (e) {
      setError(getErrorMessage(e, 'セッションの終了に失敗しました'));
    } finally {
      setClosingSession(false);
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
        {(() => {
          const isMainExpanded = isRoomExpanded('main', mainRoomParticipants.length);
          return (
            <div className="bg-gray-800/70 border border-gray-700/70 rounded-xl overflow-hidden transition-all">
              <div
                onClick={() => toggleRoom('main', isMainExpanded)}
                className="flex items-center justify-between gap-2 p-2.5 cursor-pointer hover:bg-gray-800/90 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRoom('main', isMainExpanded);
                    }}
                    className="p-1 -m-1 rounded-lg text-gray-400 hover:text-white transition-colors shrink-0"
                    title={isMainExpanded ? '閉じる' : '参加者を表示'}
                  >
                    <ChevronRight
                      className={`w-4 h-4 transition-transform duration-200 ${
                        isMainExpanded ? 'rotate-90 text-sky-400' : ''
                      }`}
                    />
                  </button>
                  <span className="text-sm font-bold text-gray-100">メインルーム</span>
                  <span
                    className={`text-xs font-bold shrink-0 ${
                      mainRoomParticipants.length > 0 ? 'text-sky-400' : 'text-gray-100'
                    }`}
                  >
                    ({mainRoomParticipants.length})
                  </span>
                </div>
                <span className="text-[10px] font-semibold text-gray-400 px-2 py-0.5 rounded-full bg-gray-700/50">
                  メイン
                </span>
              </div>

              {isMainExpanded && (
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
                        {p.pendingRoomId && p.pendingRoomId !== p.currentRoomId && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30 shrink-0 whitespace-nowrap">
                            {p.pendingRoomName || 'ミニルーム'}に案内中
                          </span>
                        )}
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
    })()}

        {/* Mini Room Tiles */}
        {miniRooms.rooms.map((room) => {
          const roomParticipants = participantsByRoom.get(room.id) ?? [];
          const pendingParticipants = pendingByRoom.get(room.id) ?? [];
          const isExpanded = isRoomExpanded(room.id, roomParticipants.length + pendingParticipants.length);
          return (
            <div
              key={room.id}
              className="bg-gray-800/60 border border-gray-700/60 rounded-xl overflow-hidden transition-all"
            >
              <div
                onClick={() => toggleRoom(room.id, isExpanded)}
                className="flex items-center justify-between gap-2 p-2.5 cursor-pointer hover:bg-gray-800/80 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRoom(room.id, isExpanded);
                    }}
                    className="p-1 -m-1 rounded-lg text-gray-400 hover:text-white transition-colors shrink-0"
                    title={isExpanded ? '閉じる' : '参加者を表示'}
                  >
                    <ChevronRight
                      className={`w-4 h-4 transition-transform duration-200 ${
                        isExpanded ? 'rotate-90 text-sky-400' : ''
                      }`}
                    />
                  </button>
                  {editingRoomId === room.id ? (
                    <div className="flex items-center gap-1.5 min-w-0" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={editingRoomName}
                        onChange={(e) => setEditingRoomName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveRoomName(room.id);
                          if (e.key === 'Escape') setEditingRoomId(null);
                        }}
                        autoFocus
                        maxLength={40}
                        className="px-2 py-0.5 bg-gray-950 border border-sky-500 rounded-lg text-xs font-bold text-white focus:outline-none w-28"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveRoomName(room.id)}
                        className="p-1 rounded-md text-sky-400 hover:text-white hover:bg-sky-500/20 transition-colors"
                        title="保存"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingRoomId(null)}
                        className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors"
                        title="キャンセル"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-bold text-gray-100 truncate">{room.name}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingRoomId(room.id);
                          setEditingRoomName(room.name);
                        }}
                        className="p-1 -m-1 rounded-md text-gray-400 hover:text-gray-200 hover:bg-gray-700/60 transition-colors"
                        title="ルーム名を変更"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                  <span
                    className={`text-xs font-bold shrink-0 ${
                      roomParticipants.length > 0 ? 'text-sky-400' : 'text-gray-400'
                    }`}
                  >
                    ({roomParticipants.length})
                  </span>
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

              {isExpanded && (
                <div className="px-3 pb-2.5 pt-1 border-t border-gray-700/40 bg-gray-900/40">
                  {roomParticipants.length === 0 && pendingParticipants.length === 0 ? (
                    <p className="text-[11px] text-gray-500 py-1 pl-6">参加者はいません</p>
                  ) : (
                    <div className="space-y-1.5 pl-2 pt-1">
                      {/* 通常在室している参加者 */}
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

                      {/* 移動待ちの参加者（グレーアウト表示） */}
                      {pendingParticipants.map((p) => (
                        <div
                          key={`pending-${p.identity}`}
                          className="flex items-center justify-between gap-2 py-1 pl-2 pr-1 opacity-45 select-none"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {p.avatarUrl ? (
                              <img src={p.avatarUrl} alt="" className="w-5 h-5 rounded-full object-cover shrink-0 grayscale" />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-gray-700 text-gray-400 text-[10px] font-bold flex items-center justify-center shrink-0">
                                {p.name.charAt(0)}
                              </div>
                            )}
                            <span className="font-medium text-xs text-gray-300 truncate">{p.name}</span>
                            <span className="text-[10px] font-medium text-gray-400 shrink-0">
                              （移動待ち）
                            </span>
                          </div>
                          <div className="shrink-0">
                            <span className="inline-block px-2 py-0.5 text-[10px] text-gray-400 bg-gray-800/80 rounded-md border border-gray-700/60">
                              案内中
                            </span>
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
        {/* Toggle switch for allowSelfAssign (Instant Sync) */}
        <div
          onClick={handleToggleAllowSelfAssign}
          className="flex items-center justify-between gap-3 px-1 cursor-pointer select-none py-1 group"
        >
          <span className="text-xs text-gray-300 group-hover:text-gray-200 transition-colors leading-relaxed">
            参加者が自分で入るルームを選べるようにする
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={miniRooms.allowSelfAssign}
            disabled={updatingSettings}
            onClick={(e) => {
              e.stopPropagation();
              handleToggleAllowSelfAssign();
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
              miniRooms.allowSelfAssign ? 'bg-sky-500' : 'bg-gray-700'
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                miniRooms.allowSelfAssign ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {error && <p className="text-xs text-rose-400 leading-relaxed">{error}</p>}

        <button
          type="button"
          onClick={handleCloseSession}
          disabled={closingSession}
          className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 text-xs font-bold transition-colors disabled:opacity-50"
        >
          {closingSession ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>セッションを終了中...</span>
            </>
          ) : (
            <span>セッションを終了（全員をメインルームに戻す）</span>
          )}
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
      ) : miniRooms.assignedRoom ? (
        <div className="space-y-2">
          <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20 text-xs text-sky-300 leading-relaxed">
            ホストから「{miniRooms.assignedRoom.name}」にアサインされています。
          </div>
          <button
            type="button"
            onClick={() => {
              miniRooms.moveToAssignedRoom();
              onDone();
            }}
            disabled={busy || miniRooms.currentRoomId === miniRooms.assignedRoom.id}
            className="w-full flex items-center justify-between px-4 py-3 bg-sky-900/30 hover:bg-sky-900/50 border border-sky-500/40 rounded-xl text-sm font-bold text-sky-100 disabled:opacity-40 transition-colors"
          >
            <span>{miniRooms.assignedRoom.name}へ参加</span>
            {miniRooms.currentRoomId === miniRooms.assignedRoom.id && (
              <span className="text-[10px] font-bold text-sky-400">現在ここ</span>
            )}
          </button>
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
