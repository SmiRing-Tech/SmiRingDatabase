import { useCallback, useEffect, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { apiClient } from '../lib/apiClient';

const POLL_MS = 10000;

/**
 * Who currently holds host privileges for this room group (main room + its mini
 * rooms) — creator, registered/instant hosts, and anyone who has claimed or been
 * granted temporary host this session. Used to badge hosts in the Participants panel.
 *
 * This is a display aid, not an authorization check — every host-only action still
 * re-verifies server-side regardless of what this returns, so a stale/wrong entry
 * here can at worst mis-badge someone, not grant them anything.
 */
export function useRoomHosts(mainRoomId: string) {
  const room = useRoomContext();
  const [hostUserIds, setHostUserIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!mainRoomId) return;
    try {
      const res = await apiClient.get(`/api/connect/rooms/${encodeURIComponent(mainRoomId)}/hosts`);
      if (!res.ok) return;
      const body = await res.json();
      setHostUserIds(new Set<string>(body.hostUserIds || []));
    } catch (e) {
      console.error('[Connect] Failed to load room hosts:', e);
    }
  }, [mainRoomId]);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // A host grant is a clear signal the set just changed (claim-host has no such
  // broadcast, so that case only picks up on the next poll tick) — refetch right
  // away rather than waiting, regardless of who the grant's target was.
  useEffect(() => {
    const handleDataReceived = (_payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string) => {
      if (topic !== 'host_granted') return;
      refresh();
    };
    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, refresh]);

  return hostUserIds;
}
