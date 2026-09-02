import { useEffect, useState } from 'react';
import { DoorOpen } from 'lucide-react';
import type { PendingMiniRoomMove } from '../../hooks/useMiniRooms';

const TICK_MS = 250;

/**
 * Corner toast shown when the host force-moves this participant. Purely informational —
 * the countdown is local UI only (a fixed 250ms decrement, not wall-clock time — good
 * enough for a few-second toast); the actual room switch happens server-side and is
 * reflected by RoomEvent.Moved (which clears `pendingMove` in useMiniRooms), not by
 * this component's timer running out.
 */
export default function MiniRoomMoveToast({ pendingMove }: { pendingMove: PendingMiniRoomMove | null }) {
  if (!pendingMove) return null;
  // Remounting per notice (via `key`) resets the countdown state naturally, with no
  // effect needed to re-seed it when a new pendingMove arrives.
  return <Countdown key={`${pendingMove.destinationRoomId}_${pendingMove.etaMs}`} pendingMove={pendingMove} />;
}

function Countdown({ pendingMove }: { pendingMove: PendingMiniRoomMove }) {
  const [remainingMs, setRemainingMs] = useState(pendingMove.etaMs);

  useEffect(() => {
    const interval = setInterval(() => {
      setRemainingMs((prev) => Math.max(0, prev - TICK_MS));
    }, TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-center gap-3 px-4 py-2 bg-indigo-950/90 border border-indigo-500/50 backdrop-blur-md rounded-2xl shadow-2xl text-white">
        <DoorOpen className="w-4 h-4 text-indigo-400 animate-pulse shrink-0" />
        <span className="text-xs font-semibold">
          まもなく「{pendingMove.destinationName}」に移動します（{seconds}秒）
        </span>
      </div>
    </div>
  );
}
