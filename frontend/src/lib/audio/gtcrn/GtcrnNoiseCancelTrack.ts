// The 'onnxruntime-web/wasm' entry point, not the bare 'onnxruntime-web' package: the default
// entry bundles every backend (wasm, webgl, webgpu/jsep), and the jsep backend alone drags in a
// 25.6MB .wasm file — over Cloudflare Pages' 25MB per-file limit — that this app never uses
// (execution is pinned to 'wasm' below). The /wasm entry excludes it entirely.
import * as ort from 'onnxruntime-web/wasm';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import { GtcrnStreamProcessor, GTCRN_SAMPLE_RATE, type OrtTensorLike } from './GtcrnStreamProcessor';
import { keepAudioContextResumed } from '../keepAudioContextResumed';
import type { GtcrnPlaybackOptions, GtcrnPlaybackStats } from './gtcrnPlayback.worklet';
import playbackWorkletUrl from './gtcrnPlayback.worklet.ts?worker&url';

/**
 * Wraps GtcrnStreamProcessor into a MediaStreamTrack-in, MediaStreamTrack-out node, the same
 * shape as VideoDelayPipeline — so CallRoomPage can splice it into its own audio graph exactly
 * like every other stage there, instead of going through LiveKit's setProcessor() slot (that's
 * the same reasoning as VideoDelayPipeline and the VAD gate: this file went through a whole
 * saga about setProcessor()-based Krisp racing the gate's own sender.replaceTrack() calls, and
 * this avoids reintroducing that class of bug — see the comment above useVadAutoGate).
 *
 * onnxruntime-web can't run inside an AudioWorkletGlobalScope (see NoiseCancelLabPage's doc
 * comment for the upstream issue), so capture still uses a plain ScriptProcessorNode callback on
 * the main thread, where awaiting the async ONNX call is straightforward. Playback does NOT:
 * it's an AudioWorkletNode, because having it on the main thread is what made operating the UI
 * audible to the rest of the call. See gtcrnPlayback.worklet.ts for the full story.
 */

// 1024 samples @ 16kHz = 64ms. The lab page used 4096 (256ms) for generous headroom while
// tuning; GTCRN's measured RTF (~0.03-0.04, i.e. 25-30x faster than real-time — see
// noise-cancel-research) leaves enormous margin even at this much smaller, lower-latency size.
const BUFFER_SIZE = 1024;

/** How long a main-thread stall the playback worklet can hide before listeners hear anything.
 * Paid for one-for-one in mouth-to-ear latency (and, via GTCRN_PIPELINE_LATENCY_MS below, in
 * how far video is delayed to keep lips in sync), so it's a straight continuity-vs-latency
 * dial: raise it if stutter survives, lower it if the delay becomes the bigger complaint. */
const PRIME_MS = 128;
/** Ceiling on queued audio, so a producer that ever runs ahead doesn't leave the extra delay in
 * place for the rest of the call. Generous — it should only ever bite after a long stall. */
const MAX_QUEUE_MS = 400;

/** This stage's added latency: a full capture buffer has to arrive before the main thread sees
 * it at all, then the worklet holds PRIME_MS more as its anti-stall cushion. Exported so callers
 * (the video delay pipeline, to keep lips in sync) can account for it instead of guessing. */
export const GTCRN_PIPELINE_LATENCY_MS = (BUFFER_SIZE / GTCRN_SAMPLE_RATE) * 1000 + PRIME_MS;

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

/**
 * Fire-and-forget preload of the ONNX session, exported so PreJoinScreen can start this — the
 * slow part of `GtcrnNoiseCancelTrack.create()`, a multi-second download + WASM compile on first
 * use — while the user is still looking at the pre-join preview, in parallel with the
 * getUserMedia() permission prompt. `getSession()` caches at module scope, so by the time
 * `create()` actually runs after the user joins, it resolves near-instantly instead of running
 * that same load deep inside the room-join sequence — which is what left this class's own
 * `AudioContext.resume()` landing too late for stricter browsers' autoplay policy to honor (see
 * the constructor's comment). Settles either way; a failed warmup just leaves `create()` to
 * retry from scratch as it always has.
 */
export function warmupGtcrnModel(): Promise<void> {
  return getSession()
    .then(() => undefined)
    .catch(() => undefined);
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
  private readonly playback: AudioWorkletNode;
  private readonly silentGain: GainNode;
  private stopped = false;
  private readonly detachResumeRetry: () => void;

  // Diagnostics only — cheap to keep always-on given how much this pipeline has needed
  // debugging blind. Logged periodically rather than per-hop (62x/sec at BUFFER_SIZE=1024)
  // so it doesn't drown out everything else in the console.
  private inferenceCount = 0;
  private inferenceTimeTotalMs = 0;
  private inferenceTimeMaxMs = 0;
  private lastInputRms = 0;
  private lastOutputRms = 0;
  // Gap between consecutive capture callbacks. Capture is the one stage still on the main
  // thread, so this is the direct readout of how starved the main thread gets: at
  // BUFFER_SIZE=1024 it should sit at ~64ms, and whatever it peaks to during a tab/app switch
  // is the stall the playback worklet's PRIME_MS cushion has to cover.
  private captureIntervalMaxMs = 0;
  private lastCaptureAt = 0;
  // Reported by the worklet (it owns the queue now), mirrored here for the stats line.
  private playbackStats: GtcrnPlaybackStats | null = null;
  private statsInterval: ReturnType<typeof setInterval>;

  static async create(source: MediaStreamTrack): Promise<GtcrnNoiseCancelTrack> {
    const session = await getSession();
    // Model is fixed at 16kHz; creating the context at that rate lets the browser's own
    // resampler handle 48kHz-hardware -> 16kHz transparently (same trick as the VAD mic tap).
    const ctx = new AudioContext({ sampleRate: GTCRN_SAMPLE_RATE });
    // A freshly constructed AudioContext can start 'suspended' under the browsers' autoplay
    // policy — this runs well removed from whatever click actually joined the call (there's a
    // model load awaited above, and an addModule() below), so it doesn't reliably inherit that
    // gesture, and on stricter browsers (Safari, in-app webviews) a single resume() attempt
    // here can silently fail with no error. Suspended means the graph never processes a single
    // sample: the output track is live but permanently silent, which looks exactly like a stuck
    // mute. keepAudioContextResumed retries on every subsequent page interaction until it
    // actually succeeds, instead of gambling on this one. Attached before the await below so
    // the retry is already armed while the module loads. See the matching comment in
    // CallRoomPage's buildGateGraph.
    const detachResumeRetry = keepAudioContextResumed(ctx);
    try {
      await ctx.audioWorklet.addModule(playbackWorkletUrl);
    } catch (e) {
      detachResumeRetry();
      void ctx.close();
      throw e;
    }
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
    return new GtcrnNoiseCancelTrack(ctx, detachResumeRetry, source, processor);
  }

  private constructor(
    ctx: AudioContext,
    detachResumeRetry: () => void,
    source: MediaStreamTrack,
    processor: GtcrnStreamProcessor,
  ) {
    this.ctx = ctx;
    this.detachResumeRetry = detachResumeRetry;
    this.sourceClone = source.clone();
    // clone() snapshots .enabled from the source at clone time and never updates it again — if
    // the raw mic happens to be mid-mute (.enabled false) at this exact moment (e.g. a brief
    // initial mute right as the call starts, still in effect while this constructor runs on a
    // slow first-time model load), this clone is silently disabled forever, even once the real
    // mic unmutes moments later. Confirmed live for the same clone-of-the-mic pattern in
    // CallRoomPage's vadTrack — see its matching comment. Actual muting already goes through
    // useVadAutoGate's GainNode downstream, not this track's .enabled, so there's no reason for
    // this clone to ever be disabled.
    this.sourceClone.enabled = true;
    const sourceNode = this.ctx.createMediaStreamSource(new MediaStream([this.sourceClone]));

    this.capture = this.ctx.createScriptProcessor(BUFFER_SIZE, 1, 1);
    let processing = false;
    this.capture.onaudioprocess = (event) => {
      if (this.stopped) return;
      // Measured before the `processing` bail-out below, so this stays a reading of how late
      // the main thread delivered the callback and doesn't get inflated by a skipped buffer.
      const now = performance.now();
      if (this.lastCaptureAt > 0) {
        const gap = now - this.lastCaptureAt;
        if (gap > this.captureIntervalMaxMs) this.captureIntervalMaxMs = gap;
      }
      this.lastCaptureAt = now;
      if (processing) return;
      processing = true;
      const input = new Float32Array(event.inputBuffer.getChannelData(0));
      this.lastInputRms = rms(input);
      void processor
        .push(input)
        .then((enhanced) => {
          const elapsed = performance.now() - now;
          this.inferenceCount++;
          this.inferenceTimeTotalMs += elapsed;
          if (elapsed > this.inferenceTimeMaxMs) this.inferenceTimeMaxMs = elapsed;
          if (enhanced.length > 0 && !this.stopped) {
            this.lastOutputRms = rms(enhanced);
            // Transferred, not copied: push() hands back a freshly allocated buffer it doesn't
            // retain, so the worklet can take ownership outright.
            this.playback.port.postMessage({ type: 'samples', samples: enhanced }, [enhanced.buffer]);
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

    const playbackOptions: GtcrnPlaybackOptions = { primeMs: PRIME_MS, maxMs: MAX_QUEUE_MS };
    this.playback = new AudioWorkletNode(this.ctx, 'gtcrn-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: playbackOptions,
    });
    this.playback.port.onmessage = (event: MessageEvent<GtcrnPlaybackStats>) => {
      this.playbackStats = event.data;
    };
    this.destination = this.ctx.createMediaStreamDestination();
    this.playback.connect(this.destination);

    this.statsInterval = setInterval(() => {
      const meanMs = this.inferenceCount > 0 ? this.inferenceTimeTotalMs / this.inferenceCount : 0;
      console.log('[Connect] GTCRN stats', {
        inferenceCount: this.inferenceCount,
        meanMs: meanMs.toFixed(2),
        maxMs: this.inferenceTimeMaxMs.toFixed(2),
        captureIntervalMaxMs: this.captureIntervalMaxMs.toFixed(0),
        underrunCount: this.playbackStats?.underrunCount ?? 0,
        droppedSamples: this.playbackStats?.droppedSamples ?? 0,
        queuedMs: (this.playbackStats?.queuedMs ?? 0).toFixed(0),
        priming: this.playbackStats?.priming ?? true,
        inputRms: this.lastInputRms.toFixed(4),
        outputRms: this.lastOutputRms.toFixed(4),
        ctxState: this.ctx.state,
      });
      this.captureIntervalMaxMs = 0;
    }, 3000);
  }

  get track(): MediaStreamTrack {
    return this.destination.stream.getAudioTracks()[0];
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.detachResumeRetry();
    clearInterval(this.statsInterval);
    this.capture.disconnect();
    this.playback.port.postMessage({ type: 'stop' });
    this.playback.disconnect();
    this.silentGain.disconnect();
    this.sourceClone.stop();
    this.track.stop();
    void this.ctx.close();
  }
}
