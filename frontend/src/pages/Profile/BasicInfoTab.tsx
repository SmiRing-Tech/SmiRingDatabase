import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import { SquarePen, ChevronRight, ArrowDown } from 'lucide-react';
import ProfileEditModal from './components/ProfileEditModal';
import { BASIC_INFO_FIELDS } from './basicInfoFields';
import { supabase } from '../../lib/supabase';
import { API_BASE_URL } from '../../config';

// --- Lucideアイコンのヘルパー ---
const LucideIcon = ({ name, className }: { name: string, className?: string }) => {
  const Icon = (Icons as any)[name];
  if (!Icon) return null;
  return <Icon className={className} />;
};

type Props = {
  initialData: any;
  isEditable?: boolean;
  onDataChange?: () => void;
};

// --- 値の表示 ---
function ValueDisplay({ value, fieldKey }: { value: any, fieldKey?: string }) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return (
      <span className="text-[14px] sm:text-[15px] text-gray-300 italic font-normal">—</span>
    );
  }

  const renderSingleValue = (v: any) => {
    if (typeof v === 'object' && v !== null && 'text' in v) {
      return (
        <span className="flex items-center gap-2">
          {v.lucideIcon && <LucideIcon name={v.lucideIcon} className="w-4 h-4 text-blue-500" />}
          {v.text}
        </span>
      );
    }
    // ISO形式の日付文字列を検出してフォーマット
    if (typeof v === 'string' && v.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)) {
      try {
        const d = new Date(v);
        const fieldDef = fieldKey ? BASIC_INFO_FIELDS[fieldKey] : null;
        const fmt = fieldDef?.dateTimeSettings?.format;
        
        if (fmt) {
          const parts = [];
          if (fmt.year) parts.push(`${d.getFullYear()}年`);
          if (fmt.month) parts.push(`${d.getMonth() + 1}月`);
          if (fmt.date) parts.push(`${d.getDate()}日`);
          
          if (fmt.hour || fmt.minute || fmt.second) {
            const timeParts = [];
            if (fmt.hour) timeParts.push(`${String(d.getHours()).padStart(2, '0')}時`);
            if (fmt.minute) timeParts.push(`${String(d.getMinutes()).padStart(2, '0')}分`);
            if (fmt.second) timeParts.push(`${String(d.getSeconds()).padStart(2, '0')}秒`);
            parts.push(timeParts.join(''));
          }
          return parts.join(' ');
        }
        
        return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
      } catch (e) {
        return v;
      }
    }
    return String(v);
  };

  if (Array.isArray(value)) {
    const fieldDef = fieldKey ? BASIC_INFO_FIELDS[fieldKey] : null;
    const isMultiple = fieldDef?.shortTextMultiple?.enabled;
    const listStyle = fieldDef?.shortTextMultiple?.style;

    if (fieldDef?.type === 'checkbox') {
      return (
        <div className="w-full break-words flex flex-col gap-1">
          {value.map((v, i) => (
            <span key={i} className="text-[14px] sm:text-[15px] font-medium text-gray-900 leading-snug">
              {renderSingleValue(v)}
            </span>
          ))}
        </div>
      );
    }

    return (
      <div className="w-full break-words flex flex-col py-1">
        {value.map((v, i) => (
          <React.Fragment key={i}>
            {i > 0 && isMultiple && listStyle === 'arrow' && (
              <div className="flex justify-start pl-2 opacity-50 py-0.5">
                <ArrowDown className="text-gray-600 font-bold text-sm" />
              </div>
            )}
            <div className="flex items-start">
               {isMultiple && listStyle === 'bullet' && <span className="text-gray-800 mr-2 font-bold mt-[2px]">•</span>}
               {isMultiple && listStyle === 'number' && <span className="text-gray-400 mr-2 font-bold mt-[2px]">{i + 1}.</span>}
               <span className="text-[14px] sm:text-[15px] font-medium text-gray-900 leading-snug flex-1">
                 {renderSingleValue(v)}
               </span>
            </div>
          </React.Fragment>
        ))}
      </div>
    );
  }

  return (
    <div className="w-full break-words">
      <span className="text-[14px] sm:text-[15px] font-medium text-gray-900 leading-snug whitespace-pre-wrap">
        {renderSingleValue(value)}
      </span>
    </div>
  );
}

// --- 📱 レスポンシブ対応のプロフィール行 ---
type ProfileInfoRowProps = {
  title: string;
  value: any;
  onEdit: () => void;
  children?: React.ReactNode;
  isEditable?: boolean;
  fieldKey?: string;
};

function ProfileInfoRow({
  title,
  value,
  onEdit,
  children,
  isEditable = false,
  fieldKey,
}: ProfileInfoRowProps) {
  const [isOpen, setIsOpen] = useState(false);
  const hasChildren = React.Children.count(children) > 0;

  return (
    <div>
      <div
        onClick={() => hasChildren && setIsOpen((prev) => !prev)}
        className={`group flex px-3 py-3 md:py-4 border-b border-gray-100 transition-colors ${
          hasChildren ? 'cursor-pointer hover:bg-gray-50' : 'cursor-default'
        }`}
      >
        {/* 🌟 ここがレスポンシブの肝！
          flex-col (縦並び) を基本とし、md:flex-row (画面幅768px以上で横並び) に切り替えます。
          md:items-center でPC表示のときは上下中央揃えにします。
        */}
        <div className="flex-1 flex flex-col md:flex-row md:items-center min-w-0 gap-1 md:gap-4">
          
          {/* 左側：タイトル */}
          <span className="text-[11px] font-medium tracking-wide text-gray-400 uppercase w-full md:w-48 flex-shrink-0">
            {title}
          </span>
          
          {/* 右側：値 */}
          <div className="flex-1 w-full pl-2 md:pl-0">
            <ValueDisplay value={value} fieldKey={fieldKey} />
          </div>
        </div>

        {/* アイコン類は常に右端 */}
        <div className="flex items-center ml-2 flex-shrink-0 gap-2">
          {isEditable ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              className="flex items-center justify-center w-9 h-9 md:w-9 md:h-9 rounded-md bg-blue-50 text-blue-600 border border-blue-100 transition-all hover:bg-blue-100 hover:text-blue-700 shadow-sm"
              title="編集"
            >
              <SquarePen className="w-5 h-5" />
            </button>
          ) : (
            <div className="w-9" />
          )}

          {hasChildren && (
            <div className="flex items-center justify-center pl-5 border-l-2 border-gray-200 ml-2 h-10 w-12">
              <ChevronRight 
                className={`w-6 h-6 transition-all duration-200 flex-shrink-0 ${
                  isOpen
                    ? 'rotate-90 text-blue-300'
                    : 'text-blue-600 hover:text-blue-700'
                }`}
                strokeWidth={3.2}
              />
            </div>
          )}
          {!hasChildren && <div className="w-12 ml-2 pl-5 border-l-2 border-transparent" />}
        </div>
      </div>

      {hasChildren && (
        <div
          className={`overflow-hidden transition-all duration-200 ease-in-out ${
            isOpen ? 'max-h-screen opacity-100' : 'max-h-0 opacity-0'
          }`}
        >
          {/* 子要素のインデントもスマホ向けに微調整 */}
          <div className="ml-2 md:ml-5 pl-3 md:pl-4 border-l-2 border-gray-100 my-1 md:my-2">
            {React.Children.map(children, (child) => {
              if (React.isValidElement(child)) {
                return React.cloneElement(child, { isEditable } as any);
              }
              return child;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// --- セクションタイトル ---
function SectionTitle({ title }: { title: string }) {
  return (
    <h3 className="text-[12px] font-bold tracking-widest uppercase text-gray-500 mt-8 mb-2 px-3 pb-2 border-b border-gray-100 first:mt-0">
      {title}
    </h3>
  );
}

// --- メインページ ---
export default function BasicInfoPage({ initialData, isEditable = false, onDataChange }: Props) {
  const [data, setData] = useState(initialData || {});
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);

  const handleEdit = (key: string) => {
    setEditingFieldKey(key);
  };

  const handleSave = async (fieldKey: string, newValue: any) => {
    // API経由で保存
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('認証エラー');

    const res = await fetch(`${API_BASE_URL}/api/basic_profile_info/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ [fieldKey]: newValue })
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || '保存に失敗しました');
    }

    // ローカルのデータも更新
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

  return (
    // 🌟 左右の余白もレスポンシブに対応 (スマホはpx-4, PCはpx-6)
    <div className="w-full px-4 md:px-6 py-6 pb-20">
      {/* Name */}
      <SectionTitle title="Name" />
      <ProfileInfoRow title="Name (English)" value={getDisplayValue('name_english', data['name_english'])} fieldKey="name_english" onEdit={() => handleEdit('name_english')} isEditable={isEditable}>
        <ProfileInfoRow title="Name (Kanji)" value={getDisplayValue('name_kanji', data['name_kanji'])} fieldKey="name_kanji" onEdit={() => handleEdit('name_kanji')} isEditable={isEditable} />
      </ProfileInfoRow>

      {/* Background & Education */}
      <SectionTitle title="Background & Education" />
      <ProfileInfoRow title="Birthday" value={getDisplayValue('birthday', data['birthday'])} fieldKey="birthday" onEdit={() => handleEdit('birthday')} isEditable={isEditable} />
      <ProfileInfoRow title="Hometown" value={getDisplayValue('hometown', data['hometown'])} fieldKey="hometown" onEdit={() => handleEdit('hometown')} isEditable={isEditable} />
      <ProfileInfoRow title="Study Abroad Country" value={getDisplayValue('study_abroad_country', data['study_abroad_country'])} fieldKey="study_abroad_country" onEdit={() => handleEdit('study_abroad_country')} isEditable={isEditable}>
        <ProfileInfoRow title="City" value={getDisplayValue('study_abroad_city', data['study_abroad_city'])} fieldKey="study_abroad_city" onEdit={() => handleEdit('study_abroad_city')} isEditable={isEditable} />
        <ProfileInfoRow title="Type" value={getDisplayValue('study_abroad_type', data['study_abroad_type'])} fieldKey="study_abroad_type" onEdit={() => handleEdit('study_abroad_type')} isEditable={isEditable} />
        <ProfileInfoRow title="History" value={getDisplayValue('study_abroad_history', data['study_abroad_history'])} fieldKey="study_abroad_history" onEdit={() => handleEdit('study_abroad_history')} isEditable={isEditable} />
        <ProfileInfoRow title="English School" value={getDisplayValue('english_school', data['english_school'])} fieldKey="english_school" onEdit={() => handleEdit('english_school')} isEditable={isEditable} />
      </ProfileInfoRow>
      <ProfileInfoRow title="Current School" value={getDisplayValue('current_school', data['current_school'])} fieldKey="current_school" onEdit={() => handleEdit('current_school')} isEditable={isEditable}>
        <ProfileInfoRow title="School History" value={getDisplayValue('school_history', data['school_history'])} fieldKey="school_history" onEdit={() => handleEdit('school_history')} isEditable={isEditable} />
      </ProfileInfoRow>
      <ProfileInfoRow title="Grade Level" value={getDisplayValue('grade_level', data['grade_level'])} fieldKey="grade_level" onEdit={() => handleEdit('grade_level')} isEditable={isEditable} />
      <ProfileInfoRow title="Majors" value={getDisplayValue('majors', data['majors'])} fieldKey="majors" onEdit={() => handleEdit('majors')} isEditable={isEditable}>
        <ProfileInfoRow title="Minors" value={getDisplayValue('minors', data['minors'])} fieldKey="minors" onEdit={() => handleEdit('minors')} isEditable={isEditable} />
        <ProfileInfoRow title="Major History" value={getDisplayValue('major_history', data['major_history'])} fieldKey="major_history" onEdit={() => handleEdit('major_history')} isEditable={isEditable} />
      </ProfileInfoRow>

      {/* Personal Identity */}
      <SectionTitle title="Personal Identity" />
      <ProfileInfoRow title="Personality" value={getDisplayValue('personality', data['personality'])} fieldKey="personality" onEdit={() => handleEdit('personality')} isEditable={isEditable} />
      <ProfileInfoRow title="Important Values" value={getDisplayValue('important_values', data['important_values'])} fieldKey="important_values" onEdit={() => handleEdit('important_values')} isEditable={isEditable} />
      <ProfileInfoRow title="Future Image" value={getDisplayValue('future_image', data['future_image'])} fieldKey="future_image" onEdit={() => handleEdit('future_image')} isEditable={isEditable} />

      {/* SmiRing Info */}
      <SectionTitle title="SmiRing Info" />
      <ProfileInfoRow title="Department" value={getDisplayValue('smiring_department', data['smiring_department'])} fieldKey="smiring_department" onEdit={() => handleEdit('smiring_department')} isEditable={isEditable} />
      <ProfileInfoRow title="Join Date" value={getDisplayValue('smiring_join_date', data['smiring_join_date'])} fieldKey="smiring_join_date" onEdit={() => handleEdit('smiring_join_date')} isEditable={isEditable} />

      {/* Edit Modal */}
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