import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Edit2, Trash2 } from 'lucide-react';
import { apiClient } from '../../../lib/apiClient';
import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';
import RichTextEditor from '../../../components/ui/RichTextEditor';

interface Role {
  id: string;
  role_name: string;
  description: string;
}

interface MemberRoleItem {
  id: string;
  name_english: string;
  name_kanji: string;
  avatar_link: string | null;
  role_ids: string[];
}

interface UserRoleTabProps {
  onError: (msg: string) => void;
}

export default function UserRoleTab({ onError }: UserRoleTabProps) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [memberRoles, setMemberRoles] = useState<MemberRoleItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [roleForm, setRoleForm] = useState({ role_name: '', description: '' });
  const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);

  const fetchRolesData = async () => {
    setIsLoading(true);
    onError('');
    try {
      const [rRes, mRes] = await Promise.all([
        apiClient.get('/api/management/roles'),
        apiClient.get('/api/management/members')
      ]);
      if (rRes.ok && mRes.ok) {
        setRoles(await rRes.json());
        setMemberRoles(await mRes.json());
      } else {
        onError('ロールデータの取得に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'データの取得に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRolesData();
  }, []);

  const handleOpenRoleModal = (role?: Role) => {
    if (role) {
      setEditingRole(role);
      setRoleForm({ role_name: role.role_name, description: role.description || '' });
    } else {
      setEditingRole(null);
      setRoleForm({ role_name: '', description: '' });
    }
    setIsRoleModalOpen(true);
  };

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleForm.role_name.trim()) return;
    onError('');

    try {
      let res;
      if (editingRole) {
        res = await apiClient.patch(`/api/management/roles/${editingRole.id}`, roleForm);
      } else {
        res = await apiClient.post('/api/management/roles', roleForm);
      }

      if (res.ok) {
        setIsRoleModalOpen(false);
        fetchRolesData();
      } else {
        const data = await res.json();
        onError(data.error || 'ロールの保存に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'ロールの保存に失敗しました');
    }
  };

  const handleDeleteRole = async (id: string) => {
    if (!confirm('このロールを削除してもよろしいですか？紐付いていたメンバーの権限情報も削除されます。')) return;
    onError('');

    try {
      const res = await apiClient.delete(`/api/management/roles/${id}`);
      if (res.ok) {
        fetchRolesData();
      } else {
        const data = await res.json();
        onError(data.error || 'ロールの削除に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'ロールの削除に失敗しました');
    }
  };

  const handleMemberRoleChange = async (userId: string, newRoleIds: string[]) => {
    onError('');
    try {
      const res = await apiClient.put(`/api/management/members/${userId}/roles`, { roleIds: newRoleIds });
      if (res.ok) {
        setMemberRoles(prev => 
          prev.map(m => m.id === userId ? { ...m, role_ids: newRoleIds } : m)
        );
      } else {
        const data = await res.json();
        onError(data.error || 'メンバーのロール更新に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'メンバーのロール更新に失敗しました');
    }
  };

  const roleDropdownOptions = useMemo<DropdownOption[]>(() => {
    return roles.map(r => ({
      label: r.role_name,
      value: r.id,
      description: r.description ? r.description.replace(/<[^>]*>/g, '') : undefined
    }));
  }, [roles]);

  if (isLoading) {
    return <div className="text-center py-10 text-gray-500 font-bold">ロールデータをロード中...</div>;
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-200">
      {/* 上部: ロールマスタ一覧 */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-black text-gray-900">ロール定義マスタ</h2>
            <p className="text-xs text-gray-400 font-semibold mt-1">
              システムで使用するユーザー役割（管理者・一般メンバー等）を定義・編集します。
            </p>
          </div>
          <button
            onClick={() => handleOpenRoleModal()}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-sky-500 hover:bg-sky-600 text-white font-bold text-sm rounded-xl shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>ロール追加</span>
          </button>
        </div>

        {roles.length === 0 ? (
          <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
            登録されているシステム用ロールがありません。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-gray-100 text-gray-400 font-bold text-xs uppercase tracking-wider">
                  <th className="py-3 px-4">ロール名</th>
                  <th className="py-3 px-4">説明</th>
                  <th className="py-3 px-4 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 text-sm">
                {roles.map(role => (
                  <tr key={role.id} className="hover:bg-slate-50/40">
                    <td className="py-4 px-4 font-black text-gray-800">{role.role_name}</td>
                    <td className="py-4 px-4 text-gray-400 max-w-lg truncate">
                      <div 
                        className="line-clamp-1"
                        dangerouslySetInnerHTML={{ __html: role.description || '<span class="italic text-gray-300">説明なし</span>' }} 
                      />
                    </td>
                    <td className="py-4 px-4 text-right">
                      <div className="inline-flex gap-2">
                        <button
                          onClick={() => handleOpenRoleModal(role)}
                          className="p-2 text-gray-400 hover:text-sky-600 hover:bg-sky-50 rounded-lg transition-colors"
                          title="編集"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteRole(role.id)}
                          className="p-2 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          title="削除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 下部: メンバーとロール紐付け一覧 */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="mb-6">
          <h2 className="text-xl font-black text-gray-900">メンバーへのロール割り当て</h2>
          <p className="text-xs text-gray-400 font-semibold mt-1">
            登録されているメンバーにユーザーロールを割り当てます。複数選択が可能です。
          </p>
        </div>

        <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
          {memberRoles.map(member => (
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
              
              <div className="w-full sm:w-[320px]">
                <CustomDropdown
                  multiple={true}
                  options={roleDropdownOptions}
                  value={member.role_ids}
                  onChange={(vals) => handleMemberRoleChange(member.id, vals as string[])}
                  placeholder="ロールなし"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ロール追加・編集モーダル */}
      {isRoleModalOpen && (
        <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-[1px] flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white border rounded-3xl w-full max-w-xl p-6 shadow-2xl">
            <h3 className="text-lg font-black text-gray-900 mb-4">
              {editingRole ? 'ロール定義の編集' : '新規ロール定義の追加'}
            </h3>
            <form onSubmit={handleSaveRole} className="space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">ロール名 (英語名/一意)</label>
                <input
                  type="text"
                  required
                  placeholder="例: smiring_member"
                  value={roleForm.role_name}
                  onChange={(e) => setRoleForm(prev => ({ ...prev, role_name: e.target.value }))}
                  className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-gray-700 font-semibold"
                />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">説明</label>
                <div className="border border-gray-300 rounded-xl overflow-hidden max-h-[300px] overflow-y-auto">
                  <RichTextEditor
                    value={roleForm.description}
                    onChange={(val) => setRoleForm(prev => ({ ...prev, description: val }))}
                    placeholder="ロールの役割やアクセス権限の説明文を入力..."
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsRoleModalOpen(false)}
                  className="px-4 py-2.5 bg-gray-50 border border-gray-200 hover:border-gray-300 text-gray-600 font-bold text-sm rounded-xl"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="px-4 py-2.5 bg-sky-500 hover:bg-sky-600 text-white font-bold text-sm rounded-xl shadow-sm"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
