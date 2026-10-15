import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { r2, BUCKET_NAME } from '../lib/r2';

/**
 * 通話ごとに自動で送られてくる負荷テレメトリ(POST /api/connect/rooms/:roomId/telemetry、
 * frontend/src/lib/connectTelemetry.ts)を R2 から読む。中身は負荷ガバナーの2秒ごとの計測と判断。
 *
 *   npx tsx src/scripts/connectTelemetry.ts days                    … データのある日付(UTC)
 *   npx tsx src/scripts/connectTelemetry.ts summary [YYYY-MM-DD]    … その日の全通話の要約(既定: 今日)
 *   npx tsx src/scripts/connectTelemetry.ts get <YYYY-MM-DD> <セッション> … ../temp/connect-telemetry/ に保存
 *
 * summary の見方: 段階(lv)は「b=背景を標準に落とした / 数字=カメラの段階0-2 / r1,r2=受信の段階
 * (他の人のカメラのコマ数を下げている) / x=カメラOFF」。
 * 「重い」理由(reasons)は governorPolicy.ts の classify() が付けたもの。
 * React再描画は通話画面の再描画にかかった画面スレッドの時間(lib/renderMeter.ts)。
 */

const PREFIX = 'connect-telemetry/';
const OUT_DIR = path.resolve(__dirname, '../../../temp/connect-telemetry');

type Entry = { t: number; type: string } & Record<string, any>;
type Part = { session: string; seq: number; startedAt: number; roomId: string; context?: any; env?: any; entries: Entry[] };

async function listAll(prefix: string, delimiter?: string) {
  const keys: string[] = [];
  const prefixes: string[] = [];
  let token: string | undefined;
  do {
    const page = await r2.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }),
    );
    for (const obj of page.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    for (const p of page.CommonPrefixes ?? []) if (p.Prefix) prefixes.push(p.Prefix);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { keys, prefixes };
}

async function readPart(key: string): Promise<Part> {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
  const bytes = Buffer.from(await res.Body!.transformToByteArray());
  return JSON.parse(zlib.gunzipSync(bytes).toString('utf8'));
}

async function loadSession(dir: string) {
  const { keys } = await listAll(dir);
  keys.sort();
  const parts = await Promise.all(keys.map(readPart));
  let uploader = '?';
  if (keys[0]) {
    const head = await r2.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: keys[0] }));
    uploader = decodeURIComponent(head.Metadata?.uploader ?? '?');
  }
  const first = parts[0];
  const withEnv = parts.find((p) => p.env);
  return {
    dir: dir.split('/').filter(Boolean).pop(),
    uploader,
    session: first?.session,
    roomId: first?.roomId,
    startedAt: first?.startedAt,
    context: parts.find((p) => p.context)?.context,
    env: withEnv?.env,
    missingParts: parts.length ? parts[parts.length - 1].seq + 1 - parts.length : 0,
    entries: parts.flatMap((p) => p.entries).sort((a, b) => a.t - b.t),
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function describeEnv(env: any) {
  if (!env) return '?';
  const ua = String(env.userAgent ?? '');
  const browser = ua.match(/(Edg|Chrome|Firefox|Version)\/[\d.]+/)?.[0]?.replace('Version', 'Safari') ?? '?';
  const os = env.platform ?? ua.match(/\(([^;)]+)/)?.[1] ?? '?';
  return `${browser} | ${os} | cores ${env.cpuCores ?? '?'} | mem ${env.deviceMemoryGB ?? '?'}GB | ${env.gpu?.renderer ?? '?'}`;
}

function summarize(s: Awaited<ReturnType<typeof loadSession>>) {
  const samples = s.entries.filter((e) => e.type === 'sample');
  const actions = s.entries.filter((e) => e.type === 'action');
  const mode = s.entries.find((e) => e.type === 'governor-start')?.mode ?? s.context?.mode ?? '?';
  const minutes = samples.length ? (samples[samples.length - 1].t - samples[0].t) / 60_000 : 0;
  const levelTime: Record<string, number> = {};
  const reasonCount: Record<string, number> = {};
  let overloaded = 0;
  let visible = 0;
  const max = { enc: 0, lag: 0, lt: 0, bgc: 0 };
  let minBgRatio = Infinity;
  let audioStressed = 0;
  let audioChunks = 0;
  let audioPass = 0;
  let audioUnderruns = 0;
  const net = { n: 0, up: 0, upMax: 0, down: 0, downMax: 0, bweN: 0, bwe: 0, bweMin: Infinity, rttMax: 0 };
  const share = { n: 0, heights: {} as Record<string, number>, bwLimited: 0, cpuLimited: 0, kbps: 0 };
  const lev = { n: 0, gain: 0, atMax: 0, speaking: 0, floor: 0, floorN: 0, speech: 0, speechN: 0 };
  const react = { samples: 0, perSec: 0, msPerSec: 0, maxMsPerSec: 0, maxPass: 0 };
  const recv = { samples: 0, maxStreams: 0, fps: 0, decodeMax: 0, decodeSum: 0, decodeN: 0, dropped: 0, freezes: 0, maxHeight: 0 };
  for (const e of samples) {
    levelTime[e.lv] = (levelTime[e.lv] ?? 0) + 1;
    if (e.vis === 0) continue;
    visible += 1;
    if (e.p === 'overloaded') overloaded += 1;
    for (const r of e.r ?? []) reasonCount[r] = (reasonCount[r] ?? 0) + 1;
    max.enc = Math.max(max.enc, e.enc ?? 0);
    max.lag = Math.max(max.lag, e.lag ?? 0);
    max.lt = Math.max(max.lt, e.lt ?? 0);
    max.bgc = Math.max(max.bgc, e.bgc ?? 0);
    if (e.bgf !== undefined && e.bge) minBgRatio = Math.min(minBgRatio, e.bgf / e.bge);
    audioChunks += e.ac ?? 0;
    audioStressed += e.as ?? 0;
    audioPass += e.ap ?? 0;
    audioUnderruns += e.au ?? 0;
    if (e.up !== undefined || e.down !== undefined) {
      net.n += 1;
      net.up += e.up ?? 0;
      net.upMax = Math.max(net.upMax, e.up ?? 0);
      net.down += e.down ?? 0;
      net.downMax = Math.max(net.downMax, e.down ?? 0);
      if (e.bwe !== undefined) {
        net.bweN += 1;
        net.bwe += e.bwe;
        net.bweMin = Math.min(net.bweMin, e.bwe);
      }
      net.rttMax = Math.max(net.rttMax, e.rtt ?? 0);
    }
    if (e.sh && e.shh) {
      share.n += 1;
      const bucket = e.shh >= 1000 ? '1080p級' : e.shh >= 700 ? '720p級' : e.shh >= 500 ? '540p級' : e.shh >= 300 ? '360p級' : '〜240p';
      share.heights[bucket] = (share.heights[bucket] ?? 0) + 1;
      share.bwLimited += e.sbw ?? 0;
      share.cpuLimited += e.scpu ?? 0;
      share.kbps += e.sk ?? 0;
    }
    if (e.lg !== undefined && e.lsp) {
      // Only windows with some speech: muted / silent stretches say nothing about the gain needed.
      lev.n += 1;
      lev.gain += e.lg;
      if (e.lgx >= 11.5) lev.atMax += 1;
      lev.speaking += e.lsp;
      if (e.lfl !== undefined) {
        lev.floor += e.lfl;
        lev.floorN += 1;
      }
      if (e.lsd !== undefined) {
        lev.speech += e.lsd;
        lev.speechN += 1;
      }
    }
    if (e.rr) {
      react.samples += 1;
      react.perSec += e.rr;
      react.msPerSec += e.rms ?? 0;
      react.maxMsPerSec = Math.max(react.maxMsPerSec, e.rms ?? 0);
      react.maxPass = Math.max(react.maxPass, e.rmax ?? 0);
    }
    if (e.rv) {
      recv.samples += 1;
      recv.maxStreams = Math.max(recv.maxStreams, e.rv);
      recv.fps += e.rfps ?? 0;
      if (e.rdec !== undefined) {
        recv.decodeMax = Math.max(recv.decodeMax, e.rdec);
        recv.decodeSum += e.rdec;
        recv.decodeN += 1;
      }
      recv.dropped += (e.rdrop ?? 0) * 2;
      recv.freezes += e.rfrz ?? 0;
      recv.maxHeight = Math.max(recv.maxHeight, e.rh ?? 0);
    }
  }
  const decoders = s.entries.filter((e) => e.type === 'decoder').map((e) => `${e.impl}${e.powerEfficient ? '(HW)' : ''}`);
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');
  const start = s.startedAt ? new Date(s.startedAt).toISOString().slice(11, 16) : '?';
  console.log(`\n■ ${s.uploader}  ${start}UTC  ${minutes.toFixed(1)}分  mode=${mode}  room=${s.roomId}${s.missingParts ? `  (欠けたパート ${s.missingParts})` : ''}`);
  console.log(`  端末: ${describeEnv(s.env)}`);
  console.log(`  保存するには: get ${s.dir}`);
  console.log(
    `  重い判定: ${pct(overloaded, visible)} (表示中のサンプル ${visible}) 理由: ${
      Object.entries(reasonCount).map(([k, v]) => `${k}×${v}`).join(' ') || 'なし'
    }`,
  );
  console.log(
    `  最大値: 圧縮CPU不足 ${Math.round(max.enc * 100)}% | 画面スレッド遅れ ${max.lag}ms | 長いタスク ${max.lt}ms/s | 背景1コマ ${max.bgc}ms | 背景の処理率 最低 ${
      minBgRatio === Infinity ? '-' : `${Math.round(minBgRatio * 100)}%`
    }`,
  );
  console.log(`  音声: 最軽量/素通し ${pct(audioStressed, audioChunks)}  素通し ${audioPass}  再生の途切れ ${audioUnderruns}`);
  console.log(
    recv.samples
      ? `  受信: 最大${recv.maxStreams}本 平均${(recv.fps / recv.samples).toFixed(1)}fps | デコード 平均${
          recv.decodeN ? (recv.decodeSum / recv.decodeN).toFixed(1) : '-'
        }ms 最大${recv.decodeMax}ms/コマ | 取りこぼし ${Math.round(recv.dropped)}コマ | 固まり ${recv.freezes}回 | 最大${recv.maxHeight}p | デコーダ ${decoders.join(', ') || '?'}`
      : '  受信: (映像の受信なし)',
  );
  console.log(
    net.n
      ? `  回線: 上り 平均${Math.round(net.up / net.n)} 最大${net.upMax}kbps | 下り 平均${Math.round(net.down / net.n)} 最大${net.downMax}kbps | 上りの推定帯域 平均${
          net.bweN ? Math.round(net.bwe / net.bweN) : '-'
        } 最低${net.bweMin === Infinity ? '-' : net.bweMin}kbps | 往復 最大${net.rttMax}ms`
      : '  回線: (記録なし)',
  );
  if (share.n) {
    console.log(
      `  画面共有の送信: ${Object.entries(share.heights).map(([k, v]) => `${k} ${((v * 2) / 60).toFixed(1)}分`).join(' / ')} | 平均${Math.round(
        share.kbps / share.n,
      )}kbps | 回線で制限 ${Math.round((share.bwLimited / share.n) * 100)}% CPUで制限 ${Math.round((share.cpuLimited / share.n) * 100)}%`,
    );
  }
  console.log(
    lev.n
      ? `  レベラー(話している区間): 平均+${(lev.gain / lev.n).toFixed(1)}dB | 上限(+12dB)に達した区間 ${Math.round((lev.atMax / lev.n) * 100)}% | 声の大きさ 平均${
          lev.speechN ? (lev.speech / lev.speechN).toFixed(1) : '-'
        }dBFS | 無音時のノイズ 平均${lev.floorN ? (lev.floor / lev.floorN).toFixed(1) : '-'}dBFS`
      : '  レベラー: (記録なし)',
  );
  console.log(
    react.samples
      ? `  React再描画: 平均${(react.perSec / visible).toFixed(1)}回/秒 ${(react.msPerSec / visible).toFixed(1)}ms/秒 | 最大 ${react.maxMsPerSec}ms/秒 | 1回の最長 ${react.maxPass}ms`
      : '  React再描画: (記録なし)',
  );
  console.log(`  段階ごとの時間: ${Object.entries(levelTime).map(([k, v]) => `${k}:${((v * 2) / 60).toFixed(1)}分`).join(' ')}`);
  // The governor's actions and the call's own state changes/events, in time order.
  for (const e of s.entries) {
    const at = s.startedAt ? `${((e.t - s.startedAt) / 60_000).toFixed(1)}分` : '?';
    if (e.type === 'action') {
      console.log(`  → ${at} ${JSON.stringify(e.action)} ${e.applied ? '実行' : '(判断のみ)'} 理由: ${(e.reasons ?? []).join('+')}`);
    } else if (e.type === 'state' && !['participants', 'pageVisible', 'cpuPressure', 'connectionQuality'].includes(e.key)) {
      console.log(`    ${at} ${e.key}: ${JSON.stringify(e.from)} → ${JSON.stringify(e.to)}`);
    } else if (e.type.startsWith('event:') && e.type !== 'event:load-governor') {
      const { t: _t, type, ...data } = e;
      console.log(`    ${at} ${type.slice(6)} ${Object.keys(data).length ? JSON.stringify(data) : ''}`);
    }
  }
}

async function main() {
  const [command, a, b] = process.argv.slice(2);
  if (command === 'days') {
    const { prefixes } = await listAll(PREFIX, '/');
    console.log(prefixes.map((p) => p.slice(PREFIX.length, -1)).join('\n') || '(まだありません)');
    return;
  }
  if (command === 'summary') {
    const day = a ?? today();
    const { prefixes } = await listAll(`${PREFIX}${day}/`, '/');
    if (prefixes.length === 0) console.log(`(${day} のテレメトリはありません)`);
    for (const dir of prefixes) summarize(await loadSession(dir));
    return;
  }
  if (command === 'get' && a && b) {
    const session = await loadSession(`${PREFIX}${a}/${b.replace(/\/$/, '')}/`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${b.replace(/[^\w-]/g, '_')}.json`);
    fs.writeFileSync(out, JSON.stringify(session, null, 1));
    console.log(`保存しました: ${out}`);
    return;
  }
  console.log('usage: connectTelemetry.ts days | summary [YYYY-MM-DD] | get <YYYY-MM-DD> <セッション>');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
