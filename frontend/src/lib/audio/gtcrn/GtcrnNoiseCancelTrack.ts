// The 'onnxruntime-web/wasm' entry point, not the bare 'onnxruntime-web' package: the default
// entry bundles every backend (wasm, webgl, webgpu/jsep), and the jsep backend alone drags in a
// 25.6MB .wasm file — over Cloudflare Pages' 25MB per-file limit — that this app never uses
// (execution is pinned to 'wasm' below). The /wasm entry excludes it entirely.
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { GtcrnStreamProcessor, GTCRN_SAMPLE_RATE, type OrtTensorLike } from './GtcrnStreamProcessor';

/**
 * Wraps GtcrnStreamProcessor into a MediaStreamTrack-in, MediaStreamTrack-out node, the same
 * shape as VideoDelayPipeline — so CallRoomPage can splice it into its own audio graph exactly
 * like every other stage there, instead of going through LiveKit's setProcessor() slot (that's
 * the same reasoning as VideoDelayPipeline and the VAD gate: this file went through a whole
 * saga about setProcessor()-based Krisp racing the gate's own sender.replaceTrack() calls, and
 * this avoids reintroducing that class of bug — see the comment above useVadAutoGate).
 *
 * onnxruntime-web can't run inside an AudioWorkletGlobalScope (see NoiseCancelLabPage's doc
 * comment for the upstream issue), so — like the lab page — capture and playback both use plain
 * ScriptProcessorNode callbacks on the main thread, where awaiting the async ONNX call is
 * straightforward.
 */

// 1024 samples @ 16kHz = 64ms. The lab page used 4096 (256ms) for generous headroom while
// tuning; GTCRN's measured RTF (~0.03-0.04, i.e. 25-30x faster than real-time — see
// noise-cancel-research) leaves enormous margin even at this much smaller, lower-latency size.
const BUFFER_SIZE = 1024;
/** Dominant source of this stage's added latency: audio only becomes visible to the capture
 * callback once a full buffer has arrived. Exported so callers (the video delay pipeline, to
 * keep lips in sync) can account for it instead of guessing. */
export const GTCRN_PIPELINE_LATENCY_MS = (BUFFER_SIZE / GTCRN_SAMPLE_RATE) * 1000;

let sessionPromise: Promise<ort.InferenceSession> | null = null;
function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortMjsUrl };
    console.log('[Connect] GTCRN: creating ONNX session...');
    sessionPromise = ort.InferenceSession.create('/gtcrn/gtcrn_simple.onnx', {
      executionProviders: ['wasm'],
    });
    sessionPromise
      .then(() => console.log('[Connect] GTCRN: ONNX session created'))
      .catch((e) => {
        // A rejected promise cached at module scope would otherwise poison every future
        // attempt for the rest of the page's lifetime — one transient failure (e.g. a slow
        // network fetch of the .wasm/.onnx assets timing out) would permanently disable
        // noise-cancel until a full reload, with retoggling the UI switch never able to help
        // since it always re-awaits this same rejected promise. Clearing it lets the next
        // create() call retry from scratch instead.
        console.error('[Connect] GTCRN: ONNX session creation failed, will retry next attempt:', e);
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

export class GtcrnNoiseCancelTrack {
  private readonly ctx: AudioContext;
  private readonly sourceClone: MediaStreamTrack;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly capture: ScriptProcessorNode;
  private readonly playback: ScriptProcessorNode;
  private readonly silentGain: GainNode;
  private outputQueue: Float32Array[] = [];
  private stopped = false;

  // Diagnostics only — cheap to keep always-on given how much this pipeline has needed
  // debugging blind. Logged periodically rather than per-hop (62x/sec at BUFFER_SIZE=1024)
  // so it doesn't drown out everything else in the console.
  private inferenceCount = 0;
  private inferenceTimeTotalMs = 0;
  private inferenceTimeMaxMs = 0;
  private underrunCount = 0;
  private lastInputRms = 0;
  private lastOutputRms = 0;
  private statsInterval: ReturnType<typeof setInterval>;

  static async create(source: MediaStreamTrack): Promise<GtcrnNoiseCancelTrack> {
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
    const processor = new GtcrnStreamProcessor(sessionLike, makeTensor);
    const instance = new GtcrnNoiseCancelTrack(source, processor);
    // A freshly constructed AudioContext can start 'suspended' under the browsers' autoplay
    // policy, and nothing else in this pipeline ever resumes it — this whole factory runs well
    // removed from whatever click actually joined the call (there's a model load awaited above),
    // so it doesn't reliably inherit that gesture. Suspended means the capture/playback graph
    // never processes a single sample: the output track is live but permanently silent, which
    // looks exactly like a stuck mute. See the matching comment in CallRoomPage's buildGateGraph.
    if (instance.ctx.state === 'suspended') {
      await instance.ctx.resume().catch((e) => console.error('[Connect] failed to resume GTCRN AudioContext:', e));
    }
    return instance;
  }

  private constructor(source: MediaStreamTrack, processor: GtcrnStreamProcessor) {
    // Model is fixed at 16kHz; creating the context at that rate lets the browser's own
    // resampler handle 48kHz-hardware -> 16kHz transparently (same trick as the VAD mic tap).
    this.ctx = new AudioContext({ sampleRate: GTCRN_SAMPLE_RATE });
    this.sourceClone = source.clone();
    const sourceNode = this.ctx.createMediaStreamSource(new MediaStream([this.sourceClone]));

    this.capture = this.ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    let processing = false;
    this.capture.onaudioprocess = (event) => {
      if (this.stopped || processing) return;
      processing = true;
      const input = new Float32Array(event.inputBuffer.getChannelData(0));
      this.lastInputRms = rms(input);
      const t0 = performance.now();
      void processor
        .push(input)
        .then((enhanced) => {
          const elapsed = performance.now() - t0;
          this.inferenceCount++;
          this.inferenceTimeTotalMs += elapsed;
          if (elapsed > this.inferenceTimeMaxMs) this.inferenceTimeMaxMs = elapsed;
          if (enhanced.length > 0 && !this.stopped) {
            this.lastOutputRms = rms(enhanced);
            this.outputQueue.push(enhanced);
          }
        })
        .catch((e) => console.error('[Connect] GTCRN inference failed:', e))
        .finally(() => {
          processing = false;
        });
    };
    // ScriptProcessorNode only fires once wired into a graph reaching the destination; route
    // capture through a silent gain so it doesn't also loop the raw mic to this context's output
    // (which nothing listens to anyway, but keep the signal path silent on principle).
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    sourceNode.connect(this.capture);
    this.capture.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);

    this.playback = this.ctx.createScriptProcessor(BUFFER_SIZE, 0, 1);
    this.playback.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      let filled = 0;
      while (filled < out.length && this.outputQueue.length > 0) {
        const chunk = this.outputQueue[0];
        const take = Math.min(chunk.length, out.length - filled);
        out.set(chunk.subarray(0, take), filled);
        filled += take;
        if (take === chunk.length) this.outputQueue.shift();
        else this.outputQueue[0] = chunk.subarray(take);
      }
      if (filled < out.length) {
        out.fill(0, filled); // underrun — pad with silence, not garbage
        this.underrunCount++;
      }
    };
    this.destination = this.ctx.createMediaStreamDestination();
    this.playback.connect(this.destination);

    this.statsInterval = setInterval(() => {
      const meanMs = this.inferenceCount > 0 ? this.inferenceTimeTotalMs / this.inferenceCount : 0;
      console.log('[Connect] GTCRN stats', {
        inferenceCount: this.inferenceCount,
        meanMs: meanMs.toFixed(2),
        maxMs: this.inferenceTimeMaxMs.toFixed(2),
        underrunCount: this.underrunCount,
        queuedMs: ((this.outputQueue.reduce((n, c) => n + c.length, 0) / GTCRN_SAMPLE_RATE) * 1000).toFixed(0),
        inputRms: this.lastInputRms.toFixed(4),
        outputRms: this.lastOutputRms.toFixed(4),
        ctxState: this.ctx.state,
      });
    }, 3000);
  }

  get track(): MediaStreamTrack {
    return this.destination.stream.getAudioTracks()[0];
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.statsInterval);
    this.capture.disconnect();
    this.playback.disconnect();
    this.silentGain.disconnect();
    this.sourceClone.stop();
    this.track.stop();
    void this.ctx.close();
  }
}
