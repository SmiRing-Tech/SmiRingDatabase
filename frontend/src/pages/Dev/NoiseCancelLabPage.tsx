import { useCallback, useEffect, useRef, useState } from 'react';
// See the comment in GtcrnNoiseCancelTrack.ts: the /wasm entry excludes the webgpu/jsep backend
// (and its oversized .wasm file), which this dev-only page doesn't use either.
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { GtcrnStreamProcessor, GTCRN_SAMPLE_RATE, type OrtTensorLike } from '../../lib/audio/gtcrn/GtcrnStreamProcessor';

/**
 * Dev-only bench for the GTCRN noise-cancellation model, mirroring
 * BackgroundBlurLabPage's approach: drive the real processing class straight from
 * getUserMedia, no LiveKit room needed. Registered behind `import.meta.env.DEV` in
 * App.tsx, so it never ships.
 *
 * onnxruntime-web can't run inference inside an AudioWorkletGlobalScope (long-standing
 * upstream issue — "self is not defined" / "no available backend found"), so both capture
 * and playback use plain ScriptProcessorNode callbacks on the main thread instead, where
 * awaiting the async ONNX call is straightforward. Deprecated API, but it's what the rest
 * of this codebase's mic-side experiments (see CallRoomPage's VAD fast-gate history) already
 * lean on, and it's simpler to reason about correctness here than AudioWorklet + postMessage.
 */

const CAPTURE_BUFFER_SIZE = 4096;
const PLAYBACK_BUFFER_SIZE = 4096;

function makeTensor(data: Float32Array, dims: readonly number[]): OrtTensorLike {
  return new ort.Tensor('float32', data, dims as number[]);
}

export default function NoiseCancelLabPage() {
  const [status, setStatus] = useState('モデル読み込み前');
  const [running, setRunning] = useState(false);
  const [enhancedEnabled, setEnhancedEnabled] = useState(true);
  const [stats, setStats] = useState({ meanMs: 0, maxMs: 0, queuedHops: 0, underruns: 0 });

  const processorRef = useRef<GtcrnStreamProcessor | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const outputQueueRef = useRef<Float32Array[]>([]);
  const enhancedEnabledRef = useRef(enhancedEnabled);
  const statsRef = useRef({ times: [] as number[], underruns: 0 });

  useEffect(() => {
    enhancedEnabledRef.current = enhancedEnabled;
  }, [enhancedEnabled]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
      const session = await ort.InferenceSession.create('/gtcrn/gtcrn_simple.onnx', {
        executionProviders: ['wasm'],
      });
      if (cancelled) return;
      const sessionLike = {
        run: async (feeds: Record<string, OrtTensorLike>) => {
          const ortFeeds: Record<string, ort.Tensor> = {};
          for (const [name, t] of Object.entries(feeds)) {
            ortFeeds[name] = t as ort.Tensor;
          }
          const out = await session.run(ortFeeds);
          const result: Record<string, OrtTensorLike> = {};
          for (const [name, t] of Object.entries(out)) {
            result[name] = { data: t.data as Float32Array, dims: t.dims };
          }
          return result;
        },
      };
      processorRef.current = new GtcrnStreamProcessor(sessionLike, makeTensor);
      setStatus('モデル読み込み完了。マイクを開始してください');
    })().catch((e) => {
      console.error('[noise-cancel-lab] failed to load model:', e);
      setStatus(`モデル読み込み失敗: ${e}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const start = useCallback(async () => {
    if (!processorRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true },
    });
    micStreamRef.current = stream;

    // Creating the context at the model's native rate lets the browser's own resampler
    // handle 48kHz-hardware -> 16kHz transparently, same trick used for VAD's mic tap.
    const audioCtx = new AudioContext({ sampleRate: GTCRN_SAMPLE_RATE });
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(stream);
    const capture = audioCtx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
    let processing = false;
    capture.onaudioprocess = (event) => {
      if (processing) return; // drop this callback's audio rather than pile up overlapping pushes
      processing = true;
      const input = new Float32Array(event.inputBuffer.getChannelData(0));
      void (async () => {
        const t0 = performance.now();
        try {
          const enhanced = enhancedEnabledRef.current
            ? await processorRef.current!.push(input)
            : input; // raw passthrough for A/B comparison
          const elapsed = performance.now() - t0;
          statsRef.current.times.push(elapsed);
          if (statsRef.current.times.length > 50) statsRef.current.times.shift();
          if (enhanced.length > 0) outputQueueRef.current.push(enhanced);
        } catch (e) {
          console.error('[noise-cancel-lab] push failed:', e);
        } finally {
          processing = false;
        }
      })();
    };
    // ScriptProcessorNode only fires once wired into a graph that reaches the destination;
    // route capture through a silent gain so it doesn't also loop the raw mic to speakers.
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    source.connect(capture);
    capture.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    const playback = audioCtx.createScriptProcessor(PLAYBACK_BUFFER_SIZE, 0, 1);
    playback.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      let filled = 0;
      while (filled < out.length && outputQueueRef.current.length > 0) {
        const chunk = outputQueueRef.current[0];
        const take = Math.min(chunk.length, out.length - filled);
        out.set(chunk.subarray(0, take), filled);
        filled += take;
        if (take === chunk.length) {
          outputQueueRef.current.shift();
        } else {
          outputQueueRef.current[0] = chunk.subarray(take);
        }
      }
      if (filled < out.length) {
        out.fill(0, filled); // underrun — inference fell behind; pad with silence, not garbage
        statsRef.current.underruns++;
      }
    };
    playback.connect(audioCtx.destination);

    (capture as unknown as { _sink: GainNode })._sink = silentGain; // keep refs alive off the closure
    (audioCtx as unknown as { _nodes: unknown[] })._nodes = [source, capture, playback, silentGain];

    setRunning(true);
    setStatus('稼働中');

    const statsInterval = setInterval(() => {
      const times = statsRef.current.times;
      const meanMs = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
      const maxMs = times.length ? Math.max(...times) : 0;
      setStats({
        meanMs,
        maxMs,
        queuedHops: outputQueueRef.current.reduce((n, c) => n + c.length, 0),
        underruns: statsRef.current.underruns,
      });
    }, 500);
    (audioCtx as unknown as { _statsInterval: ReturnType<typeof setInterval> })._statsInterval = statsInterval;
  }, []);

  const stop = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    const ctx = audioCtxRef.current as unknown as { _statsInterval?: ReturnType<typeof setInterval> } | null;
    if (ctx?._statsInterval) clearInterval(ctx._statsInterval);
    void audioCtxRef.current?.close();
    audioCtxRef.current = null;
    outputQueueRef.current = [];
    setRunning(false);
    setStatus('停止');
  }, []);

  useEffect(() => () => stop(), [stop]);

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', color: '#eee', background: '#111', minHeight: '100vh' }}>
      <h1>GTCRN Noise Cancel Lab</h1>
      <p>{status}</p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        {!running ? (
          <button onClick={() => void start()} disabled={!processorRef.current}>
            マイク開始
          </button>
        ) : (
          <button onClick={stop}>停止</button>
        )}
        <label>
          <input
            type="checkbox"
            checked={enhancedEnabled}
            onChange={(e) => setEnhancedEnabled(e.target.checked)}
          />
          {' '}ノイズ抑制ON（切ると生マイクそのまま再生）
        </label>
      </div>

      {running && (
        <div style={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}>
          <div>推論時間: 平均 {stats.meanMs.toFixed(2)}ms / 最大 {stats.maxMs.toFixed(2)}ms（1フレーム分の予算 = {(CAPTURE_BUFFER_SIZE / GTCRN_SAMPLE_RATE * 1000).toFixed(0)}ms）</div>
          <div>出力バッファ残量: {stats.queuedHops} samples ({(stats.queuedHops / GTCRN_SAMPLE_RATE * 1000).toFixed(0)}ms)</div>
          <div style={{ color: stats.underruns > 0 ? '#f66' : '#6f6' }}>
            アンダーラン（音切れ）回数: {stats.underruns}
          </div>
        </div>
      )}
    </div>
  );
}
