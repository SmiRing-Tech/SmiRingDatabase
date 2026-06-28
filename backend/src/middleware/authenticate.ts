import type { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: '認証トークンがありません' });
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: '認証に失敗しました' });
  }

  req.user = user;
  next();
}
