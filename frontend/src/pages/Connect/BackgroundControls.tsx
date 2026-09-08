import { useRef } from 'react';
import { Ban, Droplets, Image as ImageIcon, Loader2, Plus, Trash2 } from 'lucide-react';
import { PRESETS, type BackgroundEffectState } from './useBackgroundEffect';

/** Panel UI. Purely presentational — all the state lives in useBackgroundEffect. */
export default function BackgroundControls({ state }: { state: BackgroundEffectState }) {
  const { supported, mode, imageId, uploads, busy, error, commit, handleUpload, handleDelete } = state;
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!supported) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-sky-400" />
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

  const isSelected = (tile: 'off' | 'blur' | string) =>
    tile === 'off' ? mode === 'off' : tile === 'blur' ? mode === 'blur' : mode === 'image' && imageId === tile;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 pr-6">
        <ImageIcon className="w-4 h-4 text-sky-400" />
        <div className="flex-1">
          <p className="text-xs font-bold text-gray-200">背景エフェクト</p>
        </div>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />}
      </div>

      {/* なし / ぼかし / プリセット画像 / アップロード画像 / 追加、を1つの選択肢一覧に */}
      <div className="grid grid-cols-3 gap-1.5 max-h-56 overflow-y-auto pr-0.5">
        <button
          onClick={() => void commit({ mode: 'off' })}
          disabled={busy}
          title="なし"
          className={`relative aspect-video rounded-lg overflow-hidden border-2 transition disabled:opacity-50 flex flex-col items-center justify-center gap-1 bg-gray-800/60 ${
            isSelected('off') ? 'border-sky-400' : 'border-transparent hover:border-gray-600'
          }`}
        >
          <Ban className="w-4 h-4 text-gray-400" />
          <span className="text-[10px] font-bold text-gray-300">なし</span>
        </button>

        <button
          onClick={() => void commit({ mode: 'blur' })}
          disabled={busy}
          title="ぼかし"
          className={`relative aspect-video rounded-lg overflow-hidden border-2 transition disabled:opacity-50 flex flex-col items-center justify-center gap-1 bg-gray-800/60 ${
            isSelected('blur') ? 'border-sky-400' : 'border-transparent hover:border-gray-600'
          }`}
        >
          <Droplets className="w-4 h-4 text-gray-400" />
          <span className="text-[10px] font-bold text-gray-300">ぼかし</span>
        </button>

        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            onClick={() => void commit({ mode: 'image', imageId: preset.id })}
            disabled={busy}
            title={preset.label}
            className={`relative aspect-video rounded-lg overflow-hidden border-2 transition disabled:opacity-50 ${
              isSelected(preset.id) ? 'border-sky-400' : 'border-transparent hover:border-gray-600'
            }`}
          >
            <img src={preset.url} alt={preset.label} className="w-full h-full object-cover" />
          </button>
        ))}

        {uploads.map((upload) => (
          <div
            key={upload.id}
            className={`relative aspect-video rounded-lg overflow-hidden border-2 group ${
              isSelected(upload.id) ? 'border-sky-400' : 'border-transparent hover:border-gray-600'
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
          className="aspect-video rounded-lg border-2 border-dashed border-gray-700 text-gray-500 hover:border-sky-400 hover:text-sky-300 transition flex items-center justify-center disabled:opacity-50"
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

      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
