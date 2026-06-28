"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_STAGE_FIELDS = exports.STAGE_FIELDS_MAP = exports.ROLE_NAMES = exports.STAGE_TABLE_MAP = exports.ROLE_GUARDIAN = exports.ROLE_POST = exports.ROLE_CURRENT = exports.ROLE_PRE = void 0;
exports.filterProfileByActiveRole = filterProfileByActiveRole;
exports.selectActiveRole = selectActiveRole;
const express_1 = require("express");
const supabase_1 = require("../lib/supabase");
const r2_1 = require("../lib/r2");
const ai_1 = require("../lib/ai");
const vectorIndexer_1 = require("../lib/vectorIndexer");
const authenticate_1 = require("../middleware/authenticate");
const router = (0, express_1.Router)();
// ==========================================
// 🔑 留学段階ロール定数 & 優先解決ヘルパー
// ==========================================
exports.ROLE_PRE = '30b89471-46da-4501-84cd-f318b8cfeb3e';
exports.ROLE_CURRENT = '1f7f6138-eecc-4925-958a-095ea80eff5c';
exports.ROLE_POST = 'aad63ee1-40de-4807-a0b0-5660fa68a1f6';
exports.ROLE_GUARDIAN = 'c8fcb0bc-7cf1-4bd5-90ba-7bbb45f5fbbc';
exports.STAGE_TABLE_MAP = {
    [exports.ROLE_PRE]: 'pre_study_abroad_profiles',
    [exports.ROLE_CURRENT]: 'current_study_abroad_profiles',
    [exports.ROLE_POST]: 'post_study_abroad_profiles',
    [exports.ROLE_GUARDIAN]: 'guardian_profiles'
};
exports.ROLE_NAMES = {
    [exports.ROLE_PRE]: '留学前',
    [exports.ROLE_CURRENT]: '留学中',
    [exports.ROLE_POST]: '留学後',
    [exports.ROLE_GUARDIAN]: '保護者'
};
exports.STAGE_FIELDS_MAP = {
    [exports.ROLE_PRE]: [
        'study_abroad_interest_level',
        'interested_areas',
        'interested_countries',
        'interested_majors',
        'interested_study_abroad_types',
        'expected_timing'
    ],
    [exports.ROLE_CURRENT]: [
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
    [exports.ROLE_POST]: [
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
    [exports.ROLE_GUARDIAN]: [
        'child_id',
        'concerns'
    ]
};
exports.ALL_STAGE_FIELDS = (() => {
    const fieldsSet = new Set();
    Object.values(exports.STAGE_FIELDS_MAP).forEach(fields => {
        fields.forEach(f => fieldsSet.add(f));
    });
    return fieldsSet;
})();
function filterProfileByActiveRole(profile, activeRole) {
    const allowedFields = new Set(activeRole ? exports.STAGE_FIELDS_MAP[activeRole] || [] : []);
    const filtered = { ...profile };
    exports.ALL_STAGE_FIELDS.forEach(field => {
        if (!allowedFields.has(field)) {
            delete filtered[field];
        }
    });
    return filtered;
}
function selectActiveRole(roleIds) {
    if (roleIds.includes(exports.ROLE_POST))
        return exports.ROLE_POST;
    if (roleIds.includes(exports.ROLE_CURRENT))
        return exports.ROLE_CURRENT;
    if (roleIds.includes(exports.ROLE_PRE))
        return exports.ROLE_PRE;
    if (roleIds.includes(exports.ROLE_GUARDIAN))
        return exports.ROLE_GUARDIAN;
    return null;
}
// ==========================================
// 👤 プロフィール系 API
// ==========================================
// 🌟 メンバーの基本プロフィール情報（一覧用）
router.get('/api/basic_profile_info', authenticate_1.authenticate, async (req, res) => {
    try {
        const roleFilter = req.query.role;
        let userIdsWithRole = null;
        if (roleFilter) {
            // 1. Get role ID from user_roles where role_name matches
            const { data: roleData, error: roleErr } = await supabase_1.supabase
                .from('user_roles')
                .select('id')
                .eq('role_name', roleFilter)
                .single();
            if (roleErr && roleErr.code !== 'PGRST116') {
                throw roleErr;
            }
            if (roleData) {
                // 2. Get user IDs with this role mapping
                const { data: mappings, error: mapErr } = await supabase_1.supabase
                    .from('user_role_mappings')
                    .select('user_id')
                    .eq('user_role', roleData.id);
                if (mapErr)
                    throw mapErr;
                userIdsWithRole = (mappings || []).map(m => m.user_id);
            }
            else {
                // If the role name is not found, check if roleFilter itself is a valid UUID
                const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
                if (uuidRegex.test(roleFilter)) {
                    const { data: mappings, error: mapErr } = await supabase_1.supabase
                        .from('user_role_mappings')
                        .select('user_id')
                        .eq('user_role', roleFilter);
                    if (mapErr)
                        throw mapErr;
                    userIdsWithRole = (mappings || []).map(m => m.user_id);
                }
                else {
                    // If neither, return empty array immediately
                    userIdsWithRole = [];
                }
            }
        }
        let query = supabase_1.supabase.from('basic_profile_info').select('*');
        if (userIdsWithRole !== null) {
            if (userIdsWithRole.length === 0) {
                return res.json([]);
            }
            query = query.in('id', userIdsWithRole);
        }
        const { data: basicProfiles, error } = await query;
        if (error)
            throw error;
        const basicList = basicProfiles || [];
        let profiles = [...basicList];
        if (basicList.length > 0) {
            const userIds = basicList.map(p => p.id);
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
            const guardianUserIds = [];
            userIds.forEach(uid => {
                const roles = userRolesMap.get(uid) || [];
                const active = selectActiveRole(roles);
                if (active === exports.ROLE_PRE)
                    preUserIds.push(uid);
                else if (active === exports.ROLE_CURRENT)
                    currentUserIds.push(uid);
                else if (active === exports.ROLE_POST)
                    postUserIds.push(uid);
                else if (active === exports.ROLE_GUARDIAN)
                    guardianUserIds.push(uid);
            });
            // 4. 各段階別プロフィールテーブルに対して、対象ユーザーIDのみで一括取得
            const [preRes, currentRes, postRes, guardianRes] = await Promise.all([
                preUserIds.length > 0
                    ? supabase_1.supabase.from('pre_study_abroad_profiles').select('*').in('user_id', preUserIds)
                    : Promise.resolve({ data: [] }),
                currentUserIds.length > 0
                    ? supabase_1.supabase.from('current_study_abroad_profiles').select('*').in('user_id', currentUserIds)
                    : Promise.resolve({ data: [] }),
                postUserIds.length > 0
                    ? supabase_1.supabase.from('post_study_abroad_profiles').select('*').in('user_id', postUserIds)
                    : Promise.resolve({ data: [] }),
                guardianUserIds.length > 0
                    ? supabase_1.supabase.from('guardian_profiles').select('*').in('user_id', guardianUserIds)
                    : Promise.resolve({ data: [] })
            ]);
            // 5. 取得したデータをユーザーIDをキーとする Map に格納
            const stageDataMap = new Map();
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
                exports.ALL_STAGE_FIELDS.forEach(field => {
                    delete cleanBasic[field];
                });
                const merged = {
                    ...cleanBasic,
                    ...stageData,
                    active_stage_role_id: active ? exports.ROLE_NAMES[active] : null,
                    id: p.id // Keep user's ID
                };
                return filterProfileByActiveRole(merged, active);
            });
        }
        // ✅ 最適化: 全 avatar_id をまとめて1回のDBクエリで取得（N回 → 1回）
        const avatarIds = profiles.map(p => p.avatar_id).filter(Boolean);
        let avatarPathMap = {};
        if (avatarIds.length > 0) {
            const { data: avatarItems } = await supabase_1.supabase
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
        const enriched = await Promise.all(profiles.map(async (profile) => {
            const key = profile.avatar_id ? avatarPathMap[profile.avatar_id] : null;
            const avatarUrl = key ? await (0, r2_1.getSignedFileUrl)(key) : null;
            return { ...profile, avatar_link: avatarUrl };
        }));
        res.json(enriched);
    }
    catch (error) {
        console.error('メンバー基本プロフィール取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 自分のプロフィール情報を取得
router.get('/api/basic_profile_info/me', authenticate_1.authenticate, async (req, res) => {
    try {
        const { data: basicInfo, error } = await supabase_1.supabase
            .from('basic_profile_info')
            .select('*')
            .eq('id', req.user.id)
            .single();
        if (error)
            throw error;
        // ユーザーのアクティブな段階別ロールを取得
        const { data: roleMappings } = await supabase_1.supabase
            .from('user_role_mappings')
            .select('user_role')
            .eq('user_id', req.user.id)
            .eq('is_current_status', true);
        const activeRoleIds = (roleMappings || []).map(rm => rm.user_role);
        const activeRole = selectActiveRole(activeRoleIds);
        let stageData = {};
        if (activeRole) {
            const tableName = exports.STAGE_TABLE_MAP[activeRole];
            if (tableName) {
                try {
                    const { data: fetchStageData, error: stageError } = await supabase_1.supabase
                        .from(tableName)
                        .select('*')
                        .eq('user_id', req.user.id)
                        .maybeSingle();
                    if (!stageError) {
                        stageData = fetchStageData || {};
                    }
                    else {
                        console.error(`[Stage Fetch Error in me] Table ${tableName}:`, stageError);
                    }
                }
                catch (err) {
                    console.error(`[Stage Fetch Exception in me] Table ${tableName}:`, err);
                }
            }
        }
        // Remove legacy stage fields from basic profile to avoid leaks
        const cleanBasic = { ...basicInfo };
        exports.ALL_STAGE_FIELDS.forEach(field => {
            delete cleanBasic[field];
        });
        const profile = {
            ...cleanBasic,
            ...stageData,
            active_stage_role_id: activeRole ? exports.ROLE_NAMES[activeRole] : null,
            id: basicInfo.id // Keep user's ID
        };
        const filteredProfile = filterProfileByActiveRole(profile, activeRole);
        // avatar_id から表示用URLを生成してフロントへ返す
        const avatarUrl = await (0, r2_1.resolveAvatarUrl)(filteredProfile.avatar_id);
        res.json({ ...filteredProfile, avatar_link: avatarUrl });
    }
    catch (error) {
        console.error('プロフィール取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 自分のプロフィール情報を更新
router.patch('/api/basic_profile_info/me', authenticate_1.authenticate, async (req, res) => {
    try {
        // Body から更新したいフィールドのみ受け取り、メタデータを分離
        const { _ai_metadata, ...updates } = req.body;
        // 現在の有効な状況（active_stage_role_id）の更新処理
        const activeStageName = updates.active_stage_role_id;
        delete updates.active_stage_role_id;
        if (activeStageName) {
            const stageNameToId = {
                '留学前': exports.ROLE_PRE,
                '留学中': exports.ROLE_CURRENT,
                '留学後': exports.ROLE_POST,
                '保護者': exports.ROLE_GUARDIAN
            };
            const newActiveRoleId = stageNameToId[activeStageName];
            if (newActiveRoleId) {
                // マッピングが存在するか確認
                const { data: existingMapping } = await supabase_1.supabase
                    .from('user_role_mappings')
                    .select('id')
                    .eq('user_id', req.user.id)
                    .eq('user_role', newActiveRoleId)
                    .maybeSingle();
                if (!existingMapping) {
                    await supabase_1.supabase
                        .from('user_role_mappings')
                        .insert({
                        user_id: req.user.id,
                        user_role: newActiveRoleId,
                        is_current_status: true
                    });
                }
                // 選択された以外のステージの is_current_status を false に設定
                await supabase_1.supabase
                    .from('user_role_mappings')
                    .update({ is_current_status: false })
                    .eq('user_id', req.user.id)
                    .in('user_role', [exports.ROLE_PRE, exports.ROLE_CURRENT, exports.ROLE_POST, exports.ROLE_GUARDIAN])
                    .neq('user_role', newActiveRoleId);
                // 選択されたステージの is_current_status を true に設定
                await supabase_1.supabase
                    .from('user_role_mappings')
                    .update({ is_current_status: true })
                    .eq('user_id', req.user.id)
                    .eq('user_role', newActiveRoleId);
            }
        }
        // ユーザーのアクティブな段階別ロールを取得
        const { data: roleMappings } = await supabase_1.supabase
            .from('user_role_mappings')
            .select('user_role')
            .eq('user_id', req.user.id)
            .eq('is_current_status', true);
        const activeRoleIds = (roleMappings || []).map(rm => rm.user_role);
        const activeRole = selectActiveRole(activeRoleIds);
        const basicUpdates = {};
        const stageUpdates = {};
        const allowedStageFields = activeRole ? exports.STAGE_FIELDS_MAP[activeRole] || [] : [];
        for (const [key, value] of Object.entries(updates)) {
            if (allowedStageFields.includes(key)) {
                stageUpdates[key] = value;
            }
            else if (!exports.ALL_STAGE_FIELDS.has(key)) {
                basicUpdates[key] = value;
            }
        }
        // 1. basic_profile_info の更新 (更新内容がある場合のみ)
        if (Object.keys(basicUpdates).length > 0) {
            const { error: basicError } = await supabase_1.supabase
                .from('basic_profile_info')
                .update(basicUpdates)
                .eq('id', req.user.id);
            if (basicError)
                throw basicError;
        }
        // 2. アクティブな段階別プロフィールの更新 (更新内容があり、かつロールが存在する場合のみ)
        if (activeRole && Object.keys(stageUpdates).length > 0) {
            const tableName = exports.STAGE_TABLE_MAP[activeRole];
            if (tableName) {
                try {
                    const { data: existing, error: fetchError } = await supabase_1.supabase
                        .from(tableName)
                        .select('id')
                        .eq('user_id', req.user.id)
                        .maybeSingle();
                    if (fetchError)
                        throw fetchError;
                    if (existing) {
                        const { error: stageError } = await supabase_1.supabase
                            .from(tableName)
                            .update(stageUpdates)
                            .eq('user_id', req.user.id);
                        if (stageError)
                            throw stageError;
                    }
                    else {
                        const { error: stageError } = await supabase_1.supabase
                            .from(tableName)
                            .insert({ user_id: req.user.id, ...stageUpdates });
                        if (stageError)
                            throw stageError;
                    }
                }
                catch (err) {
                    console.error(`[Stage Update Error] Table ${tableName}:`, err);
                    return res.status(400).json({
                        error: `データベースの保存に失敗しました (テーブル定義の整合性エラー): ${err.message || JSON.stringify(err)}`
                    });
                }
            }
        }
        // 3. 最新の結合プロファイルを取得して返す
        const { data: basicInfo, error: fetchError } = await supabase_1.supabase
            .from('basic_profile_info')
            .select('*')
            .eq('id', req.user.id)
            .single();
        if (fetchError || !basicInfo)
            throw fetchError || new Error('Profile not found');
        let latestStageData = {};
        if (activeRole) {
            const tableName = exports.STAGE_TABLE_MAP[activeRole];
            if (tableName) {
                try {
                    const { data: fetchStageData, error: stageError } = await supabase_1.supabase
                        .from(tableName)
                        .select('*')
                        .eq('user_id', req.user.id)
                        .maybeSingle();
                    if (!stageError) {
                        latestStageData = fetchStageData || {};
                    }
                    else {
                        console.error(`[Stage Fetch Error in PATCH] Table ${tableName}:`, stageError);
                    }
                }
                catch (err) {
                    console.error(`[Stage Fetch Exception in PATCH] Table ${tableName}:`, err);
                }
            }
        }
        const profile = {
            ...basicInfo,
            ...latestStageData,
            active_stage_role_id: activeRole ? exports.ROLE_NAMES[activeRole] : null,
            id: basicInfo.id // Keep user's ID
        };
        const filteredProfile = filterProfileByActiveRole(profile, activeRole);
        // レスポンスにも avatar_link を付与して返す
        const avatarUrl = await (0, r2_1.resolveAvatarUrl)(filteredProfile.avatar_id);
        res.json({ ...filteredProfile, avatar_link: avatarUrl });
        // 🤖 バックグラウンドでAIベクトル化を実行
        (async () => {
            try {
                const user_id = req.user.id;
                if (_ai_metadata) {
                    // フロントから届いたヒント（型情報）を使って、既存の answerToText で一貫した文章を作る
                    const { label, type, options, formattedValue } = _ai_metadata;
                    const field_key = _ai_metadata.field_key || Object.keys(updates)[0];
                    const value = updates[field_key];
                    const q = { id: field_key, title: label, type: type, options: options, formattedValue: formattedValue };
                    const text = (0, ai_1.answerToText)([q], { [field_key]: value });
                    if (text) {
                        await (0, vectorIndexer_1.queueIndexWork)({
                            source_type: 'basic_profile',
                            source_id: user_id,
                            content: text,
                            metadata: { user_id, field_key, label }
                        });
                    }
                }
                else {
                    // フォールバック: メタデータがない場合は単純な変換
                    for (const [key, value] of Object.entries(updates)) {
                        if (['updated_at', 'timezone', 'avatar_id'].includes(key))
                            continue;
                        const text = `${key}: ${Array.isArray(value) ? value.join(', ') : value}`;
                        await (0, vectorIndexer_1.queueIndexWork)({
                            source_type: 'basic_profile',
                            source_id: user_id,
                            content: text,
                            metadata: { user_id, field_key: key }
                        });
                    }
                }
            }
            catch (err) {
                console.error('[AI Indexer] ❌ Profile indexing failed:', err);
            }
        })();
    }
    catch (error) {
        console.error('プロフィール更新エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 指定したID（他人）のプロフィール情報を取得
router.get('/api/basic_profile_info/:id', authenticate_1.authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const { data: basicInfo, error } = await supabase_1.supabase
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
        const { data: roleMappings } = await supabase_1.supabase
            .from('user_role_mappings')
            .select('user_role')
            .eq('user_id', id)
            .eq('is_current_status', true);
        const activeRoleIds = (roleMappings || []).map(rm => rm.user_role);
        const activeRole = selectActiveRole(activeRoleIds);
        let stageData = {};
        if (activeRole) {
            const tableName = exports.STAGE_TABLE_MAP[activeRole];
            if (tableName) {
                try {
                    const { data: fetchStageData, error: stageError } = await supabase_1.supabase
                        .from(tableName)
                        .select('*')
                        .eq('user_id', id)
                        .maybeSingle();
                    if (!stageError) {
                        stageData = fetchStageData || {};
                    }
                    else {
                        console.error(`[Stage Fetch Error in :id] Table ${tableName}:`, stageError);
                    }
                }
                catch (err) {
                    console.error(`[Stage Fetch Exception in :id] Table ${tableName}:`, err);
                }
            }
        }
        // Remove legacy stage fields from basic profile to avoid leaks
        const cleanBasic = { ...basicInfo };
        exports.ALL_STAGE_FIELDS.forEach(field => {
            delete cleanBasic[field];
        });
        const profile = {
            ...cleanBasic,
            ...stageData,
            active_stage_role_id: activeRole ? exports.ROLE_NAMES[activeRole] : null,
            id: basicInfo.id // Keep user's ID
        };
        const filteredProfile = filterProfileByActiveRole(profile, activeRole);
        // avatar_id から表示用URLを生成してフロントへ返す
        const avatarUrl = await (0, r2_1.resolveAvatarUrl)(filteredProfile.avatar_id);
        res.json({ ...filteredProfile, avatar_link: avatarUrl });
    }
    catch (error) {
        console.error('指定プロフィール取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 自分のアカウントを削除
// ⚠️ Service Role Key（管理者権限）が必要なため、フロントではなくバックエンドで実行する
router.delete('/api/account/me', authenticate_1.authenticate, async (req, res) => {
    try {
        // Supabase Admin APIでユーザーを削除（関連するAuth情報も全消し）
        const { error: deleteError } = await supabase_1.supabase.auth.admin.deleteUser(req.user.id);
        if (deleteError)
            throw deleteError;
        res.json({ message: 'アカウントを削除しました' });
    }
    catch (error) {
        console.error('アカウント削除エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
