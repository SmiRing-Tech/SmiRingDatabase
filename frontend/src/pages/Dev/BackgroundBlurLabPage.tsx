import { useCallback, useEffect, useRef, useState } from 'react';
import { Track } from 'livekit-client';
import {
  loadSegmentationModel,
  MediapipeBackgroundProcessor,
  supportsMediapipeBackground,
} from '../../lib/video/MediapipeBackgroundProcessor';
import { supportsWorkerBackgroundSpike, WorkerBackgroundSpike } from '../../lib/video/WorkerBackgroundSpike';

/**
 * Dev-only bench for the MediaPipe background processor.
 *
 * The processor only ever needs a MediaStreamTrack, so this page drives it
 * straight from getUserMedia — no LiveKit server, no room token, no login.
 * Registered behind `import.meta.env.DEV` in App.tsx, so it never ships.
 *
 * Two halves:
 *  - Manual: pick one configuration and watch it (edge quality, motion artifacts).
 *  - Automatic: run a fixed list of configurations one after another and report each one's
 *    cost relative to the first (= what the app runs today), as a table to paste back. Meant to
 *    be run on a fast machine first to rank the options by ratio, then confirmed on a slow one.
 *    For a CPU-bound picture on a fast machine, turn on DevTools' CPU throttling (Performance
 *    panel) and note which setting you used in the "CPU throttle" field — it only labels the
 *    report, the page can't detect it. GPU work can't be throttled that way; "GPU完了待ち"
 *    makes the per-frame timings include it instead.
 *
 * "メイン vs Worker" runs the same configurations on the main-thread processor and on the worker
 * spike (lib/video/backgroundSpike.worker.ts) alternately, to decide whether moving the pipeline
 * off the main thread is worth the real refactor: same cost, and no page freeze while loading.
 *
 * Rule from the product side: segmentation never runs at less than half the camera's frame rate
 * (below that the matte visibly lags behind motion), so every configuration here respects it.
 */

type ModelChoice = 'balanced' | 'high' | 'square';

const MODEL_LABELS: Record<ModelChoice, string> = {
  balanced: '標準 / selfie_segmenter_landscape（244KB・本番）',
  high: '高精細 / selfie_multiclass_256x256（15.6MB・本番のHD）',
  square: '正方形 / selfie_segmenter 256x256（実験）',
};

/** The square model isn't one the app ships, so it's handed to the processor by URL. */
const SQUARE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

const RESOLUTIONS = {
  720: { width: 1280, height: 720 },
  540: { width: 960, height: 540 },
  360: { width: 640, height: 360 },
} as const;
type ResolutionKey = keyof typeof RESOLUTIONS;

const CAMERA_FPS = [20, 15, 10] as const;
/** Segmentation rates allowed for a camera rate: never below half of it. */
const segRatesFor = (cameraFps: number) => [20, 15, 10, 5].filter((r) => r <= cameraFps && r >= cameraFps / 2);

interface LabConfig {
  label: string;
  model: ModelChoice;
  delegate: 'GPU' | 'CPU';
  resolution: ResolutionKey;
  cameraFps: number;
  segFps: number;
  /** 'interval' reproduces the app exactly (≈ half the camera rate in practice); 'exact' hits segFps. */
  scheduler: 'interval' | 'exact';
  /** Where the pipeline runs: the app's processor on the main thread, or the worker spike. */
  path: RunPath;
}

type RunPath = 'main' | 'worker' | 'split';
const PATH_LABELS: Record<RunPath, string> = { main: 'メイン', worker: 'Worker', split: 'Worker分離' };

const APP_DEFAULT: LabConfig = {
  label: '基準（本番と同じ）',
  model: 'balanced',
  delegate: 'GPU',
  resolution: 720,
  cameraFps: 20,
  segFps: 20,
  scheduler: 'interval',
  path: 'main',
};

/** One factor at a time from what the app runs, plus a couple of combinations. */
const SUITE: LabConfig[] = [
  APP_DEFAULT,
  { ...APP_DEFAULT, label: '切り抜き 毎フレーム(20/s)', scheduler: 'exact', segFps: 20 },
  { ...APP_DEFAULT, label: '切り抜き 15/s', scheduler: 'exact', segFps: 15 },
  { ...APP_DEFAULT, label: '切り抜き 10/s（本番相当を正確に）', scheduler: 'exact', segFps: 10 },
  { ...APP_DEFAULT, label: 'モデル: 高精細', model: 'high' },
  { ...APP_DEFAULT, label: '解像度 540p', resolution: 540 },
  { ...APP_DEFAULT, label: '解像度 360p', resolution: 360 },
  { ...APP_DEFAULT, label: 'カメラ15fps / 切り抜き15', cameraFps: 15, segFps: 15, scheduler: 'exact' },
  { ...APP_DEFAULT, label: 'カメラ15fps / 切り抜き10', cameraFps: 15, segFps: 10, scheduler: 'exact' },
  { ...APP_DEFAULT, label: 'カメラ10fps / 切り抜き10', cameraFps: 10, segFps: 10, scheduler: 'exact' },
  { ...APP_DEFAULT, label: 'カメラ10fps / 切り抜き5', cameraFps: 10, segFps: 5, scheduler: 'exact' },
  { ...APP_DEFAULT, label: '組合せ: 540p・15fps・切り抜き10', resolution: 540, cameraFps: 15, segFps: 10, scheduler: 'exact' },
  { ...APP_DEFAULT, label: '組合せ: 360p・15fps・切り抜き10', resolution: 360, cameraFps: 15, segFps: 10, scheduler: 'exact' },
  { ...APP_DEFAULT, label: '基準（再計測・温度変化の確認）' },
];

/** Main and worker alternately (so drift from heat hits both alike), for a few telling configs. */
const PATH_SUITE: LabConfig[] = ([
  APP_DEFAULT,
  { ...APP_DEFAULT, model: 'high', label: 'モデル: 高精細' },
  { ...APP_DEFAULT, cameraFps: 10, segFps: 5, scheduler: 'exact', label: 'カメラ10fps / 切り抜き5' },
  { ...APP_DEFAULT, label: '基準（再計測）' },
] satisfies LabConfig[]).flatMap((c): LabConfig[] => [c, { ...c, path: 'worker' }, { ...c, path: 'split' }]);

for (const c of [...SUITE, ...PATH_SUITE]) {
  if (c.scheduler === 'exact' && c.segFps < c.cameraFps / 2) throw new Error(`suite config breaks the half-rate rule: ${c.label}`);
}

const WARMUP_MS = 3000;

/** Both models' bytes in memory before a swap test, so no swap includes a download. */
const loadModelsForSwapTest = () => Promise.all([loadSegmentationModel('balanced'), loadSegmentationModel('high')]);

/** Rough suite duration at the default 8s measurement, for the buttons. */
const suiteMinutes = (count: number) => Math.ceil((count * (8 + WARMUP_MS / 1000 + 4)) / 60);

interface LabResult {
  config: LabConfig;
  captureFps?: number;
  outputFps: number;
  procFps?: number;
  frameMsAvg?: number;
  segPerSec: number;
  segmentMsAvg?: number;
  /** Main-thread ms per second spent in the processor (frame cost x frames) — the headline load figure. */
  busyMsPerSec?: number;
  longTaskMsPerSec: number;
  loadMs: number;
  loadLongTaskMaxMs: number;
  /** Worst main-thread timer delay while loading — "how long the page froze". */
  loadLagMaxMs: number;
  /** Worst gap between frames of the raw camera preview while loading — also catches GPU stalls. */
  loadVideoGapMaxMs: number;
  loadTimings: MediapipeBackgroundProcessor['loadTimings'];
}

/** What the lab needs from either path (the worker's snapshot is a round trip, hence the Promise). */
interface LabProcessor {
  processedTrack?: MediaStreamTrack;
  loadTimings: MediapipeBackgroundProcessor['loadTimings'];
  waitUntilReady(timeoutMs?: number): Promise<void>;
  takePerfSnapshot(): Record<string, unknown> | Promise<Record<string, unknown>>;
  destroy(): Promise<void>;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long Tasks API accumulator, so load freezes and steady-state stalls can be read separately. */
function createLongTaskMeter() {
  let total = 0;
  let max = 0;
  const supported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask');
  const observer = supported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          total += entry.duration;
          max = Math.max(max, entry.duration);
        }
      })
    : null;
  observer?.observe({ type: 'longtask', buffered: false });
  return {
    take() {
      const result = { total, max };
      total = 0;
      max = 0;
      return result;
    },
    stop() {
      observer?.disconnect();
    },
  };
}

/**
 * Page responsiveness while a processor loads: a 50ms timer's worst lateness (main thread only),
 * and the worst gap between frames of a <video> (main thread + compositor/GPU process).
 */
function createJankMeter(video: HTMLVideoElement | null) {
  const TICK_MS = 50;
  let lagMax = 0;
  let expected = performance.now() + TICK_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    lagMax = Math.max(lagMax, now - expected);
    expected = now + TICK_MS;
  }, TICK_MS);
  let gapMax = 0;
  let lastFrameAt = 0;
  let handle = 0;
  const canWatchVideo = !!video && 'requestVideoFrameCallback' in video;
  const onFrame = (now: number) => {
    if (lastFrameAt) gapMax = Math.max(gapMax, now - lastFrameAt);
    lastFrameAt = now;
    handle = video!.requestVideoFrameCallback(onFrame);
  };
  if (canWatchVideo) handle = video!.requestVideoFrameCallback(onFrame);
  return {
    stop() {
      clearInterval(timer);
      if (canWatchVideo) video!.cancelVideoFrameCallback(handle);
      return { lagMax: Math.max(0, lagMax), gapMax };
    },
  };
}

/**
 * How long a <video> showed (near-)black: samples it every 50ms into a tiny canvas. A video with
 * no frame at all (srcObject just replaced) samples as black too, which is what the viewer sees.
 */
function createBlackMeter(video: HTMLVideoElement | null) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let blackMs = 0;
  let lastAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 32, 18);
    if (video && video.readyState >= 2) ctx.drawImage(video, 0, 0, 32, 18);
    const data = ctx.getImageData(0, 0, 32, 18).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    if (sum / (data.length / 4) / 3 < 6) blackMs += now - lastAt;
    lastAt = now;
  }, 50);
  return {
    stop() {
      clearInterval(timer);
      return blackMs;
    },
  };
}

interface SwapResult {
  path: RunPath;
  from: 'balanced' | 'high';
  to: 'balanced' | 'high';
  swapMs: number;
  blackMs: number;
  outputGapMaxMs: number;
  lagMaxMs: number;
}

const SWAP_PATHS: RunPath[] = ['main', 'split'];
const SWAPS_PER_PATH = 4;
const QUALITY_LABELS = { balanced: '標準', high: '高精細' } as const;

export default function BackgroundBlurLabPage() {
  const rawVideoRef = useRef<HTMLVideoElement>(null);
  const processedVideoRef = useRef<HTMLVideoElement>(null);
  const processorRef = useRef<LabProcessor | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const outputFramesRef = useRef(0);
  const cancelSuiteRef = useRef(false);

  const [supported] = useState(() => supportsMediapipeBackground());
  const [workerSupported] = useState(() => supportsWorkerBackgroundSpike());
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('カメラ未起動');
  const [error, setError] = useState('');
  const [live, setLive] = useState<Record<string, unknown> | null>(null);

  // Manual configuration.
  const [model, setModel] = useState<ModelChoice>('balanced');
  const [delegate, setDelegate] = useState<'GPU' | 'CPU'>('GPU');
  const [resolution, setResolution] = useState<ResolutionKey>(720);
  const [cameraFps, setCameraFps] = useState(20);
  const [segFps, setSegFps] = useState(20);
  const [scheduler, setScheduler] = useState<'interval' | 'exact'>('interval');
  const [mode, setMode] = useState<'blur' | 'image'>('blur');
  const [path, setPath] = useState<RunPath>('main');

  // Automatic suite.
  const [gpuSync, setGpuSync] = useState(false);
  const [throttleLabel, setThrottleLabel] = useState('なし');
  const [measureSec, setMeasureSec] = useState(8);
  const [suiteRunning, setSuiteRunning] = useState(false);
  const [suiteName, setSuiteName] = useState('');
  const [results, setResults] = useState<LabResult[]>([]);
  const [copied, setCopied] = useState(false);
  const [swapResults, setSwapResults] = useState<SwapResult[]>([]);
  const [swapCopied, setSwapCopied] = useState(false);
  const [manualQuality, setManualQuality] = useState<'balanced' | 'high'>('balanced');

  useEffect(() => {
    const allowed = segRatesFor(cameraFps);
    if (!allowed.includes(segFps)) setSegFps(allowed[0]);
  }, [cameraFps, segFps]);

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

  /** Camera + processor for one configuration. Resolves once the processor's output is stable. */
  /** Builds a processor for `config` on an already-open camera track, shows its output, waits until ready. */
  const startProcessor = useCallback(
    async (config: LabConfig, cameraTrack: MediaStreamTrack, measureGpuSync: boolean): Promise<LabProcessor> => {
      const quality = config.model === 'high' ? 'high' : 'balanced';
      const common = {
        delegate: config.delegate,
        segmentationFps: config.segFps,
        segmentationScheduler: config.scheduler,
        measureGpuSync,
        blurRadius: 16,
        temporalSmoothing: 0.25,
        edgeFeather: 1.5,
      };
      let processor: LabProcessor;
      if (config.path === 'main') {
        const main = new MediapipeBackgroundProcessor({
          ...common,
          quality,
          assetPaths: config.model === 'square' ? { modelAssetPath: SQUARE_MODEL_URL } : undefined,
          mode,
        });
        processorRef.current = main;
        await main.init({ kind: Track.Kind.Video, track: cameraTrack });
        processor = main;
      } else {
        const spike = new WorkerBackgroundSpike({
          ...common,
          quality,
          modelUrl: config.model === 'square' ? SQUARE_MODEL_URL : undefined,
          split: config.path === 'split',
        });
        processorRef.current = spike;
        await spike.init({ track: cameraTrack });
        processor = spike;
      }
      const processedTrack = processor.processedTrack;
      if (!processedTrack) throw new Error('processedTrack が生成されませんでした');
      if (processedVideoRef.current) {
        processedVideoRef.current.srcObject = new MediaStream([processedTrack]);
        await processedVideoRef.current.play().catch(() => {});
      }
      await processor.waitUntilReady(10_000);
      return processor;
    },
    [mode],
  );

  /** Camera + processor for one configuration. Resolves once the processor's output is stable. */
  const launch = useCallback(
    async (config: LabConfig, measureGpuSync: boolean) => {
      await teardown();
      const size = RESOLUTIONS[config.resolution];
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: size.width, height: size.height, frameRate: { ideal: config.cameraFps, max: config.cameraFps } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      const cameraTrack = stream.getVideoTracks()[0];
      if (rawVideoRef.current) {
        rawVideoRef.current.srcObject = new MediaStream([cameraTrack]);
        await rawVideoRef.current.play().catch(() => {});
      }
      // Let the raw preview settle so the jank meter's first gap isn't the camera starting up.
      await sleep(500);
      const jank = createJankMeter(rawVideoRef.current);
      const t0 = performance.now();
      const processor = await startProcessor(config, cameraTrack, measureGpuSync);
      const loadMs = performance.now() - t0;
      const loadJank = jank.stop();
      return { processor, cameraTrack, loadMs, loadJank };
    },
    [teardown, startProcessor],
  );

  /**
   * Switches the running processor's model. Split worker: the seamless hand-over. Otherwise what
   * the app does today: stop the running processor, then build the new one.
   */
  const swapModel = useCallback(
    async (config: LabConfig, target: 'balanced' | 'high') => {
      const current = processorRef.current;
      const cameraTrack = cameraStreamRef.current?.getVideoTracks()[0];
      if (!current || !cameraTrack) throw new Error('カメラが起動していません');
      if (config.path === 'split' && current instanceof WorkerBackgroundSpike) {
        await current.setQuality(target);
        return;
      }
      processorRef.current = null;
      await current.destroy();
      if (processedVideoRef.current) processedVideoRef.current.srcObject = null;
      await startProcessor({ ...config, model: target }, cameraTrack, false);
    },
    [startProcessor],
  );

  const manualConfig: LabConfig = {
    label: '手動',
    model,
    delegate,
    resolution,
    cameraFps,
    segFps,
    scheduler,
    path,
  };

  const startManual = useCallback(async () => {
    setBusy(true);
    setError('');
    setStatus('準備中…');
    try {
      await launch(manualConfig, false);
      setManualQuality(model === 'high' ? 'high' : 'balanced');
      setRunning(true);
      setStatus('稼働中');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setStatus('エラー');
      await teardown();
    } finally {
      setBusy(false);
    }
    // manualConfig is rebuilt every render from the fields listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch, teardown, model, delegate, resolution, cameraFps, segFps, scheduler, path]);

  const stopManual = useCallback(async () => {
    await teardown();
    setRunning(false);
    setLive(null);
    setStatus('停止しました');
  }, [teardown]);

  // Output frames actually delivered on the processed track (shared by manual and suite).
  useEffect(() => {
    const video = processedVideoRef.current;
    if (!video || !('requestVideoFrameCallback' in video)) return;
    let handle = 0;
    let cancelled = false;
    const tick = () => {
      outputFramesRef.current += 1;
      if (!cancelled) handle = video.requestVideoFrameCallback(tick);
    };
    handle = video.requestVideoFrameCallback(tick);
    return () => {
      cancelled = true;
      video.cancelVideoFrameCallback(handle);
    };
  }, [running, suiteRunning]);

  // Live readout while running manually.
  useEffect(() => {
    if (!running) return;
    const meter = createLongTaskMeter();
    outputFramesRef.current = 0;
    void processorRef.current?.takePerfSnapshot();
    const timer = setInterval(async () => {
      const snap = (await processorRef.current?.takePerfSnapshot()) ?? {};
      const longTasks = meter.take();
      const frameMs = num(snap.frameMsAvg);
      const fps = num(snap.fps);
      setLive({
        ...snap,
        outputFps: outputFramesRef.current,
        busyMsPerSec: num(snap.busyMsPerSec) ?? (frameMs !== undefined && fps !== undefined ? Math.round(frameMs * fps) : undefined),
        longTaskMs: Math.round(longTasks.total),
        captureFps: cameraStreamRef.current?.getVideoTracks()[0]?.getSettings().frameRate,
      });
      outputFramesRef.current = 0;
    }, 1000);
    return () => {
      clearInterval(timer);
      meter.stop();
    };
  }, [running]);

  const runSuite = useCallback(async (suite: LabConfig[], name: string) => {
    cancelSuiteRef.current = false;
    setSuiteName(name);
    setSuiteRunning(true);
    setRunning(false);
    setResults([]);
    setError('');
    const collected: LabResult[] = [];
    try {
      // Warm caches (model downloads, WASM) so the first rows' load times aren't download times.
      setStatus('準備: モデルを事前に読み込み中…');
      await fetch(SQUARE_MODEL_URL).catch(() => {});
      const warmups: LabConfig[] = [APP_DEFAULT, { ...APP_DEFAULT, model: 'high' }];
      if (suite.some((c) => c.path === 'worker')) warmups.push({ ...APP_DEFAULT, path: 'worker' });
      if (suite.some((c) => c.path === 'split')) warmups.push({ ...APP_DEFAULT, path: 'split' });
      for (const warm of warmups) {
        await launch(warm, false).catch(() => {});
      }

      for (let i = 0; i < suite.length; i++) {
        if (cancelSuiteRef.current) break;
        const config = suite[i];
        setStatus(`計測中 ${i + 1}/${suite.length}: ${config.label}（${PATH_LABELS[config.path]}）`);
        const loadMeter = createLongTaskMeter();
        const { processor, cameraTrack, loadMs, loadJank } = await launch(config, gpuSync);
        const loadLongTasks = loadMeter.take();
        loadMeter.stop();

        await sleep(WARMUP_MS);
        await processor.takePerfSnapshot();
        const meter = createLongTaskMeter();
        outputFramesRef.current = 0;
        const t0 = performance.now();
        await sleep(measureSec * 1000);
        const seconds = (performance.now() - t0) / 1000;
        const snap = await processor.takePerfSnapshot();
        const longTasks = meter.take();
        meter.stop();

        const frameMs = num(snap.frameMsAvg);
        const procFps = num(snap.fps);
        const segmentations = num(snap.segmentations) ?? 0;
        collected.push({
          config,
          captureFps: cameraTrack.getSettings().frameRate,
          outputFps: outputFramesRef.current / seconds,
          procFps,
          frameMsAvg: frameMs,
          segPerSec: segmentations / seconds,
          segmentMsAvg: num(snap.segmentMsAvg),
          busyMsPerSec: num(snap.busyMsPerSec) ?? (frameMs !== undefined && procFps !== undefined ? frameMs * procFps : undefined),
          longTaskMsPerSec: longTasks.total / seconds,
          loadMs,
          loadLongTaskMaxMs: loadLongTasks.max,
          loadLagMaxMs: loadJank.lagMax,
          loadVideoGapMaxMs: loadJank.gapMax,
          loadTimings: { ...processor.loadTimings },
        });
        setResults([...collected]);
      }
      setStatus(cancelSuiteRef.current ? '中断しました' : '自動計測が完了しました');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setStatus('エラー');
    } finally {
      await teardown();
      setSuiteRunning(false);
    }
  }, [launch, teardown, gpuSync, measureSec]);

  const reportMarkdown = useCallback(() => {
    const base = results[0]?.busyMsPerSec;
    const f = (v: number | undefined, digits = 1) => (v === undefined ? '-' : v.toFixed(digits));
    const lines = [
      `背景エフェクト計測（${suiteName}） ${new Date().toISOString().slice(0, 16)} | ${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? ''} | CPUコア ${navigator.hardwareConcurrency} | GPU完了待ち ${gpuSync ? 'ON' : 'OFF'} | CPU throttle ${throttleLabel} | 計測${measureSec}秒`,
      '',
      '| 設定 | 場所 | 負荷(ms/秒) | 基準比 | 1フレーム(ms) | 処理fps | 出力fps | 切り抜き/秒 | 切り抜き1回(ms) | 長いタスク(ms/秒) | 読込(ms) | 読込中の最大固まり(ms) | 読込中の画面停止(ms) | 読込中の元映像コマ間隔(ms) | 読込内訳 WASM/モデル/生成/初回推論 |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...results.map((r) => {
        const t = r.loadTimings;
        return `| ${r.config.label} | ${PATH_LABELS[r.config.path]} | ${f(r.busyMsPerSec)} | ${base && r.busyMsPerSec !== undefined ? (r.busyMsPerSec / base).toFixed(2) : '-'} | ${f(r.frameMsAvg, 2)} | ${f(r.procFps)} | ${f(r.outputFps)} | ${f(r.segPerSec)} | ${f(r.segmentMsAvg, 2)} | ${f(r.longTaskMsPerSec)} | ${Math.round(r.loadMs)} | ${Math.round(r.loadLongTaskMaxMs)} | ${Math.round(r.loadLagMaxMs)} | ${Math.round(r.loadVideoGapMaxMs)} | ${t.filesetMs ?? '-'}/${t.modelFetchMs ?? '-'}/${t.createSegmenterMs ?? '-'}/${t.firstSegmentationMs ?? '-'} |`;
      }),
    ];
    return lines.join('\n');
  }, [results, gpuSync, throttleLabel, measureSec, suiteName]);

  const copyReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(reportMarkdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(`コピーできませんでした: ${String(e)}`);
    }
  }, [reportMarkdown]);

  /** Starts on 標準, then switches 標準 <-> 高精細 a few times per path, watching the processed preview. */
  const runSwapTest = useCallback(async () => {
    cancelSuiteRef.current = false;
    setSuiteRunning(true);
    setRunning(false);
    setSwapResults([]);
    setError('');
    const collected: SwapResult[] = [];
    try {
      setStatus('準備: モデルを事前に読み込み中…');
      await loadModelsForSwapTest();
      for (const swapPath of SWAP_PATHS) {
        if (cancelSuiteRef.current) break;
        const config: LabConfig = { ...APP_DEFAULT, path: swapPath };
        setStatus(`切り替えテスト（${PATH_LABELS[swapPath]}）: 起動中…`);
        await launch(config, false);
        await sleep(3000);
        let quality: 'balanced' | 'high' = 'balanced';
        for (let i = 0; i < SWAPS_PER_PATH && !cancelSuiteRef.current; i++) {
          const target: 'balanced' | 'high' = quality === 'balanced' ? 'high' : 'balanced';
          setStatus(`切り替えテスト（${PATH_LABELS[swapPath]}）${i + 1}/${SWAPS_PER_PATH}: ${QUALITY_LABELS[quality]} → ${QUALITY_LABELS[target]}`);
          const jank = createJankMeter(processedVideoRef.current);
          const black = createBlackMeter(processedVideoRef.current);
          const t0 = performance.now();
          await swapModel(config, target);
          const swapMs = performance.now() - t0;
          // Keep watching a little past the hand-over: a late black flash or stall still counts.
          await sleep(2500);
          const blackMs = black.stop();
          const { lagMax, gapMax } = jank.stop();
          collected.push({ path: swapPath, from: quality, to: target, swapMs, blackMs, outputGapMaxMs: gapMax, lagMaxMs: lagMax });
          setSwapResults([...collected]);
          quality = target;
          await sleep(1500);
        }
        await teardown();
      }
      setStatus(cancelSuiteRef.current ? '中断しました' : '切り替えテストが完了しました');
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setStatus('エラー');
    } finally {
      await teardown();
      setSuiteRunning(false);
    }
  }, [launch, swapModel, teardown]);

  const swapReportMarkdown = useCallback(() => {
    const lines = [
      `背景エフェクト モデル切り替えテスト ${new Date().toISOString().slice(0, 16)} | ${navigator.userAgent.match(/(Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? ''} | CPUコア ${navigator.hardwareConcurrency} | CPU throttle ${throttleLabel}`,
      '',
      '| 場所 | 切り替え | 切り替え完了まで(ms) | 黒い画面の時間(ms) | 適用後映像の最大停止(ms) | 画面スレッドの最大停止(ms) |',
      '|---|---|---|---|---|---|',
      ...swapResults.map(
        (r) =>
          `| ${PATH_LABELS[r.path]} | ${QUALITY_LABELS[r.from]}→${QUALITY_LABELS[r.to]} | ${Math.round(r.swapMs)} | ${Math.round(r.blackMs)} | ${Math.round(r.outputGapMaxMs)} | ${Math.round(r.lagMaxMs)} |`,
      ),
    ];
    return lines.join('\n');
  }, [swapResults, throttleLabel]);

  const copySwapReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(swapReportMarkdown());
      setSwapCopied(true);
      setTimeout(() => setSwapCopied(false), 2000);
    } catch (e) {
      setError(`コピーできませんでした: ${String(e)}`);
    }
  }, [swapReportMarkdown]);

  /** Manual mode: switch the running processor between 標準 and 高精細 to watch the hand-over. */
  const swapManual = useCallback(async () => {
    const target = manualQuality === 'balanced' ? 'high' : 'balanced';
    setBusy(true);
    setError('');
    setStatus(`切り替え中: ${QUALITY_LABELS[manualQuality]} → ${QUALITY_LABELS[target]}`);
    try {
      const t0 = performance.now();
      await swapModel({ ...manualConfig, model: manualQuality }, target);
      setManualQuality(target);
      setStatus(`稼働中（${QUALITY_LABELS[target]}・切り替え ${Math.round(performance.now() - t0)}ms）`);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : String(e));
      setStatus('エラー');
    } finally {
      setBusy(false);
    }
    // manualConfig is rebuilt every render from the manual fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swapModel, manualQuality, model, delegate, resolution, cameraFps, segFps, scheduler, path]);

  if (!supported) {
    return (
      <div className="min-h-screen bg-gray-950 text-gray-200 p-8">
        <h1 className="text-xl font-bold mb-2">背景エフェクト計測</h1>
        <p className="text-sm text-red-400">このブラウザは WebGL2 / VideoFrame に対応していないため実行できません。</p>
      </div>
    );
  }

  const selectClass = 'bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 disabled:opacity-50';
  const locked = busy || suiteRunning;
  const base = results[0]?.busyMsPerSec;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 p-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">背景エフェクト計測（開発用）</h1>
        <p className="text-xs text-gray-400">
          LiveKit サーバー不要。カメラ映像に直接プロセッサを適用します。切り抜きはカメラの半分のレートを下限にしています。
        </p>
        <p className="text-xs text-gray-400">
          状態: <span className="text-gray-200">{status}</span>
        </p>
      </header>

      {error && <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded-lg p-3">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <figure className="space-y-1">
          <figcaption className="text-xs text-gray-400">元映像</figcaption>
          <video ref={rawVideoRef} muted playsInline className="w-full rounded-xl bg-black aspect-video object-cover" />
        </figure>
        <figure className="space-y-1">
          <figcaption className="text-xs text-gray-400">プロセッサ適用後</figcaption>
          <video ref={processedVideoRef} muted playsInline className="w-full rounded-xl bg-black aspect-video object-cover" />
        </figure>
      </div>

      {/* ---------------- Automatic suite ---------------- */}
      <section className="space-y-3 border border-gray-800 rounded-2xl p-4">
        <h2 className="font-bold text-sm">自動計測</h2>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={gpuSync} onChange={(e) => setGpuSync(e.target.checked)} disabled={locked} />
            GPU完了待ちで計測（GPU側の負荷も含める）
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">CPU throttle（DevToolsで設定したもの）</span>
            <select value={throttleLabel} onChange={(e) => setThrottleLabel(e.target.value)} disabled={locked} className={selectClass}>
              {['なし', '4x', '6x', '20x'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">1パターンの計測秒数</span>
            <select value={measureSec} onChange={(e) => setMeasureSec(Number(e.target.value))} disabled={locked} className={selectClass}>
              {[5, 8, 15].map((v) => (
                <option key={v} value={v}>
                  {v}秒
                </option>
              ))}
            </select>
          </label>
          {suiteRunning ? (
            <button onClick={() => (cancelSuiteRef.current = true)} className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 font-bold">
              中断
            </button>
          ) : (
            <>
              <button onClick={() => void runSuite(SUITE, '全パターン')} disabled={busy} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 font-bold">
                全パターン（{SUITE.length}・約{suiteMinutes(SUITE.length)}分）
              </button>
              <button
                onClick={() => void runSuite(PATH_SUITE, 'メイン vs Worker')}
                disabled={busy || !workerSupported}
                title={workerSupported ? undefined : 'このブラウザは Worker 版に対応していません'}
                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 font-bold"
              >
                メイン vs Worker（{PATH_SUITE.length}・約{suiteMinutes(PATH_SUITE.length)}分）
              </button>
            </>
          )}
          {results.length > 0 && !suiteRunning && (
            <button onClick={() => void copyReport()} className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 font-bold">
              {copied ? 'コピーしました' : '結果をコピー（表）'}
            </button>
          )}
        </div>
        <p className="text-[11px] text-gray-500">
          計測中はこのタブを前面に出したまま、ほかのアプリをなるべく閉じてください。「負荷(ms/秒)」は背景エフェクトの処理スレッド（メイン版は画面のスレッド、Worker版はWorker）を1秒あたり何ms使ったかで、基準比が小さいほど軽い設定です。「読込中の画面停止」は読み込み中に画面のスレッドが止まった最長時間、「元映像コマ間隔」は左の元映像が止まった最長時間です。
        </p>
        {results.length > 0 && (
          <div className="overflow-x-auto">
            <table className="text-[11px] tabular-nums">
              <thead className="text-gray-400">
                <tr>
                  {['設定', '場所', '負荷(ms/秒)', '基準比', '1フレーム(ms)', '処理fps', '切り抜き/秒', '長いタスク(ms/秒)', '読込(ms)', '読込中の最大固まり(ms)', '読込中の画面停止(ms)', '読込中の元映像コマ間隔(ms)'].map((h) => (
                    <th key={h} className="text-left font-semibold pr-4 pb-1">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => (
                  <tr key={i} className="border-t border-gray-800">
                    <td className="pr-4 py-1">{r.config.label}</td>
                    <td className="pr-4">{PATH_LABELS[r.config.path]}</td>
                    <td className="pr-4">{r.busyMsPerSec?.toFixed(1) ?? '-'}</td>
                    <td className="pr-4 font-bold">{base && r.busyMsPerSec !== undefined ? (r.busyMsPerSec / base).toFixed(2) : '-'}</td>
                    <td className="pr-4">{r.frameMsAvg?.toFixed(2) ?? '-'}</td>
                    <td className="pr-4">{r.procFps?.toFixed(1) ?? '-'}</td>
                    <td className="pr-4">{r.segPerSec.toFixed(1)}</td>
                    <td className="pr-4">{r.longTaskMsPerSec.toFixed(1)}</td>
                    <td className="pr-4">{Math.round(r.loadMs)}</td>
                    <td className="pr-4">{Math.round(r.loadLongTaskMaxMs)}</td>
                    <td className="pr-4">{Math.round(r.loadLagMaxMs)}</td>
                    <td className="pr-4">{Math.round(r.loadVideoGapMaxMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------------- Model swap test ---------------- */}
      <section className="space-y-3 border border-gray-800 rounded-2xl p-4">
        <h2 className="font-bold text-sm">モデル切り替えテスト（標準 ⇄ 高精細）</h2>
        <p className="text-[11px] text-gray-500">
          本番と同じ方式（メイン: 止めて作り直す）と Worker分離（裏で準備して差し替える）で、それぞれ{SWAPS_PER_PATH}回切り替えます。右の「プロセッサ適用後」が黒くなった時間と、止まった時間を測ります。約2分。
        </p>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          {suiteRunning ? (
            <button onClick={() => (cancelSuiteRef.current = true)} className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 font-bold">
              中断
            </button>
          ) : (
            <button
              onClick={() => void runSwapTest()}
              disabled={busy || !workerSupported}
              className="px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:opacity-50 font-bold"
            >
              切り替えテストを開始
            </button>
          )}
          {swapResults.length > 0 && !suiteRunning && (
            <button onClick={() => void copySwapReport()} className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 font-bold">
              {swapCopied ? 'コピーしました' : '結果をコピー（表）'}
            </button>
          )}
        </div>
        {swapResults.length > 0 && (
          <table className="text-[11px] tabular-nums">
            <thead className="text-gray-400">
              <tr>
                {['場所', '切り替え', '完了まで(ms)', '黒い画面(ms)', '映像の最大停止(ms)', '画面スレッドの最大停止(ms)'].map((h) => (
                  <th key={h} className="text-left font-semibold pr-4 pb-1">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {swapResults.map((r, i) => (
                <tr key={i} className="border-t border-gray-800">
                  <td className="pr-4 py-1">{PATH_LABELS[r.path]}</td>
                  <td className="pr-4">
                    {QUALITY_LABELS[r.from]}→{QUALITY_LABELS[r.to]}
                  </td>
                  <td className="pr-4">{Math.round(r.swapMs)}</td>
                  <td className="pr-4 font-bold">{Math.round(r.blackMs)}</td>
                  <td className="pr-4">{Math.round(r.outputGapMaxMs)}</td>
                  <td className="pr-4">{Math.round(r.lagMaxMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ---------------- Manual ---------------- */}
      <section className="space-y-3 border border-gray-800 rounded-2xl p-4">
        <h2 className="font-bold text-sm">手動で1つの設定を見る（画質の確認用）</h2>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="space-y-1">
            <span className="block text-gray-400">モデル</span>
            <select value={model} onChange={(e) => setModel(e.target.value as ModelChoice)} disabled={locked || running} className={selectClass}>
              {(Object.keys(MODEL_LABELS) as ModelChoice[]).map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">推論</span>
            <select value={delegate} onChange={(e) => setDelegate(e.target.value as 'GPU' | 'CPU')} disabled={locked || running} className={selectClass}>
              <option value="GPU">GPU</option>
              <option value="CPU">CPU</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">解像度</span>
            <select value={resolution} onChange={(e) => setResolution(Number(e.target.value) as ResolutionKey)} disabled={locked || running} className={selectClass}>
              {([720, 540, 360] as const).map((r) => (
                <option key={r} value={r}>
                  {r}p{r === 720 ? '（本番）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">カメラfps</span>
            <select value={cameraFps} onChange={(e) => setCameraFps(Number(e.target.value))} disabled={locked || running} className={selectClass}>
              {CAMERA_FPS.map((v) => (
                <option key={v} value={v}>
                  {v}
                  {v === 20 ? '（本番）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">切り抜き/秒</span>
            <select value={segFps} onChange={(e) => setSegFps(Number(e.target.value))} disabled={locked || running} className={selectClass}>
              {segRatesFor(cameraFps).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">切り抜きの間引き方</span>
            <select value={scheduler} onChange={(e) => setScheduler(e.target.value as 'interval' | 'exact')} disabled={locked || running} className={selectClass}>
              <option value="interval">本番と同じ（実際は約半分になる）</option>
              <option value="exact">指定どおり</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">実行場所</span>
            <select value={path} onChange={(e) => setPath(e.target.value as RunPath)} disabled={locked || running} className={selectClass}>
              <option value="main">メインスレッド（本番）</option>
              <option value="worker" disabled={!workerSupported}>
                Worker（試作・ぼかしのみ）
              </option>
              <option value="split" disabled={!workerSupported}>
                Worker分離（試作・切替で止まらない）
              </option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">背景</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as 'blur' | 'image')} disabled={locked || running} className={selectClass}>
              <option value="blur">ぼかし</option>
              <option value="image">画像</option>
            </select>
          </label>
          <button
            onClick={() => (running ? void stopManual() : void startManual())}
            disabled={locked}
            className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 font-bold"
          >
            {busy ? '準備中…' : running ? '停止' : 'カメラを開始'}
          </button>
          {running && model !== 'square' && (
            <button
              onClick={() => void swapManual()}
              disabled={locked}
              className="px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 font-bold"
            >
              {QUALITY_LABELS[manualQuality]} → {QUALITY_LABELS[manualQuality === 'balanced' ? 'high' : 'balanced']} に切り替え
            </button>
          )}
        </div>
        {live && (
          <p className="text-[11px] text-gray-300 tabular-nums">
            負荷 {String(live.busyMsPerSec ?? '-')}ms/秒 ・ 1フレーム {String(live.frameMsAvg ?? '-')}ms ・ 処理 {String(live.fps ?? '-')}fps ・ 出力{' '}
            {String(live.outputFps)}fps ・ カメラ {String(live.captureFps ?? '-')}fps ・ 切り抜き {String(live.segmentations ?? '-')}回 ・ 長いタスク {String(live.longTaskMs)}ms
          </p>
        )}
        <ul className="text-[11px] text-gray-500 space-y-1 list-disc pl-4">
          <li>手を素早く振って、輪郭が遅れてついてくる（背景がはみ出す）かを確認してください。切り抜きを減らした設定ほど出やすくなります。</li>
          <li>「正方形」モデルはアプリで使っていないため、人物と背景が逆に見える場合があります（計測には影響しません）。</li>
        </ul>
      </section>
    </div>
  );
}
