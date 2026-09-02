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

/** What to reconnect to, and the mic/camera enabled state to carry over. */
export interface ReconnectTarget {
  token: string;
  url: string;
  audio: boolean;
  video: boolean;
}

interface UseMiniRoomsOptions {
  /** The main call's room id (URL route param) — mini rooms belong to this session. */
  mainRoomId: string;
  /** Same value used as the LiveKit participant identity (see useAdvancedChat). */
  selfIdentity: string;
  isHost: boolean;
  /** Applies a reconnect target to the actual LiveKit connection (owned by CallRoomPage,
   *  which feeds token/url into <LiveKitRoom>). */
  onReconnect: (target: ReconnectTarget) => void;
}

/**
 * Client for the "mini room" (breakout room) feature.
 *
 * This self-hosted LiveKit deployment doesn't implement the server-side
 * `MoveParticipant` RPC (confirmed by testing against livekit/livekit-server:latest —
 * it returns "twirp error unknown: not implemented", apparently a LiveKit Cloud-only
 * capability). So room switching is entirely client-driven: the backend mints a token
 * for the destination room and hands it over — directly in the response for a
 * self-move, or via a `miniroom_notify` data message (targeted at just this identity)
 * for a host-initiated move — and this hook disconnects/reconnects using it via
 * `onReconnect`, which updates the token/url state that <LiveKitRoom> is rendered with.
 *
 * Also:
 *  - keeps the mini-room list in sync via REST + a `miniroom_sync` data broadcast;
 *  - surfaces a host's forced-move notice as `pendingMove` for a toast, and applies the
 *    embedded token itself once the notice's `delayMs` elapses (nothing server-side
 *    performs the move — this hook's own timer is what makes it happen);
 *  - exposes thin REST actions for create/move/close.
 */
export function useMiniRooms({ mainRoomId, selfIdentity, isHost, onReconnect }: UseMiniRoomsOptions) {
  const room = useRoomContext();

  const [currentRoomId, setCurrentRoomId] = useState(mainRoomId);
  const [rooms, setRooms] = useState<MiniRoom[]>([]);
  const [allowSelfAssign, setAllowSelfAssign] = useState(false);
  const [participants, setParticipants] = useState<MiniRoomParticipant[]>([]);
  const [pendingMove, setPendingMove] = useState<PendingMiniRoomMove | null>(null);

  const onReconnectRef = useRef(onReconnect);
  useEffect(() => {
    onReconnectRef.current = onReconnect;
  }, [onReconnect]);

  // Applies a reconnect target: captures the room's *current* mic/camera enabled state
  // (not the original join-time preference) so muting/camera-off survives the switch —
  // <LiveKitRoom>'s audio/video props otherwise only reflect how the call was first
  // joined, which would silently un-mute someone on every room switch.
  const applyReconnect = useCallback(
    (target: { token: string; url: string; destinationRoomId: string }) => {
      const audio = room?.localParticipant?.isMicrophoneEnabled ?? true;
      const video = room?.localParticipant?.isCameraEnabled ?? true;
      setCurrentRoomId(target.destinationRoomId);
      setPendingMove(null);
      onReconnectRef.current({ token: target.token, url: target.url, audio, video });
    },
    [room],
  );

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

  // Live updates: room list changes (create/close) and forced-move notices. A forced
  // move's `delayMs` countdown is enforced right here with a plain timeout — there is no
  // server-side timer backing this; if this tab is closed before it fires, the move
  // simply never happens for it (acceptable: nobody is there to see it complete anyway).
  const pendingMoveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        } else if (topic === NOTIFY_TOPIC && data.destinationRoomId && data.token && data.url) {
          const delayMs = typeof data.delayMs === 'number' ? data.delayMs : 4000;
          setPendingMove({
            destinationRoomId: data.destinationRoomId,
            destinationName: data.destinationName || data.destinationRoomId,
            etaMs: delayMs,
          });

          if (pendingMoveTimeoutRef.current) clearTimeout(pendingMoveTimeoutRef.current);
          pendingMoveTimeoutRef.current = setTimeout(() => {
            pendingMoveTimeoutRef.current = null;
            applyReconnect({
              token: data.token,
              url: data.url,
              destinationRoomId: data.destinationRoomId,
            });
          }, delayMs);
        }
      } catch (e) {
        console.warn('[MiniRooms] Failed to parse incoming data message:', e);
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, applyReconnect]);

  useEffect(
    () => () => {
      if (pendingMoveTimeoutRef.current) clearTimeout(pendingMoveTimeoutRef.current);
    },
    [],
  );

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

  // Self-move: the response carries a token for the destination room directly — apply
  // it immediately, no notify/delay (the participant already knows they asked for this).
  const moveSelf = useCallback(
    async (destinationRoomId: string) => {
      const res = await apiClient.post(`/api/connect/rooms/${mainRoomId}/miniroom/move`, {
        targetIdentity: selfIdentity,
        destinationRoomId,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `移動に失敗しました (${res.status})`);
      }
      const body = await res.json();
      if (body.alreadyThere) return;
      applyReconnect({ token: body.token, url: body.url, destinationRoomId: body.destinationRoomId });
    },
    [mainRoomId, selfIdentity, applyReconnect],
  );

  // Host moving someone else: this only sends the request — the target's own client
  // applies the move via the `miniroom_notify` data message it receives (handled above).
  const moveOther = useCallback(
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
