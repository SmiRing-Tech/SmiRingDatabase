import * as dotenv from 'dotenv';
import path from 'path';

// Load .env before other imports
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { r2, BUCKET_NAME } from '../lib/r2';
import { supabase } from '../lib/supabase';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { Readable } from 'stream';

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: any[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function migrate() {
  console.log('🚀 マイグレーションを開始します...');

  // 1. 対象レコードを取得 (thumbnail_path が未設定のもの)
  const { data: photos, error: fetchError } = await supabase
    .from('gallery')
    .select('*')
    .is('thumbnail_path', null);

  if (fetchError) {
    console.error('❌ データ取得エラー:', fetchError);
    return;
  }

  if (!photos || photos.length === 0) {
    console.log('✅ 移行対象の画像はありませんでした。');
    return;
  }

  console.log(`📦 対象画像: ${photos.length} 件`);

  for (const photo of photos) {
    try {
      console.log(`\n🔄 処理中: ${photo.id} (${photo.storage_path})`);

      // 2. R2 から画像をダウンロード
      const getCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: photo.storage_path,
      });

      const response = await r2.send(getCommand);
      if (!response.Body) {
        console.warn(`⚠️  ファイルの中身が空です: ${photo.storage_path}`);
        continue;
      }

      const originalBuffer = await streamToBuffer(response.Body as Readable);

      // 3. サムネイル生成
      const thumbBuffer = await sharp(originalBuffer)
        .resize(400, 400, { fit: 'inside' })
        .webp({ quality: 80 })
        .toBuffer();

      // 4. 新しいパスを決定
      // 既存のパスが users/{userId}/timestamp.ext の場合、そのまま流用しつつディレクトリだけ変える
      let newLargeKey = photo.storage_path;
      const fileName = path.basename(photo.storage_path);
      const ext = path.extname(fileName).replace('.', '');
      
      // パスを gallery/large/{userId}/{fileName} に統一したい
      // 現状は users/{userId}/{timestamp}.{ext} なので、これを変換
      if (photo.storage_path.startsWith('users/')) {
        const parts = photo.storage_path.split('/');
        const userId = parts[1];
        newLargeKey = `gallery/large/${userId}/${fileName}`;
      } else if (!photo.storage_path.startsWith('gallery/large/')) {
        // それ以外の未知のパスも一応 gallery/large に移動
        newLargeKey = `gallery/large/${photo.user_id}/${fileName}`;
      }

      const thumbKey = `gallery/thumbnails/${photo.user_id}/${path.parse(fileName).name}.webp`;

      // 5. R2 へアップロード (Large と Thumbnail)
      // Large (コピー)
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: newLargeKey,
        Body: originalBuffer,
        ContentType: response.ContentType || 'image/jpeg',
      }));

      // Thumbnail
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: thumbKey,
        Body: thumbBuffer,
        ContentType: 'image/webp',
      }));

      // 6. DB 更新
      const { error: updateError } = await supabase
        .from('gallery')
        .update({
          storage_path: newLargeKey,
          thumbnail_path: thumbKey
        })
        .eq('id', photo.id);

      if (updateError) throw updateError;

      console.log(`✨ 成功: -> ${thumbKey}`);

    } catch (err) {
      console.error(`❌ 失敗 (${photo.id}):`, err);
    }
  }

  console.log('\n✅ すべての処理が完了しました。');
}

migrate();
