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
 * The GPU half of the background effect: takes a camera frame and a segmentation mask, and
 * renders the blurred-or-replaced result onto its canvas. No segmentation, no streams, no DOM —
 * so the same code runs on the main thread (MediapipeBackgroundProcessor, on an
 * HTMLCanvasElement it shares with MediaPipe) and in a worker (backgroundCompositor.worker.ts, on
 * an OffscreenCanvas, with the mask arriving from a separate segmenter worker).
 *
 * Per frame: uploadFrame() -> optionally composeMatte*() when a fresh mask exists -> render().
 * Frames between masks reuse the last matte.
 */

export type BackgroundMode = 'blur' | 'image';

/** Which side of the matte the effect lands on. */
export type EffectTarget = 'background' | 'subject';

export interface MatteOptions {
  /** 1 when the mask scores background (the shader inverts it to get subject alpha). */
  invert: number;
  matteLo: number;
  matteHi: number;
  temporalSmoothing: number;
  edgeFeather: number;
}

export interface CompositeOptions {
  /** Image mode falls back to blur while no image is loaded. */
  mode: BackgroundMode;
  blurRadius: number;
  target: EffectTarget;
}

type Programs = {
  alpha: GLProgram<'u_mask' | 'u_history' | 'u_invert' | 'u_lo' | 'u_hi' | 'u_history_weight'>;
  gaussian: GLProgram<'u_texture' | 'u_step'>;
  copy: GLProgram<'u_texture'>;
  composite: GLProgram<
    'u_frame' | 'u_background' | 'u_alpha' | 'u_background_scale' | 'u_background_offset' | 'u_swap_sides'
  >;
};

export class BackgroundCompositor {
  readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly programs: Programs;
  private readonly quad: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly frameTexture: WebGLTexture;
  /** For masks handed over as images (the worker path); the main thread uses MediaPipe's texture directly. */
  private maskTexture?: WebGLTexture;
  /** Ping-pong pair holding the temporally smoothed matte. */
  private matte: RenderTarget[] = [];
  private matteIndex = 0;
  private featherScratch?: RenderTarget;
  private feathered?: RenderTarget;
  /** Half-resolution step on the way down to the background buffers. */
  private halfFrame?: RenderTarget;
  /** Ping-pong pair for the downsampled, blurred background. */
  private background: RenderTarget[] = [];
  /** Still image used in `image` mode, already uploaded to the GPU. */
  private imageTexture?: WebGLTexture;
  private imageAspect = 1;
  private matteHistory = false;
  width: number;
  height: number;

  /**
   * Takes the canvas's WebGL2 context itself, so on a canvas later shared with MediaPipe these
   * attributes are the ones that stick (a later getContext('webgl2') returns this same object).
   */
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    this.width = canvas.width;
    this.height = canvas.height;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
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
        ['u_frame', 'u_background', 'u_alpha', 'u_background_scale', 'u_background_offset', 'u_swap_sides'] as const,
        true,
      ),
    };
    gl.bindVertexArray(this.vao);
    this.quad = createQuadBuffer(gl);
    this.frameTexture = createTexture(gl);
    this.allocateTargets();
  }

  /** False until the first mask has been composed, and again after every resize. */
  get hasMatteHistory() {
    return this.matteHistory;
  }

  get hasImage() {
    return !!this.imageTexture;
  }

  /** Matches the canvas and every render target to a new frame size; drops the matte history. */
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.allocateTargets();
  }

  private allocateTargets() {
    const gl = this.gl;
    this.deleteTargets();

    // Half resolution is plenty for a matte and keeps the feather passes cheap.
    const matteWidth = Math.max(64, Math.round(this.width / 2));
    const matteHeight = Math.max(64, Math.round(this.height / 2));
    // Quarter resolution for the background: it is about to be blurred anyway,
    // and this is where most of the blur cost would otherwise go.
    const bgWidth = Math.max(16, Math.round(this.width / 4));
    const bgHeight = Math.max(16, Math.round(this.height / 4));

    this.matte = [createRenderTarget(gl, matteWidth, matteHeight), createRenderTarget(gl, matteWidth, matteHeight)];
    this.featherScratch = createRenderTarget(gl, matteWidth, matteHeight);
    this.feathered = createRenderTarget(gl, matteWidth, matteHeight);
    this.halfFrame = createRenderTarget(gl, matteWidth, matteHeight);
    this.background = [createRenderTarget(gl, bgWidth, bgHeight), createRenderTarget(gl, bgWidth, bgHeight)];

    this.matteIndex = 0;
    this.matteHistory = false;
  }

  private deleteTargets() {
    const gl = this.gl;
    for (const target of [...this.matte, ...this.background]) deleteRenderTarget(gl, target);
    if (this.featherScratch) deleteRenderTarget(gl, this.featherScratch);
    if (this.feathered) deleteRenderTarget(gl, this.feathered);
    if (this.halfFrame) deleteRenderTarget(gl, this.halfFrame);
    this.matte = [];
    this.background = [];
    this.featherScratch = undefined;
    this.feathered = undefined;
    this.halfFrame = undefined;
  }

  /**
   * MediaPipe shares the main-thread context with us and leaves its own state behind — most
   * dangerously a bound VAO and UNPACK_FLIP_Y_WEBGL, which would silently flip every frame we
   * upload. Re-assert everything we depend on rather than assuming any of it survived.
   */
  resetGLState() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  uploadFrame(source: TexImageSource) {
    const gl = this.gl;
    this.resetGLState();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /** Turns a confidence mask (read from .r) into the smoothed, feathered matte the composite uses. */
  composeMatte(maskTexture: WebGLTexture, options: MatteOptions) {
    const gl = this.gl;
    const { alpha, gaussian } = this.programs;
    const scratch = this.featherScratch!;
    const feathered = this.feathered!;
    // On the main thread this runs inside MediaPipe's segmentation callback, so its GL state is live.
    this.resetGLState();

    const write = this.matte[this.matteIndex];
    const history = this.matte[1 - this.matteIndex];

    // Pass 1 — confidence mask to alpha matte, blended with the previous frame.
    gl.useProgram(alpha.program);
    bindTextureUnit(gl, 0, maskTexture, alpha.uniforms.u_mask);
    bindTextureUnit(gl, 1, history.texture, alpha.uniforms.u_history);
    gl.uniform1f(alpha.uniforms.u_invert, options.invert);
    // A wide ramp: only clip what is almost certainly background, only saturate
    // what is almost certainly body, and let everything between stay translucent.
    gl.uniform1f(alpha.uniforms.u_lo, options.matteLo);
    gl.uniform1f(alpha.uniforms.u_hi, options.matteHi);
    gl.uniform1f(
      alpha.uniforms.u_history_weight,
      this.matteHistory ? Math.min(0.95, Math.max(0, options.temporalSmoothing)) : 0,
    );
    drawQuad(gl, this.quad, alpha.position, write, write.width, write.height);

    // Pass 2/3 — separable feather, so the silhouette hands over gradually.
    const featherTexels = Math.max(0.5, (options.edgeFeather / 2) * 0.5);
    gl.useProgram(gaussian.program);

    bindTextureUnit(gl, 0, write.texture, gaussian.uniforms.u_texture);
    gl.uniform2f(gaussian.uniforms.u_step, featherTexels / write.width, 0);
    drawQuad(gl, this.quad, gaussian.position, scratch, scratch.width, scratch.height);

    bindTextureUnit(gl, 0, scratch.texture, gaussian.uniforms.u_texture);
    gl.uniform2f(gaussian.uniforms.u_step, 0, featherTexels / scratch.height);
    drawQuad(gl, this.quad, gaussian.position, feathered, feathered.width, feathered.height);

    this.matteIndex = 1 - this.matteIndex;
    this.matteHistory = true;
  }

  /**
   * composeMatte for a mask that arrives as an image (an ImageBitmap from the segmenter worker,
   * mask in .r, image top row first like a camera frame). A GPU-backed bitmap uploads GPU-side.
   */
  composeMatteFromImage(mask: TexImageSource, options: MatteOptions) {
    const gl = this.gl;
    this.resetGLState();
    this.maskTexture ??= createTexture(gl);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
    this.composeMatte(this.maskTexture, options);
  }

  /** The still image for `image` mode (null clears it, which falls back to blur). */
  setImage(source: TexImageSource | null, aspect = 1) {
    const gl = this.gl;
    if (this.imageTexture) gl.deleteTexture(this.imageTexture);
    this.imageTexture = undefined;
    if (!source) return;
    const texture = createTexture(gl);
    this.resetGLState();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // Same unpack convention as the camera frame, so the single flip in the
    // composite pass puts both the right way up.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.imageTexture = texture;
    this.imageAspect = aspect;
  }

  /** Blurs (unless showing an image) and composites onto the canvas, from the last frame and matte. */
  render(options: CompositeOptions) {
    this.resetGLState();
    const useImage = options.mode === 'image' && !!this.imageTexture;
    if (!useImage) this.blurBackground(options.blurRadius);
    this.composite(useImage, options.target);
  }

  /** Paints the canvas black — for output that exists but must not be shown yet. */
  blank() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private blurBackground(blurRadius: number) {
    const gl = this.gl;
    const { copy, gaussian } = this.programs;
    const [bufferA, bufferB] = this.background;
    if (!bufferA || !bufferB) return;

    // Downsample first — a quarter-size buffer makes the blur roughly 16x cheaper
    // and the reduction itself contributes to the softening. Go via half
    // resolution so each step is a clean bilinear 2x2 box; jumping straight to a
    // quarter would take one tap out of every 4x4 block and shimmer on detailed
    // backgrounds.
    const half = this.halfFrame;
    gl.useProgram(copy.program);
    bindTextureUnit(gl, 0, this.frameTexture, copy.uniforms.u_texture);
    if (half) {
      drawQuad(gl, this.quad, copy.position, half, half.width, half.height);
      bindTextureUnit(gl, 0, half.texture, copy.uniforms.u_texture);
    }
    drawQuad(gl, this.quad, copy.position, bufferA, bufferA.width, bufferA.height);

    const sigma = Math.max(1, blurRadius / 4);
    const passes = Math.min(4, Math.max(1, Math.ceil(sigma / 4)));
    const spread = Math.max(0.5, sigma / passes / 2);

    gl.useProgram(gaussian.program);
    for (let i = 0; i < passes; i += 1) {
      bindTextureUnit(gl, 0, bufferA.texture, gaussian.uniforms.u_texture);
      gl.uniform2f(gaussian.uniforms.u_step, spread / bufferA.width, 0);
      drawQuad(gl, this.quad, gaussian.position, bufferB, bufferB.width, bufferB.height);

      bindTextureUnit(gl, 0, bufferB.texture, gaussian.uniforms.u_texture);
      gl.uniform2f(gaussian.uniforms.u_step, 0, spread / bufferB.height);
      drawQuad(gl, this.quad, gaussian.position, bufferA, bufferA.width, bufferA.height);
    }
  }

  private composite(useImage: boolean, target: EffectTarget) {
    const gl = this.gl;
    const composite = this.programs.composite;

    // Cover-fit the still image; the blurred frame already matches the output
    // aspect exactly, so it maps 1:1.
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
    bindTextureUnit(gl, 0, this.frameTexture, composite.uniforms.u_frame);
    bindTextureUnit(gl, 1, useImage ? this.imageTexture! : this.background[0].texture, composite.uniforms.u_background);
    bindTextureUnit(gl, 2, this.feathered!.texture, composite.uniforms.u_alpha);
    gl.uniform2f(composite.uniforms.u_background_scale, scaleX, scaleY);
    gl.uniform2f(composite.uniforms.u_background_offset, (1 - scaleX) / 2, (1 - scaleY) / 2);
    gl.uniform1f(composite.uniforms.u_swap_sides, target === 'subject' ? 1 : 0);
    drawQuad(gl, this.quad, composite.position, null, this.width, this.height);
  }

  destroy() {
    const gl = this.gl;
    this.deleteTargets();
    if (this.imageTexture) gl.deleteTexture(this.imageTexture);
    if (this.maskTexture) gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.frameTexture);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    for (const entry of Object.values(this.programs)) gl.deleteProgram(entry.program);
    this.imageTexture = undefined;
    this.maskTexture = undefined;
  }
}
