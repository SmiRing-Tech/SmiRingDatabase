import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getLocalEmbedding, getGeminiEmbedding, generateChatResponse } from '../lib/ai';
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
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: '検索キーワードが必要です' });

    console.log(`[Search] 「${query}」の即時検索を開始...`);
    const startTime = Date.now();

    const queryVector = await getLocalEmbedding(query, true); // 検索用(query:)

    const { data: results, error } = await supabase.rpc('search_local_vectors', {
      query_embedding: queryVector,
      match_threshold: 0.8,
      match_count: 10
    });

    if (error) throw error;

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
