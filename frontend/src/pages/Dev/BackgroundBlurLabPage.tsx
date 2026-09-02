import { useCallback, useEffect, useRef, useState } from 'react';
import { Track } from 'livekit-client';
import {
  MediapipeBackgroundProcessor,
  supportsMediapipeBackground,
  type SegmentationQuality,
} from '../../lib/video/MediapipeBackgroundProcessor';

/**
 * Dev-only bench for the MediaPipe background processor.
 *
 * The processor only ever needs a MediaStreamTrack, so this page drives it
 * straight from getUserMedia — no LiveKit server, no room token, no login.
 * Registered behind `import.meta.env.DEV` in App.tsx, so it never ships.
 */

/** Same files the room UI offers, so the lab exercises the real cover-fit path. */
const PRESET_IMAGES = [
  { label: 'スレート', url: '/backgrounds/slate.jpg' },
  { label: 'インディゴ', url: '/backgrounds/indigo.jpg' },
  { label: 'ダスク', url: '/backgrounds/dusk.jpg' },
  { label: 'フォレスト', url: '/backgrounds/forest.jpg' },
  { label: 'サンド', url: '/backgrounds/sand.jpg' },
  { label: 'ペーパー', url: '/backgrounds/paper.jpg' },
];

const RESOLUTIONS = [
  { label: '360p（本番と同じ）', width: 640, height: 360 },
  { label: '720p', width: 1280, height: 720 },
] as const;

export default function BackgroundBlurLabPage() {
  const rawVideoRef = useRef<HTMLVideoElement>(null);
  const processedVideoRef = useRef<HTMLVideoElement>(null);
  const processorRef = useRef<MediapipeBackgroundProcessor | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const [supported] = useState(() => supportsMediapipeBackground());
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('カメラ未起動');
  const [error, setError] = useState('');
  const [fps, setFps] = useState(0);

  const [quality, setQuality] = useState<SegmentationQuality>('balanced');
  const [resolutionIndex, setResolutionIndex] = useState(0);
  const [mode, setMode] = useState<'blur' | 'image'>('blur');
  const [imageUrl, setImageUrl] = useState(PRESET_IMAGES[0].url);
  const [blurRadius, setBlurRadius] = useState(14);
  const [edgeFeather, setEdgeFeather] = useState(4);
  const [temporalSmoothing, setTemporalSmoothing] = useState(0.45);

  const teardown = useCallback(async () => {
    const processor = processorRef.current;
    processorRef.current = null;
    if (processor) await processor.destroy().catch(() => {});
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (rawVideoRef.current) rawVideoRef.current.srcObject = null;
    if (processedVideoRef.current) processedVideoRef.current.srcObject = null;
  }, []);

  useEffect(() => () => void teardown(), [teardown]);

  const start = useCallback(
    async (nextQuality: SegmentationQuality) => {
      setBusy(true);
      setError('');
      try {
        await teardown();

        const resolution = RESOLUTIONS[resolutionIndex];
        setStatus('カメラを取得中…');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: resolution.width, height: resolution.height },
          audio: false,
        });
        cameraStreamRef.current = stream;
        const cameraTrack = stream.getVideoTracks()[0];

        if (rawVideoRef.current) {
          rawVideoRef.current.srcObject = new MediaStream([cameraTrack]);
          await rawVideoRef.current.play().catch(() => {});
        }

        setStatus(
          nextQuality === 'high'
            ? 'モデルをダウンロード中…（初回のみ約16MB）'
            : 'モデルを読み込み中…',
        );
        const processor = new MediapipeBackgroundProcessor({
          quality: nextQuality,
          mode,
          imageUrl: mode === 'image' ? imageUrl : null,
          blurRadius,
          edgeFeather,
          temporalSmoothing,
        });
        await processor.init({ kind: Track.Kind.Video, track: cameraTrack });
        processorRef.current = processor;

        const processedTrack = processor.processedTrack;
        if (!processedTrack) throw new Error('processedTrack が生成されませんでした');
        if (processedVideoRef.current) {
          processedVideoRef.current.srcObject = new MediaStream([processedTrack]);
          await processedVideoRef.current.play().catch(() => {});
        }

        setRunning(true);
        setStatus('稼働中');
      } catch (e) {
        console.error(e);
        setError(e instanceof Error ? e.message : String(e));
        setStatus('エラー');
        setRunning(false);
        await teardown();
      } finally {
        setBusy(false);
      }
    },
    [teardown, resolutionIndex, blurRadius, edgeFeather, temporalSmoothing, mode, imageUrl],
  );

  const stop = useCallback(async () => {
    await teardown();
    setRunning(false);
    setFps(0);
    setStatus('停止しました');
  }, [teardown]);

  // Blur/feather/smoothing are read fresh every frame, so they update live.
  useEffect(() => {
    processorRef.current?.updateOptions({ blurRadius, edgeFeather, temporalSmoothing });
  }, [blurRadius, edgeFeather, temporalSmoothing]);

  // Mode and image swap in place — no need to reload the segmentation model.
  useEffect(() => {
    const processor = processorRef.current;
    if (!processor) return;
    processor
      .setBackground({ mode, imageUrl: mode === 'image' ? imageUrl : null })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [mode, imageUrl]);

  // Count frames actually delivered on the processed track.
  useEffect(() => {
    const video = processedVideoRef.current;
    if (!video || !running || !('requestVideoFrameCallback' in video)) return;

    let frames = 0;
    let handle = 0;
    let cancelled = false;
    const tick = () => {
      frames += 1;
      if (!cancelled) handle = video.requestVideoFrameCallback(tick);
    };
    handle = video.requestVideoFrameCallback(tick);
    const timer = setInterval(() => {
      setFps(frames);
      frames = 0;
    }, 1000);

    return () => {
      cancelled = true;
      video.cancelVideoFrameCallback(handle);
      clearInterval(timer);
    };
  }, [running]);

  if (!supported) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-200 p-8">
        <h1 className="text-xl font-bold mb-2">背景ブラー検証</h1>
        <p className="text-sm text-red-400">
          このブラウザは WebGL2 / VideoFrame に対応していないため実行できません。
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 p-6 space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">背景ブラー検証（開発用）</h1>
        <p className="text-xs text-gray-400">
          LiveKit サーバー不要。カメラ映像に直接プロセッサを適用して左右で見比べます。
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs space-y-1">
          <span className="block text-gray-400">解像度</span>
          <select
            value={resolutionIndex}
            onChange={(e) => setResolutionIndex(Number(e.target.value))}
            disabled={running || busy}
            className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 disabled:opacity-50"
          >
            {RESOLUTIONS.map((resolution, index) => (
              <option key={resolution.label} value={index}>
                {resolution.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs space-y-1">
          <span className="block text-gray-400">モデル</span>
          <select
            value={quality}
            onChange={(e) => {
              const next = e.target.value as SegmentationQuality;
              setQuality(next);
              if (running) void start(next);
            }}
            disabled={busy}
            className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 disabled:opacity-50"
          >
            <option value="balanced">標準 / selfie_segmenter_landscape（244KB）</option>
            <option value="high">高精細 / selfie_multiclass_256x256（15.6MB）</option>
          </select>
        </label>

        <label className="text-xs space-y-1">
          <span className="block text-gray-400">背景</span>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'blur' | 'image')}
            className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5"
          >
            <option value="blur">ぼかし</option>
            <option value="image">画像</option>
          </select>
        </label>

        {mode === 'image' && (
          <label className="text-xs space-y-1">
            <span className="block text-gray-400">プリセット</span>
            <select
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5"
            >
              {PRESET_IMAGES.map((preset) => (
                <option key={preset.url} value={preset.url}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          onClick={() => (running ? void stop() : void start(quality))}
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm font-bold"
        >
          {busy ? '準備中…' : running ? '停止' : 'カメラを開始'}
        </button>

        <div className="text-xs text-gray-400">
          状態: <span className="text-gray-200">{status}</span>
          {running && <span className="ml-3">出力 {fps} fps</span>}
        </div>
      </div>

      {error && (
        <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded-lg p-3">
          {error}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <figure className="space-y-1">
          <figcaption className="text-xs text-gray-400">元映像</figcaption>
          <video
            ref={rawVideoRef}
            muted
            playsInline
            className="w-full rounded-xl bg-black aspect-video object-cover"
          />
        </figure>
        <figure className="space-y-1">
          <figcaption className="text-xs text-gray-400">プロセッサ適用後</figcaption>
          <video
            ref={processedVideoRef}
            muted
            playsInline
            className="w-full rounded-xl bg-black aspect-video object-cover"
          />
        </figure>
      </div>

      <div className="grid gap-4 sm:grid-cols-3 max-w-3xl">
        <label className="text-xs space-y-1">
          <span className="block text-gray-400">ブラー強度: {blurRadius}px</span>
          <input
            type="range"
            min={2}
            max={40}
            value={blurRadius}
            onChange={(e) => setBlurRadius(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs space-y-1">
          <span className="block text-gray-400">輪郭フェザー: {edgeFeather}px</span>
          <input
            type="range"
            min={0}
            max={16}
            value={edgeFeather}
            onChange={(e) => setEdgeFeather(Number(e.target.value))}
            className="w-full"
          />
        </label>
        <label className="text-xs space-y-1">
          <span className="block text-gray-400">
            時間平滑化: {temporalSmoothing.toFixed(2)}
          </span>
          <input
            type="range"
            min={0}
            max={0.95}
            step={0.05}
            value={temporalSmoothing}
            onChange={(e) => setTemporalSmoothing(Number(e.target.value))}
            className="w-full"
          />
        </label>
      </div>

      <ul className="text-[11px] text-gray-500 space-y-1 list-disc pl-4">
        <li>上下反転していないか / 人物と背景のボケが逆になっていないかを確認してください。</li>
        <li>髪の輪郭を見るなら「高精細」に切り替えて比較してください。</li>
        <li>フェザーを 0 にすると分離そのものの精度が見えます。</li>
        <li>画像モードでは、上下反転・左右反転・引き伸ばし（cover 切り出し）を確認してください。</li>
      </ul>
    </div>
  );
}
