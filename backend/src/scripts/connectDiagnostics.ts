import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { r2, BUCKET_NAME } from '../lib/r2';

/**
 * 通話中の「通話の診断」ボタンで送られてきたログ(POST /api/connect/rooms/:roomId/diagnostics)を
 * R2 から取り出す。
 *
 *   npx tsx src/scripts/connectDiagnostics.ts list [件数]     … 新しい順に一覧(既定20件)
 *   npx tsx src/scripts/connectDiagnostics.ts get <診断ID>     … ../temp/connect-diagnostics/<ID>.json に保存
 *
 * 一覧には送信者名も出るので、IDを控え損ねた(停止せずに退出して自動送信された)場合も
 * 名前と日時で探せる。
 */

const PREFIX = 'connect-diagnostics/';
const OUT_DIR = path.resolve(__dirname, '../../../temp/connect-diagnostics');

async function list(limit: number) {
  const objects: { Key?: string; LastModified?: Date; Size?: number }[] = [];
  let token: string | undefined;
  do {
    const page = await r2.send(
      new ListObjectsV2Command({ Bucket: BUCKET_NAME, Prefix: PREFIX, ContinuationToken: token }),
    );
    objects.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  objects.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));
  for (const obj of objects.slice(0, limit)) {
    const head = await r2.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: obj.Key }));
    const id = obj.Key!.slice(PREFIX.length).replace(/\.json\.gz$/, '');
    const uploader = decodeURIComponent(head.Metadata?.uploader ?? '?');
    const kb = Math.round((obj.Size ?? 0) / 1024);
    console.log(`${id}\t${obj.LastModified?.toISOString()}\t${kb}KB\t${uploader}\troom=${head.Metadata?.room_id ?? '?'}`);
  }
  if (objects.length === 0) console.log('(診断ログはまだありません)');
}

async function get(id: string) {
  if (!/^[0-9]{8}-[0-9A-Z]{6}$/.test(id)) throw new Error(`診断IDの形式が違います: ${id}`);
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: `${PREFIX}${id}.json.gz` }));
  const bytes = Buffer.from(await res.Body!.transformToByteArray());
  const json = zlib.gunzipSync(bytes);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${id}.json`);
  fs.writeFileSync(out, json);
  console.log(`保存しました: ${out} (${Math.round(json.length / 1024)}KB)`);
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === 'list') return list(arg ? Number(arg) : 20);
  if (command === 'get' && arg) return get(arg.trim().toUpperCase());
  console.log('usage: connectDiagnostics.ts list [件数] | get <診断ID>');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
