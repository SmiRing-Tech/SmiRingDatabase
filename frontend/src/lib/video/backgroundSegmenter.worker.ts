/**
 * Segmentation for the worker background pipeline (see WorkerBackgroundProcessor): runs the
 * MediaPipe segmenter on frames the compositor worker sends over a MessagePort, and answers with
 * the mask as an ImageBitmap.
 *
 * Its own worker, not part of the compositor, because tasks-vision pools GPU buffers per WASM
 * instance — two segmenters can never be alive in one thread (see
 * MediapipeBackgroundProcessor.init()). A worker is its own WASM instance, so changing models is
 * "load and warm a new one of these, then point the compositor at it": the video never pauses.
 *
 * The mask never leaves the GPU: it is drawn onto this worker's canvas at roughly the model's own
 * resolution and handed over with transferToImageBitmap(). Reading it back to the CPU instead
 * (getAsFloat32Array) measured 13ms per mask on an M4, against ~2ms for the whole inference.
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { createProgram, createQuadBuffer, drawQuad, type GLProgram } from './mediapipeGL';

export type SegmenterRequest =
  | {
      type: 'init';
      port: MessagePort;
      wasmBase: string;
      model: { buffer: ArrayBuffer } | { url: string };
      delegate: 'GPU' | 'CPU';
      /** 1 when this model's mask scores background (see MODEL_INVERT). */
      invert: number;
      /** Size of the mask handed to the compositor; the width follows the camera's aspect. */
      maskHeight: number;
      aspect: number;
    }
  | { type: 'stop' };

export type SegmenterLoadTimings = { filesetMs: number; createSegmenterMs: number; firstSegmentationMs: number };

export type SegmenterResponse =
  | { type: 'ready'; loadTimings: SegmenterLoadTimings }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'stopped' };

/** Compositor -> segmenter, over the MessagePort. */
export type SegmentRequest = { frame: VideoFrame; sentAt: number };

/** Segmenter -> compositor, over the MessagePort. Always exactly one reply per request. */
export type SegmentReply =
  | {
      ok: true;
      mask: ImageBitmap;
      invert: number;
      /** This worker's whole time for the request: inference + drawing the mask + handing it over. */
      workMs: number;
      /** segmentForVideo up to its callback, i.e. the inference alone. */
      segmentMs: number;
      sentAt: number;
    }
  | { ok: false; sentAt: number };

/** Copies the confidence mask's single channel into RGB, so the compositor can read .r as usual. */
const maskCopyFragmentShader = `#version 300 es
precision highp float;
in vec2 texCoords;
uniform sampler2D u_mask;
out vec4 fragColor;
void main() {
  float confidence = texture(u_mask, texCoords).r;
  fragColor = vec4(confidence, confidence, confidence, 1.0);
}`;

/** This many failed frames in a row means the segmenter is broken, not unlucky. */
const MAX_CONSECUTIVE_FAILURES = 10;

const post = (message: SegmenterResponse) => self.postMessage(message);

let segmenter: ImageSegmenter | undefined;
let port: MessagePort | undefined;
let canvas: OffscreenCanvas;
let gl: WebGL2RenderingContext;
let maskProgram: GLProgram<'u_mask'>;
let quad: WebGLBuffer;
let vao: WebGLVertexArrayObject;
let maskIndex = 0;
let lastMaskCount = 0;
let invert = 0;
let lastTimestampMs = 0;
let consecutiveFailures = 0;
let stopped = false;

/** MediaPipe requires strictly increasing timestamps in VIDEO mode. */
function nextTimestamp() {
  const timestamp = Math.max(lastTimestampMs + 1, Math.round(performance.now()));
  lastTimestampMs = timestamp;
  return timestamp;
}

/**
 * Runs one inference and draws the chosen mask onto the canvas (masks are only valid inside the
 * callback). Returns the inference time, or null if there was no mask.
 */
function segmentToCanvas(source: VideoFrame | ImageData): number | null {
  const s0 = performance.now();
  let segmentMs: number | null = null;
  segmenter!.segmentForVideo(source, nextTimestamp(), (result) => {
    try {
      lastMaskCount = result.confidenceMasks?.length ?? 0;
      const mask = result.confidenceMasks?.[maskIndex] ?? result.confidenceMasks?.[0];
      if (!mask) return;
      segmentMs = performance.now() - s0;
      const texture = mask.getAsWebGLTexture();
      // MediaPipe shares this context and leaves its own state behind (see
      // BackgroundCompositor.resetGLState).
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(maskProgram.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(maskProgram.uniforms.u_mask, 0);
      // Drawn with flipY: the canvas's top row becomes the bitmap's top row, so this puts the
      // image's top row on top — the same way up as a camera frame the compositor uploads.
      drawQuad(gl, quad, maskProgram.position, null, canvas.width, canvas.height);
    } finally {
      result.close();
    }
  });
  return segmentMs;
}

function onFrame({ frame, sentAt }: SegmentRequest) {
  const t0 = performance.now();
  let reply: SegmentReply = { ok: false, sentAt };
  try {
    if (stopped || !segmenter) return;
    const segmentMs = segmentToCanvas(frame);
    if (segmentMs !== null) {
      const mask = canvas.transferToImageBitmap();
      reply = { ok: true, mask, invert, workMs: performance.now() - t0, segmentMs, sentAt };
    }
  } catch (err) {
    console.error('[bg-segmenter] frame failed:', err);
  } finally {
    frame.close();
    // Always answer: the compositor sends nothing new until it hears back.
    if (reply.ok) {
      consecutiveFailures = 0;
      port?.postMessage(reply, [reply.mask]);
    } else if (!stopped) {
      port?.postMessage(reply);
      consecutiveFailures += 1;
      if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
        post({ type: 'error', message: `${MAX_CONSECUTIVE_FAILURES} frames in a row failed`, fatal: true });
      }
    }
  }
}

async function init(request: Extract<SegmenterRequest, { type: 'init' }>) {
  invert = request.invert;
  const maskWidth = Math.round(request.maskHeight * request.aspect);
  canvas = new OffscreenCanvas(maskWidth, request.maskHeight);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    post({ type: 'error', message: 'segmenter WebGL context lost', fatal: true });
  });

  const t0 = performance.now();
  // useModule: the ES-module build of the WASM loader — the classic one needs importScripts,
  // which module workers don't have.
  const fileset = await FilesetResolver.forVisionTasks(request.wasmBase, true);
  const t1 = performance.now();
  const model = request.model;
  segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: {
      ...('buffer' in model ? { modelAssetBuffer: new Uint8Array(model.buffer) } : { modelAssetPath: model.url }),
      delegate: request.delegate,
    },
    canvas,
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
  });
  const labels = segmenter.getLabels();
  const t2 = performance.now();

  // MediaPipe created the context on this canvas; asking again returns the same one.
  const context = canvas.getContext('webgl2');
  if (!context) throw new Error('segmenter canvas has no WebGL2 context');
  gl = context;
  gl.getExtension('OES_texture_float_linear');
  vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  maskProgram = createProgram(gl, maskCopyFragmentShader, ['u_mask'] as const, true);
  quad = createQuadBuffer(gl);

  // Warm up on a blank image, so the first-inference shader compile — the multi-second stall
  // on slow GPUs — happens before the compositor depends on this worker, not on its first frame.
  segmentToCanvas(new ImageData(maskWidth, request.maskHeight));
  canvas.transferToImageBitmap().close();
  const t3 = performance.now();
  // Same mask choice as the main-thread processor: the label named "background" when there is
  // one mask per label, else the only mask there is.
  const backgroundIndex = labels.findIndex((label) => label.toLowerCase() === 'background');
  maskIndex = lastMaskCount === labels.length && backgroundIndex >= 0 ? backgroundIndex : 0;

  port = request.port;
  port.onmessage = (event: MessageEvent<SegmentRequest>) => onFrame(event.data);
  post({
    type: 'ready',
    loadTimings: {
      filesetMs: Math.round(t1 - t0),
      createSegmenterMs: Math.round(t2 - t1),
      firstSegmentationMs: Math.round(t3 - t2),
    },
  });
}

self.onmessage = async (event: MessageEvent<SegmenterRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    init(message).catch((err) =>
      post({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: true }),
    );
  } else if (message.type === 'stop') {
    stopped = true;
    port?.close();
    try {
      segmenter?.close();
    } catch {
      // Already broken; nothing left to release.
    }
    segmenter = undefined;
    post({ type: 'stopped' });
  }
};
