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
 * (他の人のカメラのコマ数を下げている。r3は受け取る画面共有も半分のコマ数) / v=自分の画面共有をVP8に切り替えた /
 * s=自分の画面共有を720pに下げた / x=カメラOFF」。
 * 「重い」理由(reasons)は governorPolicy.ts の classify() が付けたもの。
 * React再描画は通話画面の再描画にかかった画面スレッドの時間(lib/renderMeter.ts)。
 * PC全体のCPUは Compute Pressure API(Chromeのみ)の判定。画面スレッドの数値と違い、デコード・圧縮・
 * GPUプロセス・他のアプリまで含めた「PCそのものが重いか」を表す(余裕/やや混雑/混雑/限界)。
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
  // Whole-machine CPU pressure (Chromium only), counted for hidden windows too: it's the machine, not the tab.
  const cpu = [0, 0, 0, 0];
  // CPU probe (same fixed work every second in a worker), page frame pacing, frame gaps after the background effect.
  const probe: number[] = [];
  let probeLateMax = 0;
  const raf = { n: 0, fps: 0, stalls100: 0, maxGap: 0 };
  const bgg = { n: 0, over200: 0, max: 0 };
  // Per received video, by sender: [peer#, c|s, fps, freezes, frozen ms, height].
  const peerNames = new Map<number, string>();
  for (const e of s.entries) if (e.type === 'peer') peerNames.set(e.i, e.name || String(e.identity).slice(0, 8));
  const streams = new Map<string, { n: number; fps: number; freezes: number; frozenMs: number }>();
  // Received audio, by sender: [peer#, m|o, loss%, concealed%, events, stretched%, jitter, jb ms, dBFS].
  // Only windows where the sender was audible (> -60dBFS) count toward the averages.
  const audioIn = new Map<string, { n: number; loss: number; conceal: number; concealMax: number; bad: number; stretch: number; jb: number; jbN: number }>();
  // Our own mic as the server sees it: [loss%, jitter ms, kbps].
  const micOut = { n: 0, loss: 0, lossMax: 0, jitterMax: 0 };
  // Noise cancellation in/out levels (ah.nc.w), windows with clear speech vs all.
  const nz = { n: 0, inFl: 0, outFl: 0, noiseCut: 0, noiseCutN: 0, sp: 0, inSp: 0, snr: 0, speechCut: 0, speechCutN: 0 };
  for (const e of samples) {
    for (const [peer, src, loss, conceal, , stretch, , jb, db] of e.ra ?? []) {
      if (typeof db !== 'number' || db < -60) continue;
      const key = `${peerNames.get(peer) ?? `#${peer}`}${src === 'o' ? '(その他の音声)' : ''}`;
      const a = audioIn.get(key) ?? { n: 0, loss: 0, conceal: 0, concealMax: 0, bad: 0, stretch: 0, jb: 0, jbN: 0 };
      a.n += 1;
      a.loss += loss ?? 0;
      a.conceal += conceal ?? 0;
      a.concealMax = Math.max(a.concealMax, conceal ?? 0);
      if ((conceal ?? 0) >= 5) a.bad += 1;
      a.stretch += stretch ?? 0;
      if (typeof jb === 'number') {
        a.jb += jb;
        a.jbN += 1;
      }
      audioIn.set(key, a);
    }
    if (Array.isArray(e.ma) && typeof e.ma[0] === 'number') {
      micOut.n += 1;
      micOut.loss += e.ma[0];
      micOut.lossMax = Math.max(micOut.lossMax, e.ma[0]);
      micOut.jitterMax = Math.max(micOut.jitterMax, e.ma[1] ?? 0);
    }
    const w = e.ah?.nc?.w;
    if (w && e.ah?.mic) {
      nz.n += 1;
      nz.inFl += w.inFl;
      nz.outFl += w.outFl;
      if (typeof w.noiseCut === 'number') {
        nz.noiseCut += w.noiseCut;
        nz.noiseCutN += 1;
      }
      if (typeof w.speechCut === 'number') {
        nz.sp += 1;
        nz.inSp += w.inSp;
        nz.snr += w.inSp - w.inFl;
        nz.speechCut += w.speechCut;
        nz.speechCutN += 1;
      }
    }
    levelTime[e.lv] = (levelTime[e.lv] ?? 0) + 1;
    if (typeof e.cpu === 'number' && cpu[e.cpu] !== undefined) cpu[e.cpu] += 1;
    if (typeof e.cpa === 'number') probe.push(e.cpa);
    probeLateMax = Math.max(probeLateMax, e.cpl ?? 0);
    if (typeof e.bgg === 'number') {
      bgg.n += 1;
      if (e.bgg >= 200) bgg.over200 += 1;
      bgg.max = Math.max(bgg.max, e.bgg);
    }
    for (const [peer, src, fps, freezes, frozenMs] of e.rs ?? []) {
      const key = `${peerNames.get(peer) ?? `#${peer}`}${src === 's' ? '(画面共有)' : ''}`;
      const st = streams.get(key) ?? { n: 0, fps: 0, freezes: 0, frozenMs: 0 };
      st.n += 1;
      st.fps += fps ?? 0;
      st.freezes += freezes ?? 0;
      st.frozenMs += frozenMs ?? 0;
      streams.set(key, st);
    }
    if (e.vis !== 0 && typeof e.raf === 'number') {
      raf.n += 1;
      raf.fps += e.raf;
      if ((e.rafx ?? 0) >= 100) raf.stalls100 += 1;
      raf.maxGap = Math.max(raf.maxGap, e.rafx ?? 0);
    }
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
  const cpuN = cpu.reduce((a, b) => a + b, 0);
  console.log(
    cpuN
      ? `  PC全体のCPU: 余裕 ${pct(cpu[0], cpuN)} / やや混雑 ${pct(cpu[1], cpuN)} / 混雑 ${pct(cpu[2], cpuN)} / 限界 ${pct(cpu[3], cpuN)}`
      : '  PC全体のCPU: (記録なし。Chrome以外か、この記録より前の版)',
  );
  if (probe.length >= 10) {
    // The session's own floor: the work never runs faster than on an idle machine.
    const sorted = [...probe].sort((a, b) => a - b);
    const floor = Math.max(0.1, sorted[Math.floor(sorted.length * 0.05)]);
    const ratio = (q: number) => (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] / floor).toFixed(1);
    const slow = probe.filter((v) => v >= floor * 2).length;
    console.log(
      `  CPUの空き(プローブ): 基準 ${floor.toFixed(1)}ms | 中央値 ×${ratio(0.5)} 95% ×${ratio(0.95)} 最大 ×${ratio(1)} | 基準の2倍以上かかった区間 ${pct(slow, probe.length)} | タイマー遅れ 最大${probeLateMax}ms`,
    );
  }
  if (raf.n) {
    console.log(`  画面のコマ(表示中): 平均${Math.round(raf.fps / raf.n)}fps | 100ms以上止まった区間 ${pct(raf.stalls100, raf.n)} | 最長 ${raf.maxGap}ms`);
  }
  if (bgg.n) {
    console.log(`  送ったカメラのコマ間隔(背景処理の後): 200ms以上空いた区間 ${pct(bgg.over200, bgg.n)} | 最長 ${bgg.max}ms`);
  }
  if (streams.size) {
    const rows = [...streams.entries()]
      .sort((a, b) => b[1].freezes / b[1].n - a[1].freezes / a[1].n)
      .map(([k, v]) => `${k} ${Math.round(v.fps / v.n)}fps 固まり${((v.freezes / v.n) * 30).toFixed(1)}回/分 止まっていた${Math.round(v.frozenMs / (v.n * 20))}%`);
    console.log(`  受信した映像(送り手ごと): ${rows.join(' | ')}`);
  }
  if (nz.n) {
    console.log(
      `  ノイズキャンセル(マイクON中): 部屋のノイズ(処理前) 平均${(nz.inFl / nz.n).toFixed(0)}dBFS → 処理後 ${(nz.outFl / nz.n).toFixed(0)}dBFS | ノイズの削減 ${
        nz.noiseCutN ? (nz.noiseCut / nz.noiseCutN).toFixed(0) : '-'
      }dB | 話している区間 ${nz.sp}件: 声(処理前) ${nz.sp ? (nz.inSp / nz.sp).toFixed(0) : '-'}dBFS・声とノイズの差 ${nz.sp ? (nz.snr / nz.sp).toFixed(0) : '-'}dB・声から削った量 ${
        nz.speechCutN ? (nz.speechCut / nz.speechCutN).toFixed(0) : '-'
      }dB`,
    );
  }
  if (micOut.n) {
    console.log(`  自分のマイクの送信(サーバー側で見た値): パケット損失 平均${(micOut.loss / micOut.n).toFixed(1)}% 最大${micOut.lossMax}% | ゆらぎ 最大${micOut.jitterMax}ms`);
  }
  if (audioIn.size) {
    const rows = [...audioIn.entries()]
      .sort((a, b) => b[1].conceal / b[1].n - a[1].conceal / a[1].n)
      .map(
        ([k, v]) =>
          `${k} 補間${(v.conceal / v.n).toFixed(1)}%(最大${v.concealMax}%, 5%以上の区間${pct(v.bad, v.n)}) 損失${(v.loss / v.n).toFixed(1)}% 伸縮${(v.stretch / v.n).toFixed(1)}% バッファ${
            v.jbN ? Math.round(v.jb / v.jbN) : '-'
          }ms`,
      );
    console.log(`  受信した音声(送り手ごと、聞こえていた区間): ${rows.join(' | ')}`);
  }
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
