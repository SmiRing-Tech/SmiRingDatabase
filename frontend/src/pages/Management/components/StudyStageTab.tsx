import { useState, useEffect } from 'react';
import { apiClient } from '../../../lib/apiClient';
import { CustomDropdown, type DropdownOption } from '../../../components/ui/CustomDropdown';

const ROLE_PRE = '30b89471-46da-4501-84cd-f318b8cfeb3e';
const ROLE_CURRENT = '1f7f6138-eecc-4925-958a-095ea80eff5c';
const ROLE_POST = 'aad63ee1-40de-4807-a0b0-5660fa68a1f6';
const ROLE_GUARDIAN = 'c8fcb0bc-7cf1-4bd5-90ba-7bbb45f5fbbc';

interface MemberStageItem {
  id: string;
  name_english: string;
  name_kanji: string;
  avatar_link: string | null;
  stage_role_ids: string[];
  active_stage_role_id: string | null;
}

interface StudyStageTabProps {
  onError: (msg: string) => void;
}

export default function StudyStageTab({ onError }: StudyStageTabProps) {
  const [members, setMembers] = useState<MemberStageItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchStagesData = async () => {
    setIsLoading(true);
    onError('');
    try {
      const res = await apiClient.get('/api/management/members/stages');
      if (res.ok) {
        setMembers(await res.json());
      } else {
        onError('留学段階データの取得に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || 'データの取得に失敗しました');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStagesData();
  }, []);

  const handleUpdateStageAndActive = async (
    userId: string,
    newStageIds: string[],
    newActiveId: string | null
  ) => {
    onError('');
    
    // activeIdの調整
    let activeId = newActiveId;
    if (newStageIds.length === 0) {
      activeId = null;
    } else if (!activeId || !newStageIds.includes(activeId)) {
      activeId = newStageIds[0];
    }

    try {
      const res = await apiClient.put(`/api/management/members/${userId}/stage`, {
        stageRoleIds: newStageIds,
        activeStageRoleId: activeId
      });
      if (res.ok) {
        setMembers(prev =>
          prev.map(m =>
            m.id === userId
              ? { ...m, stage_role_ids: newStageIds, active_stage_role_id: activeId }
              : m
          )
        );
      } else {
        const data = await res.json();
        onError(data.error || '留学段階の更新に失敗しました');
      }
    } catch (err: any) {
      onError(err.message || '留学段階の更新に失敗しました');
    }
  };

  const stageOptions: DropdownOption[] = [
    { label: '留学前', value: ROLE_PRE },
    { label: '留学中', value: ROLE_CURRENT },
    { label: '留学後', value: ROLE_POST },
    { label: '保護者', value: ROLE_GUARDIAN }
  ];

  if (isLoading) {
    return <div className="text-center py-10 text-gray-500 font-bold">留学段階データをロード中...</div>;
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-200">
      <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
        <div className="mb-6">
          <h2 className="text-xl font-black text-gray-900">留学段階管理</h2>
          <p className="text-xs text-gray-400 font-semibold mt-1">
            各メンバーの留学状況ステージ（複数可）を設定し、そのうちのどれを「現在状況」にするかを選択します。
          </p>
        </div>

        <div className="divide-y divide-gray-100 border rounded-2xl overflow-hidden">
          {members.map(member => {
            // 現在選択されている段階のみを「現在の状況」の選択肢にする
            const activeOptions: DropdownOption[] = stageOptions
              .filter(opt => opt.value !== undefined && member.stage_role_ids.includes(opt.value))
              .map(opt => ({ label: opt.label, value: opt.value }));

            return (
              <div key={member.id} className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-4 hover:bg-slate-50/30">
                {/* メンバー情報 */}
                <div className="flex items-center gap-3 min-w-[200px]">
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

                {/* 選択コントロール群 */}
                <div className="flex flex-col sm:flex-row gap-4 flex-1 lg:justify-end">
                  {/* 1. 留学段階（複数選択） */}
                  <div className="w-full sm:w-[240px]">
                    <span className="block text-[10px] text-gray-400 font-bold mb-1.5 uppercase">割り当て段階</span>
                    <CustomDropdown
                      multiple={true}
                      options={stageOptions}
                      value={member.stage_role_ids}
                      onChange={(vals) =>
                        handleUpdateStageAndActive(
                          member.id,
                          vals as string[],
                          member.active_stage_role_id
                        )
                      }
                      placeholder="段階なし"
                    />
                  </div>

                  {/* 2. 現在の状況（単一選択） */}
                  <div className="w-full sm:w-[200px]">
                    <span className="block text-[10px] text-gray-400 font-bold mb-1.5 uppercase">現在状況の表示対象</span>
                    {member.stage_role_ids.length === 0 ? (
                      <div className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm bg-slate-50 text-gray-400 font-semibold select-none">
                        段階未選択
                      </div>
                    ) : (
                      <CustomDropdown
                        multiple={false}
                        options={activeOptions}
                        value={member.active_stage_role_id || ''}
                        onChange={(val) =>
                          handleUpdateStageAndActive(
                            member.id,
                            member.stage_role_ids,
                            (val as string) || null
                          )
                        }
                        placeholder="現在状況を選択"
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
