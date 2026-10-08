import type { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';

export const FORM_GUEST_KEY_HEADER = 'X-Form-Guest-Key';
const GUEST_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Like `authenticate`, but a caller without a Supabase session is also let through as a guest
 * when the target form is a published `access_mode = 'public'` form and they present a guest
 * key (a random UUID their browser keeps, acting as a bearer secret for their own drafts).
 * On success exactly one of `req.user` / `req.formGuestKey` is set.
 */
export function authenticateFormRespondent(getFormId: (req: Request) => unknown = (req) => req.params.id) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        req.user = user;
        return next();
      }
    }

    const guestKey = req.get(FORM_GUEST_KEY_HEADER);
    const formId = getFormId(req);
    if (!guestKey || !GUEST_KEY_RE.test(guestKey) || typeof formId !== 'string' || !formId) {
      return res.status(401).json({ error: '認証に失敗しました' });
    }

    const { data: form } = await supabase
      .from('forms')
      .select('access_mode, status, deleted_at')
      .eq('id', formId)
      .maybeSingle();
    if (!form || form.access_mode !== 'public' || form.status !== 'published' || form.deleted_at) {
      return res.status(401).json({ error: 'このフォームはログインが必要です' });
    }

    req.formGuestKey = guestKey.toLowerCase();
    next();
  };
}
