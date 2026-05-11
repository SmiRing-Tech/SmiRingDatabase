import { Router, Request, Response } from 'express';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { supabase } from '../lib/supabase';
import multer from 'multer';
import sharp from 'sharp';
import { analyzeImageWithGemini } from '../lib/ai';
import { queueGalleryImageIndexWork, deleteSearchIndex } from '../lib/vectorIndexer';

const router = Router();

// ==========================================
// ☁️ Cloudflare R2 クライアントの初期化
// ==========================================
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  // AWS SDK v3がデフォルトで付与するCRC32チェックサムをR2は拒否するため無効化
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME!;

// multer: ファイルをメモリに保持（ディスクに書かない）
// バックエンド側での最終防衛線として 5MB 以上のファイルは弾く（フロントエンドで事前に圧縮される前提）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit for gallery
});

// フォーム添付ファイル用の multer（Zip等も考慮して上限を高めに設定）
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit for attachments
});

// ==========================================
// 📸 写真アップロード & ギャラリー登録 API（プロキシ方式）
// ==========================================
// フロントエンドからファイルをバックエンドが受け取り、R2へ転送してDBに登録する
// CORS問題を回避するため、ブラウザがR2に直接アクセスしない設計
router.post('/api/gallery/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    // 🔐 JWT検証
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });

    // ファイルの存在チェック
    if (!req.file) {
      return res.status(400).json({ error: 'ファイルがありません' });
    }

    const { image_type, visibility, description } = req.body;
    const file = req.file;

    // ファイル名を一意にする
    const timestamp = Date.now();
    const largeKey = `gallery/large/${user.id}/${timestamp}.jpg`;
    const thumbKey = `gallery/thumbnails/${user.id}/${timestamp}.webp`;

    // Step 1: ラージ画像 (1920px) & サムネイル (400px) 生成
    const largeBuffer = await sharp(file.buffer)
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();

    const thumbBuffer = await sharp(file.buffer)
      .resize(400, 400, { fit: 'inside' })
      .webp({ quality: 80 })
      .toBuffer();

    // Step 2: R2へアップロード
    // ラージ (1920px版)
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: largeKey,
      Body: largeBuffer,
      ContentType: 'image/jpeg',
    }));

    // サムネイル
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: 'image/webp',
    }));

    // Step 3: galleryテーブルへ登録
    const { data: gallery, error: insertError } = await supabase
      .from('gallery')
      .insert({
        user_id: user.id,
        storage_path: largeKey,
        thumbnail_path: thumbKey,
        image_type: image_type || null,
        tags: [],
        visibility: visibility || 'organization',
        description: description || null,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    res.json({ message: '写真を保存しました', gallery });

    // 🤖 バックグラウンドでLLMによる画像解析を行い description_generated を埋める
    (async () => {
      try {
        // メモリと通信節約のため、リサイズ済みの largeBuffer を AI に渡す
        const aiDesc = await analyzeImageWithGemini(largeBuffer, 'image/jpeg', description);
        await supabase.from('gallery').update({ description_generated: aiDesc }).eq('id', gallery.id);

        // 🔍 ベクトル化して検索インデックスに登録
        await queueGalleryImageIndexWork(
          gallery.id,
          aiDesc,
          gallery.visibility,
          { user_id: user.id, image_type: gallery.image_type }
        );

        console.log(`[AI Worker] 画像解析完了: ${gallery.id}`);
      } catch (aiError) {
        console.error('[AI Worker Error] 画像解析失敗:', aiError);
      }
    })();

  } catch (error: any) {
    console.error('写真アップロードエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🖼️ ギャラリー一覧取得 API
// ==========================================
router.get('/api/gallery', async (req: Request, res: Response) => {
  try {
    // 🔐 JWT検証（ログイン済み = 全員組織メンバーとして扱う）
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });

    // クエリパラメータでアバターを含めるかどうかを判定（デフォルトは除外）
    const includeAvatars = req.query.includeAvatars === 'true';

    // visibility が public, registered, organization のものを取得
    let query = supabase
      .from('gallery')
      .select('*')
      .in('visibility', ['public', 'registered', 'organization']);

    if (!includeAvatars) {
      query = query.neq('image_type', 'avatar');
    }

    const { data: galleries, error: fetchError } = await query.order('created_at', { ascending: false });

    if (fetchError) throw fetchError;

    // gallery.user_id と basic_profile_info.user_id の間に FK がないため、別途プロフィールを取得してマージ
    const uniqueUserIds = [...new Set((galleries || []).map(g => g.user_id))];
    const { data: profiles } = await supabase
      .from('basic_profile_info')
      .select('id, name_kanji, name_english, avatar_id')
      .in('id', uniqueUserIds);

    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    // 各画像の表示用署名付きURL（1時間有効）を生成してフロントに返す
    const galleriesWithUrls = await Promise.all((galleries || []).map(async (g) => {
      const profile = profileMap[g.user_id] || null;
      let avatarUrl = null;

      // プロフィールのアバターURLを解決
      if (profile?.avatar_id) {
        const { data: avatar } = await supabase.from('gallery').select('storage_path').eq('id', profile.avatar_id).single();
        if (avatar) {
          const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: avatar.storage_path });
          avatarUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
        }
      }

      let viewUrl = '';
      let thumbnailUrl = '';

      try {
        // メイン画像 (Large)
        const command = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: g.storage_path,
        });
        viewUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

        // サムネイル画像
        // もし thumbnail_path がない場合は、フォールバックとしてオリジナルを表示する
        const thumbKey = g.thumbnail_path || g.storage_path;
        const thumbCommand = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: thumbKey,
        });
        thumbnailUrl = await getSignedUrl(r2, thumbCommand, { expiresIn: 3600 });

      } catch (err) {
        console.error('署名付きURL生成エラー:', err);
      }

      return {
        ...g,
        basic_profile_info: profile ? { ...profile, avatar_url: avatarUrl } : null,
        view_url: viewUrl,
        thumbnail_url: thumbnailUrl,
      };
    }));

    res.json(galleriesWithUrls);

  } catch (error: any) {
    console.error('ギャラリー一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 👤 特定ユーザーのギャラリー一覧取得 API
// ==========================================
router.get('/api/gallery/user/:userId', async (req: Request, res: Response) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });

    const targetUserId = req.params.userId;
    const isOwner = user.id === targetUserId;

    let query = supabase.from('gallery').select('*').eq('user_id', targetUserId);

    if (!isOwner) {
      // 他人の場合は公開設定のもののみ表示
      query = query.in('visibility', ['public', 'registered', 'organization']);
    }

    const { data: galleries, error: fetchError } = await query.order('created_at', { ascending: false });

    if (fetchError) throw fetchError;

    // アバター写真を先頭にするソート
    const sortedGalleries = (galleries || []).sort((a, b) => {
      if (a.image_type === 'avatar' && b.image_type !== 'avatar') return -1;
      if (a.image_type !== 'avatar' && b.image_type === 'avatar') return 1;
      return 0; // あとは created_at の降順
    });

    const galleriesWithUrls = await Promise.all(
      sortedGalleries.map(async (item) => {
        const command = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: item.storage_path,
        });
        const viewUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

        // サムネイル
        const thumbKey = item.thumbnail_path || item.storage_path;
        const thumbCommand = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: thumbKey,
        });
        const thumbnailUrl = await getSignedUrl(r2, thumbCommand, { expiresIn: 3600 });

        return { ...item, view_url: viewUrl, thumbnail_url: thumbnailUrl };
      })
    );

    res.json(galleriesWithUrls);

  } catch (error: any) {
    console.error('ユーザーギャラリー取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🔍 ギャラリー個別取得 API
// ==========================================
router.get('/api/gallery/:id', async (req: Request, res: Response) => {
  try {
    // 🔐 JWT検証
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });

    const { id } = req.params;

    const { data: gallery, error: fetchError } = await supabase
      .from('gallery')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !gallery) {
      return res.status(404).json({ error: '画像が見つかりません' });
    }

    // TODO: 取得した画像の visibility に応じて、アクセス権限を確認する

    // 表示用署名付きURL（1時間有効）を生成
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: gallery.storage_path,
    });
    const viewUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });

    res.json({ ...gallery, view_url: viewUrl });

  } catch (error: any) {
    console.error('ギャラリー個別取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ✏️ ギャラリー情報更新 API
// ==========================================
router.patch('/api/gallery/:id', async (req: Request, res: Response) => {
  try {
    // 🔐 JWT検証
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });

    const { id } = req.params;
    const { image_type, visibility, description } = req.body;

    // galleryテーブルからレコードを取得（オーナーチェック）
    const { data: gallery, error: fetchError } = await supabase
      .from('gallery')
      .select('id, user_id')
      .eq('id', id)
      .single();

    if (fetchError || !gallery) {
      return res.status(404).json({ error: '画像が見つかりません' });
    }

    // 自分がアップロードした画像のみ編集可能
    if (gallery.user_id !== user.id) {
      return res.status(403).json({ error: 'この画像を編集する権限がありません' });
    }

    // galleryテーブルのレコードを更新
    const { data: updatedGallery, error: updateError } = await supabase
      .from('gallery')
      .update({
        image_type: image_type !== undefined ? image_type : null,
        visibility: visibility !== undefined ? visibility : 'organization',
        description: description !== undefined ? description : null,
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.json({ message: '画像情報を更新しました', gallery: updatedGallery });

  } catch (error: any) {
    console.error('ギャラリー情報更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🗑️ ギャラリー削除 API
// ==========================================
router.delete('/api/gallery/:id', async (req: Request, res: Response) => {
  try {
    // 🔐 JWT検証
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });

    const { id } = req.params;

    // galleryテーブルからレコードを取得（storage_pathの確認とオーナーチェック）
    const { data: gallery, error: fetchError } = await supabase
      .from('gallery')
      .select('id, storage_path, user_id')
      .eq('id', id)
      .single();

    if (fetchError || !gallery) {
      return res.status(404).json({ error: '画像が見つかりません' });
    }

    // 自分がアップロードした画像のみ削除可能
    if (gallery.user_id !== user.id) {
      return res.status(403).json({ error: 'この画像を削除する権限がありません' });
    }

    // R2からファイルを削除
    await r2.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: gallery.storage_path,
    }));

    // galleryテーブルからレコードを削除
    const { error: deleteError } = await supabase
      .from('gallery')
      .delete()
      .eq('id', id);

    if (deleteError) throw deleteError;

    // 🔍 検索インデックスからも削除
    await deleteSearchIndex('gallery_image', id as string);

    res.json({ message: '画像を削除しました', id });

  } catch (error: any) {
    console.error('ギャラリー削除エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📎 フォーム添付ファイルアップロード API
// ==========================================
router.post('/api/forms/attachments/upload', attachmentUpload.single('file'), async (req: Request, res: Response) => {
  try {
    // 🔐 JWT検証
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });

    if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

    const { form_id } = req.body;
    if (!form_id) return res.status(400).json({ error: 'form_id が指定されていません' });

    const file = req.file;
    const timestamp = Date.now();
    const isImage = file.mimetype.startsWith('image/');

    if (isImage) {
      // 🖼️ 画像の場合はギャラリーとして処理
      const largeKey = `gallery/large/${user.id}/${timestamp}.jpg`;
      const thumbKey = `gallery/thumbnails/${user.id}/${timestamp}.webp`;

      // Step 1: ラージ画像 (1920px) & サムネイル (400px) 生成
      const largeBuffer = await sharp(file.buffer)
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();

      const thumbBuffer = await sharp(file.buffer)
        .resize(400, 400, { fit: 'inside' })
        .webp({ quality: 80 })
        .toBuffer();

      // Step 2: R2へアップロード
      // ラージ (1920px版)
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: largeKey,
        Body: largeBuffer,
        ContentType: 'image/jpeg',
      }));

      // サムネイル
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: thumbKey,
        Body: thumbBuffer,
        ContentType: 'image/webp',
      }));

      // Step 3: galleryテーブルへ登録（組織内公開）
      const { data: gallery, error: insertError } = await supabase
        .from('gallery')
        .insert({
          user_id: user.id,
          storage_path: largeKey,
          thumbnail_path: thumbKey,
          image_type: 'form_attachment',
          tags: [`form:${form_id}`],
          visibility: 'organization',
          description: `Form Attachment: ${file.originalname}`,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      res.json({
        message: '写真をギャラリーに保存しました',
        galleryId: gallery.id,
        path: largeKey,
        thumbnailPath: thumbKey,
        filename: file.originalname,
        mimetype: file.mimetype,
        size: file.size
      });

      // 🤖 バックグラウンドでLLMによる画像解析を行い description_generated を埋める
      (async () => {
        try {
          // メモリと通信節約のため、リサイズ済みの largeBuffer を AI に渡す
          const aiDesc = await analyzeImageWithGemini(largeBuffer, 'image/jpeg', `Form Attachment: ${file.originalname}`);
          await supabase.from('gallery').update({ description_generated: aiDesc }).eq('id', gallery.id);

          // 🔍 ベクトル化して検索インデックスに登録
          await queueGalleryImageIndexWork(
            gallery.id,
            aiDesc,
            gallery.visibility,
            { user_id: user.id, image_type: gallery.image_type, form_id: form_id }
          );

          console.log(`[AI Worker] フォーム画像解析完了: ${gallery.id}`);
        } catch (aiError) {
          console.error('[AI Worker Error] フォーム画像解析失敗:', aiError);
        }
      })();

    } else {
      // 📎 画像以外は通常の添付ファイルとして処理
      const safeFileName = file.originalname.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
      const storagePath = `form_attachments/${form_id}/${user.id}/${timestamp}_${safeFileName}`;

      await r2.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: storagePath,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));

      res.json({
        message: 'ファイルをアップロードしました',
        path: storagePath,
        filename: file.originalname,
        mimetype: file.mimetype,
        size: file.size
      });
    }

  } catch (error: any) {
    console.error('添付ファイルアップロードエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
