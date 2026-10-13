/**
 * Runs GTCRN inference off the main thread.
 *
 * ## Why this file can exist at all
 *
 * The long-standing note in this codebase — "onnxruntime-web can't run inference inside an
 * AudioWorkletGlobalScope (`self is not defined` / `no available backend found`)" — is correct,
 * but it is specific to *AudioWorkletGlobalScope*, not to "off the main thread" in general.
 * AudioWorkletGlobalScope is a deliberately minimal realtime environment: no `self`, no `fetch`,
 * no dynamic `import()`, no `WebAssembly` streaming APIs. ORT's loader needs all of those, hence
 * the failure.
 *
 * A DedicatedWorkerGlobalScope (this file) is an ordinary JS environment with all of them, and
 * running ORT in a Worker is a supported, well-trodden deployment. So the pipeline splits three
 * ways: capture and playback stay in AudioWorklets on the render thread (where they need
 * realtime scheduling and no dependencies), inference lives here (where it needs ORT and can
 * take as long as it likes without blocking anything).
 *
 * Audio never passes through the main thread: each stream arrives with two MessagePorts, one
 * from the capture worklet and one to the playback worklet, and chunks flow worklet -> here ->
 * worklet directly. The main thread only opens/closes streams, says when a stream is active
 * (muted streams aren't worth inferring), and receives per-chunk numbers for diagnostics. It
 * used to relay every chunk both ways, so any main-thread stall (a background effect loading,
 * a long render) held up the audio too.
 *
 * ## Ordering
 *
 * GtcrnStreamProcessor is stateful (STFT input ring, overlap-add accumulator, and the model's
 * three recurrent caches), so chunks for a given stream MUST be processed strictly in order.
 * `onmessage` handlers are async here, so several could otherwise interleave at their `await`
 * points; everything therefore goes through the single serialized `drain()` loop below rather
 * than being processed directly in the message handler.
 *
 * ## Keeping up in real time
 *
 * Every chunk is 64ms of audio, so processing one has to take less than 64ms on average or the
 * queue grows without bound — which is exactly what made one participant's voice reach everyone
 * 10+ seconds late (measured: 90-160ms per chunk on a 2-core MacBook Air, backlog climbing to
 * 14s). This file now guards against that in three steps, judged from what it measures live
 * rather than from the machine's spec (a fast machine busy with other apps falls behind too):
 *
 *  1. Skip level (GtcrnStreamProcessor's GtcrnSkipLevel): when chunks start taking close to
 *     64ms or a backlog forms, infer fewer frames per chunk; step back down once there's been
 *     comfortable headroom for a while.
 *  2. Backlog cap: if audio still piles up past MAX_BACKLOG_CHUNKS, the older chunks are sent
 *     back *unprocessed* (so listeners hear raw audio for that moment, not a gap or a delay) and
 *     the processor restarts from the newest chunk.
 *  3. Overload: if the cap keeps tripping, report 'overloaded' — the main thread then gives up
 *     on browser-side noise cancellation for this call and tells the person.
 */

// The '/wasm' entry point, not the bare package — same reasoning as the main-thread code this
// replaced: the default entry bundles a 25.6MB jsep/webgpu .wasm this never uses.
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import {
  GtcrnStreamProcessor,
  GTCRN_MAX_SKIP_LEVEL,
  GTCRN_SAMPLE_RATE,
  SESSION_FOR_LEVEL,
  supportedSkipLevel,
  type GtcrnSessions,
  type GtcrnSkipLevel,
  type OrtSessionLike,
  type OrtTensorLike,
} from './GtcrnStreamProcessor';
import { createLevelState, setLevel, updateLevel, type LevelState } from './gtcrnLevelController';

/** main -> worker */
export type GtcrnWorkerRequest =
  /** Create (or just await) the T=4 session — the only one needed to start — so the model
   *  download/compile can be warmed up well before any audio needs it. Answered with 'ready' or
   *  'error'. The lighter T=2/T=1 models are loaded later, see maybeLoadLighterModels. */
  | { type: 'init' }
  /**
   * Begin a stream. Allocates that stream's own DSP state. Chunks arrive on `capturePort` (from
   * the capture worklet, as GtcrnCaptureChunk) and results go out on `playbackPort` (to the
   * playback worklet, as { type: 'samples', samples }) — both transferred.
   */
  | { type: 'open'; streamId: number; capturePort: MessagePort; playbackPort: MessagePort; active: boolean }
  /** Whether the stream's audio is going anywhere; inactive chunks are dropped uninferred. */
  | { type: 'active'; streamId: number; active: boolean }
  /** End a stream and drop its DSP state. */
  | { type: 'close'; streamId: number };

/** worker -> main */
export type GtcrnWorkerResponse =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  /** Numbers for one chunk just sent to playback (the samples themselves went straight there). */
  | {
      type: 'chunk';
      streamId: number;
      /** Wall-clock ms this chunk spent in push() — 0 for a passthrough chunk. */
      inferenceMs: number;
      /** Skip level this chunk was processed at. */
      level: GtcrnSkipLevel;
      /** Frames-per-run models loaded so far (4 first; 2 and 1 arrive later). */
      loadedModels: number[];
      /** True when the backlog cap sent this chunk back unprocessed (raw mic audio). */
      passthrough: boolean;
      inputRms: number;
      outputRms: number;
      /** Chunks still queued for this stream after this one — x64ms is how late it's running. */
      backlog: number;
      /** Longest gap between chunks arriving from the capture worklet since the last report. */
      captureGapMs: number;
      /** Chunks dropped uninferred since the last report because the stream was inactive. */
      inactiveChunks: number;
    }
  /** The backlog cap keeps tripping: this machine can't run noise cancellation right now. */
  | { type: 'overloaded'; streamId: number };

const MODEL_URLS: Record<1 | 2 | 4, string> = {
  1: '/gtcrn/gtcrn_simple.onnx',
  2: '/gtcrn/gtcrn_simple_t2.onnx',
  4: '/gtcrn/gtcrn_simple_t4.onnx',
};

/** Real-time budget per chunk, from the chunk's own length (64ms for the 1024-sample chunks the
 *  capture worklet sends). */
const chunkBudgetMs = (samples: number) => (samples / GTCRN_SAMPLE_RATE) * 1000;

/** Backlog cap: ~300ms of queued audio. Past this, older chunks go back unprocessed. */
const MAX_BACKLOG_CHUNKS = 4;
/** Cap trips within OVERLOAD_WINDOW_MS that count as "can't keep up at all". */
const OVERLOAD_TRIPS = 3;
const OVERLOAD_WINDOW_MS = 10_000;

/**
 * Loaded sessions, shared by every stream's processor (which reads it per batch, so a model
 * that finishes loading mid-call is used from the next chunk on).
 *
 * Only T=4 is loaded up front: it's all a machine that keeps up ever needs, so joining a call
 * waits on one ~0.5MB model, not three. T=2 (skip level 1) and then T=1 (level 2) load in the
 * background once the call has settled — or immediately, if the controller asks for that level
 * before then. Loading one blocks this worker for a moment (graph parse/optimise runs on this
 * thread), which is why the background load waits for a calm moment rather than happening
 * during a backlog; when a level is actually needed, waiting for calm could mean never.
 */
const sessions: GtcrnSessions = {};
const loading = new Map<1 | 2 | 4, Promise<OrtSessionLike>>();
/** When the first chunk was processed — background loads wait LAZY_LOAD_AFTER_MS past this. */
let firstChunkAt: number | null = null;
const LAZY_LOAD_AFTER_MS = 5000;

function wrapSession(session: ort.InferenceSession): OrtSessionLike {
  return {
    run: async (feeds: Record<string, OrtTensorLike>) => {
      const ortFeeds: Record<string, ort.Tensor> = {};
      for (const [name, t] of Object.entries(feeds)) ortFeeds[name] = t as ort.Tensor;
      const out = await session.run(ortFeeds);
      const result: Record<string, OrtTensorLike> = {};
      for (const [name, t] of Object.entries(out)) {
        result[name] = { data: t.data as Float32Array, dims: t.dims };
      }
      return result;
    },
  };
}

function loadModel(frames: 1 | 2 | 4): Promise<OrtSessionLike> {
  let pending = loading.get(frames);
  if (!pending) {
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    pending = ort.InferenceSession.create(MODEL_URLS[frames], { executionProviders: ['wasm'] }).then((session) => {
      const wrapped = wrapSession(session);
      sessions[frames] = wrapped;
      return wrapped;
    });
    loading.set(frames, pending);
    // Same reasoning as the main-thread version this replaced: a rejected promise cached here
    // would poison every later attempt for the lifetime of this worker, so one transient
    // network failure would permanently disable that model. Clearing it lets the next attempt
    // retry from scratch.
    pending.catch((e) => {
      loading.delete(frames);
      console.warn(`[GTCRN worker] failed to load T=${frames} model:`, e);
    });
  }
  return pending;
}

/**
 * Starts loading the next lighter model when it's wanted now (`wantedLevel`) or when the call
 * has been running a while and there's no backlog — T=2 first (the level a struggling machine
 * most likely settles at), then T=1. Fire-and-forget: the processor picks it up once loaded.
 */
function maybeLoadLighterModels(wantedLevel: GtcrnSkipLevel, backlog: number, now: number) {
  const calm = firstChunkAt !== null && now - firstChunkAt >= LAZY_LOAD_AFTER_MS && backlog <= 1;
  for (const level of [1, 2] as const) {
    const frames = SESSION_FOR_LEVEL[level];
    if (sessions[frames]) continue;
    // One at a time, in order: while this one is still loading, wait for it.
    if (!loading.has(frames) && (wantedLevel >= level || calm)) void loadModel(frames).catch(() => {});
    return;
  }
}

function makeTensor(data: Float32Array, dims: readonly number[]): OrtTensorLike {
  return new ort.Tensor('float32', data, dims as number[]);
}

function rms(data: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
  return Math.sqrt(sumSq / data.length);
}

async function createProcessor(): Promise<GtcrnStreamProcessor> {
  await loadModel(4);
  return new GtcrnStreamProcessor(sessions, makeTensor);
}

const loadedModels = () => ([4, 2, 1] as const).filter((frames) => sessions[frames]);

/** Per-stream DSP state plus the real-time controller's bookkeeping. */
interface StreamState extends LevelState {
  /** Held as a promise because a stream is opened before its sessions necessarily exist —
   *  samples that arrive during that window queue up behind the pending creation. */
  processor: Promise<GtcrnStreamProcessor>;
  capTrips: number[];
  /** Once set, this stream's chunks go to playback unprocessed (raw mic) for good. */
  overloaded: boolean;
  capturePort: MessagePort;
  playbackPort: MessagePort;
  active: boolean;
  lastCaptureAt: number;
  captureGapMs: number;
  inactiveChunks: number;
}

const streams = new Map<number, StreamState>();

const queue: Job[] = [];
let draining = false;

function post(message: GtcrnWorkerResponse, transfer?: Transferable[]) {
  self.postMessage(message, { transfer: transfer ?? [] });
}

type Job = { streamId: number; samples: Float32Array };

type ChunkInfo = Pick<
  Extract<GtcrnWorkerResponse, { type: 'chunk' }>,
  'inferenceMs' | 'level' | 'passthrough' | 'inputRms' | 'outputRms'
>;

/** Sends a finished chunk straight to the stream's playback worklet, and its numbers to the page. */
function deliver(streamId: number, state: StreamState, samples: Float32Array, info: ChunkInfo) {
  state.playbackPort.postMessage({ type: 'samples', samples }, [samples.buffer]);
  post({
    type: 'chunk',
    streamId,
    ...info,
    loadedModels: loadedModels(),
    backlog: queue.filter((q) => q.streamId === streamId).length,
    captureGapMs: state.captureGapMs,
    inactiveChunks: state.inactiveChunks,
  });
  state.captureGapMs = 0;
  state.inactiveChunks = 0;
}

/** A chunk from a stream's capture worklet. */
function onCapture(streamId: number, samples: Float32Array) {
  const state = streams.get(streamId);
  if (!state) return;
  const now = performance.now();
  if (state.lastCaptureAt) state.captureGapMs = Math.max(state.captureGapMs, now - state.lastCaptureAt);
  state.lastCaptureAt = now;
  if (!state.active) {
    // Muted: the gate downstream zeroes this anyway, so don't spend an inference on it.
    state.inactiveChunks += 1;
    return;
  }
  if (state.overloaded) {
    const loudness = rms(samples);
    deliver(streamId, state, samples, {
      inferenceMs: 0,
      level: state.level,
      passthrough: true,
      inputRms: loudness,
      outputRms: loudness,
    });
    return;
  }
  queue.push({ streamId, samples });
  void drain();
}

function closeStream(streamId: number) {
  const state = streams.get(streamId);
  if (!state) return;
  streams.delete(streamId);
  state.capturePort.close();
  state.playbackPort.close();
}

/**
 * Backlog cap. `job` has just been taken off the queue; together with whatever is still queued
 * for its stream, that's the backlog. Past MAX_BACKLOG_CHUNKS, every chunk but the newest goes
 * back unprocessed and the processor restarts from scratch at the lightest level (the skipped
 * audio broke the stream's continuity anyway). Returns the chunk to process now.
 *
 * The seam between raw and processed audio isn't perfectly smooth (processed audio trails raw by
 * one 16ms hop), but this is an emergency path: a brief rough edge beats seconds of delay or a gap.
 */
async function enforceBacklogCap(job: Job, state: StreamState, now: number): Promise<Job> {
  const backlog = [job, ...queue.filter((q) => q.streamId === job.streamId)];
  if (backlog.length <= MAX_BACKLOG_CHUNKS) return job;

  const newest = backlog[backlog.length - 1];
  for (const stale of backlog.slice(0, -1)) {
    const index = queue.indexOf(stale);
    if (index !== -1) queue.splice(index, 1);
    const loudness = rms(stale.samples);
    deliver(job.streamId, state, stale.samples, {
      inferenceMs: 0,
      level: state.level,
      passthrough: true,
      inputRms: loudness,
      outputRms: loudness,
    });
  }
  queue.splice(queue.indexOf(newest), 1);
  (await state.processor).reset();
  // Lightest level that's actually loaded — and start fetching the lightest one if it isn't.
  setLevel(state, supportedSkipLevel(sessions, GTCRN_MAX_SKIP_LEVEL), now);
  maybeLoadLighterModels(GTCRN_MAX_SKIP_LEVEL, backlog.length, now);

  state.capTrips = state.capTrips.filter((t) => now - t < OVERLOAD_WINDOW_MS);
  state.capTrips.push(now);
  if (!state.overloaded && state.capTrips.length >= OVERLOAD_TRIPS) {
    state.overloaded = true;
    post({ type: 'overloaded', streamId: job.streamId });
  }
  return newest;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      const state = streams.get(job.streamId);
      // Stream was closed while this chunk sat in the queue — its output would go nowhere.
      if (!state) continue;

      try {
        const processor = await state.processor;
        // Re-check: the await above yields, and a 'close' can land in that gap.
        if (!streams.has(job.streamId)) continue;

        const current = await enforceBacklogCap(job, state, performance.now());
        const t0 = performance.now();
        firstChunkAt ??= t0;
        const inputRms = rms(current.samples);
        const level = state.level;
        const enhanced = await processor.push(current.samples, level);
        const now = performance.now();
        const inferenceMs = now - t0;

        if (!streams.has(job.streamId) || enhanced.length === 0) continue;

        const backlog = queue.filter((q) => q.streamId === job.streamId).length;
        updateLevel(state, inferenceMs, backlog, chunkBudgetMs(current.samples.length), now);
        // The controller only knows levels, not which models have arrived: keep it to what's
        // loaded (resetting its settle timer, so it re-judges once the lighter model is in),
        // and fetch the model it wanted.
        const wanted = state.level;
        const usable = supportedSkipLevel(sessions, wanted);
        if (usable !== wanted) setLevel(state, usable, now);
        maybeLoadLighterModels(wanted, backlog, now);

        deliver(job.streamId, state, enhanced, {
          inferenceMs,
          level,
          passthrough: false,
          inputRms,
          outputRms: rms(enhanced),
        });
      } catch (e) {
        post({ type: 'error', message: `inference failed: ${String(e)}` });
      }
    }
  } finally {
    draining = false;
  }
}

self.onmessage = (event: MessageEvent<GtcrnWorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      loadModel(4).then(
        () => post({ type: 'ready' }),
        (e) => post({ type: 'error', message: `session creation failed: ${String(e)}` }),
      );
      break;

    case 'open': {
      const state: StreamState = {
        ...createLevelState(performance.now()),
        processor: createProcessor(),
        capTrips: [],
        overloaded: false,
        capturePort: msg.capturePort,
        playbackPort: msg.playbackPort,
        active: msg.active,
        lastCaptureAt: 0,
        captureGapMs: 0,
        inactiveChunks: 0,
      };
      streams.set(msg.streamId, state);
      const streamId = msg.streamId;
      msg.capturePort.onmessage = (event: MessageEvent<{ samples: Float32Array }>) => onCapture(streamId, event.data.samples);
      // A failed creation is reported once here; every chunk that then queues behind it would
      // otherwise re-report the same failure on each drain iteration.
      state.processor.catch((e) => {
        closeStream(msg.streamId);
        post({ type: 'error', message: `stream ${msg.streamId} setup failed: ${String(e)}` });
      });
      break;
    }

    case 'active': {
      const state = streams.get(msg.streamId);
      if (state) state.active = msg.active;
      break;
    }

    case 'close':
      closeStream(msg.streamId);
      break;
  }
};
