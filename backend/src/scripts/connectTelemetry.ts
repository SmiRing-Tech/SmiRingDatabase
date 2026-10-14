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
 * summary の見方: 段階(lv)は「b=背景を標準に落とした / 数字=カメラの段階0-2 / x=カメラOFF」。
 * 「重い」理由(reasons)は governorPolicy.ts の classify() が付けたもの。
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
  console.log(`  段階ごとの時間: ${Object.entries(levelTime).map(([k, v]) => `${k}:${((v * 2) / 60).toFixed(1)}分`).join(' ')}`);
  for (const a of actions) {
    const at = s.startedAt ? `${((a.t - s.startedAt) / 60_000).toFixed(1)}分` : '?';
    console.log(`  → ${at} ${JSON.stringify(a.action)} ${a.applied ? '実行' : '(判断のみ)'} 理由: ${(a.reasons ?? []).join('+')}`);
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
