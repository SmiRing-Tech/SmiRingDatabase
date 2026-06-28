"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const supabase_1 = require("../lib/supabase");
const client_s3_1 = require("@aws-sdk/client-s3");
const ai_1 = require("../lib/ai");
const vectorIndexer_1 = require("../lib/vectorIndexer");
const dotenv = __importStar(require("dotenv"));
const path = __importStar(require("path"));
// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const r2 = new client_s3_1.S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET_NAME = process.env.R2_BUCKET_NAME;
async function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}
async function main() {
    console.log('Starting reprocessing of gallery images...');
    // 🤖 ローカルAIモデルの初期化（ベクトル化に必要）
    await (0, ai_1.initAIModel)();
    // 1. Fetch unprocessed images
    const { data: galleries, error: fetchError } = await supabase_1.supabase
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
            const command = new client_s3_1.GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: gallery.storage_path,
            });
            const response = await r2.send(command);
            if (!response.Body)
                throw new Error(`Failed to download image from R2 for ${gallery.id}`);
            const imageBuffer = await streamToBuffer(response.Body);
            console.log(`Downloaded image: ${gallery.storage_path} (${imageBuffer.length} bytes)`);
            // 3. Gemini analysis
            console.log('Calling Gemini API...');
            const aiDesc = await (0, ai_1.analyzeImageWithGemini)(imageBuffer, 'image/jpeg', gallery.description);
            console.log(`Gemini description generated: "${aiDesc.join('\n').substring(0, 50)}..."`);
            // 4. Update DB
            const { error: updateError } = await supabase_1.supabase
                .from('gallery')
                .update({ description_generated: aiDesc })
                .eq('id', gallery.id);
            if (updateError)
                throw updateError;
            console.log('Database updated.');
            // 5. Vector indexing
            console.log('Queueing vector indexing...');
            await (0, vectorIndexer_1.queueGalleryImageIndexWork)(gallery.id, aiDesc, gallery.visibility, {
                user_id: gallery.user_id,
                image_type: gallery.image_type,
                form_id: gallery.tags?.find((t) => t.startsWith('form:'))?.split(':')[1]
            });
            console.log('Vector indexing queued.');
        }
        catch (error) {
            console.error(`Error processing gallery item ${gallery.id}:`, error);
        }
    }
    console.log('\nReprocessing completed.');
}
main();
