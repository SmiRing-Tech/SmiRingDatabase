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
 * ログイン中ユーザーの実効権限一覧を返す API
 * フロントエンドが AuthContext に権限をキャッシュするために使用
 */
router.get('/api/me/permissions', authenticate_1.authenticate, async (req, res) => {
    try {
        const { data: permissions, error: permError } = await supabase_1.supabase.rpc('get_user_permissions', {
            p_user_id: req.user.id,
        });
        if (permError)
            throw permError;
        const { data: roleMappings, error: rolesError } = await supabase_1.supabase
            .from('user_role_mappings')
            .select(`
        user_role,
        user_roles (
          id,
          role_name
        )
      `)
            .eq('user_id', req.user.id);
        if (rolesError)
            throw rolesError;
        const roles = (roleMappings || [])
            .map(rm => rm.user_roles?.role_name)
            .filter(Boolean);
        const roleIds = (roleMappings || [])
            .map(rm => rm.user_role)
            .filter(Boolean);
        res.json({
            permissions: permissions ?? [],
            roles,
            roleIds
        });
    }
    catch (error) {
        console.error('権限取得エラー:', error);
        res.status(500).json({ error: '権限の取得中にエラーが発生しました' });
    }
});
exports.default = router;
