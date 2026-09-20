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
 * take as long as it likes without blocking anything), and the main thread only hands
 * transferable buffers between them.
 *
 * ## Ordering
 *
 * GtcrnStreamProcessor is stateful (STFT input ring, overlap-add accumulator, and the model's
 * three recurrent caches), so chunks for a given stream MUST be processed strictly in order.
 * `onmessage` handlers are async here, so several could otherwise interleave at their `await`
 * points; everything therefore goes through the single serialized `drain()` loop below rather
 * than being processed directly in the message handler.
 */

// The '/wasm' entry point, not the bare package — same reasoning as the main-thread code this
// replaced: the default entry bundles a 25.6MB jsep/webgpu .wasm this never uses.
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { GtcrnStreamProcessor, type OrtTensorLike } from './GtcrnStreamProcessor';

/** main -> worker */
export type GtcrnWorkerRequest =
  /** Create (or just await) the ORT session, so the model download/compile can be warmed up
   *  well before any audio needs it. Answered with 'ready' or 'error'. */
  | { type: 'init' }
  /** Begin a stream. Allocates that stream's own DSP state. */
  | { type: 'open'; streamId: number }
  /** One chunk of 16kHz mono samples for a stream. `samples` is transferred. */
  | { type: 'samples'; streamId: number; samples: Float32Array }
  /** End a stream and drop its DSP state. */
  | { type: 'close'; streamId: number };

/** worker -> main */
export type GtcrnWorkerResponse =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | {
      type: 'enhanced';
      streamId: number;
      /** Transferred back, not copied. */
      samples: Float32Array;
      /** Wall-clock ms this chunk spent in push() — diagnostics for the dev stats line. */
      inferenceMs: number;
      inputRms: number;
      outputRms: number;
    };

const MODEL_URL = '/gtcrn/gtcrn_simple.onnx';

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    sessionPromise = ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
    // Same reasoning as the main-thread version this replaced: a rejected promise cached here
    // would poison every later attempt for the lifetime of this worker, so one transient
    // network failure would permanently disable noise-cancel. Clearing it lets the next
    // attempt retry from scratch.
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
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
  const session = await getSession();
  const sessionLike = {
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
  return new GtcrnStreamProcessor(sessionLike, makeTensor);
}

/**
 * Per-stream DSP state, keyed by streamId. Held as promises because a stream is opened before
 * its ORT session necessarily exists — samples that arrive during that window queue up behind
 * the pending creation rather than being dropped.
 */
const processors = new Map<number, Promise<GtcrnStreamProcessor>>();

const queue: Array<{ streamId: number; samples: Float32Array }> = [];
let draining = false;

function post(message: GtcrnWorkerResponse, transfer?: Transferable[]) {
  self.postMessage(message, { transfer: transfer ?? [] });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      const pending = processors.get(job.streamId);
      // Stream was closed while this chunk sat in the queue — its output would go nowhere.
      if (!pending) continue;

      try {
        const processor = await pending;
        // Re-check: the await above yields, and a 'close' can land in that gap.
        if (!processors.has(job.streamId)) continue;

        const t0 = performance.now();
        const inputRms = rms(job.samples);
        const enhanced = await processor.push(job.samples);
        const inferenceMs = performance.now() - t0;

        if (!processors.has(job.streamId) || enhanced.length === 0) continue;

        post(
          {
            type: 'enhanced',
            streamId: job.streamId,
            samples: enhanced,
            inferenceMs,
            inputRms,
            outputRms: rms(enhanced),
          },
          [enhanced.buffer],
        );
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
      getSession().then(
        () => post({ type: 'ready' }),
        (e) => post({ type: 'error', message: `session creation failed: ${String(e)}` }),
      );
      break;

    case 'open':
      processors.set(msg.streamId, createProcessor());
      // A failed creation is reported once here; every chunk that then queues behind it would
      // otherwise re-report the same failure on each drain iteration.
      processors.get(msg.streamId)!.catch((e) => {
        processors.delete(msg.streamId);
        post({ type: 'error', message: `stream ${msg.streamId} setup failed: ${String(e)}` });
      });
      break;

    case 'samples':
      queue.push({ streamId: msg.streamId, samples: msg.samples });
      void drain();
      break;

    case 'close':
      processors.delete(msg.streamId);
      break;
  }
};
