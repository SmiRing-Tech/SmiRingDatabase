import { GTCRN_SAMPLE_RATE } from './GtcrnStreamProcessor';
import { keepAudioContextResumed } from '../keepAudioContextResumed';
import type { GtcrnPlaybackOptions, GtcrnPlaybackStats } from './gtcrnPlayback.worklet';
import type { GtcrnCaptureOptions, GtcrnCaptureChunk } from './gtcrnCapture.worklet';
import type { GtcrnWorkerRequest, GtcrnWorkerResponse } from './gtcrnInference.worker';
import playbackWorkletUrl from './gtcrnPlayback.worklet.ts?worker&url';
import captureWorkletUrl from './gtcrnCapture.worklet.ts?worker&url';

/**
 * Wraps GTCRN noise cancellation into a MediaStreamTrack-in, MediaStreamTrack-out node, the same
 * shape as VideoDelayPipeline — so CallRoomPage can splice it into its own audio graph exactly
 * like every other stage there, instead of going through LiveKit's setProcessor() slot (that's
 * the same reasoning as VideoDelayPipeline and the VAD gate: this file went through a whole
 * saga about setProcessor()-based Krisp racing the gate's own sender.replaceTrack() calls, and
 * this avoids reintroducing that class of bug — see the comment above useVadAutoGate).
 *
 * ## Thread layout
 *
 * Nothing in the per-buffer path runs on the main thread any more:
 *
 *   mic
 *    -> gtcrn-capture AudioWorkletNode      (audio render thread, realtime priority)
 *    -> [main thread relay: two postMessage calls, both zero-copy transfers]
 *    -> gtcrnInference.worker               (dedicated worker: FFT + 62.5 ONNX inferences/sec)
 *    -> [main thread relay]
 *    -> gtcrn-playback AudioWorkletNode      (audio render thread)
 *    -> MediaStreamDestination -> sender
 *
 * This used to be a ScriptProcessorNode on the main thread doing the inference inline. The
 * blocker that shape was working around — ORT cannot run inside an AudioWorkletGlobalScope
 * (`self is not defined` / `no available backend found`) — is real, but it only rules out
 * inference on the *audio* thread. An ordinary Worker is a normal JS environment where ORT runs
 * fine, so the inference moved there and the audio plumbing moved into worklets. See
 * gtcrnInference.worker.ts's header for the longer version.
 *
 * What this buys, beyond battery: the old shape lost microphone audio outright whenever the main
 * thread stalled (ScriptProcessorNode's input buffer is only valid inside its callback, and the
 * callback simply doesn't fire while the thread is busy). Capture now happens at realtime
 * priority regardless, and a main-thread stall only delays the relay.
 */

// 1024 samples @ 16kHz = 64ms. Unchanged from the ScriptProcessorNode this replaced, so
// GTCRN_PIPELINE_LATENCY_MS below — and everything downstream that compensates for it, notably
// the video delay pipeline — keeps the same value it had. With inference off the main thread
// there is now headroom to lower this for less latency; that's a separate, measurable change.
const CAPTURE_CHUNK = 1024;

/** How long a stall the playback worklet can hide before listeners hear anything. Paid for
 * one-for-one in mouth-to-ear latency (and, via GTCRN_PIPELINE_LATENCY_MS below, in how far
 * video is delayed to keep lips in sync), so it's a straight continuity-vs-latency dial. */
const PRIME_MS = 128;
/** Ceiling on queued audio, so a producer that ever runs ahead doesn't leave the extra delay in
 * place for the rest of the call. Generous — it should only ever bite after a long stall. */
const MAX_QUEUE_MS = 400;

/** This stage's added latency: a full capture chunk has to accumulate before anything sees it,
 * then the playback worklet holds PRIME_MS more as its anti-stall cushion. Exported so callers
 * (the video delay pipeline, to keep lips in sync) can account for it instead of guessing. */
export const GTCRN_PIPELINE_LATENCY_MS = (CAPTURE_CHUNK / GTCRN_SAMPLE_RATE) * 1000 + PRIME_MS;

// ---------------------------------------------------------------- Shared inference worker

/**
 * One worker for the page, not one per track instance. The expensive part of starting up is the
 * ORT session (a multi-second model download + WASM compile on a cold cache), and keeping the
 * worker alive across toggles means flipping noise-cancel off and back on is instant — the same
 * property the old module-scope `sessionPromise` had. Per-stream DSP state is isolated inside
 * the worker by streamId, so an outgoing instance's teardown can safely overlap an incoming
 * one's setup (which it routinely does — see the cleanup comment in useVadAutoGate).
 */
let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let nextStreamId = 1;

/** streamId -> that instance's handler for 'enhanced' messages. */
const streamHandlers = new Map<number, (msg: Extract<GtcrnWorkerResponse, { type: 'enhanced' }>) => void>();

function postToWorker(message: GtcrnWorkerRequest, transfer?: Transferable[]) {
  worker?.postMessage(message, transfer ?? []);
}

function getWorker(): Promise<void> {
  if (!workerReady) {
    const w = new Worker(new URL('./gtcrnInference.worker.ts', import.meta.url), { type: 'module' });
    worker = w;

    workerReady = new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<GtcrnWorkerResponse>) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          resolve();
        } else if (msg.type === 'error') {
          // Session-level failures reject the readiness promise (so create() can fall back to
          // the raw mic, exactly as the old main-thread version did); anything later is logged,
          // since by then there's a live pipeline that simply produces nothing for that chunk.
          console.error('[Connect] GTCRN worker:', msg.message);
          reject(new Error(msg.message));
        } else if (msg.type === 'enhanced') {
          streamHandlers.get(msg.streamId)?.(msg);
        }
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', (e) => reject(new Error(`GTCRN worker failed to load: ${e.message}`)));
      postToWorker({ type: 'init' });
    });

    workerReady.catch(() => {
      // Don't cache a rejected promise: one transient failure would otherwise disable
      // noise-cancel for the rest of the page's life, with retoggling unable to help.
      w.terminate();
      worker = null;
      workerReady = null;
    });
  }
  return workerReady;
}

/**
 * Fire-and-forget preload, exported so PreJoinScreen can start the worker and its ORT session
 * while the user is still looking at the pre-join preview, in parallel with the getUserMedia()
 * permission prompt — so `create()` resolves near-instantly after the user joins instead of
 * running a multi-second load deep inside the room-join sequence. Settles either way; a failed
 * warmup just leaves `create()` to retry from scratch.
 */
export function warmupGtcrnModel(): Promise<void> {
  return getWorker().catch(() => undefined);
}

// ---------------------------------------------------------------- Track wrapper

export class GtcrnNoiseCancelTrack {
  private readonly ctx: AudioContext;
  private readonly sourceClone: MediaStreamTrack;
  private readonly destination: MediaStreamAudioDestinationNode;
  private readonly capture: AudioWorkletNode;
  private readonly playback: AudioWorkletNode;
  private readonly silentGain: GainNode;
  private readonly streamId: number;
  private stopped = false;
  private readonly detachResumeRetry: () => void;

  // Diagnostics only, and dev-only in what they feed (see the stats interval below).
  private inferenceCount = 0;
  private inferenceTimeTotalMs = 0;
  private inferenceTimeMaxMs = 0;
  private lastInputRms = 0;
  private lastOutputRms = 0;
  // Gap between consecutive relay invocations. The relay is the one step still on the main
  // thread, so this is the direct readout of how starved that thread gets: it should sit at
  // ~64ms, and whatever it peaks to during a stall is what the cushions have to cover. Unlike
  // the ScriptProcessorNode this replaced, a spike here no longer means lost audio — the
  // capture worklet keeps buffering — only late audio.
  private relayIntervalMaxMs = 0;
  private lastRelayAt = 0;
  private playbackStats: GtcrnPlaybackStats | null = null;
  private statsInterval: ReturnType<typeof setInterval> | undefined;

  /**
   * @param isActive Polled once per captured chunk (~every CAPTURE_CHUNK/GTCRN_SAMPLE_RATE ms).
   *   While it returns false the chunk is dropped at the relay instead of being sent to the
   *   worker, skipping the inference entirely on audio the gate (see useVadAutoGate) is about to
   *   zero out anyway. Muted is the overwhelmingly common state for most of a call, so this is
   *   the single biggest lever on battery use here without touching quality while unmuted.
   *   Deliberately polled at the relay rather than pushed down into the capture worklet: a
   *   worklet that stops posting while muted could never be told that the mute had ended.
   */
  static async create(
    source: MediaStreamTrack,
    isActive: () => boolean = () => true,
  ): Promise<GtcrnNoiseCancelTrack> {
    await getWorker();
    // Model is fixed at 16kHz; creating the context at that rate lets the browser's own
    // resampler handle 48kHz-hardware -> 16kHz transparently (same trick as the VAD mic tap).
    const ctx = new AudioContext({ sampleRate: GTCRN_SAMPLE_RATE });
    // A freshly constructed AudioContext can start 'suspended' under the browsers' autoplay
    // policy — this runs well removed from whatever click actually joined the call, so it
    // doesn't reliably inherit that gesture, and on stricter browsers (Safari, in-app webviews)
    // a single resume() attempt here can silently fail with no error. Suspended means the graph
    // never processes a single sample: the output track is live but permanently silent, which
    // looks exactly like a stuck mute. keepAudioContextResumed retries on every subsequent page
    // interaction until it actually succeeds. Attached before the awaits below so the retry is
    // already armed while the modules load.
    const detachResumeRetry = keepAudioContextResumed(ctx);
    try {
      await Promise.all([
        ctx.audioWorklet.addModule(captureWorkletUrl),
        ctx.audioWorklet.addModule(playbackWorkletUrl),
      ]);
    } catch (e) {
      detachResumeRetry();
      void ctx.close();
      throw e;
    }
    return new GtcrnNoiseCancelTrack(ctx, detachResumeRetry, source, isActive);
  }

  private constructor(
    ctx: AudioContext,
    detachResumeRetry: () => void,
    source: MediaStreamTrack,
    isActive: () => boolean,
  ) {
    this.ctx = ctx;
    this.detachResumeRetry = detachResumeRetry;
    this.streamId = nextStreamId++;

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

    // --- playback stage (built first: the relay below posts into it) ---
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

    // --- worker stream + the return half of the relay ---
    postToWorker({ type: 'open', streamId: this.streamId });
    streamHandlers.set(this.streamId, (msg) => {
      if (this.stopped) return;
      this.inferenceCount++;
      this.inferenceTimeTotalMs += msg.inferenceMs;
      if (msg.inferenceMs > this.inferenceTimeMaxMs) this.inferenceTimeMaxMs = msg.inferenceMs;
      this.lastInputRms = msg.inputRms;
      this.lastOutputRms = msg.outputRms;
      // Transferred straight through to the audio thread — the worker doesn't retain it and
      // neither does this handler, so nothing is copied anywhere along the path.
      this.playback.port.postMessage({ type: 'samples', samples: msg.samples }, [msg.samples.buffer]);
    });

    // --- capture stage + the outbound half of the relay ---
    const captureOptions: GtcrnCaptureOptions = { chunkSize: CAPTURE_CHUNK };
    this.capture = new AudioWorkletNode(this.ctx, 'gtcrn-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: captureOptions,
    });
    this.capture.port.onmessage = (event: MessageEvent<GtcrnCaptureChunk>) => {
      if (this.stopped) return;
      const now = performance.now();
      if (this.lastRelayAt > 0) {
        const gap = now - this.lastRelayAt;
        if (gap > this.relayIntervalMaxMs) this.relayIntervalMaxMs = gap;
      }
      this.lastRelayAt = now;
      if (!isActive()) return;
      const samples = event.data.samples;
      postToWorker({ type: 'samples', streamId: this.streamId, samples }, [samples.buffer]);
    };

    // An AudioWorkletNode is only pulled once it's wired into a graph reaching the destination.
    // The capture node writes nothing to its output, so routing it through a zero gain keeps
    // the signal path silent while still getting process() called.
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    sourceNode.connect(this.capture);
    this.capture.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);

    if (import.meta.env.DEV) {
      this.statsInterval = setInterval(() => {
        const meanMs = this.inferenceCount > 0 ? this.inferenceTimeTotalMs / this.inferenceCount : 0;
        console.log('[Connect] GTCRN stats', {
          inferenceCount: this.inferenceCount,
          meanMs: meanMs.toFixed(2),
          maxMs: this.inferenceTimeMaxMs.toFixed(2),
          relayIntervalMaxMs: this.relayIntervalMaxMs.toFixed(0),
          underrunCount: this.playbackStats?.underrunCount ?? 0,
          droppedSamples: this.playbackStats?.droppedSamples ?? 0,
          queuedMs: (this.playbackStats?.queuedMs ?? 0).toFixed(0),
          priming: this.playbackStats?.priming ?? true,
          inputRms: this.lastInputRms.toFixed(4),
          outputRms: this.lastOutputRms.toFixed(4),
          ctxState: this.ctx.state,
        });
        this.relayIntervalMaxMs = 0;
      }, 3000);
    }
  }

  get track(): MediaStreamTrack {
    return this.destination.stream.getAudioTracks()[0];
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.detachResumeRetry();
    if (this.statsInterval !== undefined) clearInterval(this.statsInterval);
    // Drop this stream's DSP state in the worker, and stop routing its results here. The worker
    // itself stays alive for the page — see getWorker's comment.
    streamHandlers.delete(this.streamId);
    postToWorker({ type: 'close', streamId: this.streamId });
    this.capture.port.postMessage({ type: 'stop' });
    this.capture.disconnect();
    this.playback.port.postMessage({ type: 'stop' });
    this.playback.disconnect();
    this.silentGain.disconnect();
    this.sourceClone.stop();
    this.track.stop();
    void this.ctx.close();
  }
}
