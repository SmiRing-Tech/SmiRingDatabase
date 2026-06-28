"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../lib/supabase");
const ai_1 = require("../lib/ai");
const vectorIndexer_1 = require("../lib/vectorIndexer");
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const authenticate_1 = require("../middleware/authenticate");
const profileRoutes_1 = require("./profileRoutes");
const router = (0, express_1.Router)();
// 👤 ユーザーIDのリストを受け取り、アクティブな留学段階プロフィールを結合して返す一括取得ヘルパー
async function fetchActiveProfiles(userIds) {
    if (!userIds || userIds.length === 0)
        return [];
    // 1. 基本プロフィールを一括取得
    const { data: basicProfiles } = await supabase_1.supabase
        .from('basic_profile_info')
        .select('id, name_english, name_kanji, avatar_id')
        .in('id', userIds);
    const basicList = basicProfiles || [];
    // 2. 全ユーザーのアクティブなロールマッピングを一括取得
    const { data: roleMappings } = await supabase_1.supabase
        .from('user_role_mappings')
        .select('user_id, user_role')
        .in('user_id', userIds)
        .eq('is_current_status', true);
    // 3. ユーザーIDごとにロールIDリストをグループ化
    const userRolesMap = new Map();
    (roleMappings || []).forEach(rm => {
        const list = userRolesMap.get(rm.user_id) || [];
        list.push(rm.user_role);
        userRolesMap.set(rm.user_id, list);
    });
    // 4. ユーザーごとにアクティブなロールを選択し、テーブル別にIDを振り分け
    const preUserIds = [];
    const currentUserIds = [];
    const postUserIds = [];
    userIds.forEach(uid => {
        const roles = userRolesMap.get(uid) || [];
        const active = (0, profileRoutes_1.selectActiveRole)(roles);
        if (active === profileRoutes_1.ROLE_PRE)
            preUserIds.push(uid);
        else if (active === profileRoutes_1.ROLE_CURRENT)
            currentUserIds.push(uid);
        else if (active === profileRoutes_1.ROLE_POST)
            postUserIds.push(uid);
    });
    // 5. 各段階別プロフィールテーブルに対して一括取得
    const [preRes, currentRes, postRes] = await Promise.all([
        preUserIds.length > 0
            ? supabase_1.supabase.from('pre_study_abroad_profiles').select('user_id, expected_timing, interested_countries, interested_majors').in('user_id', preUserIds)
            : Promise.resolve({ data: [] }),
        currentUserIds.length > 0
            ? supabase_1.supabase.from('current_study_abroad_profiles').select('user_id, current_school, study_abroad_country, majors').in('user_id', currentUserIds)
            : Promise.resolve({ data: [] }),
        postUserIds.length > 0
            ? supabase_1.supabase.from('post_study_abroad_profiles').select('user_id, last_overseas_university, study_abroad_country, majors').in('user_id', postUserIds)
            : Promise.resolve({ data: [] })
    ]);
    // 6. 取得したデータをユーザーIDをキーとする Map に格納し、表示プロパティ名を共通化する
    const stageDataMap = new Map();
    (preRes.data || []).forEach(p => {
        stageDataMap.set(p.user_id, {
            current_school: p.expected_timing || null,
            study_abroad_country: p.interested_countries || null,
            majors: p.interested_majors ? [p.interested_majors] : []
        });
    });
    (currentRes.data || []).forEach(p => {
        stageDataMap.set(p.user_id, {
            current_school: p.current_school,
            study_abroad_country: p.study_abroad_country,
            majors: p.majors
        });
    });
    (postRes.data || []).forEach(p => {
        stageDataMap.set(p.user_id, {
            current_school: p.last_overseas_university,
            study_abroad_country: p.study_abroad_country,
            majors: p.majors
        });
    });
    // 7. 基本プロフィール情報に、対象のアクティブな段階データを結合
    return basicList.map(bp => {
        const stageData = stageDataMap.get(bp.id) || {};
        return {
            ...bp,
            ...stageData
        };
    });
}
// Cloudflare R2 (storageRoutesと同じ設定)
const r2 = new client_s3_1.S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET_NAME = process.env.R2_BUCKET_NAME;
// ==========================================
// 🧪 AIテスト用のエンドポイント
// ==========================================
router.post('/api/test-ai', authenticate_1.authenticate, async (req, res) => {
    try {
        const { text } = req.body;
        if (!text)
            return res.status(400).json({ error: 'textが必要です' });
        console.log(`「${text}」を処理中...`);
        const localVector = await (0, ai_1.getLocalEmbedding)(text);
        const geminiVector = await (0, ai_1.getGeminiEmbedding)(text);
        const chatReply = await (0, ai_1.generateChatResponse)(`「${text}」について10文字以内で褒めてください。`);
        res.json({
            message: "AIパイプライン成功！",
            localVectorLength: localVector.length,
            geminiVectorLength: geminiVector.length,
            chatReply: chatReply,
        });
    }
    catch (error) {
        console.error('AIテストエラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 📝 フォーム回答の保存 ＆ 裏側でのAIベクトル化API
// ==========================================
router.post('/api/answers', authenticate_1.authenticate, async (req, res) => {
    try {
        const { question_id, form_id, answer_data } = req.body;
        const user_id = req.user.id;
        if (!question_id || !answer_data) {
            return res.status(400).json({ error: '必須データが足りません' });
        }
        const { data: answer, error: answerError } = await supabase_1.supabase
            .from('answers')
            .insert([{ user_id, question_id, form_id, answer_data }])
            .select()
            .single();
        if (answerError)
            throw answerError;
        res.json({ message: "回答を保存しました！裏側でAIが解析を開始します。", answer });
        // 🤖 バックグラウンドでAIベクトル化を実行
        const { data: question } = await supabase_1.supabase
            .from('questions')
            .select('title, primary_category, tags')
            .eq('id', question_id)
            .single();
        const textToEmbed = `質問: ${question?.title || '不明'}\n回答: ${JSON.stringify(answer_data)}`;
        await (0, vectorIndexer_1.queueIndexWork)({
            source_type: 'form_answer',
            source_id: answer.id,
            content: textToEmbed,
            metadata: {
                category: question?.primary_category,
                tags: question?.tags,
                user_id: user_id
            }
        });
    }
    catch (error) {
        console.error('回答保存エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 🔍 爆速ローカルAI検索 API (エンターキーを押す前の即時リスト用)
// ==========================================
router.post('/api/search/instant', authenticate_1.authenticate, async (req, res) => {
    try {
        const { query, limit, model, searchMode } = req.body;
        if (!query)
            return res.status(400).json({ error: '検索キーワードが必要です' });
        console.log(`[Search] 「${query}」の即時検索を開始... (mode: ${model || 'local'}, searchMode: ${searchMode || 'smart'})`);
        const startTime = Date.now();
        let results;
        if (model === 'groq') {
            const analysis = await (0, ai_1.analyzeSearchQuery)(query, searchMode);
            console.log(`[Search] Groq Analysis (${searchMode}):`, analysis);
            const searchTarget = analysis.target; // 'person' | 'school' | 'gallery_image' | 'unknown'
            // 抽出されたキーワードの形式を正規化する
            // Deepモードの場合は [{ original_keyword: string, expanded_keywords: string[] }] の形式
            // Smartモードの場合は string[] の形式
            let keywordGroups = [];
            let coreKeywords = [];
            if (searchMode === 'deep' && analysis.keywords && analysis.keywords.length > 0 && typeof analysis.keywords[0] === 'object') {
                keywordGroups = analysis.keywords;
                coreKeywords = keywordGroups.map((g) => g.original_keyword);
            }
            else {
                coreKeywords = Array.from(new Set(analysis.keywords));
                keywordGroups = coreKeywords.map((kw) => ({ original_keyword: kw, expanded_keywords: analysis.expanded_keywords || [] }));
            }
            if (coreKeywords.length === 0) {
                coreKeywords.push(query);
                keywordGroups.push({ original_keyword: query, expanded_keywords: [] });
            }
            const textResults = [];
            const vectorResponses = [];
            // キーワードごとの目標件数（閾値）を計算: 最低5件、または上限をキーワード数で均等割り
            const targetLimit = limit || 15;
            const keywordThreshold = Math.max(5, Math.ceil(targetLimit / Math.max(1, keywordGroups.length)));
            console.log(`[Search] キーワードごとの目標件数(閾値): ${keywordThreshold}件 (全${keywordGroups.length}キーワード)`);
            // 各キーワードグループごとに3ステップのパイプラインを並列実行
            await Promise.all(keywordGroups.map(async (group) => {
                const { original_keyword, expanded_keywords } = group;
                if (!original_keyword || typeof original_keyword !== 'string' || original_keyword.trim().length === 0)
                    return;
                let keywordResultCount = 0;
                // ステップ1: 元のキーワードでLike検索
                const res1 = await supabase_1.supabase
                    .from('unified_search_index')
                    .select('id, source_type, source_id, content, metadata, visibility')
                    .ilike('content', `%${original_keyword}%`)
                    .limit(targetLimit);
                if (res1.data && res1.data.length > 0) {
                    console.log(`[Search] キーワード「${original_keyword}」: ステップ1成功 (元ワードヒット ${res1.data.length}件)`);
                    res1.data.forEach((t) => textResults.push({ ...t, similarity: 0.99, matched_keyword: original_keyword }));
                    keywordResultCount += res1.data.length;
                }
                if (keywordResultCount >= keywordThreshold) {
                    console.log(`[Search] キーワード「${original_keyword}」: 閾値(${keywordThreshold})に達したため完了`);
                    return;
                }
                // ステップ2: 類義語でLike検索（一括OR検索）
                const validExpanded = (expanded_keywords || []).filter(kw => typeof kw === 'string' && kw.trim().length > 0);
                if (validExpanded.length > 0) {
                    const orConditions = validExpanded.map(kw => `content.ilike.%${kw}%`).join(',');
                    const res2 = await supabase_1.supabase
                        .from('unified_search_index')
                        .select('id, source_type, source_id, content, metadata, visibility')
                        .or(orConditions)
                        .limit(targetLimit);
                    if (res2.data && res2.data.length > 0) {
                        console.log(`[Search] キーワード「${original_keyword}」: ステップ2成功 (類語ヒット ${res2.data.length}件, used: ${validExpanded.length} words)`);
                        res2.data.forEach((t) => textResults.push({ ...t, similarity: 0.95, matched_keyword: original_keyword }));
                        keywordResultCount += res2.data.length;
                    }
                }
                if (keywordResultCount >= keywordThreshold) {
                    console.log(`[Search] キーワード「${original_keyword}」: ステップ2で閾値(${keywordThreshold})に達したため完了`);
                    return; // ここで完了（ベクトル検索をスキップ）
                }
                // ステップ3: 最後の手段として、元のキーワードをGeminiでベクトル化して意味検索
                console.log(`[Search] キーワード「${original_keyword}」: 件数不足(${keywordResultCount}/${keywordThreshold})のため、ステップ3(ベクトル検索)へフォールバック`);
                try {
                    console.time(`[Search] Gemini Embedding: ${original_keyword}`);
                    const emb = await (0, ai_1.getGeminiEmbedding)(original_keyword, true);
                    console.timeEnd(`[Search] Gemini Embedding: ${original_keyword}`);
                    console.time(`[Search] Supabase RPC: ${original_keyword}`);
                    const res3 = await supabase_1.supabase.rpc('search_gemini_vectors', {
                        query_embedding: emb,
                        match_threshold: 0.6, // 📸 少し緩めてヒットしやすくする
                        match_count: targetLimit
                    });
                    console.timeEnd(`[Search] Supabase RPC: ${original_keyword}`);
                    if (res3.data && res3.data.length > 0) {
                        console.log(`[Search] キーワード「${original_keyword}」: ステップ3成功 (ベクトルヒット ${res3.data.length}件)`);
                        vectorResponses.push({ data: res3.data.map((r) => ({ ...r, matched_keyword: original_keyword })) });
                    }
                }
                catch (err) {
                    console.error(`[Search] ❌ ステップ3 (ベクトル検索) エラー: ${original_keyword}`, err);
                }
            }));
            const vectorResults = vectorResponses.flatMap(vRes => (vRes.data || []));
            // 3. ベクトル検索とテキスト検索の結果をマージ
            const allMergedResults = [...vectorResults, ...textResults];
            // --- 📸 1. 画像検索結果の集計 ---
            const imageScores = {};
            allMergedResults.forEach((r) => {
                if (r.source_type !== 'gallery_image')
                    return;
                const galleryId = r.source_id;
                if (!galleryId)
                    return;
                if (!imageScores[galleryId]) {
                    imageScores[galleryId] = { total_score: 0, keyword_scores: {}, matched_keywords: [], matches: [] };
                }
                const sim = r.similarity || 0;
                const matchedKw = r.matched_keyword || query; // ベクトル検索の場合は元のクエリ等
                // キーワードごとの最高スコアを更新
                const currentMax = imageScores[galleryId].keyword_scores[matchedKw] || 0;
                if (sim > currentMax) {
                    imageScores[galleryId].keyword_scores[matchedKw] = sim;
                }
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
            // 最後にキーワードごとの最高スコアを合計して total_score とする
            Object.values(imageScores).forEach(item => {
                item.total_score = Object.values(item.keyword_scores).reduce((sum, score) => sum + score, 0);
            });
            const topGalleryIds = Object.entries(imageScores)
                .sort((a, b) => b[1].total_score - a[1].total_score)
                .slice(0, limit || 15)
                .map(([id]) => id);
            const { data: galleries } = await supabase_1.supabase
                .from('gallery')
                .select('id, storage_path, thumbnail_path, description, description_generated, user_id, image_type, visibility')
                .in('id', topGalleryIds);
            const photoUserIds = [...new Set((galleries || []).map(g => g.user_id))];
            const { data: photoProfiles } = await supabase_1.supabase
                .from('basic_profile_info')
                .select('id, name_english, name_kanji, avatar_id')
                .in('id', photoUserIds);
            const photoAvatarIds = [...new Set((photoProfiles || []).map(p => p.avatar_id).filter(Boolean))];
            const { data: photoAvatars } = photoAvatarIds.length > 0
                ? await supabase_1.supabase.from('gallery').select('id, storage_path').in('id', photoAvatarIds)
                : { data: [] };
            const photoAvatarMap = Object.fromEntries((photoAvatars || []).map(a => [a.id, a.storage_path]));
            const photos = await Promise.all((galleries || []).map(async (g) => {
                const profile = photoProfiles?.find(p => p.id === g.user_id);
                let avatarUrl = null;
                if (profile?.avatar_id && photoAvatarMap[profile.avatar_id]) {
                    try {
                        avatarUrl = await (0, s3_request_presigner_1.getSignedUrl)(r2, new client_s3_1.GetObjectCommand({ Bucket: BUCKET_NAME, Key: photoAvatarMap[profile.avatar_id] }), { expiresIn: 3600 });
                    }
                    catch (e) { }
                }
                let view_url = '', thumbnail_url = '';
                try {
                    if (g.storage_path)
                        view_url = await (0, s3_request_presigner_1.getSignedUrl)(r2, new client_s3_1.GetObjectCommand({ Bucket: BUCKET_NAME, Key: g.storage_path }), { expiresIn: 3600 });
                    const thumbKey = g.thumbnail_path || g.storage_path;
                    if (thumbKey)
                        thumbnail_url = await (0, s3_request_presigner_1.getSignedUrl)(r2, new client_s3_1.GetObjectCommand({ Bucket: BUCKET_NAME, Key: thumbKey }), { expiresIn: 3600 });
                }
                catch (e) { }
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
            const userScores = {};
            allMergedResults.forEach((r) => {
                if (r.source_type === 'gallery_image')
                    return;
                const userId = r.metadata?.user_id || r.source_id;
                if (!userId)
                    return;
                if (!userScores[userId]) {
                    userScores[userId] = { total_score: 0, keyword_scores: {}, matched_keywords: [], matches: [] };
                }
                const sim = r.similarity || 0;
                const matchedKw = r.matched_keyword || query;
                // キーワードごとの最高スコアを更新
                const currentMax = userScores[userId].keyword_scores[matchedKw] || 0;
                if (sim > currentMax) {
                    userScores[userId].keyword_scores[matchedKw] = sim;
                }
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
            // 最後にキーワードごとの最高スコアを合計して total_score とする
            Object.values(userScores).forEach(item => {
                item.total_score = Object.values(item.keyword_scores).reduce((sum, score) => sum + score, 0);
            });
            const members = Object.entries(userScores)
                .map(([user_id, data]) => ({ user_id, total_score: data.total_score, matched_keywords: data.matched_keywords, matches: data.matches }))
                .sort((a, b) => b.total_score - a.total_score)
                .slice(0, limit || 15);
            // 🌟 メンバー情報の結合
            const userIds = members.map(m => m.user_id);
            const flattenedUserProfiles = await fetchActiveProfiles(userIds);
            const userAvatarIds = [...new Set((flattenedUserProfiles || []).map(p => p.avatar_id).filter(Boolean))];
            const { data: userAvatars } = userAvatarIds.length > 0 ? await supabase_1.supabase.from('gallery').select('id, storage_path').in('id', userAvatarIds) : { data: [] };
            const userAvatarMap = Object.fromEntries((userAvatars || []).map(a => [a.id, a.storage_path]));
            const membersWithInfo = await Promise.all(members.map(async (m) => {
                const profile = flattenedUserProfiles?.find(p => p.id === m.user_id);
                let avatarUrl = null;
                if (profile?.avatar_id && userAvatarMap[profile.avatar_id]) {
                    try {
                        avatarUrl = await (0, s3_request_presigner_1.getSignedUrl)(r2, new client_s3_1.GetObjectCommand({ Bucket: BUCKET_NAME, Key: userAvatarMap[profile.avatar_id] }), { expiresIn: 3600 });
                    }
                    catch (e) { }
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
        }
        else {
            // 🎯 2. Keyword/Text fallback search (High performance)
            const searchKeywords = query.split(/[\s　]+/).filter((k) => k.length > 0);
            if (searchKeywords.length === 0)
                searchKeywords.push(query);
            // 🌟 OR検索条件の構築 (どれか一つのキーワードでも含まれていれば取得)
            const orConditions = searchKeywords.map((kw) => `content.ilike.%${kw}%`).join(',');
            const textSearchQuery = supabase_1.supabase
                .from('unified_search_index')
                .select('id, source_type, source_id, content, metadata, visibility')
                .or(orConditions)
                .limit(50); // 多めに取得して後でJS側で絞り込む
            const textRes = await textSearchQuery;
            // 🌟 取得したデータに対して、含まれるキーワード数をカウント (スコアリング)
            const lowerKeywords = searchKeywords.map((kw) => kw.toLowerCase());
            const scoredTextResults = (textRes.data || []).map((r) => {
                let matchCount = 0;
                const lowerContent = (r.content || '').toLowerCase();
                lowerKeywords.forEach((kw) => {
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
            let vectorResults = [];
            // 2. テキスト検索結果が6件未満、かつ「キーワード検索モード以外」の場合のみ、ベクトル検索を実行して補填
            if (searchMode !== 'keyword' && textResults.length < 6) {
                console.log(`[Search] テキスト検索結果が${textResults.length}件のため、ローカルベクトル検索で補填します`);
                const queryEmbedding = await (0, ai_1.getLocalEmbedding)(query, true);
                const vectorRes = await supabase_1.supabase.rpc('search_local_vectors', {
                    query_embedding: queryEmbedding,
                    match_threshold: 0.7,
                    match_count: limit || 15
                });
                vectorResults = (vectorRes.data || []).map((r) => ({ ...r, matched_keyword: query }));
            }
            else if (searchMode === 'keyword') {
                console.log(`[Search] キーワードモードのため、ベクトル検索（意味検索）の補填はスキップします`);
            }
            const allMergedResults = [...textResults, ...vectorResults];
            // --- 📸 1. 画像検索結果の集計 ---
            const imageScores = {};
            allMergedResults.forEach((r) => {
                if (r.source_type !== 'gallery_image')
                    return;
                const galleryId = r.source_id;
                if (!galleryId)
                    return;
                if (!imageScores[galleryId])
                    imageScores[galleryId] = { total_score: 0, matched_keywords: [], matches: [] };
                const sim = r.similarity || 0;
                const matchedKw = r.matched_keyword || query;
                imageScores[galleryId].total_score = Math.max(imageScores[galleryId].total_score, sim);
                if (!imageScores[galleryId].matched_keywords.includes(matchedKw))
                    imageScores[galleryId].matched_keywords.push(matchedKw);
                imageScores[galleryId].matches.push({ keyword: matchedKw, score: sim, content: r.content, source_type: r.source_type, metadata: r.metadata });
            });
            const topGalleryIds = Object.entries(imageScores).sort((a, b) => b[1].total_score - a[1].total_score).slice(0, limit || 15).map(([id]) => id);
            const { data: galleries } = await supabase_1.supabase.from('gallery').select('id, storage_path, thumbnail_path, description, description_generated, user_id, image_type, visibility').in('id', topGalleryIds);
            const photoUserIds = [...new Set((galleries || []).map(g => g.user_id))];
            const flattenedPhotoProfiles = await fetchActiveProfiles(photoUserIds);
            const photoAvatarIds = [...new Set((flattenedPhotoProfiles || []).map(p => p.avatar_id).filter(Boolean))];
            const { data: photoAvatars } = photoAvatarIds.length > 0 ? await supabase_1.supabase.from('gallery').select('id, storage_path').in('id', photoAvatarIds) : { data: [] };
            const photoAvatarMap = Object.fromEntries((photoAvatars || []).map(a => [a.id, a.storage_path]));
            const photos = await Promise.all((galleries || []).map(async (g) => {
                const profile = flattenedPhotoProfiles?.find(p => p.id === g.user_id);
                let avatarUrl = null;
                if (profile?.avatar_id && photoAvatarMap[profile.avatar_id]) {
                    try {
                        avatarUrl = await (0, s3_request_presigner_1.getSignedUrl)(r2, new client_s3_1.GetObjectCommand({ Bucket: BUCKET_NAME, Key: photoAvatarMap[profile.avatar_id] }), { expiresIn: 3600 });
                    }
                    catch (e) { }
                }
                let view_url = '', thumbnail_url = '';
                try {
                    if (g.storage_path)
                        view_url = await (0, s3_request_presigner_1.getSignedUrl)(r2, new client_s3_1.GetObjectCommand({ Bucket: BUCKET_NAME, Key: g.storage_path }), { expiresIn: 3600 });
                    const thumbKey = g.thumbnail_path || g.storage_path;
                    if (thumbKey)
                        thumbnail_url = await (0, s3_request_presigner_1.getSignedUrl)(r2, new client_s3_1.GetObjectCommand({ Bucket: BUCKET_NAME, Key: thumbKey }), { expiresIn: 3600 });
                }
                catch (e) { }
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
            const userScores = {};
            allMergedResults.forEach((r) => {
                if (r.source_type === 'gallery_image')
                    return;
                const userId = r.metadata?.user_id || r.source_id;
                if (!userId)
                    return;
                if (!userScores[userId])
                    userScores[userId] = { total_score: 0, matched_keywords: [], matches: [] };
                const sim = r.similarity || 0;
                const matchedKw = r.matched_keyword || query;
                userScores[userId].total_score = Math.max(userScores[userId].total_score, sim);
                if (!userScores[userId].matched_keywords.includes(matchedKw))
                    userScores[userId].matched_keywords.push(matchedKw);
                userScores[userId].matches.push({ keyword: matchedKw, score: sim, content: r.content, source_type: r.source_type, metadata: r.metadata });
            });
            const members = Object.entries(userScores)
                .map(([user_id, data]) => ({ user_id, total_score: data.total_score, matched_keywords: data.matched_keywords, matches: data.matches }))
                .sort((a, b) => b.total_score - a.total_score).slice(0, limit || 15);
            // 🌟 メンバー情報の結合
            const userIds = members.map(m => m.user_id);
            const flattenedUserProfiles = await fetchActiveProfiles(userIds);
            const userAvatarIds = [...new Set((flattenedUserProfiles || []).map(p => p.avatar_id).filter(Boolean))];
            const { data: userAvatars } = userAvatarIds.length > 0 ? await supabase_1.supabase.from('gallery').select('id, storage_path').in('id', userAvatarIds) : { data: [] };
            const userAvatarMap = Object.fromEntries((userAvatars || []).map(a => [a.id, a.storage_path]));
            const membersWithInfo = await Promise.all(members.map(async (m) => {
                const profile = flattenedUserProfiles?.find(p => p.id === m.user_id);
                let avatarUrl = null;
                if (profile?.avatar_id && userAvatarMap[profile.avatar_id]) {
                    try {
                        avatarUrl = await (0, s3_request_presigner_1.getSignedUrl)(r2, new client_s3_1.GetObjectCommand({ Bucket: BUCKET_NAME, Key: userAvatarMap[profile.avatar_id] }), { expiresIn: 3600 });
                    }
                    catch (e) { }
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
    }
    catch (error) {
        console.error('検索エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 🧠 フルRAGチャット API (エンターキーを押した後のAI相談用)
// ==========================================
router.post('/api/search/chat', authenticate_1.authenticate, async (req, res) => {
    try {
        const { query } = req.body;
        if (!query)
            return res.status(400).json({ error: '質問が必要です' });
        console.log(`[Chat] 「${query}」のフルRAG検索を開始...`);
        const queryVector = await (0, ai_1.getGeminiEmbedding)(query, true); // 検索用(RETRIEVAL_QUERY)
        const { data: searchResults, error } = await supabase_1.supabase.rpc('search_gemini_vectors', {
            query_embedding: queryVector,
            match_threshold: 0.2,
            match_count: 5
        });
        if (error)
            throw error;
        let contextText = "【データベースの検索結果】\n";
        if (searchResults && searchResults.length > 0) {
            searchResults.forEach((item, index) => {
                contextText += `${index + 1}. ${item.content}\n`;
            });
        }
        else {
            contextText += "関連する情報は見つかりませんでした。\n";
        }
        const finalPrompt = `
あなたは留学生向けアプリ「SmiRing」の優秀なAIアシスタントです。
以下の【データベースの検索結果】を参考にして、ユーザーの質問に親切に答えてください。
データベースに情報がある場合はそれを積極的に使い、無い場合は「現在のデータベースには情報がありませんが...」と前置きしてから一般論でアドバイスしてください。

${contextText}

ユーザーの質問: ${query}
    `;
        const aiAnswer = await (0, ai_1.generateChatResponse)(finalPrompt);
        res.json({
            answer: aiAnswer,
            sources: searchResults
        });
    }
    catch (error) {
        console.error('RAGチャットエラー:', error);
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
