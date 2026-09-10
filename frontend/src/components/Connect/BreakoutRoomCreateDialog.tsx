import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, DoorOpen, Plus, Trash2, ChevronRight, ChevronDown } from 'lucide-react';
import { useRoomContext } from '@livekit/components-react';
import { CustomDropdown, type DropdownOption } from '../ui/CustomDropdown';
import type { MiniRoom, MiniRoomParticipant, UseMiniRoomsResult } from '../../hooks/useMiniRooms';
import { useAuth } from '../../context/AuthContext';

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
  onCreate: (rooms: BreakoutRoomCreateInput[], allowParticipantSelfAssign: boolean) => Promise<MiniRoom[]>;
  miniRooms: UseMiniRoomsResult;
  mainRoomId: string;
  onCreatingStart?: () => void;
  onCreatingEnd?: () => void;
  onSessionCreated?: () => void;
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
  miniRooms,
  mainRoomId,
  onCreatingStart,
  onCreatingEnd,
  onSessionCreated,
}: BreakoutRoomCreateDialogProps) {
  if (!isOpen || typeof document === 'undefined') return null;
  return (
    <DialogContent
      onClose={onClose}
      onCreate={onCreate}
      miniRooms={miniRooms}
      mainRoomId={mainRoomId}
      onCreatingStart={onCreatingStart}
      onCreatingEnd={onCreatingEnd}
      onSessionCreated={onSessionCreated}
    />
  );
}

function DialogContent({
  onClose,
  onCreate,
  miniRooms,
  mainRoomId,
  onCreatingStart,
  onCreatingEnd,
  onSessionCreated,
}: Omit<BreakoutRoomCreateDialogProps, 'isOpen'>) {
  const room = useRoomContext();
  const { user } = useAuth();
  const [rooms, setRooms] = useState<BreakoutRoomDraft[]>(() => [makeDraft('ルーム1'), makeDraft('ルーム2')]);
  const [allowSelfAssign, setAllowSelfAssign] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRooms, setExpandedRooms] = useState<Record<string, boolean>>({});
  const [draftAssignments, setDraftAssignments] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);

  const [submittingStep, setSubmittingStep] = useState<string>('作成中...');

  const toggleRoom = (id: string) => {
    setExpandedRooms((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // 即座にメインルームの参加者を表示できるようにLiveKitルームとAPIレスポンスの両方をフォールバックとして結合
  const activeParticipants = useMemo(() => {
    if (miniRooms.participants && miniRooms.participants.length > 0) return miniRooms.participants;
    if (!room) return [];
    const list: MiniRoomParticipant[] = [];
    if (room.localParticipant) {
      let avatarUrl: string | null = null;
      try {
        avatarUrl = room.localParticipant.metadata ? JSON.parse(room.localParticipant.metadata).avatar_url : null;
      } catch {}
      list.push({
        identity: room.localParticipant.identity,
        name: room.localParticipant.name || room.localParticipant.identity,
        avatarUrl,
        currentRoomId: mainRoomId || '',
      });
    }
    room.remoteParticipants?.forEach((p) => {
      let avatarUrl: string | null = null;
      try {
        avatarUrl = p.metadata ? JSON.parse(p.metadata).avatar_url : null;
      } catch {}
      list.push({
        identity: p.identity,
        name: p.name || p.identity,
        avatarUrl,
        currentRoomId: mainRoomId || '',
      });
    });
    return list;
  }, [miniRooms.participants, room, mainRoomId]);

  // 移動先の選択肢（メインルーム ＋ 各ドラフトルーム）
  const destinationOptions: DropdownOption[] = useMemo(() => {
    return [
      { label: 'メインルーム', value: 'main' },
      ...rooms.map((r) => ({ label: r.name || 'ルーム', value: r.id })),
    ];
  }, [rooms]);

  // ルームごとに割り当てられた参加者を振り分け
  const participantsByRoom = useMemo(() => {
    const map = new Map<string, MiniRoomParticipant[]>();
    map.set('main', []);
    rooms.forEach((r) => map.set(r.id, []));

    activeParticipants.forEach((p) => {
      const assignedRoomId = draftAssignments[p.identity] || 'main';
      const targetKey = map.has(assignedRoomId) ? assignedRoomId : 'main';
      map.get(targetKey)!.push(p);
    });
    return map;
  }, [rooms, activeParticipants, draftAssignments]);

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

  // ルーム追加時にリスト下部へスクロール
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [rooms.length]);

  const removeRoom = (id: string) => {
    setRooms((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
    setDraftAssignments((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((key) => {
        if (next[key] === id) next[key] = 'main';
      });
      return next;
    });
  };

  const canCreate = rooms.every((r) => r.name.trim().length > 0);

  const handleCreate = async () => {
    setError(null);
    setSubmitting(true);
    setSubmittingStep('ルームを作成中...');
    onCreatingStart?.();
    try {
      const createdRooms = await onCreate(
        rooms.map((r) => ({ name: r.name.trim() })),
        allowSelfAssign,
      );

      // 作成されたルームへ、事前にドラフト選択された参加者をアサイン移動
      if (Array.isArray(createdRooms) && createdRooms.length > 0) {
        const draftIdToCreatedId = new Map<string, string>();
        rooms.forEach((draft, idx) => {
          if (createdRooms[idx]) {
            draftIdToCreatedId.set(draft.id, createdRooms[idx].id);
          }
        });

        const localIdentity = room?.localParticipant?.identity;
        const authUserId = user?.id;
        const isSelf = (identity: string) => {
          return (localIdentity && identity === localIdentity) || (authUserId && identity === authUserId);
        };

        let selfTargetRoomId: string | null = null;
        const otherPromises: Promise<void>[] = [];

        for (const [identity, draftRoomId] of Object.entries(draftAssignments)) {
          if (draftRoomId === 'main') continue;
          const targetRoomId = draftIdToCreatedId.get(draftRoomId);
          if (!targetRoomId) continue;

          if (isSelf(identity)) {
            selfTargetRoomId = targetRoomId;
          } else {
            otherPromises.push(miniRooms.moveOther(identity, targetRoomId));
          }
        }

        // 1. 先に他参加者の移動リクエストを送信・待機
        if (otherPromises.length > 0) {
          setSubmittingStep('参加者を割り振り中...');
          await Promise.all(otherPromises);
        }

        // 2. ホスト自身がミニルームに割り当てられている場合は自身を移動
        if (selfTargetRoomId) {
          setSubmittingStep('ミニルームへ移動中...');
          console.log('[BreakoutRoomCreateDialog] moving self to created room:', selfTargetRoomId);
          await miniRooms.moveSelf(selfTargetRoomId);
        }
      }

      onSessionCreated?.();
    } catch (e) {
      console.error('[BreakoutRoomCreateDialog] creation failed:', e);
      setError(e instanceof Error ? e.message : '作成に失敗しました');
    } finally {
      setSubmitting(false);
      onCreatingEnd?.();
    }
  };

  const mainParticipants = participantsByRoom.get('main') ?? [];

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
        className="relative w-full max-w-md h-[520px] max-h-[85vh] bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-3xl shadow-2xl p-6 text-white flex flex-col animate-in zoom-in-95 duration-200 z-10"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title="閉じる"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header (Fixed) */}
        <div className="flex items-center justify-between gap-3 pr-8 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
              <DoorOpen className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-black tracking-tight text-gray-100 truncate">ミニルームを作成</h3>
              <p className="text-[11px] text-gray-400 leading-relaxed truncate">作成するルームを入力してください</p>
            </div>
          </div>
          <button
            type="button"
            onClick={addRoom}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-400 hover:text-sky-300 text-xs font-bold transition-all shrink-0 active:scale-95 shadow-sm"
            title="ルームを追加"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>ルーム追加</span>
          </button>
        </div>

        {/* Room List (Scrollable Area) */}
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto pr-1 py-4 space-y-2.5">
          {/* Main Room Tile (Fixed, Non-deletable) */}
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
                <span
                  className={`text-xs font-bold shrink-0 ${
                    mainParticipants.length > 0 ? 'text-sky-400' : 'text-gray-100'
                  }`}
                >
                  ({mainParticipants.length})
                </span>
              </div>
              <span className="text-[10px] font-semibold text-gray-400 px-2 py-0.5 rounded-full bg-gray-700/50">
                メイン
              </span>
            </div>

            {expandedRooms['main'] && (
              <div className="px-3 pb-2.5 pt-1 border-t border-gray-700/40 bg-gray-900/40">
                {mainParticipants.length === 0 ? (
                  <p className="text-[11px] text-gray-500 py-1 pl-6">参加者はいません</p>
                ) : (
                  <div className="space-y-1.5 pl-2 pt-1">
                    {mainParticipants.map((p) => (
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
                            value={draftAssignments[p.identity] || 'main'}
                            onChange={(newRoomId) => {
                              setDraftAssignments((prev) => ({ ...prev, [p.identity]: newRoomId }));
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

          {/* Draft Mini Rooms Tiles */}
          {rooms.map((room, idx) => {
            const roomParticipants = participantsByRoom.get(room.id) ?? [];
            return (
              <div
                key={room.id}
                className="bg-gray-800/60 border border-gray-700/60 rounded-xl overflow-hidden transition-all"
              >
                <div className="flex items-center gap-2 p-2.5">
                  <button
                    type="button"
                    onClick={() => toggleRoom(room.id)}
                    className="p-1 -m-1 rounded-lg text-gray-400 hover:text-white transition-colors shrink-0"
                    title={expandedRooms[room.id] ? '閉じる' : '参加者を表示'}
                  >
                    <ChevronRight
                      className={`w-4 h-4 transition-transform duration-200 ${
                        expandedRooms[room.id] ? 'rotate-90 text-sky-400' : ''
                      }`}
                    />
                  </button>
                  <input
                    type="text"
                    value={room.name}
                    onChange={(e) => updateRoomName(room.id, e.target.value)}
                    placeholder={`ルーム${idx + 1}`}
                    className="flex-1 min-w-0 bg-transparent text-sm font-bold text-gray-100 placeholder-gray-500 focus:outline-none"
                  />
                  <span
                    className={`text-xs font-bold shrink-0 ${
                      roomParticipants.length > 0 ? 'text-sky-400' : 'text-gray-400'
                    }`}
                  >
                    ({roomParticipants.length})
                  </span>
                  <button
                    onClick={() => removeRoom(room.id)}
                    disabled={rooms.length <= 1}
                    className="p-1.5 rounded-lg text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors shrink-0"
                    title="ルームを削除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
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
                                value={draftAssignments[p.identity] || 'main'}
                                onChange={(newRoomId) => {
                                  setDraftAssignments((prev) => ({ ...prev, [p.identity]: newRoomId }));
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
          <div
            onClick={() => setAllowSelfAssign(!allowSelfAssign)}
            className="flex items-center justify-between gap-3 px-1 cursor-pointer select-none py-1 group"
          >
            <span className="text-xs text-gray-300 group-hover:text-gray-200 transition-colors leading-relaxed">
              ルーム作成後、参加者が自分で入るルームを選べるようにする
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={allowSelfAssign}
              onClick={(e) => {
                e.stopPropagation();
                setAllowSelfAssign(!allowSelfAssign);
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                allowSelfAssign ? 'bg-sky-500' : 'bg-gray-700'
              }`}
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
                  allowSelfAssign ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {error && <p className="text-xs text-rose-400 leading-relaxed">{error}</p>}

          <div className="flex gap-2.5">
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
              className="flex-1 py-2.5 px-4 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:hover:bg-sky-600 text-white font-bold text-xs rounded-xl shadow-lg shadow-sky-950/50 transition-all active:scale-95"
            >
              {submitting ? submittingStep : '作成'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
