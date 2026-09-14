import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParticipants, useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { apiClient } from '../lib/apiClient';
import type { ChatMessage, ChatThread, ChatReplyTarget } from '../types/chat';

const CHAT_TOPIC = 'advanced_chat';

interface UseAdvancedChatOptions {
  roomId: string;
  /** The authenticated user's id (Supabase auth uid). Same value the backend uses as the
   *  LiveKit participant identity — available immediately from AuthContext, unlike
   *  `localParticipant.identity`, which is empty until the LiveKit connection completes. */
  selfIdentity: string;
  /** Whether the chat panel is currently open. Controls unread badge incrementing. */
  isOpen?: boolean;
}

/** Deterministic thread id from a set of participant identities. Must match the
 *  server-side implementation in backend/src/routes/connectRoutes.ts exactly, since
 *  received messages carry a server-assigned threadId that clients trust as-is. */
function getCanonicalThreadId(identities: string[]): string {
  const unique = Array.from(new Set(identities)).filter(Boolean).sort();
  return `dm_${unique.join('_')}`;
}

export function useAdvancedChat({ roomId, selfIdentity, isOpen = false }: UseAdvancedChatOptions) {
  const room = useRoomContext();
  const participants = useParticipants();

  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

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
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const [lastNotificationMessage, setLastNotificationMessage] = useState<ChatMessage | null>(null);

  // Cache for participant display names & avatars learned from live participants or historical chat messages
  const knownParticipantsRef = useRef<Record<string, { name: string; avatarUrl: string | null }>>({});

  // Helper to test if a string is a raw UUID
  const isUuid = useCallback((str: string) => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
  }, []);

  // Helper to resolve participant name/avatar by identity with fallback to historical message sender cache
  const getParticipantInfo = useCallback(
    (identity: string) => {
      // 1. Check live participants in the room
      const p = participants.find((part) => part.identity === identity);
      if (p) {
        let avatarUrl: string | null = null;
        if (p.metadata) {
          try {
            const parsed = JSON.parse(p.metadata);
            avatarUrl = parsed.avatar_url || null;
          } catch {}
        }
        const nameCandidate = p.name?.trim();
        if (nameCandidate && !isUuid(nameCandidate)) {
          knownParticipantsRef.current[identity] = { name: nameCandidate, avatarUrl };
          return { name: nameCandidate, avatarUrl };
        }
      }

      // 2. Check cached participant info from chat message senders
      const cached = knownParticipantsRef.current[identity];
      if (cached && cached.name && !isUuid(cached.name)) {
        return cached;
      }

      // 3. Fallback: never show raw UUID to users
      const safeName = isUuid(identity) ? '参加者' : identity;
      return {
        name: safeName,
        avatarUrl: null,
      };
    },
    [participants, isUuid],
  );

  // Auto-refresh thread names when LiveKit participants update (e.g. after late-join connect)
  useEffect(() => {
    if (participants.length === 0) return;

    setThreads((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.isEveryone || t.participantIdentities.length === 0) return t;
        const resolvedNames = t.participantIdentities
          .map((id) => getParticipantInfo(id).name)
          .join(', ');
        if (resolvedNames && resolvedNames !== t.name) {
          changed = true;
          return { ...t, name: resolvedNames };
        }
        return t;
      });
      return changed ? next : prev;
    });
  }, [participants, getParticipantInfo]);

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
        const everyone = prev.find((t) => t.isEveryone);
        const otherDms = prev.filter((t) => !t.isEveryone && t.id !== threadId);
        const targetThread = existing || {
          id: threadId,
          name: threadName,
          isEveryone: false,
          participantIdentities: memberIdentities,
          unreadCount: 0,
        };

        return everyone ? [everyone, targetThread, ...otherDms] : [targetThread, ...otherDms];
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

      // Learn and cache sender's display name and avatar from message
      if (msg.sender && msg.sender.name && !isUuid(msg.sender.name)) {
        knownParticipantsRef.current[msg.sender.identity] = {
          name: msg.sender.name,
          avatarUrl: msg.sender.avatarUrl || null,
        };
      }

      setThreads((prev) => {
        const existing = prev.find((t) => t.id === msg.threadId);
        const isCurrentlyActive = isOpenRef.current && activeThreadIdRef.current === msg.threadId;

        let targetThread: ChatThread;
        if (existing) {
          // If existing thread name was a fallback like '参加者' or had unresolved IDs, re-derive with new knowledge
          const currentResolvedName =
            !existing.isEveryone && existing.participantIdentities.length > 0
              ? existing.participantIdentities.map((id) => getParticipantInfo(id).name).join(', ')
              : existing.name;

          targetThread = {
            ...existing,
            name: currentResolvedName || existing.name,
            lastMessage: msg,
            unreadCount: isCurrentlyActive || !notify ? existing.unreadCount : existing.unreadCount + 1,
          };
        } else {
          const otherMembers = (isEveryone ? [] : [msg.sender.identity, ...msg.recipients]).filter(
            (id) => id !== selfIdentity,
          );
          const threadName =
            otherMembers
              .map((id) => getParticipantInfo(id).name)
              .join(', ') || 'ダイレクトメッセージ';

          targetThread = {
            id: msg.threadId,
            name: threadName,
            isEveryone,
            participantIdentities: otherMembers,
            lastMessage: msg,
            unreadCount: isCurrentlyActive || !notify ? 0 : 1,
          };
        }

        if (targetThread.isEveryone) {
          const otherDms = prev.filter((t) => !t.isEveryone);
          return [targetThread, ...otherDms];
        } else {
          // Place newly active DM thread right after the pinned 'everyone' thread (left-most position for DMs)
          const everyone = prev.find((t) => t.isEveryone);
          const otherDms = prev.filter((t) => !t.isEveryone && t.id !== targetThread.id);
          return everyone ? [everyone, targetThread, ...otherDms] : [targetThread, ...otherDms];
        }
      });

      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });

      if (notify) {
        setLastNotificationMessage(msg);
      }
    },
    [activeThreadId, selfIdentity, getParticipantInfo, isUuid],
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

        // Pre-populate knownParticipantsRef from all messages in history before ingesting,
        // so threads created from early messages immediately resolve sender display names
        history.forEach((msg) => {
          if (msg.sender && msg.sender.name && !isUuid(msg.sender.name)) {
            knownParticipantsRef.current[msg.sender.identity] = {
              name: msg.sender.name,
              avatarUrl: msg.sender.avatarUrl || null,
            };
          }
        });

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
    async (text: string, targetThreadId?: string, replyTo?: ChatReplyTarget | null) => {
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
          replyTo: replyTo || undefined,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `送信に失敗しました (${res.status})`);
        }
        const body = await res.json();
        const message: ChatMessage = body.message;

        if (room) {
          const payload = new TextEncoder().encode(
            JSON.stringify({ type: 'message', message }),
          );
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

  // Edit a message (author-only)
  const editMessage = useCallback(
    async (messageId: string, newText: string) => {
      const trimmed = newText.trim();
      if (!trimmed || !roomId) return;

      try {
        const res = await apiClient.patch(`/api/connect/rooms/${roomId}/messages/${messageId}`, {
          text: trimmed,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `編集に失敗しました (${res.status})`);
        }
        const body = await res.json();
        const updatedMessage: ChatMessage = body.message;

        // Update local message list
        setMessages((prev) => prev.map((m) => (m.id === messageId ? updatedMessage : m)));

        // Update thread lastMessage if it matches
        setThreads((prev) =>
          prev.map((t) =>
            t.lastMessage?.id === messageId ? { ...t, lastMessage: updatedMessage } : t,
          ),
        );

        // Broadcast over LiveKit
        if (room) {
          const thread = threads.find((t) => t.id === updatedMessage.threadId) || threads[0];
          const isEveryone = thread.isEveryone || updatedMessage.threadId === 'everyone';
          const recipients = isEveryone
            ? []
            : thread.participantIdentities.filter((id) => id !== selfIdentity);

          const payload = new TextEncoder().encode(
            JSON.stringify({ type: 'edit', message: updatedMessage }),
          );
          await room.localParticipant.publishData(payload, {
            destinationIdentities: isEveryone ? undefined : recipients,
            topic: CHAT_TOPIC,
          });
        }
      } catch (err) {
        console.error('[AdvancedChat] Failed to edit message:', err);
      }
    },
    [roomId, threads, selfIdentity, room],
  );

  // Delete a message (author-only)
  const deleteMessage = useCallback(
    async (messageId: string, threadId: string) => {
      if (!roomId) return;

      try {
        const res = await apiClient.delete(`/api/connect/rooms/${roomId}/messages/${messageId}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `削除に失敗しました (${res.status})`);
        }

        // Delete from local message list
        setMessages((prev) => prev.filter((m) => m.id !== messageId));

        // Clear thread lastMessage if it was this message
        setThreads((prev) =>
          prev.map((t) => {
            if (t.lastMessage?.id === messageId) {
              return { ...t, lastMessage: undefined };
            }
            return t;
          }),
        );

        // Broadcast over LiveKit
        if (room) {
          const thread = threads.find((t) => t.id === threadId) || threads[0];
          const isEveryone = thread.isEveryone || threadId === 'everyone';
          const recipients = isEveryone
            ? []
            : thread.participantIdentities.filter((id) => id !== selfIdentity);

          const payload = new TextEncoder().encode(
            JSON.stringify({ type: 'delete', messageId, threadId }),
          );
          await room.localParticipant.publishData(payload, {
            destinationIdentities: isEveryone ? undefined : recipients,
            topic: CHAT_TOPIC,
          });
        }
      } catch (err) {
        console.error('[AdvancedChat] Failed to delete message:', err);
      }
    },
    [roomId, threads, selfIdentity, room],
  );

  // Toggle emoji reaction on a message
  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!roomId) return;
      const cleanEmoji = emoji.trim();
      if (!cleanEmoji) return;

      const targetMsg = messages.find((m) => m.id === messageId);
      if (!targetMsg) return;

      // Optimistic update
      const currentReactions: Record<string, string[]> = { ...(targetMsg.reactions || {}) };
      const userList: string[] = currentReactions[cleanEmoji] ? [...currentReactions[cleanEmoji]] : [];
      const existingIndex = userList.indexOf(selfIdentity);

      if (existingIndex > -1) {
        userList.splice(existingIndex, 1);
      } else {
        userList.push(selfIdentity);
      }

      if (userList.length > 0) {
        currentReactions[cleanEmoji] = userList;
      } else {
        delete currentReactions[cleanEmoji];
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, reactions: currentReactions } : m)),
      );

      try {
        const res = await apiClient.post(
          `/api/connect/rooms/${roomId}/messages/${messageId}/reactions`,
          { emoji: cleanEmoji },
        );
        if (!res.ok) {
          throw new Error('リアクションの更新に失敗しました');
        }
        const body = await res.json();
        const serverReactions = body.reactions;

        // Broadcast over LiveKit
        if (room) {
          const thread = threads.find((t) => t.id === targetMsg.threadId) || threads[0];
          const isEveryone = thread.isEveryone || targetMsg.threadId === 'everyone';
          const recipients = isEveryone
            ? []
            : thread.participantIdentities.filter((id) => id !== selfIdentity);

          const payload = new TextEncoder().encode(
            JSON.stringify({
              type: 'reaction',
              messageId,
              threadId: targetMsg.threadId,
              reactions: serverReactions,
            }),
          );
          await room.localParticipant.publishData(payload, {
            destinationIdentities: isEveryone ? undefined : recipients,
            topic: CHAT_TOPIC,
          });
        }
      } catch (err) {
        console.error('[AdvancedChat] Failed to toggle reaction:', err);
      }
    },
    [roomId, messages, selfIdentity, room, threads],
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
        const data = JSON.parse(str);
        if (!data) return;

        // Case 1: Message deleted
        if (data.type === 'delete' && data.messageId) {
          setMessages((prev) => prev.filter((m) => m.id !== data.messageId));
          setThreads((prev) =>
            prev.map((t) => {
              if (t.lastMessage?.id === data.messageId) {
                return { ...t, lastMessage: undefined };
              }
              return t;
            }),
          );
          return;
        }

        // Case 2: Message edited
        if (data.type === 'edit' && data.message) {
          const updated: ChatMessage = data.message;
          setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
          setThreads((prev) =>
            prev.map((t) =>
              t.lastMessage?.id === updated.id ? { ...t, lastMessage: updated } : t,
            ),
          );
          return;
        }

        // Case 3: Message reaction updated
        if (data.type === 'reaction' && data.messageId && data.reactions) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === data.messageId ? { ...m, reactions: data.reactions } : m,
            ),
          );
          return;
        }

        // Case 4: Message added (regular or legacy format)
        const msg: ChatMessage = data.type === 'message' ? data.message : data;
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

  // When activeThreadId changes or chat is opened, clear unread count for it
  useEffect(() => {
    if (isOpen) {
      markThreadAsRead(activeThreadId);
    }
  }, [isOpen, activeThreadId, markThreadAsRead]);

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
    editMessage,
    deleteMessage,
    toggleReaction,
    createOrOpenDmThread,
    markThreadAsRead,
    totalUnreadCount,
    lastNotificationMessage,
    getParticipantInfo,
    isUuid,
  };
}
