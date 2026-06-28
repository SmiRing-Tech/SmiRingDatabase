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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
const path_1 = __importDefault(require("path"));
// Load .env before other imports
dotenv.config({ path: path_1.default.resolve(__dirname, '../../.env') });
const r2_1 = require("../lib/r2");
const supabase_1 = require("../lib/supabase");
const client_s3_1 = require("@aws-sdk/client-s3");
const sharp_1 = __importDefault(require("sharp"));
async function streamToBuffer(stream) {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}
async function migrate() {
    console.log('🚀 マイグレーションを開始します...');
    // 1. 対象レコードを取得 (thumbnail_path が未設定のもの)
    const { data: photos, error: fetchError } = await supabase_1.supabase
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
            const getCommand = new client_s3_1.GetObjectCommand({
                Bucket: r2_1.BUCKET_NAME,
                Key: photo.storage_path,
            });
            const response = await r2_1.r2.send(getCommand);
            if (!response.Body) {
                console.warn(`⚠️  ファイルの中身が空です: ${photo.storage_path}`);
                continue;
            }
            const originalBuffer = await streamToBuffer(response.Body);
            // 3. サムネイル生成
            const thumbBuffer = await (0, sharp_1.default)(originalBuffer)
                .resize(400, 400, { fit: 'inside' })
                .webp({ quality: 80 })
                .toBuffer();
            // 4. 新しいパスを決定
            // 既存のパスが users/{userId}/timestamp.ext の場合、そのまま流用しつつディレクトリだけ変える
            let newLargeKey = photo.storage_path;
            const fileName = path_1.default.basename(photo.storage_path);
            const ext = path_1.default.extname(fileName).replace('.', '');
            // パスを gallery/large/{userId}/{fileName} に統一したい
            // 現状は users/{userId}/{timestamp}.{ext} なので、これを変換
            if (photo.storage_path.startsWith('users/')) {
                const parts = photo.storage_path.split('/');
                const userId = parts[1];
                newLargeKey = `gallery/large/${userId}/${fileName}`;
            }
            else if (!photo.storage_path.startsWith('gallery/large/')) {
                // それ以外の未知のパスも一応 gallery/large に移動
                newLargeKey = `gallery/large/${photo.user_id}/${fileName}`;
            }
            const thumbKey = `gallery/thumbnails/${photo.user_id}/${path_1.default.parse(fileName).name}.webp`;
            // 5. R2 へアップロード (Large と Thumbnail)
            // Large (コピー)
            await r2_1.r2.send(new client_s3_1.PutObjectCommand({
                Bucket: r2_1.BUCKET_NAME,
                Key: newLargeKey,
                Body: originalBuffer,
                ContentType: response.ContentType || 'image/jpeg',
            }));
            // Thumbnail
            await r2_1.r2.send(new client_s3_1.PutObjectCommand({
                Bucket: r2_1.BUCKET_NAME,
                Key: thumbKey,
                Body: thumbBuffer,
                ContentType: 'image/webp',
            }));
            // 6. DB 更新
            const { error: updateError } = await supabase_1.supabase
                .from('gallery')
                .update({
                storage_path: newLargeKey,
                thumbnail_path: thumbKey
            })
                .eq('id', photo.id);
            if (updateError)
                throw updateError;
            console.log(`✨ 成功: -> ${thumbKey}`);
        }
        catch (err) {
            console.error(`❌ 失敗 (${photo.id}):`, err);
        }
    }
    console.log('\n✅ すべての処理が完了しました。');
}
migrate();
