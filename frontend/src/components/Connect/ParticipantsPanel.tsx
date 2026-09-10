import { useEffect } from 'react';
import { useParticipants } from '@livekit/components-react';
import { Users, User, Clock, Check, X, ArrowLeft, DoorOpen, ShieldCheck, MoreHorizontal, Pin, PinOff } from 'lucide-react';
import type { useAdvancedChat } from '../../hooks/useAdvancedChat';
import type { useConnectWaitlist } from '../../hooks/useConnectWaitlist';
import type { UseMiniRoomsResult } from '../../hooks/useMiniRooms';
import { CustomDropdown, type DropdownOption } from '../ui/CustomDropdown';

interface ParticipantsPanelProps {
  isHost: boolean;
  selfIdentity: string;
  getParticipantInfo: ReturnType<typeof useAdvancedChat>['getParticipantInfo'];
  waitlist: ReturnType<typeof useConnectWaitlist>;
  miniRooms: UseMiniRoomsResult;
  /** LiveKit identity (== Supabase user id for authenticated joiners) of everyone who
   *  currently holds host privileges for this room group — see useRoomHosts. */
  hostUserIds: Set<string>;
  onBackToVideo?: () => void;
  isInternalMeeting?: boolean;
  onOpenProfile?: (userId: string) => void;
  onRequestClaimHost?: () => void;
  onRequestGrantHost?: (targetUserId: string, targetName: string) => void;
  onTogglePin?: (id: string) => void;
  pinnedIds?: string[];
}

/** Host badge shown after a host's name, in both the current-room and 別室 lists —
 *  same icon as ClaimHostModal's header. */
function HostBadge() {
  return (
    <span title="ホスト" aria-label="ホスト" className="text-sky-400 shrink-0">
      <ShieldCheck className="w-3.5 h-3.5" />
    </span>
  );
}

/** Action dropdown menu rendered at the right end of each participant item */
function ParticipantActionMenu({
  identity,
  name,
  isSelf,
  isHost,
  hostUserIds,
  isInternalMeeting,
  onRequestClaimHost,
  onRequestGrantHost,
  onOpenProfile,
  onTogglePin,
  isPinned,
}: {
  identity: string;
  name: string;
  isSelf: boolean;
  isHost: boolean;
  hostUserIds: Set<string>;
  isInternalMeeting?: boolean;
  onRequestClaimHost?: () => void;
  onRequestGrantHost?: (targetUserId: string, targetName: string) => void;
  onOpenProfile?: (userId: string) => void;
  onTogglePin?: (id: string) => void;
  isPinned?: boolean;
}) {
  const canClaimHost = isSelf && !isHost && !!onRequestClaimHost;
  const canGrantHost = !isSelf && isHost && !hostUserIds.has(identity) && !!onRequestGrantHost;
  const canViewProfile = !isSelf && isInternalMeeting && !!onOpenProfile;
  const menuOptions: DropdownOption[] = [];

  if (onTogglePin) {
    menuOptions.push({
      label: isPinned ? 'ピン留めを解除' : 'ピン留めする',
      value: 'pin',
      icon: isPinned ? <PinOff className="w-4 h-4 text-sky-400" /> : <Pin className="w-4 h-4 text-gray-300" />,
    });
  }

  if (canClaimHost) {
    menuOptions.push({
      label: 'ホストになる',
      value: 'claim-host',
      icon: <ShieldCheck className="w-4 h-4 text-sky-400" />,
    });
  }

  if (canGrantHost) {
    menuOptions.push({
      label: '一時ホストにする',
      value: 'grant-host',
      icon: <ShieldCheck className="w-4 h-4 text-sky-400" />,
    });
  }

  if (canViewProfile) {
    menuOptions.push({
      label: 'プロフィールを見る',
      value: 'view-profile',
      icon: <User className="w-4 h-4 text-sky-400" />,
    });
  }

  if (menuOptions.length === 0) return null;

  return (
    <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
      <CustomDropdown
        options={menuOptions}
        value=""
        minMenuWidth={180}
        onChange={(val) => {
          if (val === 'pin') {
            onTogglePin?.(`${identity}::camera`);
          } else if (val === 'claim-host') {
            onRequestClaimHost?.();
          } else if (val === 'grant-host') {
            onRequestGrantHost?.(identity, name);
          } else if (val === 'view-profile') {
            onOpenProfile?.(identity);
          }
        }}
        customTrigger={(isOpen) => (
          <button
            type="button"
            aria-label="参加者操作メニュー"
            className={`p-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-white shadow-md shadow-sky-500/25 transition-all ${
              isOpen ? 'ring-2 ring-white/60' : 'opacity-80 hover:opacity-100'
            }`}
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        )}
      />
    </div>
  );
}

/**
 * Docked sidebar (same right-hand dock as AdvancedChat — see CallRoomPage). For everyone:
 * the live LiveKit participant list for the room this client is in, plus — when mini rooms
 * are active — a "別室" section listing everyone else in the session's other rooms (which
 * room each of them is in is deliberately not shown, see useMiniRooms'
 * otherRoomParticipants). For hosts only: a "入室待ち" section on top listing pending
 * connect_room_waitlist entries with admit/deny — the counterpart to the red badge on the
 * Participants control-bar button.
 */
export default function ParticipantsPanel({
  isHost,
  selfIdentity,
  getParticipantInfo,
  waitlist,
  miniRooms,
  hostUserIds,
  onBackToVideo,
  isInternalMeeting,
  onOpenProfile,
  onRequestClaimHost,
  onRequestGrantHost,
  onTogglePin,
  pinnedIds,
}: ParticipantsPanelProps) {
  const participants = useParticipants();

  // Only poll for the "別室" roster while this panel is actually open, and only bother
  // when there are mini rooms to have scattered anyone into in the first place (the hook
  // itself also short-circuits on this, but skipping the effect too avoids toggling a ref
  // for a request that would never fire).
  const hasMiniRooms = miniRooms.rooms.length > 0;
  useEffect(() => {
    if (!hasMiniRooms) return;
    miniRooms.setOtherRoomParticipantPollingEnabled(true);
    return () => miniRooms.setOtherRoomParticipantPollingEnabled(false);
  }, [hasMiniRooms, miniRooms]);

  return (
    <div className="h-full flex flex-col bg-gray-950 text-white">
      <div className="shrink-0 flex items-center gap-2 px-4 py-3.5 border-b border-gray-800/80">
        {onBackToVideo && (
          <button
            onClick={onBackToVideo}
            className="sm:hidden p-1.5 -ml-1 rounded-lg hover:bg-gray-800 text-gray-300 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}
        <Users className="w-4 h-4 text-sky-400 shrink-0" />
        <h2 className="font-bold text-sm flex-1">参加者（{participants.length}）</h2>
        {onBackToVideo && (
          <button
            onClick={onBackToVideo}
            className="hidden sm:flex p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isHost && waitlist.pending.length > 0 && (
          <div className="p-3 border-b border-gray-800/80 space-y-2">
            <p className="text-[10px] font-bold text-amber-400 uppercase tracking-wider px-1 flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              <span>入室待ち（{waitlist.pending.length}）</span>
            </p>
            {waitlist.pending.map((entry) => {
              const busy = waitlist.busyIds.has(entry.id);
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 px-3 py-2.5 bg-amber-950/30 border border-amber-500/20 rounded-xl"
                >
                  <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                    <User className="w-4 h-4 text-amber-300" />
                  </div>
                  <span className="flex-1 text-xs font-bold truncate">{entry.display_name}</span>
                  <button
                    onClick={() => waitlist.deny(entry.id)}
                    disabled={busy}
                    title="拒否"
                    className="p-1.5 rounded-lg bg-gray-800 hover:bg-rose-900/60 text-gray-300 hover:text-rose-300 disabled:opacity-40 transition-colors shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => waitlist.admit(entry.id)}
                    disabled={busy}
                    title="承認"
                    className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 transition-colors shrink-0"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="p-3 space-y-1">
          {participants.map((p) => {
            const info = getParticipantInfo(p.identity);
            const isSelf = p.identity === selfIdentity;
            const isPinned = pinnedIds ? pinnedIds.some((id) => id.startsWith(`${p.identity}::`)) : false;

            return (
              <div key={p.identity} className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-gray-900/60 transition-colors">
                {info.avatarUrl ? (
                  <img src={info.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center shrink-0">
                    <User className="w-4 h-4 text-gray-400" />
                  </div>
                )}
                <span className="text-xs font-semibold truncate flex-1 flex items-center gap-1 min-w-0">
                  <span className="truncate">{info.name}</span>
                  {hostUserIds.has(p.identity) && <HostBadge />}
                  {isPinned && (
                    <span title="ピン留め中" className="text-sky-400 shrink-0">
                      <Pin className="w-3 h-3 fill-current" />
                    </span>
                  )}
                  {isSelf && <span className="text-gray-500 font-normal shrink-0"> （自分）</span>}
                </span>

                {/* Right-aligned '...' dropdown menu */}
                <ParticipantActionMenu
                  identity={p.identity}
                  name={info.name}
                  isSelf={isSelf}
                  isHost={isHost}
                  hostUserIds={hostUserIds}
                  isInternalMeeting={isInternalMeeting}
                  onRequestClaimHost={onRequestClaimHost}
                  onRequestGrantHost={onRequestGrantHost}
                  onOpenProfile={onOpenProfile}
                  onTogglePin={onTogglePin}
                  isPinned={isPinned}
                />
              </div>
            );
          })}
        </div>

        {hasMiniRooms && miniRooms.otherRoomParticipants.length > 0 && (
          <div className="p-3 border-t border-gray-800/80 space-y-1">
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider px-1 flex items-center gap-1.5">
              <DoorOpen className="w-3 h-3" />
              <span>別室（{miniRooms.otherRoomParticipants.length}）</span>
            </p>
            {miniRooms.otherRoomParticipants.map((p) => {
              const isSelf = p.identity === selfIdentity;
              return (
                <div
                  key={p.identity}
                  className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-gray-900/60 transition-colors"
                >
                  {p.avatarUrl ? (
                    <img src={p.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center shrink-0">
                      <User className="w-4 h-4 text-gray-400" />
                    </div>
                  )}
                  <span className="text-xs font-semibold truncate flex-1 flex items-center gap-1 text-gray-300 min-w-0">
                    <span className="truncate">{p.name}</span>
                    {hostUserIds.has(p.identity) && <HostBadge />}
                    {isSelf && <span className="text-gray-500 font-normal shrink-0"> （自分）</span>}
                  </span>

                  {/* Right-aligned '...' dropdown menu for other-room participants */}
                  <ParticipantActionMenu
                    identity={p.identity}
                    name={p.name}
                    isSelf={isSelf}
                    isHost={isHost}
                    hostUserIds={hostUserIds}
                    isInternalMeeting={isInternalMeeting}
                    onRequestClaimHost={onRequestClaimHost}
                    onRequestGrantHost={onRequestGrantHost}
                    onOpenProfile={onOpenProfile}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
