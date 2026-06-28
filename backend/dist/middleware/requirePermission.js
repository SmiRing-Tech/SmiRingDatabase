"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requirePermission = requirePermission;
const supabase_1 = require("../lib/supabase");
// ユーザーの実効権限をSupabase RPCで取得（結果をreqにキャッシュして同一リクエスト内の二重呼び出しを防ぐ）
async function fetchPermissions(userId) {
    const { data, error } = await supabase_1.supabase.rpc('get_user_permissions', { p_user_id: userId });
    if (error)
        throw error;
    return data ?? [];
}
// requirePermission('gallery', 'read') のように resource と action を指定する
// requirePermission('gallery', 'write') なら write だけでなく admin も通す
function requirePermission(resource, action) {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: '認証が必要です' });
        }
        try {
            const permissions = await fetchPermissions(req.user.id);
            const allowed = permissions.some(p => {
                if (p.resource !== resource)
                    return false;
                if (p.action === 'admin')
                    return true; // admin は全操作を包含
                if (p.action === action)
                    return true;
                // write は read も包含する（書けるなら読める）
                if (action === 'read' && p.action === 'write')
                    return true;
                return false;
            });
            if (!allowed) {
                return res.status(403).json({ error: 'この操作を行う権限がありません' });
            }
            next();
        }
        catch (err) {
            console.error('権限チェックエラー:', err);
            return res.status(500).json({ error: '権限の確認中にエラーが発生しました' });
        }
    };
}
