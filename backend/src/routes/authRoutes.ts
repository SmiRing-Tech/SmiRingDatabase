import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { authenticate } from '../middleware/authenticate';

const router = Router();

/**
 * ログイン時に last_login_at を更新する API
 */


/**
 * 招待コードの有効性を確認する API
 * ログイン前でもアクセス可能
 */
router.post('/api/auth/check-invitation-code', async (req: Request, res: Response) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: '招待コードを入力してください' });
  }

  try {
    // SupabaseのRPCを呼び出してコードを検証
    const { data: isValid, error } = await supabase.rpc('check_signup_code', { 
      code_to_check: code 
    });

    if (error) {
      console.error('招待コード検証エラー:', error);
      throw error;
    }

    res.json({ isValid: !!isValid });

  } catch (error: any) {
    res.status(500).json({ error: 'コードの検証中にエラーが発生しました' });
  }
});

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
        user_roles (
          role_name
        )
      `)
      .eq('user_id', req.user!.id);

    if (rolesError) throw rolesError;

    const roles = (roleMappings || [])
      .map(rm => (rm.user_roles as any)?.role_name)
      .filter(Boolean);

    res.json({
      permissions: permissions ?? [],
      roles
    });
  } catch (error: any) {
    console.error('権限取得エラー:', error);
    res.status(500).json({ error: '権限の取得中にエラーが発生しました' });
  }
});

export default router;
