import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Link2, Loader2, Trash2 } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';
import { CustomDropdown, type DropdownOption } from '../ui/CustomDropdown';
import { SmartDateTimePicker } from '../ui/SmartDateTimePicker';

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

const DATE_TIME_FORMAT = { year: true, month: true, date: true, hour: true, minute: true, timezone: true };

function parseDateOrNull(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface ExternalMeetingDetail {
  id: string;
  room_title: string;
  room_id: string;
  expires_at: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  invite_token: string | null;
  viewer_user_ids: string[];
}

export interface CreatedExternalMeeting {
  id: string;
  room_title: string;
  room_id: string;
  invite_token: string;
}

interface CreateExternalMeetingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** 新規作成が成功したときだけ呼ばれる（URLコピー用ポップアップを開くため）。編集時は呼ばれない。 */
  onCreated: (meeting: CreatedExternalMeeting) => void;
  currentUserId: string;
  /** When set, the modal edits this existing external meeting instead of creating a new one. */
  roomId?: string | null;
}

export default function CreateExternalMeetingModal({
  isOpen,
  onClose,
  onSaved,
  onCreated,
  currentUserId,
  roomId = null,
}: CreateExternalMeetingModalProps) {
  const isEditing = !!roomId;
  const [roomTitle, setRoomTitle] = useState('');
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [scheduledStartAt, setScheduledStartAt] = useState<Date | null>(null);
  const [scheduledEndAt, setScheduledEndAt] = useState<Date | null>(null);
  // 失効日時・開始/終了予定の3フィールドで共通のタイムゾーン（1つのミーティングなので別々にする意味がない）
  const [pickerTimezone, setPickerTimezone] = useState('Asia/Tokyo');
  const [viewerUserIds, setViewerUserIds] = useState<string[]>([]);
  const [members, setMembers] = useState<ConnectMember[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    apiClient
      .get('/api/connect/members')
      .then((res) => (res.ok ? res.json() : { members: [] }))
      .then((data) => setMembers(data.members ?? []))
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
      setExpiresAt(null);
      setScheduledStartAt(null);
      setScheduledEndAt(null);
      setPickerTimezone('Asia/Tokyo');
      setViewerUserIds([]);
      return;
    }

    setLoadingDetail(true);
    apiClient
      .get(`/api/connect/rooms/${roomId}/detail`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('取得に失敗しました'))))
      .then((detail: ExternalMeetingDetail) => {
        setRoomTitle(detail.room_title);
        setExpiresAt(parseDateOrNull(detail.expires_at));
        setScheduledStartAt(parseDateOrNull(detail.scheduled_start_at));
        setScheduledEndAt(parseDateOrNull(detail.scheduled_end_at));
        setViewerUserIds(detail.viewer_user_ids);
      })
      .catch((e) => setError(e?.message || 'ミーティング情報の取得に失敗しました'))
      .finally(() => setLoadingDetail(false));
  }, [isOpen, roomId]);

  const memberOptions: DropdownOption[] = useMemo(
    () => groupMembersByRole(members.filter((m) => m.id !== currentUserId)),
    [members, currentUserId],
  );

  if (!isOpen || typeof document === 'undefined') return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomTitle.trim()) {
      setError('ミーティング名を入力してください');
      return;
    }
    if (!expiresAt) {
      setError('失効日時を入力してください');
      return;
    }
    setError('');
    setSaving(true);

    try {
      const body = {
        meeting_type: 'external',
        room_title: roomTitle.trim(),
        expires_at: expiresAt!.toISOString(),
        scheduled_start_at: scheduledStartAt ? scheduledStartAt.toISOString() : null,
        scheduled_end_at: scheduledEndAt ? scheduledEndAt.toISOString() : null,
        viewer_user_ids: viewerUserIds,
      };

      const res = isEditing
        ? await apiClient.patch(`/api/connect/rooms/${roomId}`, body)
        : await apiClient.post('/api/connect/rooms', body);

      if (!res.ok) {
        const resBody = await res.json().catch(() => ({}));
        setError(resBody.error || (isEditing ? '外部ミーティングの更新に失敗しました' : '外部ミーティングの作成に失敗しました'));
        return;
      }

      const resBody = await res.json();
      onSaved();
      onClose();
      if (!isEditing && resBody?.room?.invite_token) {
        onCreated({
          id: resBody.room.id,
          room_title: resBody.room.room_title,
          room_id: resBody.room.room_id,
          invite_token: resBody.room.invite_token,
        });
      }
    } catch (e: any) {
      setError(e?.message || '通信エラーが発生しました');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!roomId) return;
    if (!window.confirm(`外部ミーティング「${roomTitle}」を削除してもよろしいですか？`)) {
      return;
    }
    setError('');
    setDeleting(true);
    try {
      const res = await apiClient.delete(`/api/connect/rooms/${roomId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || '外部ミーティングの削除に失敗しました');
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
              {isEditing ? '外部ミーティングを編集' : '外部ミーティングを作成'}
            </h3>
            <p className="text-xs text-gray-400 font-semibold mt-1">
              {isEditing
                ? '失効日時・開催予定時刻などの設定を変更します'
                : 'DBアカウントを持たない外部の方にも招待URLで共有できます'}
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
              placeholder="例: 説明会（保護者向け）"
              className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm font-semibold text-gray-800 rounded-xl transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-600">失効日時</label>
            <p className="text-[10px] text-gray-400 font-semibold">
              この日時を過ぎると招待URLから新しく入室できなくなります（タイムゾーンはピッカー内で変更できます）
            </p>
            <SmartDateTimePicker
              value={expiresAt}
              onChange={setExpiresAt}
              timezone={pickerTimezone}
              onTimezoneChange={setPickerTimezone}
              format={DATE_TIME_FORMAT}
              placeholder="失効日時を選択"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-600">開始予定（任意）</label>
              <SmartDateTimePicker
                value={scheduledStartAt}
                onChange={setScheduledStartAt}
                timezone={pickerTimezone}
                onTimezoneChange={setPickerTimezone}
                format={DATE_TIME_FORMAT}
                placeholder="開始予定を選択"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-600">終了予定（任意）</label>
              <SmartDateTimePicker
                value={scheduledEndAt}
                onChange={setScheduledEndAt}
                timezone={pickerTimezone}
                onTimezoneChange={setPickerTimezone}
                format={DATE_TIME_FORMAT}
                placeholder="終了予定を選択"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-gray-600">Connectホームで共有する内部メンバー（任意）</label>
            <p className="text-[10px] text-gray-400 font-semibold">
              自分以外にも、選んだメンバーのConnectホームにこのタイルが表示され、URLをコピーできるようになります
            </p>
            <CustomDropdown
              multiple
              searchable
              options={memberOptions}
              value={viewerUserIds}
              onChange={setViewerUserIds}
              placeholder="共有するメンバーを選択"
            />
          </div>

          {error && <p className="text-xs text-rose-500 font-semibold">{error}</p>}
        </div>

        <div className="p-6 pt-4 border-t border-slate-100 space-y-2">
          <button
            type="submit"
            disabled={saving || deleting || loadingDetail || !roomTitle.trim() || !expiresAt}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-sm rounded-xl shadow-sm hover:shadow transition-all active:scale-95 flex items-center justify-center gap-1.5"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{isEditing ? '保存中...' : '作成中...'}</span>
              </>
            ) : (
              <>
                <Link2 className="w-4 h-4" />
                <span>{isEditing ? '変更を保存' : '外部ミーティングを作成'}</span>
              </>
            )}
          </button>

          {isEditing && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving || deleting || loadingDetail}
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
