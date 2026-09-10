import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, KeyRound, Loader2, ShieldCheck } from 'lucide-react';

interface ClaimHostModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (code: string) => Promise<void>;
  roomTitle?: string;
}

export default function ClaimHostModal({
  isOpen,
  onClose,
  onSubmit,
  roomTitle,
}: ClaimHostModalProps) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setCode('');
    setError('');
    setLoading(false);
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
    return () => clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, loading, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      setError('ホストコードを入力してください');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'ホストコードの認証に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        onClick={loading ? undefined : onClose}
        className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm animate-in fade-in duration-150"
      />

      {/* Modal Dialog */}
      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md bg-white border border-slate-100 rounded-3xl shadow-2xl flex flex-col animate-in zoom-in-95 duration-150 z-10 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-start justify-between p-6 pb-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-sky-50 border border-sky-100 flex items-center justify-center text-sky-600 shrink-0">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-gray-900">ホスト権限の取得</h3>
              <p className="text-xs text-gray-400 font-semibold mt-0.5">
                {roomTitle ? `「${roomTitle}」のホストコード` : 'ミーティングのホストコード'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="p-1.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors shrink-0 disabled:opacity-40"
            title="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          <p className="text-xs text-gray-500 leading-relaxed font-semibold">
            ミーティング作成時に設定されたホストコードを入力してください。認証されるとホスト権限が付与され、ミニルーム管理や録画などの機能が利用可能になります。
          </p>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-gray-400" />
              ホストコード
            </label>
            <input
              ref={inputRef}
              type="text"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError('');
              }}
              placeholder="例: HostCode123"
              disabled={loading}
              className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none text-sm font-mono tracking-wider text-gray-800 rounded-xl transition-all disabled:opacity-60"
            />
          </div>

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-100 rounded-xl text-xs text-rose-600 font-semibold animate-in fade-in duration-150">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 pt-3 border-t border-slate-100 flex items-center justify-end gap-2 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-4 py-2 text-xs font-bold text-gray-600 hover:text-gray-900 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-40"
          >
            キャンセル
          </button>
          <button
            type="submit"
            disabled={loading || !code.trim()}
            className="px-5 py-2 bg-sky-500 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs rounded-xl shadow-sm hover:shadow transition-all active:scale-95 flex items-center gap-1.5"
          >
            {loading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>確認中...</span>
              </>
            ) : (
              <span>ホストになる</span>
            )}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
