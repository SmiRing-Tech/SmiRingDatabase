import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { analyzeImageWithGemini } from '../lib/ai';
import { queueGalleryImageIndexWork } from '../lib/vectorIndexer';

const router = Router();

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME!;

/**
 * ストリームを Buffer に変換するヘルパー関数
 */
async function streamToBuffer(stream: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk: any) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ==========================================
// 🤖 ギャラリー画像 AI処理ワーカー (Supabase Webhook用)
// ==========================================
router.post('/api/worker/process-gallery', async (req: Request, res: Response) => {
  try {
    // Webhookのペイロード（追加されたデータ）を取得
    const payload = req.body;
    
    // Supabase Webhookは type: 'INSERT' で record にデータが入ってきます
    if (payload.type !== 'INSERT' || !payload.record) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const gallery = payload.record;
    console.log(`[Worker] Started processing gallery image: ${gallery.id}`);

    // ワーカーとして処理を受け付けたので、SupabaseのWebhookにはすぐ200を返しても良いですが、
    // 今回はCloud RunのCPUを確保するため、あえて最後までawaitしてからレスポンスを返します。
    // ※SupabaseのWebhookタイムアウト（通常15秒程度）に注意する必要がありますが、
    // Cloud Runの制約を回避するためにはこれが確実です。

    // 1. R2から画像（Largeサイズ）をダウンロード
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: gallery.storage_path,
    });
    
    const response = await r2.send(command);
    if (!response.Body) throw new Error('Failed to download image from R2');
    
    const imageBuffer = await streamToBuffer(response.Body);
    console.log(`[Worker] Downloaded image: ${gallery.storage_path} (${imageBuffer.length} bytes)`);

    // 2. Geminiによる画像解析
    const aiDesc = await analyzeImageWithGemini(imageBuffer, 'image/jpeg', gallery.description);
    
    // 3. DB更新 (description_generated)
    await supabase
      .from('gallery')
      .update({ description_generated: aiDesc })
      .eq('id', gallery.id);
      
    console.log(`[Worker] AI description generated and saved for: ${gallery.id}`);

    // 4. ベクトルインデックスへの登録
    // vectorIndexer 側の IIFE を外したため、ここで正しく await され CPU が維持されます。
    await queueGalleryImageIndexWork(
      gallery.id,
      aiDesc,
      gallery.visibility,
      { user_id: gallery.user_id, image_type: gallery.image_type, form_id: gallery.tags?.find((t: string) => t.startsWith('form:'))?.split(':')[1] }
    );

    console.log(`[Worker] Completely finished processing: ${gallery.id}`);
    
    // 最後に200 OKを返す（ここでCloud RunのCPU割り当てが終了する）
    res.status(200).json({ message: 'Worker processing completed successfully' });

  } catch (error: any) {
    console.error('[Worker Error] process-gallery failed:', error);
    // 失敗してもWebhookにエラーを返してリトライさせることができます
    res.status(500).json({ error: error.message });
  }
});

export default router;
