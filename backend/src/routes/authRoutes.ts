import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { authenticate } from '../middleware/authenticate';

const router = Router();

/**
 * ログイン時に last_login_at を更新する API
 */


/**
 * ログイン中ユーザーの実効権限一覧を返す API
 * フロントエンドが AuthContext に権限をキャッシュするために使用
 */
router.get('/api/me/permissions', authenticate, async (req: Request, res: Response) => {
  try {
    const { data: permissions, error: permError } = await supabase.rpc('get_user_permissions', {
      p_user_id: req.user!.id,
    });

    if (permError) throw permError;

    const { data: roleMappings, error: rolesError } = await supabase
      .from('user_role_mappings')
      .select(`
        user_role,
        user_roles (
          id,
          role_name
        )
      `)
      .eq('user_id', req.user!.id);

    if (rolesError) throw rolesError;

    const roles = (roleMappings || [])
      .map(rm => (rm.user_roles as any)?.role_name)
      .filter(Boolean);

    const roleIds = (roleMappings || [])
      .map(rm => rm.user_role)
      .filter(Boolean);

    res.json({
      permissions: permissions ?? [],
      roles,
      roleIds
    });
  } catch (error: any) {
    console.error('権限取得エラー:', error);
    res.status(500).json({ error: '権限の取得中にエラーが発生しました' });
  }
});

export default router;
