"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAIModel = initAIModel;
exports.getLocalEmbedding = getLocalEmbedding;
exports.getGeminiEmbedding = getGeminiEmbedding;
exports.stripHtml = stripHtml;
exports.answerToText = answerToText;
exports.generateChatResponse = generateChatResponse;
exports.analyzeSearchQuery = analyzeSearchQuery;
exports.analyzeImageWithGemini = analyzeImageWithGemini;
const genai_1 = require("@google/genai");
const transformers_1 = require("@xenova/transformers");
const groq_sdk_1 = __importDefault(require("groq-sdk"));
// 本番環境（Dockerイメージにモデルを焼き込んでいる環境）では、HuggingFaceへのアクセスを禁止
if (process.env.NODE_ENV === 'production') {
    transformers_1.env.allowRemoteModels = false;
    transformers_1.env.localModelPath = '/app/.cache';
}
const keywords_extraction_prompt_1 = require("./prompt/keywords_extraction_prompt");
const deep_search_expansion_prompt_1 = require("./prompt/deep_search_expansion_prompt");
const image_to_text_prompt_1 = require("./prompt/image_to_text_prompt");
// ローカルモデル用の変数
let localExtractor = null;
// ==========================================
// 1. サーバー起動時に呼び出す初期化関数
// ==========================================
async function initAIModel() {
    if (!localExtractor) {
        console.log('🤖 ローカルAIモデルを事前ロードしています... (数秒かかります)');
        localExtractor = await (0, transformers_1.pipeline)('feature-extraction', 'Xenova/multilingual-e5-small');
        console.log('✅ ローカルAIモデルの準備完了！');
    }
}
// ==========================================
// 2. ローカルAIでのベクトル化 (384次元)
// ==========================================
async function getLocalEmbedding(text, isQuery = true) {
    // すでに起動時にロードされているはずなので、ここではチェックのみ
    if (!localExtractor) {
        throw new Error("サーバーエラー: AIモデルがまだ準備されていません。サーバー起動時の initAIModel() の呼び出しを確認してください。");
    }
    // E5モデルの精度向上のため、クエリなら "query: ", 文書なら "passage: " を付与する
    const prefix = isQuery ? 'query: ' : 'passage: ';
    const input = prefix + text;
    // テキストをベクトル化 (poolingとnormalizeで検索精度を最適化)
    const output = await localExtractor(input, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}
// ==========================================
// Vertex AI クライアント取得ヘルパー
// ==========================================
const vertexClients = new Map();
function getVertexClient(location) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT;
    if (!projectId) {
        throw new Error("サーバーエラー: GOOGLE_CLOUD_PROJECT が見つかりません。環境変数をご確認ください。");
    }
    const cacheKey = `${projectId}:${location}`;
    if (!vertexClients.has(cacheKey)) {
        vertexClients.set(cacheKey, new genai_1.GoogleGenAI({
            vertexai: true,
            project: projectId,
            location,
        }));
    }
    return vertexClients.get(cacheKey);
}
const GEMINI_EMBEDDING_LOCATION = 'us-central1';
const GEMINI_IMAGE_LOCATION = 'global';
const GEMINI_CHAT_LOCATION = 'us-central1';
const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
const GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_CHAT_MODEL = 'gemini-2.5-flash';
// ==========================================
// 3. Geminiでのベクトル化 (768次元に圧縮！)
// ==========================================
async function getGeminiEmbedding(text, isQuery = false) {
    const client = getVertexClient(GEMINI_EMBEDDING_LOCATION);
    const result = await client.models.embedContent({
        model: GEMINI_EMBEDDING_MODEL,
        contents: text,
        config: {
            taskType: isQuery ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: 768,
        }
    });
    if (!result.embeddings || result.embeddings.length === 0) {
        throw new Error("Embedding response is empty");
    }
    const values = result.embeddings[0].values;
    if (!values) {
        throw new Error("Embedding values are missing in response");
    }
    return values;
}
// ==========================================
// HTMLタグを除去してプレーンテキストに変換
// ==========================================
function stripHtml(html) {
    if (typeof html !== 'string')
        return String(html);
    return html
        .replace(/<\/p>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/**
 * 日付・時刻を自然な日本語形式に変換する
 */
function formatDate(dateStr) {
    if (!dateStr)
        return '';
    const date = new Date(dateStr);
    if (isNaN(date.getTime()))
        return dateStr;
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const h = date.getHours();
    const min = date.getMinutes();
    // 形式: 2026年5月8日 (秒やタイムゾーンはAIには冗長なので除外)
    let result = `${y}年${m}月${d}日`;
    // T または半角スペースが含まれる、または時間が0時0分以外なら時刻も付ける
    if (dateStr.includes('T') || dateStr.includes(':') || h !== 0 || min !== 0) {
        result += ` ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }
    return result;
}
/**
 * HTMLを構造を保ったままプレーンテキストに変換する
 */
function cleanHtml(html) {
    if (typeof html !== 'string')
        return String(html);
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<li>/gi, '\n・ ') // 箇条書きを再現
        .replace(/<[^>]*>/g, '') // 残りのタグを除去
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n');
}
/**
 * 選択肢のIDから表示用ラベルを取得する
 */
function getLabelForValue(value, options) {
    if (!options || !Array.isArray(options))
        return String(value);
    const found = options.find(opt => String(opt.id) === String(value) ||
        String(opt.value) === String(value) ||
        opt.text === value ||
        opt.label === value);
    if (found) {
        return found.text || found.label || String(value);
    }
    return String(value);
}
/**
 * 配列形式の回答を、表示設定（displayStyle）に基づいて文字列に変換する
 */
function formatArrayAnswer(items, options, displayStyle) {
    if (!items || !Array.isArray(items) || items.length === 0)
        return '';
    const labels = items.map(item => getLabelForValue(item, options));
    if (displayStyle === 'number') {
        return labels.map((label, i) => `${i + 1}. ${label}`).join('、');
    }
    if (displayStyle === 'arrow') {
        return labels.join(' → ');
    }
    return labels.join('、');
}
function answerToText(questions, answers) {
    const lines = [];
    for (const q of questions) {
        const answer = answers[q.id];
        if (answer === undefined || answer === null || answer === '')
            continue;
        let answerText = '';
        // フロントエンドで整形済みの値がある場合は、それを優先して使用する（タイムゾーン考慮などのため）
        if (q.formattedValue) {
            answerText = q.formattedValue;
        }
        else {
            // オプション構造の正規化 (プロフィールとフォーム回答で構造が少し違う場合があるため)
            const optionsArray = Array.isArray(q.options) ? q.options : q.options?.options;
            const displayStyle = q.options?.displayStyle;
            const scaleConfig = q.options?.scale;
            switch (q.type) {
                case 'short_text':
                case 'text':
                    if (Array.isArray(answer)) {
                        answerText = formatArrayAnswer(answer, optionsArray, displayStyle);
                    }
                    else {
                        answerText = String(answer);
                    }
                    break;
                case 'long_text':
                    answerText = cleanHtml(String(answer));
                    break;
                case 'radio':
                case 'dropdown':
                    if (Array.isArray(answer)) {
                        answerText = formatArrayAnswer(answer, optionsArray, displayStyle);
                    }
                    else {
                        answerText = getLabelForValue(answer, optionsArray);
                    }
                    break;
                case 'checkbox':
                    answerText = Array.isArray(answer)
                        ? formatArrayAnswer(answer, optionsArray, displayStyle)
                        : getLabelForValue(answer, optionsArray);
                    break;
                case 'range':
                case 'scale': {
                    const min = scaleConfig?.min ?? 1;
                    const max = scaleConfig?.max ?? 10;
                    const minLabel = scaleConfig?.minLabel;
                    const maxLabel = scaleConfig?.maxLabel;
                    let text = `${answer} / ${max}`;
                    if (minLabel || maxLabel) {
                        text += ` (${min}: ${minLabel || ''} 〜 ${max}: ${maxLabel || ''})`;
                    }
                    answerText = text;
                    break;
                }
                case 'date':
                case 'date_time':
                    answerText = formatDate(String(answer));
                    break;
                case 'grid_radio':
                case 'grid_checkbox':
                    if (typeof answer === 'object' && !Array.isArray(answer)) {
                        answerText = Object.entries(answer)
                            .map(([rowId, colIds]) => {
                            const rowLabel = getLabelForValue(rowId, q.options?.gridRows);
                            const colLabels = Array.isArray(colIds)
                                ? colIds.map(c => getLabelForValue(c, q.options?.gridCols)).join('、')
                                : getLabelForValue(colIds, q.options?.gridCols);
                            return `${rowLabel}: ${colLabels}`;
                        })
                            .join(' | ');
                    }
                    break;
                default:
                    answerText = typeof answer === 'string' ? answer : JSON.stringify(answer);
            }
        }
        const cleanText = stripHtml(answerText);
        if (cleanText) {
            lines.push(`${q.title}: ${cleanText}`);
        }
    }
    return lines.join('\n');
}
// ==========================================
// 4. Gemini(LLM)での回答生成 (RAGの仕上げ用)
// ==========================================
async function generateChatResponse(prompt) {
    const client = getVertexClient(GEMINI_CHAT_LOCATION);
    const result = await client.models.generateContent({
        model: GEMINI_CHAT_MODEL,
        contents: prompt
    });
    return result.text || "";
}
// ==========================================
// 5. 検索クエリのJSON解析 (Groqを使用)
// ==========================================
async function analyzeSearchQuery(query, mode = 'smart') {
    // --- 🌟 スペース区切り、または単一キーワードのAIスキップ判定 ---
    const trimmedQuery = query.trim();
    const spaceKeywords = trimmedQuery.split(/[\s　]+/);
    // ひらがなが含まれているかチェック (文章性の判定)
    const hasHiragana = /[ぁ-ん]/.test(trimmedQuery);
    // 判定ルール (Deepモード時はスキップせずAIに深く考えさせる):
    if (mode !== 'deep' && (spaceKeywords.length > 1 || !hasHiragana || trimmedQuery.length <= 3)) {
        console.log(`[AI] Direct search triggered (Skip Groq):`, spaceKeywords);
        return { target: "unknown", keywords: spaceKeywords };
    }
    // ---------------------------------------------------------
    const apiKey = process.env.GROQ_API_KEY; // GroqのAPIキーを使用
    if (!apiKey) {
        console.warn("警告: GROQ_API_KEY が見つかりません。名前検索としてフォールバックします。");
        return { target: "person", keywords: [query] };
    }
    const client = new groq_sdk_1.default({ apiKey });
    let systemPrompt = keywords_extraction_prompt_1.KEYWORDS_EXTRACTION_PROMPT;
    if (mode === 'deep') {
        systemPrompt += `\n\n${deep_search_expansion_prompt_1.DEEP_SEARCH_EXPANSION_PROMPT}`;
    }
    try {
        const completion = await client.chat.completions.create({
            model: "openai/gpt-oss-20b",
            messages: [
                { role: "system", content: "You are a JSON-only output API." },
                { role: "user", content: `${systemPrompt}\n\nInput: ${query}\nOutput:` }
            ],
            response_format: { type: "json_object" }
        });
        const text = completion.choices[0]?.message?.content || "";
        const result = JSON.parse(text);
        console.log(`[AI] Analysis Result (${mode}):`, result);
        return result;
    }
    catch (e) {
        console.error("Groq Query Analysis Error:", e);
        return { target: "person", keywords: [query] };
    }
}
// ==========================================
// 6. Geminiでの画像解析
// ==========================================
async function analyzeImageWithGemini(buffer, mimetype, userContext) {
    const client = getVertexClient(GEMINI_IMAGE_LOCATION);
    const contextStr = userContext && userContext.trim() !== '' ? userContext : "None";
    const prompt = image_to_text_prompt_1.image_to_text_prompt.replace('[USER_CONTEXT_HERE]', () => contextStr);
    const result = await client.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: [
            { text: prompt },
            {
                inlineData: {
                    data: buffer.toString("base64"),
                    mimeType: mimetype
                }
            }
        ]
    });
    const text = (result.text || "").trim();
    return text.split('\n').map(line => line.trim()).filter(line => line !== '');
}
