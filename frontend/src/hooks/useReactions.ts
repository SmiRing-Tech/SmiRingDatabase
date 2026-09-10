import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import type { ActiveReaction, ReactionPacket, StreamReaction } from '../types/reactions';

export const REACTION_TOPIC = 'reaction';
const REACTION_DURATION_MS = 5000;

interface UseReactionsOptions {
  selfIdentity: string;
}

export function useReactions({ selfIdentity }: UseReactionsOptions) {
  const room = useRoomContext();
  const [reactionsByParticipant, setReactionsByParticipant] = useState<Record<string, ActiveReaction[]>>({});
  const [streamReactions, setStreamReactions] = useState<StreamReaction[]>([]);
  const timerMapRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Helper to add a reaction to a participant and schedule its cleanup
  const addReaction = useCallback((participantIdentity: string, emojiId: string, reactionId: string) => {
    const newReaction: ActiveReaction = {
      id: reactionId,
      emojiId,
      timestamp: Date.now(),
    };

    setReactionsByParticipant((prev) => {
      const existing = prev[participantIdentity] || [];
      // Keep up to 3 most recent reactions at once so they don't excessively clutter
      const updated = [...existing.slice(-2), newReaction];
      return {
        ...prev,
        [participantIdentity]: updated,
      };
    });

    // Also trigger bottom-left floating stream reaction (for whole screen)
    // Spawn within a ~200px square area (0~150px range considering emoji width/height)
    const SPAWN_AREA_SPAN = 150;
    const streamItem: StreamReaction = {
      id: `stream_${reactionId}_${Math.random().toString(36).slice(2, 5)}`,
      emojiId,
      timestamp: Date.now(),
      startX: Math.floor(Math.random() * SPAWN_AREA_SPAN),
      startY: Math.floor(Math.random() * SPAWN_AREA_SPAN),
    };
    setStreamReactions((prev) => [...prev.slice(-15), streamItem]);
    setTimeout(() => {
      setStreamReactions((prev) => prev.filter((r) => r.id !== streamItem.id));
    }, 3800);

    // Schedule removal from tile
    const timer = setTimeout(() => {
      setReactionsByParticipant((prev) => {
        const existing = prev[participantIdentity];
        if (!existing) return prev;
        const filtered = existing.filter((r) => r.id !== reactionId);
        if (filtered.length === 0) {
          const next = { ...prev };
          delete next[participantIdentity];
          return next;
        }
        return {
          ...prev,
          [participantIdentity]: filtered,
        };
      });
      timerMapRef.current.delete(reactionId);
    }, REACTION_DURATION_MS);

    timerMapRef.current.set(reactionId, timer);
  }, []);

  // Send a reaction to the room
  const sendReaction = useCallback(
    (emojiId: string) => {
      if (!room || !selfIdentity) return;

      const reactionId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // 1. Immediately trigger locally on own tile
      addReaction(selfIdentity, emojiId, reactionId);

      // 2. Broadcast via LiveKit DataPacket to other participants
      const packet: ReactionPacket = {
        type: 'reaction',
        emojiId,
        senderIdentity: selfIdentity,
        id: reactionId,
        timestamp: Date.now(),
      };

      try {
        const payload = new TextEncoder().encode(JSON.stringify(packet));
        // Use reliable: false for minimal latency real-time bursts
        room.localParticipant.publishData(payload, {
          reliable: false,
          topic: REACTION_TOPIC,
        });
      } catch (err) {
        console.warn('[useReactions] Failed to publish reaction:', err);
      }
    },
    [room, selfIdentity, addReaction]
  );

  // Listen for incoming reactions from other participants
  useEffect(() => {
    if (!room) return;

    const handleDataReceived = (payload: Uint8Array, participant?: any, _kind?: any, topic?: string) => {
      if (topic !== REACTION_TOPIC) {
        // Fallback: check if the json payload itself has type: 'reaction'
        try {
          const str = new TextDecoder().decode(payload);
          if (!str.includes('"type":"reaction"')) return;
          const packet: ReactionPacket = JSON.parse(str);
          if (packet.type === 'reaction' && packet.emojiId && packet.senderIdentity) {
            // Ignore own packet since we already applied it locally
            if (packet.senderIdentity === selfIdentity) return;
            addReaction(packet.senderIdentity, packet.emojiId, packet.id || `${Date.now()}`);
          }
        } catch {}
        return;
      }

      try {
        const str = new TextDecoder().decode(payload);
        const packet: ReactionPacket = JSON.parse(str);
        if (packet && packet.type === 'reaction' && packet.emojiId) {
          const sender = packet.senderIdentity || participant?.identity;
          if (!sender || sender === selfIdentity) return;
          addReaction(sender, packet.emojiId, packet.id || `${Date.now()}`);
        }
      } catch (err) {
        console.warn('[useReactions] Failed to parse incoming reaction:', err);
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room, selfIdentity, addReaction]);

  // Clean up timers on unmount
  useEffect(() => {
    const currentTimers = timerMapRef.current;
    return () => {
      currentTimers.forEach((timer) => clearTimeout(timer));
      currentTimers.clear();
    };
  }, []);

  return {
    reactionsByParticipant,
    streamReactions,
    sendReaction,
  };
}
