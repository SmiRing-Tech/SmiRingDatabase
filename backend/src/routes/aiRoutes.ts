import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getLocalEmbedding, getGeminiEmbedding, generateChatResponse, analyzeSearchQuery } from '../lib/ai';
import { queueIndexWork } from '../lib/vectorIndexer';

const router = Router();

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

      // 抽出されたキーワード（重複排除）、もし空なら元のクエリを使用
      const keywords = Array.from(new Set(analysis.keywords));
      if (keywords.length === 0) keywords.push(query);

      // 並列で各キーワードのベクトル化
      const embeddings = await Promise.all(keywords.map(kw => getGeminiEmbedding(kw, true)));

      // 並列でDB検索
      const searchPromises = embeddings.map(emb => supabase.rpc('search_gemini_vectors', {
        query_embedding: emb,
        match_threshold: 0.67,
        match_count: limit || 15
      }));
      const searchResultsArray = await Promise.all(searchPromises);

      // user_idごとにスコアを集計する
      const userScores: Record<string, { total_score: number, matched_keywords: string[], matches: any[] }> = {};

      searchResultsArray.forEach((response, idx) => {
        const keyword = keywords[idx];
        if (response.error) {
          console.error(`Error searching for keyword ${keyword}:`, response.error);
          return;
        }

        const matches = response.data || [];
        console.log(`  └ Keyword [${keyword}]: ${matches.length} matches found.`);
        
        // 1つのキーワードに対して、ユーザーごとに最大のスコアを採用
        const keywordUserMax: Record<string, { similarity: number, content: string, source_type: string, metadata: any }> = {};
        matches.forEach((r: any) => {
          const userId = r.metadata?.user_id || r.source_id;
          if (!userId) return;
          const sim = r.similarity || 0;
          
          if (!keywordUserMax[userId] || sim > keywordUserMax[userId].similarity) {
            keywordUserMax[userId] = { 
              similarity: sim, 
              content: r.content || "",
              source_type: r.source_type || "",
              metadata: r.metadata || {}
            };
          }
        });

        // ユーザーの合計スコアに加算
        for (const [userId, matchData] of Object.entries(keywordUserMax)) {
          if (!userScores[userId]) {
            userScores[userId] = { total_score: 0, matched_keywords: [], matches: [] };
          }
          userScores[userId].total_score += matchData.similarity;
          if (!userScores[userId].matched_keywords.includes(keyword)) {
            userScores[userId].matched_keywords.push(keyword);
          }
          
          userScores[userId].matches.push({
            keyword: keyword,
            score: matchData.similarity,
            content: matchData.content,
            source_type: matchData.source_type,
            metadata: matchData.metadata
          });
          
          // スコアが高い場合のみ詳細をログ出し (デバッグ用)
          if (matchData.similarity > 0.75) {
            const preview = matchData.content.substring(0, 50).replace(/\n/g, " ") + "...";
            console.log(`    MATCH: user=${userId.substring(0,8)} kw=${keyword} score=${matchData.similarity.toFixed(3)} text=${preview}`);
          }
        }
      });

      // 配列に変換し、合計スコアの降順でソートして返す
      results = Object.entries(userScores)
        .map(([user_id, data]) => ({
          user_id,
          total_score: data.total_score,
          matched_keywords: data.matched_keywords,
          matches: data.matches
        }))
        .sort((a, b) => b.total_score - a.total_score)
        .slice(0, limit || 15);
      
      console.log(`[Search] Aggregation complete. Top user: ${results[0]?.user_id.substring(0,8)} (Score: ${results[0]?.total_score.toFixed(3)})`);

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
    }

    const executeTime = Date.now() - startTime;
    console.log(`[Search] ✅ 検索完了！(${executeTime}ms) ${results?.length || 0}件ヒット`);

    res.json({
      time_ms: executeTime,
      results: results
    });

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

