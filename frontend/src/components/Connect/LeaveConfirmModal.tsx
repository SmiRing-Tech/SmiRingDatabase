import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PhoneOff, X } from 'lucide-react';

interface LeaveConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function LeaveConfirmModal({
  isOpen,
  onClose,
  onConfirm,
}: LeaveConfirmModalProps) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      />

      {/* Dialog Card */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-sm bg-gray-900/95 border border-gray-700/80 backdrop-blur-2xl rounded-3xl shadow-2xl p-6 text-white text-center space-y-4 animate-in zoom-in-95 duration-200 z-10"
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
          title="閉じる"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Warning Icon Badge */}
        <div className="w-14 h-14 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center mx-auto text-rose-500 shadow-lg shadow-rose-950/40">
          <PhoneOff className="w-7 h-7" />
        </div>

        {/* Text Details */}
        <div className="space-y-1.5">
          <h3 className="text-lg font-black tracking-tight text-gray-100">
            通話を終了しますか？
          </h3>
          <p className="text-xs text-gray-400 leading-relaxed max-w-[260px] mx-auto">
            ルームから退出します。再度通話に参加する場合はルームコードから入り直してください。
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2.5 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 px-4 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white font-bold text-xs rounded-xl border border-gray-700 transition-all active:scale-95"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => {
              onClose();
              onConfirm();
            }}
            className="flex-1 py-2.5 px-4 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-rose-950/50 transition-all active:scale-95 flex items-center justify-center gap-1.5"
          >
            <PhoneOff className="w-3.5 h-3.5" />
            <span>退出する</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
