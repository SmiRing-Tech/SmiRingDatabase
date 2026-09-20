/**
 * Capture stage of the GTCRN noise-cancel pipeline.
 *
 * This replaces the ScriptProcessorNode that used to sit here. ScriptProcessorNode's
 * `onaudioprocess` runs on the **main thread** by specification, and its input buffer is only
 * valid for the duration of that one callback — so when the main thread stalls (a long React
 * render, a GC pause, the OS deprioritising a backgrounded renderer), the callback doesn't fire
 * and that window of microphone audio is *gone*, not merely late. That is the other half of the
 * stutter story the playback worklet's header describes, and the reason this side moved over
 * too: `process()` runs on the audio render thread at real-time priority, so capture keeps
 * happening on schedule no matter what the main thread is doing. A main-thread stall now only
 * delays when the relay forwards a chunk onward; nothing is dropped at the microphone.
 *
 * All this does is rebuffer the render quantum (128 samples at the 16kHz context this runs in)
 * into CHUNK-sized pieces and post them out — deliberately dependency-free, exactly like the
 * playback worklet, because onnxruntime-web genuinely cannot run inside an
 * AudioWorkletGlobalScope (no `self`, no `fetch` — see GtcrnNoiseCancelTrack's header). The
 * inference itself lives in gtcrnInference.worker.ts, an ordinary Worker where ORT runs fine.
 */

interface AudioWorkletProcessorLike {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessorLike;
  new (options?: { processorOptions?: unknown }): AudioWorkletProcessorLike;
};
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessorLike,
): void;

export interface GtcrnCaptureOptions {
  /** Samples to accumulate before posting a chunk out. Sets this stage's added latency. */
  chunkSize: number;
}

/** Worklet -> main, one per completed chunk. `samples` is transferred, not copied. */
export interface GtcrnCaptureChunk {
  type: 'chunk';
  samples: Float32Array;
}

class GtcrnCaptureProcessor extends AudioWorkletProcessor {
  private readonly chunkSize: number;
  private buffer: Float32Array;
  private filled = 0;
  private stopped = false;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const { chunkSize } = options?.processorOptions as GtcrnCaptureOptions;
    this.chunkSize = chunkSize;
    this.buffer = new Float32Array(chunkSize);

    this.port.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'stop') this.stopped = true;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;

    const input = inputs[0]?.[0];
    // No input connected yet (or a momentarily silent/disconnected source): stay alive rather
    // than returning false, which would retire this processor permanently.
    if (!input || input.length === 0) return true;

    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(this.chunkSize - this.filled, input.length - offset);
      this.buffer.set(input.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === this.chunkSize) {
        const chunk: GtcrnCaptureChunk = { type: 'chunk', samples: this.buffer };
        // Transferred, not copied — a fresh buffer is allocated for the next chunk below, so
        // this processor never touches the one it just handed off.
        this.port.postMessage(chunk, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.chunkSize);
        this.filled = 0;
      }
    }

    // Outputs are zero-filled by the spec before every process() call and nothing writes to
    // them here, so this node contributes silence to whatever it's connected to. It still has
    // to be connected to something reaching the destination to be pulled at all — see the
    // silentGain wiring in GtcrnNoiseCancelTrack.
    return true;
  }
}

registerProcessor('gtcrn-capture', GtcrnCaptureProcessor);
