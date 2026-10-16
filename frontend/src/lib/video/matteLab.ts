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
import { copyFragmentShader, gaussianFragmentShader } from './mediapipeShaders';
import { fusedKernel } from './matteStyle';

/**
 * Experimental matte pipeline for /dev/matte-lab — NOT used by the app.
 *
 * The production matte (backgroundCompositor.composeMatte) is: sample the model's low-resolution
 * mask bilinearly, steepen it with lo/hi, blend with last frame, then feather at matte resolution.
 * On the 256x144 'balanced' model that leaves visible stair-steps, because the feather is far
 * narrower than one mask pixel. This file makes each of those stages a parameter so they can be
 * compared side by side (two pipelines, A and B, fed the same mask) and timed on the GPU:
 *
 *   mask (R8, model resolution)
 *     -> [maskBlur]    gaussian at the mask's OWN resolution (tiny: 256x144) — blur BEFORE steepening
 *     -> [interpolation] bilinear | cubic B-spline | smoothstep, while upsampling to matte resolution
 *     -> lo/hi steepening + temporal blend with history (one pass)
 *     -> [postFeather] the production-style feather at matte resolution (0 = skip both passes)
 *
 * Edge modes:
 *  - 'ramp' (production): the matte holds alpha = linear lo/hi remap of the upsampled mask.
 *  - 'contour': the matte holds the smooth upsampled confidence FIELD, un-thresholded; the composite
 *    cuts it at `contourThreshold` with an anti-aliased step whose width comes from fwidth() (the
 *    SDF-font trick). The edge is the field's iso-line — a smooth curve when the field is upsampled
 *    with a smooth kernel (bicubic) — and stays sharp instead of being blurred. Cost: the same one
 *    matte pass, plus a few ALU ops (no extra texture fetches) in the composite.
 *
 * Production behaviour = ramp, bilinear, maskBlur 0, postFeather 0.5. Same GL conventions as
 * mediapipeGL.ts: intermediate passes keep orientation, only the final composite flips Y.
 */

/** 'fused' = blur + upsample in the one matte pass (see fusedKernel); maskBlur is its strength. */
export type Interpolation = 'bilinear' | 'bicubic' | 'hermite' | 'fused';
export type PipelineId = 'a' | 'b';
export type BackgroundKind = 'blur' | 'green' | 'white' | 'black';

export type EdgeMode = 'ramp' | 'contour';

export interface MatteLabParams {
  edgeMode: EdgeMode;
  interpolation: Interpolation;
  /** Gaussian spread at mask resolution, in mask pixels. 0 = off. */
  maskBlur: number;
  /** Gaussian step at matte resolution, in matte texels (production = 0.5). 0 = off. */
  postFeather: number;
  matteLo: number;
  matteHi: number;
  temporalSmoothing: number;
  /** contour: where the edge sits on the confidence field. */
  contourThreshold: number;
  /** contour: anti-aliasing width of the edge, in output pixels. */
  contourSoftness: number;
  /** Matte resolution as a fraction of the frame. */
  matteScale: 1 | 0.5 | 0.25;
}

export interface RenderOptions {
  params: Record<PipelineId, MatteLabParams>;
  view: 'result' | 'matte';
  /** Screen-x fraction: left of it shows pipeline A, right of it pipeline B. 0 = B only, 1 = A only. */
  split: number;
  zoom: number;
  center: [number, number];
  background: BackgroundKind;
}

export interface PipelineStats {
  /** Mean GPU time of the whole matte stage per mask update; null when the timer query is unavailable. */
  gpuMs: number | null;
  samples: number;
  passes: number;
  matteSize: [number, number];
  maskSize: [number, number];
}

const INTERP_CODE: Record<Interpolation, number> = { bilinear: 0, bicubic: 1, hermite: 2, fused: 3 };

// The 'fused' kernel (4x4 bilinear taps, variance-matched to a separate blur) is shared with production.

/** Production's alpha pass plus a selectable way to upsample the mask. */
const alphaShader = `#version 300 es
precision highp float;
in vec2 texCoords;

uniform sampler2D u_mask;
uniform sampler2D u_history;
uniform float u_invert;
uniform float u_lo;
uniform float u_hi;
uniform float u_history_weight;
uniform int u_interp; // 0 bilinear, 1 cubic B-spline (4 bilinear taps), 2 smoothstep, 3 fused blur (16 taps)
uniform vec2 u_fused;  // fused: x = tap spacing in mask px, y = outer tap weight per axis
uniform float u_contour; // 1 = store the raw field (the composite thresholds it), 0 = lo/hi ramp here

out vec4 fragColor;

float sampleMask(vec2 uv) {
  if (u_interp == 0) return texture(u_mask, uv).r;
  vec2 size = vec2(textureSize(u_mask, 0));
  if (u_interp == 3) {
    // Blur and upsample in one go: a 4x4 grid of bilinear taps around the sample point.
    vec2 tapStep = u_fused.x / size;
    float outer = u_fused.y;
    float inner = 0.5 - outer;
    vec4 offsets = vec4(-1.5, -0.5, 0.5, 1.5);
    vec4 weights = vec4(outer, inner, inner, outer);
    float sum = 0.0;
    for (int y = 0; y < 4; y++) {
      float row = 0.0;
      for (int x = 0; x < 4; x++) {
        row += weights[x] * texture(u_mask, uv + vec2(offsets[x], offsets[y]) * tapStep).r;
      }
      sum += weights[y] * row;
    }
    return sum;
  }
  vec2 p = uv * size - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  if (u_interp == 2) {
    // Hardware lerps between texel i and i+1 by the weight we hand it: bend that weight into an S.
    vec2 s = f * f * (3.0 - 2.0 * f);
    return texture(u_mask, (i + 0.5 + s) / size).r;
  }
  // Cubic B-spline folded into 4 bilinear fetches (Sigg & Hadwiger). Smooths slightly, never rings.
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / size;
  vec2 h1 = (i + 1.0 + w3 / g1 + 0.5) / size;
  float t00 = texture(u_mask, vec2(h0.x, h0.y)).r;
  float t10 = texture(u_mask, vec2(h1.x, h0.y)).r;
  float t01 = texture(u_mask, vec2(h0.x, h1.y)).r;
  float t11 = texture(u_mask, vec2(h1.x, h1.y)).r;
  return g0.y * (g0.x * t00 + g1.x * t10) + g1.y * (g0.x * t01 + g1.x * t11);
}

void main() {
  float confidence = sampleMask(texCoords);
  float alpha = mix(confidence, 1.0 - confidence, u_invert);
  float ramp = clamp((alpha - u_lo) / max(1e-4, u_hi - u_lo), 0.0, 1.0);
  alpha = mix(ramp, alpha, u_contour);

  float previous = texture(u_history, texCoords).r;
  float motion = abs(alpha - previous);
  float weight = u_history_weight * (1.0 - smoothstep(0.04, 0.30, motion));
  alpha = mix(alpha, previous, weight);

  fragColor = vec4(alpha, alpha, alpha, 1.0);
}`;

/** Two matte pipelines in one image (split at u_split), with zoom, a solid-colour background option and a matte view. */
const labCompositeShader = `#version 300 es
precision highp float;
in vec2 texCoords;

uniform sampler2D u_frame;
uniform sampler2D u_background;
uniform sampler2D u_alpha_a;
uniform sampler2D u_alpha_b;
uniform vec3 u_bg_color;
uniform float u_use_color;
uniform float u_view;   // 0 = composited result, 1 = the matte itself
uniform float u_split;
uniform vec2 u_center;
uniform float u_zoom;
// Per pipeline: x = contour mode (0/1), y = threshold, z = softness in output pixels.
uniform vec3 u_edge_a;
uniform vec3 u_edge_b;

out vec4 fragColor;

// contour: anti-aliased cut of the field at its iso-line. fwidth is per *screen* pixel; times the
// zoom makes it per *output* pixel, so a zoomed view shows the edge as the real output would have it.
float shape(float field, float fieldWidth, vec3 edge) {
  float halfWidth = max(fieldWidth * u_zoom * edge.z * 0.5, 1e-4);
  float contour = smoothstep(edge.y - halfWidth, edge.y + halfWidth, field);
  return mix(field, contour, edge.x);
}

void main() {
  vec2 uv = u_center + (texCoords - 0.5) / u_zoom;
  float fieldA = texture(u_alpha_a, uv).r;
  float fieldB = texture(u_alpha_b, uv).r;
  // Derivatives taken before any branching (they need uniform control flow).
  float alphaA = shape(fieldA, fwidth(fieldA), u_edge_a);
  float alphaB = shape(fieldB, fwidth(fieldB), u_edge_b);
  float alpha = clamp(texCoords.x < u_split ? alphaA : alphaB, 0.0, 1.0);

  vec3 color;
  if (u_view > 0.5) {
    color = vec3(alpha);
  } else {
    vec3 foreground = texture(u_frame, uv).rgb;
    vec3 background = mix(texture(u_background, uv).rgb, u_bg_color, u_use_color);
    color = mix(background, foreground, alpha);
  }
  if (u_split > 0.0 && u_split < 1.0 && abs(texCoords.x - u_split) < 0.0015) color = vec3(1.0, 0.25, 0.25);
  fragColor = vec4(color, 1.0);
}`;

type Programs = {
  alpha: GLProgram<
    | 'u_mask'
    | 'u_history'
    | 'u_invert'
    | 'u_lo'
    | 'u_hi'
    | 'u_history_weight'
    | 'u_interp'
    | 'u_fused'
    | 'u_contour'
  >;
  gaussian: GLProgram<'u_texture' | 'u_step'>;
  copy: GLProgram<'u_texture'>;
  composite: GLProgram<
    | 'u_frame'
    | 'u_background'
    | 'u_alpha_a'
    | 'u_alpha_b'
    | 'u_bg_color'
    | 'u_use_color'
    | 'u_view'
    | 'u_split'
    | 'u_center'
    | 'u_zoom'
    | 'u_edge_a'
    | 'u_edge_b'
  >;
};

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

const MAX_TIMER_SAMPLES = 120;
const MAX_PENDING_QUERIES = 8;

interface PipelineState {
  key: string;
  matte: RenderTarget[];
  index: number;
  history: boolean;
  scratch?: RenderTarget;
  feathered?: RenderTarget;
  maskA?: RenderTarget;
  maskB?: RenderTarget;
  result?: RenderTarget;
  pending: WebGLQuery[];
  samples: number[];
  passes: number;
}

const newState = (): PipelineState => ({
  key: '',
  matte: [],
  index: 0,
  history: false,
  pending: [],
  samples: [],
  passes: 0,
});

export class MatteLab {
  readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly programs: Programs;
  private readonly quad: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly frameTexture: WebGLTexture;
  private readonly maskTexture: WebGLTexture;
  private readonly blankTexture: WebGLTexture;
  private readonly timer: TimerExt | null;
  private halfFrame?: RenderTarget;
  private background: RenderTarget[] = [];
  private readonly states: Record<PipelineId, PipelineState> = { a: newState(), b: newState() };
  private lastWritten?: RenderTarget;
  private readonly syncPixel = new Uint8Array(4);
  private maskWidth = 0;
  private maskHeight = 0;
  invert = 0;
  width: number;
  height: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.width = canvas.width;
    this.height = canvas.height;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quad = createQuadBuffer(gl);
    this.programs = {
      alpha: createProgram(gl, alphaShader, [
        'u_mask',
        'u_history',
        'u_invert',
        'u_lo',
        'u_hi',
        'u_history_weight',
        'u_interp',
        'u_fused',
        'u_contour',
      ] as const),
      gaussian: createProgram(gl, gaussianFragmentShader, ['u_texture', 'u_step'] as const),
      copy: createProgram(gl, copyFragmentShader, ['u_texture'] as const),
      composite: createProgram(
        gl,
        labCompositeShader,
        [
          'u_frame',
          'u_background',
          'u_alpha_a',
          'u_alpha_b',
          'u_bg_color',
          'u_use_color',
          'u_view',
          'u_split',
          'u_center',
          'u_zoom',
          'u_edge_a',
          'u_edge_b',
        ] as const,
        true,
      ),
    };
    this.frameTexture = createTexture(gl);
    this.maskTexture = createTexture(gl);
    this.blankTexture = createTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, this.blankTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.allocateBackground();
  }

  /** GPU name for labelling results from other machines (unmasked where the browser allows it). */
  get renderer(): string {
    const gl = this.gl;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }

  get timerSupported() {
    return !!this.timer;
  }

  get hasMask() {
    return this.maskWidth > 0;
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    if (width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.allocateBackground();
  }

  private allocateBackground() {
    const gl = this.gl;
    if (this.halfFrame) deleteRenderTarget(gl, this.halfFrame);
    for (const target of this.background) deleteRenderTarget(gl, target);
    const half = [Math.max(64, Math.round(this.width / 2)), Math.max(64, Math.round(this.height / 2))] as const;
    const quarter = [Math.max(16, Math.round(this.width / 4)), Math.max(16, Math.round(this.height / 4))] as const;
    this.halfFrame = createRenderTarget(gl, half[0], half[1]);
    this.background = [createRenderTarget(gl, quarter[0], quarter[1]), createRenderTarget(gl, quarter[0], quarter[1])];
  }

  private resetGLState() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  uploadFrame(source: TexImageSource) {
    const gl = this.gl;
    this.resetGLState();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  /** The mask as 8-bit values (what the worker pipeline's RGBA8 ImageBitmap carries), top row first. */
  uploadMask(data: Uint8Array, width: number, height: number, invert: number) {
    const gl = this.gl;
    this.resetGLState();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.maskWidth = width;
    this.maskHeight = height;
    this.invert = invert;
  }

  private deletePipelineTargets(state: PipelineState) {
    const gl = this.gl;
    for (const target of [...state.matte, state.scratch, state.feathered, state.maskA, state.maskB]) {
      if (target) deleteRenderTarget(gl, target);
    }
    state.matte = [];
    state.scratch = state.feathered = state.maskA = state.maskB = state.result = undefined;
  }

  private ensureAllocated(state: PipelineState, params: MatteLabParams) {
    const matteWidth = Math.max(16, Math.round(this.width * params.matteScale));
    const matteHeight = Math.max(16, Math.round(this.height * params.matteScale));
    const key = `${matteWidth}x${matteHeight}|${this.maskWidth}x${this.maskHeight}`;
    if (state.key === key) return;
    const gl = this.gl;
    this.deletePipelineTargets(state);
    state.matte = [
      createRenderTarget(gl, matteWidth, matteHeight),
      createRenderTarget(gl, matteWidth, matteHeight),
    ];
    state.scratch = createRenderTarget(gl, matteWidth, matteHeight);
    state.feathered = createRenderTarget(gl, matteWidth, matteHeight);
    state.maskA = createRenderTarget(gl, this.maskWidth, this.maskHeight);
    state.maskB = createRenderTarget(gl, this.maskWidth, this.maskHeight);
    state.index = 0;
    state.history = false;
    state.samples = [];
    state.key = key;
  }

  /** Runs one pipeline's matte stage on the last uploaded mask. */
  computeMatte(id: PipelineId, params: MatteLabParams, timed = true) {
    if (!this.hasMask) return;
    const gl = this.gl;
    const state = this.states[id];
    const { alpha, gaussian } = this.programs;
    this.resetGLState();
    this.ensureAllocated(state, params);

    let query: WebGLQuery | null = null;
    if (timed && this.timer && state.pending.length < MAX_PENDING_QUERIES) {
      query = gl.createQuery();
      gl.beginQuery(this.timer.TIME_ELAPSED_EXT, query!);
    }

    let passes = 0;
    let maskSource = this.maskTexture;
    if (params.maskBlur > 0 && params.interpolation !== 'fused') {
      const { maskA, maskB } = state;
      gl.useProgram(gaussian.program);
      bindTextureUnit(gl, 0, maskSource, gaussian.uniforms.u_texture);
      gl.uniform2f(gaussian.uniforms.u_step, params.maskBlur / this.maskWidth, 0);
      drawQuad(gl, this.quad, gaussian.position, maskA!, maskA!.width, maskA!.height);
      bindTextureUnit(gl, 0, maskA!.texture, gaussian.uniforms.u_texture);
      gl.uniform2f(gaussian.uniforms.u_step, 0, params.maskBlur / this.maskHeight);
      drawQuad(gl, this.quad, gaussian.position, maskB!, maskB!.width, maskB!.height);
      maskSource = maskB!.texture;
      passes += 2;
    }

    const write = state.matte[state.index];
    const history = state.matte[1 - state.index];
    gl.useProgram(alpha.program);
    bindTextureUnit(gl, 0, maskSource, alpha.uniforms.u_mask);
    bindTextureUnit(gl, 1, history.texture, alpha.uniforms.u_history);
    gl.uniform1f(alpha.uniforms.u_invert, this.invert);
    gl.uniform1f(alpha.uniforms.u_lo, params.matteLo);
    gl.uniform1f(alpha.uniforms.u_hi, params.matteHi);
    gl.uniform1f(
      alpha.uniforms.u_history_weight,
      state.history ? Math.min(0.95, Math.max(0, params.temporalSmoothing)) : 0,
    );
    gl.uniform1i(alpha.uniforms.u_interp, INTERP_CODE[params.interpolation]);
    const fused = fusedKernel(params.maskBlur);
    gl.uniform2f(alpha.uniforms.u_fused, fused.spacing, fused.outer);
    gl.uniform1f(alpha.uniforms.u_contour, params.edgeMode === 'contour' ? 1 : 0);
    drawQuad(gl, this.quad, alpha.position, write, write.width, write.height);
    passes += 1;

    let result = write;
    if (params.postFeather > 0) {
      const { scratch, feathered } = state;
      gl.useProgram(gaussian.program);
      bindTextureUnit(gl, 0, write.texture, gaussian.uniforms.u_texture);
      gl.uniform2f(gaussian.uniforms.u_step, params.postFeather / write.width, 0);
      drawQuad(gl, this.quad, gaussian.position, scratch!, scratch!.width, scratch!.height);
      bindTextureUnit(gl, 0, scratch!.texture, gaussian.uniforms.u_texture);
      gl.uniform2f(gaussian.uniforms.u_step, 0, params.postFeather / scratch!.height);
      drawQuad(gl, this.quad, gaussian.position, feathered!, feathered!.width, feathered!.height);
      result = feathered!;
      passes += 2;
    }

    if (query) {
      gl.endQuery(this.timer!.TIME_ELAPSED_EXT);
      state.pending.push(query);
    }
    state.result = result;
    this.lastWritten = result;
    state.passes = passes;
    state.index = 1 - state.index;
    state.history = true;
  }

  /** Collects finished GPU timer queries; call once per animation frame. */
  pollTimers() {
    const timer = this.timer;
    if (!timer) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
    for (const state of Object.values(this.states)) {
      while (state.pending.length > 0) {
        const query = state.pending[0];
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
        state.pending.shift();
        if (!disjoint) {
          state.samples.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6);
          if (state.samples.length > MAX_TIMER_SAMPLES) state.samples.shift();
        }
        gl.deleteQuery(query);
      }
    }
  }

  stats(id: PipelineId): PipelineStats {
    const state = this.states[id];
    const samples = state.samples;
    const first = state.matte[0];
    return {
      gpuMs: this.timer && samples.length > 0 ? samples.reduce((sum, v) => sum + v, 0) / samples.length : null,
      samples: samples.length,
      passes: state.passes,
      matteSize: first ? [first.width, first.height] : [0, 0],
      maskSize: [this.maskWidth, this.maskHeight],
    };
  }

  /** Same background as production at blurRadius 16: half-size copy, quarter-size copy, one separable gaussian. */
  private blurBackground() {
    const gl = this.gl;
    const { copy, gaussian } = this.programs;
    const half = this.halfFrame!;
    const [bufferA, bufferB] = this.background;
    gl.useProgram(copy.program);
    bindTextureUnit(gl, 0, this.frameTexture, copy.uniforms.u_texture);
    drawQuad(gl, this.quad, copy.position, half, half.width, half.height);
    bindTextureUnit(gl, 0, half.texture, copy.uniforms.u_texture);
    drawQuad(gl, this.quad, copy.position, bufferA, bufferA.width, bufferA.height);
    gl.useProgram(gaussian.program);
    bindTextureUnit(gl, 0, bufferA.texture, gaussian.uniforms.u_texture);
    gl.uniform2f(gaussian.uniforms.u_step, 2 / bufferA.width, 0);
    drawQuad(gl, this.quad, gaussian.position, bufferB, bufferB.width, bufferB.height);
    bindTextureUnit(gl, 0, bufferB.texture, gaussian.uniforms.u_texture);
    gl.uniform2f(gaussian.uniforms.u_step, 0, 2 / bufferB.height);
    drawQuad(gl, this.quad, gaussian.position, bufferA, bufferA.width, bufferA.height);
  }

  render(options: RenderOptions) {
    const gl = this.gl;
    const { composite } = this.programs;
    this.resetGLState();
    if (options.background === 'blur') this.blurBackground();

    const solid: Record<Exclude<BackgroundKind, 'blur'>, [number, number, number]> = {
      green: [0, 0.8, 0.2],
      white: [1, 1, 1],
      black: [0, 0, 0],
    };
    const color = options.background === 'blur' ? [0, 0, 0] : solid[options.background];

    gl.useProgram(composite.program);
    bindTextureUnit(gl, 0, this.frameTexture, composite.uniforms.u_frame);
    bindTextureUnit(gl, 1, this.background[0].texture, composite.uniforms.u_background);
    bindTextureUnit(gl, 2, this.states.a.result?.texture ?? this.blankTexture, composite.uniforms.u_alpha_a);
    bindTextureUnit(gl, 3, this.states.b.result?.texture ?? this.blankTexture, composite.uniforms.u_alpha_b);
    gl.uniform3f(composite.uniforms.u_bg_color, color[0], color[1], color[2]);
    gl.uniform1f(composite.uniforms.u_use_color, options.background === 'blur' ? 0 : 1);
    gl.uniform1f(composite.uniforms.u_view, options.view === 'matte' ? 1 : 0);
    gl.uniform1f(composite.uniforms.u_split, options.split);
    gl.uniform2f(composite.uniforms.u_center, options.center[0], options.center[1]);
    gl.uniform1f(composite.uniforms.u_zoom, options.zoom);
    for (const id of ['a', 'b'] as const) {
      const p = options.params[id];
      gl.uniform3f(
        id === 'a' ? composite.uniforms.u_edge_a : composite.uniforms.u_edge_b,
        p.edgeMode === 'contour' ? 1 : 0,
        p.contourThreshold,
        p.contourSoftness,
      );
    }
    drawQuad(gl, this.quad, composite.position, null, this.width, this.height);
  }

  /**
   * Blocks until the GPU has finished everything issued so far, by reading one pixel of the last
   * matte written (a readback has to wait for the work that produced it). For the burst benchmark.
   */
  finish() {
    const gl = this.gl;
    const target = this.lastWritten ?? this.halfFrame!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** A GPU timer query around caller-chosen work (the benchmark's bursts). Null when unsupported. */
  beginTimer(): WebGLQuery | null {
    if (!this.timer) return null;
    const query = this.gl.createQuery();
    this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, query);
    return query;
  }

  endTimer() {
    if (this.timer) this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
  }

  /** ms, or 'pending' while the GPU hasn't reported it, or null if it was disjoint (unusable). */
  readTimer(query: WebGLQuery): number | 'pending' | null {
    const gl = this.gl;
    if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) return 'pending';
    const disjoint = gl.getParameter(this.timer!.GPU_DISJOINT_EXT);
    const ms = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
    gl.deleteQuery(query);
    return disjoint ? null : ms;
  }

  destroy() {
    const gl = this.gl;
    for (const state of Object.values(this.states)) {
      this.deletePipelineTargets(state);
      for (const query of state.pending) gl.deleteQuery(query);
      state.pending = [];
    }
    if (this.halfFrame) deleteRenderTarget(gl, this.halfFrame);
    for (const target of this.background) deleteRenderTarget(gl, target);
    gl.deleteTexture(this.frameTexture);
    gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.blankTexture);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    for (const entry of Object.values(this.programs)) gl.deleteProgram(entry.program);
  }
}
