import React, { useState, useEffect, useCallback } from 'react';
import ProfileEditModal from './components/ProfileEditModal';
import { BASIC_INFO_FIELDS } from './basicInfoFields';
import { supabase } from '../../lib/supabase';
import { API_BASE_URL } from '../../config';
import { SectionTitle, ProfileInfoRow } from './BasicInfoTab';

type Props = {
  userId: string;
  isEditable?: boolean;
  onDataChange?: () => void;
};

export default function Ryugakusai2026Tab({ userId, isEditable = false, onDataChange }: Props) {
  const [data, setData] = useState<any>({});
  const [isLoading, setIsLoading] = useState(true);
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;

      const endpoint = isEditable
        ? `${API_BASE_URL}/api/profile/ryugakusai2026/me`
        : `${API_BASE_URL}/api/profile/ryugakusai2026/${userId}`;

      const res = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('データの取得に失敗しました');
      const json = await res.json();
      setData(json || {});
    } catch (e) {
      console.error('留学祭2026プロフィール取得エラー:', e);
    } finally {
      setIsLoading(false);
    }
  }, [userId, isEditable]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleEdit = (key: string) => {
    setEditingFieldKey(key);
  };

  const getAIFormattedValue = (fieldDef: any, value: any) => {
    if (!value || (fieldDef.type !== 'date' && fieldDef.type !== 'date_time')) return value;
    
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return value;

      const f = fieldDef.dateTimeSettings?.format;
      if (!f) return value;

      const useUTC = !f.hour && !f.minute;

      let parts = [];
      if (f.year) parts.push(`${useUTC ? date.getUTCFullYear() : date.getFullYear()}年`);
      if (f.month) parts.push(`${(useUTC ? date.getUTCMonth() : date.getMonth()) + 1}月`);
      if (f.date) parts.push(`${useUTC ? date.getUTCDate() : date.getDate()}日`);
      
      let timeStr = "";
      if (f.hour || f.minute) {
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        timeStr = `${hh}:${mm}`;
        if (f.second) {
          timeStr += `:${String(date.getSeconds()).padStart(2, '0')}`;
        }
        parts.push(timeStr);
      }

      if (f.timezone && !useUTC) {
        const tzName = Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
          .formatToParts(date)
          .find(p => p.type === 'timeZoneName')?.value;
        if (tzName) parts.push(`(${tzName})`);
      }

      return parts.join(' ').replace(/年 /g, '年').replace(/月 /g, '月');
    } catch (e) {
      return value;
    }
  };

  const handleSave = async (fieldKey: string, newValue: any) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('認証エラー');

    const fieldDef = BASIC_INFO_FIELDS[fieldKey];

    const res = await fetch(`${API_BASE_URL}/api/profile/ryugakusai2026/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({
        [fieldKey]: newValue,
        _ai_metadata: {
          field_key: fieldKey,
          label: fieldDef?.title || fieldKey,
          type: fieldDef?.type || 'text',
          formattedValue: getAIFormattedValue(fieldDef, newValue),
          options: fieldDef?.options || [],
          displayStyle: fieldDef?.shortTextMultiple?.style || (fieldDef?.dropdownSettings?.multiple ? 'comma' : 'none'),
          scale: fieldDef?.scale,
          gridRows: fieldDef?.gridRows,
          gridCols: fieldDef?.gridCols
        }
      })
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || '保存に失敗しました');
    }

    setData((prev: any) => ({ ...prev, [fieldKey]: newValue }));
    if (onDataChange) {
      onDataChange();
    }
  };

  const getDisplayValue = (key: string, value: any) => {
    if (value === null || value === undefined || value === '') return value;
    const fieldDef = BASIC_INFO_FIELDS[key];
    if (!fieldDef) return value;

    if (fieldDef.type === 'checkbox' || fieldDef.type === 'radio' || fieldDef.type === 'dropdown') {
      const isArray = Array.isArray(value);
      const values = isArray ? value : [value];
      const items = values.map((val: any) => {
        const opt = fieldDef.options.find(o => o.id === val || o.text === val);
        return opt ? { text: opt.text, lucideIcon: opt.lucideIcon } : { text: val };
      });
      return isArray ? items : items[0];
    }
    return value;
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-gray-500 py-10">Loading...</div>;
  }

  return (
    <div className="w-full px-4 md:px-6 py-6 pb-20">
      <SectionTitle title="留学祭2026プロフィール情報" />

      {/* 注意書き */}
      <div className="mb-6 p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-sm leading-relaxed space-y-1">
        <p className="font-bold">📢 留学祭ウェブサイトの留学生一覧にそのまま載ります！</p>
        <p>高校生が読みやすいように、「The United States of America」→「アメリカ」など、文言の変更もお願いします。</p>
        <p className="font-semibold text-amber-800">📸 写真のアップロードもお忘れなく！</p>
      </div>
      
      <ProfileInfoRow title="名前（英語）" value={getDisplayValue('name_english', data['name_english'])} fieldKey="name_english" onEdit={() => handleEdit('name_english')} isEditable={isEditable}>
        <ProfileInfoRow title="名前（漢字）" value={getDisplayValue('name_kanji', data['name_kanji'])} fieldKey="name_kanji" onEdit={() => handleEdit('name_kanji')} isEditable={isEditable} />
      </ProfileInfoRow>
      
      <ProfileInfoRow title="学年" value={getDisplayValue('grade_level', data['grade_level'])} fieldKey="grade_level" onEdit={() => handleEdit('grade_level')} isEditable={isEditable} />
      <ProfileInfoRow title="出身地" value={getDisplayValue('hometown', data['hometown'])} fieldKey="hometown" onEdit={() => handleEdit('hometown')} isEditable={isEditable} />
      <ProfileInfoRow title="学校" value={getDisplayValue('current_school', data['current_school'])} fieldKey="current_school" onEdit={() => handleEdit('current_school')} isEditable={isEditable} />
      <ProfileInfoRow title="留学先の国" value={getDisplayValue('study_abroad_country', data['study_abroad_country'])} fieldKey="study_abroad_country" onEdit={() => handleEdit('study_abroad_country')} isEditable={isEditable} />
      <ProfileInfoRow title="留学先の都市" value={getDisplayValue('study_abroad_city', data['study_abroad_city'])} fieldKey="study_abroad_city" onEdit={() => handleEdit('study_abroad_city')} isEditable={isEditable} />
      <ProfileInfoRow title="留学形態" value={getDisplayValue('study_abroad_type', data['study_abroad_type'])} fieldKey="study_abroad_type" onEdit={() => handleEdit('study_abroad_type')} isEditable={isEditable} />
      <ProfileInfoRow title="語学学校" value={getDisplayValue('english_school', data['english_school'])} fieldKey="english_school" onEdit={() => handleEdit('english_school')} isEditable={isEditable} />
      <ProfileInfoRow title="メジャー" value={getDisplayValue('majors', data['majors'])} fieldKey="majors" onEdit={() => handleEdit('majors')} isEditable={isEditable} />
      <ProfileInfoRow title="マイナー" value={getDisplayValue('minors', data['minors'])} fieldKey="minors" onEdit={() => handleEdit('minors')} isEditable={isEditable} />
      <ProfileInfoRow title="一言メッセージ" value={getDisplayValue('short_message', data['short_message'])} fieldKey="short_message" onEdit={() => handleEdit('short_message')} isEditable={isEditable} />
      <p className="mt-2 ml-3 text-[13px] text-gray-500 leading-normal">
        💡 参加者への激励メッセージ、特に自分が何を話せるかをアピールして書いて欲しいです！！
      </p>

      {editingFieldKey && BASIC_INFO_FIELDS[editingFieldKey] && (
        <ProfileEditModal
          isOpen={true}
          onClose={() => setEditingFieldKey(null)}
          questionData={BASIC_INFO_FIELDS[editingFieldKey]}
          currentValue={data[editingFieldKey]}
          onSave={handleSave}
        />
      )}
    </div>
  );
}
