/**
 * Holds outgoing camera frames back by a fixed wall-clock delay.
 *
 * This exists purely to keep lips in sync. The VAD auto-gate delays outgoing *audio* (see
 * GATE_DELAY_MS in CallRoomPage) so that when Silero finally reports speech, the audio from
 * just *before* that decision is still sitting in a delay line and can be released instead of
 * clipped. Video isn't gated and so isn't delayed, which leaves a remote viewer watching a
 * mouth move GATE_DELAY_MS before they hear it — and leaves composited recordings with the
 * same offset baked in, since recording-compositor places tracks by wall-clock arrival.
 * Delaying video by the identical amount puts both back on the same timeline.
 *
 * Web Audio has DelayNode for the audio half; video has no equivalent, so frames are paced by
 * hand through WebCodecs insertable streams — the same MediaStreamTrackProcessor/Generator
 * plumbing MediapipeBackgroundProcessor already uses for background replacement.
 *
 * The per-frame wait is timed off a dedicated Worker's setInterval (videoDelayTicker.worker.ts),
 * not a plain setTimeout in transform(). Backgrounding the tab clamps main-thread timers to
 * ~1/sec in Chrome, which turned this into "frames dump out once a second, choppy video" —
 * dedicated Workers are exempt from that throttle, so ticking from one keeps pacing smooth
 * whether or not the tab is visible.
 */

/** Frames are buffered for the whole delay window; sized for the worst-case capture rate. */
const MAX_EXPECTED_FPS = 60;
const FRAME_BUFFER_MARGIN = 4;
/**
 * How far the computed release time may drift from its expected window before the pipeline
 * re-derives its capture-clock/wall-clock offset. Without this, a camera restart (which resets
 * frame timestamps) either stalls the stream for seconds or dumps the whole buffer at once.
 */
const RESYNC_TOLERANCE_MS = 500;

export function isVideoDelaySupported(): boolean {
  return (
    typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined'
  );
}

export class VideoDelayPipeline {
  private readonly abortController = new AbortController();
  private readonly generator: MediaStreamTrackGenerator<VideoFrame>;
  private readonly delayMs: number;
  private readonly onFrame?: () => void;
  /** performance.now() minus the capture clock, established on the first frame. */
  private baseOffsetMs: number | null = null;
  private stopped = false;

  private readonly ticker: Worker;
  /** Pending frame releases, each waiting for performance.now() to reach `at`. */
  private waiters: Array<{ at: number; resolve: () => void }> = [];

  /**
   * @param source   The track currently feeding the sender — the background processor's output
   *                 when one is attached, the raw camera otherwise. Read directly rather than
   *                 cloned (the same thing MediapipeBackgroundProcessor does with the camera
   *                 track it's handed, while that track is also attached to preview elements),
   *                 and never stopped here: it belongs to whoever produced it.
   * @param onFrame  Called after each frame is handed downstream. Used as a ~frame-rate tick to
   *                 re-check that the sender is still carrying this pipeline's output.
   */
  constructor(
    source: MediaStreamTrack,
    delayMs: number,
    onFrame?: () => void,
  ) {
    this.delayMs = delayMs;
    this.onFrame = onFrame;

    this.ticker = new Worker(new URL('./videoDelayTicker.worker.ts', import.meta.url), { type: 'module' });
    this.ticker.onmessage = () => {
      const now = performance.now();
      this.waiters = this.waiters.filter((w) => {
        if (now < w.at) return true;
        w.resolve();
        return false;
      });
    };
    this.ticker.postMessage('start');

    const processor = new MediaStreamTrackProcessor({
      track: source as MediaStreamVideoTrack,
      // Chrome's default for video is a single frame, which would drop everything that arrives
      // while transform() is waiting out the delay and reduce the stream to a slideshow.
      maxBufferSize: Math.ceil((delayMs / 1000) * MAX_EXPECTED_FPS) + FRAME_BUFFER_MARGIN,
    });
    this.generator = new MediaStreamTrackGenerator({ kind: 'video' });

    const transformer = new TransformStream<VideoFrame, VideoFrame>({
      transform: (frame, controller) => this.transform(frame, controller),
    });

    processor.readable
      .pipeThrough(transformer, { signal: this.abortController.signal })
      .pipeTo(this.generator.writable, { signal: this.abortController.signal })
      .catch((err) => {
        if (!this.stopped) console.error('[video-delay] pipeline error:', err);
      });
  }

  /** The delayed track to hand to RTCRtpSender.replaceTrack(). */
  get track(): MediaStreamTrack {
    return this.generator as unknown as MediaStreamTrack;
  }

  private async transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
    // Paced off VideoFrame.timestamp (the capture clock, in microseconds) rather than off
    // arrival time: transform() runs serially, so a frame that already waited its turn in the
    // queue would get the full delay added on top of however long it had been sitting there,
    // and the delay would grow without bound.
    const frameMs = frame.timestamp / 1000;
    if (this.baseOffsetMs === null) this.baseOffsetMs = performance.now() - frameMs;

    let waitMs = frameMs + this.baseOffsetMs + this.delayMs - performance.now();
    if (waitMs < -RESYNC_TOLERANCE_MS || waitMs > this.delayMs + RESYNC_TOLERANCE_MS) {
      this.baseOffsetMs = performance.now() - frameMs;
      waitMs = this.delayMs;
    }
    if (waitMs > 0) await this.waitUntil(performance.now() + waitMs);

    // A frame that's still open when the pipeline goes away holds GPU memory until GC.
    if (this.stopped) {
      frame.close();
      return;
    }
    controller.enqueue(frame);
    this.onFrame?.();
  }

  /** Resolves once performance.now() reaches `at`, ticked by the un-throttled worker. */
  private waitUntil(at: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ at, resolve });
    });
  }

  /** Only ever call once the sender has been pointed somewhere else — this track is live. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abortController.abort();
    this.track.stop();
    // Settle any in-flight transform() await immediately so its pending VideoFrame gets closed
    // (see the comment above) instead of leaking until the worker is torn down.
    this.waiters.forEach((w) => w.resolve());
    this.waiters = [];
    this.ticker.postMessage('stop');
    this.ticker.terminate();
  }
}
