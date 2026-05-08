import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

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

export default router;
