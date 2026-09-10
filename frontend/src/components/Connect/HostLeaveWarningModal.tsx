import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ShieldAlert, X, UserCheck } from 'lucide-react';

interface HostLeaveWarningModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function HostLeaveWarningModal({
  isOpen,
  onClose,
  onConfirm,
}: HostLeaveWarningModalProps) {
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
        className="fixed inset-0 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200"
      />

      {/* Dialog Card */}
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md bg-gray-900/95 border border-amber-500/30 backdrop-blur-2xl rounded-3xl shadow-2xl p-6 text-white text-center space-y-4 animate-in zoom-in-95 duration-200 z-10"
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
        <div className="w-14 h-14 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mx-auto text-amber-400 shadow-lg shadow-amber-950/40">
          <ShieldAlert className="w-7 h-7" />
        </div>

        {/* Text Details */}
        <div className="space-y-2">
          <h3 className="text-base sm:text-lg font-black tracking-tight text-gray-100 leading-snug">
            このルームからホストがいなくなります。<br />本当に退出しますか？
          </h3>
          <p className="text-xs text-gray-400 leading-relaxed max-w-sm mx-auto">
            このミーティングにはホストコードが設定されていないため、あなたが退出すると誰もホスト機能（ミニルーム管理や録画など）を利用できなくなります。
          </p>
        </div>

        {/* Action Buttons: 左側に「アサインせずに退出」、右側に「メンバーにホストをアサイン」 */}
        <div className="flex flex-col-reverse sm:flex-row gap-2.5 pt-3">
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 py-2.5 px-4 bg-gray-800 hover:bg-rose-900/40 text-gray-300 hover:text-rose-200 font-bold text-xs rounded-xl border border-gray-700 hover:border-rose-500/40 transition-all active:scale-95"
          >
            アサインせずに退出
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 px-4 bg-sky-500 hover:bg-sky-400 text-white font-bold text-xs rounded-xl shadow-lg shadow-sky-950/50 transition-all active:scale-95 flex items-center justify-center gap-1.5"
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span>メンバーにホストをアサイン</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
