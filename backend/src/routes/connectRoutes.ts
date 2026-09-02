import { Router, Request, Response } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import multer from 'multer';
import sharp from 'sharp';
import { authenticate } from '../middleware/authenticate';
import { supabase } from '../lib/supabase';
import { r2, BUCKET_NAME } from '../lib/r2';
import { ensureJpegBuffer } from '../lib/imageInput';

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
