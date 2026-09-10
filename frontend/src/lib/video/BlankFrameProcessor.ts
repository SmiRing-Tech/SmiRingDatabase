import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';

/**
 * A trivial bridge `TrackProcessor` that publishes a static black frame and nothing
 * else — no segmenter, no meaningful GPU work. Used as a brief placeholder between two
 * `MediapipeBackgroundProcessor` instances during a quality swap: MediaPipe's
 * tasks-vision WASM build only tolerates one `ImageSegmenter` alive at a time (see that
 * class's own doc comment), so the old one has to be fully torn down before the new one
 * can be built — leaving nothing attached in between would publish raw, unprocessed
 * camera video for that gap. This fills it instead, so a quality swap always reads as
 * "video paused for a moment," never "the background effect fell off."
 */
export class BlankFrameProcessor implements TrackProcessor<Track.Kind.Video> {
  readonly name = 'blank-frame-bridge';

  processedTrack?: MediaStreamTrack;

  private stream?: MediaStream;

  async init(opts: VideoProcessorOptions) {
    const settings = opts.track.getSettings();
    const canvas = document.createElement('canvas');
    canvas.width = settings.width || 640;
    canvas.height = settings.height || 360;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // A low fps is plenty for a frame that never changes; captureStream keeps emitting
    // this same still content at that rate on its own, no redraw loop needed.
    this.stream = canvas.captureStream(5);
    this.processedTrack = this.stream.getVideoTracks()[0];
  }

  async restart(opts: VideoProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.processedTrack = undefined;
  }
}
