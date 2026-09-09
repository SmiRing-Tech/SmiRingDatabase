import { useParticipants } from '@livekit/components-react';
import { Users, User, Clock, Check, X, ArrowLeft } from 'lucide-react';
import type { useAdvancedChat } from '../../hooks/useAdvancedChat';
import type { useConnectWaitlist } from '../../hooks/useConnectWaitlist';

interface ParticipantsPanelProps {
  isHost: boolean;
  selfIdentity: string;
  getParticipantInfo: ReturnType<typeof useAdvancedChat>['getParticipantInfo'];
  waitlist: ReturnType<typeof useConnectWaitlist>;
  onBackToVideo?: () => void;
}

/**
 * Left-docked sidebar (mirrors AdvancedChat's right-docked one). For everyone: the live
 * LiveKit participant list. For hosts only: a "入室待ち" section on top listing pending
 * connect_room_waitlist entries with admit/deny — the counterpart to the red badge on the
 * Participants control-bar button.
 */
export default function ParticipantsPanel({
  isHost,
  selfIdentity,
  getParticipantInfo,
  waitlist,
  onBackToVideo,
}: ParticipantsPanelProps) {
  const participants = useParticipants();

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
            return (
              <div key={p.identity} className="flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-gray-900/60 transition-colors">
                {info.avatarUrl ? (
                  <img src={info.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center shrink-0">
                    <User className="w-4 h-4 text-gray-400" />
                  </div>
                )}
                <span className="text-xs font-semibold truncate flex-1">
                  {info.name}
                  {isSelf && <span className="text-gray-500 font-normal"> （自分）</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
