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
    const { query, limit, model } = req.body;
    if (!query) return res.status(400).json({ error: '検索キーワードが必要です' });

    console.log(`[Search] 「${query}」の即時検索を開始... (model: ${model || 'local'})`);
    const startTime = Date.now();

    let results;

    if (model === 'groq') {
      const analysis = await analyzeSearchQuery(query);
      console.log(`[Search] Groq Extraction:`, analysis);

      const searchTarget = analysis.target; // 'person' | 'school' | 'gallery_image' | 'unknown'

      // 抽出されたキーワード（重複排除）、もし空なら元のクエリを使用
      const keywords = Array.from(new Set(analysis.keywords));
      if (keywords.length === 0) keywords.push(query);

      // 並列で各キーワードのベクトル化
      const embeddings = await Promise.all(keywords.map(kw => getGeminiEmbedding(kw, true)));

      // 並列でDB検索
      const searchPromises = embeddings.map(emb => supabase.rpc('search_gemini_vectors', {
        query_embedding: emb,
        match_threshold: 0.6, // 📸 少し緩めてヒットしやすくする
        match_count: limit || 15
      }));
      const searchResultsArray = await Promise.all(searchPromises);

        // --- 📸 1. 画像検索結果の集計 ---
        const imageScores: Record<string, { total_score: number, matched_keywords: string[], top_content: string }> = {};
        searchResultsArray.forEach((response, idx) => {
          const keyword = keywords[idx];
          if (response.error) return;
          const matches = (response.data || []).filter((r: any) => r.source_type === 'gallery_image');
          const keywordImageMax: Record<string, { similarity: number, content: string }> = {};
          matches.forEach((r: any) => {
            const galleryId = r.source_id;
            if (!galleryId) return;
            const sim = r.similarity || 0;
            if (!keywordImageMax[galleryId] || sim > keywordImageMax[galleryId].similarity) {
              keywordImageMax[galleryId] = { similarity: sim, content: r.content || '' };
            }
          });
          for (const [galleryId, matchData] of Object.entries(keywordImageMax)) {
            if (!imageScores[galleryId]) {
              imageScores[galleryId] = { total_score: 0, matched_keywords: [], top_content: matchData.content };
            }
            imageScores[galleryId].total_score += matchData.similarity;
            if (!imageScores[galleryId].matched_keywords.includes(keyword)) {
              imageScores[galleryId].matched_keywords.push(keyword);
            }
          }
        });

        const topGalleryIds = Object.entries(imageScores)
          .sort((a, b) => b[1].total_score - a[1].total_score)
          .slice(0, limit || 15)
          .map(([id]) => id);

        const { data: galleries } = await supabase
          .from('gallery')
          .select('id, storage_path, thumbnail_path, description, user_id, image_type, visibility')
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
            user_id: g.user_id, image_type: g.image_type, visibility: g.visibility,
            basic_profile_info: profile ? { id: profile.id, name_english: profile.name_english, name_kanji: profile.name_kanji, avatar_url: avatarUrl } : null,
            total_score: score?.total_score || 0, matched_keywords: score?.matched_keywords || [],
          };
        }));
        photos.sort((a, b) => b.total_score - a.total_score);

        // --- 👤 2. 人・学校検索結果の集計 ---
        const userScores: Record<string, { total_score: number, matched_keywords: string[], matches: any[] }> = {};
        searchResultsArray.forEach((response, idx) => {
          const keyword = keywords[idx];
          if (response.error) return;
          const matches = response.data || [];
          const keywordUserMax: Record<string, { similarity: number, content: string, source_type: string, metadata: any }> = {};
          matches.forEach((r: any) => {
            const userId = r.metadata?.user_id || r.source_id;
            if (!userId) return;
            const sim = r.similarity || 0;
            if (!keywordUserMax[userId] || sim > keywordUserMax[userId].similarity) {
              keywordUserMax[userId] = { similarity: sim, content: r.content || "", source_type: r.source_type || "", metadata: r.metadata || {} };
            }
          });
          for (const [userId, matchData] of Object.entries(keywordUserMax)) {
            if (!userScores[userId]) userScores[userId] = { total_score: 0, matched_keywords: [], matches: [] };
            userScores[userId].total_score += matchData.similarity;
            if (!userScores[userId].matched_keywords.includes(keyword)) userScores[userId].matched_keywords.push(keyword);
            userScores[userId].matches.push({ keyword, score: matchData.similarity, content: matchData.content, source_type: matchData.source_type, metadata: matchData.metadata });
          }
        });

        const members = Object.entries(userScores)
          .map(([user_id, data]) => ({ user_id, total_score: data.total_score, matched_keywords: data.matched_keywords, matches: data.matches }))
          .sort((a, b) => b.total_score - a.total_score)
          .slice(0, limit || 15);

        const executeTime = Date.now() - startTime;
        console.log(`[Search] ✅ ハイブリッド検索完了！(${executeTime}ms) Photos: ${photos.length}, Members: ${members.length}`);

        return res.json({
          time_ms: executeTime,
          target: searchTarget,
          results: {
            photos,
            members
          }
        });

      } else {
      // 🎯 2. Keyword/Vector fallback search (High performance)
      const queryVector = await getLocalEmbedding(query, true); // 検索用(query:)
      const { data, error } = await supabase.rpc('search_local_vectors', {
        query_embedding: queryVector,
        match_threshold: 0.8, // ME5のしきい値
        match_count: limit || 10
      });
      if (error) throw error;
      
      // フロントエンドのアコーディオン用に形式を整える
      results = (data || []).map((r: any) => ({
        ...r,
        user_id: r.metadata?.user_id || r.source_id,
        matches: [{
          keyword: query,
          score: r.similarity || 0,
          content: r.content || "",
          source_type: r.source_type,
          metadata: r.metadata
        }]
      }));

      const executeTime = Date.now() - startTime;
      console.log(`[Search] ✅ 検索完了！(${executeTime}ms) ${results?.length || 0}件ヒット`);

      res.json({
        time_ms: executeTime,
        results: results
      });
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

