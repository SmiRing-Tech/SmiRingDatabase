import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParticipants, useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { apiClient } from '../lib/apiClient';
import type { ChatMessage, ChatThread } from '../types/chat';

const CHAT_TOPIC = 'advanced_chat';

interface UseAdvancedChatOptions {
  roomId: string;
  /** The authenticated user's id (Supabase auth uid). Same value the backend uses as the
   *  LiveKit participant identity — available immediately from AuthContext, unlike
   *  `localParticipant.identity`, which is empty until the LiveKit connection completes. */
  selfIdentity: string;
}

/** Deterministic thread id from a set of participant identities. Must match the
 *  server-side implementation in backend/src/routes/connectRoutes.ts exactly, since
 *  received messages carry a server-assigned threadId that clients trust as-is. */
function getCanonicalThreadId(identities: string[]): string {
  const unique = Array.from(new Set(identities)).filter(Boolean).sort();
  return `dm_${unique.join('_')}`;
}

export function useAdvancedChat({ roomId, selfIdentity }: UseAdvancedChatOptions) {
  const room = useRoomContext();
  const participants = useParticipants();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([
    {
      id: 'everyone',
      name: '全体チャット',
      isEveryone: true,
      participantIdentities: [],
      unreadCount: 0,
    },
  ]);
  const [activeThreadId, setActiveThreadId] = useState<string>('everyone');
  const [lastNotificationMessage, setLastNotificationMessage] = useState<ChatMessage | null>(null);

  // Helper to resolve participant name/avatar by identity (for UI display only —
  // never used to determine sender identity or thread membership).
  const getParticipantInfo = useCallback(
    (identity: string) => {
      const p = participants.find((part) => part.identity === identity);
      if (!p) return { name: identity, avatarUrl: null };
      let avatarUrl: string | null = null;
      if (p.metadata) {
        try {
          const parsed = JSON.parse(p.metadata);
          avatarUrl = parsed.avatar_url || null;
        } catch {}
      }
      return {
        name: p.name || p.identity || identity,
        avatarUrl,
      };
    },
    [participants],
  );

  const getThreadIdForMembers = useCallback(
    (memberIdentities: string[]) => getCanonicalThreadId([...memberIdentities, selfIdentity]),
    [selfIdentity],
  );

  // Create or switch to a DM thread
  const createOrOpenDmThread = useCallback(
    (memberIdentities: string[]) => {
      const threadId = getThreadIdForMembers(memberIdentities);
      const memberNames = memberIdentities
        .map((id) => getParticipantInfo(id).name)
        .join(', ');
      const threadName = memberNames || 'ダイレクトメッセージ';

      setThreads((prev) => {
        const existing = prev.find((t) => t.id === threadId);
        if (existing) {
          return prev;
        }
        return [
          ...prev,
          {
            id: threadId,
            name: threadName,
            isEveryone: false,
            participantIdentities: memberIdentities,
            unreadCount: 0,
          },
        ];
      });

      setActiveThreadId(threadId);
      return threadId;
    },
    [getThreadIdForMembers, getParticipantInfo],
  );

  // Merge an incoming message (from history load, live data channel, or our own send)
  // into `threads`/`messages` state. threadId/sender are trusted as-is — both are
  // assigned authoritatively by the backend, so no client-side re-derivation happens here.
  const ingestMessage = useCallback(
    (msg: ChatMessage, opts?: { notify?: boolean }) => {
      const isEveryone = msg.threadId === 'everyone';
      const notify = opts?.notify !== false;

      setThreads((prev) => {
        const existing = prev.find((t) => t.id === msg.threadId);
        const isCurrentlyActive = activeThreadId === msg.threadId;

        if (existing) {
          return prev.map((t) =>
            t.id === msg.threadId
              ? {
                  ...t,
                  lastMessage: msg,
                  unreadCount: isCurrentlyActive || !notify ? t.unreadCount : t.unreadCount + 1,
                }
              : t,
          );
        }

        const otherMembers = (isEveryone ? [] : [msg.sender.identity, ...msg.recipients]).filter(
          (id) => id !== selfIdentity,
        );
        const threadName = otherMembers
          .map((id) => getParticipantInfo(id).name)
          .join(', ') || 'ダイレクトメッセージ';

        return [
          ...prev,
          {
            id: msg.threadId,
            name: threadName,
            isEveryone,
            participantIdentities: otherMembers,
            lastMessage: msg,
            unreadCount: isCurrentlyActive || !notify ? 0 : 1,
          },
        ];
      });

      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });

      if (notify) {
        setLastNotificationMessage(msg);
      }
    },
    [activeThreadId, selfIdentity, getParticipantInfo],
  );

  // Load persisted chat history for this room on mount (server-authoritative, survives
  // reconnects — this is also what makes a freshly-opened DM show its real history
  // instead of appearing empty).
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await apiClient.get(`/api/connect/rooms/${roomId}/messages`);
        if (!res.ok || cancelled) return;
        const body = await res.json();
        const history: ChatMessage[] = body.messages || [];
        history.forEach((msg) => ingestMessage(msg, { notify: false }));
      } catch (e) {
        console.error('[AdvancedChat] Failed to load chat history:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Send a message: persist via backend first (backend assigns the canonical sender
  // identity + threadId), then broadcast the exact same payload over LiveKit for
  // realtime delivery to currently-connected peers.
  const sendMessage = useCallback(
    async (text: string, targetThreadId?: string) => {
      const trimmed = text.trim();
      if (!trimmed || !roomId) return;

      const targetId = targetThreadId || activeThreadId;
      const thread = threads.find((t) => t.id === targetId) || threads[0];
      const isEveryone = thread.isEveryone || targetId === 'everyone';
      const recipients = isEveryone
        ? []
        : thread.participantIdentities.filter((id) => id !== selfIdentity);

      try {
        const res = await apiClient.post(`/api/connect/rooms/${roomId}/messages`, {
          text: trimmed,
          recipientIdentities: recipients,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `送信に失敗しました (${res.status})`);
        }
        const body = await res.json();
        const message: ChatMessage = body.message;

        if (room) {
          const payload = new TextEncoder().encode(JSON.stringify(message));
          await room.localParticipant.publishData(payload, {
            destinationIdentities: isEveryone ? undefined : recipients,
            topic: CHAT_TOPIC,
          });
        }

        ingestMessage(message, { notify: false });
      } catch (err) {
        console.error('[AdvancedChat] Failed to send message:', err);
      }
    },
    [activeThreadId, threads, selfIdentity, roomId, room, ingestMessage],
  );

  // Mark thread as read
  const markThreadAsRead = useCallback((threadId: string) => {
    setThreads((prev) =>
      prev.map((t) => (t.id === threadId ? { ...t, unreadCount: 0 } : t)),
    );
  }, []);

  // Receive messages via LiveKit data packet
  useEffect(() => {
    if (!room) return;

    const handleDataReceived = (payload: Uint8Array, _participant?: any, _kind?: any, topic?: string) => {
      if (topic !== CHAT_TOPIC) return;

      try {
        const str = new TextDecoder().decode(payload);
        const msg: ChatMessage = JSON.parse(str);
        if (!msg || !msg.text || !msg.threadId) return;
        ingestMessage(msg);
      } catch (e) {
        console.warn('[AdvancedChat] Failed to parse incoming chat message:', e);
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, ingestMessage]);

  // When activeThreadId changes, clear unread count for it
  useEffect(() => {
    markThreadAsRead(activeThreadId);
  }, [activeThreadId, markThreadAsRead]);

  // Total unread count across all threads
  const totalUnreadCount = useMemo(() => {
    return threads.reduce((acc, t) => acc + t.unreadCount, 0);
  }, [threads]);

  // Messages in active thread
  const activeMessages = useMemo(() => {
    if (activeThreadId === 'everyone') {
      return messages.filter((m) => m.threadId === 'everyone');
    }
    return messages.filter((m) => m.threadId === activeThreadId);
  }, [messages, activeThreadId]);

  return {
    messages: activeMessages,
    allMessages: messages,
    threads,
    activeThreadId,
    setActiveThreadId,
    sendMessage,
    createOrOpenDmThread,
    markThreadAsRead,
    totalUnreadCount,
    lastNotificationMessage,
  };
}
