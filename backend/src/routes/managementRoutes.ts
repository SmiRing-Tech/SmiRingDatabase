import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { getSignedFileUrl } from '../lib/r2';
import { authenticate } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';

const router = Router();

// management 配下は全ルート認証必須
router.use(authenticate);

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
router.get('/roles', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    const { data: roles, error } = await supabase
      .from('user_roles')
      .select('*')
      .not('id', 'in', `(${ROLE_PRE},${ROLE_CURRENT},${ROLE_POST},${ROLE_GUARDIAN})`)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(roles || []);
  } catch (error: any) {
    console.error('ユーザーロール一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. 新規ロール追加
router.post('/roles', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { role_name, description, metadata } = req.body;
    if (!role_name) return res.status(400).json({ error: 'ロール名は必須です' });

    const { data: newRole, error } = await supabase
      .from('user_roles')
      .insert({ role_name, description, metadata })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(newRole);
  } catch (error: any) {
    console.error('ユーザーロール作成エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. ロール更新
router.patch('/roles/:id', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role_name, description, metadata } = req.body;

    if (id === ROLE_PRE || id === ROLE_CURRENT || id === ROLE_POST || id === ROLE_GUARDIAN) {
      return res.status(403).json({ error: '留学段階のロールは変更できません' });
    }

    const { data: updatedRole, error } = await supabase
      .from('user_roles')
      .update({ role_name, description, metadata })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(updatedRole);
  } catch (error: any) {
    console.error('ユーザーロール更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. ロール削除
router.delete('/roles/:id', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (id === ROLE_PRE || id === ROLE_CURRENT || id === ROLE_POST || id === ROLE_GUARDIAN) {
      return res.status(403).json({ error: '留学段階のロールは削除できません' });
    }

    // マッピングレコードを削除
    const { error: mappingError } = await supabase
      .from('user_role_mappings')
      .delete()
      .eq('user_role', id);

    if (mappingError) throw mappingError;

    // ロール定義本体を削除
    const { error: roleError } = await supabase
      .from('user_roles')
      .delete()
      .eq('id', id);

    if (roleError) throw roleError;

    res.json({ message: 'ロールを削除しました' });
  } catch (error: any) {
    console.error('ユーザーロール削除エラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// ------------------------------------------
// B. メンバーのユーザーロール割り当て
// ------------------------------------------

// 1. メンバー一覧とシステムロール（段階別ロールを除く）の取得
router.get('/members', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    // メンバーの基本情報を全取得
    const { data: members, error: memberError } = await supabase
      .from('basic_profile_info')
      .select('id, name_english, name_kanji, avatar_id')
      .order('name_english', { ascending: true });

    if (memberError) throw memberError;
    const memberList = members || [];

    // アバターURLのバッチ署名解決
    const avatarIds = memberList.map(m => m.avatar_id).filter(Boolean);
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

    const membersWithAvatars = await Promise.all(
      memberList.map(async (m) => {
        const key = m.avatar_id ? avatarPathMap[m.avatar_id] : null;
        const avatarUrl = key ? await getSignedFileUrl(key) : null;
        return {
          id: m.id,
          name_english: m.name_english,
          name_kanji: m.name_kanji,
          avatar_link: avatarUrl
        };
      })
    );

    // 全ユーザーのロールマッピングを取得 (段階ロールを除く)
    const { data: mappings, error: mappingError } = await supabase
      .from('user_role_mappings')
      .select('user_id, user_role')
      .not('user_role', 'in', `(${ROLE_PRE},${ROLE_CURRENT},${ROLE_POST},${ROLE_GUARDIAN})`);

    if (mappingError) throw mappingError;

    const userRolesMap = new Map<string, string[]>();
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
  } catch (error: any) {
    console.error('メンバーロール取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. メンバーのロール更新 (段階別ロールは保護した状態で一般ロールだけを洗い替え)
router.put('/members/:userId/roles', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { roleIds } = req.body; // 一般ユーザーロールIDの配列

    if (!Array.isArray(roleIds)) {
      return res.status(400).json({ error: 'roleIdsは配列である必要があります' });
    }

    // 段階別ロール以外のマッピングを一度削除
    const { error: deleteError } = await supabase
      .from('user_role_mappings')
      .delete()
      .eq('user_id', userId)
      .not('user_role', 'in', `(${ROLE_PRE},${ROLE_CURRENT},${ROLE_POST},${ROLE_GUARDIAN})`);

    if (deleteError) throw deleteError;

    // 新規登録
    if (roleIds.length > 0) {
      const inserts = roleIds.map((roleId: string) => ({
        user_id: userId,
        user_role: roleId,
        is_current_status: false
      }));

      const { error: insertError } = await supabase
        .from('user_role_mappings')
        .insert(inserts);

      if (insertError) throw insertError;
    }

    res.json({ message: 'ロールを更新しました' });
  } catch (error: any) {
    console.error('メンバーロール更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// ------------------------------------------
// E. メンバーの留学段階・保護者（Study Stage）割り当て
// ------------------------------------------

// 1. メンバー一覧と留学段階ロール（PRE, CURRENT, POST, GUARDIAN）の取得
router.get('/members/stages', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    // メンバーの基本情報を全取得
    const { data: members, error: memberError } = await supabase
      .from('basic_profile_info')
      .select('id, name_english, name_kanji, avatar_id')
      .order('name_english', { ascending: true });

    if (memberError) throw memberError;
    const memberList = members || [];

    // アバターURLのバッチ署名解決
    const avatarIds = memberList.map(m => m.avatar_id).filter(Boolean);
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

    const membersWithAvatars = await Promise.all(
      memberList.map(async (m) => {
        const key = m.avatar_id ? avatarPathMap[m.avatar_id] : null;
        const avatarUrl = key ? await getSignedFileUrl(key) : null;
        return {
          id: m.id,
          name_english: m.name_english,
          name_kanji: m.name_kanji,
          avatar_link: avatarUrl
        };
      })
    );

    // 全ユーザーの留学段階ロールマッピングを取得 (is_current_statusがtrueであるものを優先)
    const { data: mappings, error: mappingError } = await supabase
      .from('user_role_mappings')
      .select('user_id, user_role, is_current_status')
      .in('user_role', [ROLE_PRE, ROLE_CURRENT, ROLE_POST, ROLE_GUARDIAN]);

    if (mappingError) throw mappingError;

    const userStagesMap = new Map<string, string[]>();
    const userActiveStageMap = new Map<string, string>();

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
  } catch (error: any) {
    console.error('メンバー留学段階取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. メンバーの留学段階更新
router.put('/members/:userId/stage', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { stageRoleIds, activeStageRoleId } = req.body; // stageRoleIds: array of string, activeStageRoleId: string | null

    if (!Array.isArray(stageRoleIds)) {
      return res.status(400).json({ error: 'stageRoleIdsは配列である必要があります' });
    }

    // 既存の留学段階ロールマッピングをすべて削除
    const { error: deleteError } = await supabase
      .from('user_role_mappings')
      .delete()
      .eq('user_id', userId)
      .in('user_role', [ROLE_PRE, ROLE_CURRENT, ROLE_POST, ROLE_GUARDIAN]);

    if (deleteError) throw deleteError;

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

      const inserts = stageRoleIds.map((roleId: string) => ({
        user_id: userId,
        user_role: roleId,
        is_current_status: roleId === activeId
      }));

      const { error: insertError } = await supabase
        .from('user_role_mappings')
        .insert(inserts);

      if (insertError) throw insertError;
    }

    res.json({ message: '留学段階を更新しました' });
  } catch (error: any) {
    console.error('メンバー留学段階更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// ------------------------------------------
// C. 部署・チームマスタ CRUD
// ------------------------------------------

// 1. 部署一覧取得
router.get('/departments', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    const { data: departments, error } = await supabase
      .from('departments')
      .select('*')
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(departments || []);
  } catch (error: any) {
    console.error('部署一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. 新規部署作成
router.post('/departments', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: '部署名は必須です' });

    // 最大の表示順を取得して +1 する
    const { data: maxDept } = await supabase
      .from('departments')
      .select('sort_order')
      .order('sort_order', { ascending: false, nullsFirst: false })
      .limit(1);

    const maxOrder = maxDept && maxDept.length > 0 ? (maxDept[0].sort_order || 0) : 0;
    const nextOrder = maxOrder + 1;

    const { data: newDept, error } = await supabase
      .from('departments')
      .insert({ 
        name, 
        parent_id: parent_id || null,
        sort_order: nextOrder
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(newDept);
  } catch (error: any) {
    console.error('部署作成エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. 部署更新
router.patch('/departments/:id', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, parent_id, sort_order } = req.body;

    const updates: any = {
      name,
      parent_id: parent_id || null
    };

    if (sort_order !== undefined) {
      updates.sort_order = sort_order !== '' && sort_order !== null ? parseInt(sort_order, 10) : null;
    }

    const { data: updatedDept, error } = await supabase
      .from('departments')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(updatedDept);
  } catch (error: any) {
    console.error('部署更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. 部署削除
router.delete('/departments/:id', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // マッピングテーブルから紐付けを削除
    const { error: mappingError } = await supabase
      .from('member_department_mappings')
      .delete()
      .eq('department_id', id);

    if (mappingError) throw mappingError;

    // 子部署の parent_id を NULL に修正
    await supabase
      .from('departments')
      .update({ parent_id: null })
      .eq('parent_id', id);

    // 部署本体を削除
    const { error: deptError } = await supabase
      .from('departments')
      .delete()
      .eq('id', id);

    if (deptError) throw deptError;

    res.json({ message: '部署を削除しました' });
  } catch (error: any) {
    console.error('部署削除エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. 部署並べ替え (Bulk Reorder)
router.put('/departments/reorder', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { orders } = req.body; // array of { id, sort_order }

    if (!Array.isArray(orders)) {
      return res.status(400).json({ error: 'ordersは配列である必要があります' });
    }

    const promises = orders.map(item => 
      supabase
        .from('departments')
        .update({ sort_order: item.sort_order })
        .eq('id', item.id)
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      if (res.error) throw res.error;
    }

    res.json({ message: '部署の表示順を更新しました' });
  } catch (error: any) {
    console.error('部署並べ替えエラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// ------------------------------------------
// D. メンバーの部署・チーム割り当て
// ------------------------------------------

// 1. smiring_member ロールを持つメンバーと所属部署IDの取得
router.get('/members/departments', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    // smiring_member ロールを持つユーザーIDのリストを取得
    const { data: roleMappings, error: roleError } = await supabase
      .from('user_role_mappings')
      .select('user_id')
      .eq('user_role', ROLE_MEMBER);

    if (roleError) throw roleError;
    const memberUserIds = (roleMappings || []).map(rm => rm.user_id);

    if (memberUserIds.length === 0) {
      return res.json([]);
    }

    // 対象ユーザーの基本情報を取得
    const { data: members, error: memberError } = await supabase
      .from('basic_profile_info')
      .select('id, name_english, name_kanji, avatar_id')
      .in('id', memberUserIds)
      .order('name_english', { ascending: true });

    if (memberError) throw memberError;
    const memberList = members || [];

    // アバターURLの一括解決
    const avatarIds = memberList.map(m => m.avatar_id).filter(Boolean);
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

    const membersWithAvatars = await Promise.all(
      memberList.map(async (m) => {
        const key = m.avatar_id ? avatarPathMap[m.avatar_id] : null;
        const avatarUrl = key ? await getSignedFileUrl(key) : null;
        return {
          id: m.id,
          name_english: m.name_english,
          name_kanji: m.name_kanji,
          avatar_link: avatarUrl
        };
      })
    );

    // member_department_mappings から所属部署マッピングを取得
    const { data: deptMappings, error: deptMapError } = await supabase
      .from('member_department_mappings')
      .select('user_id, department_id')
      .in('user_id', memberUserIds);

    if (deptMapError) throw deptMapError;

    const userDeptsMap = new Map<string, string[]>();
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
  } catch (error: any) {
    console.error('部署メンバー取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. メンバーの部署更新 (洗い替え)
router.put('/members/:userId/departments', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { departmentIds } = req.body; // 部署IDの配列

    if (!Array.isArray(departmentIds)) {
      return res.status(400).json({ error: 'departmentIdsは配列である必要があります' });
    }

    // 既存マッピングを全削除
    const { error: deleteError } = await supabase
      .from('member_department_mappings')
      .delete()
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

    // 新規登録
    if (departmentIds.length > 0) {
      const inserts = departmentIds.map((deptId: string) => ({
        user_id: userId,
        department_id: deptId
      }));

      const { error: insertError } = await supabase
        .from('member_department_mappings')
        .insert(inserts);

      if (insertError) throw insertError;
    }

    res.json({ message: '部署を更新しました' });
  } catch (error: any) {
    console.error('メンバー部署更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// ------------------------------------------
// E. システム権限 CRUD
// ------------------------------------------

// 1. 権限一覧取得（カテゴリ情報結合）
router.get('/permissions', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    const { data: permissions, error } = await supabase
      .from('permissions')
      .select('*, permission_types(type, description)')
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(permissions || []);
  } catch (error: any) {
    console.error('権限一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. 権限カテゴリ（タイプ）一覧取得
router.get('/permission-types', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    const { data: types, error } = await supabase
      .from('permission_types')
      .select('*')
      .order('type', { ascending: true });

    if (error) throw error;
    res.json(types || []);
  } catch (error: any) {
    console.error('権限タイプ一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. 新規権限追加
router.post('/permissions', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, description, resource, action, type } = req.body;
    if (!name || !resource || !action || !type) {
      return res.status(400).json({ error: '必須項目が不足しています（name, resource, action, type）' });
    }

    const { data: newPerm, error } = await supabase
      .from('permissions')
      .insert({ name, description, resource, action, type })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(newPerm);
  } catch (error: any) {
    console.error('権限作成エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. 権限更新
router.patch('/permissions/:id', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, resource, action, type } = req.body;

    const { data: updatedPerm, error } = await supabase
      .from('permissions')
      .update({ name, description, resource, action, type })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json(updatedPerm);
  } catch (error: any) {
    console.error('権限更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. 権限削除
router.delete('/permissions/:id', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // マッピングレコードを削除
    const { error: mappingError } = await supabase
      .from('permission_mappings')
      .delete()
      .eq('permission_id', id);

    if (mappingError) throw mappingError;

    // 権限本体を削除
    const { error: permError } = await supabase
      .from('permissions')
      .delete()
      .eq('id', id);

    if (permError) throw permError;

    res.json({ message: '権限を削除しました' });
  } catch (error: any) {
    console.error('権限削除エラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// ------------------------------------------
// F. メンバーへの個別権限割り当て
// ------------------------------------------

// 1. メンバー一覧と直接付与されている権限（grantee_type = 'user'）の取得
router.get('/members/permissions', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    // smiring_member ロールを持つユーザーIDのリストを取得
    const { data: roleMappings, error: roleError } = await supabase
      .from('user_role_mappings')
      .select('user_id')
      .eq('user_role', ROLE_MEMBER);

    if (roleError) throw roleError;
    const memberUserIds = (roleMappings || []).map(rm => rm.user_id);

    if (memberUserIds.length === 0) {
      return res.json([]);
    }

    // 対象ユーザーの基本情報を取得
    const { data: members, error: memberError } = await supabase
      .from('basic_profile_info')
      .select('id, name_english, name_kanji, avatar_id')
      .in('id', memberUserIds)
      .order('name_english', { ascending: true });

    if (memberError) throw memberError;
    const memberList = members || [];

    // アバターURLの一括解決
    const avatarIds = memberList.map(m => m.avatar_id).filter(Boolean);
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

    const membersWithAvatars = await Promise.all(
      memberList.map(async (m) => {
        const key = m.avatar_id ? avatarPathMap[m.avatar_id] : null;
        const avatarUrl = key ? await getSignedFileUrl(key) : null;
        return {
          id: m.id,
          name_english: m.name_english,
          name_kanji: m.name_kanji,
          avatar_link: avatarUrl
        };
      })
    );

    // permission_mappings から直接付与されている権限マッピングを取得
    const { data: permMappings, error: permMapError } = await supabase
      .from('permission_mappings')
      .select('grantee_id, permission_id')
      .eq('grantee_type', 'user')
      .in('grantee_id', memberUserIds);

    if (permMapError) throw permMapError;

    const userPermsMap = new Map<string, string[]>();
    (permMappings || []).forEach(pm => {
      const list = userPermsMap.get(pm.grantee_id) || [];
      list.push(pm.permission_id);
      userPermsMap.set(pm.grantee_id, list);
    });

    const enrichedMembers = membersWithAvatars.map(m => ({
      ...m,
      permission_ids: userPermsMap.get(m.id) || []
    }));

    res.json(enrichedMembers);
  } catch (error: any) {
    console.error('メンバー権限取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. メンバーの個別権限更新 (洗い替え)
router.put('/members/:userId/permissions', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { permissionIds } = req.body; // 権限IDの配列

    if (!Array.isArray(permissionIds)) {
      return res.status(400).json({ error: 'permissionIdsは配列である必要があります' });
    }

    // 既存の直接付与（grantee_type = 'user'）マッピングを全削除
    const { error: deleteError } = await supabase
      .from('permission_mappings')
      .delete()
      .eq('grantee_type', 'user')
      .eq('grantee_id', userId);

    if (deleteError) throw deleteError;

    // 新規登録
    if (permissionIds.length > 0) {
      const inserts = permissionIds.map((permId: string) => ({
        grantee_type: 'user',
        grantee_id: userId,
        permission_id: permId
      }));

      const { error: insertError } = await supabase
        .from('permission_mappings')
        .insert(inserts);

      if (insertError) throw insertError;
    }

    res.json({ message: '権限を更新しました' });
  } catch (error: any) {
    console.error('メンバー権限更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. ロール別権限の取得
router.get('/roles/permissions', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    const { data: roles, error: rolesError } = await supabase
      .from('user_roles')
      .select('*')
      .not('id', 'in', `(${ROLE_PRE},${ROLE_CURRENT},${ROLE_POST},${ROLE_GUARDIAN})`)
      .order('created_at', { ascending: true });

    if (rolesError) throw rolesError;
    const roleList = roles || [];

    const roleIds = roleList.map(r => r.id);
    if (roleIds.length === 0) return res.json([]);

    const { data: mappings, error: mapError } = await supabase
      .from('permission_mappings')
      .select('grantee_id, permission_id')
      .eq('grantee_type', 'role')
      .in('grantee_id', roleIds);

    if (mapError) throw mapError;

    const rolePermsMap = new Map<string, string[]>();
    (mappings || []).forEach(m => {
      const list = rolePermsMap.get(m.grantee_id) || [];
      list.push(m.permission_id);
      rolePermsMap.set(m.grantee_id, list);
    });

    res.json(roleList.map(r => ({
      ...r,
      permission_ids: rolePermsMap.get(r.id) || []
    })));
  } catch (error: any) {
    console.error('ロール権限取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. ロール別権限の更新 (洗い替え)
router.put('/roles/:roleId/permissions', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { roleId } = req.params;
    const { permissionIds } = req.body;
    if (!Array.isArray(permissionIds)) {
      return res.status(400).json({ error: 'permissionIdsは配列である必要があります' });
    }

    const { error: deleteError } = await supabase
      .from('permission_mappings')
      .delete()
      .eq('grantee_type', 'role')
      .eq('grantee_id', roleId);

    if (deleteError) throw deleteError;

    if (permissionIds.length > 0) {
      const inserts = permissionIds.map((pId: string) => ({
        grantee_type: 'role',
        grantee_id: roleId,
        permission_id: pId
      }));
      const { error: insertError } = await supabase.from('permission_mappings').insert(inserts);
      if (insertError) throw insertError;
    }
    res.json({ message: 'ロールの権限を更新しました' });
  } catch (error: any) {
    console.error('ロール権限更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. 部署別権限の取得
router.get('/departments/permissions', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    const { data: depts, error: deptsError } = await supabase
      .from('departments')
      .select('*')
      .order('name', { ascending: true });

    if (deptsError) throw deptsError;
    const deptList = depts || [];

    const deptIds = deptList.map(d => d.id);
    if (deptIds.length === 0) return res.json([]);

    const { data: mappings, error: mapError } = await supabase
      .from('permission_mappings')
      .select('grantee_id, permission_id')
      .eq('grantee_type', 'department')
      .in('grantee_id', deptIds);

    if (mapError) throw mapError;

    const deptPermsMap = new Map<string, string[]>();
    (mappings || []).forEach(m => {
      const list = deptPermsMap.get(m.grantee_id) || [];
      list.push(m.permission_id);
      deptPermsMap.set(m.grantee_id, list);
    });

    res.json(deptList.map(d => ({
      ...d,
      permission_ids: deptPermsMap.get(d.id) || []
    })));
  } catch (error: any) {
    console.error('部署権限取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. 部署別権限の更新 (洗い替え)
router.put('/departments/:departmentId/permissions', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { departmentId } = req.params;
    const { permissionIds } = req.body;
    if (!Array.isArray(permissionIds)) {
      return res.status(400).json({ error: 'permissionIdsは配列である必要があります' });
    }

    const { error: deleteError } = await supabase
      .from('permission_mappings')
      .delete()
      .eq('grantee_type', 'department')
      .eq('grantee_id', departmentId);

    if (deleteError) throw deleteError;

    if (permissionIds.length > 0) {
      const inserts = permissionIds.map((pId: string) => ({
        grantee_type: 'department',
        grantee_id: departmentId,
        permission_id: pId
      }));
      const { error: insertError } = await supabase.from('permission_mappings').insert(inserts);
      if (insertError) throw insertError;
    }
    res.json({ message: '部署の権限を更新しました' });
  } catch (error: any) {
    console.error('部署権限更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 7. グループ別権限の取得
router.get('/groups/permissions', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    const { data: groups, error: groupsError } = await supabase
      .from('groups')
      .select('*')
      .is('deleted_at', null)
      .order('name', { ascending: true });

    if (groupsError) throw groupsError;
    const groupList = groups || [];

    const groupIds = groupList.map(g => g.id);
    if (groupIds.length === 0) return res.json([]);

    const { data: mappings, error: mapError } = await supabase
      .from('permission_mappings')
      .select('grantee_id, permission_id')
      .eq('grantee_type', 'group')
      .in('grantee_id', groupIds);

    if (mapError) throw mapError;

    const groupPermsMap = new Map<string, string[]>();
    (mappings || []).forEach(m => {
      const list = groupPermsMap.get(m.grantee_id) || [];
      list.push(m.permission_id);
      groupPermsMap.set(m.grantee_id, list);
    });

    res.json(groupList.map(g => ({
      ...g,
      permission_ids: groupPermsMap.get(g.id) || []
    })));
  } catch (error: any) {
    console.error('グループ権限取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 8. グループ別権限の更新 (洗い替え)
router.put('/groups/:groupId/permissions', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;
    const { permissionIds } = req.body;
    if (!Array.isArray(permissionIds)) {
      return res.status(400).json({ error: 'permissionIdsは配列である必要があります' });
    }

    const { error: deleteError } = await supabase
      .from('permission_mappings')
      .delete()
      .eq('grantee_type', 'group')
      .eq('grantee_id', groupId);

    if (deleteError) throw deleteError;

    if (permissionIds.length > 0) {
      const inserts = permissionIds.map((pId: string) => ({
        grantee_type: 'group',
        grantee_id: groupId,
        permission_id: pId
      }));
      const { error: insertError } = await supabase.from('permission_mappings').insert(inserts);
      if (insertError) throw insertError;
    }
    res.json({ message: 'グループの権限を更新しました' });
  } catch (error: any) {
    console.error('グループ権限更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// ------------------------------------------
// G. グループ管理 CRUD
// ------------------------------------------

// 1. グループ一覧取得
router.get('/groups', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('groups')
      .select('*')
      .is('deleted_at', null)
      .order('name', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (error: any) {
    console.error('グループ一覧取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. 新規グループ追加
router.post('/groups', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'グループ名は必須です' });
    const { data, error } = await supabase
      .from('groups')
      .insert({ name, description })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (error: any) {
    console.error('グループ作成エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. グループ更新
router.patch('/groups/:id', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const { data, error } = await supabase
      .from('groups')
      .update({ name, description })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error: any) {
    console.error('グループ更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. グループ削除 (ソフトデリート & 紐付けクリーンアップ)
router.delete('/groups/:id', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // 1. user_group_mappings から該当グループの紐付けを削除
    const { error: mapDelError } = await supabase
      .from('user_group_mappings')
      .delete()
      .eq('group_id', id);
    if (mapDelError) throw mapDelError;

    // 2. permission_mappings から該当グループの権限紐付け（grantee_type = 'group'）を削除
    const { error: permDelError } = await supabase
      .from('permission_mappings')
      .delete()
      .eq('grantee_type', 'group')
      .eq('grantee_id', id);
    if (permDelError) throw permDelError;

    // 3. groups 本体をソフトデリート (deleted_at に現在時刻を設定)
    const { error: groupError } = await supabase
      .from('groups')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (groupError) throw groupError;

    res.json({ message: 'グループを削除しました' });
  } catch (error: any) {
    console.error('グループ削除エラー:', error);
    res.status(500).json({ error: error.message });
  }
});


// ------------------------------------------
// H. メンバーのグループ割り当て
// ------------------------------------------

// 1. smiring_member ロールを持つメンバーと所属グループIDの取得
router.get('/members/groups', requirePermission('management', 'read'), async (_req: Request, res: Response) => {
  try {
    // smiring_member ロールを持つユーザーIDのリストを取得
    const { data: roleMappings, error: roleError } = await supabase
      .from('user_role_mappings')
      .select('user_id')
      .eq('user_role', ROLE_MEMBER);

    if (roleError) throw roleError;
    const memberUserIds = (roleMappings || []).map(rm => rm.user_id);

    if (memberUserIds.length === 0) {
      return res.json([]);
    }

    // 対象ユーザーの基本情報を取得
    const { data: members, error: memberError } = await supabase
      .from('basic_profile_info')
      .select('id, name_english, name_kanji, avatar_id')
      .in('id', memberUserIds)
      .order('name_english', { ascending: true });

    if (memberError) throw memberError;
    const memberList = members || [];

    // アバターURLの一括解決
    const avatarIds = memberList.map(m => m.avatar_id).filter(Boolean);
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

    const membersWithAvatars = await Promise.all(
      memberList.map(async (m) => {
        const key = m.avatar_id ? avatarPathMap[m.avatar_id] : null;
        const avatarUrl = key ? await getSignedFileUrl(key) : null;
        return {
          id: m.id,
          name_english: m.name_english,
          name_kanji: m.name_kanji,
          avatar_link: avatarUrl
        };
      })
    );

    // user_group_mappings からグループマッピングを取得
    const { data: groupMappings, error: groupMapError } = await supabase
      .from('user_group_mappings')
      .select('user_id, group_id')
      .in('user_id', memberUserIds);

    if (groupMapError) throw groupMapError;

    const userGroupsMap = new Map<string, string[]>();
    (groupMappings || []).forEach(gm => {
      const list = userGroupsMap.get(gm.user_id) || [];
      list.push(gm.group_id);
      userGroupsMap.set(gm.user_id, list);
    });

    const enrichedMembers = membersWithAvatars.map(m => ({
      ...m,
      group_ids: userGroupsMap.get(m.id) || []
    }));

    res.json(enrichedMembers);
  } catch (error: any) {
    console.error('グループメンバー取得エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. メンバーのグループ更新 (洗い替え)
router.put('/members/:userId/groups', requirePermission('management', 'write'), async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { groupIds } = req.body; // グループIDの配列

    if (!Array.isArray(groupIds)) {
      return res.status(400).json({ error: 'groupIdsは配列である必要があります' });
    }

    // 既存マッピングを全削除
    const { error: deleteError } = await supabase
      .from('user_group_mappings')
      .delete()
      .eq('user_id', userId);

    if (deleteError) throw deleteError;

    // 新規登録
    if (groupIds.length > 0) {
      const inserts = groupIds.map((gId: string) => ({
        user_id: userId,
        group_id: gId
      }));

      const { error: insertError } = await supabase
        .from('user_group_mappings')
        .insert(inserts);

      if (insertError) throw insertError;
    }

    res.json({ message: 'グループを更新しました' });
  } catch (error: any) {
    console.error('メンバーグループ更新エラー:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
