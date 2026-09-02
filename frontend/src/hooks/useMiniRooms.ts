import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { apiClient } from '../lib/apiClient';

const SYNC_TOPIC = 'miniroom_sync';
const NOTIFY_TOPIC = 'miniroom_notify';
const PARTICIPANTS_POLL_MS = 4000;

export interface MiniRoom {
  id: string;
  name: string;
  createdAt: number;
}

export interface MiniRoomParticipant {
  identity: string;
  name: string;
  avatarUrl: string | null;
  currentRoomId: string;
}

export interface PendingMiniRoomMove {
  destinationRoomId: string;
  destinationName: string;
  etaMs: number;
}

interface UseMiniRoomsOptions {
  /** The main call's room id (URL route param) — mini rooms belong to this session. */
  mainRoomId: string;
  /** Same value used as the LiveKit participant identity (see useAdvancedChat). */
  selfIdentity: string;
  isHost: boolean;
}

/**
 * Client for the "mini room" (breakout room) feature. All LiveKit room-switching is
 * driven entirely by the backend (RoomServiceClient.moveParticipant) — this hook never
 * calls any LiveKit move/connect API itself. It only:
 *  - tracks which room we're currently in, reactively, via RoomEvent.Moved (nothing in
 *    @livekit/components-react reacts to that event on its own);
 *  - keeps the mini-room list in sync via REST + a `miniroom_sync` data broadcast;
 *  - surfaces a host's forced-move notice (`miniroom_notify`) as `pendingMove` for a
 *    toast — the actual move happens server-side a few seconds later and is reflected
 *    here only once RoomEvent.Moved actually fires;
 *  - exposes thin REST actions for create/move/close.
 */
export function useMiniRooms({ mainRoomId, selfIdentity, isHost }: UseMiniRoomsOptions) {
  const room = useRoomContext();

  const [currentRoomId, setCurrentRoomId] = useState(mainRoomId);
  const [rooms, setRooms] = useState<MiniRoom[]>([]);
  const [allowSelfAssign, setAllowSelfAssign] = useState(false);
  const [participants, setParticipants] = useState<MiniRoomParticipant[]>([]);
  const [pendingMove, setPendingMove] = useState<PendingMiniRoomMove | null>(null);

  // Fetch the current mini-room list for this main room.
  const refreshRooms = useCallback(async () => {
    if (!mainRoomId) return;
    try {
      const res = await apiClient.get(`/api/connect/rooms/${mainRoomId}/miniroom`);
      if (!res.ok) return;
      const body = await res.json();
      setRooms(body.rooms || []);
      setAllowSelfAssign(!!body.allowSelfAssign);
    } catch (e) {
      console.error('[MiniRooms] Failed to load mini room list:', e);
    }
  }, [mainRoomId]);

  useEffect(() => {
    void (async () => {
      await refreshRooms();
    })();
  }, [refreshRooms]);

  // Host-only live roster for the management panel. Callers control when polling is
  // active by calling this while their panel is open (see MiniRoomPanel).
  const refreshParticipants = useCallback(async () => {
    if (!mainRoomId || !isHost) return;
    try {
      const res = await apiClient.get(`/api/connect/rooms/${mainRoomId}/miniroom/participants`);
      if (!res.ok) return;
      const body = await res.json();
      setParticipants(body.participants || []);
    } catch (e) {
      console.error('[MiniRooms] Failed to load participant roster:', e);
    }
  }, [mainRoomId, isHost]);

  // Reactive current-room tracking: RoomEvent.Moved fires with the new room name once
  // the server actually performs a moveParticipant, whether self- or host-initiated.
  // `currentRoomId` starts seeded at `mainRoomId` (its initial state), which is already
  // correct — a participant always connects to the main room first — so this effect only
  // needs to subscribe going forward, not re-seed on mount.
  useEffect(() => {
    if (!room) return;

    const handleMoved = (newRoomName: string) => {
      setCurrentRoomId(newRoomName);
      setPendingMove(null);
    };

    room.on(RoomEvent.Moved, handleMoved);
    return () => {
      room.off(RoomEvent.Moved, handleMoved);
    };
  }, [room]);

  // Live updates: room list changes (create/close) and forced-move notices.
  useEffect(() => {
    if (!room) return;

    const handleDataReceived = (payload: Uint8Array, _participant?: unknown, _kind?: unknown, topic?: string) => {
      if (topic !== SYNC_TOPIC && topic !== NOTIFY_TOPIC) return;
      try {
        const str = new TextDecoder().decode(payload);
        const data = JSON.parse(str);

        if (topic === SYNC_TOPIC && Array.isArray(data.rooms)) {
          setRooms(data.rooms);
          setAllowSelfAssign(!!data.allowSelfAssign);
        } else if (topic === NOTIFY_TOPIC && data.destinationRoomId) {
          setPendingMove({
            destinationRoomId: data.destinationRoomId,
            destinationName: data.destinationName || data.destinationRoomId,
            etaMs: typeof data.delayMs === 'number' ? data.delayMs : 4000,
          });
        }
      } catch (e) {
        console.warn('[MiniRooms] Failed to parse incoming data message:', e);
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room]);

  // Host roster polling, active only while requested (panel open).
  const pollEnabledRef = useRef(false);
  const setParticipantPollingEnabled = useCallback(
    (enabled: boolean) => {
      pollEnabledRef.current = enabled;
      if (enabled) refreshParticipants();
    },
    [refreshParticipants],
  );

  useEffect(() => {
    if (!isHost) return;
    const interval = setInterval(() => {
      if (pollEnabledRef.current) refreshParticipants();
    }, PARTICIPANTS_POLL_MS);
    return () => clearInterval(interval);
  }, [isHost, refreshParticipants]);

  const createRooms = useCallback(
    async (names: string[], newAllowSelfAssign?: boolean) => {
      const res = await apiClient.post(`/api/connect/rooms/${mainRoomId}/miniroom`, {
        rooms: names.map((name) => ({ name })),
        allowSelfAssign: newAllowSelfAssign,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `ミニルームの作成に失敗しました (${res.status})`);
      }
      const body = await res.json();
      setRooms(body.rooms || []);
      setAllowSelfAssign(!!body.allowSelfAssign);
    },
    [mainRoomId],
  );

  const move = useCallback(
    async (targetIdentity: string, destinationRoomId: string) => {
      const res = await apiClient.post(`/api/connect/rooms/${mainRoomId}/miniroom/move`, {
        targetIdentity,
        destinationRoomId,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `移動に失敗しました (${res.status})`);
      }
    },
    [mainRoomId],
  );

  const moveSelf = useCallback(
    (destinationRoomId: string) => move(selfIdentity, destinationRoomId),
    [move, selfIdentity],
  );

  const moveOther = useCallback(
    (targetIdentity: string, destinationRoomId: string) => move(targetIdentity, destinationRoomId),
    [move],
  );

  const closeMiniRoom = useCallback(
    async (miniRoomId: string) => {
      const res = await apiClient.post(`/api/connect/rooms/${mainRoomId}/miniroom/close`, { miniRoomId });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `ルームの終了に失敗しました (${res.status})`);
      }
      await refreshRooms();
    },
    [mainRoomId, refreshRooms],
  );

  const closeSession = useCallback(async () => {
    const res = await apiClient.post(`/api/connect/rooms/${mainRoomId}/miniroom/close`, {});
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `セッションの終了に失敗しました (${res.status})`);
    }
    await refreshRooms();
  }, [mainRoomId, refreshRooms]);

  return {
    rooms,
    allowSelfAssign,
    currentRoomId,
    isInMainRoom: currentRoomId === mainRoomId,
    pendingMove,
    participants,
    setParticipantPollingEnabled,
    refreshParticipants,
    createRooms,
    moveSelf,
    moveOther,
    closeMiniRoom,
    closeSession,
  };
}

export type UseMiniRoomsResult = ReturnType<typeof useMiniRooms>;
