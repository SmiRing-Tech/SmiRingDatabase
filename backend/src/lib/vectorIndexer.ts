import { supabase } from './supabase';
import { getLocalEmbedding, getGeminiEmbedding } from './ai';

export type SearchIndexSourceType = 'form_answer' | 'basic_profile';

export interface IndexingParams {
  source_type: SearchIndexSourceType;
  source_id: string;
  content: string;
  metadata: Record<string, any>;
}

/**
 * 検索インデックスへの登録・更新をバックグラウンドで実行する
 */
export async function queueIndexWork(params: IndexingParams) {
  const { source_type, source_id, content, metadata } = params;

  // 🤖 非同期で実行 (呼び出し元を待たせない)
  (async () => {
    try {
      console.log(`[VectorIndexer] Indexing ${source_type} (ID: ${source_id})...`);

      // 1. ベクトル生成 (ローカル & Gemini)
      const [localVector, geminiVector] = await Promise.all([
        getLocalEmbedding(content, false), // 文書用
        getGeminiEmbedding(content, false), // 文書用
      ]);

      // 2. インデックス保存 (Upsert)
      // source_type と source_id の組み合わせで一意になるように管理する
      // ※ DBに一意制約がない場合は、まず削除してから挿入する
      
      // まず既存の同じソースのデータを削除
      const { error: deleteError } = await supabase
        .from('unified_search_index')
        .delete()
        .eq('source_type', source_type)
        .eq('source_id', source_id);

      if (deleteError) {
        console.warn(`[VectorIndexer] Warning: Delete old index failed:`, deleteError);
      }

      // 新規挿入
      const { error: insertError } = await supabase
        .from('unified_search_index')
        .insert({
          source_type,
          source_id,
          content,
          embedding_local: localVector,
          embedding_gemini: geminiVector,
          metadata
        });

      if (insertError) throw insertError;

      console.log(`[VectorIndexer] ✅ Successfully indexed ${source_type} (ID: ${source_id})`);

    } catch (error) {
      console.error(`[VectorIndexer] ❌ Failed to index ${source_type}:`, error);
    }
  })();
}

/**
 * 特定の条件に合致するインデックスを削除する
 */
export async function deleteSearchIndex(source_type: SearchIndexSourceType, source_id: string) {
  const { error } = await supabase
    .from('unified_search_index')
    .delete()
    .eq('source_type', source_type)
    .eq('source_id', source_id);
  
  if (error) {
    console.error(`[VectorIndexer] Failed to delete index:`, error);
  }
}

/**
 * 複雑な条件（メタデータ内など）でインデックスを一括削除する
 */
export async function deleteSearchIndexByMetadata(source_type: SearchIndexSourceType, metadataFilters: Record<string, string>) {
  let query = supabase
    .from('unified_search_index')
    .delete()
    .eq('source_type', source_type);
  
  for (const [key, value] of Object.entries(metadataFilters)) {
    query = query.eq(`metadata->>${key}`, value);
  }

  const { error } = await query;
  if (error) {
    console.error(`[VectorIndexer] Failed to delete batch index:`, error);
  }
}
