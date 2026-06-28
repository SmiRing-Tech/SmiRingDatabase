"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const supabase_1 = require("../lib/supabase");
const profileSchema_1 = require("../lib/profileSchema");
const ai_1 = require("../lib/ai");
const profileRoutes_1 = require("../routes/profileRoutes");
/**
 * すべてのユーザープロフィールを最新のAI言語化ロジックで再インデックスします。
 */
async function reindexAll() {
    console.log('🚀 全プロフィールの再インデックスを開始します...');
    // 1. AIモデルの初期化 (ローカルモデルのロード)
    try {
        await (0, ai_1.initAIModel)();
    }
    catch (err) {
        console.error('❌ AIモデルの初期化に失敗しました:', err);
        return;
    }
    const { data: basicProfiles, error } = await supabase_1.supabase
        .from('basic_profile_info')
        .select('*');
    if (error) {
        console.error('❌ ユーザー情報の取得に失敗しました:', error);
        return;
    }
    const userIds = (basicProfiles || []).map(u => u.id);
    // 1. 全ユーザーのアクティブなロールマッピングを一括取得
    const { data: roleMappings } = await supabase_1.supabase
        .from('user_role_mappings')
        .select('user_id, user_role')
        .in('user_id', userIds)
        .eq('is_current_status', true);
    // 2. ユーザーIDごとにロールIDリストをグループ化
    const userRolesMap = new Map();
    (roleMappings || []).forEach(rm => {
        const list = userRolesMap.get(rm.user_id) || [];
        list.push(rm.user_role);
        userRolesMap.set(rm.user_id, list);
    });
    // 3. ユーザーごとにアクティブなロールを選択し、テーブル別にIDを振り分け
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
    // 4. 各段階別プロフィールテーブルに対して、対象ユーザーIDのみで一括取得
    const [preRes, currentRes, postRes] = await Promise.all([
        preUserIds.length > 0
            ? supabase_1.supabase.from('pre_study_abroad_profiles').select('*').in('user_id', preUserIds)
            : Promise.resolve({ data: [] }),
        currentUserIds.length > 0
            ? supabase_1.supabase.from('current_study_abroad_profiles').select('*').in('user_id', currentUserIds)
            : Promise.resolve({ data: [] }),
        postUserIds.length > 0
            ? supabase_1.supabase.from('post_study_abroad_profiles').select('*').in('user_id', postUserIds)
            : Promise.resolve({ data: [] })
    ]);
    // 5. 取得したデータをユーザーIDをキーとする Map に格納
    const stageDataMap = new Map();
    (preRes.data || []).forEach(p => stageDataMap.set(p.user_id, p));
    (currentRes.data || []).forEach(p => stageDataMap.set(p.user_id, p));
    (postRes.data || []).forEach(p => stageDataMap.set(p.user_id, p));
    // 6. 基本プロフィール情報に、対象のアクティブな段階データを結合
    const users = (basicProfiles || []).map(p => {
        const stageData = stageDataMap.get(p.id) || {};
        return {
            ...p,
            ...stageData,
            id: p.id // Keep user's ID
        };
    });
    if (!users || users.length === 0) {
        console.log('ℹ️  対象となるユーザーが見つかりませんでした。');
        return;
    }
    console.log(`📊 対象ユーザー数: ${users.length}人`);
    // 0. 古い形式（メタデータに field_key がないもの）を一括掃除
    await supabase_1.supabase
        .from('unified_search_index')
        .delete()
        .eq('source_type', 'basic_profile')
        .is('metadata->>field_key', null);
    // 3. フィールド定義を配列形式に変換
    const fieldList = Object.entries(profileSchema_1.PROFILE_FIELDS).map(([id, def]) => ({
        id,
        ...def
    }));
    let successCount = 0;
    let skipCount = 0;
    // 待機用ヘルパー
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    for (const user of users) {
        try {
            console.log(`[${successCount + skipCount + 1}/${users.length}] Processing: ${user.name_english || user.id}`);
            // 4. 項目ごとに個別にベクトル化して保存
            for (const field of fieldList) {
                const value = user[field.id];
                if (value === undefined || value === null || value === '')
                    continue;
                const sourceId = user.id;
                // すでにインデックスが存在するか確認 (レジューム機能)
                const { data: existing } = await supabase_1.supabase
                    .from('unified_search_index')
                    .select('id')
                    .eq('source_type', 'basic_profile')
                    .eq('source_id', sourceId)
                    .eq('metadata->>field_key', field.id)
                    .limit(1);
                if (existing && existing.length > 0) {
                    console.log(`  ⏩ Skipping field: ${field.id} (already indexed)`);
                    continue;
                }
                const text = (0, ai_1.answerToText)([field], user);
                if (!text || text.trim().length < 2)
                    continue;
                // レート制限回避のためのリトライループ
                let retryCount = 0;
                let vectors = null;
                while (!vectors && retryCount < 3) {
                    try {
                        // 少し待機 (1分間100リクエスト制限に配慮)
                        await sleep(650);
                        vectors = await Promise.all([
                            (0, ai_1.getLocalEmbedding)(text, false),
                            (0, ai_1.getGeminiEmbedding)(text, false)
                        ]);
                    }
                    catch (err) {
                        if (err.status === 429 || err.message?.includes('429')) {
                            console.warn(`  ⏳ Rate limit hit. Waiting 30s... (Retry ${retryCount + 1})`);
                            await sleep(30000); // 429が出たら30秒待つ
                            retryCount++;
                        }
                        else {
                            throw err;
                        }
                    }
                }
                if (!vectors) {
                    console.error(`  ❌ Failed to get embeddings for ${field.id} after retries.`);
                    continue;
                }
                const [localVector, geminiVector] = vectors;
                await supabase_1.supabase
                    .from('unified_search_index')
                    .delete()
                    .eq('source_type', 'basic_profile')
                    .eq('source_id', sourceId)
                    .eq('metadata->>field_key', field.id);
                const { error: insertError } = await supabase_1.supabase
                    .from('unified_search_index')
                    .insert({
                    source_type: 'basic_profile',
                    source_id: sourceId,
                    content: text,
                    embedding_local: localVector,
                    embedding_gemini: geminiVector,
                    visibility: 'organization',
                    metadata: {
                        type: 'profile',
                        user_id: user.id,
                        field_key: field.id,
                        name_english: user.name_english
                    }
                });
                if (insertError) {
                    console.error(`  ❌ Failed to index field ${field.id}:`, insertError);
                }
            }
            successCount++;
        }
        catch (err) {
            console.error(`❌ エラー (User: ${user.id}):`, err);
        }
    }
    console.log(`\n✨ 完了しました！`);
    console.log(`   成功: ${successCount}人`);
    console.log(`   スキップ: ${skipCount}人`);
    console.log(`   合計: ${users.length}人`);
    process.exit(0);
}
reindexAll().catch(err => {
    console.error('💥 致命的なエラーが発生しました:', err);
    process.exit(1);
});
