import { createPortal } from 'react-dom';
import { DoorOpen, X } from 'lucide-react';
import type { AssignedInvite } from '../../hooks/useMiniRooms';

interface MiniRoomAssignDialogProps {
  invite: AssignedInvite | null;
  onAccept: () => void;
  onDismiss: () => void;
}

/**
 * Dialog shown to a participant when the host assigns/moves them to a mini room.
 * Allows the participant to choose "移動" (move immediately) or "あとで" (stay in current room).
 */
export default function MiniRoomAssignDialog({ invite, onAccept, onDismiss }: MiniRoomAssignDialogProps) {
  if (!invite || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        onClick={onDismiss}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      />

      {/* Dialog Card */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-sm bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-3xl shadow-2xl p-6 text-white flex flex-col items-center text-center animate-in zoom-in-95 duration-200 z-10"
      >
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title="あとで"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="w-14 h-14 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 mb-4 shadow-lg shadow-sky-950/40">
          <DoorOpen className="w-7 h-7" />
        </div>

        <h3 className="text-lg font-black tracking-tight text-gray-100 mb-1.5">
          「{invite.destinationName}」にアサインされました
        </h3>
        <p className="text-xs text-gray-400 leading-relaxed mb-6">
          ホストによりルームへの移動が案内されています。今すぐ移動しますか？
        </p>

        <div className="flex w-full gap-2.5">
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 py-2.5 px-4 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-bold text-xs rounded-xl border border-gray-700 transition-all active:scale-95"
          >
            あとで
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="flex-1 py-2.5 px-4 bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-sky-950/50 transition-all active:scale-95"
          >
            移動
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
