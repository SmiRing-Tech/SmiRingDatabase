import { useRef } from 'react';
import { Ban, Droplets, Image as ImageIcon, Loader2, Plus, Trash2 } from 'lucide-react';
import { PRESETS, type BackgroundEffectState } from './useBackgroundEffect';

/** Panel UI. Purely presentational — all the state lives in useBackgroundEffect. */
export default function BackgroundControls({ state }: { state: BackgroundEffectState }) {
  const { supported, mode, imageId, quality, uploads, busy, error, commit, handleUpload, handleDelete } = state;
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!supported) {
    return (
      <div className="space-y-2 border-t border-gray-800/80 pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-indigo-400" />
            <div>
              <p className="text-xs font-bold text-gray-200">背景エフェクト</p>
              <p className="text-[10px] text-gray-400">ぼかし / 画像で背景を差し替え</p>
            </div>
          </div>
          <span className="text-[10px] bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full border border-gray-700">
            非対応
          </span>
        </div>
      </div>
    );
  }

  const modeButtons = [
    { value: 'off' as const, label: 'なし', icon: Ban },
    { value: 'blur' as const, label: 'ぼかし', icon: Droplets },
    { value: 'image' as const, label: '画像', icon: ImageIcon },
  ];

  return (
    <div className="space-y-3 border-t border-gray-800/80 pt-3">
      <div className="flex items-center gap-2">
        <ImageIcon className="w-4 h-4 text-indigo-400" />
        <div className="flex-1">
          <p className="text-xs font-bold text-gray-200">背景エフェクト</p>
          <p className="text-[10px] text-gray-400">MediaPipe AI で人物を切り抜いて合成</p>
        </div>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />}
      </div>

      {/* なし / ぼかし / 画像 */}
      <div className="flex gap-1.5">
        {modeButtons.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            onClick={() =>
              void commit({
                mode: value,
                imageId: value === 'image' ? (imageId ?? PRESETS[0].id) : imageId,
              })
            }
            disabled={busy}
            className={`flex-1 flex flex-col items-center gap-1 rounded-lg border px-2 py-2 transition-colors disabled:opacity-50 ${
              mode === value
                ? 'bg-indigo-500/20 border-indigo-400/60 text-indigo-200'
                : 'bg-gray-800/60 border-gray-700 text-gray-400 hover:bg-gray-800'
            }`}
          >
            <Icon className="w-4 h-4" />
            <span className="text-[10px] font-bold">{label}</span>
          </button>
        ))}
      </div>

      {mode === 'image' && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5 max-h-44 overflow-y-auto pr-0.5">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => void commit({ mode: 'image', imageId: preset.id })}
                disabled={busy}
                title={preset.label}
                className={`relative aspect-video rounded-lg overflow-hidden border-2 transition disabled:opacity-50 ${
                  imageId === preset.id ? 'border-indigo-400' : 'border-transparent hover:border-gray-600'
                }`}
              >
                <img src={preset.url} alt={preset.label} className="w-full h-full object-cover" />
              </button>
            ))}

            {uploads.map((upload) => (
              <div
                key={upload.id}
                className={`relative aspect-video rounded-lg overflow-hidden border-2 group ${
                  imageId === upload.id ? 'border-indigo-400' : 'border-transparent hover:border-gray-600'
                }`}
              >
                <button
                  onClick={() => void commit({ mode: 'image', imageId: upload.id })}
                  disabled={busy}
                  className="w-full h-full disabled:opacity-50"
                >
                  <img src={upload.objectUrl} alt="背景" className="w-full h-full object-cover" />
                </button>
                <button
                  onClick={() => void handleDelete(upload.id)}
                  disabled={busy}
                  title="削除"
                  className="absolute top-0.5 right-0.5 p-1 rounded-md bg-black/70 text-gray-300 opacity-0 group-hover:opacity-100 hover:text-red-400 transition disabled:opacity-50"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              title="画像をアップロード"
              className="aspect-video rounded-lg border-2 border-dashed border-gray-700 text-gray-500 hover:border-indigo-400 hover:text-indigo-300 transition flex items-center justify-center disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleUpload(file);
            }}
          />
        </div>
      )}

      {mode !== 'off' && (
        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            {(
              [
                { value: 'balanced', label: '標準', hint: '軽量・即時' },
                { value: 'high', label: '高精細', hint: '髪の毛まで分離' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                onClick={() => void commit({ quality: option.value })}
                disabled={busy}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-left transition-colors disabled:opacity-50 ${
                  quality === option.value
                    ? 'bg-indigo-500/20 border-indigo-400/60 text-indigo-200'
                    : 'bg-gray-800/60 border-gray-700 text-gray-400 hover:bg-gray-800'
                }`}
              >
                <span className="block text-[11px] font-bold">{option.label}</span>
                <span className="block text-[9px] opacity-80">{option.hint}</span>
              </button>
            ))}
          </div>
          {quality === 'high' && (
            <p className="text-[9px] text-gray-500">
              初回のみ約16MBのモデルをダウンロードします（次回以降はキャッシュ）
            </p>
          )}
        </div>
      )}

      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
