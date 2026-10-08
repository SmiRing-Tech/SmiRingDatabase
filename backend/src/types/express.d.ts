import type { User } from '@supabase/supabase-js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      /** Set by authenticateFormRespondent for a not-logged-in respondent of a public form. */
      formGuestKey?: string;
    }
  }
}
