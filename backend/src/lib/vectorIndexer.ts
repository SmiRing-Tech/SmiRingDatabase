import { supabase } from './supabase';
import { getLocalEmbedding, getGeminiEmbedding } from './ai';

export type SearchIndexSourceType = 'form_answer' | 'basic_profile' | 'gallery_image';

export interface IndexingParams {
  source_type: SearchIndexSourceType;
  source_id: string;
  content: string;
  metadata: Record<string, any>;
  visibility?: string;
}

/**
 * 検索インデックスへの登録・更新をバックグラウンドで実行する
 */
export async function queueIndexWork(params: IndexingParams) {
  const { source_type, source_id, content, metadata } = params;

  try {
    console.log(`[VectorIndexer] Indexing ${source_type} (ID: ${source_id})...`);

    // 1. ベクトル生成 (ローカル & Gemini)
    const [localVector, geminiVector] = await Promise.all([
      getLocalEmbedding(content, false), // 文書用
      getGeminiEmbedding(content, false), // 文書用
    ]);

    // 2. インデックス保存 (Upsert)
    let deleteQuery = supabase
      .from('unified_search_index')
      .delete()
      .eq('source_type', source_type)
      .eq('source_id', source_id);
    
    if (metadata && metadata.field_key) {
      deleteQuery = deleteQuery.eq('metadata->>field_key', metadata.field_key);
    }

    const { error: deleteError } = await deleteQuery;

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
        visibility: params.visibility || 'organization',
        metadata
      });

    if (insertError) throw insertError;

    console.log(`[VectorIndexer] ✅ Successfully indexed ${source_type} (ID: ${source_id})`);

  } catch (error) {
    console.error(`[VectorIndexer] ❌ Failed to index ${source_type}:`, error);
  }
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

/**
 * ギャラリー画像の説明文（複数行）のベクトル化とインデックス登録をバックグラウンドで実行する
 */
export async function queueGalleryImageIndexWork(
  galleryId: string,
  descriptions: string[],
  visibility: string,
  metadata: Record<string, any>
) {
  try {
    console.log(`[VectorIndexer] Indexing gallery_image (ID: ${galleryId}) with ${descriptions.length} lines...`);

    // 1. 古いインデックスの一括削除
    const { error: deleteError } = await supabase
      .from('unified_search_index')
      .delete()
      .eq('source_type', 'gallery_image')
      .eq('source_id', galleryId);

    if (deleteError) {
      console.warn(`[VectorIndexer] Warning: Delete old gallery image index failed:`, deleteError);
    }

    // 2. 各行ごとにベクトル生成とインデックス挿入
    for (let i = 0; i < descriptions.length; i++) {
      const line = descriptions[i];
      if (!line.trim()) continue;

      const [localVector, geminiVector] = await Promise.all([
        getLocalEmbedding(line, false),
        getGeminiEmbedding(line, false),
      ]);

      const lineMetadata = { ...metadata, line_index: i };

      const { error: insertError } = await supabase
        .from('unified_search_index')
        .insert({
          source_type: 'gallery_image',
          source_id: galleryId,
          content: line,
          embedding_local: localVector,
          embedding_gemini: geminiVector,
          visibility: visibility || 'organization',
          metadata: lineMetadata
        });

      if (insertError) {
        console.error(`[VectorIndexer] Failed to insert index for line ${i}:`, insertError);
      }
    }

    console.log(`[VectorIndexer] ✅ Successfully indexed gallery_image (ID: ${galleryId})`);

  } catch (error) {
    console.error(`[VectorIndexer] ❌ Failed to index gallery_image (ID: ${galleryId}):`, error);
  }
}
