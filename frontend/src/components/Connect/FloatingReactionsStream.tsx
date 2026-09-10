import { memo } from 'react';
import { REACTION_EMOJI_MAP } from '../../types/reactions';
import { useStreamReactions } from '../../contexts/ReactionContext';

interface FloatingReactionsStreamProps {
  /** Optional custom bottom position (e.g. for PiP) */
  className?: string;
}

/**
 * Renders a vertical floating reaction stream in the bottom-left of the screen.
 * Uses decoupled 2-axis animation (linear vertical rise + ease-in-out horizontal oscillation)
 * to produce a mathematically smooth Sine wave trajectory without zigzag artifacts.
 */
export const FloatingReactionsStream = memo(function FloatingReactionsStream({
  className = 'bottom-20 left-4 sm:left-6',
}: FloatingReactionsStreamProps) {
  const streamReactions = useStreamReactions();

  if (!streamReactions || streamReactions.length === 0) return null;

  return (
    <div
      className={`fixed ${className} z-40 pointer-events-none w-[200px] h-[200px] select-none overflow-visible`}
    >
      {streamReactions.map((r) => {
        const emoji = REACTION_EMOJI_MAP.get(r.emojiId);
        if (!emoji) return null;

        return (
          /* Outer: Spawns at random point in ~200px square, rises purely vertically (linear) */
          <div
            key={r.id}
            className="absolute pointer-events-none select-none"
            style={{
              left: `${r.startX}px`,
              bottom: `${r.startY}px`,
              animation: 'streamRise 3.5s linear forwards',
            }}
          >
            {/* Inner: Pure horizontal oscillation (ease-in-out alternate) to form a sine curve */}
            <div
              style={{
                animation: 'streamSineSway 0.8s ease-in-out infinite alternate',
              }}
            >
              <img
                src={emoji.src}
                alt={emoji.label}
                className="w-12 h-12 sm:w-14 sm:h-14 object-contain select-none"
                style={{
                  filter:
                    'drop-shadow(0 4px 8px rgba(0, 0, 0, 0.45)) drop-shadow(0 1px 3px rgba(0, 0, 0, 0.25))',
                }}
                loading="eager"
              />
            </div>
          </div>
        );
      })}

      <style>{`
        /* 1. Vertical Rise: Linear ascent for constant vertical speed, fade in/out */
        @keyframes streamRise {
          0% {
            opacity: 0;
            transform: translateY(0);
          }
          10% {
            opacity: 1;
            transform: translateY(-30px);
          }
          80% {
            opacity: 1;
            transform: translateY(-240px);
          }
          100% {
            opacity: 0;
            transform: translateY(-300px);
          }
        }

        /* 2. Horizontal Sine Wave: Pure oscillation between -12px and +12px (subtle & fine) */
        @keyframes streamSineSway {
          0% {
            transform: translateX(-12px);
          }
          100% {
            transform: translateX(12px);
          }
        }
      `}</style>
    </div>
  );
});
