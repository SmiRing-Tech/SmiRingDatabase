/**
 * Dev-only: runs the load governor's policy (src/pages/Connect/loadGovernor/governorPolicy.ts)
 * against scripted load, in virtual time, and prints what it would do — to check escalation,
 * settling, recovery and backoff without a slow machine. Not part of the app build.
 *
 *   npx tsx scripts/simulate-load-governor.ts
 */
import {
  initialGovernorState,
  stepGovernor,
  type GovernorContext,
  type GovernorState,
  type LoadSample,
} from '../src/pages/Connect/loadGovernor/governorPolicy';

const SAMPLE_MS = 2000;

type Load = 'calm' | 'busy' | 'encoder' | 'audio';

function sampleFor(t: number, load: Load, state: GovernorState): LoadSample {
  // Each step down relieves some pressure: by video level 2 an "encoder" overload is gone.
  const relief = state.video;
  const base: LoadSample = {
    t,
    intervalMs: SAMPLE_MS,
    visible: true,
    cameraOn: !state.cameraOffByGovernor,
    sharing: false,
    encoderCpuFraction: 0,
    mainLagMaxMs: 40,
    longTaskMsPerSec: 0,
    bgActive: true,
    bgFps: 20,
    bgExpectedFps: 20,
    bgCostMs: 3,
    audioActive: true,
    audioChunks: 31,
    audioStressedChunks: 0,
    audioPassthroughChunks: 0,
    audioUnderruns: 0,
    audioOverloaded: false,
  };
  if (load === 'encoder') base.encoderCpuFraction = relief >= 2 ? 0.05 : 0.9;
  if (load === 'busy') {
    base.encoderCpuFraction = 0.7;
    base.mainLagMaxMs = 500;
  }
  if (load === 'audio') base.audioStressedChunks = 25;
  return base;
}

function run(name: string, schedule: (t: number) => Load, durationMs: number, ctx0: GovernorContext) {
  let state = initialGovernorState(0);
  const ctx = { ...ctx0 };
  const log: string[] = [];
  for (let t = SAMPLE_MS; t <= durationMs; t += SAMPLE_MS) {
    ctx.cameraOn = !state.cameraOffByGovernor;
    const step = stepGovernor(state, sampleFor(t, schedule(t), state), ctx);
    state = step.state;
    if (step.action) {
      const a = step.action;
      const what = a.kind === 'video' ? `video->${a.level}` : a.kind === 'camera-off' ? 'camera-off' : 'bg-balanced';
      if (a.kind === 'bg-balanced') ctx.bgQuality = 'balanced';
      log.push(`${(t / 1000).toFixed(0)}s:${what}(${step.verdict.reasons.join('+') || 'calm'})`);
    }
  }
  console.log(`${name}\n  ${log.join('  ') || '(no actions)'}\n  end: video=${state.video} cameraOff=${state.cameraOffByGovernor} backoff=${state.recoverBackoff}`);
}

const highBg: GovernorContext = { bgQuality: 'high', cameraOn: true };
const noBg: GovernorContext = { bgQuality: null, cameraOn: true };

run('fast machine, always calm (must do nothing)', () => 'calm', 600_000, highBg);
run('encoder overloaded for 2 min, then calm', (t) => (t < 120_000 ? 'encoder' : 'calm'), 600_000, highBg);
run('busy that never lets up, no background effect', () => 'busy', 300_000, noBg);
run('audio struggling (should step faster)', (t) => (t < 60_000 ? 'audio' : 'calm'), 300_000, noBg);
run(
  'load comes back right after each recovery (backoff)',
  (t) => (t < 60_000 || (t % 150_000) < 40_000 ? 'encoder' : 'calm'),
  1_200_000,
  noBg,
);
run('short 6s spike every minute (must do nothing)', (t) => (t % 60_000 < 6_000 ? 'busy' : 'calm'), 600_000, highBg);
