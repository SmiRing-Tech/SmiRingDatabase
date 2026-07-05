import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { resolveAvatarUrl, getSignedFileUrl } from '../lib/r2';
import { answerToText } from '../lib/ai';
import { queueIndexWork } from '../lib/vectorIndexer';
import { authenticate } from '../middleware/authenticate';

const router = Router();

// ==========================================
// 🔑 留学段階ロール定数 & 優先解決ヘルパー
// ==========================================
export const ROLE_PRE = '30b89471-46da-4501-84cd-f318b8cfeb3e';
export const ROLE_CURRENT = '1f7f6138-eecc-4925-958a-095ea80eff5c';
export const ROLE_POST = 'aad63ee1-40de-4807-a0b0-5660fa68a1f6';
export const ROLE_GUARDIAN = 'c8fcb0bc-7cf1-4bd5-90ba-7bbb45f5fbbc';

export const STAGE_TABLE_MAP: Record<string, string> = {
  [ROLE_PRE]: 'pre_study_abroad_profiles',
  [ROLE_CURRENT]: 'current_study_abroad_profiles',
  [ROLE_POST]: 'post_study_abroad_profiles',
  [ROLE_GUARDIAN]: 'guardian_profiles'
};

export const ROLE_NAMES: Record<string, string> = {
  [ROLE_PRE]: '留学前',
  [ROLE_CURRENT]: '留学中',
  [ROLE_POST]: '留学後',
  [ROLE_GUARDIAN]: '保護者'
};

export const STAGE_FIELDS_MAP: Record<string, string[]> = {
  [ROLE_PRE]: [
    'study_abroad_interest_level',
    'interested_areas',
    'interested_countries',
    'interested_majors',
    'interested_study_abroad_types',
    'expected_timing'
  ],
  [ROLE_CURRENT]: [
    'english_school',
    'study_abroad_type',
    'study_abroad_country',
    'study_abroad_city',
    'study_abroad_history',
    'current_school',
    'school_history',
    'majors',
    'minors',
    'major_history'
  ],
  [ROLE_POST]: [
    'english_school',
    'study_abroad_type',
    'study_abroad_country',
    'study_abroad_city',
    'study_abroad_history',
    'last_overseas_university',
    'school_history',
    'majors',
    'minors',
    'major_history'
  ],
  [ROLE_GUARDIAN]: [
    'child_id',
    'concerns'
  ]
};

export const ALL_STAGE_FIELDS = (() => {
  const fieldsSet = new Set<string>();
  Object.values(STAGE_FIELDS_MAP).forEach(fields => {
    fields.forEach(f => fieldsSet.add(f));
  });
  return fieldsSet;
})();

export function filterProfileByActiveRole(profile: any, activeRole: string | null): any {
  const allowedFields = new Set<string>(activeRole ? STAGE_FIELDS_MAP[activeRole] || [] : []);

  const filtered = { ...profile };
  ALL_STAGE_FIELDS.forEach(field => {
    if (!allowedFields.has(field)) {
      delete filtered[field];
    }
  });

  return filtered;
}

export function selectActiveRole(roleIds: string[]): string | null {
  if (roleIds.includes(ROLE_POST)) return ROLE_POST;
  if (roleIds.includes(ROLE_CURRENT)) return ROLE_CURRENT;
  if (roleIds.includes(ROLE_PRE)) return ROLE_PRE;
  if (roleIds.includes(ROLE_GUARDIAN)) return ROLE_GUARDIAN;
  return null;
}

// ==========================================
// 👤 プロフィール系 API
// ==========================================

// 🌟 メンバーの基本プロフィール情報（一覧用）
router.get('/api/basic_profile_info', authenticate, async (req: Request, res: Response) => {
  try {
    const roleFilter = req.query.role as string | undefined;
    let userIdsWithRole: string[] | null = null;

    if (roleFilter) {
      // 1. Get role ID from user_roles where role_name matches
      const { data: roleData, error: roleErr } = await supabase
        .from('user_roles')
        .select('id')
        .eq('role_name', roleFilter)
        .single();
      
      if (roleErr && roleErr.code !== 'PGRST116') {
        throw roleErr;
      }

      if (roleData) {
        // 2. Get user IDs with this role mapping
        const { data: mappings, error: mapErr } = await supabase
          .from('user_role_mappings')
          .select('user_id')
          .eq('user_role', roleData.id);
        
        if (mapErr) throw mapErr;
        userIdsWithRole = (mappings || []).map(m => m.user_id);
      } else {
        // If the role name is not found, check if roleFilter itself is a valid UUID
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(roleFilter)) {
          const { data: mappings, error: mapErr } = await supabase
            .from('user_role_mappings')
            .select('user_id')
            .eq('user_role', roleFilter);
          
          if (mapErr) throw mapErr;
          userIdsWithRole = (mappings || []).map(m => m.user_id);
        } else {
          // If neither, return empty array immediately
          userIdsWithRole = [];
        }
      }
    }

    let query = supabase.from('basic_profile_info').select('*');
    if (userIdsWithRole !== null) {
      if (userIdsWithRole.length === 0) {
        return res.json([]);
      }
      query = query.in('id', userIdsWithRole);
    }

    const { data: basicProfiles, error } = await query;

    if (error) throw error;

    const basicList = basicProfiles || [];
    let profiles = [...basicList];

    if (basicList.length > 0) {
      const userIds = basicList.map(p => p.id);

      // 1. 全ユーザーのアクティブなロールマッピングを一括取得
      const { data: roleMappings } = await supabase
        .from('user_role_mappings')
        .select('user_id, user_role')
        .in('user_id', userIds)
        .eq('is_current_status', true);

      // 2. ユーザーIDごとにロールIDリストをグループ化
      const userRolesMap = new Map<string, string[]>();
      (roleMappings || []).forEach(rm => {
        const list = userRolesMap.get(rm.user_id) || [];
        list.push(rm.user_role);
        userRolesMap.set(rm.user_id, list);
      });

      // 3. ユーザーごとにアクティブなロールを選択し、テーブル別にIDを振り分け
      const preUserIds: string[] = [];
      const currentUserIds: string[] = [];
      const postUserIds: string[] = [];
      const guardianUserIds: string[] = [];

      userIds.forEach(uid => {
        const roles = userRolesMap.get(uid) || [];
        const active = selectActiveRole(roles);
        if (active === ROLE_PRE) preUserIds.push(uid);
        else if (active === ROLE_CURRENT) currentUserIds.push(uid);
        else if (active === ROLE_POST) postUserIds.push(uid);
        else if (active === ROLE_GUARDIAN) guardianUserIds.push(uid);
      });

      // 4. 各段階別プロフィールテーブルに対して、対象ユーザーIDのみで一括取得
      const [preRes, currentRes, postRes, guardianRes] = await Promise.all([
        preUserIds.length > 0
          ? supabase.from('pre_study_abroad_profiles').select('*').in('user_id', preUserIds)
          : Promise.resolve({ data: [] }),
        currentUserIds.length > 0
          ? supabase.from('current_study_abroad_profiles').select('*').in('user_id', currentUserIds)
          : Promise.resolve({ data: [] }),
        postUserIds.length > 0
          ? supabase.from('post_study_abroad_profiles').select('*').in('user_id', postUserIds)
          : Promise.resolve({ data: [] }),
        guardianUserIds.length > 0
          ? supabase.from('guardian_profiles').select('*').in('user_id', guardianUserIds)
          : Promise.resolve({ data: [] })
      ]);

      // 5. 取得したデータをユーザーIDをキーとする Map に格納
      const stageDataMap = new Map<string, any>();
      (preRes.data || []).forEach(p => stageDataMap.set(p.user_id, p));
      (currentRes.data || []).forEach(p => stageDataMap.set(p.user_id, p));
      (postRes.data || []).forEach(p => stageDataMap.set(p.user_id, p));
      (guardianRes.data || []).forEach(p => stageDataMap.set(p.user_id, p));

      // 6. 基本プロフィール情報に、対象のアクティブな段階データを結合
      profiles = basicList.map(p => {
        const stageData = stageDataMap.get(p.id) || {};
        const roles = userRolesMap.get(p.id) || [];
        const active = selectActiveRole(roles);
        
        // Remove legacy stage fields from basic profile to avoid leaks
        const cleanBasic = { ...p };
        ALL_STAGE_FIELDS.forEach(field => {
          delete cleanBasic[field];
        });

        const merged = {
          ...cleanBasic,
          ...stageData,
          active_stage_role_id: active ? ROLE_NAMES[active] : null,
          id: p.id // Keep user's ID
        };
        return filterProfileByActiveRole(merged, active);
      });
    }

    // ✅ 最適化: 全 avatar_id をまとめて1回のDBクエリで取得（N回 → 1回）
    const avatarIds = profiles.map(p => p.avatar_id).filter(Boolean);
    
    let avatarPathMap: Record<string, string> = {};
    if (avatarIds.length > 0) {
      const { data: avatarItems } = await supabase
        .from('gallery')
        .select('id, thumbnail_path, storage_path')
        .in('id', avatarIds);
      
      if (avatarItems) {
        for (const item of avatarItems) {
          avatarPathMap[item.id] = item.thumbnail_path || item.storage_path;
        }
      }
    }

    // 取得したパスから署名付きURLを並列生成
    const enriched = await Promise.all(
      profiles.map(async (profile) => {
        const key = profile.avatar_id ? avatarPathMap[profile.avatar_id] : null;
        const avatarUrl = key ? await getSignedFileUrl(key) : null;
        return { ...profile, avatar_link: avatarUrl };
      })
    );

    res.json(enriched);
  } catch (error: any) {
    console.error('メンバー基本プロフィール取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// 自分のプロフィール情報を取得
router.get('/api/basic_profile_info/me', authenticate, async (req: Request, res: Response) => {
  try {
    const { data: basicInfo, error } = await supabase
      .from('basic_profile_info')
      .select('*')
      .eq('id', req.user!.id)
      .single();

    if (error) throw error;

    // ユーザーのアクティブな段階別ロールを取得
    const { data: roleMappings } = await supabase
      .from('user_role_mappings')
      .select('user_role')
      .eq('user_id', req.user!.id)
      .eq('is_current_status', true);

    const activeRoleIds = (roleMappings || []).map(rm => rm.user_role);
    const activeRole = selectActiveRole(activeRoleIds);

    let stageData = {};
    if (activeRole) {
      const tableName = STAGE_TABLE_MAP[activeRole];
      if (tableName) {
        try {
          const { data: fetchStageData, error: stageError } = await supabase
            .from(tableName)
            .select('*')
            .eq('user_id', req.user!.id)
            .maybeSingle();
          if (!stageError) {
            stageData = fetchStageData || {};
          } else {
            console.error(`[Stage Fetch Error in me] Table ${tableName}:`, stageError);
          }
        } catch (err) {
          console.error(`[Stage Fetch Exception in me] Table ${tableName}:`, err);
        }
      }
    }

    // Remove legacy stage fields from basic profile to avoid leaks
    const cleanBasic = { ...basicInfo };
    ALL_STAGE_FIELDS.forEach(field => {
      delete cleanBasic[field];
    });

    const profile = {
      ...cleanBasic,
      ...stageData,
      active_stage_role_id: activeRole ? ROLE_NAMES[activeRole] : null,
      id: basicInfo.id // Keep user's ID
    };
    const filteredProfile = filterProfileByActiveRole(profile, activeRole);

    // avatar_id から表示用URLを生成してフロントへ返す
    const avatarUrl = await resolveAvatarUrl(filteredProfile.avatar_id);
    res.json({ ...filteredProfile, avatar_link: avatarUrl });

  } catch (error: any) {
    console.error('プロフィール取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 自分のプロフィール情報を更新
router.patch('/api/basic_profile_info/me', authenticate, async (req: Request, res: Response) => {
  try {
    // Body から更新したいフィールドのみ受け取り、メタデータを分離
    const { _ai_metadata, ...updates } = req.body;

    // 現在の有効な状況（active_stage_role_id）の更新処理
    const activeStageName = updates.active_stage_role_id;
    delete updates.active_stage_role_id;

    if (activeStageName) {
      const stageNameToId: Record<string, string> = {
        '留学前': ROLE_PRE,
        '留学中': ROLE_CURRENT,
        '留学後': ROLE_POST,
        '保護者': ROLE_GUARDIAN
      };
      const newActiveRoleId = stageNameToId[activeStageName];
      if (newActiveRoleId) {
        // マッピングが存在するか確認
        const { data: existingMapping } = await supabase
          .from('user_role_mappings')
          .select('id')
          .eq('user_id', req.user!.id)
          .eq('user_role', newActiveRoleId)
          .maybeSingle();

        if (!existingMapping) {
          await supabase
            .from('user_role_mappings')
            .insert({
              user_id: req.user!.id,
              user_role: newActiveRoleId,
              is_current_status: true
            });
        }

        // 選択された以外のステージの is_current_status を false に設定
        await supabase
          .from('user_role_mappings')
          .update({ is_current_status: false })
          .eq('user_id', req.user!.id)
          .in('user_role', [ROLE_PRE, ROLE_CURRENT, ROLE_POST, ROLE_GUARDIAN])
          .neq('user_role', newActiveRoleId);

        // 選択されたステージの is_current_status を true に設定
        await supabase
          .from('user_role_mappings')
          .update({ is_current_status: true })
          .eq('user_id', req.user!.id)
          .eq('user_role', newActiveRoleId);
      }
    }

    // ユーザーのアクティブな段階別ロールを取得
    const { data: roleMappings } = await supabase
      .from('user_role_mappings')
      .select('user_role')
      .eq('user_id', req.user!.id)
      .eq('is_current_status', true);

    const activeRoleIds = (roleMappings || []).map(rm => rm.user_role);
    const activeRole = selectActiveRole(activeRoleIds);

    const basicUpdates: any = {};
    const stageUpdates: any = {};

    const allowedStageFields = activeRole ? STAGE_FIELDS_MAP[activeRole] || [] : [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedStageFields.includes(key)) {
        stageUpdates[key] = value;
      } else if (!ALL_STAGE_FIELDS.has(key)) {
        basicUpdates[key] = value;
      }
    }

    // 1. basic_profile_info の更新 (更新内容がある場合のみ)
    if (Object.keys(basicUpdates).length > 0) {
      const { error: basicError } = await supabase
        .from('basic_profile_info')
        .update(basicUpdates)
        .eq('id', req.user!.id);
      if (basicError) throw basicError;
    }

    // 2. アクティブな段階別プロフィールの更新 (更新内容があり、かつロールが存在する場合のみ)
    if (activeRole && Object.keys(stageUpdates).length > 0) {
      const tableName = STAGE_TABLE_MAP[activeRole];
      if (tableName) {
        try {
          const { data: existing, error: fetchError } = await supabase
            .from(tableName)
            .select('id')
            .eq('user_id', req.user!.id)
            .maybeSingle();

          if (fetchError) throw fetchError;

          if (existing) {
            const { error: stageError } = await supabase
              .from(tableName)
              .update(stageUpdates)
              .eq('user_id', req.user!.id);
            if (stageError) throw stageError;
          } else {
            const { error: stageError } = await supabase
              .from(tableName)
              .insert({ user_id: req.user!.id, ...stageUpdates });
            if (stageError) throw stageError;
          }
        } catch (err: any) {
          console.error(`[Stage Update Error] Table ${tableName}:`, err);
          return res.status(400).json({
            error: `データベースの保存に失敗しました (テーブル定義の整合性エラー): ${err.message || JSON.stringify(err)}`
          });
        }
      }
    }

    // 3. 最新の結合プロファイルを取得して返す
    const { data: basicInfo, error: fetchError } = await supabase
      .from('basic_profile_info')
      .select('*')
      .eq('id', req.user!.id)
      .single();

    if (fetchError || !basicInfo) throw fetchError || new Error('Profile not found');

    let latestStageData = {};
    if (activeRole) {
      const tableName = STAGE_TABLE_MAP[activeRole];
      if (tableName) {
        try {
          const { data: fetchStageData, error: stageError } = await supabase
            .from(tableName)
            .select('*')
            .eq('user_id', req.user!.id)
            .maybeSingle();
          if (!stageError) {
            latestStageData = fetchStageData || {};
          } else {
            console.error(`[Stage Fetch Error in PATCH] Table ${tableName}:`, stageError);
          }
        } catch (err) {
          console.error(`[Stage Fetch Exception in PATCH] Table ${tableName}:`, err);
        }
      }
    }

    const profile = {
      ...basicInfo,
      ...latestStageData,
      active_stage_role_id: activeRole ? ROLE_NAMES[activeRole] : null,
      id: basicInfo.id // Keep user's ID
    };
    const filteredProfile = filterProfileByActiveRole(profile, activeRole);

    // レスポンスにも avatar_link を付与して返す
    const avatarUrl = await resolveAvatarUrl(filteredProfile.avatar_id);
    res.json({ ...filteredProfile, avatar_link: avatarUrl });

    // 🤖 バックグラウンドでAIベクトル化を実行
    (async () => {
      try {
        const user_id = req.user!.id;
        
        if (_ai_metadata) {
          // フロントから届いたヒント（型情報）を使って、既存の answerToText で一貫した文章を作る
          const { label, type, options, formattedValue } = _ai_metadata;
          const field_key = _ai_metadata.field_key || Object.keys(updates)[0];
          const value = updates[field_key];

          const q = { id: field_key, title: label, type: type, options: options, formattedValue: formattedValue };
          const text = answerToText([q], { [field_key]: value });

          if (text) {
            await queueIndexWork({
              source_type: 'basic_profile',
              source_id: user_id,
              content: text,
              metadata: { user_id, field_key, label }
            });
          }
        } else {
          // フォールバック: メタデータがない場合は単純な変換
          for (const [key, value] of Object.entries(updates)) {
            if (['updated_at', 'timezone', 'avatar_id'].includes(key)) continue;
            
            const text = `${key}: ${Array.isArray(value) ? value.join(', ') : value}`;
            await queueIndexWork({
              source_type: 'basic_profile',
              source_id: user_id,
              content: text,
              metadata: { user_id, field_key: key }
            });
          }
        }
      } catch (err) {
        console.error('[AI Indexer] ❌ Profile indexing failed:', err);
      }
    })();

  } catch (error: any) {
    console.error('プロフィール更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 指定したID（他人）のプロフィール情報を取得
router.get('/api/basic_profile_info/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data: basicInfo, error } = await supabase
      .from('basic_profile_info')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'プロフィールが見つかりません' });
      }
      throw error;
    }

    // ユーザーのアクティブな段階別ロールを取得
    const { data: roleMappings } = await supabase
      .from('user_role_mappings')
      .select('user_role')
      .eq('user_id', id)
      .eq('is_current_status', true);

    const activeRoleIds = (roleMappings || []).map(rm => rm.user_role);
    const activeRole = selectActiveRole(activeRoleIds);

    let stageData = {};
    if (activeRole) {
      const tableName = STAGE_TABLE_MAP[activeRole];
      if (tableName) {
        try {
          const { data: fetchStageData, error: stageError } = await supabase
            .from(tableName)
            .select('*')
            .eq('user_id', id)
            .maybeSingle();
          if (!stageError) {
            stageData = fetchStageData || {};
          } else {
            console.error(`[Stage Fetch Error in :id] Table ${tableName}:`, stageError);
          }
        } catch (err) {
          console.error(`[Stage Fetch Exception in :id] Table ${tableName}:`, err);
        }
      }
    }

    // Remove legacy stage fields from basic profile to avoid leaks
    const cleanBasic = { ...basicInfo };
    ALL_STAGE_FIELDS.forEach(field => {
      delete cleanBasic[field];
    });

    const profile = {
      ...cleanBasic,
      ...stageData,
      active_stage_role_id: activeRole ? ROLE_NAMES[activeRole] : null,
      id: basicInfo.id // Keep user's ID
    };
    const filteredProfile = filterProfileByActiveRole(profile, activeRole);

    // avatar_id から表示用URLを生成してフロントへ返す
    const avatarUrl = await resolveAvatarUrl(filteredProfile.avatar_id);
    res.json({ ...filteredProfile, avatar_link: avatarUrl });

  } catch (error: any) {
    console.error('指定プロフィール取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 自分のアカウントを削除
// ⚠️ Service Role Key（管理者権限）が必要なため、フロントではなくバックエンドで実行する
router.delete('/api/account/me', authenticate, async (req: Request, res: Response) => {
  try {
    // Supabase Admin APIでユーザーを削除（関連するAuth情報も全消し）
    const { error: deleteError } = await supabase.auth.admin.deleteUser(req.user!.id);
    if (deleteError) throw deleteError;

    res.json({ message: 'アカウントを削除しました' });

  } catch (error: any) {
    console.error('アカウント削除エラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// ==========================================
// 🎟️ 留学祭2026プロフィール専用エンドポイント
// ==========================================

// 自分の留学祭2026プロフィール情報を取得 (basic_profile_info + current_study_abroad_profiles)
router.get('/api/profile/ryugakusai2026/me', authenticate, async (req: Request, res: Response) => {
  try {
    const { data: basicInfo, error: basicError } = await supabase
      .from('basic_profile_info')
      .select('*')
      .eq('id', req.user!.id)
      .single();

    if (basicError) throw basicError;

    const { data: currentStudyInfo, error: currentStudyError } = await supabase
      .from('current_study_abroad_profiles')
      .select('*')
      .eq('user_id', req.user!.id)
      .maybeSingle();

    if (currentStudyError) throw currentStudyError;

    const profile = {
      ...basicInfo,
      ...(currentStudyInfo || {}),
      id: basicInfo.id // 確実にユーザーIDを保つ
    };

    const avatarUrl = await resolveAvatarUrl(profile.avatar_id);
    res.json({ ...profile, avatar_link: avatarUrl });

  } catch (error: any) {
    console.error('留学祭2026プロフィール取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 指定したIDのユーザーの留学祭2026プロフィール情報を取得
router.get('/api/profile/ryugakusai2026/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const { data: basicInfo, error: basicError } = await supabase
      .from('basic_profile_info')
      .select('*')
      .eq('id', id)
      .single();

    if (basicError) {
      if (basicError.code === 'PGRST116') {
        return res.status(404).json({ error: 'プロフィールが見つかりません' });
      }
      throw basicError;
    }

    const { data: currentStudyInfo, error: currentStudyError } = await supabase
      .from('current_study_abroad_profiles')
      .select('*')
      .eq('user_id', id)
      .maybeSingle();

    if (currentStudyError) throw currentStudyError;

    const profile = {
      ...basicInfo,
      ...(currentStudyInfo || {}),
      id: basicInfo.id
    };

    const avatarUrl = await resolveAvatarUrl(profile.avatar_id);
    res.json({ ...profile, avatar_link: avatarUrl });

  } catch (error: any) {
    console.error('指定した留学祭2026プロフィール取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 自分の留学祭2026プロフィール情報を更新
router.patch('/api/profile/ryugakusai2026/me', authenticate, async (req: Request, res: Response) => {
  try {
    const { _ai_metadata, ...updates } = req.body;

    const basicFields = ['name_english', 'name_kanji', 'grade_level', 'hometown', 'short_message'];
    const currentStudyFields = [
      'current_school',
      'study_abroad_country',
      'study_abroad_city',
      'study_abroad_type',
      'english_school',
      'majors',
      'minors'
    ];

    const basicUpdates: any = {};
    const currentStudyUpdates: any = {};

    for (const [key, value] of Object.entries(updates)) {
      if (basicFields.includes(key)) {
        basicUpdates[key] = value;
      } else if (currentStudyFields.includes(key)) {
        currentStudyUpdates[key] = value;
      }
    }

    // 1. basic_profile_info の更新 (更新内容がある場合のみ)
    if (Object.keys(basicUpdates).length > 0) {
      const { error: basicError } = await supabase
        .from('basic_profile_info')
        .update(basicUpdates)
        .eq('id', req.user!.id);
      if (basicError) throw basicError;
    }

    // 2. current_study_abroad_profiles の更新または挿入 (更新内容がある場合のみ)
    if (Object.keys(currentStudyUpdates).length > 0) {
      const { data: existing, error: fetchError } = await supabase
        .from('current_study_abroad_profiles')
        .select('id')
        .eq('user_id', req.user!.id)
        .maybeSingle();

      if (fetchError) throw fetchError;

      if (existing) {
        const { error: stageError } = await supabase
          .from('current_study_abroad_profiles')
          .update(currentStudyUpdates)
          .eq('user_id', req.user!.id);
        if (stageError) throw stageError;
      } else {
        const { error: stageError } = await supabase
          .from('current_study_abroad_profiles')
          .insert({ user_id: req.user!.id, ...currentStudyUpdates });
        if (stageError) throw stageError;
      }
    }

    // 最新の結合情報を取得して返す
    const { data: basicInfo, error: fetchBasicError } = await supabase
      .from('basic_profile_info')
      .select('*')
      .eq('id', req.user!.id)
      .single();

    if (fetchBasicError || !basicInfo) throw fetchBasicError || new Error('Profile not found');

    const { data: currentStudyInfo, error: fetchCurrentStudyError } = await supabase
      .from('current_study_abroad_profiles')
      .select('*')
      .eq('user_id', req.user!.id)
      .maybeSingle();

    if (fetchCurrentStudyError) throw fetchCurrentStudyError;

    const profile = {
      ...basicInfo,
      ...(currentStudyInfo || {}),
      id: basicInfo.id
    };

    const avatarUrl = await resolveAvatarUrl(profile.avatar_id);
    res.json({ ...profile, avatar_link: avatarUrl });

    // 🤖 バックグラウンドでAIベクトル化を実行
    (async () => {
      try {
        const user_id = req.user!.id;
        
        if (_ai_metadata) {
          const { label, type, options, formattedValue } = _ai_metadata;
          const field_key = _ai_metadata.field_key || Object.keys(updates)[0];
          const value = updates[field_key];

          const q = { id: field_key, title: label, type: type, options: options, formattedValue: formattedValue };
          const text = answerToText([q], { [field_key]: value });

          if (text) {
            await queueIndexWork({
              source_type: 'basic_profile',
              source_id: user_id,
              content: text,
              metadata: { user_id, field_key, label }
            });
          }
        } else {
          for (const [key, value] of Object.entries(updates)) {
            if (['updated_at', 'timezone', 'avatar_id'].includes(key)) continue;
            
            const text = `${key}: ${Array.isArray(value) ? value.join(', ') : value}`;
            await queueIndexWork({
              source_type: 'basic_profile',
              source_id: user_id,
              content: text,
              metadata: { user_id, field_key: key }
            });
          }
        }
      } catch (err) {
        console.error('[AI Indexer] ❌ Profile indexing failed:', err);
      }
    })();

  } catch (error: any) {
    console.error('留学祭2026プロフィール更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

