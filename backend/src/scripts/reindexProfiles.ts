import 'dotenv/config';
import { supabase } from '../lib/supabase';
import { PROFILE_FIELDS } from '../lib/profileSchema';
import { answerToText, getLocalEmbedding, getGeminiEmbedding, initAIModel } from '../lib/ai';

/**
 * すべてのユーザープロフィールを最新のAI言語化ロジックで再インデックスします。
 */
async function reindexAll() {
  console.log('🚀 全プロフィールの再インデックスを開始します...');
  
  // 1. AIモデルの初期化 (ローカルモデルのロード)
  try {
    await initAIModel();
  } catch (err) {
    console.error('❌ AIモデルの初期化に失敗しました:', err);
    return;
  }

  // 2. 全ユーザーのプロフィール情報を取得
  const { data: users, error } = await supabase
    .from('basic_profile_info')
    .select('*');

  if (error) {
    console.error('❌ ユーザー情報の取得に失敗しました:', error);
    return;
  }

  if (!users || users.length === 0) {
    console.log('ℹ️  対象となるユーザーが見つかりませんでした。');
    return;
  }

  console.log(`📊 対象ユーザー数: ${users.length}人`);

  // 0. 古い形式（メタデータに field_key がないもの）を一括掃除
  await supabase
    .from('unified_search_index')
    .delete()
    .eq('source_type', 'basic_profile')
    .is('metadata->>field_key', null);

  // 3. フィールド定義を配列形式に変換
  const fieldList = Object.entries(PROFILE_FIELDS).map(([id, def]: [string, any]) => ({
    id,
    ...def
  }));

  let successCount = 0;
  let skipCount = 0;

  // 待機用ヘルパー
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  for (const user of users) {
    try {
      console.log(`[${successCount + skipCount + 1}/${users.length}] Processing: ${user.name_english || user.id}`);

      // 4. 項目ごとに個別にベクトル化して保存
      for (const field of fieldList) {
        const value = user[field.id];
        if (value === undefined || value === null || value === '') continue;

        const sourceId = user.id;

        // すでにインデックスが存在するか確認 (レジューム機能)
        const { data: existing } = await supabase
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

        const text = answerToText([field], user);
        if (!text || text.trim().length < 2) continue;

        // レート制限回避のためのリトライループ
        let retryCount = 0;
        let vectors = null;

        while (!vectors && retryCount < 3) {
          try {
            // 少し待機 (1分間100リクエスト制限に配慮)
            await sleep(650); 
            
            vectors = await Promise.all([
              getLocalEmbedding(text, false),
              getGeminiEmbedding(text, false)
            ]);
          } catch (err: any) {
            if (err.status === 429 || err.message?.includes('429')) {
              console.warn(`  ⏳ Rate limit hit. Waiting 30s... (Retry ${retryCount + 1})`);
              await sleep(30000); // 429が出たら30秒待つ
              retryCount++;
            } else {
              throw err;
            }
          }
        }

        if (!vectors) {
          console.error(`  ❌ Failed to get embeddings for ${field.id} after retries.`);
          continue;
        }

        const [localVector, geminiVector] = vectors;

        await supabase
          .from('unified_search_index')
          .delete()
          .eq('source_type', 'basic_profile')
          .eq('source_id', sourceId)
          .eq('metadata->>field_key', field.id);

        const { error: insertError } = await supabase
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
    } catch (err) {
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
