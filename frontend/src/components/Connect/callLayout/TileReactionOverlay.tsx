import { memo } from 'react';
import { REACTION_EMOJI_MAP, type ActiveReaction } from '../../../types/reactions';

interface TileReactionOverlayProps {
  reactions?: ActiveReaction[];
}

/**
 * Overlay rendered at the top-left of the actual video frame
 * displaying Animated Fluent Emoji reactions with natural contour drop-shadow & bounce-in effects.
 */
export const TileReactionOverlay = memo(function TileReactionOverlay({ reactions }: TileReactionOverlayProps) {
  if (!reactions || reactions.length === 0) return null;

  return (
    <div className="absolute top-1 left-1 sm:top-2 sm:left-2 z-30 pointer-events-none flex flex-col gap-2 items-start select-none">
      {reactions.map((reaction) => {
        const emoji = REACTION_EMOJI_MAP.get(reaction.emojiId);
        if (!emoji) return null;

        return (
          <div
            key={reaction.id}
            className="tile-reaction-badge pointer-events-none"
            style={{
              animation: 'reactionPopFloat 5s cubic-bezier(0.16, 1, 0.3, 1) forwards',
            }}
          >
            <img
              src={emoji.src}
              alt={emoji.label}
              className="object-contain"
              style={{
                width: 'clamp(36px, 28cqmin, 136px)',
                height: 'clamp(36px, 28cqmin, 136px)',
                filter:
                  'drop-shadow(0 4px 6px rgba(0, 0, 0, 0.35)) drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25))',
              }}
              loading="eager"
            />
          </div>
        );
      })}

      <style>{`
        @keyframes reactionPopFloat {
          0% {
            opacity: 0;
            transform: scale(0.3) translateY(12%);
          }
          8% {
            opacity: 1;
            transform: scale(1.18) translateY(0);
          }
          14% {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          84% {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
          100% {
            opacity: 0;
            transform: scale(0.85) translateY(-25%);
          }
        }
      `}</style>
    </div>
  );
});
