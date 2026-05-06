import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import { pipeline } from '@xenova/transformers';

// ローカルモデル用の変数（サーバー起動時は空にしておく）
let localExtractor: any = null;

// ==========================================
// 2. ローカルAIでのベクトル化 (384次元)
// ==========================================
export async function getLocalEmbedding(text: string): Promise<number[]> {
  // 初回呼び出し時だけ、モデル(約100MB)をメモリにダウンロードして読み込む（Lazy Loading）
  if (!localExtractor) {
    console.log('ローカルAIモデルを初期化中... (初回は数秒かかります)');
    localExtractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
    console.log('ローカルAIモデルの準備完了！');
  }

  // テキストをベクトル化 (poolingとnormalizeで検索精度を最適化)
  const output = await localExtractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ==========================================
// 3. Geminiでのベクトル化 (768次元に圧縮！)
// ==========================================
export async function getGeminiEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("サーバーエラー: GEMINI_API_KEY が見つかりません");
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
  
  const result = await model.embedContent({
    content: { role: "user", parts: [{ text }] }, 
    taskType: TaskType.RETRIEVAL_DOCUMENT,
    outputDimensionality: 768,
  } as any );
  
  return result.embedding.values;
}

// ==========================================
// 4. Gemini(LLM)での回答生成 (RAGの仕上げ用)
// ==========================================
export async function generateChatResponse(prompt: string): Promise<string> {
  // 爆速・低コストの Flash モデルを使用
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("サーバーエラー: GEMINI_API_KEY が見つかりません");
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}