import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalParticipant, useParticipants, useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import type { ChatMessage, ChatThread } from '../types/chat';

const CHAT_TOPIC = 'advanced_chat';

export function useAdvancedChat() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
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

  // Helper to extract sender info
  const localSenderInfo = useMemo(() => {
    let avatarUrl: string | null = null;
    if (localParticipant?.metadata) {
      try {
        const parsed = JSON.parse(localParticipant.metadata);
        avatarUrl = parsed.avatar_url || null;
      } catch {}
    }
    return {
      identity: localParticipant?.identity || 'local',
      name: localParticipant?.name || localParticipant?.identity || '自分',
      avatarUrl,
    };
  }, [localParticipant]);

  // Helper to resolve participant name/avatar by identity
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

  // Helper to construct a deterministic threadId from a list of participant identities
  const getThreadIdForMembers = useCallback(
    (memberIdentities: string[]) => {
      const allMembers = Array.from(
        new Set([...memberIdentities, localParticipant?.identity || '']),
      )
        .filter(Boolean)
        .sort();
      return `dm_${allMembers.join('_')}`;
    },
    [localParticipant?.identity],
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

  // Send a message
  const sendMessage = useCallback(
    async (text: string, targetThreadId?: string) => {
      const targetId = targetThreadId || activeThreadId;
      const thread = threads.find((t) => t.id === targetId) || threads[0];
      const isEveryone = thread.isEveryone || targetId === 'everyone';

      const recipients = isEveryone
        ? []
        : thread.participantIdentities.filter((id) => id !== localParticipant?.identity);

      const message: ChatMessage = {
        id: `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        threadId: isEveryone ? 'everyone' : targetId,
        text: text.trim(),
        sender: localSenderInfo,
        recipients,
        timestamp: Date.now(),
      };

      if (!message.text || !room) return;

      try {
        const payload = new TextEncoder().encode(JSON.stringify(message));
        await room.localParticipant.publishData(payload, {
          destinationIdentities: isEveryone ? undefined : recipients,
          topic: CHAT_TOPIC,
        });

        // Add to local message history
        setMessages((prev) => [...prev, message]);
      } catch (err) {
        console.error('[AdvancedChat] Failed to send message:', err);
      }
    },
    [activeThreadId, threads, localParticipant?.identity, localSenderInfo, room],
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

    const handleDataReceived = (
      payload: Uint8Array,
      _participant?: any,
      _kind?: any,
      topic?: string,
    ) => {
      if (topic !== CHAT_TOPIC) return;

      try {
        const str = new TextDecoder().decode(payload);
        const msg: ChatMessage = JSON.parse(str);
        if (!msg || !msg.text) return;

        // Auto-register DM thread if not already existing
        const isEveryone = !msg.recipients || msg.recipients.length === 0;
        let threadId = msg.threadId;

        if (!isEveryone) {
          const allMembers = Array.from(
            new Set([msg.sender.identity, ...msg.recipients]),
          )
            .filter(Boolean)
            .sort();
          threadId = `dm_${allMembers.join('_')}`;
        } else {
          threadId = 'everyone';
        }

        setThreads((prev) => {
          const existing = prev.find((t) => t.id === threadId);
          const isCurrentlyActive = activeThreadId === threadId;

          if (existing) {
            return prev.map((t) =>
              t.id === threadId
                ? {
                    ...t,
                    lastMessage: msg,
                    unreadCount: isCurrentlyActive ? 0 : t.unreadCount + 1,
                  }
                : t,
            );
          }

          // Thread does not exist yet: create it!
          const otherMembers = (isEveryone ? [] : [msg.sender.identity, ...msg.recipients]).filter(
            (id) => id !== localParticipant?.identity,
          );
          const threadName = otherMembers
            .map((id) => getParticipantInfo(id).name)
            .join(', ') || 'ダイレクトメッセージ';

          return [
            ...prev,
            {
              id: threadId,
              name: threadName,
              isEveryone,
              participantIdentities: otherMembers,
              lastMessage: msg,
              unreadCount: isCurrentlyActive ? 0 : 1,
            },
          ];
        });

        setMessages((prev) => {
          // Avoid duplicate messages
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });

        // Trigger notification
        setLastNotificationMessage(msg);
      } catch (e) {
        console.warn('[AdvancedChat] Failed to parse incoming chat message:', e);
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, activeThreadId, localParticipant?.identity, getParticipantInfo]);

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
