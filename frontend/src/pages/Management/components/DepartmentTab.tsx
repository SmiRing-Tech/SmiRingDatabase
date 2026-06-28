import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Edit2, Trash2, GripVertical } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { apiClient } from '../../../lib/apiClient';
import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';

interface Department {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order?: number | null;
}

interface MemberDeptItem {
  id: string;
  name_english: string;
  name_kanji: string;
  avatar_link: string | null;
  department_ids: string[];
}

interface DepartmentTabProps {
  onError: (msg: string) => void;
}

export default function DepartmentTab({ onError }: DepartmentTabProps) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [memberDepts, setMemberDepts] = useState<MemberDeptItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [editingDept, setEditingDept] = useState<Department | null>(null);
  const [deptForm, setDeptForm] = useState({ name: '', parent_id: '' as string });
  const [isDeptModalOpen, setIsDeptModalOpen] = useState(false);

  const fetchDeptsData = async () => {
    setIsLoading(true);
    onError('');
    try {
      const [dRes, mdRes] = await Promise.all([
        apiClient.get('/api/management/departments'),
        apiClient.get('/api/management/members/departments')
      ]);
      if (dRes.ok && mdRes.ok) {
        setDepartments(await dRes.json());
        setMemberDepts(await mdRes.json());
      } else {
        onError('部署データの取得に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'データの取得に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDeptsData();
  }, []);

  const handleOpenDeptModal = (dept?: Department) => {
    if (dept) {
      setEditingDept(dept);
      setDeptForm({ 
        name: dept.name, 
        parent_id: dept.parent_id || ''
      });
    } else {
      setEditingDept(null);
      setDeptForm({ name: '', parent_id: '' });
    }
    setIsDeptModalOpen(true);
  };

  const handleSaveDept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deptForm.name.trim()) return;
    onError('');

    try {
      let res;
      if (editingDept) {
        res = await apiClient.patch(`/api/management/departments/${editingDept.id}`, deptForm);
      } else {
        res = await apiClient.post('/api/management/departments', deptForm);
      }

      if (res.ok) {
        setIsDeptModalOpen(false);
        fetchDeptsData();
      } else {
        const data = await res.json();
        onError(data.error || '部署の保存に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || '部署の保存に失敗しました');
    }
  };

  const handleDeleteDept = async (id: string) => {
    if (!confirm('この部署を削除してもよろしいですか？紐付いていたメンバーの所属マッピングも削除されます。')) return;
    onError('');

    try {
      const res = await apiClient.delete(`/api/management/departments/${id}`);
      if (res.ok) {
        fetchDeptsData();
      } else {
        const data = await res.json();
        onError(data.error || '部署の削除に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || '部署の削除に失敗しました');
    }
  };

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const { source, destination } = result;
    if (source.index === destination.index) return;

    // 即座にフロントエンド状態を更新して滑らかに見せる
    const reordered = Array.from(departments);
    const [moved] = reordered.splice(source.index, 1);
    reordered.splice(destination.index, 0, moved);

    // 新しいインデックスに基づいて sort_order を連番で再計算
    const updated = reordered.map((dept, idx) => ({
      ...dept,
      sort_order: idx + 1
    }));
    setDepartments(updated);

    // バックエンドへ順序の保存リクエスト
    onError('');
    try {
      const orders = updated.map(dept => ({
        id: dept.id,
        sort_order: dept.sort_order
      }));
      const res = await apiClient.put('/api/management/departments/reorder', { orders });
      if (!res.ok) {
        const data = await res.json();
        onError(data.error || '表示順の保存に失敗しました');
        fetchDeptsData(); // 失敗した場合は再取得してロールバック
      }
    } catch (err: any) {
      onError(err.message || '表示順の保存に失敗しました');
      fetchDeptsData();
    }
  };

  const handleMemberDeptChange = async (userId: string, newDeptIds: string[]) => {
    onError('');
    try {
      const res = await apiClient.put(`/api/management/members/${userId}/departments`, { departmentIds: newDeptIds });
      if (res.ok) {
        setMemberDepts(prev => 
          prev.map(m => m.id === userId ? { ...m, department_ids: newDeptIds } : m)
        );
      } else {
        const data = await res.json();
        onError(data.error || 'メンバーの部署更新に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'メンバーの部署更新に失敗しました');
    }
  };

  const deptDropdownOptions = useMemo<DropdownOption[]>(() => {
    return departments.map(d => ({
      label: d.name,
      value: d.id
    }));
  }, [departments]);

  const parentDeptOptions = useMemo<DropdownOption[]>(() => {
    const list = departments
      .filter(d => !editingDept || d.id !== editingDept.id)
      .map(d => ({
        label: d.name,
        value: d.id
      }));
    return [{ label: '親部署なし (最上位)', value: '' }, ...list];
  }, [departments, editingDept]);

  if (isLoading) {
    return <div className="text-center py-10 text-gray-500 font-bold">部署データをロード中...</div>;
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-200">
      {/* 上部: 部署定義マスタ */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h2 className="text-xl font-black text-gray-900">部署・チーム一覧</h2>
            <p className="text-xs text-gray-400 font-semibold mt-1">
              組織内の所属部署やチームを定義・管理します。親部署を設定して親子構造を作成することも可能です。
            </p>
          </div>
          <button
            onClick={() => handleOpenDeptModal()}
            className="flex items-center gap-1.5 px-4 py-2.5 bg-sky-500 hover:bg-sky-600 text-white font-bold text-sm rounded-xl shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>部署追加</span>
          </button>
        </div>

        {departments.length === 0 ? (
          <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
            登録されている部署・チームがありません。
          </div>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="departments-list">
              {(provided) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className="divide-y divide-gray-100 border rounded-2xl overflow-hidden bg-white"
                >
                  {departments.map((dept, index) => {
                    const parent = departments.find(d => d.id === dept.parent_id);
                    return (
                      <Draggable key={dept.id} draggableId={dept.id} index={index}>
                        {(dragProvided, snapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            className={`flex items-center justify-between p-4 hover:bg-slate-50/30 transition-all ${
                              snapshot.isDragging ? 'bg-slate-50/80 shadow-md' : 'bg-white'
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              {/* ドラッグハンドル */}
                              <div
                                {...dragProvided.dragHandleProps}
                                className="p-1 cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 transition-colors"
                              >
                                <GripVertical className="w-4 h-4" />
                              </div>

                              {/* 部署・チーム情報 */}
                              <div>
                                <div className="font-black text-gray-800 text-sm flex items-center gap-2">
                                  {dept.name}
                                  {parent && (
                                    <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-bold rounded-md">
                                      {parent.name}内
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* 操作ボタン */}
                            <div className="inline-flex gap-2">
                              <button
                                onClick={() => handleOpenDeptModal(dept)}
                                className="p-2 text-gray-400 hover:text-sky-600 hover:bg-sky-50 rounded-lg transition-colors"
                                title="編集"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteDept(dept.id)}
                                className="p-2 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                                title="削除"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        )}
                      </Draggable>
                    );
                  })}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </div>

      {/* 下部: メンバーと部署紐付け一覧 */}
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="mb-6">
          <h2 className="text-xl font-black text-gray-900">メンバーへの部署・チーム割り当て</h2>
          <p className="text-xs text-gray-400 font-semibold mt-1">
            所属する部署を選択します。※メンバーロール（`smiring_member`）を持つユーザーのみが対象として表示されます。複数選択が可能です。
          </p>
        </div>

        {memberDepts.length === 0 ? (
          <div className="text-center py-8 text-gray-400 font-bold bg-slate-50/50 rounded-2xl border border-dashed">
            表示対象となる `smiring_member` ロールを持つメンバーがいません。ロール管理タブで権限を割り当ててください。
          </div>
        ) : (
          <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
            {memberDepts.map(member => (
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
                    options={deptDropdownOptions}
                    value={member.department_ids}
                    onChange={(vals) => handleMemberDeptChange(member.id, vals as string[])}
                    placeholder="部署未設定"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 部署・チーム追加・編集モーダル */}
      {isDeptModalOpen && (
        <div className="fixed inset-0 bg-gray-900/40 backdrop-blur-[1px] flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-white border rounded-3xl w-full max-w-xl p-6 shadow-2xl">
            <h3 className="text-lg font-black text-gray-900 mb-4">
              {editingDept ? '部署・チームの編集' : '新規部署・チームの追加'}
            </h3>
            <form onSubmit={handleSaveDept} className="space-y-4">
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">部署・チーム名</label>
                <input
                  type="text"
                  required
                  placeholder="例: Tech"
                  value={deptForm.name}
                  onChange={(e) => setDeptForm(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full border border-gray-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-gray-700 font-semibold"
                />
              </div>
              <div>
                <label className="block text-xs font-black text-gray-400 uppercase tracking-wide mb-1.5">親部署・所属先</label>
                <CustomDropdown
                  multiple={false}
                  options={parentDeptOptions}
                  value={deptForm.parent_id}
                  onChange={(val) => setDeptForm(prev => ({ ...prev, parent_id: val as string }))}
                  placeholder="親部署なし (最上位)"
                />
              </div>
              
              
              <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setIsDeptModalOpen(false)}
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
