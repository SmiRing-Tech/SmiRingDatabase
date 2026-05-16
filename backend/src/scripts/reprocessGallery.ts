import { supabase } from '../lib/supabase';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { analyzeImageWithGemini, initAIModel } from '../lib/ai';
import { queueGalleryImageIndexWork } from '../lib/vectorIndexer';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

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

async function streamToBuffer(stream: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk: any) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function main() {
  console.log('Starting reprocessing of gallery images...');

  // 🤖 ローカルAIモデルの初期化（ベクトル化に必要）
  await initAIModel();

  // 1. Fetch unprocessed images
  const { data: galleries, error: fetchError } = await supabase
    .from('gallery')
    .select('*')
    .is('description_generated', null);

  if (fetchError) {
    console.error('Failed to fetch gallery records:', fetchError);
    return;
  }

  console.log(`Found ${galleries?.length || 0} unprocessed images.`);

  if (!galleries || galleries.length === 0) {
    console.log('No images to process.');
    return;
  }

  for (const gallery of galleries) {
    console.log(`\nProcessing gallery item: ${gallery.id}`);
    try {
      // 2. Download from R2
      const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: gallery.storage_path,
      });

      const response = await r2.send(command);
      if (!response.Body) throw new Error(`Failed to download image from R2 for ${gallery.id}`);

      const imageBuffer = await streamToBuffer(response.Body);
      console.log(`Downloaded image: ${gallery.storage_path} (${imageBuffer.length} bytes)`);

      // 3. Gemini analysis
      console.log('Calling Gemini API...');
      const aiDesc = await analyzeImageWithGemini(imageBuffer, 'image/jpeg', gallery.description);
      console.log(`Gemini description generated: "${aiDesc.join('\n').substring(0, 50)}..."`);

      // 4. Update DB
      const { error: updateError } = await supabase
        .from('gallery')
        .update({ description_generated: aiDesc })
        .eq('id', gallery.id);

      if (updateError) throw updateError;
      console.log('Database updated.');

      // 5. Vector indexing
      console.log('Queueing vector indexing...');
      await queueGalleryImageIndexWork(
        gallery.id,
        aiDesc,
        gallery.visibility,
        {
          user_id: gallery.user_id,
          image_type: gallery.image_type,
          form_id: gallery.tags?.find((t: string) => t.startsWith('form:'))?.split(':')[1]
        }
      );
      console.log('Vector indexing queued.');

    } catch (error: any) {
      console.error(`Error processing gallery item ${gallery.id}:`, error);
    }
  }

  console.log('\nReprocessing completed.');
}

main();
