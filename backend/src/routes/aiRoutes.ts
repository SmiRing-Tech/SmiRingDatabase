import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getLocalEmbedding, getGeminiEmbedding, generateChatResponse, analyzeSearchQuery } from '../lib/ai';
import { queueIndexWork } from '../lib/vectorIndexer';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const router = Router();

// Cloudflare R2 (storageRoutesと同じ設定)
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET_NAME = process.env.R2_BUCKET_NAME!;

// ==========================================
// 🧪 AIテスト用のエンドポイント
// ==========================================
router.post('/api/test-ai', async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'textが必要です' });

    console.log(`「${text}」を処理中...`);

    const localVector = await getLocalEmbedding(text);
    const geminiVector = await getGeminiEmbedding(text);
    const chatReply = await generateChatResponse(`「${text}」について10文字以内で褒めてください。`);

    res.json({
      message: "AIパイプライン成功！",
      localVectorLength: localVector.length,
      geminiVectorLength: geminiVector.length,
      chatReply: chatReply,
    });

  } catch (error: any) {
    console.error('AIテストエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 📝 フォーム回答の保存 ＆ 裏側でのAIベクトル化API
// ==========================================
router.post('/api/answers', async (req: Request, res: Response) => {
  try {
    // 🔐 JWT検証
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: '認証トークンがありません' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: '認証に失敗しました' });

    const { question_id, form_id, answer_data } = req.body;
    const user_id = user.id;

    if (!question_id || !answer_data) {
      return res.status(400).json({ error: '必須データが足りません' });
    }

    const { data: answer, error: answerError } = await supabase
      .from('answers')
      .insert([{ user_id, question_id, form_id, answer_data }])
      .select()
      .single();

    if (answerError) throw answerError;

    res.json({ message: "回答を保存しました！裏側でAIが解析を開始します。", answer });

    // 🤖 バックグラウンドでAIベクトル化を実行
    const { data: question } = await supabase
      .from('questions')
      .select('title, primary_category, tags')
      .eq('id', question_id)
      .single();

    const textToEmbed = `質問: ${question?.title || '不明'}\n回答: ${JSON.stringify(answer_data)}`;

    await queueIndexWork({
      source_type: 'form_answer',
      source_id: answer.id,
      content: textToEmbed,
      metadata: {
        category: question?.primary_category,
        tags: question?.tags,
        user_id: user_id
      }
    });

  } catch (error: any) {
    console.error('回答保存エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🔍 爆速ローカルAI検索 API (エンターキーを押す前の即時リスト用)
// ==========================================
router.post('/api/search/instant', async (req: Request, res: Response) => {
  try {
    const { query, limit, model, searchMode } = req.body;
    if (!query) return res.status(400).json({ error: '検索キーワードが必要です' });

    console.log(`[Search] 「${query}」の即時検索を開始... (mode: ${model || 'local'}, searchMode: ${searchMode || 'smart'})`);
    const startTime = Date.now();

    let results;

    if (model === 'groq') {
      const analysis = await analyzeSearchQuery(query, searchMode);
      console.log(`[Search] Groq Analysis (${searchMode}):`, analysis);

      const searchTarget = analysis.target; // 'person' | 'school' | 'gallery_image' | 'unknown'

      // 抽出されたキーワードの形式を正規化する
      // Deepモードの場合は [{ original_keyword: string, expanded_keywords: string[] }] の形式
      // Smartモードの場合は string[] の形式
      let keywordGroups: { original_keyword: string, expanded_keywords: string[] }[] = [];
      let coreKeywords: string[] = [];

      if (searchMode === 'deep' && analysis.keywords && analysis.keywords.length > 0 && typeof analysis.keywords[0] === 'object') {
        keywordGroups = analysis.keywords;
        coreKeywords = keywordGroups.map((g: any) => g.original_keyword);
      } else {
        coreKeywords = Array.from(new Set(analysis.keywords as string[]));
        keywordGroups = coreKeywords.map((kw: string) => ({ original_keyword: kw, expanded_keywords: analysis.expanded_keywords || [] }));
      }
      
      if (coreKeywords.length === 0) {
        coreKeywords.push(query);
        keywordGroups.push({ original_keyword: query, expanded_keywords: [] });
      }

      const textResults: any[] = [];
      const vectorResponses: any[] = [];

      // 各キーワードグループごとに3ステップのパイプラインを並列実行
      await Promise.all(keywordGroups.map(async (group) => {
        const { original_keyword, expanded_keywords } = group;

        if (!original_keyword || typeof original_keyword !== 'string' || original_keyword.trim().length === 0) return;

        // ステップ1: 元のキーワードでLike検索
        const res1 = await supabase
          .from('unified_search_index')
          .select('id, source_type, source_id, content, metadata, visibility')
          .ilike('content', `%${original_keyword}%`)
          .limit(limit || 15);

        if (res1.data && res1.data.length > 0) {
          console.log(`[Search] ステップ1成功 (元ワードヒット): ${original_keyword}`);
          res1.data.forEach((t: any) => textResults.push({ ...t, similarity: 0.99, matched_keyword: original_keyword }));
          return; // ここで完了（類義語とベクトル検索をスキップ）
        }

        // ステップ2: 類義語でLike検索（一括OR検索）
        const validExpanded = (expanded_keywords || []).filter(kw => typeof kw === 'string' && kw.trim().length > 0);
        if (validExpanded.length > 0) {
          const orConditions = validExpanded.map(kw => `content.ilike.%${kw}%`).join(',');
          const res2 = await supabase
            .from('unified_search_index')
            .select('id, source_type, source_id, content, metadata, visibility')
            .or(orConditions)
            .limit(limit || 15);

          if (res2.data && res2.data.length > 0) {
            console.log(`[Search] ステップ2成功 (類語ヒット): ${original_keyword} (used: ${validExpanded.length} words)`);
            // 💡 UI表示を統一するため、matched_keywordには「元のキーワード」をセットする
            res2.data.forEach((t: any) => textResults.push({ ...t, similarity: 0.95, matched_keyword: original_keyword }));
            return; // ここで完了（ベクトル検索をスキップ）
          }
        }

        // ステップ3: 最後の手段として、元のキーワードをGeminiでベクトル化して意味検索
        console.log(`[Search] ステップ3実行 (ベクトルへフォールバック): ${original_keyword}`);
        try {
          const emb = await getGeminiEmbedding(original_keyword, true);
          const res3 = await supabase.rpc('search_gemini_vectors', {
            query_embedding: emb,
            match_threshold: 0.6, // 📸 少し緩めてヒットしやすくする
            match_count: limit || 15
          });

          if (res3.data && res3.data.length > 0) {
            vectorResponses.push({ data: res3.data.map((r: any) => ({ ...r, matched_keyword: original_keyword })) });
          }
        } catch (err) {
          console.error(`[Search] ❌ ステップ3 (ベクトル検索) エラー: ${original_keyword}`, err);
        }
      }));

      const vectorResults = vectorResponses.flatMap(vRes => (vRes.data || []));

      // 3. ベクトル検索とテキスト検索の結果をマージ
      const allMergedResults = [...vectorResults, ...textResults];

      // --- 📸 1. 画像検索結果の集計 ---
      const imageScores: Record<string, { total_score: number, matched_keywords: string[], matches: any[] }> = {};
      
      allMergedResults.forEach((r: any) => {
        if (r.source_type !== 'gallery_image') return;
        const galleryId = r.source_id;
        if (!galleryId) return;

        if (!imageScores[galleryId]) {
          imageScores[galleryId] = { total_score: 0, matched_keywords: [], matches: [] };
        }

        const sim = r.similarity || 0;
        const matchedKw = r.matched_keyword || query; // ベクトル検索の場合は元のクエリ等

        imageScores[galleryId].total_score = Math.max(imageScores[galleryId].total_score, sim);
        if (!imageScores[galleryId].matched_keywords.includes(matchedKw)) {
          imageScores[galleryId].matched_keywords.push(matchedKw);
        }
        imageScores[galleryId].matches.push({
          keyword: matchedKw,
          score: sim,
          content: r.content,
          source_type: r.source_type,
          metadata: r.metadata
        });
      });

        const topGalleryIds = Object.entries(imageScores)
          .sort((a, b) => b[1].total_score - a[1].total_score)
          .slice(0, limit || 15)
          .map(([id]) => id);

        const { data: galleries } = await supabase
          .from('gallery')
          .select('id, storage_path, thumbnail_path, description, description_generated, user_id, image_type, visibility')
          .in('id', topGalleryIds);

        const photoUserIds = [...new Set((galleries || []).map(g => g.user_id))];
        const { data: photoProfiles } = await supabase
          .from('basic_profile_info')
          .select('id, name_english, name_kanji, avatar_id')
          .in('id', photoUserIds);
        
        const photoAvatarIds = [...new Set((photoProfiles || []).map(p => p.avatar_id).filter(Boolean))];
        const { data: photoAvatars } = photoAvatarIds.length > 0 
          ? await supabase.from('gallery').select('id, storage_path').in('id', photoAvatarIds)
          : { data: [] };
        const photoAvatarMap = Object.fromEntries((photoAvatars || []).map(a => [a.id, a.storage_path]));

        const photos = await Promise.all((galleries || []).map(async (g: any) => {
          const profile = photoProfiles?.find(p => p.id === g.user_id);
          let avatarUrl = null;
          if (profile?.avatar_id && photoAvatarMap[profile.avatar_id]) {
            try {
              avatarUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: photoAvatarMap[profile.avatar_id] }), { expiresIn: 3600 });
            } catch (e) {}
          }
          let view_url = '', thumbnail_url = '';
          try {
            if (g.storage_path) view_url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: g.storage_path }), { expiresIn: 3600 });
            const thumbKey = g.thumbnail_path || g.storage_path;
            if (thumbKey) thumbnail_url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: thumbKey }), { expiresIn: 3600 });
          } catch (e) {}
          const score = imageScores[g.id];
          return {
            gallery_id: g.id, view_url, thumbnail_url, description: g.description,
            description_generated: g.description_generated,
            user_id: g.user_id, image_type: g.image_type, visibility: g.visibility,
            basic_profile_info: profile ? { id: profile.id, name_english: profile.name_english, name_kanji: profile.name_kanji, avatar_url: avatarUrl } : null,
            total_score: score?.total_score || 0, 
            matched_keywords: score?.matched_keywords || [],
            matches: score?.matches || []
          };
        }));
        photos.sort((a, b) => b.total_score - a.total_score);

        // --- 👤 2. 人・学校検索結果の集計 ---
        const userScores: Record<string, { total_score: number, matched_keywords: string[], matches: any[] }> = {};
        
        allMergedResults.forEach((r: any) => {
          if (r.source_type === 'gallery_image') return;
          const userId = r.metadata?.user_id || r.source_id;
          if (!userId) return;

          if (!userScores[userId]) {
            userScores[userId] = { total_score: 0, matched_keywords: [], matches: [] };
          }

          const sim = r.similarity || 0;
          const matchedKw = r.matched_keyword || query;

          userScores[userId].total_score = Math.max(userScores[userId].total_score, sim);
          if (!userScores[userId].matched_keywords.includes(matchedKw)) {
            userScores[userId].matched_keywords.push(matchedKw);
          }
          userScores[userId].matches.push({
            keyword: matchedKw,
            score: sim,
            content: r.content,
            source_type: r.source_type,
            metadata: r.metadata
          });
        });

        const members = Object.entries(userScores)
          .map(([user_id, data]) => ({ user_id, total_score: data.total_score, matched_keywords: data.matched_keywords, matches: data.matches }))
          .sort((a, b) => b.total_score - a.total_score)
          .slice(0, limit || 15);

        // 🌟 メンバー情報の結合
        const userIds = members.map(m => m.user_id);
        const { data: userProfiles } = await supabase.from('basic_profile_info').select('id, name_english, name_kanji, avatar_id, current_school, study_abroad_country, majors').in('id', userIds);
        const userAvatarIds = [...new Set((userProfiles || []).map(p => p.avatar_id).filter(Boolean))];
        const { data: userAvatars } = userAvatarIds.length > 0 ? await supabase.from('gallery').select('id, storage_path').in('id', userAvatarIds) : { data: [] };
        const userAvatarMap = Object.fromEntries((userAvatars || []).map(a => [a.id, a.storage_path]));

        const membersWithInfo = await Promise.all(members.map(async (m) => {
          const profile = userProfiles?.find(p => p.id === m.user_id);
          let avatarUrl = null;
          if (profile?.avatar_id && userAvatarMap[profile.avatar_id]) {
            try { avatarUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: userAvatarMap[profile.avatar_id] }), { expiresIn: 3600 }); } catch (e) {}
          }
          return {
            ...m,
            type: 'member',
            name_english: profile?.name_english,
            name_kanji: profile?.name_kanji,
            avatar_link: avatarUrl, // フロントエンドに合わせて avatar_link とする
            current_school: profile?.current_school,
            study_abroad_country: profile?.study_abroad_country,
            majors: profile?.majors
          };
        }));

        const executeTime = Date.now() - startTime;
        console.log(`[Search] ✅ ハイブリッド検索完了！(${executeTime}ms) Photos: ${photos.length}, Members: ${membersWithInfo.length}`);

        return res.json({
          time_ms: executeTime,
          target: searchTarget,
          results: {
            photos,
            members: membersWithInfo
          }
        });

      } else {
        // 🎯 2. Keyword/Text fallback search (High performance)
        const searchKeywords = query.split(/[\s　]+/).filter((k: string) => k.length > 0);
        if (searchKeywords.length === 0) searchKeywords.push(query);

        // 🌟 OR検索条件の構築 (どれか一つのキーワードでも含まれていれば取得)
        const orConditions = searchKeywords.map((kw: string) => `content.ilike.%${kw}%`).join(',');
        const textSearchQuery = supabase
          .from('unified_search_index')
          .select('id, source_type, source_id, content, metadata, visibility')
          .or(orConditions)
          .limit(50); // 多めに取得して後でJS側で絞り込む

        const textRes = await textSearchQuery;

        // 🌟 取得したデータに対して、含まれるキーワード数をカウント (スコアリング)
        const lowerKeywords = searchKeywords.map((kw: string) => kw.toLowerCase());
        const scoredTextResults = (textRes.data || []).map((r: any) => {
          let matchCount = 0;
          const lowerContent = (r.content || '').toLowerCase();
          lowerKeywords.forEach((kw: string) => {
            if (lowerContent.includes(kw)) {
              matchCount++;
            }
          });
          // similarityはヒット数に比例するように仮設定（ソート用）
          return { ...r, matchCount, similarity: 0.9 + (matchCount * 0.01), matched_keyword: query };
        });

        // 🌟 ヒットしたキーワード数が多い順（実質ANDが上、ORが下）にソート
        scoredTextResults.sort((a, b) => b.matchCount - a.matchCount);

        // 🌟 指定件数（上限）で切り詰める
        const textResults = scoredTextResults.slice(0, limit || 15);

        let vectorResults: any[] = [];
        
        // 2. テキスト検索結果が6件未満、かつ「キーワード検索モード以外」の場合のみ、ベクトル検索を実行して補填
        if (searchMode !== 'keyword' && textResults.length < 6) {
          console.log(`[Search] テキスト検索結果が${textResults.length}件のため、ローカルベクトル検索で補填します`);
          const queryEmbedding = await getLocalEmbedding(query, true);
          const vectorRes = await supabase.rpc('search_local_vectors', {
            query_embedding: queryEmbedding,
            match_threshold: 0.7,
            match_count: limit || 15
          });
          vectorResults = (vectorRes.data || []).map((r: any) => ({ ...r, matched_keyword: query }));
        } else if (searchMode === 'keyword') {
          console.log(`[Search] キーワードモードのため、ベクトル検索（意味検索）の補填はスキップします`);
        }

        const allMergedResults = [...textResults, ...vectorResults];

        // --- 📸 1. 画像検索結果の集計 ---
        const imageScores: Record<string, { total_score: number, matched_keywords: string[], matches: any[] }> = {};
        allMergedResults.forEach((r: any) => {
          if (r.source_type !== 'gallery_image') return;
          const galleryId = r.source_id;
          if (!galleryId) return;
          if (!imageScores[galleryId]) imageScores[galleryId] = { total_score: 0, matched_keywords: [], matches: [] };
          const sim = r.similarity || 0;
          const matchedKw = r.matched_keyword || query;
          imageScores[galleryId].total_score = Math.max(imageScores[galleryId].total_score, sim);
          if (!imageScores[galleryId].matched_keywords.includes(matchedKw)) imageScores[galleryId].matched_keywords.push(matchedKw);
          imageScores[galleryId].matches.push({ keyword: matchedKw, score: sim, content: r.content, source_type: r.source_type, metadata: r.metadata });
        });

        const topGalleryIds = Object.entries(imageScores).sort((a, b) => b[1].total_score - a[1].total_score).slice(0, limit || 15).map(([id]) => id);
        const { data: galleries } = await supabase.from('gallery').select('id, storage_path, thumbnail_path, description, description_generated, user_id, image_type, visibility').in('id', topGalleryIds);
        const photoUserIds = [...new Set((galleries || []).map(g => g.user_id))];
        const { data: photoProfiles } = await supabase.from('basic_profile_info').select('id, name_english, name_kanji, avatar_id, current_school, study_abroad_country, majors').in('id', photoUserIds);
        const photoAvatarIds = [...new Set((photoProfiles || []).map(p => p.avatar_id).filter(Boolean))];
        const { data: photoAvatars } = photoAvatarIds.length > 0 ? await supabase.from('gallery').select('id, storage_path').in('id', photoAvatarIds) : { data: [] };
        const photoAvatarMap = Object.fromEntries((photoAvatars || []).map(a => [a.id, a.storage_path]));

        const photos = await Promise.all((galleries || []).map(async (g: any) => {
          const profile = photoProfiles?.find(p => p.id === g.user_id);
          let avatarUrl = null;
          if (profile?.avatar_id && photoAvatarMap[profile.avatar_id]) {
            try { avatarUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: photoAvatarMap[profile.avatar_id] }), { expiresIn: 3600 }); } catch (e) {}
          }
          let view_url = '', thumbnail_url = '';
          try {
            if (g.storage_path) view_url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: g.storage_path }), { expiresIn: 3600 });
            const thumbKey = g.thumbnail_path || g.storage_path;
            if (thumbKey) thumbnail_url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: thumbKey }), { expiresIn: 3600 });
          } catch (e) {}
          const score = imageScores[g.id];
          return {
            type: 'gallery_image',
            gallery_id: g.id, view_url, thumbnail_url, description: g.description, description_generated: g.description_generated,
            user_id: g.user_id, image_type: g.image_type, visibility: g.visibility,
            basic_profile_info: profile ? { 
              id: profile.id, 
              name_english: profile.name_english, 
              name_kanji: profile.name_kanji, 
              avatar_url: avatarUrl,
              current_school: profile.current_school,
              study_abroad_country: profile.study_abroad_country,
              majors: profile.majors
            } : null,
            total_score: score?.total_score || 0, matched_keywords: score?.matched_keywords || [], matches: score?.matches || []
          };
        }));

        // --- 👤 2. 人・学校検索結果の集計 ---
        const userScores: Record<string, { total_score: number, matched_keywords: string[], matches: any[] }> = {};
        allMergedResults.forEach((r: any) => {
          if (r.source_type === 'gallery_image') return;
          const userId = r.metadata?.user_id || r.source_id;
          if (!userId) return;
          if (!userScores[userId]) userScores[userId] = { total_score: 0, matched_keywords: [], matches: [] };
          const sim = r.similarity || 0;
          const matchedKw = r.matched_keyword || query;
          userScores[userId].total_score = Math.max(userScores[userId].total_score, sim);
          if (!userScores[userId].matched_keywords.includes(matchedKw)) userScores[userId].matched_keywords.push(matchedKw);
          userScores[userId].matches.push({ keyword: matchedKw, score: sim, content: r.content, source_type: r.source_type, metadata: r.metadata });
        });

        const members = Object.entries(userScores)
          .map(([user_id, data]) => ({ user_id, total_score: data.total_score, matched_keywords: data.matched_keywords, matches: data.matches }))
          .sort((a, b) => b.total_score - a.total_score).slice(0, limit || 15);

        // 🌟 メンバー情報の結合
        const userIds = members.map(m => m.user_id);
        const { data: userProfiles } = await supabase.from('basic_profile_info').select('id, name_english, name_kanji, avatar_id, current_school, study_abroad_country, majors').in('id', userIds);
        const userAvatarIds = [...new Set((userProfiles || []).map(p => p.avatar_id).filter(Boolean))];
        const { data: userAvatars } = userAvatarIds.length > 0 ? await supabase.from('gallery').select('id, storage_path').in('id', userAvatarIds) : { data: [] };
        const userAvatarMap = Object.fromEntries((userAvatars || []).map(a => [a.id, a.storage_path]));

        const membersWithInfo = await Promise.all(members.map(async (m) => {
          const profile = userProfiles?.find(p => p.id === m.user_id);
          let avatarUrl = null;
          if (profile?.avatar_id && userAvatarMap[profile.avatar_id]) {
            try { avatarUrl = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: userAvatarMap[profile.avatar_id] }), { expiresIn: 3600 }); } catch (e) {}
          }
          return {
            ...m,
            type: 'member',
            name_english: profile?.name_english,
            name_kanji: profile?.name_kanji,
            avatar_link: avatarUrl, // フロントエンドに合わせて avatar_link とする
            current_school: profile?.current_school,
            study_abroad_country: profile?.study_abroad_country,
            majors: profile?.majors
          };
        }));

        const executeTime = Date.now() - startTime;
        res.json({ time_ms: executeTime, results: { photos, members: membersWithInfo } });
      }


  } catch (error: any) {
    console.error('検索エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 🧠 フルRAGチャット API (エンターキーを押した後のAI相談用)
// ==========================================
router.post('/api/search/chat', async (req: Request, res: Response) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: '質問が必要です' });

    console.log(`[Chat] 「${query}」のフルRAG検索を開始...`);

    const queryVector = await getGeminiEmbedding(query, true); // 検索用(RETRIEVAL_QUERY)

    const { data: searchResults, error } = await supabase.rpc('search_gemini_vectors', {
      query_embedding: queryVector,
      match_threshold: 0.2,
      match_count: 5
    });

    if (error) throw error;

    let contextText = "【データベースの検索結果】\n";
    if (searchResults && searchResults.length > 0) {
      searchResults.forEach((item: any, index: number) => {
        contextText += `${index + 1}. ${item.content}\n`;
      });
    } else {
      contextText += "関連する情報は見つかりませんでした。\n";
    }

    const finalPrompt = `
あなたは留学生向けアプリ「SmiRing」の優秀なAIアシスタントです。
以下の【データベースの検索結果】を参考にして、ユーザーの質問に親切に答えてください。
データベースに情報がある場合はそれを積極的に使い、無い場合は「現在のデータベースには情報がありませんが...」と前置きしてから一般論でアドバイスしてください。

${contextText}

ユーザーの質問: ${query}
    `;

    const aiAnswer = await generateChatResponse(finalPrompt);

    res.json({
      answer: aiAnswer,
      sources: searchResults
    });

  } catch (error: any) {
    console.error('RAGチャットエラー:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

