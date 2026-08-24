"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const livekit_server_sdk_1 = require("livekit-server-sdk");
const authenticate_1 = require("../middleware/authenticate");
const supabase_1 = require("../lib/supabase");
const r2_1 = require("../lib/r2");
const router = (0, express_1.Router)();
// LiveKit connection info (set in .env)
const LIVEKIT_URL = process.env.LIVEKIT_URL; // e.g. wss://livekit.smiring-ryugaku.com
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
/** Allow only safe room names (alphanumeric, hyphen, underscore). */
function isValidRoomName(room) {
    return typeof room === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(room);
}
// POST /api/connect/token  { room, username? } -> { token, url, identity, roomTitle, avatarUrl, displayName }
router.post('/api/connect/token', authenticate_1.authenticate, async (req, res) => {
    try {
        // Not configured yet: tell the frontend clearly.
        if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
            return res.status(503).json({
                error: 'LiveKit is not configured',
                detail: 'サーバー側で LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET が未設定です。',
            });
        }
        const { room, username } = req.body ?? {};
        if (!isValidRoomName(room)) {
            return res.status(400).json({ error: 'ルーム名が不正です（英数字・ハイフン・アンダースコアのみ、1〜64文字）' });
        }
        const userId = req.user.id;
        // Display name & avatar from profile
        let displayName = username?.trim() || req.user.email?.split('@')[0] || userId;
        let avatarUrl = null;
        let nameEnglish = null;
        let nameKanji = null;
        try {
            const { data: profile } = await supabase_1.supabase
                .from('basic_profile_info')
                .select('name_english, name_kanji, avatar_id')
                .eq('id', userId)
                .single();
            if (profile) {
                nameEnglish = profile.name_english || null;
                nameKanji = profile.name_kanji || null;
                if (!username?.trim()) {
                    displayName = profile.name_english || profile.name_kanji || displayName;
                }
                if (profile.avatar_id) {
                    avatarUrl = await (0, r2_1.resolveAvatarUrl)(profile.avatar_id);
                }
            }
        }
        catch {
            // Ignore profile lookup failure; still issue the token.
        }
        const metadata = JSON.stringify({
            avatar_url: avatarUrl,
            name_english: nameEnglish,
            name_kanji: nameKanji,
        });
        // Issue access token (identity is unique per user).
        const at = new livekit_server_sdk_1.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
            identity: userId,
            name: displayName,
            metadata,
            ttl: '1h',
        });
        at.addGrant({
            roomJoin: true,
            room,
            canPublish: true,
            canSubscribe: true,
        });
        const token = await at.toJwt();
        // Look up room_title if this room_id is registered in connect_rooms
        let roomTitle = null;
        try {
            const { data: roomData } = await supabase_1.supabase
                .from('connect_rooms')
                .select('room_title')
                .eq('room_id', room)
                .maybeSingle();
            if (roomData?.room_title) {
                roomTitle = roomData.room_title;
            }
        }
        catch (e) {
            // Ignore DB lookup error
        }
        return res.status(200).json({ token, url: LIVEKIT_URL, identity: userId, roomTitle });
    }
    catch (error) {
        console.error('[Connect] token issue failed:', error);
        return res.status(500).json({ error: error.message });
    }
});
/** Helper to generate random room id for fixed meetings if omitted */
function generateDefaultRoomId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 9; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6, 9)}`;
}
// GET /api/connect/rooms - List all fixed meetings
router.get('/api/connect/rooms', authenticate_1.authenticate, async (_req, res) => {
    try {
        const { data, error } = await supabase_1.supabase
            .from('connect_rooms')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) {
            console.error('[Connect] Failed to fetch connect_rooms:', error);
            return res.status(500).json({ error: error.message });
        }
        return res.status(200).json({ rooms: data ?? [] });
    }
    catch (error) {
        console.error('[Connect] GET /api/connect/rooms failed:', error);
        return res.status(500).json({ error: error.message });
    }
});
// POST /api/connect/rooms - Create a fixed meeting
router.post('/api/connect/rooms', authenticate_1.authenticate, async (req, res) => {
    try {
        const { room_title, room_id: requestedRoomId } = req.body ?? {};
        if (!room_title || typeof room_title !== 'string' || !room_title.trim()) {
            return res.status(400).json({ error: 'ミーティング名を入力してください' });
        }
        let finalRoomId = requestedRoomId?.trim();
        if (!finalRoomId) {
            finalRoomId = generateDefaultRoomId();
        }
        else if (!isValidRoomName(finalRoomId)) {
            return res.status(400).json({ error: 'ルームIDは半角英数字・ハイフン・アンダースコア（1〜64文字）で入力してください' });
        }
        // Check duplicate
        const { data: existing } = await supabase_1.supabase
            .from('connect_rooms')
            .select('id')
            .eq('room_id', finalRoomId)
            .maybeSingle();
        if (existing) {
            return res.status(400).json({ error: `ルームID「${finalRoomId}」は既に登録されています` });
        }
        const { data, error } = await supabase_1.supabase
            .from('connect_rooms')
            .insert([
            {
                room_id: finalRoomId,
                room_title: room_title.trim(),
            },
        ])
            .select()
            .single();
        if (error) {
            console.error('[Connect] Failed to insert connect_rooms:', error);
            return res.status(500).json({ error: error.message });
        }
        return res.status(201).json({ room: data });
    }
    catch (error) {
        console.error('[Connect] POST /api/connect/rooms failed:', error);
        return res.status(500).json({ error: error.message });
    }
});
// DELETE /api/connect/rooms/:id - Delete a fixed meeting
router.delete('/api/connect/rooms/:id', authenticate_1.authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.status(400).json({ error: 'IDが指定されていません' });
        }
        const { error } = await supabase_1.supabase
            .from('connect_rooms')
            .delete()
            .eq('id', id);
        if (error) {
            console.error('[Connect] Failed to delete connect_room:', error);
            return res.status(500).json({ error: error.message });
        }
        return res.status(200).json({ success: true });
    }
    catch (error) {
        console.error('[Connect] DELETE /api/connect/rooms/:id failed:', error);
        return res.status(500).json({ error: error.message });
    }
});
exports.default = router;
