import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AccessToken, RoomServiceClient, WebhookReceiver, DataPacket_Kind } from 'livekit-server-sdk';
import { ParticipantInfo_Kind } from '@livekit/protocol';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import multer from 'multer';
import sharp from 'sharp';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { supabase } from '../lib/supabase';
import { r2, BUCKET_NAME, resolveAvatarUrl, getSignedFileUrl } from '../lib/r2';
import { ensureJpegBuffer } from '../lib/imageInput';
import {
  closeParticipantPresence,
  closeParticipantTracks,
  finishRecording,
  getActiveRecordingId,
  getRecordingSession,
  isRecordingConfigured,
  openParticipantPresence,
  setRecordingSession,
  startRecordingForParticipants,
  startTrackRecording,
  syncCameraRecordings,
} from '../lib/recording';

// smiring_member ロールID（ryugakusai-web / frontend/src/hooks/useIsInternal.ts と共通の定義）
const SMIRING_MEMBER_ROLE_ID = 'c7f24039-c537-402e-91db-664684f5f8b3';
// 内部メンバー判定用のロールID一式（frontend/src/hooks/useIsInternal.ts の INTERNAL_ROLE_IDS と同一）
const PARTNER_ROLE_ID = 'e9b3b5b3-b95e-4c87-bf1c-6b65603189cf';
const ADMIN_ROLE_ID = 'a6dfbd9b-f64b-446d-b89f-b7d876e26988';
const ALUMNI_ROLE_ID = '535cde53-58d7-48a8-9036-527a48b624b7';
const INTERNAL_ROLE_IDS = [SMIRING_MEMBER_ROLE_ID, PARTNER_ROLE_ID, ADMIN_ROLE_ID];

// connect/membersピッカーの表示グループ分け用（この優先順で最初に一致したものをそのユーザーの代表ロールとする）
const MEMBER_GROUP_ROLE_IDS: { id: string; group: string }[] = [
  { id: SMIRING_MEMBER_ROLE_ID, group: 'smiring_member' },
  { id: PARTNER_ROLE_ID, group: 'smiring_partner' },
  { id: ALUMNI_ROLE_ID, group: 'smiring_alumni' },
];

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

const MEETING_TYPES = ['fixed', 'external'] as const;
type MeetingType = (typeof MEETING_TYPES)[number];

/** Unguessable token embedded in an external meeting's no-login invite URL
 *  (/j/:token, added separately). Same "passcode, not a credential" trust level
 *  as host_code — stored in plaintext so it can be re-shown/copied later. */
function generateInviteToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/** Parses a required ISO datetime string, rejecting anything unparsable or already past. */
function parseFutureDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date;
}

/** Parses an optional ISO datetime string; returns undefined if omitted, null if invalid. */
function parseOptionalDate(value: unknown): Date | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Deterministic thread id from a set of participant identities (server is the single source of truth). */
function getCanonicalThreadId(identities: string[]): string {
  const unique = Array.from(new Set(identities)).filter(Boolean).sort();
  return `dm_${unique.join('_')}`;
}

/**
 * Mints a LiveKit access token for a user to join a specific room, embedding their
 * profile (name/avatar) as participant metadata exactly like `/api/connect/token` does.
 * Shared by that route and the mini-room move/close endpoints, which need to hand a
 * participant a token for a *different* room without requiring their own browser to
 * make the request (LiveKit server-side room migration isn't available on this
 * self-hosted deployment — see mini-room routes below — so switching rooms is done by
 * the client disconnecting and reconnecting with a freshly minted token instead).
 */
async function mintLiveKitToken(userId: string, room: string, usernameOverride?: string): Promise<string> {
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error('LiveKitが設定されていません');
  }

  let displayName = usernameOverride?.trim() || userId;
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
      if (!usernameOverride?.trim()) {
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

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userId,
    name: displayName,
    metadata,
    ttl: '1h',
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return at.toJwt();
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

/** True if userId holds host privileges for LiveKit room `roomId`. For a registered
 *  fixed meeting this is its creator or anyone in connect_room_hosts; for an instant
 *  (unregistered) room it's whoever connect_instant_hosts recorded for that room_id
 *  (see POST /api/connect/token, which auto-registers the first joiner). */
async function isRoomHost(userId: string, roomId: string): Promise<boolean> {
  const { data: room } = await supabase
    .from('connect_rooms')
    .select('id, created_by')
    .eq('room_id', roomId)
    .maybeSingle();

  if (room) {
    if (room.created_by === userId) return true;
    const { data } = await supabase
      .from('connect_room_hosts')
      .select('room_id')
      .eq('room_id', room.id)
      .eq('user_id', userId)
      .maybeSingle();
    return !!data;
  }

  const { data: instantHost } = await supabase
    .from('connect_instant_hosts')
    .select('room_id')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!instantHost;
}

/** Of the given user ids, which hold one of the internal roles (member/partner/admin) —
 *  used for the connect/members "is_internal" flag and the create-room "内部メンバーのみ" snapshot. */
async function getInternalUserIds(candidateIds: string[]): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const { data } = await supabase
    .from('user_role_mappings')
    .select('user_id')
    .in('user_role', INTERNAL_ROLE_IDS)
    .in('user_id', candidateIds);
  return new Set((data ?? []).map((r) => r.user_id));
}

/** Gate for room-host-only actions: mini-room create/move-other/close and recording start/stop. */
async function requireRoomHost(req: Request, res: Response, next: NextFunction) {
  try {
    const isHost = await isRoomHost(req.user!.id, req.params.roomId as string);
    if (!isHost) {
      return res.status(403).json({ error: 'この操作にはホスト権限が必要です' });
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

interface PendingMiniRoomAssignment {
  destinationRoomId: string;
  destinationName: string;
  assignedAt: number;
}

// In-memory track of participants assigned to a mini room who haven't moved yet.
// Map<mainRoomId, Map<identity, PendingMiniRoomAssignment>>
const pendingMiniRoomAssignments = new Map<string, Map<string, PendingMiniRoomAssignment>>();

function setPendingAssignment(
  mainRoomId: string,
  identity: string,
  destinationRoomId: string,
  destinationName: string,
) {
  let roomMap = pendingMiniRoomAssignments.get(mainRoomId);
  if (!roomMap) {
    roomMap = new Map();
    pendingMiniRoomAssignments.set(mainRoomId, roomMap);
  }
  roomMap.set(identity, {
    destinationRoomId,
    destinationName,
    assignedAt: Date.now(),
  });
}

function clearPendingAssignment(mainRoomId: string, identity: string) {
  const roomMap = pendingMiniRoomAssignments.get(mainRoomId);
  if (roomMap) {
    roomMap.delete(identity);
    if (roomMap.size === 0) {
      pendingMiniRoomAssignments.delete(mainRoomId);
    }
  }
}

function clearRoomPendingAssignments(mainRoomId: string, destinationRoomId?: string) {
  if (!destinationRoomId) {
    pendingMiniRoomAssignments.delete(mainRoomId);
    return;
  }
  const roomMap = pendingMiniRoomAssignments.get(mainRoomId);
  if (roomMap) {
    for (const [identity, item] of roomMap.entries()) {
      if (item.destinationRoomId === destinationRoomId) {
        roomMap.delete(identity);
      }
    }
    if (roomMap.size === 0) {
      pendingMiniRoomAssignments.delete(mainRoomId);
    }
  }
}

function getPendingAssignment(mainRoomId: string, identity: string): PendingMiniRoomAssignment | undefined {
  const item = pendingMiniRoomAssignments.get(mainRoomId)?.get(identity);
  if (!item) return undefined;
  // Expire assignments older than 1 hour just in case
  if (Date.now() - item.assignedAt > 3600 * 1000) {
    clearPendingAssignment(mainRoomId, identity);
    return undefined;
  }
  return item;
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

/** Pings a room's data channel so any connected host's Participants panel refetches the
 *  waitlist immediately instead of waiting for its fallback poll. Best-effort: the actual
 *  data (who's pending) is never in the payload — clients treat this as "something about
 *  the waitlist changed, go re-fetch" and hit GET .../waitlist for the authoritative list. */
async function broadcastWaitlistUpdate(roomId: string) {
  if (!roomService) return;
  const payload = Buffer.from(JSON.stringify({ type: 'connect_waitlist_updated' }), 'utf8');
  try {
    await roomService.sendData(roomId, payload, DataPacket_Kind.RELIABLE, { topic: 'connect_waitlist' });
  } catch (e) {
    console.warn(`[Connect] waitlist broadcast to ${roomId} failed:`, e);
  }
}

/** 403s and returns false unless req.user (must be set — call after `authenticate`) is
 *  this room's creator or a registered host. Shared by the waitlist admin routes below. */
async function ensureRoomHost(req: Request, res: Response, roomId: string): Promise<boolean> {
  const host = await isRoomHost(req.user!.id, roomId);
  if (!host) {
    res.status(403).json({ error: 'この操作にはホスト権限が必要です' });
    return false;
  }
  return true;
}

/** True if a room currently has no connected participants on LiveKit. */
async function isRoomEmpty(roomId: string): Promise<boolean> {
  if (!roomService) return false;
  const existingRooms = await roomService.listRooms([roomId]);
  const currentRoom = existingRooms.find((r) => r.name === roomId);
  return !currentRoom || currentRoom.numParticipants === 0;
}

/**
 * True if a main room's *entire session* is done — the main room itself has 0
 * participants AND every one of its mini rooms does too. A main room alone going empty
 * is expected and routine once a breakout session starts (everyone moves out into mini
 * rooms), so `isRoomEmpty(mainRoomId)` on its own is NOT a safe signal that the call is
 * over; using it directly would make the first mini-room split trigger cleanup of the
 * mini rooms that were just created. This is the check every cleanup trigger must use
 * instead of `isRoomEmpty` for a main room.
 */
async function isMainRoomSessionEmpty(mainRoomId: string): Promise<boolean> {
  if (!(await isRoomEmpty(mainRoomId))) return false;

  const miniRooms = await getActiveMiniRooms(mainRoomId).catch((e) => {
    console.error('[Connect] Failed to check mini rooms for session-emptiness:', e);
    return null;
  });
  if (miniRooms === null) return false; // Inconclusive — don't risk deleting active mini rooms.
  if (miniRooms.length === 0) return true;

  // If any mini room was created very recently (< 2 minutes ago), the session was just created
  // and participants are likely in transit (reconnecting). Do not treat it as stale.
  const hasRecentlyCreatedRoom = miniRooms.some((r) => {
    const createdAt = r.created_at ? new Date(r.created_at).getTime() : 0;
    return Date.now() - createdAt < 120_000;
  });
  if (hasRecentlyCreatedRoom) return false;

  try {
    let liveMiniRooms = await roomService!.listRooms(miniRooms.map((r) => r.id));
    if (liveMiniRooms.some((r) => r.numParticipants > 0)) return false;

    // Grace period for room transitions: wait 5s and re-verify before tearing down the session.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (!(await isRoomEmpty(mainRoomId))) return false;

    liveMiniRooms = await roomService!.listRooms(miniRooms.map((r) => r.id));
    return !liveMiniRooms.some((r) => r.numParticipants > 0);
  } catch (e) {
    console.error('[Connect] Failed to check mini room occupancy:', e);
    return false;
  }
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

  // Instant-room host claim is only valid for the session it was made in; clear it so a
  // reused room name lets the next joiner become its host again.
  const { error: instantHostError } = await supabase.from('connect_instant_hosts').delete().eq('room_id', mainRoomId);
  if (instantHostError) {
    console.error('[Connect] Failed to delete stale instant host row:', instantHostError);
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

    // If this room's whole session (main room + any mini rooms) has nobody left in it,
    // the previous session has fully ended — wipe any leftover chat/mini-room data for
    // this room_id so a reused room name never resurrects a stale/unrelated session.
    if (roomService) {
      try {
        if (await isMainRoomSessionEmpty(room)) {
          await cleanupStaleRoomData(room);
        }
      } catch (e) {
        // Best-effort cleanup; never block token issuance on this.
        console.warn('[Connect] Room-freshness cleanup check failed:', e);
      }
    }

    const fallbackName = username?.trim() || req.user!.email?.split('@')[0] || userId;
    const token = await mintLiveKitToken(userId, room, fallbackName);

    // Look up room_title if this room_id is registered in connect_rooms, and determine
    // whether this user holds host privileges for it (fixed meeting host list/creator,
    // or — for an instant/unregistered room — whoever connect_instant_hosts auto-registered
    // as its first joiner below).
    let roomTitle: string | null = null;
    let isHost = false;
    try {
      const { data: roomData } = await supabase
        .from('connect_rooms')
        .select('id, room_title, created_by')
        .eq('room_id', room)
        .maybeSingle();

      if (roomData) {
        roomTitle = roomData.room_title ?? null;
        if (roomData.created_by === userId) {
          isHost = true;
        } else {
          const { data: hostRow } = await supabase
            .from('connect_room_hosts')
            .select('room_id')
            .eq('room_id', roomData.id)
            .eq('user_id', userId)
            .maybeSingle();
          isHost = !!hostRow;
        }
      } else {
        const { data: instantHosts } = await supabase
          .from('connect_instant_hosts')
          .select('user_id')
          .eq('room_id', room);

        if (!instantHosts || instantHosts.length === 0) {
          // Nobody registered yet for this instant room — this joiner claims it.
          await supabase.from('connect_instant_hosts').insert({ room_id: room, user_id: userId });
          isHost = true;
        } else {
          isHost = instantHosts.some((h) => h.user_id === userId);
        }
      }
    } catch (e) {
      // Ignore DB lookup error — worst case, this joiner just isn't treated as host.
    }

    return res.status(200).json({ token, url: LIVEKIT_URL, identity: userId, roomTitle, is_host: isHost });
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

interface ConnectMemberDirectoryEntry {
  id: string;
  name: string;
  is_internal: boolean;
  role_group: string;
  departments: string[];
}

interface ConnectMembersDirectoryResult {
  members: ConnectMemberDirectoryEntry[];
  allDepartments: string[];
}

/** Full member directory (id, display name, internal flag, role_group, departments) —
 *  shared by /api/connect/members (viewer/host pickers) and /api/connect/rooms (to look
 *  up the requesting user's own role_group/departments for public-mode visibility). */
async function getConnectMembersDirectory(): Promise<ConnectMembersDirectoryResult> {
  const { data, error } = await supabase
    .from('basic_profile_info')
    .select('id, name_english, name_kanji, smiring_department')
    .order('name_english', { ascending: true });

  if (error) throw error;

  const rows = data ?? [];
  const memberIds = rows.map((m) => m.id);

  const [internalIds, { data: roleMappingRows }, { data: deptRows }, { data: deptMappingRows }] =
    await Promise.all([
      getInternalUserIds(memberIds),
      supabase
        .from('user_role_mappings')
        .select('user_id, user_role')
        .in(
          'user_role',
          MEMBER_GROUP_ROLE_IDS.map((r) => r.id),
        )
        .in('user_id', memberIds),
      supabase
        .from('departments')
        .select('id, name, sort_order')
        .order('sort_order', { ascending: true }),
      supabase
        .from('member_department_mappings')
        .select('user_id, department_id')
        .in('user_id', memberIds),
    ]);

  // 表示グループ用の代表ロール。1人が複数該当する場合は MEMBER_GROUP_ROLE_IDS の優先順で決める。
  const roleGroupByUserId = new Map<string, string>();
  for (const { id: roleId, group } of MEMBER_GROUP_ROLE_IDS) {
    for (const row of roleMappingRows ?? []) {
      if (row.user_role === roleId && !roleGroupByUserId.has(row.user_id)) {
        roleGroupByUserId.set(row.user_id, group);
      }
    }
  }

  // Management Consoleの部署マスタ (id -> name)
  const deptNameById = new Map<string, string>();
  const allDepartmentNames: string[] = [];
  for (const d of deptRows ?? []) {
    if (d.id && d.name) {
      deptNameById.set(d.id, d.name);
      allDepartmentNames.push(d.name);
    }
  }

  // ユーザーごとの所属部署名リスト (member_department_mappings を正とする)
  const departmentsByUserId = new Map<string, string[]>();
  for (const dm of deptMappingRows ?? []) {
    const deptName = deptNameById.get(dm.department_id);
    if (deptName && dm.user_id) {
      const list = departmentsByUserId.get(dm.user_id) || [];
      if (!list.includes(deptName)) list.push(deptName);
      departmentsByUserId.set(dm.user_id, list);
    }
  }

  const members = rows.map((m) => {
    // Management Consoleの部署設定を正とする。
    // ※Management Consoleにマッピングが存在する場合はそれを100%使用。
    // まだManagement Console未登録のユーザーのみ、旧smiring_departmentをフォールバックとして保持。
    const mgmtDepts = departmentsByUserId.get(m.id);
    const resolvedDepartments =
      mgmtDepts !== undefined ? mgmtDepts : (m.smiring_department ?? []);

    return {
      id: m.id,
      name: m.name_english || m.name_kanji || m.id,
      is_internal: internalIds.has(m.id),
      role_group: roleGroupByUserId.get(m.id) ?? 'other',
      departments: resolvedDepartments,
    };
  });

  return { members, allDepartments: allDepartmentNames };
}

/** Lightweight member roster for the viewer/host pickers in the create-meeting modal.
 *  Unlike /api/management/members this needs no `management` permission — any logged-in
 *  user creating a fixed meeting must be able to pick teammates. */
router.get('/api/connect/members', authenticate, async (_req: Request, res: Response) => {
  try {
    const { members, allDepartments } = await getConnectMembersDirectory();
    return res.status(200).json({ members, departments: allDepartments });
  } catch (error: any) {
    console.error('[Connect] GET /api/connect/members failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/connect/rooms - List fixed meetings visible to the requesting user
router.get('/api/connect/rooms', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from('connect_rooms')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Connect] Failed to fetch connect_rooms:', error);
      return res.status(500).json({ error: error.message });
    }

    const rooms = data ?? [];

    const [{ members: directory }, { data: viewerRows }, { data: hostRows }, { data: roleRows }, { data: deptRows }, { data: pinRows }] =
      await Promise.all([
        getConnectMembersDirectory(),
        supabase.from('connect_room_viewers').select('room_id').eq('user_id', userId),
        supabase.from('connect_room_hosts').select('room_id').eq('user_id', userId),
        supabase.from('connect_room_visibility_roles').select('room_id, role_group'),
        supabase.from('connect_room_visibility_departments').select('room_id, department'),
        supabase.from('connect_room_pins').select('room_id').eq('user_id', userId),
      ]);

    const pinnedRoomIds = new Set((pinRows ?? []).map((p) => p.room_id));

    const self = directory.find((m) => m.id === userId);
    const selfRoleGroup = self?.role_group ?? 'other';
    const selfDepartments = new Set(self?.departments ?? []);

    // private時=見られる固定名簿、public時=当てはまっていても常に除外する人、の両方に使う
    const viewerRoomIds = new Set((viewerRows ?? []).map((v) => v.room_id));
    const hostRoomIds = new Set((hostRows ?? []).map((h) => h.room_id));

    const allowedRolesByRoom = new Map<string, Set<string>>();
    for (const row of roleRows ?? []) {
      if (!allowedRolesByRoom.has(row.room_id)) allowedRolesByRoom.set(row.room_id, new Set());
      allowedRolesByRoom.get(row.room_id)!.add(row.role_group);
    }
    const allowedDeptsByRoom = new Map<string, Set<string>>();
    for (const row of deptRows ?? []) {
      if (!allowedDeptsByRoom.has(row.room_id)) allowedDeptsByRoom.set(row.room_id, new Set());
      allowedDeptsByRoom.get(row.room_id)!.add(row.department);
    }

    const visibleRooms = rooms
      .filter((room) => {
        // external: 失効後は誰からも新規に見えなくする（作成者自身の一覧からも消える）
        if (room.meeting_type === 'external' && room.expires_at && new Date(room.expires_at) <= new Date()) {
          return false;
        }

        if (room.created_by === userId || hostRoomIds.has(room.id)) return true;

        if (room.access_mode === 'private') {
          return viewerRoomIds.has(room.id);
        }

        // public: 永久除外リストにいれば問答無用で見えない
        if (viewerRoomIds.has(room.id)) return false;
        if (room.public_all) return true;

        const allowedRoles = allowedRolesByRoom.get(room.id);
        const allowedDepts = allowedDeptsByRoom.get(room.id);
        const roleMatches = !!allowedRoles?.has(selfRoleGroup);
        const deptMatches = allowedDepts ? Array.from(selfDepartments).some((d) => allowedDepts.has(d)) : false;
        return roleMatches || deptMatches;
      })
      .map((room) => ({
        ...room,
        is_host: hostRoomIds.has(room.id) || room.created_by === userId,
        is_pinned: pinnedRoomIds.has(room.id),
      }))
      // ピン留め済みを先頭に。同じピン状態内では元の created_at desc 順を維持する（stable sort）
      .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned));

    return res.status(200).json({ rooms: visibleRooms });
  } catch (error: any) {
    console.error('[Connect] GET /api/connect/rooms failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

/** Fetches a connect_rooms row by its internal (table) id and checks whether userId is its
 *  creator or a registered host. Shared by DELETE/PATCH/detail-GET — the "can manage this
 *  specific fixed meeting" checks — as opposed to isRoomHost() above, which takes a LiveKit
 *  room_id text and gates in-call actions (recording, mini rooms). */
async function loadRoomForHostAction(
  roomTableId: string,
  userId: string,
): Promise<{ room: any; isHost: boolean } | null> {
  const { data: room, error } = await supabase
    .from('connect_rooms')
    .select('*')
    .eq('id', roomTableId)
    .maybeSingle();
  if (error) throw error;
  if (!room) return null;

  let isHost = room.created_by === userId;
  if (!isHost) {
    const { data: hostRow } = await supabase
      .from('connect_room_hosts')
      .select('room_id')
      .eq('room_id', roomTableId)
      .eq('user_id', userId)
      .maybeSingle();
    isHost = !!hostRow;
  }
  return { room, isHost };
}

/** Writes the host/viewer(-or-exclude)/role/department child rows for a fixed meeting.
 *  `viewerRows` is private-mode's fixed roster or public-mode's permanent exclude list —
 *  same connect_room_viewers table either way (see isRoomHost's comment on that table).
 *  Shared by create (POST) and edit (PATCH). */
async function writeRoomChildRows(
  roomTableId: string,
  {
    hostIds,
    viewerRows,
    roleGroups,
    departments,
  }: { hostIds: string[]; viewerRows: string[]; roleGroups: string[]; departments: string[] },
): Promise<any> {
  const inserts: PromiseLike<{ error: any }>[] = [];

  if (hostIds.length > 0) {
    inserts.push(
      supabase.from('connect_room_hosts').insert(hostIds.map((uid) => ({ room_id: roomTableId, user_id: uid }))),
    );
  }
  if (viewerRows.length > 0) {
    inserts.push(
      supabase
        .from('connect_room_viewers')
        .insert(viewerRows.map((uid) => ({ room_id: roomTableId, user_id: uid }))),
    );
  }
  if (roleGroups.length > 0) {
    inserts.push(
      supabase
        .from('connect_room_visibility_roles')
        .insert(roleGroups.map((g) => ({ room_id: roomTableId, role_group: g }))),
    );
  }
  if (departments.length > 0) {
    inserts.push(
      supabase
        .from('connect_room_visibility_departments')
        .insert(departments.map((d) => ({ room_id: roomTableId, department: d }))),
    );
  }

  const results = await Promise.all(inserts);
  return results.find((r) => r.error)?.error ?? null;
}

const ROOM_ACCESS_MODES = ['public', 'private'] as const;

// POST /api/connect/rooms - Create a fixed meeting
router.post('/api/connect/rooms', authenticate, requirePermission('connect', 'write'), async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      room_title,
      room_id: requestedRoomId,
      meeting_type,
      access_mode,
      public_all,
      public_role_groups,
      public_departments,
      excluded_user_ids,
      viewer_user_ids,
      host_user_ids,
      host_code,
      expires_at,
      scheduled_start_at,
      scheduled_end_at,
    } = req.body ?? {};

    if (!room_title || typeof room_title !== 'string' || !room_title.trim()) {
      return res.status(400).json({ error: 'ミーティング名を入力してください' });
    }

    const resolvedMeetingType: MeetingType = meeting_type === 'external' ? 'external' : 'fixed';
    const isExternal = resolvedMeetingType === 'external';

    // 外部ミーティングは常に private（作成者 + 明示的に共有した内部メンバーのみ一覧に見える）
    if (!isExternal && !ROOM_ACCESS_MODES.includes(access_mode)) {
      return res.status(400).json({ error: '公開/非公開の指定が不正です' });
    }

    let expiresAt: Date | null = null;
    let scheduledStartAt: Date | null | undefined;
    let scheduledEndAt: Date | null | undefined;
    if (isExternal) {
      expiresAt = parseFutureDate(expires_at);
      if (!expiresAt) {
        return res.status(400).json({ error: '失効日時を（未来の日時で）指定してください' });
      }
      scheduledStartAt = parseOptionalDate(scheduled_start_at);
      scheduledEndAt = parseOptionalDate(scheduled_end_at);
      if (scheduledStartAt === null || scheduledEndAt === null) {
        return res.status(400).json({ error: '開催予定時刻の形式が不正です' });
      }
      if (scheduledStartAt && scheduledEndAt && scheduledEndAt.getTime() < scheduledStartAt.getTime()) {
        return res.status(400).json({ error: '開催予定の終了時刻は開始時刻より後にしてください' });
      }
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

    const isPublic = !isExternal && access_mode === 'public';
    const isPublicAll = isPublic && !!public_all;
    const roleGroups = isPublic && !isPublicAll ? Array.from(new Set(Array.isArray(public_role_groups) ? public_role_groups : [])) : [];
    const departments = isPublic && !isPublicAll ? Array.from(new Set(Array.isArray(public_departments) ? public_departments : [])) : [];
    // private時は「見られる固定名簿」、public時は「当てはまっていても常に除外する人」として同じ connect_room_viewers を使う
    // （外部ミーティングは常にprivate側の「見られる固定名簿」として扱う）
    const viewerRows = isPublic
      ? Array.from(new Set(Array.isArray(excluded_user_ids) ? excluded_user_ids : []))
      : Array.from(new Set(Array.isArray(viewer_user_ids) ? viewer_user_ids : []));

    const { data: room, error } = await supabase
      .from('connect_rooms')
      .insert([
        {
          room_id: finalRoomId,
          room_title: room_title.trim(),
          meeting_type: resolvedMeetingType,
          access_mode: isExternal ? 'private' : access_mode,
          public_all: isPublicAll,
          host_code: typeof host_code === 'string' && host_code.trim() ? host_code.trim() : null,
          created_by: userId,
          expires_at: isExternal ? expiresAt!.toISOString() : null,
          scheduled_start_at: isExternal && scheduledStartAt ? scheduledStartAt.toISOString() : null,
          scheduled_end_at: isExternal && scheduledEndAt ? scheduledEndAt.toISOString() : null,
          invite_token: isExternal ? generateInviteToken() : null,
        },
      ])
      .select()
      .single();

    if (error) {
      console.error('[Connect] Failed to insert connect_rooms:', error);
      return res.status(500).json({ error: error.message });
    }

    // 自分は必ずホストに含める
    const hostIds = Array.from(new Set([userId, ...(Array.isArray(host_user_ids) ? host_user_ids : [])]));

    const childError = await writeRoomChildRows(room.id, { hostIds, viewerRows, roleGroups, departments }).catch(
      (e) => e,
    );
    if (childError) {
      console.error('[Connect] Failed to insert room viewer/host/visibility rows, rolling back room:', childError);
      await supabase.from('connect_rooms').delete().eq('id', room.id);
      return res.status(500).json({ error: '固定ミーティングの作成に失敗しました' });
    }

    return res.status(201).json({ room: { ...room, is_host: true } });
  } catch (error: any) {
    console.error('[Connect] POST /api/connect/rooms failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/connect/rooms/:id - Delete a fixed meeting (creator or host only)
router.delete('/api/connect/rooms/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;
    if (!id) {
      return res.status(400).json({ error: 'IDが指定されていません' });
    }

    const loaded = await loadRoomForHostAction(id, userId).catch((e) => {
      throw e;
    });
    if (!loaded) {
      return res.status(404).json({ error: 'ミーティングが見つかりません' });
    }
    if (!loaded.isHost) {
      return res.status(403).json({ error: 'このミーティングを削除できるのは作成者かホストのみです' });
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

// POST /api/connect/rooms/:id/pin - Pin a fixed meeting for myself (personal, doesn't affect others)
router.post('/api/connect/rooms/:id/pin', authenticate, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;
    const { error } = await supabase
      .from('connect_room_pins')
      .upsert({ room_id: id, user_id: userId }, { onConflict: 'room_id,user_id', ignoreDuplicates: true });

    if (error) {
      console.error('[Connect] Failed to pin room:', error);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Connect] POST /api/connect/rooms/:id/pin failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/connect/rooms/:id/pin - Unpin a fixed meeting for myself
router.delete('/api/connect/rooms/:id/pin', authenticate, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;
    const { error } = await supabase
      .from('connect_room_pins')
      .delete()
      .eq('room_id', id)
      .eq('user_id', userId);

    if (error) {
      console.error('[Connect] Failed to unpin room:', error);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Connect] DELETE /api/connect/rooms/:id/pin failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/connect/rooms/:id/detail - Full editable detail for the edit modal (host only)
router.get('/api/connect/rooms/:id/detail', authenticate, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;

    const loaded = await loadRoomForHostAction(id, userId);
    if (!loaded) {
      return res.status(404).json({ error: 'ミーティングが見つかりません' });
    }
    if (!loaded.isHost) {
      return res.status(403).json({ error: 'この操作にはホスト権限が必要です' });
    }

    const [{ data: viewerRows }, { data: hostRows }, { data: roleRows }, { data: deptRows }] = await Promise.all([
      supabase.from('connect_room_viewers').select('user_id').eq('room_id', id),
      supabase.from('connect_room_hosts').select('user_id').eq('room_id', id),
      supabase.from('connect_room_visibility_roles').select('role_group').eq('room_id', id),
      supabase.from('connect_room_visibility_departments').select('department').eq('room_id', id),
    ]);

    return res.status(200).json({
      id: loaded.room.id,
      room_title: loaded.room.room_title,
      room_id: loaded.room.room_id,
      meeting_type: loaded.room.meeting_type,
      access_mode: loaded.room.access_mode,
      public_all: loaded.room.public_all,
      host_code: loaded.room.host_code,
      expires_at: loaded.room.expires_at,
      scheduled_start_at: loaded.room.scheduled_start_at,
      scheduled_end_at: loaded.room.scheduled_end_at,
      invite_token: loaded.room.invite_token,
      role_groups: (roleRows ?? []).map((r) => r.role_group),
      departments: (deptRows ?? []).map((d) => d.department),
      viewer_user_ids: (viewerRows ?? []).map((v) => v.user_id),
      host_user_ids: (hostRows ?? []).map((h) => h.user_id),
    });
  } catch (error: any) {
    console.error('[Connect] GET /api/connect/rooms/:id/detail failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// PATCH /api/connect/rooms/:id - Update a fixed meeting (host only). room_id (the LiveKit
// room name) is intentionally not editable — changing it would break existing shared links.
router.patch('/api/connect/rooms/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const userId = req.user!.id;
    const {
      room_title,
      access_mode,
      public_all,
      public_role_groups,
      public_departments,
      excluded_user_ids,
      viewer_user_ids,
      host_user_ids,
      host_code,
      expires_at,
      scheduled_start_at,
      scheduled_end_at,
    } = req.body ?? {};

    if (!room_title || typeof room_title !== 'string' || !room_title.trim()) {
      return res.status(400).json({ error: 'ミーティング名を入力してください' });
    }

    const loaded = await loadRoomForHostAction(id, userId);
    if (!loaded) {
      return res.status(404).json({ error: 'ミーティングが見つかりません' });
    }
    if (!loaded.isHost) {
      return res.status(403).json({ error: 'この操作にはホスト権限が必要です' });
    }

    // meeting_type は作成後に変更不可。既存の値によってどのフィールドを更新するか分岐する。
    const isExternal = loaded.room.meeting_type === 'external';

    if (!isExternal && !ROOM_ACCESS_MODES.includes(access_mode)) {
      return res.status(400).json({ error: '公開/非公開の指定が不正です' });
    }

    let expiresAt: Date | null = null;
    let scheduledStartAt: Date | null | undefined;
    let scheduledEndAt: Date | null | undefined;
    if (isExternal) {
      expiresAt = parseFutureDate(expires_at);
      if (!expiresAt) {
        return res.status(400).json({ error: '失効日時を（未来の日時で）指定してください' });
      }
      scheduledStartAt = parseOptionalDate(scheduled_start_at);
      scheduledEndAt = parseOptionalDate(scheduled_end_at);
      if (scheduledStartAt === null || scheduledEndAt === null) {
        return res.status(400).json({ error: '開催予定時刻の形式が不正です' });
      }
      if (scheduledStartAt && scheduledEndAt && scheduledEndAt.getTime() < scheduledStartAt.getTime()) {
        return res.status(400).json({ error: '開催予定の終了時刻は開始時刻より後にしてください' });
      }
    }

    const isPublic = !isExternal && access_mode === 'public';
    const isPublicAll = isPublic && !!public_all;
    const roleGroups = isPublic && !isPublicAll ? Array.from(new Set(Array.isArray(public_role_groups) ? public_role_groups : [])) : [];
    const departments = isPublic && !isPublicAll ? Array.from(new Set(Array.isArray(public_departments) ? public_departments : [])) : [];
    const viewerRows = isPublic
      ? Array.from(new Set(Array.isArray(excluded_user_ids) ? excluded_user_ids : []))
      : Array.from(new Set(Array.isArray(viewer_user_ids) ? viewer_user_ids : []));
    const hostIds = Array.from(new Set([userId, ...(Array.isArray(host_user_ids) ? host_user_ids : [])]));

    const { data: room, error } = await supabase
      .from('connect_rooms')
      .update({
        room_title: room_title.trim(),
        access_mode: isExternal ? 'private' : access_mode,
        public_all: isPublicAll,
        host_code: typeof host_code === 'string' && host_code.trim() ? host_code.trim() : null,
        ...(isExternal
          ? {
              expires_at: expiresAt!.toISOString(),
              scheduled_start_at: scheduledStartAt ? scheduledStartAt.toISOString() : null,
              scheduled_end_at: scheduledEndAt ? scheduledEndAt.toISOString() : null,
            }
          : {}),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('[Connect] Failed to update connect_rooms:', error);
      return res.status(500).json({ error: error.message });
    }

    const [delViewers, delHosts, delRoles, delDepts] = await Promise.all([
      supabase.from('connect_room_viewers').delete().eq('room_id', id),
      supabase.from('connect_room_hosts').delete().eq('room_id', id),
      supabase.from('connect_room_visibility_roles').delete().eq('room_id', id),
      supabase.from('connect_room_visibility_departments').delete().eq('room_id', id),
    ]);
    const delError = [delViewers, delHosts, delRoles, delDepts].find((r) => r.error)?.error;
    if (delError) {
      console.error('[Connect] Failed to clear room child rows before rewrite:', delError);
      return res.status(500).json({ error: '固定ミーティングの更新に失敗しました' });
    }

    const childError = await writeRoomChildRows(id, { hostIds, viewerRows, roleGroups, departments });
    if (childError) {
      console.error('[Connect] Failed to rewrite room child rows:', childError);
      return res.status(500).json({ error: '固定ミーティングの更新に失敗しました' });
    }

    return res.status(200).json({ room: { ...room, is_host: true } });
  } catch (error: any) {
    console.error('[Connect] PATCH /api/connect/rooms/:id failed:', error);
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

    // If this room's session has nobody left in it, wipe leftover messages. Uses the
    // session-aware check (not plain isRoomEmpty) because `roomId` here can be a main
    // room that still has active mini rooms under it — see isMainRoomSessionEmpty.
    if (roomService) {
      try {
        if (await isMainRoomSessionEmpty(roomId)) {
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
  requireRoomHost,
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

// PATCH /api/connect/rooms/:roomId/miniroom/settings - Update allowSelfAssign for all active mini rooms in this session.
router.patch(
  '/api/connect/rooms/:roomId/miniroom/settings',
  authenticate,
  requireRoomHost,
  async (req: Request, res: Response) => {
    try {
      const { roomId } = req.params;
      if (!isValidRoomName(roomId)) {
        return res.status(400).json({ error: 'ルーム名が不正です' });
      }

      const { allowSelfAssign } = req.body ?? {};
      if (typeof allowSelfAssign !== 'boolean') {
        return res.status(400).json({ error: 'allowSelfAssign (boolean) が必要です' });
      }

      const { error: updateError } = await supabase
        .from('connect_miniroom_rooms')
        .update({ allow_self_assign: allowSelfAssign })
        .eq('main_room_id', roomId);

      if (updateError) {
        console.error('[Connect] Failed to update allow_self_assign:', updateError);
        return res.status(500).json({ error: '設定の更新に失敗しました' });
      }

      const allMiniRooms = await getActiveMiniRooms(roomId);
      const rooms = serializeMiniRooms(allMiniRooms);
      await broadcastMiniRoomSync(roomId, rooms, allowSelfAssign);

      return res.status(200).json({ ok: true, allowSelfAssign });
    } catch (error: any) {
      console.error('[Connect] PATCH .../miniroom/settings failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// PATCH /api/connect/rooms/:roomId/miniroom/:miniRoomId - Rename a mini room.
router.patch(
  '/api/connect/rooms/:roomId/miniroom/:miniRoomId',
  authenticate,
  requireRoomHost,
  async (req: Request, res: Response) => {
    try {
      const { roomId, miniRoomId } = req.params;
      if (!isValidRoomName(roomId)) {
        return res.status(400).json({ error: 'ルーム名が不正です' });
      }

      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name || name.length > 40) {
        return res.status(400).json({ error: 'ルーム名は1〜40文字で入力してください' });
      }

      const { error: updateError } = await supabase
        .from('connect_miniroom_rooms')
        .update({ name })
        .eq('id', miniRoomId)
        .eq('main_room_id', roomId);

      if (updateError) {
        console.error('[Connect] Failed to rename mini room:', updateError);
        return res.status(500).json({ error: 'ルーム名の更新に失敗しました' });
      }

      const allMiniRooms = await getActiveMiniRooms(roomId);
      const rooms = serializeMiniRooms(allMiniRooms);
      const allowSelfAssign = allMiniRooms[0]?.allow_self_assign ?? false;
      await broadcastMiniRoomSync(roomId, rooms, allowSelfAssign);

      return res.status(200).json({ ok: true, room: { id: miniRoomId, name } });
    } catch (error: any) {
      console.error('[Connect] PATCH .../miniroom/:miniRoomId failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// GET /api/connect/rooms/:roomId/miniroom/participants - Live roster with current room, for the host's move UI.
router.get(
  '/api/connect/rooms/:roomId/miniroom/participants',
  authenticate,
  requireRoomHost,
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

        const pending = getPendingAssignment(roomId, p.identity);
        let pendingRoomId: string | undefined = undefined;
        let pendingRoomName: string | undefined = undefined;

        if (pending) {
          if (currentRoomId === pending.destinationRoomId) {
            clearPendingAssignment(roomId, p.identity);
          } else {
            pendingRoomId = pending.destinationRoomId;
            pendingRoomName = pending.destinationName;
          }
        }

        return {
          identity: p.identity,
          name: p.name || p.identity,
          avatarUrl,
          currentRoomId,
          pendingRoomId,
          pendingRoomName,
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
//
// NOTE: this deployment's self-hosted LiveKit server does not implement the
// `MoveParticipant` RPC (`RoomServiceClient.moveParticipant` returns "twirp error
// unknown: not implemented" — confirmed against livekit/livekit-server:latest; this
// appears to be a LiveKit Cloud-only capability). So instead of moving the participant
// server-side, this mints a token for the destination room and hands it to the client,
// which disconnects and reconnects itself:
//  - self-move: the token comes back directly in this response.
//  - host-move-other: the token is embedded in a `miniroom_notify` data message sent
//    only to the target's identity (via sendData, which doesn't require the sender to
//    be connected to that room) — their own client applies it after `delayMs`.
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
    const isHost = await isRoomHost(userId, roomId);

    if (isSelfMove) {
      // Returning to the main room is always allowed; joining a mini room yourself
      // requires the session's allow_self_assign flag, unless you're a host (hosts can
      // already move anyone anywhere, so they shouldn't be blocked from moving themselves).
      const allowSelfAssign = miniRooms[0]?.allow_self_assign ?? false;
      if (destinationRoomId !== roomId && !allowSelfAssign && !isHost) {
        return res.status(403).json({ error: 'このルームへは自分で移動できません' });
      }

      // Self-initiated: apply immediately, no notify/delay — the client already knows
      // it asked for this, it just needs a token for the destination room.
      const token = await mintLiveKitToken(userId, destinationRoomId);
      return res.status(200).json({ ok: true, token, url: LIVEKIT_URL, destinationRoomId });
    }

    if (!isHost) {
      return res.status(403).json({ error: '他の参加者を移動させるにはホスト権限が必要です' });
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

    // Host-initiated move of someone else: mint their destination token now and send it
    // along with the notice, so the target's own client can apply it after `delayMs`
    // (they see a "moving to..." toast in the meantime rather than an instant cut).
    const destinationName = destinationRoomId === roomId ? 'メインルーム' : destinationMiniRoom!.name;

    if (destinationRoomId === roomId) {
      clearPendingAssignment(roomId, targetIdentity);
    } else {
      setPendingAssignment(roomId, targetIdentity, destinationRoomId, destinationName);
    }

    const delayMs = 4000;
    const targetToken = await mintLiveKitToken(targetIdentity, destinationRoomId);
    const notifyPayload = Buffer.from(
      JSON.stringify({
        type: 'miniroom_notify',
        action: 'assigned',
        destinationRoomId,
        destinationName,
        token: targetToken,
        url: LIVEKIT_URL,
        delayMs,
      }),
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
  requireRoomHost,
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

      await Promise.all(
        targets.map(async (miniRoom) => {
          let participants: { identity: string }[] = [];
          try {
            participants = await roomService!.listParticipants(miniRoom.id);
          } catch (e) {
            console.warn(`[Connect] listParticipants failed for ${miniRoom.id}:`, e);
          }

          // Mint each participant their own main-room token and notify them — same
          // client-driven-reconnect mechanism as /miniroom/move (see the comment there:
          // this self-hosted LiveKit deployment doesn't support server-side
          // moveParticipant). No further backend action needed per participant; their
          // own client applies the token after `delayMs`.
          await Promise.all(
            participants.map(async (p) => {
              try {
                const token = await mintLiveKitToken(p.identity, roomId);
                const notifyPayload = Buffer.from(
                  JSON.stringify({
                    type: 'miniroom_notify',
                    action: 'session_close',
                    destinationRoomId: roomId,
                    destinationName: 'メインルーム',
                    token,
                    url: LIVEKIT_URL,
                    delayMs,
                  }),
                  'utf8',
                );
                await roomService!.sendData(miniRoom.id, notifyPayload, DataPacket_Kind.RELIABLE, {
                  destinationIdentities: [p.identity],
                  topic: 'miniroom_notify',
                });
              } catch (e) {
                console.warn('[Connect] close notify send failed:', e);
              }
            }),
          );

          // Give the client-driven moves a head start before tearing the room down;
          // deleteRoom force-disconnects anyone still there, which is fine since
          // they're leaving anyway (a client that missed the notify, e.g. a dropped
          // connection, gets no graceful move — acceptable for this cleanup path).
          setTimeout(() => {
            roomService!.deleteRoom(miniRoom.id).catch(() => {});
          }, delayMs + 2000);
        }),
      );

      const idsToRemove = targets.map((r) => r.id);
      if (miniRoomId) {
        clearRoomPendingAssignments(roomId, miniRoomId);
      } else {
        clearRoomPendingAssignments(roomId);
      }
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

// ==========================================
// ⏺️ 録画（SmiRing Connect）
// ==========================================

// POST /api/connect/rooms/:roomId/recording/start -> { recordingId }
// Records every participant's tracks individually (Track Egress); the files are stitched
// into one video later by the compositor Cloud Run Job — nothing composites on the
// Hetzner box, which is busy serving the live call.
router.post(
  '/api/connect/rooms/:roomId/recording/start',
  authenticate,
  requireRoomHost,
  async (req: Request, res: Response) => {
    const roomId = req.params.roomId;
    if (!isValidRoomName(roomId)) {
      return res.status(400).json({ error: 'ルーム名が不正です' });
    }
    if (!roomService || !isRecordingConfigured()) {
      return res.status(503).json({ error: '録画機能が設定されていません' });
    }

    try {
      if (await getRecordingSession(roomService, roomId)) {
        return res.status(409).json({ error: 'このルームは既に録画中です' });
      }

      // Excludes any leftover egress bot from a just-ended recording of this same room —
      // see the webhook handler's comment on `ParticipantInfo_Kind`.
      const participants = (await roomService.listParticipants(roomId)).filter(
        (p) => p.kind === ParticipantInfo_Kind.STANDARD,
      );
      if (participants.length === 0) {
        return res.status(400).json({ error: '参加者がいないため録画を開始できません' });
      }

      const { data: room } = await supabase
        .from('connect_rooms')
        .select('room_title')
        .eq('room_id', roomId)
        .maybeSingle();

      const { data: recording, error: insertError } = await supabase
        .from('connect_recordings')
        .insert({
          room_id: roomId,
          room_title: room?.room_title ?? null,
          status: 'recording',
          started_by: req.user!.id,
        })
        .select('id')
        .single();
      if (insertError) throw insertError;

      // Everyone already here counts as present from the first frame — the webhook only
      // reports people who arrive after this point.
      await openParticipantPresence(
        recording.id,
        participants.map((p) => p.identity),
      );

      const { attempted, started } = await startRecordingForParticipants(roomId, recording.id, participants);
      if (attempted > 0 && started === 0) {
        await supabase.from('connect_recordings').update({ status: 'failed' }).eq('id', recording.id);
        return res.status(502).json({ error: '録画を開始できませんでした' });
      }
      // Nothing to start is fine — an empty room, or one where every camera happens to be off
      // right now. Tracks are picked up as they appear (`track_published`) or as cameras come
      // off mute (`/recording/sync`).

      // Written last: while this pointer is absent, the webhook won't record newly
      // published tracks, so setting it before the initial tracks are running would let a
      // track get an egress from both paths at once.
      await setRecordingSession(roomService, roomId, {
        recordingId: recording.id,
        startedBy: req.user!.id,
        startedAt: Date.now(),
      });

      return res.json({ recordingId: recording.id, trackCount: started });
    } catch (error: any) {
      console.error('[Connect] POST .../recording/start failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// POST /api/connect/rooms/:roomId/recording/stop
// Returns as soon as the egresses are stopped — compositing runs asynchronously, and the
// row's status is how the frontend follows it from there.
router.post(
  '/api/connect/rooms/:roomId/recording/stop',
  authenticate,
  requireRoomHost,
  async (req: Request, res: Response) => {
    const roomId = req.params.roomId;
    if (!isValidRoomName(roomId)) {
      return res.status(400).json({ error: 'ルーム名が不正です' });
    }
    if (!roomService || !isRecordingConfigured()) {
      return res.status(503).json({ error: '録画機能が設定されていません' });
    }

    try {
      const recordingId = await getActiveRecordingId(roomId);
      if (!recordingId) {
        return res.status(404).json({ error: 'このルームは録画中ではありません' });
      }

      await finishRecording(roomService, roomId, recordingId);
      return res.json({ recordingId, status: 'processing' });
    } catch (error: any) {
      console.error('[Connect] POST .../recording/stop failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// POST /api/connect/rooms/:roomId/recording/sync
//
// A participant pokes this after toggling their camera, because LiveKit gives the server no
// other way to find out: `track_published` fires only on the first publish of a session, and
// there is no mute webhook. Nothing in the request is trusted — no body is read at all. The
// caller only causes this server to go and re-read LiveKit's own state and act on it, so a
// lost or spurious call costs a reconciliation, never a wrong timestamp.
//
// Deliberately `authenticate` only, without `connect_recording.write`: anyone in the call can
// turn their camera on, including people who can't start or stop the recording.
router.post('/api/connect/rooms/:roomId/recording/sync', authenticate, async (req: Request, res: Response) => {
  const roomId = req.params.roomId;
  if (!isValidRoomName(roomId)) {
    return res.status(400).json({ error: 'ルーム名が不正です' });
  }
  if (!roomService || !isRecordingConfigured()) {
    return res.json({ synced: false });
  }

  try {
    const recordingId = await getActiveRecordingId(roomId);
    if (!recordingId) return res.json({ synced: false });

    const participants = await roomService.listParticipants(roomId);
    if (!participants.some((p) => p.identity === req.user!.id)) {
      return res.status(403).json({ error: 'このルームの参加者ではありません' });
    }

    await syncCameraRecordings(roomId, recordingId, participants);
    return res.json({ synced: true });
  } catch (error: any) {
    console.error('[Connect] POST .../recording/sync failed:', error?.message);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/connect/rooms/:roomId/recording -> { recording, startedAt }
// Intentionally only `authenticate`: everyone in the call needs to see that they're being
// recorded, including participants who can't start or stop it themselves.
router.get('/api/connect/rooms/:roomId/recording', authenticate, async (req: Request, res: Response) => {
  const roomId = req.params.roomId;
  if (!isValidRoomName(roomId)) {
    return res.status(400).json({ error: 'ルーム名が不正です' });
  }
  if (!roomService || !isRecordingConfigured()) {
    return res.json({ recording: false });
  }

  try {
    const session = await getRecordingSession(roomService, roomId);
    return res.json(
      session
        ? { recording: true, recordingId: session.recordingId, startedAt: session.startedAt }
        : { recording: false },
    );
  } catch (error: any) {
    console.error('[Connect] GET .../recording failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Shared row shape for both list and single-recording endpoints below.
async function serializeRecording(row: {
  id: string;
  room_id: string;
  room_title: string | null;
  status: string;
  progress: number | null;
  r2_key: string | null;
  thumbnail_key: string | null;
  duration_seconds: number | null;
  created_at: string;
  completed_at: string | null;
}) {
  // Signed per request rather than stored: the URLs expire in an hour, so a cached one
  // would be dead by the time most people came back to it.
  const isCompleted = row.status === 'completed';
  const [url, thumbnailUrl] = await Promise.all([
    isCompleted ? getSignedFileUrl(row.r2_key) : null,
    isCompleted ? getSignedFileUrl(row.thumbnail_key) : null,
  ]);
  return {
    id: row.id,
    roomId: row.room_id,
    roomTitle: row.room_title,
    status: row.status,
    progress: row.progress,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    url,
    thumbnailUrl,
  };
}

const RECORDING_COLUMNS =
  'id, room_id, room_title, status, progress, r2_key, thumbnail_key, duration_seconds, created_at, completed_at';

// GET /api/connect/recordings -> every recording across every room, newest first.
// (Recordings live in one app-wide list now, not one per room — see RecordingsListPage.)
router.get(
  '/api/connect/recordings',
  authenticate,
  requirePermission('connect_recording', 'read'),
  async (_req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('connect_recordings')
        .select(RECORDING_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;

      const recordings = await Promise.all((data ?? []).map(serializeRecording));
      return res.json({ recordings });
    } catch (error: any) {
      console.error('[Connect] GET /recordings failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// GET /api/connect/recordings/:id -> one recording, for the player page.
router.get(
  '/api/connect/recordings/:id',
  authenticate,
  requirePermission('connect_recording', 'read'),
  async (req: Request, res: Response) => {
    try {
      const { data, error } = await supabase
        .from('connect_recordings')
        .select(RECORDING_COLUMNS)
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: '録画が見つかりません' });

      return res.json(await serializeRecording(data));
    } catch (error: any) {
      console.error('[Connect] GET /recordings/:id failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// DELETE /api/connect/recordings/:id -> delete a recording and its R2 objects
router.delete(
  '/api/connect/recordings/:id',
  authenticate,
  requirePermission('connect_recording', 'write'),
  async (req: Request, res: Response) => {
    try {
      const recordingId = req.params.id;

      // 1. レコード取得
      const { data: recording, error: fetchError } = await supabase
        .from('connect_recordings')
        .select('id, r2_key, thumbnail_key')
        .eq('id', recordingId)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!recording) {
        return res.status(404).json({ error: '録画が見つかりません' });
      }

      // 2. R2上の成果物（動画・サムネイル）を削除
      const deletePromises: Promise<any>[] = [];
      if (recording.r2_key) {
        deletePromises.push(
          r2.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: recording.r2_key })).catch((e) => {
            console.warn('[Connect] Failed to delete r2_key:', recording.r2_key, e);
          }),
        );
      }
      if (recording.thumbnail_key) {
        deletePromises.push(
          r2.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: recording.thumbnail_key })).catch((e) => {
            console.warn('[Connect] Failed to delete thumbnail_key:', recording.thumbnail_key, e);
          }),
        );
      }
      await Promise.all(deletePromises);

      // 3. トラック一覧レコードを削除
      await supabase
        .from('connect_recording_tracks')
        .delete()
        .eq('recording_id', recordingId);

      // 4. 録画レコード本体を削除
      const { error: deleteError } = await supabase
        .from('connect_recordings')
        .delete()
        .eq('id', recordingId);

      if (deleteError) throw deleteError;

      return res.json({ success: true });
    } catch (error: any) {
      console.error('[Connect] DELETE /recordings/:id failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// ============================================================================
// 完全外部ユーザー（DBアカウントなし）向けの招待URL経由の参加フロー。
// ここから4本のルートは意図的に `authenticate` を付けない — ログインしていない
// ブラウザから呼ばれる前提のエンドポイントのため。その代わり、すべての操作は
// `meeting_type === 'external'` かつ有効な `invite_token`（連想推測不可能なランダム値、
// host_codeと同じ「合言葉」的信頼レベル）を提示できることでのみ許可される。
// `fixed` なミーティングに対してこれらのルートが何かを漏らす・許可することは絶対にない
// ——固定ミーティングは常に認証必須のまま。
//
// 待機室（connect_room_waitlist）は今回、外部ミーティングでは常にON、固定ミーティングでは
// 常にOFFという決め打ち（切り替えUIはまだ無い）。ホストが承認する画面（参加許可UI）は次の
// スコープで作るため、/join-request で作られる行は今のところ pending のまま留まり続ける
// ——admitted に進める手段は本ラウンドでは未実装（意図的な範囲外）。
// ============================================================================

/** Loads a connect_rooms row by its LiveKit room_id (text), or null if unregistered. */
async function findRoomByRoomId(roomId: string) {
  const { data, error } = await supabase.from('connect_rooms').select('*').eq('room_id', roomId).maybeSingle();
  if (error) throw error;
  return data;
}

/** Validates that `room` is a live, unexpired external meeting reachable via `inviteToken`. */
function checkExternalInvite(room: any, inviteToken: unknown): string | null {
  if (!room || room.meeting_type !== 'external') {
    return 'このミーティングは招待URLでの参加に対応していません';
  }
  if (!room.invite_token || typeof inviteToken !== 'string' || inviteToken !== room.invite_token) {
    return '招待URLが無効です';
  }
  if (!room.expires_at || new Date(room.expires_at).getTime() <= Date.now()) {
    return 'この招待URLは失効しています';
  }
  return null;
}

// GET /api/connect/invite/:token - Resolve an invite token to its room, for the /j/:token
// landing page to know what it's rendering PreJoin for before the visitor has entered a name.
router.get('/api/connect/invite/:token', async (req: Request, res: Response) => {
  try {
    const token = req.params.token as string;
    const { data: room, error } = await supabase
      .from('connect_rooms')
      .select('room_id, room_title, meeting_type, expires_at, invite_token')
      .eq('invite_token', token)
      .maybeSingle();
    if (error) throw error;

    const invalidReason = checkExternalInvite(room, token);
    if (invalidReason) {
      return res.status(404).json({ error: invalidReason });
    }

    return res.status(200).json({
      room_id: room!.room_id,
      room_title: room!.room_title,
    });
  } catch (error: any) {
    console.error('[Connect] GET /api/connect/invite/:token failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/rooms/:roomId/join-request - Registers a pending waitlist entry for an
// anonymous invite-link visitor (waiting room is hardcoded ON for every external meeting).
router.post('/api/connect/rooms/:roomId/join-request', async (req: Request, res: Response) => {
  try {
    const roomId = req.params.roomId as string;
    const { invite_token, username } = req.body ?? {};
    if (!isValidRoomName(roomId)) {
      return res.status(400).json({ error: 'ルーム名が不正です' });
    }
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: '表示名を入力してください' });
    }

    const room = await findRoomByRoomId(roomId);
    const invalidReason = checkExternalInvite(room, invite_token);
    if (invalidReason) {
      return res.status(403).json({ error: invalidReason });
    }

    const { data: waitlistRow, error } = await supabase
      .from('connect_room_waitlist')
      .insert([{ room_id: roomId, display_name: username.trim(), status: 'pending' }])
      .select('id, status')
      .single();
    if (error) throw error;

    await broadcastWaitlistUpdate(roomId);

    return res.status(201).json({ status: waitlistRow.status, waitlist_id: waitlistRow.id });
  } catch (error: any) {
    console.error('[Connect] POST /api/connect/rooms/:roomId/join-request failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// GET /api/connect/rooms/:roomId/join-request/:waitlistId - Polled by the waiting-room screen
// to find out once a host admits this visitor. The waitlist row's own uuid acts as the bearer
// capability here (same trust level as invite_token) since there's no account to check against.
router.get('/api/connect/rooms/:roomId/join-request/:waitlistId', async (req: Request, res: Response) => {
  try {
    const roomId = req.params.roomId as string;
    const waitlistId = req.params.waitlistId as string;
    const { data: waitlistRow, error } = await supabase
      .from('connect_room_waitlist')
      .select('status')
      .eq('id', waitlistId)
      .eq('room_id', roomId)
      .maybeSingle();
    if (error) throw error;
    if (!waitlistRow) {
      return res.status(404).json({ error: '入室リクエストが見つかりません' });
    }

    return res.status(200).json({ status: waitlistRow.status });
  } catch (error: any) {
    console.error('[Connect] GET /api/connect/rooms/:roomId/join-request/:waitlistId failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /api/connect/rooms/:roomId/join-request/:waitlistId - Lets a waiting visitor
// withdraw their own still-pending request (the waiting-room screen's "戻る" button calls
// this). Only ever deletes a `pending` row — never touches one already admitted/denied, so
// this can't be used to erase that history. Without this, cancelling out of the waiting
// room left the row behind forever with no admission UI yet to ever resolve it.
router.delete('/api/connect/rooms/:roomId/join-request/:waitlistId', async (req: Request, res: Response) => {
  try {
    const roomId = req.params.roomId as string;
    const waitlistId = req.params.waitlistId as string;
    const { error } = await supabase
      .from('connect_room_waitlist')
      .delete()
      .eq('id', waitlistId)
      .eq('room_id', roomId)
      .eq('status', 'pending');
    if (error) throw error;

    await broadcastWaitlistUpdate(roomId);

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('[Connect] DELETE /api/connect/rooms/:roomId/join-request/:waitlistId failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/rooms/:roomId/join-request/:waitlistId/heartbeat - The waiting-room
// screen pings this every 5s so the host's Participants panel can tell a visitor who closed
// their tab (or lost network) apart from one still actually there — see the staleness check
// in GET .../waitlist below, which is what actually flips a quiet row to 'left'. Self-healing:
// pinging a row already flipped to 'left' revives it back to 'pending', so a transient network
// blip that missed one or two heartbeats doesn't permanently drop the visitor from the queue.
router.post(
  '/api/connect/rooms/:roomId/join-request/:waitlistId/heartbeat',
  async (req: Request, res: Response) => {
    try {
      const roomId = req.params.roomId as string;
      const waitlistId = req.params.waitlistId as string;
      const { error } = await supabase
        .from('connect_room_waitlist')
        .update({ status: 'pending', last_seen_at: new Date().toISOString() })
        .eq('id', waitlistId)
        .eq('room_id', roomId)
        .in('status', ['pending', 'left']); // never revives an admitted/denied (terminal) row
      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (error: any) {
      console.error(
        '[Connect] POST /api/connect/rooms/:roomId/join-request/:waitlistId/heartbeat failed:',
        error,
      );
      return res.status(500).json({ error: error.message });
    }
  },
);

// ============================================================================
// ホスト向けの参加許可UI（Participantsパネル）が使う、ログイン必須のエンドポイント。
// 上のjoin-request系（招待URL経由の匿名アクセス）とは信頼レベルが逆で、こちらは
// authenticate必須 + isRoomHost() チェック必須。
// ============================================================================

// GET /api/connect/rooms/:roomId/waitlist - Host-only: current pending join requests.
router.get('/api/connect/rooms/:roomId/waitlist', authenticate, async (req: Request, res: Response) => {
  try {
    const roomId = req.params.roomId as string;
    if (!(await ensureRoomHost(req, res, roomId))) return;

    // A visitor whose heartbeat has gone quiet for 20s+ (tab closed, network dropped,
    // browser crashed, ...) is treated as having left — flip them out of 'pending' before
    // reading the list below, rather than running a separate scheduled job for it: this
    // endpoint is already polled every 8s by the host's Participants panel, which is timely
    // enough. A row flipped here is revived back to 'pending' if a heartbeat does land later
    // (see the heartbeat endpoint above), so a transient blip isn't mistaken for a real leave.
    const staleCutoff = new Date(Date.now() - 20_000).toISOString();
    const { error: staleError } = await supabase
      .from('connect_room_waitlist')
      .update({ status: 'left' })
      .eq('room_id', roomId)
      .eq('status', 'pending')
      .lt('last_seen_at', staleCutoff);
    if (staleError) {
      console.error('[Connect] failed to flip stale waitlist rows for', roomId, staleError);
    }

    const { data, error } = await supabase
      .from('connect_room_waitlist')
      .select('id, display_name, created_at')
      .eq('room_id', roomId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw error;

    return res.status(200).json({ waitlist: data ?? [] });
  } catch (error: any) {
    console.error('[Connect] GET /api/connect/rooms/:roomId/waitlist failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/rooms/:roomId/waitlist/:waitlistId/admit - Host-only.
router.post(
  '/api/connect/rooms/:roomId/waitlist/:waitlistId/admit',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const roomId = req.params.roomId as string;
    const waitlistId = req.params.waitlistId as string;
      if (!(await ensureRoomHost(req, res, roomId))) return;

      const { error } = await supabase
        .from('connect_room_waitlist')
        .update({ status: 'admitted', updated_at: new Date().toISOString() })
        .eq('id', waitlistId)
        .eq('room_id', roomId)
        .eq('status', 'pending');
      if (error) throw error;

      await broadcastWaitlistUpdate(roomId);

      return res.status(200).json({ success: true });
    } catch (error: any) {
      console.error('[Connect] POST /api/connect/rooms/:roomId/waitlist/:waitlistId/admit failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// POST /api/connect/rooms/:roomId/waitlist/:waitlistId/deny - Host-only.
router.post(
  '/api/connect/rooms/:roomId/waitlist/:waitlistId/deny',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const roomId = req.params.roomId as string;
    const waitlistId = req.params.waitlistId as string;
      if (!(await ensureRoomHost(req, res, roomId))) return;

      const { error } = await supabase
        .from('connect_room_waitlist')
        .update({ status: 'denied', updated_at: new Date().toISOString() })
        .eq('id', waitlistId)
        .eq('room_id', roomId)
        .eq('status', 'pending');
      if (error) throw error;

      await broadcastWaitlistUpdate(roomId);

      return res.status(200).json({ success: true });
    } catch (error: any) {
      console.error('[Connect] POST /api/connect/rooms/:roomId/waitlist/:waitlistId/deny failed:', error);
      return res.status(500).json({ error: error.message });
    }
  },
);

// POST /api/connect/rooms/:roomId/anonymous-token - Mints a LiveKit token for an admitted,
// unauthenticated invite-link visitor. Requires an `admitted` waitlist row — an anonymous
// visitor can never skip the waiting room (there's no host bypass without an account).
router.post('/api/connect/rooms/:roomId/anonymous-token', async (req: Request, res: Response) => {
  try {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return res.status(503).json({
        error: 'LiveKit is not configured',
        detail: 'サーバー側で LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET が未設定です。',
      });
    }

    const roomId = req.params.roomId as string;
    const { invite_token, username, waitlist_id } = req.body ?? {};
    if (!isValidRoomName(roomId)) {
      return res.status(400).json({ error: 'ルーム名が不正です' });
    }
    if (typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: '表示名を入力してください' });
    }

    const room = await findRoomByRoomId(roomId);
    const invalidReason = checkExternalInvite(room, invite_token);
    if (invalidReason) {
      return res.status(403).json({ error: invalidReason });
    }

    if (typeof waitlist_id !== 'string' || !waitlist_id) {
      return res.status(403).json({ error: '入室リクエストが必要です' });
    }
    const { data: waitlistRow, error: waitlistError } = await supabase
      .from('connect_room_waitlist')
      .select('status')
      .eq('id', waitlist_id)
      .eq('room_id', roomId)
      .maybeSingle();
    if (waitlistError) throw waitlistError;
    if (!waitlistRow || waitlistRow.status !== 'admitted') {
      return res.status(403).json({ error: 'まだ入室が許可されていません' });
    }

    const anonymousId = `guest_${crypto.randomUUID()}`;
    const token = await mintLiveKitToken(anonymousId, roomId, username.trim());

    return res.status(200).json({
      token,
      url: LIVEKIT_URL,
      identity: anonymousId,
      roomTitle: room.room_title,
      is_host: false,
    });
  } catch (error: any) {
    console.error('[Connect] POST /api/connect/rooms/:roomId/anonymous-token failed:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/webhook - LiveKit webhook receiver.
// No `authenticate` here: this is called by the LiveKit server itself, not a logged-in
// user. Authenticity is verified via the signed `Authorization` header instead (see
// WebhookReceiver.receive below), which checks both the API key/secret and a SHA-256 of
// the exact raw body. LiveKit posts this with `Content-Type: application/webhook+json`
// (not `application/json`), so `req.body` here is the raw `Buffer` produced by the
// express.raw() middleware scoped to this path in index.ts — never JSON-parsed, since the
// hash has to be computed over the exact bytes LiveKit signed.
router.post('/api/connect/webhook', async (req: Request, res: Response) => {
  if (!webhookReceiver) {
    console.error('[Connect] Webhook received but LIVEKIT_API_KEY/SECRET are not configured');
    return res.status(503).end();
  }

  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const event = await webhookReceiver.receive(rawBody, req.get('Authorization'));

    // Someone published a track while a recording is running — a late joiner, or a camera
    // or screen share switched on. Their track needs its own egress; the ones started when
    // recording began only cover what was already published then.
    if (event.event === 'track_published' && event.room?.name && event.participant && event.track && roomService) {
      const roomId = event.room.name;
      try {
        const session = await getRecordingSession(roomService, roomId);
        if (session) {
          await startTrackRecording(
            roomId,
            session.recordingId,
            event.participant.identity,
            event.track.source,
            event.track.sid,
          );
        }
      } catch (e: any) {
        console.error(`[Connect] Failed to record newly published track in ${roomId}:`, e?.message);
      }
    }

    // Presence is tracked independently of tracks: someone who joins with both camera and mic
    // off publishes nothing at all, and without this they would be entirely absent from the
    // recording rather than showing as an avatar tile for the time they were actually here.
    //
    // Egress itself joins the room as a hidden participant to subscribe to tracks (identity
    // like `EG_xxxxx`, `kind: EGRESS`) and fires these same events — `kind` is what tells it
    // apart from a real person; identity alone can't (it isn't a UUID, but nothing enforces
    // that a real one couldn't look this way too).
    if (
      (event.event === 'participant_joined' || event.event === 'participant_left') &&
      event.room?.name &&
      event.participant &&
      event.participant.kind === ParticipantInfo_Kind.STANDARD
    ) {
      const roomId = event.room.name;
      const identity = event.participant.identity;
      try {
        const recordingId = await getActiveRecordingId(roomId);
        if (recordingId) {
          if (event.event === 'participant_joined') {
            await openParticipantPresence(recordingId, [identity]);
          } else {
            await closeParticipantPresence(recordingId, identity);
            // Their tracks have to be closed here too. `syncCameraRecordings` is the only
            // other thing that closes one, and it reads `listParticipants()` — which this
            // person has just dropped out of, so it will never look at them again. Leaving
            // the rows open would hold a camera slot (see `MAX_RECORDED_CAMERAS`) for
            // someone who is no longer in the call.
            await closeParticipantTracks(recordingId, identity);

            // Someone leaving is the one moment a camera slot can free up, so it is also the
            // moment to refill it: anyone whose camera was on but went unrecorded because the
            // cap was full gets picked up here. Without this they would stay an avatar tile
            // until somebody happened to toggle a camera, since that is the only other thing
            // that pokes `/recording/sync`. It no-ops when nothing is waiting for a slot.
            if (roomService) {
              await syncCameraRecordings(roomId, recordingId, await roomService.listParticipants(roomId));
            }
          }
        }
      } catch (e: any) {
        console.error(`[Connect] Failed to track presence for ${identity} in ${roomId}:`, e?.message);
      }
    }

    const maybeDone =
      (event.event === 'room_finished' && event.room?.name) ||
      (event.event === 'participant_left' && event.room?.name && event.room.numParticipants === 0);

    // Even when LiveKit itself reports this specific room as finished/empty, that alone
    // doesn't mean the whole session is over — `event.room.name` could be a main room
    // whose participants are all currently split into still-active mini rooms (or a
    // mini room finishing independently of the others). isMainRoomSessionEmpty checks
    // the whole family before anything gets deleted.
    if (maybeDone && event.room?.name && (await isMainRoomSessionEmpty(event.room.name))) {
      // Before the room's state is torn down: if a recording is still running because the
      // host left without stopping it, finish it here so the call still produces a video.
      if (roomService) {
        try {
          const recordingId = await getActiveRecordingId(event.room.name);
          if (recordingId) {
            await finishRecording(roomService, event.room.name, recordingId);
          }
        } catch (e: any) {
          console.error(`[Connect] Failed to finish recording for ${event.room.name}:`, e?.message);
        }
      }
      await cleanupStaleRoomData(event.room.name);
    }

    return res.status(200).end();
  } catch (error: any) {
    // Invalid signature / malformed payload — reject, but don't leak details.
    console.warn('[Connect] Webhook verification failed:', error.message);
    return res.status(401).end();
  }
});

// ==========================================
// 🖼️ バーチャル背景（SmiRing Connect）
// ==========================================
// 各ユーザーが自分でアップロードした背景画像を R2 に保存し、次回以降も選べるようにする。
// プリセット背景は frontend/public/backgrounds/ に同梱されており、ここは通らない。

/** 背景は 1 枚に圧縮済みで届く想定。念のためのサーバー側上限。 */
const backgroundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/** 1 ユーザーあたりの保存枚数の上限（R2 の容量が青天井に増えるのを防ぐ）。 */
const MAX_BACKGROUNDS_PER_USER = 20;

// GET /api/connect/backgrounds -> { backgrounds: [{ id, url, created_at }] }
router.get('/api/connect/backgrounds', authenticate, async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('connect_backgrounds')
      .select('id, storage_path, created_at')
      .eq('user_id', req.user!.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // 画像そのものは GET /api/connect/backgrounds/:id/image が返す。
    // R2 の署名付きURLを直接フロントに渡さないのは、(1) ブラウザが R2 を
    // クロスオリジンで叩くと WebGL に載せるのに R2 側の CORS 設定が要る、
    // (2) 署名付きURLは1時間で失効する、の2点を避けるため。
    res.json({
      backgrounds: (data || []).map((row) => ({ id: row.id, created_at: row.created_at })),
    });
  } catch (error: any) {
    console.error('バーチャル背景一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/connect/backgrounds  (multipart: file) -> { background: { id, url } }
router.post(
  '/api/connect/backgrounds',
  authenticate,
  backgroundUpload.single('file'),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'ファイルがありません' });
      }

      const { count, error: countError } = await supabase
        .from('connect_backgrounds')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', req.user!.id);

      if (countError) throw countError;
      if ((count ?? 0) >= MAX_BACKGROUNDS_PER_USER) {
        return res.status(409).json({
          error: `背景画像は最大 ${MAX_BACKGROUNDS_PER_USER} 枚までです。不要なものを削除してください。`,
        });
      }

      const jpegSource = await ensureJpegBuffer(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
      );

      // 1920x1080 に cover で切り出す。合成時はフロント側でも cover 補正をかけるが、
      // ここで 16:9 に揃えておくと転送量とGPUメモリが安定する。
      let processed: Buffer;
      try {
        processed = await sharp(jpegSource)
          .resize(1920, 1080, { fit: 'cover', position: 'attention' })
          .jpeg({ quality: 82, progressive: true })
          .toBuffer();
      } catch {
        return res
          .status(400)
          .json({ error: '画像として読み込めませんでした。JPEG / PNG / WebP をお試しください。' });
      }

      const storagePath = `connect/backgrounds/${req.user!.id}/${Date.now()}.jpg`;
      await r2.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: storagePath,
          Body: processed,
          ContentType: 'image/jpeg',
        }),
      );

      const { data, error } = await supabase
        .from('connect_backgrounds')
        .insert({ user_id: req.user!.id, storage_path: storagePath })
        .select('id, created_at')
        .single();

      if (error) throw error;

      res.json({ background: { id: data.id, created_at: data.created_at } });
    } catch (error: any) {
      console.error('バーチャル背景アップロードエラー:', error);
      res.status(500).json({ error: error.message });
    }
  },
);

// GET /api/connect/backgrounds/:id/image -> 画像バイト列
// バックエンドが R2 から取り出して中継する。ブラウザから見れば自分のサーバーの
// 画像なので、Cloudflare 側の CORS 設定も署名付きURLの有効期限も関係なくなる。
router.get(
  '/api/connect/backgrounds/:id/image',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      // user_id で絞ることで、IDを知っていても他人の背景は取れない
      const { data, error } = await supabase
        .from('connect_backgrounds')
        .select('storage_path')
        .eq('id', req.params.id)
        .eq('user_id', req.user!.id)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: '背景が見つかりません' });
      }

      const object = await r2.send(
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: data.storage_path }),
      );
      if (!object.Body) {
        return res.status(404).json({ error: '画像の実体が見つかりません' });
      }

      res.setHeader('Content-Type', object.ContentType || 'image/jpeg');
      if (object.ContentLength) res.setHeader('Content-Length', String(object.ContentLength));
      // 中身は差し替わらない（更新は常に新しいIDになる）ので長めにキャッシュさせる
      res.setHeader('Cache-Control', 'private, max-age=86400');

      (object.Body as NodeJS.ReadableStream).pipe(res);
    } catch (error: any) {
      console.error('バーチャル背景配信エラー:', error);
      res.status(500).json({ error: error.message });
    }
  },
);

// DELETE /api/connect/backgrounds/:id
router.delete('/api/connect/backgrounds/:id', authenticate, async (req: Request, res: Response) => {
  try {
    // user_id で絞ることで、他人の背景を消せないようにする
    const { data, error } = await supabase
      .from('connect_backgrounds')
      .select('id, storage_path')
      .eq('id', req.params.id)
      .eq('user_id', req.user!.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: '背景が見つかりません' });
    }

    await r2
      .send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: data.storage_path }))
      // R2 側が既に無くてもDBの行は消したいので、ここでは失敗を握りつぶす
      .catch((err) => console.error('R2 背景削除エラー:', err));

    const { error: deleteError } = await supabase
      .from('connect_backgrounds')
      .delete()
      .eq('id', data.id);

    if (deleteError) throw deleteError;

    res.json({ message: '背景を削除しました' });
  } catch (error: any) {
    console.error('バーチャル背景削除エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
