import { Router, Request, Response } from 'express';
import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { authenticate } from '../middleware/authenticate';
import { supabase } from '../lib/supabase';
import { resolveAvatarUrl } from '../lib/r2';

const router = Router();

// LiveKit connection info (set in .env)
const LIVEKIT_URL = process.env.LIVEKIT_URL; // e.g. wss://livekit.smiring-ryugaku.com
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const roomService =
  LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET
    ? new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    : null;

const webhookReceiver =
  LIVEKIT_API_KEY && LIVEKIT_API_SECRET
    ? new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    : null;

/** Allow only safe room names (alphanumeric, hyphen, underscore). */
function isValidRoomName(room: unknown): room is string {
  return typeof room === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(room);
}

/** Deterministic thread id from a set of participant identities (server is the single source of truth). */
function getCanonicalThreadId(identities: string[]): string {
  const unique = Array.from(new Set(identities)).filter(Boolean).sort();
  return `dm_${unique.join('_')}`;
}

/** Look up display name + avatar for a user, falling back gracefully. */
async function getDisplayProfile(userId: string, fallback: string) {
  let displayName = fallback;
  let avatarUrl: string | null = null;
  try {
    const { data: profile } = await supabase
      .from('basic_profile_info')
      .select('name_english, name_kanji, avatar_id')
      .eq('id', userId)
      .single();
    if (profile) {
      displayName = profile.name_english || profile.name_kanji || fallback;
      if (profile.avatar_id) {
        avatarUrl = await resolveAvatarUrl(profile.avatar_id);
      }
    }
  } catch {
    // Ignore profile lookup failure; caller gets the fallback name.
  }
  return { displayName, avatarUrl };
}

// POST /api/connect/token  { room, username? } -> { token, url, identity, roomTitle, avatarUrl, displayName }
router.post('/api/connect/token', authenticate, async (req: Request, res: Response) => {
  try {
    // Not configured yet: tell the frontend clearly.
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({
        error: 'LiveKit is not configured',
        detail: 'サーバー側で LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET が未設定です。',
      });
    }

    const { room, username } = req.body ?? {};
    if (!isValidRoomName(room)) {
      return res.status(400).json({ error: 'ルーム名が不正です（英数字・ハイフン・アンダースコアのみ、1〜64文字）' });
    }

    const userId = req.user!.id;

    // If this room doesn't currently exist on LiveKit or has 0 participants,
    // the previous session has fully ended — wipe any leftover chat history for this room_id
    // so a reused room name never resurrects a stale/unrelated conversation.
    if (roomService) {
      try {
        const existingRooms = await roomService.listRooms([room]);
        const currentRoom = existingRooms.find((r) => r.name === room);
        if (!currentRoom || currentRoom.numParticipants === 0) {
          await supabase.from('connect_chat_messages').delete().eq('room_id', room);
        }
      } catch (e) {
        // Best-effort cleanup; never block token issuance on this.
        console.warn('[Connect] Room-freshness cleanup check failed:', e);
      }
    }

    // Display name & avatar from profile
    let displayName = username?.trim() || req.user!.email?.split('@')[0] || userId;
    let avatarUrl: string | null = null;
    let nameEnglish: string | null = null;
    let nameKanji: string | null = null;

    try {
      const { data: profile } = await supabase
        .from('basic_profile_info')
        .select('name_english, name_kanji, avatar_id')
        .eq('id', userId)
        .single();
      if (profile) {
        nameEnglish = profile.name_english || null;
        nameKanji = profile.name_kanji || null;
        if (!username?.trim()) {
          displayName = profile.name_english || profile.name_kanji || displayName;
        }
        if (profile.avatar_id) {
          avatarUrl = await resolveAvatarUrl(profile.avatar_id);
        }
      }
    } catch {
      // Ignore profile lookup failure; still issue the token.
    }

    const metadata = JSON.stringify({
      avatar_url: avatarUrl,
      name_english: nameEnglish,
      name_kanji: nameKanji,
    });

    // Issue access token (identity is unique per user).
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: userId,
      name: displayName,
      metadata,
      ttl: '1h',
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    // Look up room_title if this room_id is registered in connect_rooms
    let roomTitle: string | null = null;
    try {
      const { data: roomData } = await supabase
        .from('connect_rooms')
        .select('room_title')
        .eq('room_id', room)
        .maybeSingle();
      if (roomData?.room_title) {
        roomTitle = roomData.room_title;
      }
    } catch (e) {
      // Ignore DB lookup error
    }

    return res.status(200).json({ token, url: LIVEKIT_URL, identity: userId, roomTitle });
  } catch (error: any) {
    console.error('[Connect] token issue failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

/** Helper to generate random room id for fixed meetings if omitted */
function generateDefaultRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 9; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6, 9)}`;
}

// GET /api/connect/rooms - List all fixed meetings
router.get('/api/connect/rooms', authenticate, async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('connect_rooms')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Connect] Failed to fetch connect_rooms:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ rooms: data ?? [] });
  } catch (error: any) {
    console.error('[Connect] GET /api/connect/rooms failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/rooms - Create a fixed meeting
router.post('/api/connect/rooms', authenticate, async (req: Request, res: Response) => {
  try {
    const { room_title, room_id: requestedRoomId } = req.body ?? {};

    if (!room_title || typeof room_title !== 'string' || !room_title.trim()) {
      return res.status(400).json({ error: 'ミーティング名を入力してください' });
    }

    let finalRoomId = requestedRoomId?.trim();
    if (!finalRoomId) {
      finalRoomId = generateDefaultRoomId();
    } else if (!isValidRoomName(finalRoomId)) {
      return res.status(400).json({ error: 'ルームIDは半角英数字・ハイフン・アンダースコア（1〜64文字）で入力してください' });
    }

    // Check duplicate
    const { data: existing } = await supabase
      .from('connect_rooms')
      .select('id')
      .eq('room_id', finalRoomId)
      .maybeSingle();

    if (existing) {
      return res.status(400).json({ error: `ルームID「${finalRoomId}」は既に登録されています` });
    }

    const { data, error } = await supabase
      .from('connect_rooms')
      .insert([
        {
          room_id: finalRoomId,
          room_title: room_title.trim(),
        },
      ])
      .select()
      .single();

    if (error) {
      console.error('[Connect] Failed to insert connect_rooms:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ room: data });
  } catch (error: any) {
    console.error('[Connect] POST /api/connect/rooms failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/connect/rooms/:id - Delete a fixed meeting
router.delete('/api/connect/rooms/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'IDが指定されていません' });
    }

    const { error } = await supabase
      .from('connect_rooms')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[Connect] Failed to delete connect_room:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Connect] DELETE /api/connect/rooms/:id failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/connect/rooms/:roomId/messages - Fetch chat history for a room (server is source of truth)
router.get('/api/connect/rooms/:roomId/messages', authenticate, async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    if (!isValidRoomName(roomId)) {
      return res.status(400).json({ error: 'ルーム名が不正です' });
    }

    // If the room currently has 0 participants on LiveKit, wipe leftover messages
    if (roomService) {
      try {
        const existingRooms = await roomService.listRooms([roomId]);
        const currentRoom = existingRooms.find((r) => r.name === roomId);
        if (!currentRoom || currentRoom.numParticipants === 0) {
          await supabase.from('connect_chat_messages').delete().eq('room_id', roomId);
          return res.status(200).json({ messages: [] });
        }
      } catch (e) {
        console.warn('[Connect] Room check on GET messages failed:', e);
      }
    }

    const { data, error } = await supabase
      .from('connect_chat_messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true })
      .limit(500);

    if (error) {
      console.error('[Connect] Failed to fetch connect_chat_messages:', error);
      return res.status(500).json({ error: error.message });
    }

    const messages = (data ?? []).map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      text: row.text,
      sender: {
        identity: row.sender_identity,
        name: row.sender_name,
        avatarUrl: row.sender_avatar_url,
      },
      recipients: row.recipient_identities ?? [],
      timestamp: new Date(row.created_at).getTime(),
    }));

    return res.status(200).json({ messages });
  } catch (error: any) {
    console.error('[Connect] GET .../messages failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/rooms/:roomId/messages - Send a chat message.
// The server (not the client) decides sender identity/name/avatar and the canonical threadId,
// so all connected clients converge on the same values regardless of local LiveKit connection state.
router.post('/api/connect/rooms/:roomId/messages', authenticate, async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    if (!isValidRoomName(roomId)) {
      return res.status(400).json({ error: 'ルーム名が不正です' });
    }

    const { text, recipientIdentities } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'メッセージが空です' });
    }
    const recipients: string[] = Array.isArray(recipientIdentities)
      ? recipientIdentities.filter((id) => typeof id === 'string')
      : [];

    const userId = req.user!.id;
    const fallbackName = req.user!.email?.split('@')[0] || userId;
    const { displayName, avatarUrl } = await getDisplayProfile(userId, fallbackName);

    const isEveryone = recipients.length === 0;
    const threadId = isEveryone ? 'everyone' : getCanonicalThreadId([userId, ...recipients]);

    const { data, error } = await supabase
      .from('connect_chat_messages')
      .insert([
        {
          room_id: roomId,
          thread_id: threadId,
          sender_identity: userId,
          sender_name: displayName,
          sender_avatar_url: avatarUrl,
          recipient_identities: recipients,
          text: text.trim(),
        },
      ])
      .select()
      .single();

    if (error) {
      console.error('[Connect] Failed to insert connect_chat_messages:', error);
      return res.status(500).json({ error: error.message });
    }

    const message = {
      id: data.id,
      threadId: data.thread_id,
      text: data.text,
      sender: {
        identity: data.sender_identity,
        name: data.sender_name,
        avatarUrl: data.sender_avatar_url,
      },
      recipients: data.recipient_identities ?? [],
      timestamp: new Date(data.created_at).getTime(),
    };

    return res.status(201).json({ message });
  } catch (error: any) {
    console.error('[Connect] POST .../messages failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/webhook - LiveKit webhook receiver.
// No `authenticate` here: this is called by the LiveKit server itself, not a logged-in
// user. Authenticity is verified via the signed `Authorize` header instead (see
// WebhookReceiver.receive below), which checks both the API key/secret and a SHA-256 of
// the exact raw body — hence `req.rawBody` captured in index.ts's express.json() verify hook.
router.post('/api/connect/webhook', async (req: Request, res: Response) => {
  if (!webhookReceiver) {
    console.error('[Connect] Webhook received but LIVEKIT_API_KEY/SECRET are not configured');
    return res.status(503).end();
  }

  try {
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const event = await webhookReceiver.receive(rawBody, req.get('Authorize'));

    const shouldDelete =
      (event.event === 'room_finished' && event.room?.name) ||
      (event.event === 'participant_left' && event.room?.name && event.room.numParticipants === 0);

    if (shouldDelete && event.room?.name) {
      const { error } = await supabase
        .from('connect_chat_messages')
        .delete()
        .eq('room_id', event.room.name);
      if (error) {
        console.error('[Connect] Failed to delete chat history on webhook:', error);
      }
    }

    return res.status(200).end();
  } catch (error: any) {
    // Invalid signature / malformed payload — reject, but don't leak details.
    console.warn('[Connect] Webhook verification failed:', error.message);
    return res.status(401).end();
  }
});

export default router;
