import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Edit2, Trash2 } from 'lucide-react';
import { apiClient } from '../../../lib/apiClient';
import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';

interface Group {
  id: string;
  name: string;
  description: string;
}

interface MemberGroupItem {
  id: string;
  name_english: string;
  name_kanji: string;
  avatar_link: string | null;
  group_ids: string[];
}

interface GroupTabProps {
  onError: (msg: string) => void;
}

export default function GroupTab({ onError }: GroupTabProps) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [memberGroups, setMemberGroups] = useState<MemberGroupItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [groupForm, setGroupForm] = useState({ name: '', description: '' });
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);

  const fetchGroupsData = async () => {
    setIsLoading(true);
    onError('');
    try {
      const [gRes, mRes] = await Promise.all([
        apiClient.get('/api/management/groups'),
        apiClient.get('/api/management/members/groups')
      ]);
      if (gRes.ok && mRes.ok) {
        setGroups(await gRes.json());
        setMemberGroups(await mRes.json());
      } else {
        onError('グループデータの取得に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'データの取得に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchGroupsData();
  }, []);

  const handleOpenGroupModal = (group?: Group) => {
    if (group) {
      setEditingGroup(group);
      setGroupForm({ 
        name: group.name, 
        description: group.description || ''
      });
    } else {
      setEditingGroup(null);
      setGroupForm({ name: '', description: '' });
    }
    setIsGroupModalOpen(true);
  };

  const handleSaveGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupForm.name.trim()) return;
    onError('');

    try {
      let res;
      if (editingGroup) {
        res = await apiClient.patch(`/api/management/groups/${editingGroup.id}`, groupForm);
      } else {
        res = await apiClient.post('/api/management/groups', groupForm);
      }

      if (res.ok) {
        setIsGroupModalOpen(false);
        fetchGroupsData();
      } else {
        const data = await res.json();
        onError(data.error || 'グループの保存に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'グループの保存に失敗しました');
    }
  };

  const handleDeleteGroup = async (id: string) => {
    if (!confirm('このグループを削除してもよろしいですか？紐付いていたメンバーの所属グループマッピングや、グループ用権限も削除されます。')) return;
    onError('');

    try {
      const res = await apiClient.delete(`/api/management/groups/${id}`);
      if (res.ok) {
        fetchGroupsData();
      } else {
        const data = await res.json();
        onError(data.error || 'グループの削除に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'グループの削除に失敗しました');
    }
  };

  const handleMemberGroupChange = async (userId: string, newGroupIds: string[]) => {
    onError('');
    try {
      const res = await apiClient.put(`/api/management/members/${userId}/groups`, {
        groupIds: newGroupIds
      });
      if (res.ok) {
        setMemberGroups(prev =>
          prev.map(m => (m.id === userId ? { ...m, group_ids: newGroupIds } : m))
        );
      } else {
        const data = await res.json();
        onError(data.error || 'メンバーのグループ更新に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'メンバーのグループ更新に失敗しました');
    }
  };

  const groupDropdownOptions = useMemo<DropdownOption[]>(() => {
    return groups.map(g => ({
      label: g.name,
      value: g.id
    }));
  }, [groups]);

  if (isLoading && groups.length === 0) {
    return <div className="text-center py-10 text-gray-500 font-bold">グループデータをロード中...</div>;
  }

  return (
    <div className="space-y-10">
      {/* 上部: グループ一覧 */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl font-black text-gray-900">グループ一覧</h2>
            <p className="text-xs text-gray-400 font-semibold mt-1">
              学内組織・タスクフォースやプロジェクトチームなどを定義・管理します。
            </p>
          </div>
          <button
            onClick={() => handleOpenGroupModal()}
            className="flex items-center justify-center gap-2 py-2.5 px-4 bg-sky-500 hover:bg-sky-600 text-white rounded-xl font-black text-sm shadow-sm transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>グループ追加</span>
          </button>
        </div>

        {groups.length === 0 ? (
          <div className="text-center py-12 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
            登録されているグループがありません。
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {groups.map(group => (
              <div
                key={group.id}
                className="group flex flex-col md:flex-row md:items-center justify-between gap-3 p-3.5 bg-slate-50/30 hover:bg-slate-50 border border-slate-100 hover:border-slate-200 rounded-2xl transition-all"
              >
                <div className="flex flex-col md:flex-row md:items-center gap-3 flex-1 min-w-0">
                  <h3 className="text-sm font-black text-gray-900 group-hover:text-sky-600 transition-colors ml-1 shrink-0">
                    {group.name}
                  </h3>
                  {group.description && (
                    <span className="text-xs text-gray-400 font-semibold truncate flex-1 min-w-0 md:border-l md:border-slate-200 md:pl-3">
                      {group.description}
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-end gap-1 shrink-0 border-t md:border-t-0 border-slate-100/60 pt-2 md:pt-0">
                  <button
                    onClick={() => handleOpenGroupModal(group)}
                    className="p-1.5 hover:bg-white hover:text-sky-600 rounded-lg text-slate-400 hover:shadow-sm border border-transparent hover:border-slate-100 transition-all"
                    title="編集"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDeleteGroup(group.id)}
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

      {/* 下部: メンバーとグループ紐付け一覧 */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="mb-6">
          <h2 className="text-xl font-black text-gray-900">メンバーへのグループ割り当て</h2>
          <p className="text-xs text-gray-400 font-semibold mt-1">
            所属するグループを選択します。※メンバーロールを持つユーザーのみが表示されます。複数選択が可能です。
          </p>
        </div>

        {memberGroups.length === 0 ? (
          <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
            表示対象となるメンバーがいません。
          </div>
        ) : (
          <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
            {memberGroups.map(member => (
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
                    options={groupDropdownOptions}
                    value={member.group_ids}
                    onChange={(vals) => handleMemberGroupChange(member.id, vals as string[])}
                    placeholder="グループ未設定"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* グループ追加・編集モーダル */}
      {isGroupModalOpen && (
        <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-[1px] flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white border rounded-3xl w-full max-w-xl p-6 shadow-2xl animate-in zoom-in-95 duration-150">
            <h3 className="text-lg font-black text-gray-900 mb-4">
              {editingGroup ? 'グループの編集' : '新規グループの追加'}
            </h3>
            <form onSubmit={handleSaveGroup} className="space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">グループ名</label>
                <input
                  type="text"
                  required
                  placeholder="例: 幹部メンバー, 進学サポーター"
                  value={groupForm.name}
                  onChange={e => setGroupForm(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">説明</label>
                <textarea
                  placeholder="グループの用途、参加条件など"
                  value={groupForm.description}
                  onChange={e => setGroupForm(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full p-3 border border-slate-200 rounded-xl text-sm font-semibold outline-none focus:border-sky-500 transition-colors min-h-[80px]"
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsGroupModalOpen(false)}
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
