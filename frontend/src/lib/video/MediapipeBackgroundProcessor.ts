import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from '@mediapipe/tasks-vision';
import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client';
import {
  bindTextureUnit,
  createProgram,
  createQuadBuffer,
  createRenderTarget,
  createTexture,
  deleteRenderTarget,
  drawQuad,
  type GLProgram,
  type RenderTarget,
} from './mediapipeGL';
import {
  alphaFragmentShader,
  compositeFragmentShader,
  copyFragmentShader,
  gaussianFragmentShader,
} from './mediapipeShaders';

/**
 * A LiveKit `TrackProcessor` that blurs the camera background using MediaPipe
 * Image Segmenter directly, instead of going through `@livekit/track-processors`.
 *
 * Why not just use `BackgroundBlur` from `@livekit/track-processors`? That
 * processor is already MediaPipe under the hood, but it consumes the segmenter's
 * *category* mask — a hard 0/1 per-pixel classification. Hair, glasses frames and
 * motion-blurred edges are exactly the places where a pixel is genuinely
 * "partly person", and a binary mask has no way to say so, which is what produces
 * the cut-out-with-scissors look.
 *
 * This processor consumes the *confidence* mask instead, so a strand of hair can
 * come through at alpha 0.4, and adds two things the built-in pipeline has no
 * knob for:
 *
 *   - temporal smoothing, so the matte stops crawling frame to frame;
 *   - a tunable feather, so the alpha ramp is a soft gradient rather than a
 *     gradient-derived smoothstep at a fixed width.
 *
 * Everything stays on the GPU: MediaPipe renders into the same WebGL2 canvas we
 * composite on, so the mask never round-trips through CPU memory (the one
 * exception is polarity detection, which reads back a handful of frames at
 * startup and only when the model ships no label map).
 */

export type SegmentationQuality = 'balanced' | 'high';

/** Pinned to the installed @mediapipe/tasks-vision version — keep in sync on upgrade. */
const TASKS_VISION_VERSION = '1.0.1';

const MODELS: Record<SegmentationQuality, string> = {
  // 244 KB. Binary person/background, trained on 256x144 landscape input, which
  // matches a 16:9 webcam without the aspect squash the square model suffers.
  balanced:
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite',
  // 15.6 MB. Six classes (background / hair / body-skin / face-skin / clothes /
  // accessories); the dedicated hair class is what makes the difference on
  // fly-away strands. Cached by the browser after the first download.
  high: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

export type BackgroundMode = 'blur' | 'image';

/** Which side of the matte the effect lands on. */
export type EffectTarget = 'background' | 'subject';

export type MediapipeBackgroundOptions = {
  /** Replace the background with a blurred copy of it, or with a still image. */
  mode?: BackgroundMode;
  /**
   * Whether the effect replaces the background (the usual case) or the subject
   * — the latter blurs the person and leaves the room sharp, or cuts the image
   * into the person's silhouette.
   */
  target?: EffectTarget;
  /**
   * Image to sit behind the subject in `image` mode. Cross-origin URLs (e.g. R2
   * presigned links) are fetched with `crossOrigin = 'anonymous'`, so the bucket
   * must send CORS headers — without them the load fails rather than silently
   * tainting the canvas, which would break frame capture entirely.
   */
  imageUrl?: string | null;
  /** Background blur strength in output pixels. Only used in `blur` mode. */
  blurRadius?: number;
  /** Which segmentation model to load. Changing this requires a new processor. */
  quality?: SegmentationQuality;
  /** How much of the previous frame's matte to keep, 0..0.95. Higher = steadier edge, more lag. */
  temporalSmoothing?: number;
  /** Width of the soft alpha ramp at the silhouette, in output pixels. */
  edgeFeather?: number;
  /** Cap on segmentation inferences per second; frames in between reuse the last matte. */
  segmentationFps?: number;
  /** Override the WASM bundle / model URLs, e.g. to self-host them. */
  assetPaths?: { wasmFileSet?: string; modelAssetPath?: string };
  /** MediaPipe inference backend. GPU unless you have a reason. */
  delegate?: 'GPU' | 'CPU';
  /**
   * Forces how the confidence mask is read: `true` = it scores background,
   * `false` = it scores the subject. Leave undefined to auto-detect. This is a
   * debugging escape hatch, not the way to swap the effect around — that is
   * what `target` is for.
   */
  invertMask?: boolean;
};

const DEFAULTS = {
  mode: 'blur' as BackgroundMode,
  target: 'background' as EffectTarget,
  imageUrl: null as string | null,
  blurRadius: 12,
  quality: 'balanced' as SegmentationQuality,
  temporalSmoothing: 0.45,
  edgeFeather: 4,
  // Enough to steady a stationary edge; the shader drops it toward zero wherever
  // the matte is moving, so raising it does not reintroduce trails.
  segmentationFps: 30,
  delegate: 'GPU' as const,
  invertMask: undefined as boolean | undefined,
};

/** True when the browser can run this processor at all. */
export function supportsMediapipeBackground(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof VideoFrame === 'undefined') return false;
  const canRender = !!document.createElement('canvas').getContext('webgl2');
  const canPipe =
    (typeof MediaStreamTrackGenerator !== 'undefined' &&
      typeof MediaStreamTrackProcessor !== 'undefined') ||
    'captureStream' in HTMLCanvasElement.prototype;
  return canRender && canPipe;
}

type Programs = {
  alpha: GLProgram<'u_mask' | 'u_history' | 'u_invert' | 'u_lo' | 'u_hi' | 'u_history_weight'>;
  gaussian: GLProgram<'u_texture' | 'u_step'>;
  copy: GLProgram<'u_texture'>;
  composite: GLProgram<
    | 'u_frame'
    | 'u_background'
    | 'u_alpha'
    | 'u_background_scale'
    | 'u_background_offset'
    | 'u_swap_sides'
  >;
};

export class MediapipeBackgroundProcessor implements TrackProcessor<Track.Kind.Video> {
  /**
   * Includes the model, because LiveKit identifies a processor by this string
   * (it serialises `processor` down to `.name` when deciding whether preview
   * tracks need rebuilding). Everything else about this processor can be changed
   * in place; the model cannot, so the name has to change with it.
   */
  name: string;

  processedTrack?: MediaStreamTrack;

  // invertMask stays genuinely optional: undefined means "auto-detect", which is
  // a different state from either explicit true or false.
  private options: Required<Omit<MediapipeBackgroundOptions, 'assetPaths' | 'invertMask'>> &
    Pick<MediapipeBackgroundOptions, 'assetPaths' | 'invertMask'>;

  private segmenter?: ImageSegmenter;

  private canvas?: HTMLCanvasElement;

  private gl?: WebGL2RenderingContext;

  private programs?: Programs;

  private quadBuffer?: WebGLBuffer;

  private vao?: WebGLVertexArrayObject;

  private frameTexture?: WebGLTexture;

  /** Ping-pong pair holding the temporally smoothed matte. */
  private matte: RenderTarget[] = [];

  private matteIndex = 0;

  private featherScratch?: RenderTarget;

  private feathered?: RenderTarget;

  /** Still image used in `image` mode, already uploaded to the GPU. */
  private imageTexture?: WebGLTexture;

  private imageAspect = 1;

  /** URL currently held in imageTexture, so we only re-upload on a real change. */
  private loadedImageUrl?: string | null;

  /** Guards against an out-of-order load when the URL changes mid-flight. */
  private imageLoadToken = 0;

  /** Half-resolution step on the way down to the background buffers. */
  private halfFrame?: RenderTarget;

  /** Ping-pong pair for the downsampled, blurred background. */
  private background: RenderTarget[] = [];

  private sourceTrack?: MediaStreamTrack;

  private streamProcessor?: MediaStreamTrackProcessor<VideoFrame>;

  private streamGenerator?: MediaStreamTrackGenerator<VideoFrame>;

  private abortController?: AbortController;

  private fallbackVideo?: HTMLVideoElement;

  private fallbackStream?: MediaStream;

  private fallbackHandle?: number;

  private width = 0;

  private height = 0;

  private hasMatteHistory = false;

  /** 1 when confidenceMasks[maskIndex] is *background* confidence, 0 when it is foreground. */
  private invert?: number;

  private maskIndex = 0;

  /** Label map from the model, if it ships one. Used to pick the mask, never the polarity. */
  private labels: string[] = [];

  private maskIndexResolved = false;

  private lastSegmentationMs = 0;

  private lastTimestampMs = 0;

  private stopped = false;

  constructor(options: MediapipeBackgroundOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.name = `mediapipe-background-${this.options.quality}`;
  }

  /** The model this processor was built with; changing it requires a new instance. */
  get quality(): SegmentationQuality {
    return this.options.quality;
  }

  /** Live-updates the numeric knobs; every one of them is re-read each frame. */
  updateOptions(
    options: Pick<
      MediapipeBackgroundOptions,
      | 'blurRadius'
      | 'edgeFeather'
      | 'temporalSmoothing'
      | 'segmentationFps'
      | 'target'
      | 'invertMask'
    >,
  ) {
    this.options = { ...this.options, ...options };
  }

  /**
   * Switches between blurred and still-image backgrounds. Rejects if the image
   * cannot be loaded (CORS, 404, expired presigned URL); the processor keeps
   * running and falls back to blur, so callers can surface the error without
   * having to tear anything down.
   */
  async setBackground(options: { mode: BackgroundMode; imageUrl?: string | null }) {
    this.options = { ...this.options, ...options };
    if (options.mode !== 'image') return;
    await this.loadImage(this.options.imageUrl ?? null);
  }

  private releaseImageTexture() {
    if (this.imageTexture && this.gl) this.gl.deleteTexture(this.imageTexture);
    this.imageTexture = undefined;
    this.loadedImageUrl = undefined;
  }

  private async loadImage(url: string | null) {
    // Every load takes a ticket; a slower earlier load must not overwrite a newer one.
    const token = this.imageLoadToken + 1;
    this.imageLoadToken = token;

    if (!url) {
      this.releaseImageTexture();
      return;
    }
    if (url === this.loadedImageUrl && this.imageTexture) return;

    const image = new Image();
    // Required: without it a cross-origin image taints the canvas, and a tainted
    // canvas makes new VideoFrame(canvas) / captureStream throw, killing the track.
    image.crossOrigin = 'anonymous';
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error(
        '背景画像を読み込めませんでした。URL の有効期限か、配信元の CORS 設定を確認してください。',
      );
    }

    const gl = this.gl;
    if (token !== this.imageLoadToken || !gl || this.stopped) return;

    this.releaseImageTexture();
    const texture = createTexture(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Same unpack convention as the camera frame, so the single flip in the
    // composite pass puts both the right way up.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

    this.imageTexture = texture;
    this.imageAspect = image.naturalWidth / Math.max(1, image.naturalHeight);
    this.loadedImageUrl = url;
  }

  /**
   * How to read the confidence mask, as a 0/1 shader uniform.
   *
   * An explicit `invertMask` wins. Otherwise use what detectPolarity measured,
   * and until it has measured anything assume the mask scores background: both
   * bundled models put background at category 0, so that is the safer of the
   * two guesses to start from — getting it wrong blurs the person instead.
   */
  private get resolvedInvert(): number {
    if (this.options.invertMask !== undefined) return this.options.invertMask ? 1 : 0;
    return this.invert ?? 1;
  }

  /** What the processor currently believes about mask polarity — for debug UIs. */
  get maskPolarity(): { inverted: boolean; source: 'override' | 'detected' | 'assumed' } {
    if (this.options.invertMask !== undefined) {
      return { inverted: this.options.invertMask, source: 'override' };
    }
    if (this.invert !== undefined) return { inverted: this.invert === 1, source: 'detected' };
    return { inverted: true, source: 'assumed' };
  }

  /** False whenever image mode is requested but no image is actually loaded. */
  private usingImageBackground() {
    return this.options.mode === 'image' && !!this.imageTexture;
  }

  async init(opts: VideoProcessorOptions) {
    this.stopped = false;
    this.sourceTrack = opts.track;

    const settings = opts.track.getSettings();
    this.width = settings.width ?? 640;
    this.height = settings.height ?? 360;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    // Grab the context before MediaPipe does, so our attributes are the ones that
    // stick — a later getContext('webgl2') on the same canvas returns this object.
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    // Lets us sample MediaPipe's float mask with linear filtering where supported.
    gl.getExtension('OES_texture_float_linear');
    // Our own VAO, so the vertex state we set never lands in whatever VAO
    // MediaPipe happens to have bound (see resetGLState).
    this.vao = gl.createVertexArray()!;

    this.programs = {
      alpha: createProgram(gl, alphaFragmentShader, [
        'u_mask',
        'u_history',
        'u_invert',
        'u_lo',
        'u_hi',
        'u_history_weight',
      ] as const),
      gaussian: createProgram(gl, gaussianFragmentShader, ['u_texture', 'u_step'] as const),
      copy: createProgram(gl, copyFragmentShader, ['u_texture'] as const),
      // Only the composite flips Y; see the orientation note in mediapipeGL.ts.
      composite: createProgram(
        gl,
        compositeFragmentShader,
        [
          'u_frame',
          'u_background',
          'u_alpha',
          'u_background_scale',
          'u_background_offset',
          'u_swap_sides',
        ] as const,
        true,
      ),
    };
    gl.bindVertexArray(this.vao);
    this.quadBuffer = createQuadBuffer(gl);
    this.frameTexture = createTexture(gl);
    this.allocateTargets(this.width, this.height);

    await this.createSegmenter();
    if (this.options.mode === 'image' && this.options.imageUrl) {
      // A failed image must not stop the camera; blur is the fallback.
      await this.loadImage(this.options.imageUrl).catch((err) =>
        console.error('[mediapipe-bg]', err),
      );
    }
    this.startPipeline();
  }

  async restart(opts: VideoProcessorOptions) {
    this.stopPipeline();
    this.sourceTrack = opts.track;
    const settings = opts.track.getSettings();
    this.resize(settings.width ?? this.width, settings.height ?? this.height);
    this.startPipeline();
  }

  async destroy() {
    this.stopped = true;
    this.stopPipeline();

    await this.segmenter?.close();
    this.segmenter = undefined;

    const gl = this.gl;
    if (gl) {
      for (const target of [...this.matte, ...this.background]) deleteRenderTarget(gl, target);
      if (this.featherScratch) deleteRenderTarget(gl, this.featherScratch);
      if (this.feathered) deleteRenderTarget(gl, this.feathered);
      if (this.halfFrame) deleteRenderTarget(gl, this.halfFrame);
      if (this.imageTexture) gl.deleteTexture(this.imageTexture);
      if (this.frameTexture) gl.deleteTexture(this.frameTexture);
      if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.programs) {
        for (const entry of Object.values(this.programs)) gl.deleteProgram(entry.program);
      }
    }

    this.matte = [];
    this.background = [];
    this.featherScratch = undefined;
    this.feathered = undefined;
    this.halfFrame = undefined;
    this.imageTexture = undefined;
    this.loadedImageUrl = undefined;
    this.frameTexture = undefined;
    this.quadBuffer = undefined;
    this.vao = undefined;
    this.programs = undefined;
    this.gl = undefined;
    this.canvas = undefined;
    this.processedTrack = undefined;
  }

  // ---------------------------------------------------------------- MediaPipe

  private async createSegmenter() {
    const fileset = await FilesetResolver.forVisionTasks(
      this.options.assetPaths?.wasmFileSet ??
        `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`,
    );

    this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          this.options.assetPaths?.modelAssetPath ?? MODELS[this.options.quality],
        delegate: this.options.delegate,
      },
      canvas: this.canvas,
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      // Only consumed by the polarity fallback below; never read back once the
      // polarity is known, so leaving it on costs a texture we don't download.
      outputCategoryMask: true,
    });

    // Keep the label map for picking which mask to read. Deliberately do NOT
    // infer polarity from it: the binary selfie model lists a "background" label
    // yet hands back a single mask scoring the *subject*, so trusting the labels
    // here inverted the whole effect on that model.
    this.labels = this.segmenter.getLabels();
  }

  /**
   * Works out whether the confidence mask scores "background" or "subject".
   *
   * Both bundled models put background at category 0, and MediaPipe documents
   * confidenceMasks[i] as tracking category i — but the binary selfie model
   * ships no label map, so there is nothing to read that from at runtime.
   * Rather than trust a guess, measure it, with a second method to fall back on
   * so this cannot quietly give up and leave the effect inverted.
   */
  private detectPolarity(result: ImageSegmenterResult) {
    const confidenceMask = result.confidenceMasks?.[this.maskIndex];
    if (!confidenceMask) return;

    const confidences = confidenceMask.getAsFloat32Array();
    const width = confidenceMask.width;
    const height = confidenceMask.height;
    if (!confidences.length || width < 8 || height < 8) return;

    // Preferred: the category mask states outright which pixels are background,
    // so comparing the confidence values over each group settles it.
    const categoryMask = result.categoryMask;
    if (categoryMask) {
      const categories = categoryMask.getAsUint8Array();
      if (categories.length === confidences.length) {
        let backgroundSum = 0;
        let backgroundCount = 0;
        let subjectSum = 0;
        let subjectCount = 0;
        // Every 7th pixel is far more than enough for two means.
        for (let i = 0; i < categories.length; i += 7) {
          if (categories[i] === 0) {
            backgroundSum += confidences[i];
            backgroundCount += 1;
          } else {
            subjectSum += confidences[i];
            subjectCount += 1;
          }
        }
        const total = backgroundCount + subjectCount;
        // An all-person or all-background frame tells us nothing; wait for a better one.
        if (total > 0 && backgroundCount / total >= 0.05 && subjectCount / total >= 0.05) {
          this.invert = backgroundSum / backgroundCount > subjectSum / subjectCount ? 1 : 0;
          return;
        }
      }
    }

    // Fallback for a model with no category mask: in webcam framing the outer
    // border is background and the middle is the subject. Crude, but it only has
    // to answer which of two directions the mask reads.
    let borderSum = 0;
    let borderCount = 0;
    let centreSum = 0;
    let centreCount = 0;
    const borderX = Math.max(1, Math.floor(width * 0.08));
    const borderY = Math.max(1, Math.floor(height * 0.08));
    const centreX0 = Math.floor(width * 0.35);
    const centreX1 = Math.floor(width * 0.65);
    const centreY0 = Math.floor(height * 0.35);
    const centreY1 = Math.floor(height * 0.65);

    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const value = confidences[y * width + x];
        if (x < borderX || x >= width - borderX || y < borderY || y >= height - borderY) {
          borderSum += value;
          borderCount += 1;
        } else if (x >= centreX0 && x < centreX1 && y >= centreY0 && y < centreY1) {
          centreSum += value;
          centreCount += 1;
        }
      }
    }

    if (borderCount > 0 && centreCount > 0) {
      this.invert = borderSum / borderCount > centreSum / centreCount ? 1 : 0;
    }
  }

  // ----------------------------------------------------------------- Plumbing

  private startPipeline() {
    if (!this.sourceTrack || !this.canvas) return;

    const canUseInsertableStreams =
      typeof MediaStreamTrackGenerator !== 'undefined' &&
      typeof MediaStreamTrackProcessor !== 'undefined';

    if (canUseInsertableStreams) {
      this.streamProcessor = new MediaStreamTrackProcessor({
        track: this.sourceTrack as MediaStreamVideoTrack,
      });
      this.streamGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
      this.abortController = new AbortController();

      const transformer = new TransformStream<VideoFrame, VideoFrame>({
        transform: (frame, controller) => this.transform(frame, controller),
      });

      this.streamProcessor.readable
        .pipeThrough(transformer, { signal: this.abortController.signal })
        .pipeTo(this.streamGenerator.writable, { signal: this.abortController.signal })
        .catch((err) => {
          if (!this.stopped) console.error('[mediapipe-bg] pipeline error:', err);
        });

      this.processedTrack = this.streamGenerator as unknown as MediaStreamTrack;
      return;
    }

    // Safari / Firefox: no insertable streams, so pull frames off a hidden
    // <video> and publish the canvas via captureStream instead.
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([this.sourceTrack]);
    this.fallbackVideo = video;

    const frameRate = this.sourceTrack.getSettings().frameRate ?? 30;
    this.fallbackStream = this.canvas.captureStream(frameRate);
    this.processedTrack = this.fallbackStream.getVideoTracks()[0];

    void video
      .play()
      .then(() => this.scheduleFallbackFrame())
      .catch((err) => console.error('[mediapipe-bg] could not start fallback video:', err));
  }

  private scheduleFallbackFrame() {
    const video = this.fallbackVideo;
    if (!video || this.stopped) return;

    const render = () => {
      if (!this.fallbackVideo || this.stopped) return;
      try {
        if (video.videoWidth > 0) {
          this.resize(video.videoWidth, video.videoHeight);
          this.renderFrame(video);
        }
      } catch (err) {
        console.error('[mediapipe-bg] render error:', err);
      }
      this.scheduleFallbackFrame();
    };

    if ('requestVideoFrameCallback' in video) {
      this.fallbackHandle = video.requestVideoFrameCallback(() => render());
    } else {
      this.fallbackHandle = requestAnimationFrame(() => render());
    }
  }

  private stopPipeline() {
    this.abortController?.abort();
    this.abortController = undefined;
    this.streamProcessor = undefined;
    this.streamGenerator = undefined;

    if (this.fallbackVideo && this.fallbackHandle !== undefined) {
      if ('cancelVideoFrameCallback' in this.fallbackVideo) {
        this.fallbackVideo.cancelVideoFrameCallback(this.fallbackHandle);
      } else {
        cancelAnimationFrame(this.fallbackHandle);
      }
    }
    this.fallbackHandle = undefined;
    if (this.fallbackVideo) {
      this.fallbackVideo.srcObject = null;
      this.fallbackVideo = undefined;
    }
    this.fallbackStream?.getTracks().forEach((track) => track.stop());
    this.fallbackStream = undefined;
  }

  private transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
    let handedOff = false;
    try {
      if (frame.codedWidth === 0 || frame.codedHeight === 0 || this.stopped || !this.canvas) {
        controller.enqueue(frame);
        handedOff = true;
        return;
      }

      this.resize(frame.displayWidth, frame.displayHeight);
      this.renderFrame(frame);
      controller.enqueue(new VideoFrame(this.canvas, { timestamp: frame.timestamp }));
    } catch (err) {
      console.error('[mediapipe-bg] frame failed, passing it through:', err);
      if (!handedOff) {
        controller.enqueue(frame);
        handedOff = true;
      }
    } finally {
      if (!handedOff) frame.close();
    }
  }

  // ------------------------------------------------------------------- Render

  private resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0 || !this.canvas) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.allocateTargets(width, height);
  }

  private allocateTargets(width: number, height: number) {
    const gl = this.gl;
    if (!gl) return;

    for (const target of [...this.matte, ...this.background]) deleteRenderTarget(gl, target);
    if (this.featherScratch) deleteRenderTarget(gl, this.featherScratch);
    if (this.feathered) deleteRenderTarget(gl, this.feathered);
    if (this.halfFrame) deleteRenderTarget(gl, this.halfFrame);

    // Half resolution is plenty for a matte and keeps the feather passes cheap.
    const matteWidth = Math.max(64, Math.round(width / 2));
    const matteHeight = Math.max(64, Math.round(height / 2));
    // Quarter resolution for the background: it is about to be blurred anyway,
    // and this is where most of the blur cost would otherwise go.
    const bgWidth = Math.max(16, Math.round(width / 4));
    const bgHeight = Math.max(16, Math.round(height / 4));

    this.matte = [
      createRenderTarget(gl, matteWidth, matteHeight),
      createRenderTarget(gl, matteWidth, matteHeight),
    ];
    this.featherScratch = createRenderTarget(gl, matteWidth, matteHeight);
    this.feathered = createRenderTarget(gl, matteWidth, matteHeight);
    this.halfFrame = createRenderTarget(gl, matteWidth, matteHeight);
    this.background = [
      createRenderTarget(gl, bgWidth, bgHeight),
      createRenderTarget(gl, bgWidth, bgHeight),
    ];

    this.matteIndex = 0;
    this.hasMatteHistory = false;
  }

  /**
   * MediaPipe shares this WebGL context with us and leaves its own state behind —
   * most dangerously a bound VAO and UNPACK_FLIP_Y_WEBGL, which would silently
   * flip every frame we upload. Re-assert everything we depend on rather than
   * assuming any of it survived.
   */
  private resetGLState() {
    const gl = this.gl;
    if (!gl) return;
    gl.bindVertexArray(this.vao ?? null);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  private renderFrame(source: VideoFrame | HTMLVideoElement) {
    const gl = this.gl;
    const programs = this.programs;
    const quad = this.quadBuffer;
    if (!gl || !programs || !quad || !this.frameTexture || !this.feathered) return;

    this.resetGLState();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    this.updateMatte(source);

    this.resetGLState();
    if (!this.usingImageBackground()) this.blurBackground();
    this.composite();
  }

  private updateMatte(source: VideoFrame | HTMLVideoElement) {
    const gl = this.gl;
    const programs = this.programs;
    const segmenter = this.segmenter;
    if (!gl || !programs || !segmenter || !this.feathered || !this.featherScratch) return;

    // Throttle inference; in-between frames reuse the matte we already have.
    const now = performance.now();
    const minInterval = 1000 / Math.max(1, this.options.segmentationFps);
    if (this.hasMatteHistory && now - this.lastSegmentationMs < minInterval) return;
    this.lastSegmentationMs = now;

    // MediaPipe requires strictly increasing timestamps in VIDEO mode.
    const timestamp = Math.max(this.lastTimestampMs + 1, Math.round(now));
    this.lastTimestampMs = timestamp;

    // segmentForVideo is synchronous: the callback runs before it returns, and the
    // masks are only valid inside it.
    segmenter.segmentForVideo(source, timestamp, (result) => {
      try {
        const masks = result.confidenceMasks;
        if (!masks?.length) return;

        if (!this.maskIndexResolved) {
          // Labels line up with masks only when there is one mask per label; with
          // a single mask there is nothing to choose and index 0 is the answer.
          const backgroundIndex = this.labels.findIndex(
            (label) => label.toLowerCase() === 'background',
          );
          this.maskIndex =
            masks.length === this.labels.length && backgroundIndex >= 0 ? backgroundIndex : 0;
          this.maskIndexResolved = true;
        }

        const mask = masks[this.maskIndex];
        if (!mask) return;
        // Take the GPU texture before anything else: detectPolarity pulls the
        // masks down to CPU arrays, and we would rather not depend on MPMask
        // still being able to hand back a texture afterwards.
        this.composeMatte(mask.getAsWebGLTexture());
        if (this.invert === undefined) this.detectPolarity(result);
      } finally {
        result.close();
      }
    });
  }

  private composeMatte(maskTexture: WebGLTexture) {
    const gl = this.gl!;
    const programs = this.programs!;
    const quad = this.quadBuffer!;
    const scratch = this.featherScratch!;
    const feathered = this.feathered!;

    // We are inside MediaPipe's segmentation callback here, so its GL state is live.
    this.resetGLState();

    const write = this.matte[this.matteIndex];
    const history = this.matte[1 - this.matteIndex];

    // Pass 1 — confidence mask to alpha matte, blended with the previous frame.
    const alpha = programs.alpha;
    gl.useProgram(alpha.program);
    bindTextureUnit(gl, 0, maskTexture, alpha.uniforms.u_mask);
    bindTextureUnit(gl, 1, history.texture, alpha.uniforms.u_history);
    gl.uniform1f(alpha.uniforms.u_invert, this.resolvedInvert);
    // A wide ramp: only clip what is almost certainly background, only saturate
    // what is almost certainly body, and let everything between stay translucent.
    gl.uniform1f(alpha.uniforms.u_lo, 0.1);
    gl.uniform1f(alpha.uniforms.u_hi, 0.9);
    gl.uniform1f(
      alpha.uniforms.u_history_weight,
      this.hasMatteHistory ? Math.min(0.95, Math.max(0, this.options.temporalSmoothing)) : 0,
    );
    drawQuad(gl, quad, alpha.position, write, write.width, write.height);

    // Pass 2/3 — separable feather, so the silhouette hands over gradually.
    const featherTexels = Math.max(0.5, (this.options.edgeFeather / 2) * 0.5);
    const gaussian = programs.gaussian;
    gl.useProgram(gaussian.program);

    bindTextureUnit(gl, 0, write.texture, gaussian.uniforms.u_texture);
    gl.uniform2f(gaussian.uniforms.u_step, featherTexels / write.width, 0);
    drawQuad(gl, quad, gaussian.position, scratch, scratch.width, scratch.height);

    bindTextureUnit(gl, 0, scratch.texture, gaussian.uniforms.u_texture);
    gl.uniform2f(gaussian.uniforms.u_step, 0, featherTexels / scratch.height);
    drawQuad(gl, quad, gaussian.position, feathered, feathered.width, feathered.height);

    this.matteIndex = 1 - this.matteIndex;
    this.hasMatteHistory = true;
  }

  private blurBackground() {
    const gl = this.gl!;
    const programs = this.programs!;
    const quad = this.quadBuffer!;
    const [bufferA, bufferB] = this.background;
    if (!bufferA || !bufferB) return;

    // Downsample first — a quarter-size buffer makes the blur roughly 16x cheaper
    // and the reduction itself contributes to the softening. Go via half
    // resolution so each step is a clean bilinear 2x2 box; jumping straight to a
    // quarter would take one tap out of every 4x4 block and shimmer on detailed
    // backgrounds.
    const half = this.halfFrame;
    const copy = programs.copy;
    gl.useProgram(copy.program);
    bindTextureUnit(gl, 0, this.frameTexture!, copy.uniforms.u_texture);
    if (half) {
      drawQuad(gl, quad, copy.position, half, half.width, half.height);
      bindTextureUnit(gl, 0, half.texture, copy.uniforms.u_texture);
    }
    drawQuad(gl, quad, copy.position, bufferA, bufferA.width, bufferA.height);

    const sigma = Math.max(1, this.options.blurRadius / 4);
    const passes = Math.min(4, Math.max(1, Math.ceil(sigma / 4)));
    const spread = Math.max(0.5, sigma / passes / 2);

    const gaussian = programs.gaussian;
    gl.useProgram(gaussian.program);
    for (let i = 0; i < passes; i += 1) {
      bindTextureUnit(gl, 0, bufferA.texture, gaussian.uniforms.u_texture);
      gl.uniform2f(gaussian.uniforms.u_step, spread / bufferA.width, 0);
      drawQuad(gl, quad, gaussian.position, bufferB, bufferB.width, bufferB.height);

      bindTextureUnit(gl, 0, bufferB.texture, gaussian.uniforms.u_texture);
      gl.uniform2f(gaussian.uniforms.u_step, 0, spread / bufferB.height);
      drawQuad(gl, quad, gaussian.position, bufferA, bufferA.width, bufferA.height);
    }
  }

  private composite() {
    const gl = this.gl!;
    const programs = this.programs!;
    const quad = this.quadBuffer!;
    const composite = programs.composite;

    // Cover-fit the still image; the blurred frame already matches the output
    // aspect exactly, so it maps 1:1.
    const useImage = this.usingImageBackground();
    let scaleX = 1;
    let scaleY = 1;
    if (useImage) {
      const outputAspect = this.width / Math.max(1, this.height);
      if (this.imageAspect > outputAspect) {
        scaleX = outputAspect / this.imageAspect;
      } else {
        scaleY = this.imageAspect / outputAspect;
      }
    }

    gl.useProgram(composite.program);
    bindTextureUnit(gl, 0, this.frameTexture!, composite.uniforms.u_frame);
    bindTextureUnit(
      gl,
      1,
      useImage ? this.imageTexture! : this.background[0].texture,
      composite.uniforms.u_background,
    );
    bindTextureUnit(gl, 2, this.feathered!.texture, composite.uniforms.u_alpha);
    gl.uniform2f(composite.uniforms.u_background_scale, scaleX, scaleY);
    gl.uniform2f(composite.uniforms.u_background_offset, (1 - scaleX) / 2, (1 - scaleY) / 2);
    gl.uniform1f(composite.uniforms.u_swap_sides, this.options.target === 'subject' ? 1 : 0);
    drawQuad(gl, quad, composite.position, null, this.width, this.height);
  }
}

/** Convenience factory mirroring the `BackgroundBlur(...)` call shape. */
export function MediapipeBackgroundBlur(options: MediapipeBackgroundOptions = {}) {
  return new MediapipeBackgroundProcessor(options);
}
