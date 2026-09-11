/**
 * Dev-only cross-check: runs the same GtcrnStreamProcessor TypeScript module the browser will
 * use, but under Node + onnxruntime-node, over the raw float32 PCM exported from
 * noise-cancel-research's Python validation (see test_real_samples.py). Not part of the app
 * build — run manually with `node --experimental-strip-types scripts/validate-gtcrn-node.ts`.
 *
 * This is a true streaming run (no reflect-padding lookahead, unlike the Python offline
 * reference), so don't expect sample-exact parity with enh_onnx.wav — the point is to confirm
 * the hand-rolled STFT/OLA math in GtcrnStreamProcessor.ts doesn't diverge, NaN, or otherwise
 * misbehave before ever touching a browser, and to produce something to listen to.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import {
  GtcrnStreamProcessor,
  type OrtSessionLike,
  type OrtTensorLike,
} from '../src/lib/audio/gtcrn/GtcrnStreamProcessor.ts';

const RAW_DIR = '../noise-cancel-research/vendor/gtcrn/stream/test_wavs';
const MODEL_PATH = 'public/gtcrn/gtcrn_simple.onnx';

function readRawFloat32(path: string): Float32Array {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function writeWav16(path: string, samples: Float32Array, sampleRate = 16000) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = Math.round(s * 32767);
  }
  const dataSize = pcm.byteLength;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(pcm.buffer)]));
}

async function main() {
  const session = await InferenceSession.create(MODEL_PATH, { executionProviders: ['cpu'] });
  const sessionLike: OrtSessionLike = {
    async run(feeds) {
      const ortFeeds: Record<string, Tensor> = {};
      for (const [name, t] of Object.entries(feeds)) {
        ortFeeds[name] = new Tensor('float32', t.data, t.dims as number[]);
      }
      const out = await session.run(ortFeeds);
      const result: Record<string, OrtTensorLike> = {};
      for (const [name, t] of Object.entries(out)) {
        result[name] = { data: t.data as Float32Array, dims: t.dims };
      }
      return result;
    },
  };
  const makeTensor = (data: Float32Array, dims: readonly number[]): OrtTensorLike => ({ data, dims });

  const processor = new GtcrnStreamProcessor(sessionLike, makeTensor);

  const mix = readRawFloat32(`${RAW_DIR}/mix_f32.raw`);
  console.log(`input: ${mix.length} samples (${(mix.length / 16000).toFixed(2)}s)`);

  // Feed in small chunks (simulating a real audio callback) rather than all at once, to
  // exercise the carry-buffer logic the same way live mic input would.
  const CALLBACK_SIZE = 512;
  const chunks: Float32Array[] = [];
  for (let i = 0; i < mix.length; i += CALLBACK_SIZE) {
    const chunk = mix.subarray(i, i + CALLBACK_SIZE);
    const out = await processor.push(chunk);
    if (out.length > 0) chunks.push(out);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    output.set(c, offset);
    offset += c.length;
  }

  let nanOrInf = 0;
  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < output.length; i++) {
    const v = output[i];
    if (!Number.isFinite(v)) nanOrInf++;
    sumSquares += v * v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const rms = Math.sqrt(sumSquares / output.length);
  console.log(`output: ${output.length} samples (${(output.length / 16000).toFixed(2)}s)`);
  console.log(`NaN/Inf count: ${nanOrInf}, RMS: ${rms.toFixed(4)}, peak: ${peak.toFixed(4)}`);

  const outPath = `${RAW_DIR}/enh_node_streaming.wav`;
  writeWav16(outPath, output);
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
