import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { supabase } from './supabase';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  // AWS SDK v3がデフォルトで付与するCRC32チェックサムをR2は拒否するため無効化
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export const BUCKET_NAME = process.env.R2_BUCKET_NAME!;

// avatar_id から 1時間有効な署名付き表示URLを生成するヘルパー
// サムネイルがある場合はサムネイルを優先する（一覧表示用のため）
export async function resolveAvatarUrl(avatarId: string | null): Promise<string | null> {
  if (!avatarId) return null;
  try {
    const { data: galleryItem } = await supabase
      .from('gallery')
      .select('storage_path, thumbnail_path')
      .eq('id', avatarId)
      .single();
    
    if (!galleryItem) return null;

    // サムネイルがあればそれを使い、なければオリジナルを使う
    const key = galleryItem.thumbnail_path || galleryItem.storage_path;
    if (!key) return null;

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });
    return await getSignedUrl(r2, command, { expiresIn: 3600 });
  } catch {
    return null;
  }
}
// 任意のキーから署名付きURLを生成するヘルパー（1時間有効）
export async function getSignedFileUrl(key: string | null): Promise<string | null> {
  if (!key) return null;
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });
    return await getSignedUrl(r2, command, { expiresIn: 3600 });
  } catch {
    return null;
  }
}
