/**
 * SPIKE (blur lab only): segmentation alone, in its own worker, for the "split" pipeline — the
 * compositor worker (backgroundSpike.worker.ts in 'external' mode) keeps rendering every frame
 * and sends this worker a frame whenever it wants a fresh matte; this worker answers with the
 * mask as an ImageBitmap.
 *
 * Why a separate worker at all: tasks-vision pools GPU buffers per WASM instance, so two
 * segmenters can never be alive in one thread (see MediapipeBackgroundProcessor.init()). A
 * worker is its own WASM instance, so swapping models becomes "load and warm the new one here,
 * then point the compositor at it" — nothing on the outgoing video ever stops or goes black.
 *
 * The mask never leaves the GPU: it is drawn (downscaled) onto this worker's canvas and handed
 * over with transferToImageBitmap(). The first version read it back with getAsFloat32Array()
 * instead — a synchronous GPU->CPU readback that measured 13ms per mask on an M4 (34ms on the
 * high model), against ~2ms for the whole inference when the mask stays on the GPU.
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
      invert: number;
      /** Size of the mask handed to the compositor; the width follows the camera's aspect. */
      maskHeight: number;
      aspect: number;
    }
  | { type: 'stop' };

export type SegmenterResponse =
  | { type: 'ready'; loadTimings: { filesetMs: number; createSegmenterMs: number; firstSegmentationMs: number } }
  | { type: 'error'; message: string }
  | { type: 'stopped' };

/** Compositor -> segmenter, over the MessagePort. */
export type SegmentRequest = { frame: VideoFrame; sentAt: number };

/** Segmenter -> compositor, over the MessagePort. */
export type SegmentResult = {
  mask: ImageBitmap;
  invert: number;
  /** This worker's whole time for the request: inference + drawing the mask + handing it over. */
  workMs: number;
  /** segmentForVideo up to its callback, i.e. the inference alone. */
  segmentMs: number;
  sentAt: number;
};

/** Copies the confidence mask's single channel into all of RGB, so any reader can take .r. */
const maskCopyFragmentShader = `#version 300 es
precision highp float;
in vec2 texCoords;
uniform sampler2D u_mask;
out vec4 fragColor;
void main() {
  float confidence = texture(u_mask, texCoords).r;
  fragColor = vec4(confidence, confidence, confidence, 1.0);
}`;

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
let stopped = false;

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
    segmentMs = performance.now() - s0;
    try {
      lastMaskCount = result.confidenceMasks?.length ?? 0;
      const mask = result.confidenceMasks?.[maskIndex] ?? result.confidenceMasks?.[0];
      if (!mask) {
        segmentMs = null;
        return;
      }
      const texture = mask.getAsWebGLTexture();
      // MediaPipe shares this context and leaves its own state behind (see
      // MediapipeBackgroundProcessor.resetGLState).
      gl.bindVertexArray(vao);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.useProgram(maskProgram.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(maskProgram.uniforms.u_mask, 0);
      // flipY: the canvas's top row becomes the bitmap's top row, so this puts the image's top
      // row on top — the same way up as a camera frame uploaded by the compositor.
      drawQuad(gl, quad, maskProgram.position, null, canvas.width, canvas.height);
    } finally {
      result.close();
    }
  });
  return segmentMs;
}

function onFrame({ frame, sentAt }: SegmentRequest) {
  const t0 = performance.now();
  try {
    if (stopped || !segmenter) return;
    const segmentMs = segmentToCanvas(frame);
    if (segmentMs === null || stopped) return;
    const mask = canvas.transferToImageBitmap();
    const message: SegmentResult = { mask, invert, workMs: performance.now() - t0, segmentMs, sentAt };
    port?.postMessage(message, [mask]);
  } catch (err) {
    console.error('[bg-segmenter spike] frame failed:', err);
  } finally {
    frame.close();
  }
}

async function init(request: Extract<SegmenterRequest, { type: 'init' }>) {
  invert = request.invert;
  const maskWidth = Math.round(request.maskHeight * request.aspect);
  canvas = new OffscreenCanvas(maskWidth, request.maskHeight);

  const t0 = performance.now();
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

  // Warm up here, on a blank image, so the first-inference shader compile happens before the
  // compositor ever depends on this worker — that compile is the multi-second stall on slow GPUs.
  segmentToCanvas(new ImageData(maskWidth, request.maskHeight));
  canvas.transferToImageBitmap().close();
  const t3 = performance.now();
  // Same mask choice as the main-thread processor: the label named "background" when there is one
  // mask per label, else the only mask there is.
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
    init(message).catch((err) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  } else if (message.type === 'stop') {
    stopped = true;
    port?.close();
    await segmenter?.close();
    segmenter = undefined;
    post({ type: 'stopped' });
  }
};
