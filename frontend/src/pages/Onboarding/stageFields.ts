// active_stage_role_id で選ばれたラベルごとに、オンボーディングStep3で聞く留学系フィールドを定義。
// backend/src/routes/profileRoutes.ts の STAGE_FIELDS_MAP と対応させること。
// 保護者の child_id は現状 (自動紐付け未実装につき保存時エラーになる) ため、オンボーディングでは聞かない。
export const STAGE_FIELD_KEYS_BY_LABEL: Record<string, string[]> = {
  '留学前': [
    'study_abroad_interest_level',
    'expected_timing',
    'interested_countries',
    'interested_areas',
    'interested_study_abroad_types',
    'interested_majors',
  ],
  '留学中': [
    'study_abroad_country',
    'study_abroad_city',
    'study_abroad_type',
    'study_abroad_history',
    'english_school',
    'current_school',
    'school_history',
    'majors',
    'minors',
    'major_history',
  ],
  '留学後': [
    'study_abroad_country',
    'study_abroad_city',
    'study_abroad_type',
    'study_abroad_history',
    'english_school',
    'last_overseas_university',
    'school_history',
    'majors',
    'minors',
    'major_history',
  ],
  '保護者': [
    'concerns',
  ],
};
