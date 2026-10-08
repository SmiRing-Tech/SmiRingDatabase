import { useCallback, useEffect, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { apiClient } from '../lib/apiClient';

export interface ActiveSurvey {
  id: string;
  form_id: string;
  form_title: string;
  started_at: string;
}

// Backstop for a data-channel ping missed while (re)connecting; the ping is the main signal.
const FALLBACK_POLL_MS = 30000;

/**
 * The in-call survey currently running in this room group (main room + mini rooms), plus
 * host controls to start/end one. The server only pings `connect_survey` on change; the
 * actual state always comes from GET .../surveys/active.
 */
export function useConnectSurvey({ mainRoomId, currentRoomId }: { mainRoomId: string; currentRoomId: string }) {
  const room = useRoomContext();
  const [activeSurvey, setActiveSurvey] = useState<ActiveSurvey | null>(null);

  // Guests' LiveKit-token credential is scoped to the room they're in, so ask via the current room.
  const refresh = useCallback(async () => {
    if (!currentRoomId) return;
    try {
      const res = await apiClient.get(`/api/connect/rooms/${encodeURIComponent(currentRoomId)}/surveys/active`);
      if (!res.ok) return;
      const body = await res.json();
      setActiveSurvey(body.survey ?? null);
    } catch (e) {
      console.error('[Connect] Failed to load active survey:', e);
    }
  }, [currentRoomId]);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
    const interval = setInterval(refresh, FALLBACK_POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const handleData = (_payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string) => {
      if (topic === 'connect_survey') void refresh();
    };
    const handleReconnected = () => void refresh();
    room.on(RoomEvent.DataReceived, handleData);
    room.on(RoomEvent.Reconnected, handleReconnected);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
      room.off(RoomEvent.Reconnected, handleReconnected);
    };
  }, [room, refresh]);

  const start = useCallback(
    async (formId: string) => {
      const res = await apiClient.post(`/api/connect/rooms/${encodeURIComponent(mainRoomId)}/surveys`, {
        form_id: formId,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'アンケートの開始に失敗しました');
      }
      await refresh();
    },
    [mainRoomId, refresh],
  );

  const end = useCallback(async () => {
    if (!activeSurvey) return;
    const res = await apiClient.post(
      `/api/connect/rooms/${encodeURIComponent(mainRoomId)}/surveys/${activeSurvey.id}/end`,
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'アンケートの終了に失敗しました');
    }
    await refresh();
  }, [mainRoomId, activeSurvey, refresh]);

  return { activeSurvey, start, end };
}

export type UseConnectSurveyResult = ReturnType<typeof useConnectSurvey>;
