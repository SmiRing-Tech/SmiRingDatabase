import { Router, Request, Response, NextFunction } from 'express';
import { AccessToken, RoomServiceClient, WebhookReceiver, DataPacket_Kind } from 'livekit-server-sdk';
import { authenticate } from '../middleware/authenticate';
import { supabase } from '../lib/supabase';
import { resolveAvatarUrl } from '../lib/r2';

// smiring_member ロールID（ryugakusai-web / frontend/src/hooks/useIsInternal.ts と共通の定義）
const SMIRING_MEMBER_ROLE_ID = 'c7f24039-c537-402e-91db-664684f5f8b3';

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

/** True if the user holds the smiring_member role — the only "mini room host" grant today. */
async function isSmiRingMemberHost(userId: string): Promise<boolean> {
  const { data: mapping } = await supabase
    .from('user_role_mappings')
    .select('user_id')
    .eq('user_id', userId)
    .eq('user_role', SMIRING_MEMBER_ROLE_ID)
    .maybeSingle();
  if (mapping) return true;

  // Fallback: resolve the role id by name, in case the constant above ever drifts from the DB.
  const { data: roleData } = await supabase
    .from('user_roles')
    .select('id')
    .eq('role_name', 'smiring_member')
    .maybeSingle();
  if (!roleData?.id) return false;

  const { data: fallbackMapping } = await supabase
    .from('user_role_mappings')
    .select('user_id')
    .eq('user_id', userId)
    .eq('user_role', roleData.id)
    .maybeSingle();
  return !!fallbackMapping;
}

/** Gate for mini-room management routes: create/move-other/close all require the host grant. */
async function requireMiniRoomHost(req: Request, res: Response, next: NextFunction) {
  try {
    const isHost = await isSmiRingMemberHost(req.user!.id);
    if (!isHost) {
      return res.status(403).json({ error: 'ミニルームの操作にはホスト権限が必要です' });
    }
    next();
  } catch (error: any) {
    console.error('[Connect] Host check failed:', error);
    return res.status(500).json({ error: error.message });
  }
}

/** Generates a LiveKit-safe room name for a mini room. */
function generateMiniRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'mr_';
  for (let i = 0; i < 10; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

interface MiniRoomRow {
  id: string;
  name: string;
  allow_self_assign: boolean;
  created_at: string;
}

/** Active mini rooms for a main room, oldest first. */
async function getActiveMiniRooms(mainRoomId: string): Promise<MiniRoomRow[]> {
  const { data, error } = await supabase
    .from('connect_miniroom_rooms')
    .select('id, name, allow_self_assign, created_at')
    .eq('main_room_id', mainRoomId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

function serializeMiniRooms(rows: MiniRoomRow[]) {
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: new Date(r.created_at).getTime() }));
}

/** Finds which of the given LiveKit rooms an identity is currently connected to. */
async function findParticipantCurrentRoom(
  candidateRoomIds: string[],
  identity: string,
): Promise<string | null> {
  if (!roomService) return null;
  const results = await Promise.all(
    candidateRoomIds.map(async (roomId) => {
      try {
        const participants = await roomService!.listParticipants(roomId);
        return participants.some((p) => p.identity === identity) ? roomId : null;
      } catch {
        return null;
      }
    }),
  );
  return results.find((r) => r !== null) ?? null;
}

/** Broadcasts the current mini-room list to the main room and every active mini room,
 *  so every connected client's picker/panel stays live without relying on polling alone. */
async function broadcastMiniRoomSync(
  mainRoomId: string,
  rooms: { id: string; name: string; createdAt: number }[],
  allowSelfAssign: boolean,
) {
  if (!roomService) return;
  const payload = Buffer.from(JSON.stringify({ type: 'miniroom_sync', rooms, allowSelfAssign }), 'utf8');
  const targets = [mainRoomId, ...rooms.map((r) => r.id)];
  await Promise.all(
    targets.map((roomId) =>
      roomService!
        .sendData(roomId, payload, DataPacket_Kind.RELIABLE, { topic: 'miniroom_sync' })
        .catch((e) => console.warn(`[Connect] miniroom_sync broadcast to ${roomId} failed:`, e)),
    ),
  );
}

/** True if a main room currently has no connected participants on LiveKit. */
async function isRoomEmpty(roomId: string): Promise<boolean> {
  if (!roomService) return false;
  const existingRooms = await roomService.listRooms([roomId]);
  const currentRoom = existingRooms.find((r) => r.name === roomId);
  return !currentRoom || currentRoom.numParticipants === 0;
}

/** Wipes everything scoped to a main room once it's gone stale (no participants left):
 *  chat history, and any mini rooms + their LiveKit rooms. Shared by token issuance,
 *  the chat-history fetch, and the LiveKit webhook — all three previously duplicated
 *  the chat-only version of this cleanup inline. */
async function cleanupStaleRoomData(mainRoomId: string): Promise<void> {
  const { error: chatError } = await supabase.from('connect_chat_messages').delete().eq('room_id', mainRoomId);
  if (chatError) {
    console.error('[Connect] Failed to delete stale chat messages:', chatError);
  }

  const miniRooms = await getActiveMiniRooms(mainRoomId).catch((e) => {
    console.error('[Connect] Failed to list stale mini rooms:', e);
    return [] as MiniRoomRow[];
  });
  if (miniRooms.length === 0) return;

  if (roomService) {
    await Promise.all(miniRooms.map((r) => roomService!.deleteRoom(r.id).catch(() => {})));
  }
  const { error: miniError } = await supabase
    .from('connect_miniroom_rooms')
    .delete()
    .eq('main_room_id', mainRoomId);
  if (miniError) {
    console.error('[Connect] Failed to delete stale mini room rows:', miniError);
  }
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
        if (await isRoomEmpty(room)) {
          await cleanupStaleRoomData(room);
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
        if (await isRoomEmpty(roomId)) {
          await cleanupStaleRoomData(roomId);
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

// ==========================================
// 🚪 ミニルーム（ブレイクアウトルーム）API
// ==========================================

// GET /api/connect/rooms/:roomId/miniroom - List active mini rooms for a main room.
router.get('/api/connect/rooms/:roomId/miniroom', authenticate, async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    if (!isValidRoomName(roomId)) {
      return res.status(400).json({ error: 'ルーム名が不正です' });
    }

    const miniRooms = await getActiveMiniRooms(roomId);
    return res.status(200).json({
      rooms: serializeMiniRooms(miniRooms),
      allowSelfAssign: miniRooms[0]?.allow_self_assign ?? false,
    });
  } catch (error: any) {
    console.error('[Connect] GET .../miniroom failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/rooms/:roomId/miniroom - Create mini room(s) (initial batch, or added to an active session).
router.post(
  '/api/connect/rooms/:roomId/miniroom',
  authenticate,
  requireMiniRoomHost,
  async (req: Request, res: Response) => {
    try {
      const { roomId } = req.params;
      if (!isValidRoomName(roomId)) {
        return res.status(400).json({ error: 'ルーム名が不正です' });
      }
      if (!roomService) {
        return res.status(503).json({ error: 'LiveKitが設定されていません' });
      }

      const { rooms: requestedRooms, allowSelfAssign: requestedAllowSelfAssign } = req.body ?? {};
      if (!Array.isArray(requestedRooms) || requestedRooms.length === 0 || requestedRooms.length > 20) {
        return res.status(400).json({ error: 'ルームは1〜20個で指定してください' });
      }
      const names: string[] = [];
      for (const r of requestedRooms) {
        const name = typeof r?.name === 'string' ? r.name.trim() : '';
        if (!name || name.length > 40) {
          return res.status(400).json({ error: 'ルーム名は1〜40文字で入力してください' });
        }
        names.push(name);
      }

      const existing = await getActiveMiniRooms(roomId);
      const allowSelfAssign =
        typeof requestedAllowSelfAssign === 'boolean'
          ? requestedAllowSelfAssign
          : existing[0]?.allow_self_assign ?? false;

      // The flag is session-wide — keep already-created rooms in sync if the host changes it.
      if (typeof requestedAllowSelfAssign === 'boolean' && existing.length > 0) {
        const { error: syncError } = await supabase
          .from('connect_miniroom_rooms')
          .update({ allow_self_assign: allowSelfAssign })
          .eq('main_room_id', roomId);
        if (syncError) {
          console.error('[Connect] Failed to sync allow_self_assign:', syncError);
        }
      }

      const created: { id: string }[] = [];
      try {
        for (const name of names) {
          const id = generateMiniRoomId();
          await roomService.createRoom({ name: id });
          const { error } = await supabase.from('connect_miniroom_rooms').insert([
            {
              id,
              main_room_id: roomId,
              name,
              allow_self_assign: allowSelfAssign,
              created_by: req.user!.id,
            },
          ]);
          if (error) throw error;
          created.push({ id });
        }
      } catch (error: any) {
        // Roll back this batch on partial failure (both the LiveKit rooms and DB rows).
        await Promise.all(
          created.map((r) =>
            Promise.all([
              roomService!.deleteRoom(r.id).catch(() => {}),
              supabase.from('connect_miniroom_rooms').delete().eq('id', r.id),
            ]),
          ),
        );
        console.error('[Connect] Mini room creation failed partway:', error);
        return res.status(500).json({ error: 'ミニルームの作成に失敗しました' });
      }

      const allMiniRooms = await getActiveMiniRooms(roomId);
      const rooms = serializeMiniRooms(allMiniRooms);
      await broadcastMiniRoomSync(roomId, rooms, allowSelfAssign);

      return res.status(201).json({ rooms, allowSelfAssign });
    } catch (error: any) {
      console.error('[Connect] POST .../miniroom failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// GET /api/connect/rooms/:roomId/miniroom/participants - Live roster with current room, for the host's move UI.
router.get(
  '/api/connect/rooms/:roomId/miniroom/participants',
  authenticate,
  requireMiniRoomHost,
  async (req: Request, res: Response) => {
    try {
      const { roomId } = req.params;
      if (!isValidRoomName(roomId)) {
        return res.status(400).json({ error: 'ルーム名が不正です' });
      }
      if (!roomService) {
        return res.status(503).json({ error: 'LiveKitが設定されていません' });
      }

      const miniRooms = await getActiveMiniRooms(roomId);
      const roomIds = [roomId, ...miniRooms.map((r) => r.id)];

      const results = await Promise.all(
        roomIds.map(async (id) => {
          try {
            const list = await roomService!.listParticipants(id);
            return list.map((p) => ({ participant: p, currentRoomId: id }));
          } catch {
            return [];
          }
        }),
      );

      const participants = results.flat().map(({ participant: p, currentRoomId }) => {
        let avatarUrl: string | null = null;
        try {
          const meta = p.metadata ? JSON.parse(p.metadata) : {};
          avatarUrl = meta.avatar_url ?? null;
        } catch {
          // Ignore malformed metadata.
        }
        return {
          identity: p.identity,
          name: p.name || p.identity,
          avatarUrl,
          currentRoomId,
        };
      });

      return res.status(200).json({ participants });
    } catch (error: any) {
      console.error('[Connect] GET .../miniroom/participants failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// POST /api/connect/rooms/:roomId/miniroom/move - Unified self-move / host-move-other.
router.post('/api/connect/rooms/:roomId/miniroom/move', authenticate, async (req: Request, res: Response) => {
  try {
    const { roomId } = req.params;
    if (!isValidRoomName(roomId)) {
      return res.status(400).json({ error: 'ルーム名が不正です' });
    }
    if (!roomService) {
      return res.status(503).json({ error: 'LiveKitが設定されていません' });
    }

    const { targetIdentity, destinationRoomId } = req.body ?? {};
    if (typeof targetIdentity !== 'string' || !targetIdentity) {
      return res.status(400).json({ error: 'targetIdentityが必要です' });
    }
    if (typeof destinationRoomId !== 'string' || !destinationRoomId) {
      return res.status(400).json({ error: 'destinationRoomIdが必要です' });
    }

    const miniRooms = await getActiveMiniRooms(roomId);
    const destinationMiniRoom = miniRooms.find((r) => r.id === destinationRoomId);
    if (destinationRoomId !== roomId && !destinationMiniRoom) {
      return res.status(400).json({ error: '無効な移動先です' });
    }

    const userId = req.user!.id;
    const isSelfMove = targetIdentity === userId;

    if (isSelfMove) {
      // Returning to the main room is always allowed; joining a mini room yourself
      // requires the session's allow_self_assign flag.
      const allowSelfAssign = miniRooms[0]?.allow_self_assign ?? false;
      if (destinationRoomId !== roomId && !allowSelfAssign) {
        return res.status(403).json({ error: 'このルームへは自分で移動できません' });
      }
    } else {
      const isHost = await isSmiRingMemberHost(userId);
      if (!isHost) {
        return res.status(403).json({ error: '他の参加者を移動させるにはホスト権限が必要です' });
      }
    }

    const fromRoom = await findParticipantCurrentRoom(
      [roomId, ...miniRooms.map((r) => r.id)],
      targetIdentity,
    );
    if (!fromRoom) {
      return res.status(404).json({ error: '対象の参加者が見つかりません' });
    }
    if (fromRoom === destinationRoomId) {
      return res.status(200).json({ ok: true, alreadyThere: true });
    }

    if (isSelfMove) {
      await roomService.moveParticipant(fromRoom, targetIdentity, destinationRoomId);
      return res.status(200).json({ ok: true });
    }

    // Host-initiated move of someone else: notify first, then apply the actual move a
    // few seconds later so the target sees a "moving to..." toast rather than an instant cut.
    const destinationName = destinationRoomId === roomId ? 'メインルーム' : destinationMiniRoom!.name;
    const delayMs = 4000;
    const notifyPayload = Buffer.from(
      JSON.stringify({ type: 'miniroom_notify', destinationRoomId, destinationName, delayMs }),
      'utf8',
    );
    try {
      await roomService.sendData(fromRoom, notifyPayload, DataPacket_Kind.RELIABLE, {
        destinationIdentities: [targetIdentity],
        topic: 'miniroom_notify',
      });
    } catch (e) {
      console.warn('[Connect] miniroom notify send failed:', e);
    }

    setTimeout(() => {
      roomService!
        .moveParticipant(fromRoom, targetIdentity, destinationRoomId)
        .catch((e) => console.warn('[Connect] delayed moveParticipant failed (participant likely left):', e));
    }, delayMs);

    return res.status(202).json({ ok: true, delayMs });
  } catch (error: any) {
    console.error('[Connect] POST .../miniroom/move failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/rooms/:roomId/miniroom/close - Close one mini room, or (omitted body) the whole session.
router.post(
  '/api/connect/rooms/:roomId/miniroom/close',
  authenticate,
  requireMiniRoomHost,
  async (req: Request, res: Response) => {
    try {
      const { roomId } = req.params;
      if (!isValidRoomName(roomId)) {
        return res.status(400).json({ error: 'ルーム名が不正です' });
      }
      if (!roomService) {
        return res.status(503).json({ error: 'LiveKitが設定されていません' });
      }

      const { miniRoomId } = req.body ?? {};
      const allMiniRooms = await getActiveMiniRooms(roomId);
      const targets = miniRoomId ? allMiniRooms.filter((r) => r.id === miniRoomId) : allMiniRooms;

      if (miniRoomId && targets.length === 0) {
        return res.status(404).json({ error: 'ミニルームが見つかりません' });
      }

      const delayMs = 3000;
      const notifyPayload = Buffer.from(
        JSON.stringify({ type: 'miniroom_notify', destinationRoomId: roomId, destinationName: 'メインルーム', delayMs }),
        'utf8',
      );

      await Promise.all(
        targets.map(async (miniRoom) => {
          let participants: { identity: string }[] = [];
          try {
            participants = await roomService!.listParticipants(miniRoom.id);
          } catch (e) {
            console.warn(`[Connect] listParticipants failed for ${miniRoom.id}:`, e);
          }

          await Promise.all(
            participants.map(async (p) => {
              try {
                await roomService!.sendData(miniRoom.id, notifyPayload, DataPacket_Kind.RELIABLE, {
                  destinationIdentities: [p.identity],
                  topic: 'miniroom_notify',
                });
              } catch (e) {
                console.warn('[Connect] close notify send failed:', e);
              }
              setTimeout(() => {
                roomService!
                  .moveParticipant(miniRoom.id, p.identity, roomId)
                  .catch((e) => console.warn('[Connect] delayed close-move failed:', e));
              }, delayMs);
            }),
          );

          // Give in-flight moves a head start before tearing the room down; deleteRoom
          // force-disconnects anyone still there, which is fine since they're leaving anyway.
          setTimeout(() => {
            roomService!.deleteRoom(miniRoom.id).catch(() => {});
          }, delayMs + 2000);
        }),
      );

      const idsToRemove = targets.map((r) => r.id);
      const { error } = await supabase.from('connect_miniroom_rooms').delete().in('id', idsToRemove);
      if (error) {
        console.error('[Connect] Failed to delete closed mini room rows:', error);
      }

      const remaining = await getActiveMiniRooms(roomId);
      const rooms = serializeMiniRooms(remaining);
      const allowSelfAssign = remaining[0]?.allow_self_assign ?? false;
      await broadcastMiniRoomSync(roomId, rooms, allowSelfAssign);

      return res.status(200).json({ ok: true });
    } catch (error: any) {
      console.error('[Connect] POST .../miniroom/close failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

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
      await cleanupStaleRoomData(event.room.name);
    }

    return res.status(200).end();
  } catch (error: any) {
    // Invalid signature / malformed payload — reject, but don't leak details.
    console.warn('[Connect] Webhook verification failed:', error.message);
    return res.status(401).end();
  }
});

export default router;
