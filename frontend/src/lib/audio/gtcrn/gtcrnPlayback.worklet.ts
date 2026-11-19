/**
 * Playback stage of the GTCRN noise-cancel pipeline.
 *
 * Runs on the audio render thread (process() is called on time whatever the page or the
 * inference worker are doing — it replaced a main-thread ScriptProcessorNode whose stalls were
 * the "が、が、が" repeat stutter).
 *
 * Timeline playout with raw fill (2026-11-19). Every sample here is addressed by the context's
 * frame number (`currentFrame`, shared by every worklet in this AudioContext):
 *  - The raw mic is wired into this node too, and kept in a ring buffer by frame.
 *  - Each processed chunk from the worker carries the frame of the raw audio it corresponds to
 *    (tagged by the capture worklet, shifted by GTCRN's own analysis delay in the worker).
 *  - Output for frame F plays at F + latency: the processed sample for that frame when it has
 *    arrived, otherwise the *raw* sample of that same frame.
 * So when the worker stalls — measured on 2026-11-19 at 200-1100ms on a Mac in Low Power Mode
 * while switching desktops, far past any cushion worth its latency — listeners hear the room's
 * noise for that moment instead of silence, the voice never breaks up, and the latency never
 * changes (no re-priming, nothing to drain back down). Processed audio for a frame that has
 * already been played is simply dropped. Coming back from raw, the two are crossfaded.
 *
 * Deliberately dependency-free: onnxruntime-web can't run in an AudioWorkletGlobalScope (see
 * GtcrnNoiseCancelTrack's header) — this only needs ring buffers.
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
declare const sampleRate: number;
declare const currentFrame: number;

export interface GtcrnPlaybackOptions {
  /**
   * Raw frame F plays at F + this. Has to cover one capture chunk accumulating, GTCRN's analysis
   * delay and the worker's normal inference time; anything later than this plays raw instead.
   * Added one-for-one to mouth-to-ear latency (and the video is delayed to match).
   */
  latencyMs: number;
}

/** main -> worklet: take samples from this port (the inference worker's end) from now on. */
export interface GtcrnPlaybackConnect {
  type: 'connect';
  port: MessagePort;
}

/** worker -> worklet: processed audio for raw frames startFrame .. startFrame + samples.length. */
export interface GtcrnPlaybackSamples {
  type: 'samples';
  samples: Float32Array;
  startFrame: number;
}

/** main -> worklet: whether the mic is live. Muted, the worker processes nothing and everything
 *  plays raw (the gate downstream silences it) — that isn't counted as filling. */
export interface GtcrnPlaybackActive {
  type: 'active';
  active: boolean;
}

/** Worklet -> main, every STATS_INTERVAL_MS. Counters are cumulative unless noted. */
export interface GtcrnPlaybackStats {
  type: 'stats';
  /** Stretches played from the raw mic because processed audio was late (mic live only). */
  fillCount: number;
  filledSamples: number;
  /** Stretches of silence: neither processed nor raw audio for the frame (should stay 0). */
  underrunCount: number;
  /** Processed samples that arrived after their frame had played (dropped). */
  lateSamples: number;
  /** How far processed audio reaches past what's playing now, ms (a live gauge). */
  queuedMs: number;
  /** Playing raw right now. */
  filling: boolean;
  /** Since the previous stats: the least processed audio ahead while playing processed, and the
   *  longest raw-filled stretch, ms. */
  minQueuedMs: number | null;
  longestFillMs: number;
}

const STATS_INTERVAL_MS = 1000;
/** Ring buffers hold this long of audio — far more than latency + the longest stall to absorb. */
const RING_SECONDS = 4;
/** Raw -> processed crossfade, samples (4ms at 16kHz). Processed -> raw switches at once: there's
 *  no processed audio left to fade out. */
const CROSSFADE_SAMPLES = 64;

class GtcrnPlaybackProcessor extends AudioWorkletProcessor {
  private readonly latency: number;
  private readonly capacity: number;
  /** Processed and raw audio by frame (index = frame % capacity), each with the frame it holds. */
  private readonly proc: Float32Array;
  private readonly procFrame: Float64Array;
  private readonly raw: Float32Array;
  private readonly rawFrame: Float64Array;
  /** Highest frame of processed audio received so far, +1. */
  private procEnd = 0;
  /** 1 = processed, 0 = raw; ramps toward processed after a fill. */
  private mix = 1;

  private active = true;
  private stopped = false;
  private input: MessagePort | null = null;

  private filling = false;
  private fillRun = 0;
  private longestFill = 0;
  private fillCount = 0;
  private filledSamples = 0;
  private silent = false;
  private underrunCount = 0;
  private lateSamples = 0;
  private minAhead = Infinity;
  private samplesSinceStats = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const { latencyMs } = options?.processorOptions as GtcrnPlaybackOptions;
    this.latency = Math.round((latencyMs / 1000) * sampleRate);
    this.capacity = Math.round(RING_SECONDS * sampleRate);
    this.proc = new Float32Array(this.capacity);
    this.procFrame = new Float64Array(this.capacity).fill(-1);
    this.raw = new Float32Array(this.capacity);
    this.rawFrame = new Float64Array(this.capacity).fill(-1);

    // Samples arrive on a port from the inference worker (see GtcrnPlaybackConnect).
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as
        | GtcrnPlaybackSamples
        | GtcrnPlaybackConnect
        | GtcrnPlaybackActive
        | { type: 'stop' };
      if (msg.type === 'samples') this.write(msg.samples, msg.startFrame);
      else if (msg.type === 'active') this.active = msg.active;
      else if (msg.type === 'connect') {
        this.input = msg.port;
        msg.port.onmessage = onMessage;
      } else if (msg.type === 'stop') {
        this.stopped = true;
        this.input?.close();
      }
    };
    this.port.onmessage = onMessage;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0];
    const rawIn = inputs[0]?.[0];
    const base = currentFrame;

    // Keep the raw mic by frame.
    if (rawIn) {
      for (let i = 0; i < rawIn.length; i++) {
        const frame = base + i;
        const at = frame % this.capacity;
        this.raw[at] = rawIn[i];
        this.rawFrame[at] = frame;
      }
    }
    if (!out) return !this.stopped;

    const playhead = base - this.latency;
    for (let i = 0; i < out.length; i++) {
      const frame = playhead + i;
      if (frame < 0) {
        out[i] = 0;
        continue;
      }
      const at = frame % this.capacity;
      const hasProc = this.procFrame[at] === frame;
      const hasRaw = this.rawFrame[at] === frame;
      if (hasProc) {
        if (this.filling) this.endFill();
        this.silent = false;
        if (this.mix < 1 && hasRaw) {
          this.mix = Math.min(1, this.mix + 1 / CROSSFADE_SAMPLES);
          out[i] = this.mix * this.proc[at] + (1 - this.mix) * this.raw[at];
        } else {
          this.mix = 1;
          out[i] = this.proc[at];
        }
      } else if (hasRaw) {
        this.mix = 0;
        this.silent = false;
        out[i] = this.raw[at];
        if (this.active) {
          if (!this.filling) {
            this.filling = true;
            this.fillCount++;
          }
          this.fillRun++;
          this.filledSamples++;
        }
      } else {
        out[i] = 0;
        if (!this.silent && this.active) this.underrunCount++;
        this.silent = true;
      }
    }

    const ahead = this.procEnd - (playhead + out.length);
    if (!this.filling && this.active) this.minAhead = Math.min(this.minAhead, Math.max(0, ahead));

    this.samplesSinceStats += out.length;
    if (this.samplesSinceStats >= (STATS_INTERVAL_MS / 1000) * sampleRate) {
      this.samplesSinceStats = 0;
      const stats: GtcrnPlaybackStats = {
        type: 'stats',
        fillCount: this.fillCount,
        filledSamples: this.filledSamples,
        underrunCount: this.underrunCount,
        lateSamples: this.lateSamples,
        queuedMs: (Math.max(0, ahead) / sampleRate) * 1000,
        filling: this.filling,
        minQueuedMs: Number.isFinite(this.minAhead) ? (this.minAhead / sampleRate) * 1000 : null,
        // A fill still going counts too, so a long one shows up while it lasts.
        longestFillMs: (Math.max(this.longestFill, this.filling ? this.fillRun : 0) / sampleRate) * 1000,
      };
      this.port.postMessage(stats);
      this.minAhead = Infinity;
      this.longestFill = 0;
    }

    return !this.stopped;
  }

  private endFill() {
    this.filling = false;
    this.longestFill = Math.max(this.longestFill, this.fillRun);
    this.fillRun = 0;
  }

  private write(samples: Float32Array, startFrame: number): void {
    // Whatever has already played (or is playing in this quantum) is too late to use.
    const playhead = currentFrame - this.latency;
    for (let i = 0; i < samples.length; i++) {
      const frame = startFrame + i;
      if (frame < playhead) {
        this.lateSamples++;
        continue;
      }
      const at = frame % this.capacity;
      this.proc[at] = samples[i];
      this.procFrame[at] = frame;
    }
    this.procEnd = Math.max(this.procEnd, startFrame + samples.length);
  }
}

registerProcessor('gtcrn-playback', GtcrnPlaybackProcessor);
