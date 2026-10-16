import { useCallback, useEffect, useRef, useState } from 'react';
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import {
  loadSegmentationModel,
  MEDIAPIPE_WASM_BASE,
  MODEL_INVERT,
} from '../../lib/video/MediapipeBackgroundProcessor';
import {
  MatteLab,
  type BackgroundKind,
  type EdgeMode,
  type Interpolation,
  type MatteLabParams,
  type PipelineId,
  type PipelineStats,
} from '../../lib/video/matteLab';

/**
 * Matte edge lab: tune how the segmentation mask becomes the cut-out edge, and see what it costs.
 *
 * Runs the camera through MediaPipe and feeds the SAME mask to two matte pipelines, A and B
 * (lib/video/matteLab.ts), shown side by side with a draggable split. A starts as the cheap
 * baseline (no blur, quarter-resolution matte); B as the same cost with a curved edge (bicubic
 * field, cut at its iso-line in the composite). Every stage is a parameter. Each pipeline's matte stage is timed on the GPU
 * (EXT_disjoint_timer_query_webgl2), so "looks better" can be weighed against "costs more".
 *
 * Meant for judging edges: freeze a frame, zoom into the shoulder/hair, switch to the matte view
 * or a green background, and change parameters live (a frozen frame is re-computed continuously).
 * Public like /dev/blur-lab: it touches nothing but the visitor's own camera.
 */

type ModelChoice = 'balanced' | 'high';

const MODEL_LABELS: Record<ModelChoice, string> = {
  balanced: '標準 / selfie_segmenter_landscape（256×144・ガタつきやすい）',
  high: '高精細 / selfie_multiclass_256x256',
};

const RESOLUTIONS = { 720: [1280, 720], 540: [960, 540], 360: [640, 360] } as const;
type ResolutionKey = keyof typeof RESOLUTIONS;

const SEG_FPS = [5, 10, 15, 20, 30] as const;

/**
 * Same mask size the app's worker pipeline hands the compositor (SEGMENTER_MASK_HEIGHT in
 * WorkerBackgroundProcessor; width follows the camera's aspect). MediaPipe itself returns the mask
 * already resized to the INPUT frame (e.g. 1280x720), so it is brought back to this grid first —
 * otherwise "blur in mask pixels" here would mean full-resolution pixels and change nothing.
 */
const MASK_HEIGHT: Record<ModelChoice, number> = { balanced: 144, high: 256 };

/** Bilinear sample at each target texel's centre — what drawing the mask onto a small canvas does. */
function resampleMask(src: Float32Array, srcW: number, srcH: number, dst: Uint8Array, dstW: number, dstH: number) {
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y += 1) {
    const fy = Math.min(srcH - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < dstW; x += 1) {
      const fx = Math.min(srcW - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const tx = fx - x0;
      const top = src[y0 * srcW + x0] * (1 - tx) + src[y0 * srcW + x1] * tx;
      const bottom = src[y1 * srcW + x0] * (1 - tx) + src[y1 * srcW + x1] * tx;
      const v = top * (1 - ty) + bottom * ty;
      dst[y * dstW + x] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
}

/** What the app does today (backgroundCompositor.composeMatte + useBackgroundEffect's options). */
const PRESET_CURRENT: MatteLabParams = {
  edgeMode: 'ramp',
  interpolation: 'bilinear',
  maskBlur: 0,
  postFeather: 0.5,
  matteLo: 0.3,
  matteHi: 0.75,
  temporalSmoothing: 0.25,
  contourThreshold: 0.5,
  contourSoftness: 1.5,
  matteScale: 0.5,
};

/** No blur at all, quarter-resolution matte: the cheap baseline. */
const PRESET_LIGHT: MatteLabParams = { ...PRESET_CURRENT, postFeather: 0, matteScale: 0.25 };

/** Smooth field at quarter resolution, cut at its iso-line in the composite. Same pass count as PRESET_LIGHT. */
const PRESET_CONTOUR: MatteLabParams = { ...PRESET_LIGHT, edgeMode: 'contour', interpolation: 'bicubic' };

/** What looked best in the lab: contour edge, a little blur at mask resolution (2 extra passes), softness 2. */
const PRESET_CONTOUR_BLUR: MatteLabParams = { ...PRESET_CONTOUR, maskBlur: 0.5, contourSoftness: 2 };

/** The same look in one pass: the blur is folded into the matte pass's mask read. */
const PRESET_CONTOUR_FUSED: MatteLabParams = { ...PRESET_CONTOUR_BLUR, interpolation: 'fused' };

const PRESETS: { label: string; params: MatteLabParams }[] = [
  { label: '現状（本番）', params: PRESET_CURRENT },
  { label: '軽量（ぼかしなし・1/4）', params: PRESET_LIGHT },
  { label: '曲線境界（1/4）', params: PRESET_CONTOUR },
  { label: '曲線境界＋ぼかし0.5（3パス）', params: PRESET_CONTOUR_BLUR },
  { label: '曲線境界＋ぼかし0.5（1パス）', params: PRESET_CONTOUR_FUSED },
];

const EDGE_MODE_LABELS: Record<EdgeMode, string> = {
  ramp: 'ランプ（lo/hiで直線的に・現状）',
  contour: '曲線境界（等高線で切る）',
};

const INTERPOLATION_LABELS: Record<Interpolation, string> = {
  bilinear: 'bilinear（現状）',
  bicubic: 'bicubic（B-spline・4タップ）',
  hermite: 'smoothstep補間',
  fused: 'ぼかし込み1パス（4×4タップ・強さ＝マスクぼかし）',
};

/** Short description of a parameter set, for benchmark rows. */
const describeParams = (p: MatteLabParams) =>
  [
    p.edgeMode === 'contour' ? '曲線' : 'ランプ',
    p.interpolation,
    p.maskBlur > 0 ? `ぼかし${p.maskBlur}` : null,
    p.postFeather > 0 ? `後段${p.postFeather}` : null,
    `マット${p.matteScale === 1 ? '等倍' : p.matteScale === 0.5 ? '1/2' : '1/4'}`,
  ]
    .filter(Boolean)
    .join(' / ');

const median = (values: number[]) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const BENCH_ROUNDS = 10;
/** Each burst should take at least this long, so timer resolution and sync overhead stay small next to it. */
const BENCH_MIN_BURST_MS = 15;
const BENCH_MAX_REPEATS = 4096;

interface BenchRow {
  id: PipelineId;
  description: string;
  passes: number;
  /** Wall-clock ms per matte computation: CPU-side command issue and GPU execution, whichever limits. */
  wallMs: number;
  /** GPU-only ms per matte computation (timer query); null when unavailable. */
  gpuMs: number | null;
}

interface BenchResult {
  renderer: string;
  model: string;
  frame: string;
  maskSize: string;
  repeats: number;
  rounds: number;
  /** ms of one empty burst (the readback sync alone), already subtracted from wallMs. */
  syncMs: number;
  rows: BenchRow[];
}

const selectClass = 'bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-sm disabled:opacity-50';
const buttonClass =
  'bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-1.5 text-sm disabled:opacity-50';

function Slider(props: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-0.5">
      <span className="flex justify-between text-xs">
        <span className="text-gray-300">{props.label}</span>
        <span className="text-gray-100 tabular-nums">{props.value}</span>
      </span>
      <input
        type="range"
        className="w-full"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {props.hint && <span className="block text-[11px] text-gray-500">{props.hint}</span>}
    </label>
  );
}

function ParamPanel(props: {
  title: string;
  accent: string;
  params: MatteLabParams;
  stats: PipelineStats | undefined;
  baseline: PipelineStats | undefined;
  timerSupported: boolean;
  onChange: (params: MatteLabParams) => void;
}) {
  const { params, onChange, stats, baseline } = props;
  const set = <K extends keyof MatteLabParams>(key: K, value: MatteLabParams[K]) =>
    onChange({ ...params, [key]: value });
  const ratio = stats?.gpuMs != null && baseline?.gpuMs ? stats.gpuMs / baseline.gpuMs : null;

  return (
    <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 space-y-3">
      <h2 className={`text-sm font-bold ${props.accent}`}>{props.title}</h2>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="text-[11px] bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded px-2 py-1"
            onClick={() => onChange(preset.params)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <label className="block space-y-0.5">
        <span className="text-xs text-gray-300">境界の作り方</span>
        <select
          className={`${selectClass} w-full`}
          value={params.edgeMode}
          onChange={(e) => set('edgeMode', e.target.value as EdgeMode)}
        >
          {(Object.keys(EDGE_MODE_LABELS) as EdgeMode[]).map((key) => (
            <option key={key} value={key}>
              {EDGE_MODE_LABELS[key]}
            </option>
          ))}
        </select>
        {params.edgeMode === 'contour' && (
          <span className="block text-[11px] text-gray-500">
            滑らかに拡大した信頼度の「等高線」を境界にする。補間は bicubic 推奨（bilinear だと等高線自体が階段になる）
          </span>
        )}
      </label>

      <label className="block space-y-0.5">
        <span className="text-xs text-gray-300">マスクの拡大補間</span>
        <select
          className={`${selectClass} w-full`}
          value={params.interpolation}
          onChange={(e) => set('interpolation', e.target.value as Interpolation)}
        >
          {(Object.keys(INTERPOLATION_LABELS) as Interpolation[]).map((key) => (
            <option key={key} value={key}>
              {INTERPOLATION_LABELS[key]}
            </option>
          ))}
        </select>
      </label>

      <Slider
        label="マスク解像度でのぼかし（マスクpx）"
        hint="急峻化の前に、モデルの出力そのままの解像度でぼかす（別に2パス）。補間が「ぼかし込み1パス」のときは別パスを使わず、この値をその強さにする"
        value={params.maskBlur}
        min={0}
        max={4}
        step={0.25}
        onChange={(v) => set('maskBlur', v)}
      />
      <Slider
        label="マット解像度でのぼかし（texel・急峻化の後）"
        hint="現状は0.5。0=パスごと省略"
        value={params.postFeather}
        min={0}
        max={6}
        step={0.25}
        onChange={(v) => set('postFeather', v)}
      />
      {params.edgeMode === 'ramp' ? (
        <>
          <Slider
            label="下限 lo"
            hint="これ未満は完全に背景"
            value={params.matteLo}
            min={0}
            max={0.95}
            step={0.01}
            onChange={(v) => set('matteLo', Math.min(v, params.matteHi - 0.02))}
          />
          <Slider
            label="上限 hi"
            hint="これ以上は完全に人物。hi−lo が狭いほど急峻"
            value={params.matteHi}
            min={0.05}
            max={1}
            step={0.01}
            onChange={(v) => set('matteHi', Math.max(v, params.matteLo + 0.02))}
          />
        </>
      ) : (
        <>
          <Slider
            label="境界の位置（閾値）"
            hint="信頼度がこの値の線を境界にする。上げると人物が細く、下げると太る"
            value={params.contourThreshold}
            min={0.05}
            max={0.95}
            step={0.01}
            onChange={(v) => set('contourThreshold', v)}
          />
          <Slider
            label="境界のやわらかさ（出力px）"
            hint="アンチエイリアスの幅。1前後でシャープ、3〜6でやわらかい"
            value={params.contourSoftness}
            min={0.5}
            max={8}
            step={0.25}
            onChange={(v) => set('contourSoftness', v)}
          />
        </>
      )}
      <Slider
        label="時間方向の平滑化"
        value={params.temporalSmoothing}
        min={0}
        max={0.95}
        step={0.05}
        onChange={(v) => set('temporalSmoothing', v)}
      />

      <label className="block space-y-0.5">
        <span className="text-xs text-gray-300">マット解像度（フレーム比）</span>
        <select
          className={`${selectClass} w-full`}
          value={params.matteScale}
          onChange={(e) => set('matteScale', Number(e.target.value) as MatteLabParams['matteScale'])}
        >
          <option value={1}>1（等倍）</option>
          <option value={0.5}>1/2（現状）</option>
          <option value={0.25}>1/4</option>
        </select>
      </label>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs border-t border-gray-800 pt-2">
        <dt className="text-gray-400">マット段のGPU時間</dt>
        <dd className="text-gray-100 tabular-nums">
          {!props.timerSupported
            ? '計測不可（拡張なし）'
            : stats?.gpuMs != null
              ? `${stats.gpuMs.toFixed(3)} ms${ratio != null ? `（A比 ${ratio.toFixed(2)}x）` : ''}`
              : '計測中…'}
        </dd>
        <dt className="text-gray-400">パス数</dt>
        <dd className="text-gray-100 tabular-nums">{stats?.passes ?? '-'}</dd>
        <dt className="text-gray-400">マット / マスク</dt>
        <dd className="text-gray-100 tabular-nums">
          {stats ? `${stats.matteSize.join('×')} / ${stats.maskSize.join('×')}` : '-'}
        </dd>
      </dl>
    </section>
  );
}

interface LiveSettings {
  params: Record<PipelineId, MatteLabParams>;
  view: 'result' | 'matte';
  split: number;
  zoom: number;
  center: [number, number];
  background: BackgroundKind;
  frozen: boolean;
  segFps: number;
}

export default function MatteEdgeLabPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<MatteLab | null>(null);
  const segmenterRef = useRef<ImageSegmenter | null>(null);
  const maskChoiceRef = useRef<{ index: number; resolved: boolean }>({ index: 0, resolved: false });
  const segTimingRef = useRef({ count: 0, totalMs: 0 });

  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('停止中');
  const [error, setError] = useState<string | null>(null);

  const [model, setModel] = useState<ModelChoice>('balanced');
  const [resolution, setResolution] = useState<ResolutionKey>(720);
  const [segFps, setSegFps] = useState<number>(15);
  const [frozen, setFrozen] = useState(false);
  const [paramsA, setParamsA] = useState<MatteLabParams>(PRESET_CONTOUR_BLUR);
  const [paramsB, setParamsB] = useState<MatteLabParams>(PRESET_CONTOUR_FUSED);
  const benchRef = useRef(false);
  const [bench, setBench] = useState<{ running: boolean; progress: string; result?: BenchResult }>({
    running: false,
    progress: '',
  });
  const [view, setView] = useState<'result' | 'matte'>('result');
  const [split, setSplit] = useState(0.5);
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState<[number, number]>([0.5, 0.5]);
  const [background, setBackground] = useState<BackgroundKind>('blur');
  const [stats, setStats] = useState<{
    a?: PipelineStats;
    b?: PipelineStats;
    timerSupported: boolean;
    segMs?: number;
    segPerSec?: number;
    rawMaskSize?: [number, number];
  }>({ timerSupported: true });
  const rawMaskSizeRef = useRef<[number, number] | undefined>(undefined);

  // The animation loop reads this instead of closing over state, so it never needs restarting.
  const live = useRef<LiveSettings>(null as unknown as LiveSettings);
  useEffect(() => {
    live.current = { params: { a: paramsA, b: paramsB }, view, split, zoom, center, background, frozen, segFps };
  }, [paramsA, paramsB, view, split, zoom, center, background, frozen, segFps]);

  // The model the mask in flight belongs to, for the invert table (the segmenter effect swaps models underneath the loop).
  const liveModelRef = useRef<ModelChoice>(model);
  useEffect(() => {
    liveModelRef.current = model;
  }, [model]);

  // ---- Segmenter: rebuilt when the model changes. Never two alive at once (see the worker's header comment). ----
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    setStatus(`モデル読み込み中…（${model}）`);
    segmenterRef.current?.close();
    segmenterRef.current = null;
    (async () => {
      try {
        const bytes = await loadSegmentationModel(model);
        const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_BASE);
        const create = (delegate: 'GPU' | 'CPU') =>
          ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: bytes, delegate },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
          });
        const segmenter = await create('GPU').catch(() => create('CPU'));
        if (cancelled) {
          segmenter.close();
          return;
        }
        maskChoiceRef.current = { index: 0, resolved: false };
        segmenterRef.current = segmenter;
        setStatus('実行中');
      } catch (err) {
        if (!cancelled) setError(`モデルの読み込みに失敗: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
      segmenterRef.current?.close();
      segmenterRef.current = null;
    };
  }, [running, model]);

  // ---- Main loop ----
  useEffect(() => {
    if (!running) return;
    const video = videoRef.current!;
    let raf = 0;
    let lastVideoTime = -1;
    let lastSegAt = 0;
    let lastTimestamp = 0;
    let quantized = new Uint8Array(0);

    const segmentOnce = (engine: MatteLab) => {
      const segmenter = segmenterRef.current;
      if (!segmenter) return;
      const t0 = performance.now();
      lastTimestamp = Math.max(lastTimestamp + 1, Math.round(t0));
      segmenter.segmentForVideo(video, lastTimestamp, (result) => {
        try {
          const masks = result.confidenceMasks ?? [];
          if (!maskChoiceRef.current.resolved && masks.length > 0) {
            const labels = segmenter.getLabels();
            const backgroundIndex = labels.findIndex((label) => label.toLowerCase() === 'background');
            maskChoiceRef.current = {
              index: masks.length === labels.length && backgroundIndex >= 0 ? backgroundIndex : 0,
              resolved: true,
            };
          }
          const mask = masks[maskChoiceRef.current.index] ?? masks[0];
          if (!mask) return;
          const floats = mask.getAsFloat32Array();
          rawMaskSizeRef.current = [mask.width, mask.height];
          const maskHeight = MASK_HEIGHT[liveModelRef.current];
          const maskWidth = Math.round((maskHeight * video.videoWidth) / video.videoHeight);
          if (quantized.length !== maskWidth * maskHeight) quantized = new Uint8Array(maskWidth * maskHeight);
          resampleMask(floats, mask.width, mask.height, quantized, maskWidth, maskHeight);
          engine.uploadMask(quantized, maskWidth, maskHeight, MODEL_INVERT[liveModelRef.current]);
          const { params } = live.current;
          engine.computeMatte('a', params.a);
          engine.computeMatte('b', params.b);
          segTimingRef.current.count += 1;
          segTimingRef.current.totalMs += performance.now() - t0;
        } finally {
          result.close();
        }
      });
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // The benchmark owns the GPU while it runs; anything drawn here would land inside its timings.
      if (benchRef.current) return;
      const engine = engineRef.current;
      const settings = live.current;
      if (!engine || !settings || video.readyState < 2) return;

      if (settings.frozen) {
        // Same frame, same mask: recompute every tick so parameter changes show up at once.
        if (engine.hasMask) {
          engine.computeMatte('a', settings.params.a);
          engine.computeMatte('b', settings.params.b);
        }
      } else {
        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;
          engine.uploadFrame(video);
        }
        if (now - lastSegAt >= 1000 / settings.segFps) {
          lastSegAt = now;
          segmentOnce(engine);
        }
      }
      engine.pollTimers();
      engine.render({
        params: settings.params,
        view: settings.view,
        split: settings.split,
        zoom: settings.zoom,
        center: settings.center,
        background: settings.background,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  // ---- Stats, 4x a second ----
  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    const timer = setInterval(() => {
      const engine = engineRef.current;
      if (!engine) return;
      const now = performance.now();
      const { count, totalMs } = segTimingRef.current;
      segTimingRef.current = { count: 0, totalMs: 0 };
      setStats((prev) => ({
        a: engine.stats('a'),
        b: engine.stats('b'),
        timerSupported: engine.timerSupported,
        segMs: count > 0 ? totalMs / count : prev.segMs,
        segPerSec: count > 0 ? count / ((now - last) / 1000) : prev.segPerSec,
        rawMaskSize: rawMaskSizeRef.current,
      }));
      last = now;
    }, 250);
    return () => clearInterval(timer);
  }, [running]);

  const stop = useCallback(() => {
    const video = videoRef.current;
    const stream = video?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    if (video) video.srcObject = null;
    engineRef.current?.destroy();
    engineRef.current = null;
    setRunning(false);
    setStatus('停止中');
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStatus('カメラ起動中…');
    try {
      const [width, height] = RESOLUTIONS[resolution];
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
        audio: false,
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      const canvas = canvasRef.current!;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      engineRef.current = new MatteLab(canvas);
      setCenter([0.5, 0.5]);
      setRunning(true);
    } catch (err) {
      setError(`起動に失敗: ${err instanceof Error ? err.message : String(err)}`);
      setStatus('停止中');
    }
  }, [resolution]);

  useEffect(() => () => stop(), [stop]);

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    // Where the clicked point sits in the image right now, given the current zoom.
    setCenter([center[0] + (u - 0.5) / zoom, center[1] + (v - 0.5) / zoom]);
  };

  const copySettings = () =>
    navigator.clipboard.writeText(
      JSON.stringify(
        { model, resolution, segFps, background, a: paramsA, b: paramsB, stats, bench: bench.result },
        null,
        2,
      ),
    );

  /**
   * Burst benchmark: runs each pipeline's matte stage back to back, many times, with the GPU flat
   * out — so its clock is at maximum for both and the per-run cost is comparable across models and
   * machines (unlike the live timings, which a lightly loaded GPU's power-saving clock inflates).
   * Rounds alternate the order and the medians are kept, so heat drift hits A and B alike.
   */
  const runBench = async () => {
    const engine = engineRef.current;
    if (!engine || !engine.hasMask) {
      setError('先にカメラを開始し、切り抜きが表示されてから実行してください。');
      return;
    }
    const params = { ...live.current.params };
    const alive = () => engineRef.current === engine;
    const discarded: WebGLQuery[] = [];
    benchRef.current = true;
    setError(null);
    try {
      const burst = (target: PipelineId | null, repeats: number) => {
        const query = engine.beginTimer();
        const t0 = performance.now();
        if (target) for (let i = 0; i < repeats; i += 1) engine.computeMatte(target, params[target], false);
        engine.endTimer();
        engine.finish();
        return { wall: performance.now() - t0, query };
      };

      setBench({ running: true, progress: 'ウォームアップ中…' });
      for (const target of ['a', 'b'] as const) {
        const { query } = burst(target, 20);
        if (query) discarded.push(query);
      }

      setBench({ running: true, progress: '回数を調整中…' });
      let repeats = 8;
      while (repeats < BENCH_MAX_REPEATS) {
        const a = burst('a', repeats);
        const b = burst('b', repeats);
        for (const q of [a.query, b.query]) if (q) discarded.push(q);
        if (Math.min(a.wall, b.wall) >= BENCH_MIN_BURST_MS) break;
        repeats *= 2;
        await sleep(0);
        if (!alive()) return;
      }

      const wall: Record<'none' | PipelineId, number[]> = { none: [], a: [], b: [] };
      const queries: Record<PipelineId, WebGLQuery[]> = { a: [], b: [] };
      for (let round = 0; round < BENCH_ROUNDS; round += 1) {
        setBench({ running: true, progress: `計測中… ${round + 1}/${BENCH_ROUNDS}（${repeats}回ずつ）` });
        const order: ('none' | PipelineId)[] = round % 2 === 0 ? ['none', 'a', 'b'] : ['b', 'a', 'none'];
        for (const key of order) {
          const { wall: ms, query } = burst(key === 'none' ? null : key, repeats);
          wall[key].push(ms);
          if (!query) continue;
          if (key === 'none') discarded.push(query);
          else queries[key].push(query);
        }
        await sleep(30);
        if (!alive()) return;
      }

      const readAll = async (list: WebGLQuery[]) => {
        const out: number[] = [];
        for (const query of list) {
          let value = engine.readTimer(query);
          for (let tries = 0; value === 'pending' && tries < 100; tries += 1) {
            await sleep(20);
            value = engine.readTimer(query);
          }
          if (typeof value === 'number') out.push(value);
        }
        return out;
      };
      const gpu = { a: await readAll(queries.a), b: await readAll(queries.b) };
      await readAll(discarded);

      const syncMs = median(wall.none);
      const rows: BenchRow[] = (['a', 'b'] as const).map((id) => ({
        id,
        description: describeParams(params[id]),
        passes: engine.stats(id).passes,
        wallMs: Math.max(0, median(wall[id]) - syncMs) / repeats,
        gpuMs: gpu[id].length > 0 ? median(gpu[id]) / repeats : null,
      }));
      const video = videoRef.current!;
      setBench({
        running: false,
        progress: '',
        result: {
          renderer: engine.renderer,
          model,
          frame: `${video.videoWidth}x${video.videoHeight}`,
          maskSize: engine.stats('a').maskSize.join('x'),
          repeats,
          rounds: BENCH_ROUNDS,
          syncMs,
          rows,
        },
      });
    } catch (err) {
      setError(`ベンチに失敗: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      benchRef.current = false;
      setBench((prev) => ({ ...prev, running: false, progress: '' }));
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 p-6 space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">マスク境界ラボ</h1>
        <p className="text-xs text-gray-400">
          同じマスクを2つのパイプライン（A / B）に通して並べて比較します。赤い線の左がA、右がB。
          フリーズして拡大し、パラメーターを動かすと確認しやすいです。
        </p>
        <p className="text-xs text-gray-400">
          状態: <span className="text-gray-200">{status}</span>
          {stats.segMs != null && (
            <span className="ml-3">
              切り抜き: {stats.segMs.toFixed(1)}ms / {stats.segPerSec?.toFixed(1)}回/秒（推論＋読み出し＋両マット。読み出しは実験用で本番より遅い）
            </span>
          )}
          {stats.rawMaskSize && (
            <span className="ml-3">
              MediaPipeの出力マスク: {stats.rawMaskSize.join('×')} → 本番と同じ {stats.a?.maskSize.join('×')} に縮小して使用
            </span>
          )}
        </p>
      </header>

      {error && <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded-lg p-3">{error}</p>}

      <div className="flex flex-wrap items-end gap-3">
        <button type="button" className={buttonClass} onClick={running ? stop : start}>
          {running ? '停止' : 'カメラ開始'}
        </button>
        <label className="text-xs space-y-0.5">
          <span className="block text-gray-400">モデル</span>
          <select className={selectClass} value={model} onChange={(e) => setModel(e.target.value as ModelChoice)}>
            {(Object.keys(MODEL_LABELS) as ModelChoice[]).map((key) => (
              <option key={key} value={key}>
                {MODEL_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs space-y-0.5">
          <span className="block text-gray-400">解像度（開始時）</span>
          <select
            className={selectClass}
            value={resolution}
            disabled={running}
            onChange={(e) => setResolution(Number(e.target.value) as ResolutionKey)}
          >
            {(Object.keys(RESOLUTIONS) as unknown as ResolutionKey[]).map((key) => (
              <option key={key} value={key}>
                {key}p
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs space-y-0.5">
          <span className="block text-gray-400">切り抜き回数/秒</span>
          <select className={selectClass} value={segFps} onChange={(e) => setSegFps(Number(e.target.value))}>
            {SEG_FPS.map((fps) => (
              <option key={fps} value={fps}>
                {fps}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs space-y-0.5">
          <span className="block text-gray-400">背景</span>
          <select
            className={selectClass}
            value={background}
            onChange={(e) => setBackground(e.target.value as BackgroundKind)}
          >
            <option value="blur">ぼかし（本番）</option>
            <option value="green">緑（境界が見やすい）</option>
            <option value="white">白</option>
            <option value="black">黒</option>
          </select>
        </label>
        <label className="text-xs space-y-0.5">
          <span className="block text-gray-400">表示</span>
          <select
            className={selectClass}
            value={view}
            onChange={(e) => setView(e.target.value as 'result' | 'matte')}
          >
            <option value="result">合成結果</option>
            <option value="matte">マット（白黒）</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={frozen} onChange={(e) => setFrozen(e.target.checked)} />
          フリーズ
        </label>
        <button type="button" className={buttonClass} onClick={copySettings}>
          設定と計測値をコピー
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-[1fr_1fr] items-center">
        <label className="block space-y-0.5">
          <span className="flex justify-between text-xs">
            <span className="text-gray-300">分割位置（0=Bのみ 〜 1=Aのみ）</span>
            <span className="tabular-nums">{split.toFixed(2)}</span>
          </span>
          <input
            type="range"
            className="w-full"
            min={0}
            max={1}
            step={0.01}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
          />
        </label>
        <div className="flex items-end gap-3">
          <label className="block space-y-0.5 flex-1">
            <span className="flex justify-between text-xs">
              <span className="text-gray-300">拡大（画像をクリックでその位置を中心に）</span>
              <span className="tabular-nums">{zoom}x</span>
            </span>
            <input
              type="range"
              className="w-full"
              min={1}
              max={12}
              step={0.5}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setZoom(1);
              setCenter([0.5, 0.5]);
            }}
          >
            リセット
          </button>
        </div>
      </div>

      <video ref={videoRef} muted playsInline className="absolute w-px h-px opacity-0 pointer-events-none" />
      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        onClick={onCanvasClick}
        className="w-full max-w-5xl rounded-xl bg-black aspect-video cursor-crosshair"
      />

      <div className="grid gap-4 md:grid-cols-2">
        <ParamPanel
          title="A（赤線の左）"
          accent="text-sky-300"
          params={paramsA}
          stats={stats.a}
          baseline={stats.a}
          timerSupported={stats.timerSupported}
          onChange={setParamsA}
        />
        <ParamPanel
          title="B（赤線の右）"
          accent="text-emerald-300"
          params={paramsB}
          stats={stats.b}
          baseline={stats.a}
          timerSupported={stats.timerSupported}
          onChange={setParamsB}
        />
      </div>

      <section className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-bold">負荷ベンチ（A / B のマット段）</h2>
          <button type="button" className={buttonClass} disabled={!running || bench.running} onClick={runBench}>
            {bench.running ? '実行中…' : 'ベンチ実行（約5〜15秒）'}
          </button>
          {bench.progress && <span className="text-xs text-gray-400">{bench.progress}</span>}
        </div>
        <p className="text-[11px] text-gray-500 max-w-3xl">
          今のA/Bの設定と今のマスクで、マット段だけを数百〜数千回まとめて実行し、1回あたりのコストを出します。GPUを全力で回すので、
          軽い負荷のときに起きる「省電力でクロックが下がって遅く見える」影響が消え、モデル間・PC間で比べられる数字になります。
          実行中は映像が止まります。古いPCではこのページを開いて同じボタンを押し、「設定と計測値をコピー」で結果を送ってください。
        </p>
        {bench.result && (
          <div className="space-y-2">
            <p className="text-xs text-gray-400">
              GPU: <span className="text-gray-200">{bench.result.renderer}</span> ／ モデル {bench.result.model} ／ 映像{' '}
              {bench.result.frame} ／ マスク {bench.result.maskSize} ／ {bench.result.repeats}回×{bench.result.rounds}
              ラウンド ／ 同期待ち {bench.result.syncMs.toFixed(2)}ms（差し引き済み）
            </p>
            <table className="w-full text-xs tabular-nums">
              <thead className="text-gray-400">
                <tr className="text-left">
                  <th className="py-1 pr-3 font-normal"></th>
                  <th className="py-1 pr-3 font-normal">方式</th>
                  <th className="py-1 pr-3 font-normal">パス数</th>
                  <th className="py-1 pr-3 font-normal">1回あたり（全体）</th>
                  <th className="py-1 pr-3 font-normal">うちGPU</th>
                  <th className="py-1 pr-3 font-normal">1秒あたり（×{segFps}回/秒）</th>
                  <th className="py-1 pr-3 font-normal">A比（全体）</th>
                </tr>
              </thead>
              <tbody>
                {bench.result.rows.map((row) => (
                  <tr key={row.id} className="border-t border-gray-800">
                    <td className={`py-1 pr-3 font-bold ${row.id === 'a' ? 'text-sky-300' : 'text-emerald-300'}`}>
                      {row.id.toUpperCase()}
                    </td>
                    <td className="py-1 pr-3">{row.description}</td>
                    <td className="py-1 pr-3">{row.passes}</td>
                    <td className="py-1 pr-3">{(row.wallMs * 1000).toFixed(1)} µs</td>
                    <td className="py-1 pr-3">{row.gpuMs != null ? `${(row.gpuMs * 1000).toFixed(1)} µs` : '計測不可'}</td>
                    <td className="py-1 pr-3">{(row.wallMs * segFps).toFixed(2)} ms/秒</td>
                    <td className="py-1 pr-3">
                      {(row.wallMs / Math.max(1e-9, bench.result!.rows[0].wallMs)).toFixed(2)}x
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-gray-500 max-w-3xl">
              「全体」はCPUがGL命令を出す時間とGPUの実行時間の、遅い方で決まります（パスが多いとCPU側も増える）。「うちGPU」はGPUの実行だけ。
              「全体」が「うちGPU」よりずっと大きいなら、そのPCではパス数（CPU側の命令発行）が効いています。
            </p>
          </div>
        )}
      </section>

      <p className="text-[11px] text-gray-500 max-w-3xl">
        GPU時間は「マスク1枚ぶんのマット計算（ぼかし・補間・急峻化・時間平滑・後段ぼかし）」だけで、カメラ映像の合成や背景ぼかしは含みません。
        Chrome以外や一部環境では計測できません。数値は短時間でゆらぐので、フリーズ状態で数秒見て平均を比べるのがおすすめです。
      </p>
    </div>
  );
}
