import { useCallback, useEffect, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { apiClient } from '../lib/apiClient';

const TOPIC = 'connect_waitlist';
const POLL_MS = 8000;

export interface WaitlistEntry {
  id: string;
  display_name: string;
  created_at: string;
}

/**
 * Host-only: tracks pending "入室待ち" (waiting room) requests for this call.
 *
 * Refreshed on mount, on a LiveKit data-channel ping from the backend (near-real-time —
 * see connectRoutes.ts' broadcastWaitlistUpdate, fired whenever a request is created,
 * cancelled, admitted, or denied), and as a periodic fallback poll in case a ping was
 * missed (e.g. the host wasn't connected yet when someone joined the waitlist).
 *
 * Non-hosts get a permanently empty list — the backend 403s these routes for them anyway,
 * so this just avoids firing pointless requests.
 */
export function useConnectWaitlist(roomId: string, isHost: boolean) {
  const room = useRoomContext();
  const [pending, setPending] = useState<WaitlistEntry[]>([]);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!isHost || !roomId) return;
    try {
      const res = await apiClient.get(`/api/connect/rooms/${roomId}/waitlist`);
      if (res.ok) {
        const data = await res.json();
        setPending(data.waitlist ?? []);
      }
    } catch (e) {
      console.error('[Connect] Failed to fetch waitlist:', e);
    }
  }, [roomId, isHost]);

  useEffect(() => {
    if (!isHost) {
      setPending([]);
      return;
    }
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [isHost, refresh]);

  useEffect(() => {
    if (!isHost) return;
    const handleDataReceived = (
      _payload: Uint8Array,
      _participant?: unknown,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (topic === TOPIC) refresh();
    };
    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, isHost, refresh]);

  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const admit = useCallback(
    async (waitlistId: string) => {
      setBusy(waitlistId, true);
      try {
        const res = await apiClient.post(`/api/connect/rooms/${roomId}/waitlist/${waitlistId}/admit`);
        if (res.ok) {
          setPending((prev) => prev.filter((p) => p.id !== waitlistId));
        }
      } catch (e) {
        console.error('[Connect] Failed to admit waitlist entry:', e);
      } finally {
        setBusy(waitlistId, false);
      }
    },
    [roomId, setBusy],
  );

  const deny = useCallback(
    async (waitlistId: string) => {
      setBusy(waitlistId, true);
      try {
        const res = await apiClient.post(`/api/connect/rooms/${roomId}/waitlist/${waitlistId}/deny`);
        if (res.ok) {
          setPending((prev) => prev.filter((p) => p.id !== waitlistId));
        }
      } catch (e) {
        console.error('[Connect] Failed to deny waitlist entry:', e);
      } finally {
        setBusy(waitlistId, false);
      }
    },
    [roomId, setBusy],
  );

  return { pending, admit, deny, busyIds };
}
