import type { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

type PermissionRow = { resource: string; action: string };

// ユーザーの実効権限をSupabase RPCで取得（結果をreqにキャッシュして同一リクエスト内の二重呼び出しを防ぐ）
async function fetchPermissions(userId: string): Promise<PermissionRow[]> {
  const { data, error } = await supabase.rpc('get_user_permissions', { p_user_id: userId });
  if (error) throw error;
  return (data as PermissionRow[]) ?? [];
}

// requirePermission('gallery', 'read') のように resource と action を指定する
// requirePermission('gallery', 'write') なら write だけでなく admin も通す
export function requirePermission(resource: string, action: 'read' | 'write' | 'delete' | 'admin') {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: '認証が必要です' });
    }

    try {
      const permissions = await fetchPermissions(req.user.id);

      const allowed = permissions.some(p => {
        if (p.resource !== resource) return false;
        if (p.action === 'admin') return true;   // admin は全操作を包含
        if (p.action === action) return true;
        // write は read も包含する（書けるなら読める）
        if (action === 'read' && p.action === 'write') return true;
        return false;
      });

      if (!allowed) {
        return res.status(403).json({ error: 'この操作を行う権限がありません' });
      }

      next();
    } catch (err) {
      console.error('権限チェックエラー:', err);
      return res.status(500).json({ error: '権限の確認中にエラーが発生しました' });
    }
  };
}
