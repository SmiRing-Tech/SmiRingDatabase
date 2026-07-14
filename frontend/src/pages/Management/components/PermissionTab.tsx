import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Edit2, Trash2, Users, Briefcase, User, Shield } from 'lucide-react';
import { apiClient } from '../../../lib/apiClient';
import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';

interface PermissionType {
  id: string;
  type: string;
  description: string;
}

interface Permission {
  id: string;
  name: string;
  description: string;
  resource: string;
  action: string;
  type: string; // permission_types.id
  permission_types?: {
    type: string;
    description: string;
  };
}

interface RoleItem {
  id: string;
  role_name: string;
  description: string;
  permission_ids: string[];
}

interface DepartmentItem {
  id: string;
  name: string;
  permission_ids: string[];
}

interface GroupItem {
  id: string;
  name: string;
  description: string;
  permission_ids: string[];
}

interface MemberPermissionItem {
  id: string;
  name_english: string;
  name_kanji: string;
  avatar_link: string | null;
  permission_ids: string[];
}

interface PermissionTabProps {
  onError: (msg: string) => void;
}

export default function PermissionTab({ onError }: PermissionTabProps) {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [permissionTypes, setPermissionTypes] = useState<PermissionType[]>([]);
  
  // Mapping lists
  const [rolesWithPerms, setRolesWithPerms] = useState<RoleItem[]>([]);
  const [departmentsWithPerms, setDepartmentsWithPerms] = useState<DepartmentItem[]>([]);
  const [groupsWithPerms, setGroupsWithPerms] = useState<GroupItem[]>([]);
  const [memberPermissions, setMemberPermissions] = useState<MemberPermissionItem[]>([]);

  const [activeSubTab, setActiveSubTab] = useState<'role' | 'department' | 'group' | 'user'>('role');
  const [isLoading, setIsLoading] = useState(false);

  const [editingPerm, setEditingPerm] = useState<Permission | null>(null);
  const [permForm, setPermForm] = useState({
    name: '',
    description: '',
    resource: '',
    action: 'read' as string,
    type: '',
  });
  const [isPermModalOpen, setIsPermModalOpen] = useState(false);

  const fetchData = async () => {
    setIsLoading(true);
    onError('');
    try {
      const [pRes, tRes, rRes, dRes, gRes, mRes] = await Promise.all([
        apiClient.get('/api/management/permissions'),
        apiClient.get('/api/management/permission-types'),
        apiClient.get('/api/management/roles/permissions'),
        apiClient.get('/api/management/departments/permissions'),
        apiClient.get('/api/management/groups/permissions'),
        apiClient.get('/api/management/members/permissions'),
      ]);

      if (pRes.ok && tRes.ok && rRes.ok && dRes.ok && gRes.ok && mRes.ok) {
        setPermissions(await pRes.json());
        setPermissionTypes(await tRes.json());
        setRolesWithPerms(await rRes.json());
        setDepartmentsWithPerms(await dRes.json());
        setGroupsWithPerms(await gRes.json());
        setMemberPermissions(await mRes.json());
      } else {
        onError('データの取得に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'データの取得に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleOpenPermModal = (perm?: Permission) => {
    if (perm) {
      setEditingPerm(perm);
      setPermForm({
        name: perm.name,
        description: perm.description || '',
        resource: perm.resource,
        action: perm.action,
        type: perm.type,
      });
    } else {
      setEditingPerm(null);
      setPermForm({
        name: '',
        description: '',
        resource: '',
        action: 'read',
        type: permissionTypes[0]?.id || '',
      });
    }
    setIsPermModalOpen(true);
  };

  const handleSavePerm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!permForm.name.trim() || !permForm.resource.trim() || !permForm.action.trim() || !permForm.type) {
      onError('必須項目を入力してください');
      return;
    }
    onError('');

    try {
      let res;
      if (editingPerm) {
        res = await apiClient.patch(`/api/management/permissions/${editingPerm.id}`, permForm);
      } else {
        res = await apiClient.post('/api/management/permissions', permForm);
      }

      if (res.ok) {
        setIsPermModalOpen(false);
        fetchData();
      } else {
        const data = await res.json();
        onError(data.error || '権限の保存に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || '権限の保存に失敗しました');
    }
  };

  const handleDeletePerm = async (id: string) => {
    if (!confirm('この権限を削除してもよろしいですか？紐付いていたすべての対象（ユーザー・ロール・部署・グループ）の権限情報も削除されます。')) return;
    onError('');

    try {
      const res = await apiClient.delete(`/api/management/permissions/${id}`);
      if (res.ok) {
        fetchData();
      } else {
        const data = await res.json();
        onError(data.error || '権限の削除に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || '権限の削除に失敗しました');
    }
  };

  // Mappings update handlers
  const handleRolePermChange = async (roleId: string, newPermIds: string[]) => {
    onError('');
    try {
      const res = await apiClient.put(`/api/management/roles/${roleId}/permissions`, {
        permissionIds: newPermIds,
      });
      if (res.ok) {
        setRolesWithPerms(prev =>
          prev.map(r => (r.id === roleId ? { ...r, permission_ids: newPermIds } : r))
        );
      } else {
        const data = await res.json();
        onError(data.error || 'ロールの権限更新に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'ロールの権限更新に失敗しました');
    }
  };

  const handleDeptPermChange = async (deptId: string, newPermIds: string[]) => {
    onError('');
    try {
      const res = await apiClient.put(`/api/management/departments/${deptId}/permissions`, {
        permissionIds: newPermIds,
      });
      if (res.ok) {
        setDepartmentsWithPerms(prev =>
          prev.map(d => (d.id === deptId ? { ...d, permission_ids: newPermIds } : d))
        );
      } else {
        const data = await res.json();
        onError(data.error || '部署の権限更新に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || '部署の権限更新に失敗しました');
    }
  };

  const handleGroupPermChange = async (groupId: string, newPermIds: string[]) => {
    onError('');
    try {
      const res = await apiClient.put(`/api/management/groups/${groupId}/permissions`, {
        permissionIds: newPermIds,
      });
      if (res.ok) {
        setGroupsWithPerms(prev =>
          prev.map(g => (g.id === groupId ? { ...g, permission_ids: newPermIds } : g))
        );
      } else {
        const data = await res.json();
        onError(data.error || 'グループの権限更新に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'グループの権限更新に失敗しました');
    }
  };

  const handleMemberPermChange = async (userId: string, newPermIds: string[]) => {
    onError('');
    try {
      const res = await apiClient.put(`/api/management/members/${userId}/permissions`, {
        permissionIds: newPermIds,
      });
      if (res.ok) {
        setMemberPermissions(prev =>
          prev.map(m => (m.id === userId ? { ...m, permission_ids: newPermIds } : m))
        );
      } else {
        const data = await res.json();
        onError(data.error || 'メンバーの権限更新に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'メンバーの権限更新に失敗しました');
    }
  };

  const permDropdownOptions = useMemo<DropdownOption[]>(() => {
    return permissions.map(p => ({
      label: `${p.name} (${p.permission_types?.type || '未分類'})`,
      value: p.id,
    }));
  }, [permissions]);

  if (isLoading && permissions.length === 0) {
    return <div className="text-center py-10 text-gray-500 font-bold">データをロード中...</div>;
  }

  return (
    <div className="space-y-10">
      {/* 上部: 権限定義マスタ */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl font-black text-gray-900">システム権限一覧</h2>
            <p className="text-xs text-gray-400 font-semibold mt-1">
              各機能やモジュールに対するアクセス権限を定義します。
            </p>
          </div>
          <button
            onClick={() => handleOpenPermModal()}
            className="flex items-center justify-center gap-2 py-2.5 px-4 bg-sky-500 hover:bg-sky-600 text-white rounded-xl font-black text-sm shadow-sm transition-all animate-in fade-in"
          >
            <Plus className="w-4 h-4" />
            <span>権限追加</span>
          </button>
        </div>

        {permissions.length === 0 ? (
          <div className="text-center py-12 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
            登録されている権限がありません。
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {permissions.map(perm => (
              <div
                key={perm.id}
                className="group flex flex-col md:flex-row md:items-center justify-between gap-3 p-3.5 bg-slate-50/30 hover:bg-slate-50 border border-slate-100 hover:border-slate-200 rounded-2xl transition-all"
              >
                <div className="flex flex-col md:flex-row md:items-center gap-3 flex-1 min-w-0">
                  {/* カテゴリ & アクションバッジ & 権限名 */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <span className="text-[10px] bg-slate-200 text-slate-700 font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">
                      {perm.permission_types?.type || '未分類'}
                    </span>
                    <span className="text-[10px] bg-sky-100 text-sky-700 font-bold px-2 py-0.5 rounded-full tracking-wider">
                      {perm.resource}:{perm.action}
                    </span>
                    <h3 className="text-sm font-black text-gray-900 group-hover:text-sky-600 transition-colors ml-1">
                      {perm.name}
                    </h3>
                  </div>

                  {/* 説明文 (横並び) */}
                  {perm.description && (
                    <span className="text-xs text-gray-400 font-semibold truncate flex-1 min-w-0 md:border-l md:border-slate-200 md:pl-3">
                      {perm.description}
                    </span>
                  )}
                </div>

                {/* アクションボタン */}
                <div className="flex items-center justify-end gap-1 shrink-0 border-t md:border-t-0 border-slate-100/60 pt-2 md:pt-0">
                  <button
                    onClick={() => handleOpenPermModal(perm)}
                    className="p-1.5 hover:bg-white hover:text-sky-600 rounded-lg text-slate-400 hover:shadow-sm border border-transparent hover:border-slate-100 transition-all"
                    title="編集"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDeletePerm(perm.id)}
                    className="p-1.5 hover:bg-white hover:text-rose-600 rounded-lg text-slate-400 hover:shadow-sm border border-transparent hover:border-slate-100 transition-all"
                    title="削除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 下部: 権限アサインの分類別表示（サブタブ） */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-gray-900">権限の割り当て設定</h2>
            <p className="text-xs text-gray-400 font-semibold mt-1">
              各対象タイプ（ロール・部署・グループ・ユーザー）ごとに権限を割り当てます。
            </p>
          </div>
        </div>

        {/* サブタブバー */}
        <div className="flex border-b border-gray-100 mb-6 bg-slate-50/60 p-1 rounded-2xl border">
          <button
            onClick={() => setActiveSubTab('role')}
            className={`flex-1 py-2 px-4 rounded-xl font-black text-xs flex items-center justify-center gap-2 transition-all ${
              activeSubTab === 'role'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-100'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            <span>ロール別</span>
          </button>
          <button
            onClick={() => setActiveSubTab('department')}
            className={`flex-1 py-2 px-4 rounded-xl font-black text-xs flex items-center justify-center gap-2 transition-all ${
              activeSubTab === 'department'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-100'
            }`}
          >
            <Briefcase className="w-3.5 h-3.5" />
            <span>部署別</span>
          </button>
          <button
            onClick={() => setActiveSubTab('group')}
            className={`flex-1 py-2 px-4 rounded-xl font-black text-xs flex items-center justify-center gap-2 transition-all ${
              activeSubTab === 'group'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-100'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>グループ別</span>
          </button>
          <button
            onClick={() => setActiveSubTab('user')}
            className={`flex-1 py-2 px-4 rounded-xl font-black text-xs flex items-center justify-center gap-2 transition-all ${
              activeSubTab === 'user'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-100'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            <span>ユーザー別</span>
          </button>
        </div>

        {/* ロール別タブのコンテンツ */}
        {activeSubTab === 'role' && (
          <div className="space-y-3">
            {rolesWithPerms.length === 0 ? (
              <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
                ロールデータがありません。
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
                {rolesWithPerms.map(role => (
                  <div key={role.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-slate-50/30">
                    <div>
                      <div className="font-black text-gray-800 text-sm">{role.role_name}</div>
                      {role.description && (
                        <div className="text-[10px] text-gray-400 font-semibold mt-0.5">{role.description}</div>
                      )}
                    </div>
                    <div className="w-full sm:w-[360px]">
                      <CustomDropdown
                        multiple={true}
                        options={permDropdownOptions}
                        value={role.permission_ids}
                        onChange={(vals) => handleRolePermChange(role.id, vals as string[])}
                        placeholder="権限未設定"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 部署別タブのコンテンツ */}
        {activeSubTab === 'department' && (
          <div className="space-y-3">
            {departmentsWithPerms.length === 0 ? (
              <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
                部署データがありません。
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
                {departmentsWithPerms.map(dept => (
                  <div key={dept.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-slate-50/30">
                    <div>
                      <div className="font-black text-gray-800 text-sm">{dept.name}</div>
                    </div>
                    <div className="w-full sm:w-[360px]">
                      <CustomDropdown
                        multiple={true}
                        options={permDropdownOptions}
                        value={dept.permission_ids}
                        onChange={(vals) => handleDeptPermChange(dept.id, vals as string[])}
                        placeholder="権限未設定"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* グループ別タブのコンテンツ */}
        {activeSubTab === 'group' && (
          <div className="space-y-3">
            {groupsWithPerms.length === 0 ? (
              <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
                グループデータがありません。
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
                {groupsWithPerms.map(group => (
                  <div key={group.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-slate-50/30">
                    <div>
                      <div className="font-black text-gray-800 text-sm">{group.name}</div>
                      {group.description && (
                        <div className="text-[10px] text-gray-400 font-semibold mt-0.5">{group.description}</div>
                      )}
                    </div>
                    <div className="w-full sm:w-[360px]">
                      <CustomDropdown
                        multiple={true}
                        options={permDropdownOptions}
                        value={group.permission_ids}
                        onChange={(vals) => handleGroupPermChange(group.id, vals as string[])}
                        placeholder="権限未設定"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ユーザー別タブのコンテンツ */}
        {activeSubTab === 'user' && (
          <div className="space-y-3">
            {memberPermissions.length === 0 ? (
              <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
                表示対象となるメンバーがいません。
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
                {memberPermissions.map(member => (
                  <div key={member.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-slate-50/30">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-slate-100 flex-shrink-0 overflow-hidden border border-slate-200">
                        <img
                          src={member.avatar_link || '/assets/images/profile_photo_empty.png'}
                          alt={member.name_english}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div>
                        <div className="font-black text-gray-800 text-sm">
                          {member.name_english || member.id}
                        </div>
                        <div className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">
                          {member.name_kanji || '-'}
                        </div>
                      </div>
                    </div>

                    <div className="w-full sm:w-[360px]">
                      <CustomDropdown
                        multiple={true}
                        options={permDropdownOptions}
                        value={member.permission_ids}
                        onChange={(vals) => handleMemberPermChange(member.id, vals as string[])}
                        placeholder="個別権限なし"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 権限追加・編集モーダル */}
      {isPermModalOpen && (
        <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-[1px] flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white border rounded-3xl w-full max-w-xl p-6 shadow-2xl animate-in zoom-in-95 duration-150">
            <h3 className="text-lg font-black text-gray-900 mb-4">
              {editingPerm ? '権限の編集' : '新規権限の追加'}
            </h3>
            <form onSubmit={handleSavePerm} className="space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">権限名</label>
                <input
                  type="text"
                  required
                  placeholder="例: 会議作成・削除"
                  value={permForm.name}
                  onChange={e => setPermForm(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">カテゴリ（タイプ）</label>
                <select
                  value={permForm.type}
                  onChange={e => setPermForm(prev => ({ ...prev, type: e.target.value }))}
                  className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 bg-white transition-colors"
                >
                  {permissionTypes.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.type} ({t.description})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">リソース（resource）</label>
                  <input
                    type="text"
                    required
                    placeholder="例: meetings"
                    value={permForm.resource}
                    onChange={e => setPermForm(prev => ({ ...prev, resource: e.target.value }))}
                    className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">アクション（action）</label>
                  <select
                    value={permForm.action}
                    onChange={e => setPermForm(prev => ({ ...prev, action: e.target.value }))}
                    className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 bg-white transition-colors"
                  >
                    <option value="read">read</option>
                    <option value="write">write</option>
                    <option value="delete">delete</option>
                    <option value="admin">admin</option>
                    <option value="insert">insert</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">説明</label>
                <textarea
                  placeholder="権限の具体的な用途・影響範囲など"
                  value={permForm.description}
                  onChange={e => setPermForm(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 transition-colors min-h-[80px]"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsPermModalOpen(false)}
                  className="py-2.5 px-5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-black text-sm transition-all"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="py-2.5 px-5 bg-sky-500 hover:bg-sky-600 text-white rounded-xl font-black text-sm shadow-sm transition-all"
                >
                  保存する
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
