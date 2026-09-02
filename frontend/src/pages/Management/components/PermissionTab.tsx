import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Edit2, Trash2, Users, Briefcase, User, Shield, Search, Tags, X, Layers } from 'lucide-react';
import { apiClient } from '../../../lib/apiClient';
import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';

interface PermissionType {
  id: string;
  type: string;
  description: string | null;
  created_at?: string;
  updated_at?: string;
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
    description: string | null;
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

const ACTION_OPTIONS: DropdownOption[] = [
  { label: 'read (閲覧)', value: 'read' },
  { label: 'write (作成・編集)', value: 'write' },
  { label: 'delete (削除)', value: 'delete' },
  { label: 'admin (管理者権限)', value: 'admin' },
  { label: 'insert (作成のみ)', value: 'insert' },
];

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

  // 検索・フィルター用ステート
  const [typeSearchQuery, setTypeSearchQuery] = useState('');
  const [permSearchQuery, setPermSearchQuery] = useState('');
  const [permTypeFilter, setPermTypeFilter] = useState('all');
  const [assignSearchQuery, setAssignSearchQuery] = useState('');
  const [userPermFilter, setUserPermFilter] = useState<'all' | 'assigned' | 'unassigned'>('all');

  // 権限タイプ モーダル用ステート
  const [editingType, setEditingType] = useState<PermissionType | null>(null);
  const [typeForm, setTypeForm] = useState({
    type: '',
    description: '',
  });
  const [isTypeModalOpen, setIsTypeModalOpen] = useState(false);

  // システム権限 モーダル用ステート
  const [editingPerm, setEditingPerm] = useState<Permission | null>(null);
  const [permForm, setPermForm] = useState({
    name: '',
    description: '',
    resource: '',
    action: 'read',
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

  // --- 権限タイプ 操作ハンドラー ---
  const handleOpenTypeModal = (pType?: PermissionType) => {
    if (pType) {
      setEditingType(pType);
      setTypeForm({
        type: pType.type,
        description: pType.description || '',
      });
    } else {
      setEditingType(null);
      setTypeForm({
        type: '',
        description: '',
      });
    }
    setIsTypeModalOpen(true);
  };

  const handleSaveType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!typeForm.type.trim()) {
      onError('タイプ名を入力してください');
      return;
    }
    onError('');

    try {
      let res;
      if (editingType) {
        res = await apiClient.patch(`/api/management/permission-types/${editingType.id}`, typeForm);
      } else {
        res = await apiClient.post('/api/management/permission-types', typeForm);
      }

      if (res.ok) {
        setIsTypeModalOpen(false);
        fetchData();
      } else {
        const data = await res.json();
        onError(data.error || '権限タイプの保存に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || '権限タイプの保存に失敗しました');
    }
  };

  const handleDeleteType = async (id: string) => {
    if (!confirm('この権限タイプを削除してもよろしいですか？')) return;
    onError('');

    try {
      const res = await apiClient.delete(`/api/management/permission-types/${id}`);
      if (res.ok) {
        fetchData();
      } else {
        const data = await res.json();
        onError(data.error || '権限タイプの削除に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || '権限タイプの削除に失敗しました');
    }
  };

  // --- システム権限 操作ハンドラー ---
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

  // --- 権限アサイン更新ハンドラー ---
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

  // --- ドロップダウン用オプション ---
  const typeDropdownOptions = useMemo<DropdownOption[]>(() => {
    return permissionTypes.map(t => ({
      label: t.type,
      value: t.id,
      description: t.description || undefined,
    }));
  }, [permissionTypes]);

  const permFilterOptions = useMemo<DropdownOption[]>(() => {
    return [
      { label: 'すべてのタイプ', value: 'all' },
      ...permissionTypes.map(t => ({
        label: t.type,
        value: t.id,
      })),
    ];
  }, [permissionTypes]);

  const permDropdownOptions = useMemo<DropdownOption[]>(() => {
    return permissions.map(p => ({
      label: `${p.name} (${p.permission_types?.type || '未分類'})`,
      value: p.id,
      description: `${p.resource}:${p.action}${p.description ? ` - ${p.description}` : ''}`,
    }));
  }, [permissions]);

  const userPermFilterOptions: DropdownOption[] = [
    { label: 'すべてのユーザー', value: 'all' },
    { label: '個別権限あり', value: 'assigned' },
    { label: '個別権限なし', value: 'unassigned' },
  ];

  // --- フィルタリング ---
  const filteredTypes = useMemo(() => {
    if (!typeSearchQuery.trim()) return permissionTypes;
    const q = typeSearchQuery.toLowerCase();
    return permissionTypes.filter(t => 
      t.type.toLowerCase().includes(q) || 
      (t.description && t.description.toLowerCase().includes(q))
    );
  }, [permissionTypes, typeSearchQuery]);

  const filteredPermissions = useMemo(() => {
    return permissions.filter(p => {
      // タイプフィルター
      if (permTypeFilter !== 'all' && p.type !== permTypeFilter) {
        return false;
      }
      // 検索クエリ
      if (!permSearchQuery.trim()) return true;
      const q = permSearchQuery.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.resource.toLowerCase().includes(q) ||
        p.action.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.permission_types?.type && p.permission_types.type.toLowerCase().includes(q))
      );
    });
  }, [permissions, permSearchQuery, permTypeFilter]);

  const filteredRoles = useMemo(() => {
    if (!assignSearchQuery.trim()) return rolesWithPerms;
    const q = assignSearchQuery.toLowerCase();
    return rolesWithPerms.filter(r =>
      r.role_name.toLowerCase().includes(q) ||
      (r.description && r.description.toLowerCase().includes(q))
    );
  }, [rolesWithPerms, assignSearchQuery]);

  const filteredDepartments = useMemo(() => {
    if (!assignSearchQuery.trim()) return departmentsWithPerms;
    const q = assignSearchQuery.toLowerCase();
    return departmentsWithPerms.filter(d =>
      d.name.toLowerCase().includes(q)
    );
  }, [departmentsWithPerms, assignSearchQuery]);

  const filteredGroups = useMemo(() => {
    if (!assignSearchQuery.trim()) return groupsWithPerms;
    const q = assignSearchQuery.toLowerCase();
    return groupsWithPerms.filter(g =>
      g.name.toLowerCase().includes(q) ||
      (g.description && g.description.toLowerCase().includes(q))
    );
  }, [groupsWithPerms, assignSearchQuery]);

  const filteredMembers = useMemo(() => {
    return memberPermissions.filter(m => {
      // 権限有無フィルター
      if (userPermFilter === 'assigned' && m.permission_ids.length === 0) return false;
      if (userPermFilter === 'unassigned' && m.permission_ids.length > 0) return false;

      // 検索クエリ
      if (!assignSearchQuery.trim()) return true;
      const q = assignSearchQuery.toLowerCase();
      return (
        (m.name_english && m.name_english.toLowerCase().includes(q)) ||
        (m.name_kanji && m.name_kanji.toLowerCase().includes(q)) ||
        m.id.toLowerCase().includes(q)
      );
    });
  }, [memberPermissions, assignSearchQuery, userPermFilter]);

  if (isLoading && permissions.length === 0 && permissionTypes.length === 0) {
    return <div className="text-center py-10 text-gray-500 font-bold">データをロード中...</div>;
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-200">
      {/* 1. 最上部: 権限タイプ一覧 (permission_types) */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-sky-50 text-sky-600 rounded-2xl">
              <Tags className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-black text-gray-900">権限タイプ一覧</h2>
              <p className="text-xs text-gray-400 font-semibold mt-0.5">
                権限を大まかに分類するためのカテゴリ・種別を定義します。
              </p>
            </div>
          </div>
          <button
            onClick={() => handleOpenTypeModal()}
            className="flex items-center justify-center gap-2 py-2.5 px-4 bg-sky-500 hover:bg-sky-600 text-white rounded-xl font-black text-sm shadow-sm transition-all shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>タイプ追加</span>
          </button>
        </div>

        {/* 検索バー */}
        <div className="mb-4">
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="権限タイプ名や説明で検索..."
              value={typeSearchQuery}
              onChange={e => setTypeSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-gray-700 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-sky-400 focus:ring-2 focus:ring-sky-500/10 transition-all"
            />
            {typeSearchQuery && (
              <button
                onClick={() => setTypeSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {filteredTypes.length === 0 ? (
          <div className="text-center py-10 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
            {typeSearchQuery ? '該当する権限タイプが見つかりません。' : '登録されている権限タイプがありません。'}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredTypes.map(t => (
              <div
                key={t.id}
                className="group flex flex-col justify-between p-4 bg-slate-50/40 hover:bg-slate-50 border border-slate-100 hover:border-slate-200 rounded-2xl transition-all"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="font-black text-gray-900 text-sm group-hover:text-sky-600 transition-colors">
                      {t.type}
                    </span>
                    <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleOpenTypeModal(t)}
                        className="p-1.5 hover:bg-white hover:text-sky-600 rounded-lg text-slate-400 hover:shadow-sm border border-transparent hover:border-slate-100 transition-all"
                        title="編集"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteType(t.id)}
                        className="p-1.5 hover:bg-white hover:text-rose-600 rounded-lg text-slate-400 hover:shadow-sm border border-transparent hover:border-slate-100 transition-all"
                        title="削除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 font-semibold line-clamp-2">
                    {t.description || <span className="italic text-gray-300">説明なし</span>}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 2. 中段: システム権限一覧 (permissions) */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-sky-50 text-sky-600 rounded-2xl">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-black text-gray-900">システム権限一覧</h2>
              <p className="text-xs text-gray-400 font-semibold mt-0.5">
                各機能やモジュールに対する個別アクセス権限を定義します。
              </p>
            </div>
          </div>
          <button
            onClick={() => handleOpenPermModal()}
            className="flex items-center justify-center gap-2 py-2.5 px-4 bg-sky-500 hover:bg-sky-600 text-white rounded-xl font-black text-sm shadow-sm transition-all shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>権限追加</span>
          </button>
        </div>

        {/* 検索・絞り込みフィルター */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="権限名・リソース・アクション・説明で検索..."
              value={permSearchQuery}
              onChange={e => setPermSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-gray-700 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-sky-400 focus:ring-2 focus:ring-sky-500/10 transition-all"
            />
            {permSearchQuery && (
              <button
                onClick={() => setPermSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="w-full sm:w-[220px]">
            <CustomDropdown
              multiple={false}
              options={permFilterOptions}
              value={permTypeFilter}
              onChange={val => setPermTypeFilter(val as string)}
              placeholder="タイプで絞り込み"
            />
          </div>
        </div>

        {filteredPermissions.length === 0 ? (
          <div className="text-center py-12 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
            {permSearchQuery || permTypeFilter !== 'all'
              ? '条件に一致する権限が見つかりません。'
              : '登録されている権限がありません。'}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {filteredPermissions.map(perm => (
              <div
                key={perm.id}
                className="group flex flex-col md:flex-row md:items-center justify-between gap-3 p-3.5 bg-slate-50/30 hover:bg-slate-50 border border-slate-100 hover:border-slate-200 rounded-2xl transition-all"
              >
                <div className="flex flex-col md:flex-row md:items-center gap-3 flex-1 min-w-0">
                  {/* カテゴリ & アクションバッジ & 権限名 */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <span className="text-[10px] bg-slate-200 text-slate-700 font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                      {perm.permission_types?.type || '未分類'}
                    </span>
                    <span className="text-[10px] bg-sky-100 text-sky-700 font-bold px-2.5 py-0.5 rounded-full tracking-wider">
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

      {/* 3. 下段: 権限アサインの分類別表示（サブタブ） */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-2xl">
              <Layers className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-black text-gray-900">権限の割り当て設定</h2>
              <p className="text-xs text-gray-400 font-semibold mt-0.5">
                各対象タイプ（ロール・部署・グループ・ユーザー）ごとに権限を割り当てます。
              </p>
            </div>
          </div>
        </div>

        {/* サブタブバー */}
        <div className="flex border-b border-gray-100 mb-6 bg-slate-50/60 p-1 rounded-2xl border">
          <button
            onClick={() => {
              setActiveSubTab('role');
              setAssignSearchQuery('');
            }}
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
            onClick={() => {
              setActiveSubTab('department');
              setAssignSearchQuery('');
            }}
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
            onClick={() => {
              setActiveSubTab('group');
              setAssignSearchQuery('');
            }}
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
            onClick={() => {
              setActiveSubTab('user');
              setAssignSearchQuery('');
            }}
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

        {/* 検索バー＆フィルター（サブタブ共通） */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder={
                activeSubTab === 'role'
                  ? 'ロール名・説明で検索...'
                  : activeSubTab === 'department'
                  ? '部署名で検索...'
                  : activeSubTab === 'group'
                  ? 'グループ名・説明で検索...'
                  : 'メンバー名（英語・漢字）で検索...'
              }
              value={assignSearchQuery}
              onChange={e => setAssignSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-semibold text-gray-700 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-sky-400 focus:ring-2 focus:ring-sky-500/10 transition-all"
            />
            {assignSearchQuery && (
              <button
                onClick={() => setAssignSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {activeSubTab === 'user' && (
            <div className="w-full sm:w-[200px]">
              <CustomDropdown
                multiple={false}
                options={userPermFilterOptions}
                value={userPermFilter}
                onChange={val => setUserPermFilter(val as any)}
                placeholder="権限付与状態で絞り込み"
              />
            </div>
          )}
        </div>

        {/* ロール別タブのコンテンツ */}
        {activeSubTab === 'role' && (
          <div className="space-y-3">
            {filteredRoles.length === 0 ? (
              <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
                {assignSearchQuery ? '該当するロールが見つかりません。' : 'ロールデータがありません。'}
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
                {filteredRoles.map(role => (
                  <div key={role.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-slate-50/30">
                    <div>
                      <div className="font-black text-gray-800 text-sm">{role.role_name}</div>
                      {role.description && (
                        <div className="text-[10px] text-gray-400 font-semibold mt-0.5 line-clamp-1">{role.description.replace(/<[^>]*>/g, '')}</div>
                      )}
                    </div>
                    <div className="w-full sm:w-[360px]">
                      <CustomDropdown
                        multiple={true}
                        searchable={true}
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
            {filteredDepartments.length === 0 ? (
              <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
                {assignSearchQuery ? '該当する部署が見つかりません。' : '部署データがありません。'}
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
                {filteredDepartments.map(dept => (
                  <div key={dept.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-slate-50/30">
                    <div>
                      <div className="font-black text-gray-800 text-sm">{dept.name}</div>
                    </div>
                    <div className="w-full sm:w-[360px]">
                      <CustomDropdown
                        multiple={true}
                        searchable={true}
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
            {filteredGroups.length === 0 ? (
              <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
                {assignSearchQuery ? '該当するグループが見つかりません。' : 'グループデータがありません。'}
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
                {filteredGroups.map(group => (
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
                        searchable={true}
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
            {filteredMembers.length === 0 ? (
              <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
                {assignSearchQuery || userPermFilter !== 'all'
                  ? '該当するメンバーが見つかりません。'
                  : '表示対象となるメンバーがいません。'}
              </div>
            ) : (
              <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
                {filteredMembers.map(member => (
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
                        searchable={true}
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

      {/* 権限タイプ 追加・編集モーダル */}
      {isTypeModalOpen && (
        <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-[1px] flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white border rounded-3xl w-full max-w-lg p-6 shadow-2xl animate-in zoom-in-95 duration-150">
            <h3 className="text-lg font-black text-gray-900 mb-4">
              {editingType ? '権限タイプの編集' : '新規権限タイプの追加'}
            </h3>
            <form onSubmit={handleSaveType} className="space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">タイプ名（一意）</label>
                <input
                  type="text"
                  required
                  placeholder="例: meetings, system, users"
                  value={typeForm.type}
                  onChange={e => setTypeForm(prev => ({ ...prev, type: e.target.value }))}
                  className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">説明</label>
                <textarea
                  placeholder="この権限タイプがカバーする機能や領域の説明..."
                  value={typeForm.description}
                  onChange={e => setTypeForm(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 transition-colors min-h-[90px]"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsTypeModalOpen(false)}
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
                <CustomDropdown
                  multiple={false}
                  searchable={true}
                  options={typeDropdownOptions}
                  value={permForm.type}
                  onChange={val => setPermForm(prev => ({ ...prev, type: val as string }))}
                  placeholder="権限タイプを選択"
                />
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
                  <CustomDropdown
                    multiple={false}
                    options={ACTION_OPTIONS}
                    value={permForm.action}
                    onChange={val => setPermForm(prev => ({ ...prev, action: val as string }))}
                    placeholder="アクションを選択"
                  />
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
