"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../lib/supabase");
const r2_1 = require("../lib/r2");
const authenticate_1 = require("../middleware/authenticate");
const requirePermission_1 = require("../middleware/requirePermission");
const router = (0, express_1.Router)();
// management 配下は全ルート認証必須
router.use(authenticate_1.authenticate);
// ==========================================
// 🔑 留学段階ロールの定義 (保護用)
// ==========================================
const ROLE_PRE = '30b89471-46da-4501-84cd-f318b8cfeb3e';
const ROLE_CURRENT = '1f7f6138-eecc-4925-958a-095ea80eff5c';
const ROLE_POST = 'aad63ee1-40de-4807-a0b0-5660fa68a1f6';
const ROLE_GUARDIAN = 'c8fcb0bc-7cf1-4bd5-90ba-7bbb45f5fbbc';
// 部署一覧の表示に必要な smiring_member ロールID
const ROLE_MEMBER = 'c7f24039-c537-402e-91db-664684f5f8b3';
// ------------------------------------------
// A. ユーザーロール CRUD
// ------------------------------------------
// 1. ロール一覧取得 (留学段階別ロールを除外)
router.get('/roles', (0, requirePermission_1.requirePermission)('management', 'read'), async (_req, res) => {
    try {
        const { data: roles, error } = await supabase_1.supabase
            .from('user_roles')
            .select('*')
            .not('id', 'in', `(${ROLE_PRE},${ROLE_CURRENT},${ROLE_POST},${ROLE_GUARDIAN})`)
            .order('created_at', { ascending: true });
        if (error)
            throw error;
        res.json(roles || []);
    }
    catch (error) {
        console.error('ユーザーロール一覧取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 2. 新規ロール追加
router.post('/roles', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { role_name, description, metadata } = req.body;
        if (!role_name)
            return res.status(400).json({ error: 'ロール名は必須です' });
        const { data: newRole, error } = await supabase_1.supabase
            .from('user_roles')
            .insert({ role_name, description, metadata })
            .select()
            .single();
        if (error)
            throw error;
        res.status(201).json(newRole);
    }
    catch (error) {
        console.error('ユーザーロール作成エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 3. ロール更新
router.patch('/roles/:id', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { id } = req.params;
        const { role_name, description, metadata } = req.body;
        if (id === ROLE_PRE || id === ROLE_CURRENT || id === ROLE_POST || id === ROLE_GUARDIAN) {
            return res.status(403).json({ error: '留学段階のロールは変更できません' });
        }
        const { data: updatedRole, error } = await supabase_1.supabase
            .from('user_roles')
            .update({ role_name, description, metadata })
            .eq('id', id)
            .select()
            .single();
        if (error)
            throw error;
        res.json(updatedRole);
    }
    catch (error) {
        console.error('ユーザーロール更新エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 4. ロール削除
router.delete('/roles/:id', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { id } = req.params;
        if (id === ROLE_PRE || id === ROLE_CURRENT || id === ROLE_POST || id === ROLE_GUARDIAN) {
            return res.status(403).json({ error: '留学段階のロールは削除できません' });
        }
        // マッピングレコードを削除
        const { error: mappingError } = await supabase_1.supabase
            .from('user_role_mappings')
            .delete()
            .eq('user_role', id);
        if (mappingError)
            throw mappingError;
        // ロール定義本体を削除
        const { error: roleError } = await supabase_1.supabase
            .from('user_roles')
            .delete()
            .eq('id', id);
        if (roleError)
            throw roleError;
        res.json({ message: 'ロールを削除しました' });
    }
    catch (error) {
        console.error('ユーザーロール削除エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ------------------------------------------
// B. メンバーのユーザーロール割り当て
// ------------------------------------------
// 1. メンバー一覧とシステムロール（段階別ロールを除く）の取得
router.get('/members', (0, requirePermission_1.requirePermission)('management', 'read'), async (_req, res) => {
    try {
        // メンバーの基本情報を全取得
        const { data: members, error: memberError } = await supabase_1.supabase
            .from('basic_profile_info')
            .select('id, name_english, name_kanji, avatar_id')
            .order('name_english', { ascending: true });
        if (memberError)
            throw memberError;
        const memberList = members || [];
        // アバターURLのバッチ署名解決
        const avatarIds = memberList.map(m => m.avatar_id).filter(Boolean);
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
        const membersWithAvatars = await Promise.all(memberList.map(async (m) => {
            const key = m.avatar_id ? avatarPathMap[m.avatar_id] : null;
            const avatarUrl = key ? await (0, r2_1.getSignedFileUrl)(key) : null;
            return {
                id: m.id,
                name_english: m.name_english,
                name_kanji: m.name_kanji,
                avatar_link: avatarUrl
            };
        }));
        // 全ユーザーのロールマッピングを取得 (段階ロールを除く)
        const { data: mappings, error: mappingError } = await supabase_1.supabase
            .from('user_role_mappings')
            .select('user_id, user_role')
            .not('user_role', 'in', `(${ROLE_PRE},${ROLE_CURRENT},${ROLE_POST},${ROLE_GUARDIAN})`);
        if (mappingError)
            throw mappingError;
        const userRolesMap = new Map();
        (mappings || []).forEach(rm => {
            const list = userRolesMap.get(rm.user_id) || [];
            list.push(rm.user_role);
            userRolesMap.set(rm.user_id, list);
        });
        const enrichedMembers = membersWithAvatars.map(m => ({
            ...m,
            role_ids: userRolesMap.get(m.id) || []
        }));
        res.json(enrichedMembers);
    }
    catch (error) {
        console.error('メンバーロール取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 2. メンバーのロール更新 (段階別ロールは保護した状態で一般ロールだけを洗い替え)
router.put('/members/:userId/roles', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { userId } = req.params;
        const { roleIds } = req.body; // 一般ユーザーロールIDの配列
        if (!Array.isArray(roleIds)) {
            return res.status(400).json({ error: 'roleIdsは配列である必要があります' });
        }
        // 段階別ロール以外のマッピングを一度削除
        const { error: deleteError } = await supabase_1.supabase
            .from('user_role_mappings')
            .delete()
            .eq('user_id', userId)
            .not('user_role', 'in', `(${ROLE_PRE},${ROLE_CURRENT},${ROLE_POST},${ROLE_GUARDIAN})`);
        if (deleteError)
            throw deleteError;
        // 新規登録
        if (roleIds.length > 0) {
            const inserts = roleIds.map((roleId) => ({
                user_id: userId,
                user_role: roleId,
                is_current_status: false
            }));
            const { error: insertError } = await supabase_1.supabase
                .from('user_role_mappings')
                .insert(inserts);
            if (insertError)
                throw insertError;
        }
        res.json({ message: 'ロールを更新しました' });
    }
    catch (error) {
        console.error('メンバーロール更新エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ------------------------------------------
// E. メンバーの留学段階・保護者（Study Stage）割り当て
// ------------------------------------------
// 1. メンバー一覧と留学段階ロール（PRE, CURRENT, POST, GUARDIAN）の取得
router.get('/members/stages', (0, requirePermission_1.requirePermission)('management', 'read'), async (_req, res) => {
    try {
        // メンバーの基本情報を全取得
        const { data: members, error: memberError } = await supabase_1.supabase
            .from('basic_profile_info')
            .select('id, name_english, name_kanji, avatar_id')
            .order('name_english', { ascending: true });
        if (memberError)
            throw memberError;
        const memberList = members || [];
        // アバターURLのバッチ署名解決
        const avatarIds = memberList.map(m => m.avatar_id).filter(Boolean);
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
        const membersWithAvatars = await Promise.all(memberList.map(async (m) => {
            const key = m.avatar_id ? avatarPathMap[m.avatar_id] : null;
            const avatarUrl = key ? await (0, r2_1.getSignedFileUrl)(key) : null;
            return {
                id: m.id,
                name_english: m.name_english,
                name_kanji: m.name_kanji,
                avatar_link: avatarUrl
            };
        }));
        // 全ユーザーの留学段階ロールマッピングを取得 (is_current_statusがtrueであるものを優先)
        const { data: mappings, error: mappingError } = await supabase_1.supabase
            .from('user_role_mappings')
            .select('user_id, user_role, is_current_status')
            .in('user_role', [ROLE_PRE, ROLE_CURRENT, ROLE_POST, ROLE_GUARDIAN]);
        if (mappingError)
            throw mappingError;
        const userStagesMap = new Map();
        const userActiveStageMap = new Map();
        (mappings || []).forEach(rm => {
            const list = userStagesMap.get(rm.user_id) || [];
            list.push(rm.user_role);
            userStagesMap.set(rm.user_id, list);
            if (rm.is_current_status) {
                userActiveStageMap.set(rm.user_id, rm.user_role);
            }
        });
        const enrichedMembers = membersWithAvatars.map(m => ({
            ...m,
            stage_role_ids: userStagesMap.get(m.id) || [],
            active_stage_role_id: userActiveStageMap.get(m.id) || null
        }));
        res.json(enrichedMembers);
    }
    catch (error) {
        console.error('メンバー留学段階取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 2. メンバーの留学段階更新
router.put('/members/:userId/stage', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { userId } = req.params;
        const { stageRoleIds, activeStageRoleId } = req.body; // stageRoleIds: array of string, activeStageRoleId: string | null
        if (!Array.isArray(stageRoleIds)) {
            return res.status(400).json({ error: 'stageRoleIdsは配列である必要があります' });
        }
        // 既存の留学段階ロールマッピングをすべて削除
        const { error: deleteError } = await supabase_1.supabase
            .from('user_role_mappings')
            .delete()
            .eq('user_id', userId)
            .in('user_role', [ROLE_PRE, ROLE_CURRENT, ROLE_POST, ROLE_GUARDIAN]);
        if (deleteError)
            throw deleteError;
        // 新規登録
        if (stageRoleIds.length > 0) {
            const validRoles = [ROLE_PRE, ROLE_CURRENT, ROLE_POST, ROLE_GUARDIAN];
            for (const rid of stageRoleIds) {
                if (!validRoles.includes(rid)) {
                    return res.status(400).json({ error: `無効な留学段階ロールIDが含まれています: ${rid}` });
                }
            }
            // activeStageRoleId が指定されていなければ、選択されている最初のものをデフォルトアクティブにする
            let activeId = activeStageRoleId;
            if (!activeId || !stageRoleIds.includes(activeId)) {
                activeId = stageRoleIds[0];
            }
            const inserts = stageRoleIds.map((roleId) => ({
                user_id: userId,
                user_role: roleId,
                is_current_status: roleId === activeId
            }));
            const { error: insertError } = await supabase_1.supabase
                .from('user_role_mappings')
                .insert(inserts);
            if (insertError)
                throw insertError;
        }
        res.json({ message: '留学段階を更新しました' });
    }
    catch (error) {
        console.error('メンバー留学段階更新エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ------------------------------------------
// C. 部署・チームマスタ CRUD
// ------------------------------------------
// 1. 部署一覧取得
router.get('/departments', (0, requirePermission_1.requirePermission)('management', 'read'), async (_req, res) => {
    try {
        const { data: departments, error } = await supabase_1.supabase
            .from('departments')
            .select('*')
            .order('sort_order', { ascending: true, nullsFirst: false })
            .order('name', { ascending: true });
        if (error)
            throw error;
        res.json(departments || []);
    }
    catch (error) {
        console.error('部署一覧取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 2. 新規部署作成
router.post('/departments', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { name, parent_id } = req.body;
        if (!name)
            return res.status(400).json({ error: '部署名は必須です' });
        // 最大の表示順を取得して +1 する
        const { data: maxDept } = await supabase_1.supabase
            .from('departments')
            .select('sort_order')
            .order('sort_order', { ascending: false, nullsFirst: false })
            .limit(1);
        const maxOrder = maxDept && maxDept.length > 0 ? (maxDept[0].sort_order || 0) : 0;
        const nextOrder = maxOrder + 1;
        const { data: newDept, error } = await supabase_1.supabase
            .from('departments')
            .insert({
            name,
            parent_id: parent_id || null,
            sort_order: nextOrder
        })
            .select()
            .single();
        if (error)
            throw error;
        res.status(201).json(newDept);
    }
    catch (error) {
        console.error('部署作成エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 3. 部署更新
router.patch('/departments/:id', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { id } = req.params;
        const { name, parent_id, sort_order } = req.body;
        const updates = {
            name,
            parent_id: parent_id || null
        };
        if (sort_order !== undefined) {
            updates.sort_order = sort_order !== '' && sort_order !== null ? parseInt(sort_order, 10) : null;
        }
        const { data: updatedDept, error } = await supabase_1.supabase
            .from('departments')
            .update(updates)
            .eq('id', id)
            .select()
            .single();
        if (error)
            throw error;
        res.json(updatedDept);
    }
    catch (error) {
        console.error('部署更新エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 4. 部署削除
router.delete('/departments/:id', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { id } = req.params;
        // マッピングテーブルから紐付けを削除
        const { error: mappingError } = await supabase_1.supabase
            .from('member_department_mappings')
            .delete()
            .eq('department_id', id);
        if (mappingError)
            throw mappingError;
        // 子部署の parent_id を NULL に修正
        await supabase_1.supabase
            .from('departments')
            .update({ parent_id: null })
            .eq('parent_id', id);
        // 部署本体を削除
        const { error: deptError } = await supabase_1.supabase
            .from('departments')
            .delete()
            .eq('id', id);
        if (deptError)
            throw deptError;
        res.json({ message: '部署を削除しました' });
    }
    catch (error) {
        console.error('部署削除エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 5. 部署並べ替え (Bulk Reorder)
router.put('/departments/reorder', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { orders } = req.body; // array of { id, sort_order }
        if (!Array.isArray(orders)) {
            return res.status(400).json({ error: 'ordersは配列である必要があります' });
        }
        const promises = orders.map(item => supabase_1.supabase
            .from('departments')
            .update({ sort_order: item.sort_order })
            .eq('id', item.id));
        const results = await Promise.all(promises);
        for (const res of results) {
            if (res.error)
                throw res.error;
        }
        res.json({ message: '部署の表示順を更新しました' });
    }
    catch (error) {
        console.error('部署並べ替えエラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// ------------------------------------------
// D. メンバーの部署・チーム割り当て
// ------------------------------------------
// 1. smiring_member ロールを持つメンバーと所属部署IDの取得
router.get('/members/departments', (0, requirePermission_1.requirePermission)('management', 'read'), async (_req, res) => {
    try {
        // smiring_member ロールを持つユーザーIDのリストを取得
        const { data: roleMappings, error: roleError } = await supabase_1.supabase
            .from('user_role_mappings')
            .select('user_id')
            .eq('user_role', ROLE_MEMBER);
        if (roleError)
            throw roleError;
        const memberUserIds = (roleMappings || []).map(rm => rm.user_id);
        if (memberUserIds.length === 0) {
            return res.json([]);
        }
        // 対象ユーザーの基本情報を取得
        const { data: members, error: memberError } = await supabase_1.supabase
            .from('basic_profile_info')
            .select('id, name_english, name_kanji, avatar_id')
            .in('id', memberUserIds)
            .order('name_english', { ascending: true });
        if (memberError)
            throw memberError;
        const memberList = members || [];
        // アバターURLの一括解決
        const avatarIds = memberList.map(m => m.avatar_id).filter(Boolean);
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
        const membersWithAvatars = await Promise.all(memberList.map(async (m) => {
            const key = m.avatar_id ? avatarPathMap[m.avatar_id] : null;
            const avatarUrl = key ? await (0, r2_1.getSignedFileUrl)(key) : null;
            return {
                id: m.id,
                name_english: m.name_english,
                name_kanji: m.name_kanji,
                avatar_link: avatarUrl
            };
        }));
        // member_department_mappings から所属部署マッピングを取得
        const { data: deptMappings, error: deptMapError } = await supabase_1.supabase
            .from('member_department_mappings')
            .select('user_id, department_id')
            .in('user_id', memberUserIds);
        if (deptMapError)
            throw deptMapError;
        const userDeptsMap = new Map();
        (deptMappings || []).forEach(dm => {
            const list = userDeptsMap.get(dm.user_id) || [];
            list.push(dm.department_id);
            userDeptsMap.set(dm.user_id, list);
        });
        const enrichedMembers = membersWithAvatars.map(m => ({
            ...m,
            department_ids: userDeptsMap.get(m.id) || []
        }));
        res.json(enrichedMembers);
    }
    catch (error) {
        console.error('部署メンバー取得エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
// 2. メンバーの部署更新 (洗い替え)
router.put('/members/:userId/departments', (0, requirePermission_1.requirePermission)('management', 'write'), async (req, res) => {
    try {
        const { userId } = req.params;
        const { departmentIds } = req.body; // 部署IDの配列
        if (!Array.isArray(departmentIds)) {
            return res.status(400).json({ error: 'departmentIdsは配列である必要があります' });
        }
        // 既存マッピングを全削除
        const { error: deleteError } = await supabase_1.supabase
            .from('member_department_mappings')
            .delete()
            .eq('user_id', userId);
        if (deleteError)
            throw deleteError;
        // 新規登録
        if (departmentIds.length > 0) {
            const inserts = departmentIds.map((deptId) => ({
                user_id: userId,
                department_id: deptId
            }));
            const { error: insertError } = await supabase_1.supabase
                .from('member_department_mappings')
                .insert(inserts);
            if (insertError)
                throw insertError;
        }
        res.json({ message: '部署を更新しました' });
    }
    catch (error) {
        console.error('メンバー部署更新エラー:', error);
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
