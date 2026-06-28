"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../lib/supabase");
const authenticate_1 = require("../middleware/authenticate");
const router = (0, express_1.Router)();
/**
 * ログイン時に last_login_at を更新する API
 */
/**
 * 招待コードの有効性を確認する API
 * ログイン前でもアクセス可能
 */
router.post('/api/auth/check-invitation-code', async (req, res) => {
    const { code } = req.body;
    if (!code) {
        return res.status(400).json({ error: '招待コードを入力してください' });
    }
    try {
        // SupabaseのRPCを呼び出してコードを検証
        const { data: isValid, error } = await supabase_1.supabase.rpc('check_signup_code', {
            code_to_check: code
        });
        if (error) {
            console.error('招待コード検証エラー:', error);
            throw error;
        }
        res.json({ isValid: !!isValid });
    }
    catch (error) {
        res.status(500).json({ error: 'コードの検証中にエラーが発生しました' });
    }
});
/**
 * ログイン中ユーザーの実効権限一覧を返す API
 * フロントエンドが AuthContext に権限をキャッシュするために使用
 */
router.get('/api/me/permissions', authenticate_1.authenticate, async (req, res) => {
    try {
        const { data, error } = await supabase_1.supabase.rpc('get_user_permissions', {
            p_user_id: req.user.id,
        });
        if (error)
            throw error;
        res.json(data ?? []);
    }
    catch (error) {
        console.error('権限取得エラー:', error);
        res.status(500).json({ error: '権限の取得中にエラーが発生しました' });
    }
});
exports.default = router;
