/**
 * SPIKE (blur lab only, not used by the app): the background blur pipeline of
 * MediapipeBackgroundProcessor, moved into a dedicated worker, to find out before committing to
 * the real refactor whether
 *   1. tasks-vision's ImageSegmenter runs in a module worker on an OffscreenCanvas with the GPU
 *      delegate at all,
 *   2. it costs the same as the main-thread version (same shaders, same passes, same order), and
 *   3. the multi-second model load / first-inference stall stops freezing the page.
 *
 * Frames never touch the main thread: the camera's MediaStreamTrackProcessor.readable and the
 * output MediaStreamTrackGenerator.writable are both transferred here. Blur mode only; the
 * still-image background, perf callbacks and stability logging are left out on purpose.
 *
 * Two ways to get the matte:
 *  - 'inline': the segmenter lives in this worker, exactly like the main-thread processor.
 *  - 'external': a separate segmenter worker (backgroundSegmenterSpike.worker.ts) attached over
 *    a MessagePort. This worker never waits for it — it keeps compositing every frame with the
 *    latest matte, and asks for a new one only when the previous request has come back. That is
 *    what lets the model be swapped (attach a new, already-warm segmenter) without the output
 *    ever pausing.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
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
import { alphaFragmentShader, compositeFragmentShader, copyFragmentShader, gaussianFragmentShader } from './mediapipeShaders';
import type { SegmentRequest, SegmentResult } from './backgroundSegmenterSpike.worker';

export interface SpikeOptions {
  segmentationFps: number;
  segmentationScheduler: 'interval' | 'exact';
  measureGpuSync: boolean;
  delegate: 'GPU' | 'CPU';
  blurRadius: number;
  temporalSmoothing: number;
  edgeFeather: number;
  matteLo: number;
  matteHi: number;
  invert: number;
}

export type SpikeRequest =
  | {
      type: 'init';
      readable: ReadableStream<VideoFrame>;
      writable: WritableStream<VideoFrame>;
      width: number;
      height: number;
      segmentation: 'inline' | 'external';
      wasmBase: string;
      /** 'inline' only. Model bytes (copied from the page's shared download), or a URL for models the app doesn't ship. */
      model?: { buffer: ArrayBuffer } | { url: string };
      options: SpikeOptions;
    }
  /** 'external' only: start (or switch to) getting mattes from this segmenter worker's port. */
  | { type: 'attachSegmenter'; port: MessagePort }
  | { type: 'snapshot'; id: number }
  | { type: 'stop' };

export type SpikeLoadTimings = {
  filesetMs?: number;
  modelFetchMs?: number;
  createSegmenterMs?: number;
  firstSegmentationMs?: number;
};

export type SpikeResponse =
  | { type: 'loaded'; loadTimings: SpikeLoadTimings }
  | { type: 'firstSegmentation'; ms: number }
  | { type: 'ready' }
  | { type: 'snapshot'; id: number; data: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

type Programs = {
  alpha: GLProgram<'u_mask' | 'u_history' | 'u_invert' | 'u_lo' | 'u_hi' | 'u_history_weight'>;
  gaussian: GLProgram<'u_texture' | 'u_step'>;
  copy: GLProgram<'u_texture'>;
  composite: GLProgram<
    'u_frame' | 'u_background' | 'u_alpha' | 'u_background_scale' | 'u_background_offset' | 'u_swap_sides'
  >;
};

const REQUIRED_STABLE_FRAMES = 5;

const post = (message: SpikeResponse) => self.postMessage(message);

let options: SpikeOptions;
let canvas: OffscreenCanvas;
let gl: WebGL2RenderingContext;
let programs: Programs;
let vao: WebGLVertexArrayObject;
let quad: WebGLBuffer;
let frameTexture: WebGLTexture;
let matte: RenderTarget[] = [];
let matteIndex = 0;
let featherScratch: RenderTarget | undefined;
let feathered: RenderTarget | undefined;
let halfFrame: RenderTarget | undefined;
let background: RenderTarget[] = [];
let segmenter: ImageSegmenter | undefined;
let labels: string[] = [];
let maskIndex = 0;
let maskIndexResolved = false;
let width = 0;
let height = 0;
let hasMatteHistory = false;
let lastSegmentationMs = 0;
let segmentationCredit = 0;
let lastSchedulerAt = 0;
let lastTimestampMs = 0;
let stableFrameCount = 0;
let ready = false;
let firstSegmentationReported = false;
let stopped = false;
let abortController: AbortController | undefined;

// 'external' segmentation.
let segmenterPort: MessagePort | undefined;
let requestInFlight = false;
let maskTexture: WebGLTexture | undefined;
let diagWorkMsTotal = 0;
let diagCompositeMsTotal = 0;
let diagLatencyMsTotal = 0;
let diagSegmenterSwitches = 0;

// Same counters (and reset-on-read semantics) as MediapipeBackgroundProcessor.takePerfSnapshot.
let diagFrames = 0;
let diagFrameMsTotal = 0;
let diagFrameMsMax = 0;
let diagSegmentations = 0;
let diagSegmentMsTotal = 0;
let diagSegmentMsMax = 0;
let diagLastReadAt = 0;

function takePerfSnapshot(): Record<string, unknown> {
  const now = performance.now();
  const seconds = diagLastReadAt ? (now - diagLastReadAt) / 1000 : undefined;
  const avg = (total: number, count: number) => (count ? Math.round((total / count) * 100) / 100 : undefined);
  const external = !!maskTexture;
  const data = {
    path: external ? 'worker-split' : 'worker',
    delegate: options?.delegate,
    fps: seconds ? Math.round((diagFrames / seconds) * 10) / 10 : undefined,
    frameMsAvg: avg(diagFrameMsTotal, diagFrames),
    frameMsMax: Math.round(diagFrameMsMax),
    segmentations: diagSegmentations,
    segmentMsAvg: avg(diagSegmentMsTotal, diagSegmentations),
    segmentMsMax: Math.round(diagSegmentMsMax),
    // Split pipeline: both workers' time together, so it compares with the single-thread paths.
    busyMsPerSec: external && seconds ? Math.round(((diagCompositeMsTotal + diagWorkMsTotal) / seconds) * 10) / 10 : undefined,
    segmenterWorkMsAvg: external ? avg(diagWorkMsTotal, diagSegmentations) : undefined,
    maskLatencyMsAvg: external ? avg(diagLatencyMsTotal, diagSegmentations) : undefined,
    segmenterSwitches: external ? diagSegmenterSwitches : undefined,
  };
  diagLastReadAt = now;
  diagWorkMsTotal = 0;
  diagCompositeMsTotal = 0;
  diagLatencyMsTotal = 0;
  diagSegmenterSwitches = 0;
  diagFrames = 0;
  diagFrameMsTotal = 0;
  diagFrameMsMax = 0;
  diagSegmentations = 0;
  diagSegmentMsTotal = 0;
  diagSegmentMsMax = 0;
  return data;
}

function setupGL(initialWidth: number, initialHeight: number) {
  width = initialWidth;
  height = initialHeight;
  canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  });
  if (!context) throw new Error('WebGL2 is not available in the worker');
  gl = context;
  gl.getExtension('OES_texture_float_linear');
  vao = gl.createVertexArray()!;
  programs = {
    alpha: createProgram(gl, alphaFragmentShader, ['u_mask', 'u_history', 'u_invert', 'u_lo', 'u_hi', 'u_history_weight'] as const),
    gaussian: createProgram(gl, gaussianFragmentShader, ['u_texture', 'u_step'] as const),
    copy: createProgram(gl, copyFragmentShader, ['u_texture'] as const),
    composite: createProgram(
      gl,
      compositeFragmentShader,
      ['u_frame', 'u_background', 'u_alpha', 'u_background_scale', 'u_background_offset', 'u_swap_sides'] as const,
      true,
    ),
  };
  gl.bindVertexArray(vao);
  quad = createQuadBuffer(gl);
  frameTexture = createTexture(gl);
  allocateTargets();
}

function allocateTargets() {
  for (const target of [...matte, ...background]) deleteRenderTarget(gl, target);
  if (featherScratch) deleteRenderTarget(gl, featherScratch);
  if (feathered) deleteRenderTarget(gl, feathered);
  if (halfFrame) deleteRenderTarget(gl, halfFrame);
  const matteWidth = Math.max(64, Math.round(width / 2));
  const matteHeight = Math.max(64, Math.round(height / 2));
  const bgWidth = Math.max(16, Math.round(width / 4));
  const bgHeight = Math.max(16, Math.round(height / 4));
  matte = [createRenderTarget(gl, matteWidth, matteHeight), createRenderTarget(gl, matteWidth, matteHeight)];
  featherScratch = createRenderTarget(gl, matteWidth, matteHeight);
  feathered = createRenderTarget(gl, matteWidth, matteHeight);
  halfFrame = createRenderTarget(gl, matteWidth, matteHeight);
  background = [createRenderTarget(gl, bgWidth, bgHeight), createRenderTarget(gl, bgWidth, bgHeight)];
  matteIndex = 0;
  hasMatteHistory = false;
}

function resize(nextWidth: number, nextHeight: number) {
  if ((nextWidth === width && nextHeight === height) || nextWidth <= 0 || nextHeight <= 0) return;
  width = nextWidth;
  height = nextHeight;
  canvas.width = width;
  canvas.height = height;
  allocateTargets();
}

function resetGLState() {
  gl.bindVertexArray(vao);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.CULL_FACE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
}

async function createSegmenter(wasmBase: string, model: { buffer: ArrayBuffer } | { url: string }) {
  const t0 = performance.now();
  // useModule: the ES-module build of the WASM loader — the classic one relies on importScripts,
  // which module workers don't have.
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, true);
  const t1 = performance.now();
  segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: {
      ...('buffer' in model ? { modelAssetBuffer: new Uint8Array(model.buffer) } : { modelAssetPath: model.url }),
      delegate: options.delegate,
    },
    canvas,
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
  });
  labels = segmenter.getLabels();
  return { filesetMs: Math.round(t1 - t0), modelFetchMs: 0, createSegmenterMs: Math.round(performance.now() - t1) };
}

function renderFrame(frame: VideoFrame) {
  const t0 = performance.now();
  resetGLState();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, frameTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

  updateMatte(frame);

  resetGLState();
  blurBackground();
  composite();

  stableFrameCount = hasMatteHistory ? stableFrameCount + 1 : 0;
  if (!ready && stableFrameCount >= REQUIRED_STABLE_FRAMES) {
    ready = true;
    post({ type: 'ready' });
  }
  if (!ready) {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  if (options.measureGpuSync) gl.finish();
  const frameMs = performance.now() - t0;
  diagCompositeMsTotal += frameMs;
  diagFrames += 1;
  diagFrameMsTotal += frameMs;
  if (frameMs > diagFrameMsMax) diagFrameMsMax = frameMs;
}

/** Same rate limiting for both ways of segmenting; true when this frame should get a new matte. */
function segmentationDue(now: number) {
  if (options.segmentationScheduler === 'exact') {
    const elapsed = lastSchedulerAt ? now - lastSchedulerAt : Infinity;
    lastSchedulerAt = now;
    segmentationCredit = Math.min(2, segmentationCredit + (elapsed * options.segmentationFps) / 1000);
    if (hasMatteHistory && segmentationCredit < 1) return false;
    segmentationCredit = Math.max(0, segmentationCredit - 1);
    return true;
  }
  const minInterval = 1000 / Math.max(1, options.segmentationFps);
  return !hasMatteHistory || now - lastSegmentationMs >= minInterval;
}

function requestExternalMatte(frame: VideoFrame) {
  if (!segmenterPort || requestInFlight) return;
  const now = performance.now();
  if (!segmentationDue(now)) return;
  lastSegmentationMs = now;
  requestInFlight = true;
  const copy = frame.clone();
  const message: SegmentRequest = { frame: copy, sentAt: now };
  segmenterPort.postMessage(message, [copy]);
}

function onExternalMatte(result: SegmentResult) {
  requestInFlight = false;
  if (stopped || !maskTexture) {
    result.mask.close();
    return;
  }
  const t0 = performance.now();
  resetGLState();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, maskTexture);
  // A GPU-backed bitmap from the segmenter's canvas: Chrome copies it GPU-side, no readback.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, result.mask);
  result.mask.close();
  const previousInvert = options.invert;
  options.invert = result.invert;
  composeMatte(maskTexture);
  options.invert = previousInvert;
  diagSegmentations += 1;
  diagSegmentMsTotal += result.segmentMs;
  if (result.segmentMs > diagSegmentMsMax) diagSegmentMsMax = result.segmentMs;
  diagWorkMsTotal += result.workMs;
  diagLatencyMsTotal += performance.now() - result.sentAt;
  // Uploading and feathering the matte is this worker's share of a segmentation; count it.
  diagCompositeMsTotal += performance.now() - t0;
}

function attachSegmenter(port: MessagePort) {
  if (segmenterPort) diagSegmenterSwitches += 1;
  // A request still out with the old segmenter is simply forgotten; closing its port drops the reply.
  segmenterPort?.close();
  segmenterPort = port;
  requestInFlight = false;
  port.onmessage = (event: MessageEvent<SegmentResult>) => onExternalMatte(event.data);
}

function updateMatte(frame: VideoFrame) {
  if (maskTexture) {
    requestExternalMatte(frame);
    return;
  }
  if (!segmenter) return;
  const now = performance.now();
  if (!segmentationDue(now)) return;
  lastSegmentationMs = now;
  const timestamp = Math.max(lastTimestampMs + 1, Math.round(now));
  lastTimestampMs = timestamp;

  const segmentStart = performance.now();
  segmenter.segmentForVideo(frame, timestamp, (result) => {
    try {
      const masks = result.confidenceMasks;
      if (!masks?.length) return;
      if (!maskIndexResolved) {
        const backgroundIndex = labels.findIndex((label) => label.toLowerCase() === 'background');
        maskIndex = masks.length === labels.length && backgroundIndex >= 0 ? backgroundIndex : 0;
        maskIndexResolved = true;
      }
      const mask = masks[maskIndex];
      if (mask) composeMatte(mask.getAsWebGLTexture());
    } finally {
      result.close();
    }
  });
  const segmentMs = performance.now() - segmentStart;
  if (!firstSegmentationReported) {
    firstSegmentationReported = true;
    post({ type: 'firstSegmentation', ms: Math.round(segmentMs) });
  }
  diagSegmentations += 1;
  diagSegmentMsTotal += segmentMs;
  if (segmentMs > diagSegmentMsMax) diagSegmentMsMax = segmentMs;
}

function composeMatte(maskTexture: WebGLTexture) {
  resetGLState();
  const write = matte[matteIndex];
  const history = matte[1 - matteIndex];
  const alpha = programs.alpha;
  gl.useProgram(alpha.program);
  bindTextureUnit(gl, 0, maskTexture, alpha.uniforms.u_mask);
  bindTextureUnit(gl, 1, history.texture, alpha.uniforms.u_history);
  gl.uniform1f(alpha.uniforms.u_invert, options.invert);
  gl.uniform1f(alpha.uniforms.u_lo, options.matteLo);
  gl.uniform1f(alpha.uniforms.u_hi, options.matteHi);
  gl.uniform1f(alpha.uniforms.u_history_weight, hasMatteHistory ? Math.min(0.95, Math.max(0, options.temporalSmoothing)) : 0);
  drawQuad(gl, quad, alpha.position, write, write.width, write.height);

  const featherTexels = Math.max(0.5, (options.edgeFeather / 2) * 0.5);
  const gaussian = programs.gaussian;
  gl.useProgram(gaussian.program);
  bindTextureUnit(gl, 0, write.texture, gaussian.uniforms.u_texture);
  gl.uniform2f(gaussian.uniforms.u_step, featherTexels / write.width, 0);
  drawQuad(gl, quad, gaussian.position, featherScratch!, featherScratch!.width, featherScratch!.height);
  bindTextureUnit(gl, 0, featherScratch!.texture, gaussian.uniforms.u_texture);
  gl.uniform2f(gaussian.uniforms.u_step, 0, featherTexels / featherScratch!.height);
  drawQuad(gl, quad, gaussian.position, feathered!, feathered!.width, feathered!.height);

  matteIndex = 1 - matteIndex;
  hasMatteHistory = true;
}

function blurBackground() {
  const [bufferA, bufferB] = background;
  const copy = programs.copy;
  gl.useProgram(copy.program);
  bindTextureUnit(gl, 0, frameTexture, copy.uniforms.u_texture);
  if (halfFrame) {
    drawQuad(gl, quad, copy.position, halfFrame, halfFrame.width, halfFrame.height);
    bindTextureUnit(gl, 0, halfFrame.texture, copy.uniforms.u_texture);
  }
  drawQuad(gl, quad, copy.position, bufferA, bufferA.width, bufferA.height);

  const sigma = Math.max(1, options.blurRadius / 4);
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

function composite() {
  const program = programs.composite;
  gl.useProgram(program.program);
  bindTextureUnit(gl, 0, frameTexture, program.uniforms.u_frame);
  bindTextureUnit(gl, 1, background[0].texture, program.uniforms.u_background);
  bindTextureUnit(gl, 2, feathered!.texture, program.uniforms.u_alpha);
  gl.uniform2f(program.uniforms.u_background_scale, 1, 1);
  gl.uniform2f(program.uniforms.u_background_offset, 0, 0);
  gl.uniform1f(program.uniforms.u_swap_sides, 0);
  drawQuad(gl, quad, program.position, null, width, height);
}

function transform(frame: VideoFrame, controller: TransformStreamDefaultController<VideoFrame>) {
  if (stopped || frame.codedWidth === 0 || frame.codedHeight === 0) {
    controller.enqueue(frame);
    return;
  }
  try {
    resize(frame.displayWidth, frame.displayHeight);
    renderFrame(frame);
    controller.enqueue(new VideoFrame(canvas, { timestamp: frame.timestamp }));
  } catch (err) {
    console.error('[bg-spike worker] frame failed:', err);
  } finally {
    frame.close();
  }
}

async function init(request: Extract<SpikeRequest, { type: 'init' }>) {
  options = request.options;
  setupGL(request.width, request.height);
  if (request.segmentation === 'external') {
    maskTexture = createTexture(gl);
    post({ type: 'loaded', loadTimings: {} });
  } else {
    const timings = await createSegmenter(request.wasmBase, request.model!);
    post({ type: 'loaded', loadTimings: timings });
  }
  if (stopped) return;
  abortController = new AbortController();
  request.readable
    .pipeThrough(new TransformStream<VideoFrame, VideoFrame>({ transform }), { signal: abortController.signal })
    .pipeTo(request.writable, { signal: abortController.signal })
    .catch((err) => {
      if (!stopped) post({ type: 'error', message: `pipeline: ${String(err)}` });
    });
}

async function stop() {
  stopped = true;
  abortController?.abort();
  segmenterPort?.close();
  await segmenter?.close();
  segmenter = undefined;
  // Give the GPU memory back now rather than whenever the worker gets collected.
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  post({ type: 'stopped' });
}

self.onmessage = (event: MessageEvent<SpikeRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    init(message).catch((err) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  } else if (message.type === 'attachSegmenter') {
    attachSegmenter(message.port);
  } else if (message.type === 'snapshot') {
    post({ type: 'snapshot', id: message.id, data: takePerfSnapshot() });
  } else if (message.type === 'stop') {
    void stop();
  }
};
