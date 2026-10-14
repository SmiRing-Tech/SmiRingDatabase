import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { ConnectionQuality, RoomEvent, Track, type LocalVideoTrack, type Participant, type Room } from 'livekit-client';
import { cameraSourceTrack } from '../../lib/video/backgroundProcessor';
import {
  collectDiagProbes,
  diagEvent,
  diagSample,
  diagState,
  isDiagnosticsRecording,
} from '../../lib/connectDiagnostics';

/**
 * Opt-in call diagnostics, for working out *why* a call degrades before changing codecs or
 * encoder settings — "encoder starved of CPU", "encoder dropping frames after a full-screen
 * change (a slide switch)", "uplink too thin" and "audio stuck behind congested video" all
 * have different fixes.
 *
 * Off unless this browser has the flag set (in DevTools):
 *   localStorage.setItem('smiring.debug.shareStats', '1')   // on, takes effect within 2s
 *   localStorage.removeItem('smiring.debug.shareStats')     // off
 * (Named for its first job, screen-share stats; kept so the same commands keep working.)
 * Every 2s it logs one console line per stream below and appends the same data to
 * `window.__smiringShareStats` — `copy(JSON.stringify(window.__smiringShareStats))` puts the
 * whole session on the clipboard. History is per window: export from each participant's.
 *
 *  - `net`: total up/down bitrate for this browser, the uplink bandwidth estimate (BWE) and
 *    round-trip time — the context everything else is read against.
 *  - `send` (this browser's screen share, one per simulcast layer): capture vs sent fps,
 *    bitrate, `qualityLimitationReason` (cpu / bandwidth / none), encode time per frame,
 *    `hugeFramesSent` (frames > 2.5x the average size — i.e. slide switches), and which encoder
 *    is in use (hardware or not).
 *  - `recv` (everyone else's screen share): `freezeCount`/`totalFreezesDuration` — Chrome's own
 *    measure of "the picture visibly stopped" — plus dropped frames, jitter-buffer delay, loss.
 *  - `audio-send` (this browser's mic): bitrate, loss/RTT on the way to the server, and the level
 *    actually handed to the encoder (`levelDb`, see audioLevelDb).
 *  - `audio-recv` (everyone else's mic): the share of audio the decoder had to *invent* to cover
 *    gaps (concealment — what choppy audio actually is), packet loss, jitter-buffer delay, and
 *    the level as decoded here (`levelDb`).
 *  - `cam-send` / `cam-recv`: the same as `send` / `recv`, for cameras instead of screen shares.
 *  - `room`: how many participants / subscribed videos this browser is handling.
 *
 * The same samples also feed the in-call diagnostics recorder (lib/connectDiagnostics, the
 * "通話の診断" button) whenever it's recording — no DevTools needed, and nothing is printed to
 * the console unless the flag above is also set. This hook also reports the room events and
 * local media state that recorder puts on its timeline.
 */
const FLAG_KEY = 'smiring.debug.shareStats';
const INTERVAL_MS = 2000;
/** Cap on exported samples, so a long session can't grow without bound. */
const HISTORY_LIMIT = 5000;

type Stat = Record<string, unknown>;
type Stats = Map<string, Stat>;

const num = (s: Stat | undefined, k: string): number | undefined =>
  typeof s?.[k] === 'number' ? (s[k] as number) : undefined;
const str = (s: Stat | undefined, k: string): string | undefined =>
  typeof s?.[k] === 'string' ? (s[k] as string) : undefined;

const round = (n: number | undefined, digits = 0) =>
  n === undefined || !Number.isFinite(n) ? undefined : Number(n.toFixed(digits));

function isConsoleEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function record(entry: Record<string, unknown>) {
  const w = window as unknown as { __smiringShareStats?: unknown[] };
  const history = (w.__smiringShareStats ??= []);
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}

let consoleOutput = false;

function emit(entry: Record<string, unknown> & { t: number }, line: string, warn: boolean) {
  diagSample(entry);
  if (!consoleOutput) return;
  record(entry);
  if (warn) console.warn(line);
  else console.log(line);
}

const toMap = (report: RTCStatsReport): Stats => {
  const all: Stats = new Map();
  report.forEach((s: Stat) => all.set(s.id as string, s));
  return all;
};

function codecOf(stats: Stats, s: Stat): string | undefined {
  const codecId = str(s, 'codecId');
  return codecId ? str(stats.get(codecId), 'mimeType') : undefined;
}

function implLabel(name: string | undefined, powerEfficient: unknown): string {
  const hw = powerEfficient === true ? 'hw' : powerEfficient === false ? 'sw' : '?';
  return `${name ?? '?'}(${hw})`;
}

/**
 * Mean level over the interval, from a stats object's cumulative totalAudioEnergy /
 * totalSamplesDuration (media-source on the send side, inbound-rtp on the receive side).
 *
 * Two things to know when reading it: it averages over everything, pauses included, so it
 * reads lower the more someone pauses (a closed VAD gate reads as silence); and libwebrtc
 * builds totalAudioEnergy from each 10ms frame's *peak*, not its RMS, so it sits several dB
 * above an RMS figure. Compare it across participants and between send and receive — not
 * against /dev/audio-gain-lab's speech levels, which are RMS-based and leave pauses out.
 */
function audioLevelDb(d: Deltas, s: Stat | undefined): number | undefined {
  if (!s) return undefined;
  const energy = d.of(s, 'totalAudioEnergy');
  const duration = d.of(s, 'totalSamplesDuration');
  if (energy === undefined || !duration) return undefined;
  return round(energy > 0 ? Math.max(-100, 10 * Math.log10(energy / duration)) : -100, 1);
}

const selectedPair = (stats: Stats) =>
  [...stats.values()].find((s) => s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded');

/**
 * Remembers the previous sample of each stats object, to turn cumulative counters into
 * per-interval deltas. One instance per peer connection (LiveKit publishes on one and
 * subscribes on another): stats ids are only unique within a single RTCPeerConnection, and
 * the two can reuse the same ids.
 */
class Deltas {
  private prev = new Map<string, Stat>();

  /** Change in counter `k` since the previous sample of `cur`. */
  of(cur: Stat, k: string): number | undefined {
    const a = num(cur, k);
    const b = num(this.prev.get(cur.id as string), k);
    return a === undefined || b === undefined ? undefined : a - b;
  }

  seconds(cur: Stat): number {
    return (this.of(cur, 'timestamp') ?? NaN) / 1000;
  }

  kbps(cur: Stat, bytesKey: string): number | undefined {
    return round(((this.of(cur, bytesKey) ?? NaN) * 8) / this.seconds(cur) / 1000);
  }

  remember(cur: Stat) {
    this.prev.set(cur.id as string, cur);
  }
}

function logNet(pub: Stats | undefined, sub: Stats | undefined, d: { pub: Deltas; sub: Deltas }, now: number) {
  const pubPair = pub && selectedPair(pub);
  const subPair = sub && selectedPair(sub);
  if (!pubPair && !subPair) return;
  const entry = {
    t: now,
    dir: 'net',
    upKbps: pubPair ? d.pub.kbps(pubPair, 'bytesSent') : undefined,
    bweKbps: round((num(pubPair, 'availableOutgoingBitrate') ?? NaN) / 1000),
    downKbps: subPair ? d.sub.kbps(subPair, 'bytesReceived') : undefined,
    rttPubMs: round((num(pubPair, 'currentRoundTripTime') ?? NaN) * 1000),
    rttSubMs: round((num(subPair, 'currentRoundTripTime') ?? NaN) * 1000),
  };
  if (pubPair) d.pub.remember(pubPair);
  if (subPair) d.sub.remember(subPair);
  const nearCap = entry.upKbps !== undefined && entry.bweKbps !== undefined && entry.upKbps > entry.bweKbps * 0.9;
  emit(
    entry,
    `[stats net] up ${entry.upKbps ?? '?'}kbps (BWE ${entry.bweKbps ?? '?'}) | down ${entry.downKbps ?? '?'}kbps` +
      ` | rtt up ${entry.rttPubMs ?? '?'}ms / down ${entry.rttSubMs ?? '?'}ms`,
    nearCap,
  );
}

type VideoKind = 'screen' | 'camera';

function logVideoSend(stats: Stats, d: Deltas, now: number, kind: VideoKind) {
  const dir = kind === 'screen' ? 'send' : 'cam-send';
  const values = [...stats.values()];
  const source = values.find((s) => s.type === 'media-source' && s.kind === 'video');
  const captureFps = round(num(source, 'framesPerSecond'), 1);

  for (const out of values.filter((s) => s.type === 'outbound-rtp' && s.kind === 'video')) {
    const encoded = d.of(out, 'framesEncoded');
    const remote = values.find((s) => s.type === 'remote-inbound-rtp' && s.localId === out.id);
    const entry = {
      t: now,
      dir,
      rid: str(out, 'rid') ?? '-',
      active: out.active,
      size: `${num(out, 'frameWidth') ?? '?'}x${num(out, 'frameHeight') ?? '?'}`,
      sentFps: round(num(out, 'framesPerSecond'), 1),
      captureFps,
      kbps: d.kbps(out, 'bytesSent'),
      hugeFrames: d.of(out, 'hugeFramesSent'),
      encodeMs: encoded ? round(((d.of(out, 'totalEncodeTime') ?? NaN) / encoded) * 1000, 1) : undefined,
      limit: str(out, 'qualityLimitationReason'),
      codec: codecOf(stats, out),
      encoder: implLabel(str(out, 'encoderImplementation'), out.powerEfficientEncoder),
      rttMs: round((num(remote, 'roundTripTime') ?? NaN) * 1000),
      lossPct: round((num(remote, 'fractionLost') ?? NaN) * 100, 1),
    };
    d.remember(out);
    if (entry.active === false) {
      // A layer nobody is subscribed to: dynacast paused it, so it isn't being encoded. Still
      // recorded (compactly) for diagnostics — otherwise a paused layer is indistinguishable
      // from a missing sample — but kept out of the console.
      diagSample({ t: now, dir, rid: entry.rid, active: false, codec: entry.codec });
      continue;
    }
    emit(
      entry,
      `[stats ${dir} ${entry.rid}] ${entry.size} sent ${entry.sentFps ?? '?'}fps / capture ${entry.captureFps ?? '?'}fps` +
        ` | ${entry.kbps ?? '?'}kbps | huge+${entry.hugeFrames ?? '?'} | enc ${entry.encodeMs ?? '?'}ms` +
        ` | limit=${entry.limit ?? '?'} | ${entry.codec ?? '?'} ${entry.encoder}` +
        ` | rtt ${entry.rttMs ?? '?'}ms loss ${entry.lossPct ?? '?'}%`,
      (entry.hugeFrames ?? 0) > 0 || (!!entry.limit && entry.limit !== 'none'),
    );
  }
}

function logVideoRecv(from: string, stats: Stats, d: Deltas, now: number, kind: VideoKind) {
  const dir = kind === 'screen' ? 'recv' : 'cam-recv';
  for (const inb of [...stats.values()].filter((s) => s.type === 'inbound-rtp' && s.kind === 'video')) {
    const emitted = d.of(inb, 'jitterBufferEmittedCount');
    const entry = {
      t: now,
      dir,
      from,
      size: `${num(inb, 'frameWidth') ?? '?'}x${num(inb, 'frameHeight') ?? '?'}`,
      fps: round(num(inb, 'framesPerSecond'), 1),
      freezes: d.of(inb, 'freezeCount'),
      freezeSec: round(d.of(inb, 'totalFreezesDuration'), 2),
      dropped: d.of(inb, 'framesDropped'),
      kbps: d.kbps(inb, 'bytesReceived'),
      jitterBufferMs: emitted ? round(((d.of(inb, 'jitterBufferDelay') ?? NaN) / emitted) * 1000) : undefined,
      lost: d.of(inb, 'packetsLost'),
      codec: codecOf(stats, inb),
      decoder: implLabel(str(inb, 'decoderImplementation'), inb.powerEfficientDecoder),
    };
    d.remember(inb);
    emit(
      entry,
      `[stats ${dir} ${from}] ${entry.size} ${entry.fps ?? '?'}fps` +
        ` | freezes+${entry.freezes ?? '?'} (${entry.freezeSec ?? '?'}s) | dropped+${entry.dropped ?? '?'}` +
        ` | ${entry.kbps ?? '?'}kbps | jb ${entry.jitterBufferMs ?? '?'}ms | lost+${entry.lost ?? '?'}` +
        ` | ${entry.codec ?? '?'} ${entry.decoder}`,
      (entry.freezes ?? 0) > 0,
    );
  }
}

function logAudioSend(stats: Stats, d: Deltas, now: number) {
  const values = [...stats.values()];
  const out = values.find((s) => s.type === 'outbound-rtp' && s.kind === 'audio');
  if (!out) return;
  const remote = values.find((s) => s.type === 'remote-inbound-rtp' && s.localId === out.id);
  const source = values.find((s) => s.type === 'media-source' && s.kind === 'audio');
  const entry = {
    t: now,
    dir: 'audio-send',
    kbps: d.kbps(out, 'bytesSent'),
    rttMs: round((num(remote, 'roundTripTime') ?? NaN) * 1000),
    lossPct: round((num(remote, 'fractionLost') ?? NaN) * 100, 1),
    jitterMs: round((num(remote, 'jitter') ?? NaN) * 1000),
    levelDb: audioLevelDb(d, source),
  };
  d.remember(out);
  if (source) d.remember(source);
  emit(
    entry,
    `[stats audio-send] ${entry.kbps ?? '?'}kbps | rtt ${entry.rttMs ?? '?'}ms loss ${entry.lossPct ?? '?'}% jitter ${entry.jitterMs ?? '?'}ms` +
      ` | level ${entry.levelDb ?? '?'}dB`,
    (entry.lossPct ?? 0) >= 2,
  );
}

function logAudioRecv(from: string, stats: Stats, d: Deltas, now: number) {
  const inb = [...stats.values()].find((s) => s.type === 'inbound-rtp' && s.kind === 'audio');
  if (!inb) return;
  const samples = d.of(inb, 'totalSamplesReceived');
  // Silent concealment is the decoder filling DTX gaps (deliberate silence suppression, see
  // `dtx` in roomOptions) — not lost speech — so it's left out of the choppiness figure.
  const concealed = (d.of(inb, 'concealedSamples') ?? NaN) - (d.of(inb, 'silentConcealedSamples') ?? 0);
  const emitted = d.of(inb, 'jitterBufferEmittedCount');
  const entry = {
    t: now,
    dir: 'audio-recv',
    from,
    concealedPct: samples ? round((concealed / samples) * 100, 1) : undefined,
    concealEvents: d.of(inb, 'concealmentEvents'),
    lost: d.of(inb, 'packetsLost'),
    jitterBufferMs: emitted ? round(((d.of(inb, 'jitterBufferDelay') ?? NaN) / emitted) * 1000) : undefined,
    kbps: d.kbps(inb, 'bytesReceived'),
    levelDb: audioLevelDb(d, inb),
  };
  d.remember(inb);
  emit(
    entry,
    `[stats audio-recv ${from}] concealed ${entry.concealedPct ?? '?'}% (events+${entry.concealEvents ?? '?'})` +
      ` | lost+${entry.lost ?? '?'} | jb ${entry.jitterBufferMs ?? '?'}ms | ${entry.kbps ?? '?'}kbps | level ${entry.levelDb ?? '?'}dB`,
    (entry.concealedPct ?? 0) >= 2,
  );
}

async function sample(room: Room, d: { pub: Deltas; sub: Deltas }) {
  const now = Date.now();
  const local = room.localParticipant;
  const micReport = await local.getTrackPublication(Track.Source.Microphone)?.track?.getRTCStatsReport();
  const shareReport = await local.getTrackPublication(Track.Source.ScreenShare)?.track?.getRTCStatsReport();
  const camReport = await local.getTrackPublication(Track.Source.Camera)?.track?.getRTCStatsReport();
  const mic = micReport && toMap(micReport);
  const share = shareReport && toMap(shareReport);
  const cam = camReport && toMap(camReport);

  // Any one track's report carries its whole peer connection's transport/candidate pair, so
  // whichever local track exists stands in for the publisher side, any remote one for the
  // subscriber side.
  const pubStats: Stats | undefined = mic ?? share ?? cam;
  let subStats: Stats | undefined;

  const remote: Array<{ from: string; mic?: Stats; share?: Stats; cam?: Stats }> = [];
  for (const participant of room.remoteParticipants.values()) {
    const from = participant.name || participant.identity;
    const micR = await participant.getTrackPublication(Track.Source.Microphone)?.track?.getRTCStatsReport();
    const shareR = await participant.getTrackPublication(Track.Source.ScreenShare)?.track?.getRTCStatsReport();
    const camR = await participant.getTrackPublication(Track.Source.Camera)?.track?.getRTCStatsReport();
    const entry = { from, mic: micR && toMap(micR), share: shareR && toMap(shareR), cam: camR && toMap(camR) };
    subStats ??= entry.mic ?? entry.share ?? entry.cam;
    remote.push(entry);
  }

  logNet(pubStats, subStats, d, now);
  if (mic) logAudioSend(mic, d.pub, now);
  if (share) logVideoSend(share, d.pub, now, 'screen');
  if (cam) logVideoSend(cam, d.pub, now, 'camera');
  for (const r of remote) {
    if (r.mic) logAudioRecv(r.from, r.mic, d.sub, now);
    if (r.share) logVideoRecv(r.from, r.share, d.sub, now, 'screen');
    if (r.cam) logVideoRecv(r.from, r.cam, d.sub, now, 'camera');
  }

  const entry = {
    t: now,
    dir: 'room',
    participants: participantCount(room),
    remoteCamerasReceived: remote.filter((r) => r.cam).length,
    remoteSharesReceived: remote.filter((r) => r.share).length,
  };
  emit(
    entry,
    `[stats room] ${entry.participants} participants | receiving ${entry.remoteCamerasReceived} cameras, ${entry.remoteSharesReceived} shares`,
    false,
  );
}

const captureLabel = (settings: MediaTrackSettings) =>
  `${settings.width ?? '?'}x${settings.height ?? '?'}@${settings.frameRate ? Math.round(settings.frameRate) : '?'}`;

/** The device's human-readable name. Looked up from the room's active device id rather than the
 *  track's own label: once a background processor is attached, the camera track is a generated
 *  one whose label is a random UUID. */
async function reportDeviceLabel(room: Room, kind: MediaDeviceKind, key: string) {
  const deviceId = room.getActiveDevice(kind);
  if (!deviceId) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const device = devices.find((d) => d.kind === kind && d.deviceId === deviceId);
    diagState(key, device?.label || deviceId);
  } catch {
    diagState(key, deviceId);
  }
}

/** Local camera/mic/share on-off, capture settings and device names, deduplicated by diagState. */
function reportLocalMediaState(room: Room) {
  const local = room.localParticipant;
  diagState('camera', local.isCameraEnabled);
  diagState('microphone', local.isMicrophoneEnabled);
  diagState('screenShare', local.isScreenShareEnabled);
  // The camera itself: with the background effect on, track.mediaStreamTrack is the effect's output.
  const cameraTrack = local.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
  const cam = cameraTrack ? cameraSourceTrack(cameraTrack) : undefined;
  if (cam && cam.readyState === 'live') diagState('cameraCapture', captureLabel(cam.getSettings()));
  const share = local.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
  if (share && share.readyState === 'live') diagState('screenShareCapture', captureLabel(share.getSettings()));
  void reportDeviceLabel(room, 'videoinput', 'cameraDevice');
  void reportDeviceLabel(room, 'audioinput', 'microphoneDevice');
}

/** Everyone in the call including this browser — counted locally, since the server-reported
 *  figure reads 0 until its first update arrives. */
const participantCount = (room: Room) => room.remoteParticipants.size + 1;

/** Puts the room's own events on the diagnostics timeline. Cheap enough to always listen —
 *  diagEvent/diagState are no-ops beyond a map write while nothing is recording. */
function useDiagnosticsRoomEvents(room: Room) {
  useEffect(() => {
    const syncLocal = () => reportLocalMediaState(room);
    const nameOf = (p: Participant) => p.name || p.identity;
    const onJoined = (p: Participant) => {
      diagEvent('participant-joined', { name: nameOf(p) });
      diagState('participants', participantCount(room));
    };
    const onLeft = (p: Participant) => {
      diagEvent('participant-left', { name: nameOf(p) });
      diagState('participants', participantCount(room));
    };
    const onQuality = (quality: ConnectionQuality, p: Participant) => {
      if (p.isLocal) diagState('connectionQuality', quality);
    };
    const onReconnecting = () => diagEvent('reconnecting');
    const onSignalReconnecting = () => diagEvent('signal-reconnecting');
    const onReconnected = () => diagEvent('reconnected');
    const onDisconnected = (reason?: unknown) => diagEvent('disconnected', { reason: String(reason ?? '') });
    const onDevice = (kind: MediaDeviceKind) => {
      diagEvent('device-changed', { kind });
      syncLocal();
    };

    syncLocal();
    diagState('participants', participantCount(room));
    room
      .on(RoomEvent.LocalTrackPublished, syncLocal)
      .on(RoomEvent.LocalTrackUnpublished, syncLocal)
      .on(RoomEvent.TrackMuted, syncLocal)
      .on(RoomEvent.TrackUnmuted, syncLocal)
      .on(RoomEvent.ParticipantConnected, onJoined)
      .on(RoomEvent.ParticipantDisconnected, onLeft)
      .on(RoomEvent.ConnectionQualityChanged, onQuality)
      .on(RoomEvent.Reconnecting, onReconnecting)
      .on(RoomEvent.SignalReconnecting, onSignalReconnecting)
      .on(RoomEvent.Reconnected, onReconnected)
      .on(RoomEvent.Disconnected, onDisconnected)
      .on(RoomEvent.ActiveDeviceChanged, onDevice);
    return () => {
      room
        .off(RoomEvent.LocalTrackPublished, syncLocal)
        .off(RoomEvent.LocalTrackUnpublished, syncLocal)
        .off(RoomEvent.TrackMuted, syncLocal)
        .off(RoomEvent.TrackUnmuted, syncLocal)
        .off(RoomEvent.ParticipantConnected, onJoined)
        .off(RoomEvent.ParticipantDisconnected, onLeft)
        .off(RoomEvent.ConnectionQualityChanged, onQuality)
        .off(RoomEvent.Reconnecting, onReconnecting)
        .off(RoomEvent.SignalReconnecting, onSignalReconnecting)
        .off(RoomEvent.Reconnected, onReconnected)
        .off(RoomEvent.Disconnected, onDisconnected)
        .off(RoomEvent.ActiveDeviceChanged, onDevice);
    };
  }, [room]);
}

export function useCallStatsLogger() {
  const room = useRoomContext();
  useDiagnosticsRoomEvents(room);

  useEffect(() => {
    const deltas = { pub: new Deltas(), sub: new Deltas() };
    let announced = false;
    let running = false;

    const tick = async () => {
      consoleOutput = isConsoleEnabled();
      const recording = isDiagnosticsRecording();
      if (!consoleOutput) announced = false;
      if (!consoleOutput && !recording) return;
      if (consoleOutput && !announced) {
        console.info(
          '[stats] on — samples every 2s; copy(JSON.stringify(window.__smiringShareStats)) to export',
        );
        announced = true;
      }
      if (running) return; // a slow getStats() must not pile up overlapping samples
      running = true;
      try {
        await sample(room, deltas);
      } catch (e) {
        console.warn('[stats] sample failed:', e);
      } finally {
        // Outside the try: the probes (GTCRN backlog, main-thread stalls, ...) matter most
        // exactly when things are going wrong, including a getStats() that just threw.
        collectDiagProbes(Date.now());
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [room]);
}
