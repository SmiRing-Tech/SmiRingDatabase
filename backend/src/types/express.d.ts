import type { User } from '@supabase/supabase-js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      /** Raw request body bytes, captured for endpoints that need to verify an
       *  HMAC signature over the exact bytes received (e.g. the LiveKit webhook). */
      rawBody?: Buffer;
    }
  }
}
