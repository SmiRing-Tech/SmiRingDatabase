import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { REACTION_EMOJIS, type ReactionEmoji } from '../../types/reactions';

interface ReactionPickerProps {
  anchorRef?: React.RefObject<HTMLElement | null>;
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emojiId: string) => void;
}

export function ReactionPicker({ isOpen, onClose, onSelect }: ReactionPickerProps) {
  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <>
      {/* Backdrop for outside click */}
      <div className="fixed inset-0 z-[999]" onClick={onClose} />

      {/* Floating Reaction Picker: Centered horizontally, right above bottom controls */}
      <div
        className="fixed bottom-[78px] sm:bottom-[84px] left-1/2 -translate-x-1/2 z-[1000] animate-in fade-in slide-in-from-bottom-3 duration-200 pointer-events-auto max-w-[96vw]"
      >
        {/* Step-width container:
            - width 612px (12 items x 1 row) on screens >= 680px
            - width 312px (6 items x 2 rows) on screens 360px - 680px
            - width 212px (4 items x 3 rows) on screens < 360px
        */}
        <div className="w-[212px] min-[360px]:w-[312px] min-[680px]:w-[612px] p-2 bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-2xl shadow-2xl shadow-black/80 transition-[width] duration-200">
          <div className="flex flex-wrap gap-1.5 justify-center">
            {REACTION_EMOJIS.map((emoji: ReactionEmoji) => (
              <button
                key={emoji.id}
                type="button"
                onClick={() => {
                  onSelect(emoji.id);
                  onClose();
                }}
                title={emoji.label}
                className="group relative w-11 h-11 shrink-0 flex items-center justify-center rounded-xl transition-all duration-150 hover:bg-white/10 hover:scale-125 active:scale-95"
              >
                <img
                  src={emoji.src}
                  alt={emoji.label}
                  className="w-8 h-8 shrink-0 object-contain drop-shadow-md select-none pointer-events-none transition-transform duration-150"
                  loading="eager"
                />
                {/* Tooltip on hover */}
                <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-gray-950/95 text-gray-200 text-[10px] font-medium rounded-md whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-gray-800 shadow-lg z-10">
                  {emoji.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
