import { useState } from 'react';
import { LayoutGrid, Info, Users, Briefcase, GraduationCap, Shield, FolderGit2 } from 'lucide-react';
import UserRoleTab from './components/UserRoleTab';
import DepartmentTab from './components/DepartmentTab';
import StudyStageTab from './components/StudyStageTab';
import PermissionTab from './components/PermissionTab';
import GroupTab from './components/GroupTab';

export default function ManagementConsolePage() {
  const [activeTab, setActiveTab] = useState<'roles' | 'departments' | 'stages' | 'permissions' | 'groups'>('stages');
  const [errorMsg, setErrorMsg] = useState('');

  return (
    <div className="min-h-full bg-slate-50/50 p-6 md:p-10">
      <div className="max-w-6xl mx-auto">
        {/* --- ヘッダー --- */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-2 text-sky-600 font-bold text-sm tracking-wide uppercase">
              <LayoutGrid className="w-4 h-4" />
              <span>Administration</span>
            </div>
            <h1 className="text-3xl font-black text-gray-900 tracking-tight">
              Management Console
            </h1>
          </div>
        </div>

        {/* エラーメッセージ */}
        {errorMsg && (
          <div className="mb-6 p-4 bg-rose-50 border border-rose-100 rounded-2xl flex items-start gap-3 text-rose-700 text-sm font-semibold">
            <Info className="w-5 h-5 shrink-0 text-rose-500" />
            <div>{errorMsg}</div>
          </div>
        )}

        {/* --- タブ切り替え --- */}
        <div className="flex border-b border-gray-200 mb-8 bg-white p-1.5 rounded-2xl shadow-sm border overflow-x-auto gap-1">
          <button
            onClick={() => {
              setErrorMsg('');
              setActiveTab('stages');
            }}
            className={`flex-1 py-3 px-6 rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all min-w-[120px] ${
              activeTab === 'stages'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-50'
            }`}
          >
            <GraduationCap className="w-4 h-4" />
            <span>留学段階管理</span>
          </button>
          <button
            onClick={() => {
              setErrorMsg('');
              setActiveTab('roles');
            }}
            className={`flex-1 py-3 px-6 rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all min-w-[120px] ${
              activeTab === 'roles'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-50'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>ユーザーロール管理</span>
          </button>
          <button
            onClick={() => {
              setErrorMsg('');
              setActiveTab('departments');
            }}
            className={`flex-1 py-3 px-6 rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all min-w-[120px] ${
              activeTab === 'departments'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-50'
            }`}
          >
            <Briefcase className="w-4 h-4" />
            <span>部署・チーム管理</span>
          </button>
          <button
            onClick={() => {
              setErrorMsg('');
              setActiveTab('groups');
            }}
            className={`flex-1 py-3 px-6 rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all min-w-[120px] ${
              activeTab === 'groups'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-50'
            }`}
          >
            <FolderGit2 className="w-4 h-4" />
            <span>グループ管理</span>
          </button>
          <button
            onClick={() => {
              setErrorMsg('');
              setActiveTab('permissions');
            }}
            className={`flex-1 py-3 px-6 rounded-xl font-black text-sm flex items-center justify-center gap-2 transition-all min-w-[120px] ${
              activeTab === 'permissions'
                ? 'bg-sky-500 text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-900 hover:bg-slate-50'
            }`}
          >
            <Shield className="w-4 h-4" />
            <span>権限管理</span>
          </button>
        </div>

        {/* --- タブコンテンツの表示 --- */}
        {activeTab === 'stages' ? (
          <StudyStageTab onError={setErrorMsg} />
        ) : activeTab === 'roles' ? (
          <UserRoleTab onError={setErrorMsg} />
        ) : activeTab === 'departments' ? (
          <DepartmentTab onError={setErrorMsg} />
        ) : activeTab === 'groups' ? (
          <GroupTab onError={setErrorMsg} />
        ) : (
          <PermissionTab onError={setErrorMsg} />
        )}
      </div>
    </div>
  );
}
