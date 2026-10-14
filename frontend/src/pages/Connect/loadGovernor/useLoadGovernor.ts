import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { Track, TrackEvent, type LocalVideoTrack } from 'livekit-client';
import { subscribeLoadSignals } from '../../../lib/loadSignals';
import { takeRenderMeter } from '../../../lib/renderMeter';
import { applyCaptureConstraints, cameraSourceTrack } from '../../../lib/video/backgroundProcessor';
import { diagEvent, diagState } from '../../../lib/connectDiagnostics';
import { recordTelemetry, startTelemetry, stopTelemetry } from '../../../lib/connectTelemetry';
import { VIDEO_CAPTURE_CONSTRAINTS } from '../../../components/Connect/captureConstraints';
import type { BackgroundEffectState } from '../useBackgroundEffect';
import {
  initialGovernorState,
  stepGovernor,
  videoProfileFor,
  type GovernorAction,
  type GovernorState,
  type GovernorStep,
  type LoadSample,
  type ReceiveStats,
  type VideoLevel,
  type VideoProfile,
} from './governorPolicy';

/**
 * Watches how the machine is coping during a call and lightens the camera side when it isn't
 * (see governorPolicy.ts for the ladder and the rules). Every sample and decision also goes to
 * the always-on telemetry, so thresholds can be tuned from real calls.
 *
 * Per-device switch, for calibrating on a machine without it touching anything:
 *   localStorage.setItem('smiring.debug.loadGovernor', 'observe')  // judge and record, never act
 *   localStorage.setItem('smiring.debug.loadGovernor', 'off')      // nothing at all
 *   localStorage.setItem('smiring.debug.loadPanel', '1')           // live readout on screen
 */

const SAMPLE_MS = 2000;
const LAG_TICK_MS = 100;
/** One noise-cancel chunk is 64ms of audio. */
const AUDIO_CHUNK_MS = 64;
/** Don't re-apply camera constraints more often than this when the camera won't take them. */
const REAPPLY_MIN_MS = 10_000;

export type GovernorMode = 'active' | 'observe' | 'off';

function readFlag(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function governorMode(): GovernorMode {
  const value = readFlag('smiring.debug.loadGovernor');
  return value === 'observe' || value === 'off' ? value : 'active';
}

function idealNumber(value: ConstrainULong | ConstrainDouble | undefined, fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof value.ideal === 'number') return value.ideal;
  return fallback;
}

/** What this device captures at normally (level 0) — the pre-join capture settings. */
const BASE_PROFILE: VideoProfile = {
  width: idealNumber(VIDEO_CAPTURE_CONSTRAINTS.width, 1280),
  height: idealNumber(VIDEO_CAPTURE_CONSTRAINTS.height, 720),
  frameRate: idealNumber(VIDEO_CAPTURE_CONSTRAINTS.frameRate, 20),
  segmentationFps: 20,
  segmentationScheduler: 'interval',
};

function constraintsFor(profile: VideoProfile): MediaTrackConstraints {
  return {
    width: { ideal: profile.width },
    height: { ideal: profile.height },
    aspectRatio: { ideal: 16 / 9 },
    frameRate: { ideal: profile.frameRate },
  };
}

/** Accumulates the push signals (lib/loadSignals) between samples. */
function createSignalTotals() {
  return {
    audioChunks: 0,
    audioStressed: 0,
    audioPassthrough: 0,
    audioUnderruns: 0,
    audioOverloaded: false,
    bgFrames: 0,
    bgSeconds: 0,
    bgCostMs: 0,
    bgExpectedFps: 0,
    bgReports: 0,
  };
}

export interface CameraOffNotice {
  withBackground: boolean;
}

export function useLoadGovernor({
  background,
  roomId,
  onNotice,
  onCameraTurnedOff,
}: {
  background: BackgroundEffectState;
  /** The room telemetry is filed under (the current room — a guest's token only covers that one). */
  roomId: string;
  onNotice: (message: string) => void;
  onCameraTurnedOff?: () => void;
}) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const [mode] = useState(governorMode);
  const [showPanel] = useState(() => readFlag('smiring.debug.loadPanel') === '1');
  const [lastStep, setLastStep] = useState<(GovernorStep & { sample: LoadSample }) | null>(null);
  const [cameraOffNotice, setCameraOffNotice] = useState<CameraOffNotice | null>(null);

  // Latest values for the sampling loop, which runs outside React's render cycle.
  const backgroundRef = useRef(background);
  const onNoticeRef = useRef(onNotice);
  const onCameraTurnedOffRef = useRef(onCameraTurnedOff);
  useEffect(() => {
    backgroundRef.current = background;
    onNoticeRef.current = onNotice;
    onCameraTurnedOffRef.current = onCameraTurnedOff;
  });

  const stateRef = useRef<GovernorState>(initialGovernorState(performance.now()));
  /** Which capture level was last applied to which camera track (LiveKit replaces the track on restart). */
  const appliedRef = useRef(new WeakMap<MediaStreamTrack, VideoLevel>());
  const lastApplyAtRef = useRef(0);

  const cameraTrack = useCallback(
    () => localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined,
    [localParticipant],
  );

  /** Makes the camera match the governor's video level (idempotent; called every sample). */
  const syncCameraProfile = useCallback(
    (level: VideoLevel, force = false) => {
      const track = cameraTrack();
      const mst = track ? cameraSourceTrack(track) : undefined;
      if (!track || !mst || mst.readyState !== 'live') return;
      const profile = videoProfileFor(level, BASE_PROFILE);
      const now = performance.now();
      const applied = appliedRef.current.get(mst);
      // LiveKit puts its own constraints back when the processor changes; catch the camera
      // running bigger than this level asks for.
      const settings = mst.getSettings();
      const drifted = level > 0 && (settings.height ?? 0) > profile.height * 1.1 && now - lastApplyAtRef.current > REAPPLY_MIN_MS;
      if (!force && applied === level && !drifted) return;
      if (applied === undefined && level === 0) {
        appliedRef.current.set(mst, 0);
        return;
      }
      lastApplyAtRef.current = now;
      appliedRef.current.set(mst, level);
      void applyCaptureConstraints(track, constraintsFor(profile)).catch((err) =>
        console.warn('[governor] could not change camera settings:', err),
      );
    },
    [cameraTrack],
  );

  const applyAction = useCallback(
    async (action: GovernorAction) => {
      const bg = backgroundRef.current;
      if (action.kind === 'bg-balanced') {
        const ok = await bg.setQuality('balanced', { auto: true });
        if (ok) onNoticeRef.current('パソコンの負荷が高いため、背景エフェクトを標準画質に切り替えました。');
        return;
      }
      if (action.kind === 'video') {
        const profile = videoProfileFor(action.level, BASE_PROFILE);
        bg.setPerformanceProfile(
          action.level === 0
            ? null
            : { segmentationFps: profile.segmentationFps, segmentationScheduler: profile.segmentationScheduler },
        );
        syncCameraProfile(action.level, true);
        if (action.direction === 'down') {
          onNoticeRef.current('パソコンの負荷が高いため、カメラの画質を下げています（負荷が下がると自動で戻ります）。');
        }
        return;
      }
      await localParticipant.setCameraEnabled(false);
      onCameraTurnedOffRef.current?.();
      setCameraOffNotice({ withBackground: action.withBackground });
    },
    [localParticipant, syncCameraProfile],
  );

  // Camera track replaced or its processor changed: forget what was applied, so the next sample
  // re-applies the current level.
  useEffect(() => {
    const forget = () => {
      const track = cameraTrack();
      const mst = track ? cameraSourceTrack(track) : undefined;
      if (mst) appliedRef.current.delete(mst);
    };
    const track = cameraTrack();
    track?.on(TrackEvent.TrackProcessorUpdate, forget);
    track?.on(TrackEvent.Restarted, forget);
    return () => {
      track?.off(TrackEvent.TrackProcessorUpdate, forget);
      track?.off(TrackEvent.Restarted, forget);
    };
  });

  useEffect(() => {
    if (mode === 'off') return;
    startTelemetry(roomId, { mode, base: BASE_PROFILE });
    recordTelemetry('governor-start', { mode });
    diagState('loadGovernor', mode);

    let totals = createSignalTotals();
    let lastUnderrunCount: number | null = null;
    const unsubscribe = subscribeLoadSignals((signal) => {
      if (signal.kind === 'audio-chunk') {
        totals.audioChunks += 1;
        if (signal.passthrough) totals.audioPassthrough += 1;
        if (signal.passthrough || signal.level >= signal.maxLevel) totals.audioStressed += 1;
      } else if (signal.kind === 'audio-playback') {
        // Cumulative per noise-cancel instance; a smaller number means a new instance started.
        const previous = lastUnderrunCount ?? 0;
        totals.audioUnderruns += signal.underrunCount >= previous ? signal.underrunCount - previous : signal.underrunCount;
        lastUnderrunCount = signal.underrunCount;
      } else if (signal.kind === 'audio-overload') {
        totals.audioOverloaded = true;
      } else if (signal.kind === 'background') {
        totals.bgFrames += signal.frames;
        totals.bgSeconds += signal.seconds;
        totals.bgCostMs += signal.costMsTotal;
        totals.bgExpectedFps = signal.expectedFps;
        totals.bgReports += 1;
      }
    });

    // Main-thread responsiveness: how late a 100ms timer fires, and long tasks where supported.
    let lagMax = 0;
    let lastTick = performance.now();
    const lagTimer = setInterval(() => {
      const now = performance.now();
      lagMax = Math.max(lagMax, now - lastTick - LAG_TICK_MS);
      lastTick = now;
    }, LAG_TICK_MS);
    let longTaskMs = 0;
    let longTaskObserver: PerformanceObserver | undefined;
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTaskMs += entry.duration;
      });
      longTaskObserver.observe({ type: 'longtask', buffered: false });
    }

    // Encoder CPU limitation: share of time each outbound video stream spent CPU-limited,
    // from the cumulative qualityLimitationDurations (falls back to the current reason).
    const lastDurations = new Map<string, { cpu: number; total: number }>();
    const encoderCpuFraction = async (): Promise<number | undefined> => {
      const senders = [Track.Source.Camera, Track.Source.ScreenShare]
        .map((source) => localParticipant.getTrackPublication(source)?.track?.sender)
        .filter((sender): sender is RTCRtpSender => !!sender);
      let worst: number | undefined;
      for (const sender of senders) {
        const report = await sender.getStats();
        report.forEach((stat) => {
          if (stat.type !== 'outbound-rtp' || stat.kind !== 'video' || stat.active === false) return;
          const durations = stat.qualityLimitationDurations as Record<string, number> | undefined;
          let fraction: number | undefined;
          if (durations) {
            const total = Object.values(durations).reduce((sum, v) => sum + v, 0);
            const cpu = durations.cpu ?? 0;
            const prev = lastDurations.get(stat.id);
            lastDurations.set(stat.id, { cpu, total });
            if (prev && total > prev.total) fraction = (cpu - prev.cpu) / (total - prev.total);
          } else if (typeof stat.qualityLimitationReason === 'string') {
            fraction = stat.qualityLimitationReason === 'cpu' ? 1 : 0;
          }
          if (fraction !== undefined) worst = Math.max(worst ?? 0, fraction);
        });
      }
      return worst;
    };

    // Receiving side: decode work for everyone else's video, from each remote track's receiver.
    const lastInbound = new Map<string, { decoded: number; decodeTime: number; dropped: number; freezes: number }>();
    const decoders = new Set<string>();
    const receiveStats = async (seconds: number): Promise<ReceiveStats> => {
      const result: ReceiveStats = { streams: 0, decodedFps: 0, droppedPerSec: 0, freezes: 0, maxHeight: 0 };
      let decodedTotal = 0;
      let decodeTimeTotal = 0;
      const seen = new Set<string>();
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.videoTrackPublications.values()) {
          const receiver = publication.isSubscribed ? (publication.track as { receiver?: RTCRtpReceiver } | undefined)?.receiver : undefined;
          if (!receiver) continue;
          const report = await receiver.getStats();
          report.forEach((stat) => {
            if (stat.type !== 'inbound-rtp' || stat.kind !== 'video') return;
            seen.add(stat.id);
            result.streams += 1;
            result.maxHeight = Math.max(result.maxHeight, stat.frameHeight ?? 0);
            if (typeof stat.decoderImplementation === 'string' && !decoders.has(stat.decoderImplementation)) {
              decoders.add(stat.decoderImplementation);
              recordTelemetry('decoder', {
                impl: stat.decoderImplementation,
                powerEfficient: stat.powerEfficientDecoder,
              });
            }
            const now = {
              decoded: stat.framesDecoded ?? 0,
              decodeTime: stat.totalDecodeTime ?? 0,
              dropped: stat.framesDropped ?? 0,
              freezes: stat.freezeCount ?? 0,
            };
            const prev = lastInbound.get(stat.id);
            lastInbound.set(stat.id, now);
            if (!prev || now.decoded < prev.decoded) return;
            decodedTotal += now.decoded - prev.decoded;
            decodeTimeTotal += now.decodeTime - prev.decodeTime;
            result.droppedPerSec += Math.max(0, now.dropped - prev.dropped) / seconds;
            result.freezes += Math.max(0, now.freezes - prev.freezes);
          });
        }
      }
      for (const id of lastInbound.keys()) if (!seen.has(id)) lastInbound.delete(id);
      result.decodedFps = decodedTotal / seconds;
      if (decodedTotal > 0) result.decodeMsPerFrame = (decodeTimeTotal / decodedTotal) * 1000;
      return result;
    };

    let lastSampleAt = performance.now();
    let running = false;
    takeRenderMeter(); // drop whatever was counted before this call's first window
    const sampleTimer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const now = performance.now();
        const bg = backgroundRef.current;
        const encoder = await encoderCpuFraction().catch(() => undefined);
        const seconds = Math.max(0.001, (now - lastSampleAt) / 1000);
        const recv = await receiveStats(seconds).catch(() => undefined);
        const t = totals;
        totals = createSignalTotals();
        const rendered = takeRenderMeter();
        // The playback queue also runs dry whenever the mic is muted (muted chunks are never
        // processed), so only count underruns from windows where audio was flowing throughout.
        const audioFlowing = t.audioChunks >= ((now - lastSampleAt) / AUDIO_CHUNK_MS) * 0.8;
        const sample: LoadSample = {
          t: now,
          intervalMs: now - lastSampleAt,
          visible: document.visibilityState === 'visible',
          cameraOn: localParticipant.isCameraEnabled,
          sharing: localParticipant.isScreenShareEnabled,
          encoderCpuFraction: encoder,
          mainLagMaxMs: Math.max(0, lagMax),
          longTaskMsPerSec: longTaskMs / seconds,
          bgActive: t.bgReports > 0,
          bgFps: t.bgSeconds > 0 ? t.bgFrames / t.bgSeconds : undefined,
          bgExpectedFps: t.bgExpectedFps || undefined,
          bgCostMs: t.bgFrames > 0 ? t.bgCostMs / t.bgFrames : undefined,
          audioActive: t.audioChunks > 0,
          audioChunks: t.audioChunks,
          audioStressedChunks: t.audioStressed,
          audioPassthroughChunks: t.audioPassthrough,
          audioUnderruns: audioFlowing ? t.audioUnderruns : 0,
          audioOverloaded: t.audioOverloaded,
          recv,
          render: {
            perSec: rendered.renders / seconds,
            msPerSec: rendered.renderMs / seconds,
            maxMs: rendered.maxMs,
          },
        };
        lastSampleAt = now;
        lagMax = 0;
        longTaskMs = 0;

        const state = stateRef.current;
        const actualQuality = bg.supported && bg.mode !== 'off' ? bg.quality : null;
        // In observe mode nothing is applied, so judge as if it had been — otherwise the governor
        // would keep "deciding" the same first step forever.
        const ctx =
          mode === 'active'
            ? { bgQuality: actualQuality, cameraOn: sample.cameraOn }
            : {
                bgQuality: actualQuality === 'high' && state.bgDowngraded ? ('balanced' as const) : actualQuality,
                cameraOn: sample.cameraOn && !state.cameraOffByGovernor,
              };
        const step = stepGovernor(state, sample, ctx);
        stateRef.current = step.state;
        if (mode === 'active') syncCameraProfile(step.state.video);

        recordTelemetry('sample', compactSample(sample, step));
        if (step.action) {
          const applied = mode === 'active';
          recordTelemetry('action', { action: step.action, applied, reasons: step.verdict.reasons });
          diagEvent('load-governor', { action: step.action, applied, reasons: step.verdict.reasons });
          if (applied) await applyAction(step.action);
        }
        if (showPanel) setLastStep({ ...step, sample });
      } finally {
        running = false;
      }
    }, SAMPLE_MS);

    return () => {
      clearInterval(sampleTimer);
      clearInterval(lagTimer);
      longTaskObserver?.disconnect();
      unsubscribe();
      recordTelemetry('governor-stop', {});
      stopTelemetry();
    };
  }, [mode, roomId, room, localParticipant, applyAction, syncCameraProfile, showPanel]);

  const dismissCameraOffNotice = useCallback(() => setCameraOffNotice(null), []);

  return { mode, showPanel, lastStep, cameraOffNotice, dismissCameraOffNotice };
}

/** One telemetry line per sample: short keys, rounded numbers (it's every 2s for the whole call). */
function compactSample(s: LoadSample, step: GovernorStep) {
  const r1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);
  const st = step.state;
  return {
    p: step.verdict.pressure,
    r: step.verdict.reasons.length ? step.verdict.reasons : undefined,
    lv: `${st.bgDowngraded ? 'b' : ''}${st.video}${st.cameraOffByGovernor ? 'x' : ''}`,
    vis: s.visible ? undefined : 0,
    cam: s.cameraOn ? 1 : 0,
    sh: s.sharing ? 1 : undefined,
    enc: s.encoderCpuFraction === undefined ? undefined : Math.round(s.encoderCpuFraction * 100) / 100,
    lag: Math.round(s.mainLagMaxMs),
    lt: Math.round(s.longTaskMsPerSec),
    bgf: r1(s.bgFps),
    bge: s.bgExpectedFps === undefined ? undefined : Math.round(s.bgExpectedFps),
    bgc: r1(s.bgCostMs),
    ac: s.audioChunks || undefined,
    as: s.audioStressedChunks || undefined,
    ap: s.audioPassthroughChunks || undefined,
    au: s.audioUnderruns || undefined,
    // Receiving side (not judged yet): streams, decoded fps, decode ms/frame, dropped/s, freezes, tallest.
    rv: s.recv?.streams || undefined,
    rfps: s.recv?.streams ? r1(s.recv.decodedFps) : undefined,
    rdec: s.recv?.streams ? r1(s.recv.decodeMsPerFrame) : undefined,
    rdrop: s.recv?.droppedPerSec ? r1(s.recv.droppedPerSec) : undefined,
    rfrz: s.recv?.freezes || undefined,
    rh: s.recv?.streams ? s.recv.maxHeight : undefined,
    // React re-rendering the call screen: passes/s, ms/s, slowest pass ms.
    rr: s.render?.perSec ? r1(s.render.perSec) : undefined,
    rms: s.render?.perSec ? r1(s.render.msPerSec) : undefined,
    rmax: s.render?.perSec ? r1(s.render.maxMs) : undefined,
  };
}
