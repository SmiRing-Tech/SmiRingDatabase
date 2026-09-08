import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Loader2, KeyRound, Shuffle, Trash2, HelpCircle } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { CustomDropdown, type DropdownOption } from '../ui/CustomDropdown';

type ScopeMode = 'all' | 'roles' | 'departments' | 'private';
type MemberRoleGroup = 'smiring_member' | 'smiring_partner' | 'smiring_alumni' | 'other';

interface ConnectMember {
  id: string;
  name: string;
  is_internal: boolean;
  role_group: MemberRoleGroup;
  departments: string[];
}

const ROLE_GROUP_LABELS: Record<MemberRoleGroup, string> = {
  smiring_member: 'SmiRing内部メンバー',
  smiring_partner: 'SmiRingパートナー',
  smiring_alumni: 'SmiRing卒業生',
  other: 'その他のメンバー',
};
const ROLE_GROUP_ORDER: MemberRoleGroup[] = ['smiring_member', 'smiring_partner', 'smiring_alumni', 'other'];

const SCOPE_TABS: { value: ScopeMode; label: string }[] = [
  { value: 'all', label: '全員' },
  { value: 'roles', label: 'ロールごと' },
  { value: 'departments', label: '部署ごと' },
  { value: 'private', label: 'プライベート' },
];

/** Groups already-name-sorted members into CustomDropdown's flat { isLabel } + options format. */
function groupMembersByRole(members: ConnectMember[]): DropdownOption[] {
  const options: DropdownOption[] = [];
  for (const group of ROLE_GROUP_ORDER) {
    const inGroup = members.filter((m) => m.role_group === group);
    if (inGroup.length === 0) continue;
    options.push({ label: ROLE_GROUP_LABELS[group], isLabel: true });
    for (const m of inGroup) {
      options.push({ label: m.name, value: m.id });
    }
  }
  return options;
}

const ROLE_GROUP_OPTIONS: DropdownOption[] = ROLE_GROUP_ORDER.map((g) => ({
  label: ROLE_GROUP_LABELS[g],
  value: g,
}));

interface RoomDetail {
  id: string;
  room_title: string;
  room_id: string;
  access_mode: 'public' | 'private';
  public_all: boolean;
  host_code: string | null;
  role_groups: string[];
  departments: string[];
  excluded_user_ids: string[];
  viewer_user_ids: string[];
  host_user_ids: string[];
}

interface CreateFixedMeetingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  currentUserId: string;
  /** When set, the modal edits this existing meeting (fetched via .../detail) instead of creating a new one. */
  roomId?: string | null;
}

function generateHostCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += chars[b % chars.length];
  return code;
}

export default function CreateFixedMeetingModal({
  isOpen,
  onClose,
  onSaved,
  currentUserId,
  roomId = null,
}: CreateFixedMeetingModalProps) {
  const isEditing = !!roomId;
  const [roomTitle, setRoomTitle] = useState('');
  const [customRoomId, setCustomRoomId] = useState('');
  const [scopeMode, setScopeMode] = useState<ScopeMode>('private');
  // Private: fixed roster.
  const [viewerUserIds, setViewerUserIds] = useState<string[]>([]);
  // all/roles/departments: dynamic condition + permanent excludes.
  const [publicRoleGroups, setPublicRoleGroups] = useState<string[]>([]);
  const [publicDepartments, setPublicDepartments] = useState<string[]>([]);
  const [excludedUserIds, setExcludedUserIds] = useState<string[]>([]);
  const [showExcludePanel, setShowExcludePanel] = useState(false);
  const [showHostHelp, setShowHostHelp] = useState(false);
  const [hostUserIds, setHostUserIds] = useState<string[]>([]);
  const [hostCode, setHostCode] = useState('');
  const [members, setMembers] = useState<ConnectMember[]>([]);
  const [allDepartments, setAllDepartments] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    apiClient
      .get('/api/connect/members')
      .then((res) => (res.ok ? res.json() : { members: [] }))
      .then((data) => {
        setMembers(data.members ?? []);
        if (Array.isArray(data.departments)) {
          setAllDepartments(data.departments);
        }
      })
      .catch((e) => console.error('[Connect] Failed to fetch members:', e));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    setError('');

    if (!roomId) {
      setRoomTitle('');
      setCustomRoomId('');
      setScopeMode('private');
      setViewerUserIds([]);
      setPublicRoleGroups([]);
      setPublicDepartments([]);
      setExcludedUserIds([]);
      setShowExcludePanel(false);
      setShowHostHelp(false);
      setHostUserIds([currentUserId]);
      setHostCode('');
      return;
    }

    setLoadingDetail(true);
    apiClient
      .get(`/api/connect/rooms/${roomId}/detail`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('取得に失敗しました'))))
      .then((detail: RoomDetail) => {
        setRoomTitle(detail.room_title);
        setCustomRoomId(detail.room_id);
        setHostUserIds(
          detail.host_user_ids.includes(currentUserId) ? detail.host_user_ids : [currentUserId, ...detail.host_user_ids],
        );
        setHostCode(detail.host_code ?? '');

        if (detail.access_mode === 'private') {
          setScopeMode('private');
          setViewerUserIds(detail.viewer_user_ids);
          setPublicRoleGroups([]);
          setPublicDepartments([]);
          setExcludedUserIds([]);
        } else {
          setViewerUserIds([]);
          setExcludedUserIds(detail.viewer_user_ids);
          setShowExcludePanel(detail.viewer_user_ids.length > 0);
          if (detail.public_all) {
            setScopeMode('all');
            setPublicRoleGroups([]);
            setPublicDepartments([]);
          } else if (detail.role_groups.length > 0) {
            setScopeMode('roles');
            setPublicRoleGroups(detail.role_groups);
            setPublicDepartments([]);
          } else {
            setScopeMode('departments');
            setPublicRoleGroups([]);
            setPublicDepartments(detail.departments);
          }
        }
      })
      .catch((e) => setError(e?.message || 'ミーティング情報の取得に失敗しました'))
      .finally(() => setLoadingDetail(false));
  }, [isOpen, roomId, currentUserId]);

  const memberOptions: DropdownOption[] = useMemo(() => groupMembersByRole(members), [members]);

  // 今の設定でこのミーティングの対象になる人（=「メンバー」）。ホスト・除外の候補はこの中からしか
  // 選べないようにする（全メンバーの一覧を毎回出さない）。
  const scopeAudienceIds = useMemo(() => {
    if (scopeMode === 'private') return new Set(viewerUserIds);
    if (scopeMode === 'all') return new Set(members.map((m) => m.id));
    if (scopeMode === 'roles') {
      return new Set(members.filter((m) => publicRoleGroups.includes(m.role_group)).map((m) => m.id));
    }
    return new Set(
      members.filter((m) => m.departments.some((d) => publicDepartments.includes(d))).map((m) => m.id),
    );
  }, [scopeMode, viewerUserIds, publicRoleGroups, publicDepartments, members]);

  // 既に選択済みのホスト/除外メンバーは、対象範囲を後から狭めても選択肢から消えない
  // （消えると値だけ残って表示が壊れるため）。
  const hostOnlyOptions = useMemo(() => {
    const ids = new Set(scopeAudienceIds);
    for (const id of hostUserIds) ids.add(id);
    return groupMembersByRole(members.filter((m) => ids.has(m.id) && m.id !== currentUserId));
  }, [members, scopeAudienceIds, hostUserIds, currentUserId]);

  const excludeOptions = useMemo(() => {
    const ids = new Set(scopeAudienceIds);
    for (const id of excludedUserIds) ids.add(id);
    return groupMembersByRole(members.filter((m) => ids.has(m.id)));
  }, [members, scopeAudienceIds, excludedUserIds]);

  const departmentOptions: DropdownOption[] = useMemo(() => {
    if (allDepartments.length > 0) {
      return allDepartments.map((d) => ({ label: d, value: d }));
    }
    const names = new Set<string>();
    for (const m of members) {
      for (const d of m.departments) names.add(d);
    }
    return Array.from(names)
      .sort()
      .map((d) => ({ label: d, value: d }));
  }, [allDepartments, members]);

  const currentUserName = members.find((m) => m.id === currentUserId)?.name ?? '自分';

  if (!isOpen || typeof document === 'undefined') return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomTitle.trim()) {
      setError('ミーティング名を入力してください');
      return;
    }
    setError('');
    setCreating(true);

    try {
      const body = {
        room_title: roomTitle.trim(),
        access_mode: scopeMode === 'private' ? 'private' : 'public',
        ...(scopeMode === 'private'
          ? {
              viewer_user_ids: viewerUserIds,
            }
          : {
              public_all: scopeMode === 'all',
              public_role_groups: scopeMode === 'roles' ? publicRoleGroups : [],
              public_departments: scopeMode === 'departments' ? publicDepartments : [],
              excluded_user_ids: excludedUserIds,
            }),
        host_user_ids: hostUserIds,
        host_code: hostCode.trim() || undefined,
      };

      const res = isEditing
        ? await apiClient.patch(`/api/connect/rooms/${roomId}`, body)
        : await apiClient.post('/api/connect/rooms', { ...body, room_id: customRoomId.trim() || undefined });

      if (!res.ok) {
        const resBody = await res.json().catch(() => ({}));
        setError(resBody.error || (isEditing ? '固定ミーティングの更新に失敗しました' : '固定ミーティングの作成に失敗しました'));
        return;
      }

      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || '通信エラーが発生しました');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!roomId) return;
    if (!window.confirm(`固定ミーティング「${roomTitle}」を削除してもよろしいですか？`)) {
      return;
    }
    setError('');
    setDeleting(true);
    try {
      const res = await apiClient.delete(`/api/connect/rooms/${roomId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || '固定ミーティングの削除に失敗しました');
        return;
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || '通信エラーが発生しました');
    } finally {
      setDeleting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div onClick={onClose} className="fixed inset-0 bg-gray-900/40 backdrop-blur-sm animate-in fade-in duration-150" />

      <form
        onSubmit={handleSubmit}
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-lg bg-white border border-slate-100 rounded-3xl shadow-2xl flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150 z-10"
      >
        <div className="flex items-start justify-between p-6 pb-4 border-b border-slate-100">
          <div>
            <h3 className="text-lg font-black text-gray-900">
              {isEditing ? '固定ミーティングを編集' : '固定ミーティングを作成'}
            </h3>
            <p className="text-xs text-gray-400 font-semibold mt-1">
              {isEditing ? '公開範囲・ホストなどの設定を変更します' : 'いつも使うミーティング名で永続ルームを作成します'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors shrink-0"
            title="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-600">ミーティング名</label>
            <input
              type="text"
              value={roomTitle}
              onChange={(e) => setRoomTitle(e.target.value)}
              placeholder="例: 定例ミーティング"
              className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none text-sm font-semibold text-gray-800 rounded-xl transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-600">
              ID{isEditing ? '（作成後は変更できません）' : '（任意・空欄なら自動生成）'}
            </label>
            <input
              type="text"
              value={customRoomId}
              onChange={(e) => setCustomRoomId(e.target.value)}
              placeholder="例: weekly-mtg"
              disabled={isEditing}
              className="w-full px-4 py-2 bg-slate-50 border border-slate-200 focus:border-sky-400 outline-none text-xs font-mono text-gray-800 rounded-xl transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-600">誰が見れるか</label>

            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
              {SCOPE_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setScopeMode(tab.value)}
                  className={`shrink-0 whitespace-nowrap px-3.5 py-2 rounded-xl text-xs font-bold border transition-all ${
                    scopeMode === tab.value
                      ? 'bg-sky-500 border-sky-500 text-white shadow-sm'
                      : 'bg-white border-slate-200 text-gray-500 hover:border-sky-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {scopeMode === 'all' && (
              <p className="text-[11px] text-gray-500 font-semibold bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5">
                このDatabase内の全員（高校生、現役留学生、既卒生など）に表示されます
              </p>
            )}

            {scopeMode === 'roles' && (
              <CustomDropdown
                multiple
                options={ROLE_GROUP_OPTIONS}
                value={publicRoleGroups}
                onChange={setPublicRoleGroups}
                placeholder="ロールを選択"
              />
            )}

            {scopeMode === 'departments' && (
              <CustomDropdown
                multiple
                searchable
                options={departmentOptions}
                value={publicDepartments}
                onChange={setPublicDepartments}
                placeholder="部署を選択"
              />
            )}

            {scopeMode === 'private' && (
              <CustomDropdown
                multiple
                searchable
                options={memberOptions}
                value={viewerUserIds}
                onChange={setViewerUserIds}
                placeholder="メンバーを選択"
              />
            )}

            {scopeMode !== 'private' && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowExcludePanel((prev) => !prev)}
                  className="text-[11px] font-bold text-gray-400 hover:text-sky-600 transition-colors"
                >
                  {showExcludePanel
                    ? '除外するメンバーを閉じる'
                    : excludedUserIds.length > 0
                      ? `除外するメンバーを指定（${excludedUserIds.length}人選択中）`
                      : '除外するメンバーを指定'}
                </button>
                {showExcludePanel && (
                  <div className="pt-1.5">
                    <CustomDropdown
                      multiple
                      searchable
                      options={excludeOptions}
                      value={excludedUserIds}
                      onChange={setExcludedUserIds}
                      placeholder="条件に当てはまっていても常に除外する人"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label className="text-xs font-bold text-gray-600">ホストユーザー</label>
              <button
                type="button"
                onClick={() => setShowHostHelp((prev) => !prev)}
                className="text-gray-400 hover:text-sky-600 p-0.5 rounded-full hover:bg-sky-50 transition-colors"
                title="ホストユーザーについて"
              >
                <HelpCircle className="w-3.5 h-3.5" />
              </button>
            </div>

            {showHostHelp && (
              <div className="p-2.5 bg-sky-50/80 border border-sky-100 rounded-xl text-xs text-sky-900 leading-relaxed animate-in fade-in duration-150">
                <p className="text-[11px] text-sky-800">
                  ミニルームの作成・管理や録画など、ミーティングの進行・管理機能を利用できるユーザーです。ここで指定したユーザーは、入室時に自動的にホスト権限が付与されます。
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-1.5 mb-1.5">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-sky-50 border border-sky-200 text-sky-700 text-[11px] font-bold rounded-full">
                {currentUserName}（自分）
              </span>
            </div>
            <CustomDropdown
              multiple
              searchable
              options={hostOnlyOptions}
              value={hostUserIds.filter((id) => id !== currentUserId)}
              onChange={(ids) => setHostUserIds([currentUserId, ...ids])}
              placeholder="他にホストにする人を選択（任意）"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-600 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5" />
              ホストコード（任意）
            </label>
            <p className="text-[10px] text-gray-400 font-semibold">
              このコードを知っていれば、権限がない人でも通話内でホストになれます
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={hostCode}
                onChange={(e) => setHostCode(e.target.value)}
                placeholder="例: SUNRISE24"
                className="flex-1 px-4 py-2 bg-slate-50 border border-slate-200 focus:border-sky-400 outline-none text-xs font-mono text-gray-800 rounded-xl transition-all"
              />
              <button
                type="button"
                onClick={() => setHostCode(generateHostCode())}
                title="ランダム生成"
                className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-gray-600 rounded-xl transition-colors shrink-0"
              >
                <Shuffle className="w-4 h-4" />
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-rose-500 font-semibold">{error}</p>}
        </div>

        <div className="p-6 pt-4 border-t border-slate-100 space-y-2">
          <button
            type="submit"
            disabled={creating || deleting || loadingDetail || !roomTitle.trim()}
            className="w-full py-2.5 bg-sky-500 hover:bg-sky-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all active:scale-95 flex items-center justify-center gap-1.5"
          >
            {creating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{isEditing ? '保存中...' : '作成中...'}</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                <span>{isEditing ? '変更を保存' : '固定ミーティングを作成'}</span>
              </>
            )}
          </button>

          {isEditing && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={creating || deleting || loadingDetail}
              className="w-full py-2.5 bg-white hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed text-rose-500 font-bold text-sm rounded-xl border border-rose-200 transition-all active:scale-95 flex items-center justify-center gap-1.5"
            >
              {deleting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>削除中...</span>
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  <span>このミーティングを削除</span>
                </>
              )}
            </button>
          )}
        </div>
      </form>
    </div>,
    document.body,
  );
}
