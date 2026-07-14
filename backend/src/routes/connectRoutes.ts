import { Router, Request, Response } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { authenticate } from '../middleware/authenticate';
import { supabase } from '../lib/supabase';

const router = Router();

// LiveKit connection info (set in .env)
const LIVEKIT_URL = process.env.LIVEKIT_URL; // e.g. wss://livekit.smiring-ryugaku.com
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

/** Allow only safe room names (alphanumeric, hyphen, underscore). */
function isValidRoomName(room: unknown): room is string {
  return typeof room === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(room);
}

// POST /api/connect/token  { room } -> { token, url, identity }
router.post('/api/connect/token', authenticate, async (req: Request, res: Response) => {
  try {
    // Not configured yet: tell the frontend clearly.
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({
        error: 'LiveKit is not configured',
        detail: 'サーバー側で LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET が未設定です。',
      });
    }

    const { room } = req.body ?? {};
    if (!isValidRoomName(room)) {
      return res.status(400).json({ error: 'ルーム名が不正です（英数字・ハイフン・アンダースコアのみ、1〜64文字）' });
    }

    const userId = req.user!.id;

    // Display name from profile, fallback to email, then userId.
    let displayName = req.user!.email ?? userId;
    try {
      const { data: profile } = await supabase
        .from('basic_profile_info')
        .select('name_english, name_kanji')
        .eq('id', userId)
        .single();
      if (profile) {
        displayName = profile.name_kanji || profile.name_english || displayName;
      }
    } catch {
      // Ignore profile lookup failure; still issue the token.
    }

    // Issue access token (identity is unique per user).
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId,
      name: displayName,
      ttl: '1h',
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    return res.status(200).json({ token, url: LIVEKIT_URL, identity: userId });
  } catch (error: any) {
    console.error('[Connect] token issue failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
