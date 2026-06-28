"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUCKET_NAME = exports.r2 = void 0;
exports.resolveAvatarUrl = resolveAvatarUrl;
exports.getSignedFileUrl = getSignedFileUrl;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const supabase_1 = require("./supabase");
exports.r2 = new client_s3_1.S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    // AWS SDK v3がデフォルトで付与するCRC32チェックサムをR2は拒否するため無効化
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
});
exports.BUCKET_NAME = process.env.R2_BUCKET_NAME;
// avatar_id から 1時間有効な署名付き表示URLを生成するヘルパー
// サムネイルがある場合はサムネイルを優先する（一覧表示用のため）
async function resolveAvatarUrl(avatarId) {
    if (!avatarId)
        return null;
    try {
        const { data: galleryItem } = await supabase_1.supabase
            .from('gallery')
            .select('storage_path, thumbnail_path')
            .eq('id', avatarId)
            .single();
        if (!galleryItem)
            return null;
        // サムネイルがあればそれを使い、なければオリジナルを使う
        const key = galleryItem.thumbnail_path || galleryItem.storage_path;
        if (!key)
            return null;
        const command = new client_s3_1.GetObjectCommand({
            Bucket: exports.BUCKET_NAME,
            Key: key,
        });
        return await (0, s3_request_presigner_1.getSignedUrl)(exports.r2, command, { expiresIn: 3600 });
    }
    catch {
        return null;
    }
}
// 任意のキーから署名付きURLを生成するヘルパー（1時間有効）
async function getSignedFileUrl(key) {
    if (!key)
        return null;
    try {
        const command = new client_s3_1.GetObjectCommand({
            Bucket: exports.BUCKET_NAME,
            Key: key,
        });
        return await (0, s3_request_presigner_1.getSignedUrl)(exports.r2, command, { expiresIn: 3600 });
    }
    catch {
        return null;
    }
}
