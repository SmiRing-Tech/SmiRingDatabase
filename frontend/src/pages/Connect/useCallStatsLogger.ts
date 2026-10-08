import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { Track, type Room } from 'livekit-client';

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
 *  - `audio-send` (this browser's mic): bitrate, and loss/RTT on the way to the server.
 *  - `audio-recv` (everyone else's mic): the share of audio the decoder had to *invent* to cover
 *    gaps (concealment — what choppy audio actually is), packet loss, jitter-buffer delay.
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

function isEnabled(): boolean {
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

function emit(entry: Record<string, unknown>, line: string, warn: boolean) {
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

function logShareSend(stats: Stats, d: Deltas, now: number) {
  const values = [...stats.values()];
  const source = values.find((s) => s.type === 'media-source' && s.kind === 'video');
  const captureFps = round(num(source, 'framesPerSecond'), 1);

  for (const out of values.filter((s) => s.type === 'outbound-rtp' && s.kind === 'video')) {
    const encoded = d.of(out, 'framesEncoded');
    const remote = values.find((s) => s.type === 'remote-inbound-rtp' && s.localId === out.id);
    const entry = {
      t: now,
      dir: 'send',
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
    if (entry.active === false) continue; // a layer nobody is subscribed to (dynacast paused it)
    emit(
      entry,
      `[stats send ${entry.rid}] ${entry.size} sent ${entry.sentFps ?? '?'}fps / capture ${entry.captureFps ?? '?'}fps` +
        ` | ${entry.kbps ?? '?'}kbps | huge+${entry.hugeFrames ?? '?'} | enc ${entry.encodeMs ?? '?'}ms` +
        ` | limit=${entry.limit ?? '?'} | ${entry.codec ?? '?'} ${entry.encoder}` +
        ` | rtt ${entry.rttMs ?? '?'}ms loss ${entry.lossPct ?? '?'}%`,
      (entry.hugeFrames ?? 0) > 0 || (!!entry.limit && entry.limit !== 'none'),
    );
  }
}

function logShareRecv(from: string, stats: Stats, d: Deltas, now: number) {
  for (const inb of [...stats.values()].filter((s) => s.type === 'inbound-rtp' && s.kind === 'video')) {
    const emitted = d.of(inb, 'jitterBufferEmittedCount');
    const entry = {
      t: now,
      dir: 'recv',
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
      `[stats recv ${from}] ${entry.size} ${entry.fps ?? '?'}fps` +
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
  const entry = {
    t: now,
    dir: 'audio-send',
    kbps: d.kbps(out, 'bytesSent'),
    rttMs: round((num(remote, 'roundTripTime') ?? NaN) * 1000),
    lossPct: round((num(remote, 'fractionLost') ?? NaN) * 100, 1),
    jitterMs: round((num(remote, 'jitter') ?? NaN) * 1000),
  };
  d.remember(out);
  emit(
    entry,
    `[stats audio-send] ${entry.kbps ?? '?'}kbps | rtt ${entry.rttMs ?? '?'}ms loss ${entry.lossPct ?? '?'}% jitter ${entry.jitterMs ?? '?'}ms`,
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
  };
  d.remember(inb);
  emit(
    entry,
    `[stats audio-recv ${from}] concealed ${entry.concealedPct ?? '?'}% (events+${entry.concealEvents ?? '?'})` +
      ` | lost+${entry.lost ?? '?'} | jb ${entry.jitterBufferMs ?? '?'}ms | ${entry.kbps ?? '?'}kbps`,
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

  // Any one track's report carries its whole peer connection's transport/candidate pair, so
  // whichever local track exists stands in for the publisher side, any remote one for the
  // subscriber side.
  const pubStats: Stats | undefined = mic ?? share ?? (camReport && toMap(camReport));
  let subStats: Stats | undefined;

  const remote: Array<{ from: string; mic?: Stats; share?: Stats }> = [];
  for (const participant of room.remoteParticipants.values()) {
    const from = participant.name || participant.identity;
    const micR = await participant.getTrackPublication(Track.Source.Microphone)?.track?.getRTCStatsReport();
    const shareR = await participant.getTrackPublication(Track.Source.ScreenShare)?.track?.getRTCStatsReport();
    const entry = { from, mic: micR && toMap(micR), share: shareR && toMap(shareR) };
    subStats ??= entry.mic ?? entry.share;
    remote.push(entry);
  }
  if (!subStats) {
    for (const participant of room.remoteParticipants.values()) {
      const camR = await participant.getTrackPublication(Track.Source.Camera)?.track?.getRTCStatsReport();
      if (camR) {
        subStats = toMap(camR);
        break;
      }
    }
  }

  logNet(pubStats, subStats, d, now);
  if (mic) logAudioSend(mic, d.pub, now);
  if (share) logShareSend(share, d.pub, now);
  for (const r of remote) {
    if (r.mic) logAudioRecv(r.from, r.mic, d.sub, now);
    if (r.share) logShareRecv(r.from, r.share, d.sub, now);
  }
}

export function useCallStatsLogger() {
  const room = useRoomContext();

  useEffect(() => {
    const deltas = { pub: new Deltas(), sub: new Deltas() };
    let announced = false;
    let running = false;

    const tick = async () => {
      if (!isEnabled()) {
        announced = false;
        return;
      }
      if (!announced) {
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
        running = false;
      }
    };

    const timer = setInterval(() => void tick(), INTERVAL_MS);
    return () => clearInterval(timer);
  }, [room]);
}
