/**
 * Dev-only: runs the GTCRN playback worklet (src/lib/audio/gtcrn/gtcrnPlayback.worklet.ts) against
 * fake render quanta and a fake inference worker that stalls for 500ms, and checks every output
 * sample is processed audio, the raw mic from the same frame, or a crossfade between the two —
 * never silence or a misaligned sample. Not part of the app build.
 *
 *   npx tsx scripts/simulate-gtcrn-playback.mts
 */

const g = globalThis as any;
g.sampleRate = 16000;
g.currentFrame = 0;
let processorCtor: any;
g.registerProcessor = (_n: string, c: any) => { processorCtor = c; };
const posted: any[] = [];
g.AudioWorkletProcessor = class { port: any = { postMessage: (m: any) => posted.push(m), onmessage: null }; constructor(_o?: any) {} };
await import('../src/lib/audio/gtcrn/gtcrnPlayback.worklet.ts');
const LAT_MS = 192, L = LAT_MS * 16, DELAY = 256, CHUNK = 1024, Q = 128;
const p = new processorCtor({ processorOptions: { latencyMs: LAT_MS } });
p.port.onmessage({ data: { type: 'active', active: true } });
const raw = (f: number) => 0.5 * Math.sin((2 * Math.PI * 440 * f) / 16000) + 0.05 * Math.sin(f * 1.7);
const proc = (f: number) => 0.8 * raw(f); // stand-in for the enhanced signal
// Worker: chunk with raw frames [F, F+1024) -> processed frames [F-256, F+768), delivered 3ms after
// the chunk completes, except chunks completing in the stall window, which all land at its end.
const STALL_FROM = 32000, STALL_TO = 40000; // 2.0s .. 2.5s
const deliveries: { at: number; start: number; samples: Float32Array }[] = [];
for (let F = 0; F < 16000 * 4; F += CHUNK) {
  const done = F + CHUNK;
  let at = done + 48;
  if (done >= STALL_FROM && done < STALL_TO) at = STALL_TO + 48;
  const start = F - DELAY;
  const s = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) s[i] = start + i >= 0 ? proc(start + i) : 0;
  deliveries.push({ at, start, samples: s });
}
let maxErr = 0, zeros = 0, rawOut = 0, procOut = 0, mixOut = 0;
for (let frame = 0; frame < 16000 * 4 - Q; frame += Q) {
  for (const d of deliveries) if (d.at <= frame && d.samples) { g.currentFrame = frame - Q; p.port.onmessage({ data: { type: 'samples', samples: d.samples, startFrame: d.start } }); (d as any).samples = null; }
  g.currentFrame = frame;
  const input = new Float32Array(Q); for (let i = 0; i < Q; i++) input[i] = raw(frame + i);
  const out = new Float32Array(Q);
  p.process([[input]], [[out]]);
  for (let i = 0; i < Q; i++) {
    const t = frame + i - L;
    if (t < 0) continue;
    const e = proc(t), r = raw(t), o = out[i];
    if (o === 0 && Math.abs(r) > 1e-6) zeros++;
    const err = Math.min(Math.abs(o - e), Math.abs(o - r));
    // within a crossfade the output is between the two
    const between = (o - e) * (o - r) <= 1e-12;
    if (Math.abs(o - e) < 1e-6) procOut++; else if (Math.abs(o - r) < 1e-6) rawOut++; else if (between) mixOut++;
    else maxErr = Math.max(maxErr, err);
  }
}
const stats = posted.filter((m) => m.type === 'stats').pop();
console.log({ procOut, rawOut, mixOut, unexplained: maxErr, silentSamples: zeros, fillCount: stats.fillCount, filledMs: (stats.filledSamples / 16), underruns: stats.underrunCount, lateSamples: stats.lateSamples });
