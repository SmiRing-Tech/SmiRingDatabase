import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { Track, TrackEvent, type LocalVideoTrack } from 'livekit-client';
import { subscribeLoadSignals } from '../../../lib/loadSignals';
import { takeRenderMeter } from '../../../lib/renderMeter';
import { activeVoiceFinish } from '../../../lib/audio/voiceFinish';
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
  type NetStats,
  type ReceiveLevel,
  type SendStats,
  type ReceiveStats,
  type VideoLevel,
  type VideoProfile,
} from './governorPolicy';
import { ReceiveFpsController, type CameraFps } from './receiveFpsController';
import { keepTemporalLayers } from './temporalLayers';
import { currentShareCodec, setShareFloor, switchShareToVp8 } from '../../../lib/video/screenShare';

/**
 * Watches how the machine is coping during a call and lightens the camera side when it isn't
 * (see governorPolicy.ts for the ladder and the rules). Every sample and decision also goes to
 * the always-on telemetry, so thresholds can be tuned from real calls.
 *
 * Per-device switch, for calibrating on a machine without it touching anything:
 *   localStorage.setItem('smiring.debug.loadGovernor', 'observe')  // judge and record, never act
 *   localStorage.setItem('smiring.debug.loadGovernor', 'off')      // nothing at all
 *   localStorage.setItem('smiring.debug.loadPanel', '1')           // live readout on screen
 *   localStorage.setItem('smiring.debug.recvLevel', '1')           // force receive level 1, 2 or 3
 *                                                                  // (to see/test it; load ignored)
 *   localStorage.setItem('smiring.debug.forceShareStep', '1')      // 10s into a share: AV1 -> VP8
 *                                                                  // ('2': then 720p too), load ignored
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

/** Share fallback steps forced by the debug flag (1: AV1 -> VP8, 2: and then 720p), or 0. */
function forcedShareStep(): 0 | 1 | 2 {
  const value = readFlag('smiring.debug.forceShareStep');
  return value === '1' ? 1 : value === '2' ? 2 : 0;
}
const FORCED_SHARE_STEP_AFTER_MS = 10_000;

/** Receive level forced by the debug flag, or null. */
function forcedReceiveLevel(): ReceiveLevel | null {
  const value = readFlag('smiring.debug.recvLevel');
  return value === '1' ? 1 : value === '2' ? 2 : value === '3' ? 3 : null;
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
  /** The receiving steps' controller, while the sampling loop runs. */
  const recvControllerRef = useRef<ReceiveFpsController | null>(null);
  const [forcedRecv] = useState(forcedReceiveLevel);

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
      if (action.kind === 'recv') {
        // No notice: it only changes what this person sees, and only the small tiles first.
        if (forcedRecv === null) recvControllerRef.current?.setLevel(action.level);
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
      if (action.kind === 'share-vp8') {
        const ok = await switchShareToVp8(localParticipant).catch((err) => {
          console.warn('[governor] could not switch the screen share to VP8:', err);
          return false;
        });
        if (ok) onNoticeRef.current('パソコンの負荷が高いため、画面共有を軽い方式に切り替えました。');
        return;
      }
      if (action.kind === 'share-720') {
        await setShareFloor(localParticipant, action.direction === 'down').catch((err) =>
          console.warn('[governor] could not change the screen share size:', err),
        );
        if (action.direction === 'down') {
          onNoticeRef.current('パソコンの負荷が高いため、画面共有の画質を下げています（負荷が下がると自動で戻ります）。');
        }
        return;
      }
      await localParticipant.setCameraEnabled(false);
      onCameraTurnedOffRef.current?.();
      setCameraOffNotice({ withBackground: action.withBackground });
    },
    [localParticipant, syncCameraProfile, forcedRecv],
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
    recordTelemetry('governor-start', { mode, ...(forcedRecv !== null ? { forcedRecv } : {}) });
    const recvController = new ReceiveFpsController();
    recvControllerRef.current = recvController;
    if (forcedRecv !== null) recvController.setLevel(forcedRecv);
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

    // What this device sends: per video (camera, screen share) its bitrate, tallest layer sent and
    // how much of the window its encoder was held back by CPU or by the uplink (from the
    // cumulative qualityLimitationDurations); and the publisher connection's throughput and
    // bandwidth estimate. Any local track's report carries the connection's candidate pair.
    const lastOutbound = new Map<string, { bytes: number; cpu: number; bandwidth: number; total: number }>();
    let lastPubPair: { bytes: number; at: number } | null = null;
    const sendCodecs = new Map<string, string>();
    const sendStats = async (seconds: number) => {
      let encoderCpu: number | undefined;
      let net: Pick<NetStats, 'upKbps' | 'bweKbps' | 'rttMs'> = {};
      let pairRead = false; // the connection's pair, read once per sample from whichever sender has it
      const perSource: Partial<Record<'camera' | 'share', SendStats>> = {};
      for (const [key, source] of [
        ['camera', Track.Source.Camera],
        ['share', Track.Source.ScreenShare],
        ['mic', Track.Source.Microphone],
      ] as const) {
        const sender = localParticipant.getTrackPublication(source)?.track?.sender;
        if (!sender) continue;
        const report = await sender.getStats();
        const stats = [...report.values()];
        if (!pairRead) {
          const pair = stats.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
          if (pair) {
            pairRead = true;
            const now = performance.now();
            const bytes = pair.bytesSent ?? 0;
            if (lastPubPair && bytes >= lastPubPair.bytes) {
              net = {
                upKbps: ((bytes - lastPubPair.bytes) * 8) / (now - lastPubPair.at),
                bweKbps: typeof pair.availableOutgoingBitrate === 'number' ? pair.availableOutgoingBitrate / 1000 : undefined,
                rttMs: typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : undefined,
              };
            }
            lastPubPair = { bytes, at: now };
          }
        }
        if (key === 'mic') continue;
        const send: SendStats = { kbps: 0, height: 0, fps: 0 };
        let worstCpu: number | undefined;
        let worstBandwidth: number | undefined;
        for (const stat of stats) {
          if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') continue;
          const codec = stat.codecId ? report.get(stat.codecId)?.mimeType : undefined;
          if (typeof codec === 'string' && sendCodecs.get(key) !== codec) {
            sendCodecs.set(key, codec);
            recordTelemetry('send-codec', { source: key, codec });
          }
          const durations = stat.qualityLimitationDurations as Record<string, number> | undefined;
          const total = durations ? Object.values(durations).reduce((sum, v) => sum + v, 0) : 0;
          const now = { bytes: stat.bytesSent ?? 0, cpu: durations?.cpu ?? 0, bandwidth: durations?.bandwidth ?? 0, total };
          const prev = lastOutbound.get(stat.id);
          lastOutbound.set(stat.id, now);
          if (stat.active === false) continue;
          if (prev && now.bytes >= prev.bytes) send.kbps += ((now.bytes - prev.bytes) * 8) / 1000 / seconds;
          if ((stat.frameHeight ?? 0) > send.height) {
            send.height = stat.frameHeight ?? 0;
            send.fps = stat.framesPerSecond ?? 0;
          }
          let cpu: number | undefined;
          let bandwidth: number | undefined;
          if (durations && prev && total > prev.total) {
            cpu = (now.cpu - prev.cpu) / (total - prev.total);
            bandwidth = (now.bandwidth - prev.bandwidth) / (total - prev.total);
          } else if (!durations && typeof stat.qualityLimitationReason === 'string') {
            cpu = stat.qualityLimitationReason === 'cpu' ? 1 : 0;
            bandwidth = stat.qualityLimitationReason === 'bandwidth' ? 1 : 0;
          }
          if (cpu !== undefined) worstCpu = Math.max(worstCpu ?? 0, cpu);
          if (bandwidth !== undefined) worstBandwidth = Math.max(worstBandwidth ?? 0, bandwidth);
        }
        send.cpuLimited = worstCpu;
        send.bandwidthLimited = worstBandwidth;
        if (worstCpu !== undefined) encoderCpu = Math.max(encoderCpu ?? 0, worstCpu);
        if (send.height > 0 || send.kbps > 0) perSource[key] = send;
      }
      return { encoderCpu, net, camera: perSource.camera, share: perSource.share };
    };

    // Receiving side: decode work for everyone else's video, from each remote track's receiver.
    const lastInbound = new Map<string, { decoded: number; decodeTime: number; dropped: number; freezes: number }>();
    let lastSubPair: { bytes: number; at: number } | null = null;
    let downKbps: number | undefined;
    let subPairRead = false;
    const decoders = new Set<string>();
    const receiveStats = async (seconds: number, cameras: CameraFps[]): Promise<ReceiveStats> => {
      const result: ReceiveStats = { streams: 0, decodedFps: 0, droppedPerSec: 0, freezes: 0, maxHeight: 0 };
      downKbps = undefined;
      subPairRead = false;
      let decodedTotal = 0;
      let decodeTimeTotal = 0;
      const seen = new Set<string>();
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.videoTrackPublications.values()) {
          const receiver = publication.isSubscribed ? (publication.track as { receiver?: RTCRtpReceiver } | undefined)?.receiver : undefined;
          if (!receiver) continue;
          const report = await receiver.getStats();
          report.forEach((stat) => {
            if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded' && !subPairRead) {
              subPairRead = true;
              const at = performance.now();
              const bytes = stat.bytesReceived ?? 0;
              if (lastSubPair && bytes >= lastSubPair.bytes && at > lastSubPair.at) {
                downKbps = ((bytes - lastSubPair.bytes) * 8) / (at - lastSubPair.at);
              }
              lastSubPair = { bytes, at };
            }
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
            const fresh = !prev || now.decoded < prev.decoded;
            if (publication.source === Track.Source.Camera || publication.source === Track.Source.ScreenShare) {
              cameras.push({ publication, decodedFps: fresh ? 0 : (now.decoded - prev.decoded) / seconds });
            }
            if (fresh) return;
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
    const forceShare = forcedShareStep();
    let sharingSince: number | null = null;
    takeRenderMeter(); // drop whatever was counted before this call's first window
    const sampleTimer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const now = performance.now();
        const bg = backgroundRef.current;
        const seconds = Math.max(0.001, (now - lastSampleAt) / 1000);
        const sent = await sendStats(seconds).catch(() => undefined);
        const cameras: CameraFps[] = [];
        const recv = await receiveStats(seconds, cameras).catch(() => undefined);
        recvController.update(cameras);
        await keepTemporalLayers(cameraTrack()).catch(() => {});
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
          encoderCpuFraction: sent?.encoderCpu,
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
          recvControl: recvController.stats(),
          net: { ...sent?.net, downKbps },
          cameraSend: sent?.camera,
          shareSend: sent?.share,
          leveler: activeVoiceFinish()?.levelerWindow(SAMPLE_MS) ?? undefined,
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
        const recvRelief = {
          1: recvController.wouldRelieve(1),
          2: recvController.wouldRelieve(2),
          3: recvController.wouldRelieve(3),
        };
        const shareCodec = currentShareCodec(localParticipant);
        const ctx =
          mode === 'active'
            ? { bgQuality: actualQuality, cameraOn: sample.cameraOn, recvRelief, shareCodec }
            : {
                bgQuality: actualQuality === 'high' && state.bgDowngraded ? ('balanced' as const) : actualQuality,
                cameraOn: sample.cameraOn && !state.cameraOffByGovernor,
                recvRelief,
                shareCodec: shareCodec === 'av1' && state.shareVp8 ? ('vp8' as const) : shareCodec,
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
        // Debug: walk the share's fallback steps on a timer, whatever the load (see the header).
        if (forceShare && shareCodec) {
          sharingSince ??= now;
          if (now - sharingSince >= FORCED_SHARE_STEP_AFTER_MS) {
            const st = stateRef.current;
            const forced: GovernorAction | null =
              shareCodec === 'av1' && !st.shareVp8
                ? { kind: 'share-vp8' }
                : forceShare === 2 && shareCodec !== 'av1' && !st.share720
                  ? { kind: 'share-720', direction: 'down' }
                  : null;
            if (forced) {
              stateRef.current = { ...st, shareVp8: st.shareVp8 || forced.kind === 'share-vp8', share720: st.share720 || forced.kind === 'share-720' };
              recordTelemetry('action', { action: forced, applied: true, reasons: ['forced'] });
              await applyAction(forced);
              sharingSince = now;
            }
          }
        } else {
          sharingSince = null;
        }
        if (showPanel) setLastStep({ ...step, sample });
      } finally {
        running = false;
      }
    }, SAMPLE_MS);

    return () => {
      clearInterval(sampleTimer);
      recvController.dispose();
      recvControllerRef.current = null;
      clearInterval(lagTimer);
      longTaskObserver?.disconnect();
      unsubscribe();
      recordTelemetry('governor-stop', {});
      stopTelemetry();
    };
  }, [mode, roomId, room, localParticipant, applyAction, syncCameraProfile, showPanel, forcedRecv, cameraTrack]);

  const dismissCameraOffNotice = useCallback(() => setCameraOffNotice(null), []);

  return { mode, showPanel, lastStep, cameraOffNotice, dismissCameraOffNotice, forcedRecv };
}

/** One telemetry line per sample: short keys, rounded numbers (it's every 2s for the whole call). */
function compactSample(s: LoadSample, step: GovernorStep) {
  const r1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);
  const r0 = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? undefined : Math.round(v));
  // Fractions only when non-zero: most windows aren't limited at all.
  const frac = (v: number | undefined) => (v ? Math.round(v * 100) / 100 : undefined);
  const st = step.state;
  return {
    p: step.verdict.pressure,
    r: step.verdict.reasons.length ? step.verdict.reasons : undefined,
    lv: `${st.bgDowngraded ? 'b' : ''}${st.video}${st.recv ? `r${st.recv}` : ''}${st.shareVp8 ? 'v' : ''}${st.share720 ? 's' : ''}${
      st.cameraOffByGovernor ? 'x' : ''
    }`,
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
    // Network: up/down kbps, uplink estimate kbps, round trip ms.
    up: r0(s.net?.upKbps),
    down: r0(s.net?.downKbps),
    bwe: r0(s.net?.bweKbps),
    rtt: r0(s.net?.rttMs),
    // Camera / screen share sent: kbps, tallest layer px, its fps, uplink- and CPU-limited share.
    ck: r0(s.cameraSend?.kbps),
    ch: s.cameraSend?.height || undefined,
    cbw: frac(s.cameraSend?.bandwidthLimited),
    sk: r0(s.shareSend?.kbps),
    shh: s.shareSend?.height || undefined,
    sfps: r1(s.shareSend?.fps),
    sbw: frac(s.shareSend?.bandwidthLimited),
    scpu: frac(s.shareSend?.cpuLimited),
    // Voice leveler: gain avg/max dB, speaking share, input speech level and noise floor dBFS.
    lg: r1(s.leveler?.gainAvgDb),
    lgx: r1(s.leveler?.gainMaxDb),
    lsp: s.leveler ? Math.round(s.leveler.speakingFraction * 100) / 100 : undefined,
    lsd: r1(s.leveler?.speechDb ?? undefined),
    lfl: r1(s.leveler?.floorDb),
    // Receiving steps: cameras asked for fewer frames, cameras found without temporal layers.
    rthr: s.recvControl?.throttled || undefined,
    rnl: s.recvControl?.noLayers || undefined,
    // React re-rendering the call screen: passes/s, ms/s, slowest pass ms.
    rr: s.render?.perSec ? r1(s.render.perSec) : undefined,
    rms: s.render?.perSec ? r1(s.render.msPerSec) : undefined,
    rmax: s.render?.perSec ? r1(s.render.maxMs) : undefined,
  };
}
