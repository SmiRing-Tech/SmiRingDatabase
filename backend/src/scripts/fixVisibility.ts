import 'dotenv/config';
import { supabase } from '../lib/supabase';

async function updateExistingVisibility() {
  console.log('🔄 既存の全インデックスの visibility を organization に更新中...');

  const { data, error, count } = await supabase
    .from('unified_search_index')
    .update({ visibility: 'organization' })
    .is('visibility', null); // まだ設定されていないものだけを対象にする

  if (error) {
    console.error('❌ 更新に失敗しました:', error);
    return;
  }

  console.log(`✅ 更新完了！`);
}

updateExistingVisibility();
