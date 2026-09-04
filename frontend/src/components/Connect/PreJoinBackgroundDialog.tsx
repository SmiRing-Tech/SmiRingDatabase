import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import BackgroundControls from '../../pages/Connect/BackgroundControls';
import { usePreviewBackgroundEffect } from '../../pages/Connect/usePreviewBackgroundEffect';

/**
 * Background picker for the pre-join screen, with its own camera preview so the
 * choice can be seen before joining. The setting is written to localStorage the
 * moment it is picked, which is what the call itself reads on join — closing this
 * dialog is not a "cancel", and there is deliberately no OK button implying one.
 */
export default function PreJoinBackgroundDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state, previewStream } = usePreviewBackgroundEffect(open);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = previewStream;
    if (previewStream) void video.play().catch(() => {});
  }, [previewStream]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl text-white">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-gray-800 bg-gray-900">
          <h2 className="text-sm font-bold">背景エフェクト</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            aria-label="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 grid gap-5 md:grid-cols-[1.1fr_1fr]">
          <div className="space-y-2">
            <video
              ref={videoRef}
              muted
              playsInline
              className="w-full aspect-video rounded-xl bg-black object-cover"
            />
            <p className="text-[10px] text-gray-500">
              ここで選んだ設定は、そのまま通話開始時に適用されます。
            </p>
          </div>

          <div className="min-w-0">
            <BackgroundControls state={state} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
