import React, { createContext, useContext } from 'react';
import type { ActiveReaction, StreamReaction } from '../types/reactions';

interface ReactionContextValue {
  reactionsByParticipant: Record<string, ActiveReaction[]>;
  streamReactions: StreamReaction[];
  sendReaction: (emojiId: string) => void;
}

const ReactionContext = createContext<ReactionContextValue | null>(null);

export function ReactionProvider({
  value,
  children,
}: {
  value: ReactionContextValue;
  children: React.ReactNode;
}) {
  return <ReactionContext.Provider value={value}>{children}</ReactionContext.Provider>;
}

export function useParticipantReactions(participantIdentity?: string): ActiveReaction[] {
  const context = useContext(ReactionContext);
  if (!context || !participantIdentity) return [];
  return context.reactionsByParticipant[participantIdentity] || [];
}

export function useStreamReactions(): StreamReaction[] {
  const context = useContext(ReactionContext);
  if (!context) return [];
  return context.streamReactions || [];
}

export function useReactionActions() {
  const context = useContext(ReactionContext);
  return context;
}
