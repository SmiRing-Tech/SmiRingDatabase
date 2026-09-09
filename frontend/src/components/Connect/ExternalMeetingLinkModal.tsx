import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, Copy, PartyPopper } from 'lucide-react';

interface ExternalMeetingLinkModalProps {
  roomTitle: string;
  inviteUrl: string;
  onClose: () => void;
}

export default function ExternalMeetingLinkModal({ roomTitle, inviteUrl, onClose }: ExternalMeetingLinkModalProps) {
  const [copied, setCopied] = useState(false);

  if (typeof document === 'undefined') return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard errors */
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div onClick={onClose} className="fixed inset-0 bg-gray-900/40 backdrop-blur-sm animate-in fade-in duration-150" />

      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md bg-white border border-slate-100 rounded-3xl shadow-2xl p-6 animate-in zoom-in-95 duration-150 z-10"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 right-5 p-1.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="閉じる"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="p-3 rounded-2xl bg-blue-50 border border-blue-100 w-fit mb-3 text-blue-600">
          <PartyPopper className="w-6 h-6" />
        </div>

        <h3 className="text-lg font-black text-gray-900">外部ミーティングを作成しました</h3>
        <p className="text-xs text-gray-400 font-semibold mt-1 mb-4">
          「{roomTitle}」への招待URLです。DBアカウントを持たない方にもこのURLを共有できます。
        </p>

        <button
          type="button"
          onClick={handleCopy}
          className="w-full flex items-center gap-2 px-4 py-3 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded-xl transition-colors text-left group"
        >
          <span className="flex-1 text-xs font-mono text-gray-700 truncate">{inviteUrl}</span>
          {copied ? (
            <Check className="w-4 h-4 text-emerald-500 shrink-0" />
          ) : (
            <Copy className="w-4 h-4 text-gray-400 group-hover:text-blue-600 shrink-0" />
          )}
        </button>

        <button
          type="button"
          onClick={onClose}
          className="w-full mt-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all active:scale-95"
        >
          閉じる
        </button>
      </div>
    </div>,
    document.body,
  );
}
