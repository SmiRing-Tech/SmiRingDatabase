import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createLocalVideoTrack,
  LocalVideoTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  VideoQuality,
  type VideoCaptureOptions,
  type VideoCodec,
} from 'livekit-client';
import { apiClient } from '../../lib/apiClient';
import { VIDEO_CAPTURE_CONSTRAINTS } from '../../components/Connect/captureConstraints';
import { isMobileDevice } from '../Connect/backgroundLibrary';

/**
 * Temporal-layer bench: can a receiver ask the SFU for fewer frames (RemoteTrackPublication
 * .setVideoFPS) and decode less, without the sender changing anything?
 *
 * That only works when the sender's stream carries temporal layers (VP8 L1T3: T0 = every 4th
 * frame and refers only to T0, T1 refers only to T0, T2 is never referenced — so the SFU can drop
 * T2, or T1+T2, and the rest still decodes). Every device joins the same test room and publishes
 * its camera the way the app does; the page shows what each sender actually encodes
 * (scalabilityMode from the outbound stats) and lets each receiver step its requested fps down
 * while measuring frames decoded and decode time.
 *
 * Login required (it mints a normal Connect token). Dynacast and adaptiveStream are off so the
 * requested layer is exactly what the buttons say.
 */

const DESKTOP_VIDEO_ENCODING = { ...VideoPresets.h720.encoding, maxFramerate: 20 };
/**
 * The SFU picks the lowest temporal layer whose *measured* fps is at least the request, and a
 * 20fps camera's layers measure a bit under 5/10/20 — so asking for exactly 10 got the 20fps layer
 * (first run). Ask below each layer instead: 6 → the half-rate layer, 1 → the quarter-rate one.
 */
const FPS_STEPS = [
  { request: 60, label: '全部' },
  { request: 6, label: '半分' },
  { request: 1, label: '4分の1' },
] as const;
/**
 * The automatic test sweeps every request instead: asking for 6 still got 20fps and 5 got 10, so
 * the SFU's per-layer fps estimate isn't what the layers actually deliver. This maps it out.
 */
const SWEEP = [60, 8, 5, 4, 3, 2, 1] as const;

type OutboundRow = {
  rid: string;
  size: string;
  fps: number;
  mode: string;
  requested: string;
  encodeMs: number;
  encoder: string;
  limit: string;
};

type InboundRow = {
  fps: number;
  size: string;
  decodeMsPerFrame: number;
  decodeMsPerSec: number;
  kbps: number;
  dropped: number;
  freezes: number;
  decoder: string;
};

type Remote = { key: string; name: string; publication: RemoteTrackPublication; track: RemoteVideoTrack };

type Counters = { at: number; decoded: number; decodeTime: number; bytes: number; dropped: number; freezes: number };

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  return 'PC';
}

function browserName() {
  const ua = navigator.userAgent;
  return ua.match(/(Edg|CriOS|Chrome|Firefox|Version)\/[\d.]+/)?.[0]?.replace('Version', 'Safari') ?? '?';
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');

export default function TemporalLayerLabPage() {
  const [roomName, setRoomName] = useState('lab-temporal-test');
  const [deviceName, setDeviceName] = useState(guessDeviceName);
  const [codec, setCodec] = useState<VideoCodec>('vp8');
  const [forceT3, setForceT3] = useState(false);
  const [status, setStatus] = useState('未接続');
  const [room, setRoom] = useState<Room | null>(null);
  const [localTrack, setLocalTrack] = useState<LocalVideoTrack | null>(null);
  const [outbound, setOutbound] = useState<OutboundRow[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [inbound, setInbound] = useState<Record<string, InboundRow>>({});
  const [requestedFps, setRequestedFps] = useState<number | null>(null);
  const [quality, setQuality] = useState<VideoQuality>(VideoQuality.HIGH);
  const [testing, setTesting] = useState(false);
  const [report, setReport] = useState('');
  const localPreview = useRef<HTMLVideoElement>(null);
  const prevOut = useRef(new Map<string, { at: number; frames: number; encodeTime: number }>());
  const prevIn = useRef(new Map<string, Counters>());
  // Each remote's decoder over time: catches a hardware decoder falling back to software, and when.
  const decoderLog = useRef(new Map<string, { since: number; entries: string[] }>());
  const inboundRef = useRef(inbound);
  inboundRef.current = inbound;

  const refreshRemotes = useCallback((r: Room) => {
    const list: Remote[] = [];
    for (const p of r.remoteParticipants.values()) {
      for (const pub of p.videoTrackPublications.values()) {
        if (pub.source !== Track.Source.Camera || !(pub.track instanceof RemoteVideoTrack)) continue;
        list.push({ key: `${p.identity}:${pub.trackSid}`, name: p.name || p.identity.slice(0, 6), publication: pub, track: pub.track });
      }
    }
    setRemotes(list);
  }, []);

  const applyTemporalLayers = useCallback(async (track: LocalVideoTrack) => {
    const sender = track.sender;
    if (!sender) return 'sender なし';
    const params = sender.getParameters();
    for (const e of params.encodings) (e as RTCRtpEncodingParameters & { scalabilityMode?: string }).scalabilityMode = 'L1T3';
    try {
      await sender.setParameters(params);
      return 'L1T3 を設定';
    } catch (err) {
      return `L1T3 の設定に失敗: ${err instanceof Error ? err.message : String(err)}`;
    }
  }, []);

  const join = async () => {
    try {
      setStatus('トークン取得中…');
      const res = await apiClient.post('/api/connect/token', { room: roomName, username: deviceName });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus(`トークン取得失敗 (${res.status}) ${body.error ?? ''} — ログインしていますか？`);
        return;
      }
      const { token, url } = await res.json();
      const mobile = isMobileDevice();
      const r = new Room({ adaptiveStream: false, dynacast: false });
      const update = () => refreshRemotes(r);
      r.on(RoomEvent.TrackSubscribed, update)
        .on(RoomEvent.TrackUnsubscribed, update)
        .on(RoomEvent.ParticipantConnected, update)
        .on(RoomEvent.ParticipantDisconnected, update)
        .on(RoomEvent.Disconnected, () => setStatus('切断されました'));
      setStatus('接続中…');
      await r.connect(url, token);
      const track = await createLocalVideoTrack(VIDEO_CAPTURE_CONSTRAINTS as VideoCaptureOptions);
      await r.localParticipant.publishTrack(track, {
        source: Track.Source.Camera,
        videoCodec: codec,
        backupCodec: false,
        videoEncoding: mobile ? VideoPresets.h360.encoding : DESKTOP_VIDEO_ENCODING,
        simulcast: !mobile,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      });
      let note = '';
      if (forceT3) note = ` / ${await applyTemporalLayers(track)}`;
      if (localPreview.current) track.attach(localPreview.current);
      setLocalTrack(track);
      setRoom(r);
      refreshRemotes(r);
      setStatus(`接続済み (${mobile ? 'スマホ設定: 1層 360p' : 'PC設定: simulcast 3層 720p'} / ${codec}${note})`);
    } catch (err) {
      setStatus(`エラー: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const leave = async () => {
    localTrack?.stop();
    await room?.disconnect();
    setRoom(null);
    setLocalTrack(null);
    setRemotes([]);
    setOutbound([]);
    setInbound({});
    setStatus('未接続');
  };

  useEffect(() => () => void room?.disconnect(), [room]);

  // Stats, once a second.
  useEffect(() => {
    if (!room) return;
    const timer = setInterval(async () => {
      const now = performance.now();
      if (localTrack?.sender) {
        const requested = localTrack.sender.getParameters().encodings.map(
          (e) => `${e.rid ?? '-'}:${(e as { scalabilityMode?: string }).scalabilityMode ?? '(未指定)'}${e.active === false ? '(停止)' : ''}`,
        );
        const rows: OutboundRow[] = [];
        (await localTrack.sender.getStats()).forEach((s) => {
          if (s.type !== 'outbound-rtp' || s.kind !== 'video') return;
          const key = s.rid ?? s.ssrc;
          const prev = prevOut.current.get(key);
          const frames = s.framesEncoded ?? 0;
          const encodeTime = s.totalEncodeTime ?? 0;
          prevOut.current.set(key, { at: now, frames, encodeTime });
          const dFrames = prev ? frames - prev.frames : 0;
          rows.push({
            rid: s.rid ?? '-',
            size: s.frameWidth ? `${s.frameWidth}x${s.frameHeight}` : '-',
            fps: prev ? (dFrames * 1000) / (now - prev.at) : NaN,
            mode: s.scalabilityMode ?? '(統計になし)',
            requested: requested.find((x) => x.startsWith(`${s.rid ?? '-'}:`))?.split(':')[1] ?? '?',
            encodeMs: dFrames > 0 ? ((encodeTime - prev!.encodeTime) * 1000) / dFrames : NaN,
            encoder: `${s.encoderImplementation ?? '?'}${s.powerEfficientEncoder ? '(HW)' : ''}`,
            limit: s.qualityLimitationReason ?? '-',
          });
        });
        rows.sort((a, b) => a.rid.localeCompare(b.rid));
        setOutbound(rows);
      }
      const next: Record<string, InboundRow> = {};
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.videoTrackPublications.values()) {
          const track = pub.track;
          if (pub.source !== Track.Source.Camera || !(track instanceof RemoteVideoTrack) || !track.receiver) continue;
          const key = `${p.identity}:${pub.trackSid}`;
          (await track.receiver.getStats()).forEach((s) => {
            if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
            const cur: Counters = {
              at: now,
              decoded: s.framesDecoded ?? 0,
              decodeTime: s.totalDecodeTime ?? 0,
              bytes: s.bytesReceived ?? 0,
              dropped: s.framesDropped ?? 0,
              freezes: s.freezeCount ?? 0,
            };
            const prev = prevIn.current.get(key);
            prevIn.current.set(key, cur);
            const decoderNow = `${s.decoderImplementation ?? '?'}${s.powerEfficientDecoder ? '(HW)' : ''}`;
            const log = decoderLog.current.get(key) ?? { since: now, entries: [] };
            decoderLog.current.set(key, log);
            const lastEntry = log.entries[log.entries.length - 1];
            if (!lastEntry || !lastEntry.endsWith(decoderNow)) {
              log.entries.push(`${Math.round((now - log.since) / 1000)}秒: ${decoderNow}`);
            }
            if (!prev) return;
            const sec = (now - prev.at) / 1000;
            const dDecoded = cur.decoded - prev.decoded;
            const dTime = (cur.decodeTime - prev.decodeTime) * 1000;
            next[key] = {
              fps: dDecoded / sec,
              size: s.frameWidth ? `${s.frameWidth}x${s.frameHeight}` : '-',
              decodeMsPerFrame: dDecoded > 0 ? dTime / dDecoded : NaN,
              decodeMsPerSec: dTime / sec,
              kbps: ((cur.bytes - prev.bytes) * 8) / 1000 / sec,
              dropped: (cur.dropped - prev.dropped) / sec,
              freezes: cur.freezes - prev.freezes,
              decoder: `${s.decoderImplementation ?? '?'}${s.powerEfficientDecoder ? '(HW)' : ''}`,
            };
          });
        }
      }
      setInbound(next);
    }, 1000);
    return () => clearInterval(timer);
  }, [room, localTrack]);

  const setAllFps = (fps: number) => {
    for (const r of remotes) r.publication.setVideoFPS(fps);
    setRequestedFps(fps);
  };

  const setAllQuality = (q: VideoQuality) => {
    for (const r of remotes) r.publication.setVideoQuality(q);
    setQuality(q);
  };

  const header = () =>
    [
      `■ 時間レイヤー実験 ${new Date().toLocaleString()} | ${deviceName} | ${browserName()} | 送信 ${codec}${forceT3 ? ' +L1T3強制' : ''} | ${
        isMobileDevice() ? 'スマホ設定' : 'PC設定'
      }`,
      '自分の送信:',
      ...outbound.map(
        (o) => `  ${o.rid} ${o.size} ${fmt(o.fps)}fps 実際=${o.mode} 指定=${o.requested} 圧縮${fmt(o.encodeMs)}ms/コマ ${o.encoder} 制限=${o.limit}`,
      ),
    ].join('\n');

  const runAutoTest = async () => {
    setTesting(true);
    const lines = [header(), `受信テスト（受け取る画質: ${quality}）:`];
    const results: Record<string, string[]> = {};
    for (const fps of SWEEP) {
      const label = fps === 60 ? '全部(60)' : String(fps);
      setAllFps(fps);
      await new Promise((r) => setTimeout(r, 3000));
      const acc: Record<string, InboundRow[]> = {};
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        for (const [k, v] of Object.entries(inboundRef.current)) (acc[k] ??= []).push(v);
      }
      for (const r of remotes) {
        const rows = acc[r.key] ?? [];
        const avg = (f: (x: InboundRow) => number) => rows.reduce((s, x) => s + (Number.isFinite(f(x)) ? f(x) : 0), 0) / (rows.length || 1);
        const last = rows[rows.length - 1];
        (results[r.name] ??= []).push(
          `  要求${label}: ${fmt(avg((x) => x.fps))}fps ${last?.size ?? '-'} デコード${fmt(avg((x) => x.decodeMsPerFrame), 2)}ms/コマ = ${fmt(
            avg((x) => x.decodeMsPerSec),
          )}ms/秒 ${fmt(avg((x) => x.kbps), 0)}kbps 取りこぼし${fmt(avg((x) => x.dropped))}/秒 固まり${rows.reduce((s, x) => s + x.freezes, 0)} ${last?.decoder ?? ''}`,
        );
      }
    }
    setAllFps(60);
    for (const [name, rows] of Object.entries(results)) lines.push(` ${name} から受信:`, ...rows);
    for (const r of remotes) {
      const log = decoderLog.current.get(r.key);
      if (log) lines.push(` ${r.name} のデコーダの変化（受信開始からの秒数）:`, ...log.entries.map((e) => `  ${e}`));
    }
    if (remotes.length === 0) lines.push(' (受信している相手がいません)');
    setReport(lines.join('\n'));
    setTesting(false);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 space-y-4 text-sm">
      <h1 className="text-lg font-bold">時間レイヤー実験</h1>
      <p className="text-gray-400 leading-relaxed">
        全端末で同じルーム名に入ってください。受け取る側で「受け取るコマ数」を下げたとき、受信fpsとデコード時間が下がれば、その送り手には時間レイヤーが付いています。
      </p>

      {!room ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            ルーム名
            <input className="bg-gray-800 rounded px-2 py-1" value={roomName} onChange={(e) => setRoomName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            端末名
            <input className="bg-gray-800 rounded px-2 py-1 w-28" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            送るコーデック
            <select className="bg-gray-800 rounded px-2 py-1" value={codec} onChange={(e) => setCodec(e.target.value as VideoCodec)}>
              <option value="vp8">VP8（今の標準）</option>
              <option value="h264">H.264</option>
              <option value="vp9">VP9</option>
              <option value="av1">AV1</option>
            </select>
          </label>
          <label className="flex items-center gap-2 py-1">
            <input type="checkbox" checked={forceT3} onChange={(e) => setForceT3(e.target.checked)} />
            時間レイヤー(L1T3)を強制
          </label>
          <button onClick={join} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 font-bold">
            入る
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button onClick={leave} className="px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700">
            退出
          </button>
          {localTrack && (
            <button
              onClick={async () => setStatus(`${status} / ${await applyTemporalLayers(localTrack)}`)}
              className="px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700"
            >
              送信にL1T3を今つける
            </button>
          )}
        </div>
      )}
      <div className="text-amber-300">{status}</div>

      <section className="space-y-2">
        <h2 className="font-bold">自分の送信</h2>
        <video ref={localPreview} muted playsInline autoPlay className="w-40 rounded bg-black" />
        <table className="text-xs font-mono">
          <thead className="text-gray-400">
            <tr>
              <th className="pr-3 text-left">層</th>
              <th className="pr-3 text-left">サイズ</th>
              <th className="pr-3 text-left">fps</th>
              <th className="pr-3 text-left">実際の時間レイヤー</th>
              <th className="pr-3 text-left">指定</th>
              <th className="pr-3 text-left">圧縮ms/コマ</th>
              <th className="pr-3 text-left">エンコーダ</th>
              <th className="text-left">制限</th>
            </tr>
          </thead>
          <tbody>
            {outbound.map((o) => (
              <tr key={o.rid}>
                <td className="pr-3">{o.rid}</td>
                <td className="pr-3">{o.size}</td>
                <td className="pr-3">{fmt(o.fps)}</td>
                <td className={`pr-3 ${/T[23]/.test(o.mode) ? 'text-emerald-400' : 'text-rose-400'}`}>{o.mode}</td>
                <td className="pr-3">{o.requested}</td>
                <td className="pr-3">{fmt(o.encodeMs)}</td>
                <td className="pr-3">{o.encoder}</td>
                <td>{o.limit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h2 className="font-bold">受信（{remotes.length}人）</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-gray-400">受け取るコマ数:</span>
          {FPS_STEPS.map(({ request: fps, label }) => (
            <button
              key={fps}
              disabled={testing}
              onClick={() => setAllFps(fps)}
              className={`px-3 py-1 rounded ${requestedFps === fps ? 'bg-sky-600' : 'bg-gray-800 hover:bg-gray-700'}`}
            >
              {label}
            </button>
          ))}
          <span className="text-gray-400 ml-3">受け取る画質:</span>
          {[VideoQuality.HIGH, VideoQuality.MEDIUM, VideoQuality.LOW].map((q) => (
            <button
              key={q}
              disabled={testing}
              onClick={() => setAllQuality(q)}
              className={`px-3 py-1 rounded ${quality === q ? 'bg-sky-600' : 'bg-gray-800 hover:bg-gray-700'}`}
            >
              {q === VideoQuality.HIGH ? '大' : q === VideoQuality.MEDIUM ? '中' : '小'}
            </button>
          ))}
          <button
            disabled={testing || remotes.length === 0}
            onClick={runAutoTest}
            className="ml-3 px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50"
          >
            {testing ? '計測中…(約50秒)' : '自動テスト（60→8→5→4→3→2→1を順に要求）'}
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          {remotes.map((r) => (
            <RemoteTile key={r.key} remote={r} stats={inbound[r.key]} />
          ))}
        </div>
      </section>

      {report && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="font-bold">結果</h2>
            <button onClick={() => void navigator.clipboard?.writeText(report)} className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700">
              コピー
            </button>
          </div>
          <textarea readOnly value={report} className="w-full h-64 bg-gray-900 rounded p-2 font-mono text-xs" />
        </section>
      )}
    </div>
  );
}

function RemoteTile({ remote, stats }: { remote: Remote; stats?: InboundRow }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    remote.track.attach(el);
    return () => {
      remote.track.detach(el);
    };
  }, [remote.track]);
  return (
    <div className="w-64 space-y-1">
      <video ref={ref} muted playsInline autoPlay className="w-64 aspect-video rounded bg-black object-cover" />
      <div className="font-bold">{remote.name}</div>
      {stats ? (
        <div className="font-mono text-xs leading-5 text-gray-300">
          <div>
            {fmt(stats.fps)}fps {stats.size} {fmt(stats.kbps, 0)}kbps
          </div>
          <div>
            デコード {fmt(stats.decodeMsPerFrame, 2)}ms/コマ = {fmt(stats.decodeMsPerSec)}ms/秒
          </div>
          <div>
            取りこぼし {fmt(stats.dropped)}/秒 固まり {stats.freezes} {stats.decoder}
          </div>
        </div>
      ) : (
        <div className="text-xs text-gray-500">計測待ち…</div>
      )}
    </div>
  );
}
