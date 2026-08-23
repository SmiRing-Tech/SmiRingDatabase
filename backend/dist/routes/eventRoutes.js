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
const express_1 = require("express");
const supabase_1 = require("../lib/supabase");
const authenticate_1 = require("../middleware/authenticate");
const requirePermission_1 = require("../middleware/requirePermission");
const r2_1 = require("../lib/r2");
const client_s3_1 = require("@aws-sdk/client-s3");
const multer_1 = __importDefault(require("multer"));
const crypto_1 = __importDefault(require("crypto"));
const router = (0, express_1.Router)();
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});
/**
 * SmiRingMemberロールを持つホスト候補メンバー一覧を取得する API
 */
router.get('/api/events/hosts', authenticate_1.authenticate, async (_req, res) => {
    try {
        const SMIRING_MEMBER_ROLE_ID = 'c7f24039-c537-402e-91db-664684f5f8b3';
        // 1. smiring_member ロールのマッピングを取得 (user_role カラム)
        const { data: mappings, error: mappingError } = await supabase_1.supabase
            .from('user_role_mappings')
            .select('user_id')
            .eq('user_role', SMIRING_MEMBER_ROLE_ID);
        if (mappingError) {
            console.warn('[Events Hosts API] Role mapping error with ID:', mappingError);
        }
        let userIds = (mappings || []).map((m) => m.user_id).filter(Boolean);
        // もし見つからない場合はロール名 'smiring_member' で検索
        if (userIds.length === 0) {
            const { data: roleData } = await supabase_1.supabase
                .from('user_roles')
                .select('id')
                .eq('role_name', 'smiring_member')
                .maybeSingle();
            if (roleData?.id) {
                const { data: fallbackMappings } = await supabase_1.supabase
                    .from('user_role_mappings')
                    .select('user_id')
                    .eq('user_role', roleData.id);
                userIds = (fallbackMappings || []).map((m) => m.user_id).filter(Boolean);
            }
        }
        let query = supabase_1.supabase
            .from('basic_profile_info')
            .select('id, name_kanji, name_english')
            .order('name_kanji', { ascending: true, nullsFirst: false });
        // ロールメンバーが取得できた場合は絞り込み、もし設定されていない場合は全メンバーをフォールバック
        if (userIds.length > 0) {
            query = query.in('id', userIds);
        }
        const { data: members, error: membersError } = await query;
        if (membersError)
            throw membersError;
        res.json(members || []);
    }
    catch (error) {
        console.error('[Events Hosts API] Fetch failed:', error);
        res.status(500).json({ error: 'ホストメンバーの取得に失敗しました' });
    }
});
/**
 * 公開イベント一覧を取得する API (外部・内部共有)
 * status === 'published' または全件
 */
router.get('/api/events', authenticate_1.authenticate, async (_req, res) => {
    try {
        const { data: rawEvents, error } = await supabase_1.supabase
            .from('events')
            .select(`
        *,
        basic_profile_info:host (
          id,
          name_kanji,
          name_english,
          avatar_id
        )
      `)
            .eq('status', 'published')
            .order('start_datetime', { ascending: true, nullsFirst: false });
        if (error) {
            console.error('[Events API] Error fetching events:', error);
            throw error;
        }
        const eventsList = rawEvents || [];
        const formattedEvents = await Promise.all(eventsList.map(async (item) => {
            let imageUrl = null;
            if (item.image_path) {
                imageUrl = await (0, r2_1.getSignedFileUrl)(item.image_path);
            }
            const hostInfo = item.basic_profile_info;
            let hostAvatarUrl = null;
            if (hostInfo?.avatar_id) {
                hostAvatarUrl = await (0, r2_1.resolveAvatarUrl)(hostInfo.avatar_id);
            }
            const eventDateText = item.metadata?.event_date_text || formatEventDate(item.start_datetime, item.end_datetime || item.metadata?.end_datetime);
            return {
                id: item.id,
                title: item.title || '',
                upper_subtitle: item.upper_subtitle || null,
                lower_subtitle: item.lower_subtitle || null,
                description: item.description || item.discription || '',
                start_datetime: item.start_datetime || null,
                end_datetime: item.end_datetime || null,
                status: item.status || 'draft',
                image_path: item.image_path || null,
                image_url: imageUrl,
                event_date_text: eventDateText,
                requirements: item.metadata?.requirements || null,
                metadata: item.metadata || {},
                created_at: item.created_at,
                updated_at: item.updated_at || item.upsated_at || null,
                host: hostInfo ? {
                    id: hostInfo.id,
                    name: hostInfo.name_kanji || hostInfo.name_english || '主催者',
                    name_english: hostInfo.name_english,
                    avatar_url: hostAvatarUrl,
                } : null,
            };
        }));
        res.json(formattedEvents);
    }
    catch (error) {
        console.error('[Events API] Fetch failed:', error);
        res.status(500).json({ error: 'イベント情報の取得に失敗しました' });
    }
});
/**
 * 管理用: 全イベント一覧を取得する API
 */
router.get('/api/events/all', authenticate_1.authenticate, (0, requirePermission_1.requirePermission)('event-management', 'read'), async (_req, res) => {
    try {
        const { data: rawEvents, error } = await supabase_1.supabase
            .from('events')
            .select(`
        *,
        basic_profile_info:host (
          id,
          name_kanji,
          name_english,
          avatar_id
        )
      `)
            .order('updated_at', { ascending: false, nullsFirst: false });
        if (error)
            throw error;
        const eventsList = rawEvents || [];
        const formattedEvents = await Promise.all(eventsList.map(async (item) => {
            let imageUrl = null;
            if (item.image_path) {
                imageUrl = await (0, r2_1.getSignedFileUrl)(item.image_path);
            }
            const hostInfo = item.basic_profile_info;
            let hostAvatarUrl = null;
            if (hostInfo?.avatar_id) {
                hostAvatarUrl = await (0, r2_1.resolveAvatarUrl)(hostInfo.avatar_id);
            }
            const eventDateText = item.metadata?.event_date_text || formatEventDate(item.start_datetime, item.end_datetime || item.metadata?.end_datetime);
            return {
                id: item.id,
                title: item.title || '',
                upper_subtitle: item.upper_subtitle || null,
                lower_subtitle: item.lower_subtitle || null,
                description: item.description || item.discription || '',
                start_datetime: item.start_datetime || null,
                end_datetime: item.end_datetime || null,
                status: item.status || 'draft',
                image_path: item.image_path || null,
                image_url: imageUrl,
                event_date_text: eventDateText,
                requirements: item.metadata?.requirements || null,
                metadata: item.metadata || {},
                created_at: item.created_at,
                updated_at: item.updated_at || item.upsated_at || item.created_at,
                host: hostInfo ? {
                    id: hostInfo.id,
                    name: hostInfo.name_kanji || hostInfo.name_english || '主催者',
                    name_english: hostInfo.name_english,
                    avatar_url: hostAvatarUrl,
                } : null,
            };
        }));
        res.json(formattedEvents);
    }
    catch (error) {
        console.error('[Events Management API] Fetch all failed:', error);
        res.status(500).json({ error: 'イベント一覧の取得に失敗しました' });
    }
});
/**
 * イベントの新規作成 (下書き)
 */
router.post('/api/events', authenticate_1.authenticate, (0, requirePermission_1.requirePermission)('event-management', 'write'), async (req, res) => {
    try {
        const { title, upper_subtitle, lower_subtitle, description, start_datetime, end_datetime, host, image_path, status, requirements, metadata = {} } = req.body;
        const mergedMetadata = {
            ...metadata,
            ...(requirements ? { requirements } : {}),
        };
        const insertData = {
            title: title || '無題のイベント',
            upper_subtitle: upper_subtitle || null,
            lower_subtitle: lower_subtitle || null,
            description: description || '',
            start_datetime: start_datetime || null,
            end_datetime: end_datetime || null,
            host: host || null,
            image_path: image_path || null,
            status: status || 'draft',
            metadata: mergedMetadata,
            updated_at: new Date().toISOString(),
        };
        const { data: newEvent, error } = await supabase_1.supabase
            .from('events')
            .insert(insertData)
            .select()
            .single();
        if (error)
            throw error;
        let imageUrl = null;
        if (newEvent.image_path) {
            imageUrl = await (0, r2_1.getSignedFileUrl)(newEvent.image_path);
        }
        res.json({
            ...newEvent,
            image_url: imageUrl,
            requirements: newEvent.metadata?.requirements || null,
        });
    }
    catch (error) {
        console.error('[Events API] Create failed:', error);
        res.status(500).json({ error: 'イベントの作成に失敗しました' });
    }
});
/**
 * イベントの更新 (自動保存 / 公開ステータス変更)
 */
router.patch('/api/events/:id', authenticate_1.authenticate, (0, requirePermission_1.requirePermission)('event-management', 'write'), async (req, res) => {
    const { id } = req.params;
    try {
        const { title, upper_subtitle, lower_subtitle, description, start_datetime, end_datetime, host, image_path, status, requirements, metadata } = req.body;
        const updatePayload = {
            updated_at: new Date().toISOString(),
        };
        if (title !== undefined)
            updatePayload.title = title;
        if (upper_subtitle !== undefined)
            updatePayload.upper_subtitle = upper_subtitle;
        if (lower_subtitle !== undefined)
            updatePayload.lower_subtitle = lower_subtitle;
        if (description !== undefined)
            updatePayload.description = description;
        if (start_datetime !== undefined)
            updatePayload.start_datetime = start_datetime;
        if (end_datetime !== undefined)
            updatePayload.end_datetime = end_datetime;
        if (host !== undefined)
            updatePayload.host = host;
        if (image_path !== undefined)
            updatePayload.image_path = image_path;
        if (status !== undefined)
            updatePayload.status = status;
        if (metadata !== undefined || requirements !== undefined) {
            // 既存の metadata を取得してマージ
            const { data: currentEvent } = await supabase_1.supabase
                .from('events')
                .select('metadata')
                .eq('id', id)
                .single();
            const currentMeta = currentEvent?.metadata || {};
            const newMeta = {
                ...currentMeta,
                ...(metadata || {}),
            };
            if (requirements !== undefined) {
                newMeta.requirements = requirements;
            }
            updatePayload.metadata = newMeta;
        }
        const { data: updatedEvent, error } = await supabase_1.supabase
            .from('events')
            .update(updatePayload)
            .eq('id', id)
            .select(`
        *,
        basic_profile_info:host (
          id,
          name_kanji,
          name_english,
          avatar_id
        )
      `)
            .single();
        if (error)
            throw error;
        let imageUrl = null;
        if (updatedEvent.image_path) {
            imageUrl = await (0, r2_1.getSignedFileUrl)(updatedEvent.image_path);
        }
        const hostInfo = updatedEvent.basic_profile_info;
        let hostAvatarUrl = null;
        if (hostInfo?.avatar_id) {
            hostAvatarUrl = await (0, r2_1.resolveAvatarUrl)(hostInfo.avatar_id);
        }
        const eventDateText = updatedEvent.metadata?.event_date_text || formatEventDate(updatedEvent.start_datetime, updatedEvent.end_datetime || updatedEvent.metadata?.end_datetime);
        res.json({
            id: updatedEvent.id,
            title: updatedEvent.title || '',
            upper_subtitle: updatedEvent.upper_subtitle || null,
            lower_subtitle: updatedEvent.lower_subtitle || null,
            description: updatedEvent.description || updatedEvent.discription || '',
            start_datetime: updatedEvent.start_datetime || null,
            end_datetime: updatedEvent.end_datetime || null,
            status: updatedEvent.status || 'draft',
            image_path: updatedEvent.image_path || null,
            image_url: imageUrl,
            event_date_text: eventDateText,
            requirements: updatedEvent.metadata?.requirements || null,
            metadata: updatedEvent.metadata || {},
            created_at: updatedEvent.created_at,
            updated_at: updatedEvent.updated_at,
            host: hostInfo ? {
                id: hostInfo.id,
                name: hostInfo.name_kanji || hostInfo.name_english || '主催者',
                name_english: hostInfo.name_english,
                avatar_url: hostAvatarUrl,
            } : null,
        });
    }
    catch (error) {
        console.error('[Events API] Update failed:', error);
        res.status(500).json({ error: 'イベントの更新に失敗しました' });
    }
});
/**
 * イベントの削除
 */
router.delete('/api/events/:id', authenticate_1.authenticate, (0, requirePermission_1.requirePermission)('event-management', 'write'), async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase_1.supabase
            .from('events')
            .delete()
            .eq('id', id);
        if (error)
            throw error;
        res.json({ success: true, id });
    }
    catch (error) {
        console.error('[Events API] Delete failed:', error);
        res.status(500).json({ error: 'イベントの削除に失敗しました' });
    }
});
/**
 * イベント画像の直接アップロード (ギャラリーには入れずR2のevents/配下に保存)
 */
router.post('/api/events/upload-image', authenticate_1.authenticate, (0, requirePermission_1.requirePermission)('event-management', 'write'), upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '画像ファイルが指定されていません' });
        }
        const file = req.file;
        const randomName = crypto_1.default.randomBytes(16).toString('hex');
        const storagePath = `events/${randomName}.jpg`;
        // sharpでリサイズ・JPEG最適化（最大2400px、EXIF向き自動補正）
        const sharp = (await Promise.resolve().then(() => __importStar(require('sharp')))).default;
        const optimizedBuffer = await sharp(file.buffer)
            .rotate() // スマホ写真のEXIF回転を自動適用
            .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85, progressive: true })
            .toBuffer();
        const command = new client_s3_1.PutObjectCommand({
            Bucket: r2_1.BUCKET_NAME,
            Key: storagePath,
            Body: optimizedBuffer,
            ContentType: 'image/jpeg',
        });
        await r2_1.r2.send(command);
        const signedUrl = await (0, r2_1.getSignedFileUrl)(storagePath);
        res.json({
            storage_path: storagePath,
            view_url: signedUrl,
        });
    }
    catch (error) {
        console.error('[Events API] Image upload failed:', error);
        res.status(500).json({ error: `画像のアップロードに失敗しました: ${error.message || error}` });
    }
});
/**
 * 日時文字列を日本語フォーマット（例: "8月22日(土) 13:00〜16:00"）に変換するヘルパー
 */
function formatEventDate(startStr, endStr) {
    if (!startStr)
        return '日時未定';
    try {
        const startDate = new Date(startStr);
        const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][startDate.getDay()];
        const month = startDate.getMonth() + 1;
        const date = startDate.getDate();
        const startHours = String(startDate.getHours()).padStart(2, '0');
        const startMinutes = String(startDate.getMinutes()).padStart(2, '0');
        let result = `${month}月${date}日(${dayOfWeek}) ${startHours}:${startMinutes}`;
        if (endStr) {
            const endDate = new Date(endStr);
            const endHours = String(endDate.getHours()).padStart(2, '0');
            const endMinutes = String(endDate.getMinutes()).padStart(2, '0');
            result += `〜${endHours}:${endMinutes}`;
        }
        return result;
    }
    catch {
        return startStr;
    }
}
exports.default = router;
