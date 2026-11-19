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

type Load = 'calm' | 'busy' | 'encoder' | 'audio' | 'bg-heavy' | 'switch' | 'switch-broken' | 'switch-often';

function sampleFor(t: number, load: Load, state: GovernorState): LoadSample {
  // Each step down relieves some pressure: two camera or receiving steps clear an "encoder"
  // overload (a "busy" one never clears).
  const relief = state.video + state.recv;
  const base: LoadSample = {
    t,
    intervalMs: SAMPLE_MS,
    visible: true,
    cameraOn: true,
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
  // The background on 'high' is too much for this machine: its frames fall behind.
  if (load === 'bg-heavy') base.bgFps = 8;
  // A window switch every 30s; the 10s after each are loaded (the browser and OS redrawing).
  // Switching every 5s and the background effect falling behind the whole time.
  if (load === 'switch-often') {
    base.sinceVisibilityChangeMs = t % 5_000;
    base.bgFps = 6;
  }
  if (load === 'switch' || load === 'switch-broken') {
    base.sinceVisibilityChangeMs = t % 30_000;
    if (base.sinceVisibilityChangeMs < 10_000) {
      base.audioStressedChunks = 31;
      base.bgFps = 6;
      if (load === 'switch-broken') base.audioUnderruns = 5;
    }
  }
  if (load === 'busy') {
    base.encoderCpuFraction = 0.7;
    base.mainLagMaxMs = 500;
  }
  if (load === 'audio') base.audioStressedChunks = 25;
  return base;
}

/** Receiving others' cameras: 'none' = nothing to slow down, 'small' = only tiles shown small, 'mixed' = small and large. */
type Receiving = 'none' | 'small' | 'mixed';

function recvReliefFor(receiving: Receiving, state: GovernorState, receivingShare: boolean) {
  if (receiving === 'none') return { 1: false, 2: false, 3: receivingShare && state.recv < 3 };
  return {
    1: state.recv < 1,
    // 2 caps large tiles at 360p; 3 takes small ones to 5fps (and a received share to half rate).
    2: state.recv < 2 && (receiving === 'mixed' || state.recv < 1),
    3: state.recv < 3,
    // Desktop senders always have a smaller simulcast layer to cap down to.
    4: state.recv < 4,
    5: receiving === 'mixed' && state.recv < 5,
  };
}

function run(
  name: string,
  schedule: (t: number) => Load,
  durationMs: number,
  ctx0: GovernorContext,
  receiving: Receiving = 'mixed',
  cameraOn = true,
  /** This person shares their screen in AV1 (or 'vp8'), or receives someone else's share. */
  share: 'av1' | 'vp8' | 'receiving' | null = null,
  /** Height of this person's own share (1440 = a screen above 1080p). */
  shareHeight = 1080,
  /** Load as a function of time and of the background quality currently in effect. */
  loadWithBg?: (t: number, bgQuality: GovernorContext['bgQuality']) => Load,
) {
  let state = initialGovernorState(0);
  const ctx = { ...ctx0 };
  const log: string[] = [];
  for (let t = SAMPLE_MS; t <= durationMs; t += SAMPLE_MS) {
    ctx.cameraOn = cameraOn;
    ctx.shareHeight = state.share1080 || state.share720 ? Math.min(shareHeight, 1080) : shareHeight;
    ctx.recvRelief = recvReliefFor(receiving, state, share === 'receiving');
    ctx.shareCodec = share === 'av1' ? (state.shareVp8 ? 'vp8' : 'av1') : share === 'vp8' ? 'vp8' : null;
    const load = loadWithBg ? loadWithBg(t, ctx.bgQuality) : schedule(t);
    const step = stepGovernor(state, sampleFor(t, load, state), ctx);
    state = step.state;
    if (step.action) {
      const a = step.action;
      const what =
        a.kind === 'video'
          ? `video->${a.level}`
          : a.kind === 'recv'
            ? `recv->${a.level}`
            : a.kind === 'share-vp8'
              ? 'share->VP8'
              : a.kind === 'share-720'
                ? `share-720-${a.direction}`
                : a.kind === 'share-1080'
                  ? `share-1080-${a.direction}`
                  : a.kind === 'photo'
                    ? `photo-${a.direction}`
                    : a.kind === 'seg-half'
                      ? `seg-half-${a.direction}`
                      : a.kind;
      if (a.kind === 'bg-balanced') ctx.bgQuality = 'balanced';
      if (a.kind === 'bg-high') ctx.bgQuality = 'high';
      log.push(`${(t / 1000).toFixed(0)}s:${what}(${step.verdict.reasons.join('+') || 'calm'})`);
    }
  }
  console.log(`${name}\n  ${log.join('  ') || '(no actions)'}\n  end: video=${state.video} recv=${state.recv} shareVp8=${state.shareVp8} share720=${state.share720} share1080=${state.share1080} photo=${state.photo} bgBlocked=${state.bgRestoreBlocked} backoff=${state.recoverBackoff}`);
}

const highBg: GovernorContext = { bgQuality: 'high', bgUpgradable: true, segHalfAvailable: true, cameraOn: true };
const balancedBg: GovernorContext = { bgQuality: 'balanced', bgUpgradable: true, segHalfAvailable: true, cameraOn: true };
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
run('busy, receiving only phones/iPhones (no receive steps possible)', () => 'busy', 300_000, noBg, 'none');
run('busy, camera off, watching others (receive steps only)', () => 'busy', 300_000, noBg, 'mixed', false);
run('busy while sharing in AV1 (camera first, then share->VP8, photo, 720p)', () => 'busy', 300_000, noBg, 'none', true, 'av1');
run('busy while receiving a share, camera off', () => 'busy', 300_000, noBg, 'mixed', false, 'receiving');
run('encoder overloaded 2 min while sharing in AV1, then calm', (t) => (t < 120_000 ? 'busy' : 'calm'), 600_000, noBg, 'none', true, 'av1');
run('busy while sharing a 1440p screen in VP8 (1440p -> 1080p first)', () => 'busy', 300_000, noBg, 'none', true, 'vp8', 1440);
run(
  'background restore holds: overloaded early, calm after (high comes back after 5 calm minutes)',
  (t) => (t < 60_000 ? 'encoder' : 'calm'),
  900_000,
  highBg,
);
run(
  "background restore fails: 'high' is too heavy (back to balanced within a minute, then never again)",
  () => 'calm',
  1_500_000,
  highBg,
  'mixed',
  true,
  null,
  1080,
  (t, bg) => (t < 30_000 || bg === 'high' ? 'bg-heavy' : 'calm'),
);
run(
  "background restore, heavy again only after the trial minute (back to balanced, then tried again)",
  () => 'calm',
  1_500_000,
  highBg,
  'mixed',
  true,
  null,
  1080,
  // Heavy at the start, and again for a while starting 2 minutes after each restore.
  (() => {
    let restoredAt: number | null = null;
    return (t: number, bg: GovernorContext['bgQuality']) => {
      if (t < 30_000) return 'bg-heavy';
      if (bg === 'high') restoredAt ??= t;
      else restoredAt = null;
      return restoredAt !== null && t - restoredAt > 120_000 && t - restoredAt < 160_000 ? 'bg-heavy' : 'calm';
    };
  })(),
);
run("started on 'balanced', machine has room ('high' tried after 5 calm minutes, and holds)", () => 'calm', 600_000, balancedBg);
run(
  "started on 'balanced', machine too slow for 'high' (tried once, back within a minute, never again)",
  () => 'calm',
  1_200_000,
  balancedBg,
  'mixed',
  true,
  null,
  1080,
  (_t, bg) => (bg === 'high' ? 'bg-heavy' : 'calm'),
);
run('window switched every 30s, each followed by 10s of load (must do nothing)', () => 'switch', 300_000, highBg);
run('window switched every 30s and the audio really breaks each time (steps down)', () => 'switch-broken', 120_000, highBg);
run('window switched every 5s, background effect behind throughout (grace runs out, steps down)', () => 'switch-often', 120_000, highBg);
