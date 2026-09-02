import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import BackgroundControls from '../../pages/Connect/BackgroundControls';
import type { BackgroundEffectState } from '../../pages/Connect/useBackgroundEffect';

interface BackgroundEffectModalProps {
  isOpen: boolean;
  onClose: () => void;
  state: BackgroundEffectState;
}

/** Standalone popup for the background picker, opened from the camera menu's summary row. */
export default function BackgroundEffectModal({ isOpen, onClose, state }: BackgroundEffectModalProps) {
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

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      />

      {/* Dialog Card */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-sm bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-3xl shadow-2xl p-5 text-white space-y-1 animate-in zoom-in-95 duration-200 z-10 max-h-[85vh] overflow-y-auto no-scrollbar"
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title="閉じる"
        >
          <X className="w-4 h-4" />
        </button>

        <BackgroundControls state={state} />
      </div>
    </div>,
    document.body,
  );
}
