// Response機能で全タブが共有する型定義

import type { QuestionData } from '../FormEditor/FormEditorPage';

export type ResponseSummary = {
  response_id: string;
  user_id: string;
  submitted_at: string;
  updated_at: string;
  name_english: string;
  name_kanji: string;
  avatar_link: string | null;
  content: Record<string, any>; // { [questionId]: value }
  is_anonymous: boolean;
};

export type TabProps = {
  formId: string;
  title: string;
  description: string;
  questions: QuestionData[];
  responses: ResponseSummary[];
  indexMap: Map<string, number>; // userId → 回答者番号 (1始まり)
  isAnonymous: boolean;
};

// 回答者の表示名を返すヘルパー
export function getDisplayName(
  response: ResponseSummary,
  indexMap: Map<string, number>,
  isGlobalAnonymous: boolean
): string {
  // レコード自身が匿名フラグを持っている、またはフォーム全体が現在匿名設定の場合
  if (response.is_anonymous || isGlobalAnonymous) {
    const idx = indexMap.get(response.user_id) ?? '?';
    return `回答者 ${idx}`;
  }
  return response.name_english || '不明なユーザー';
}

// 回答値を人間が読める文字列に変換するヘルパー
export function formatAnswerValue(question: QuestionData, answer: any): string {
  if (answer === null || answer === undefined || answer === '') return '—';

  switch (question.type) {
    case 'radio': {
      const opt = question.options.find(o => o.id === answer);
      return opt?.text || String(answer);
    }
    case 'dropdown': {
      // dropdownは opt.text を値として保存している
      return String(answer);
    }
    case 'checkbox': {
      if (!Array.isArray(answer)) return String(answer);
      return answer
        .map(id => question.options.find(o => o.id === id)?.text || String(id))
        .join(', ') || '—';
    }
    case 'scale':
      return String(answer);
    case 'short_text':
      return String(answer);
    case 'long_text_md':
      // HTMLタグを除去して先頭50文字
      return String(answer).replace(/<[^>]*>/g, '').substring(0, 60) + (String(answer).length > 60 ? '...' : '');
    case 'grid_radio': {
      if (typeof answer !== 'object') return String(answer);
      const rowCount = Object.keys(answer).length;
      return `${rowCount}行 回答済み`;
    }
    case 'file_upload': {
      if (!Array.isArray(answer)) return String(answer);
      if (answer.length === 0) return '—';
      return `${answer.length}件のファイル`;
    }
    default:
      return String(answer);
  }
}

// チャートで使うカラーパレット
export const CHART_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#3b82f6', '#ef4444', '#14b8a6',
  '#f97316', '#84cc16',
];
