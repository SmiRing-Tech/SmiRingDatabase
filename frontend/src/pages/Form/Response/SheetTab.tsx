import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Pin, PinOff, FileText, Image as Paperclip, Calendar} from 'lucide-react';
import type { TabProps } from './types';
import { getDisplayName } from './types';
import type { QuestionData } from '../FormEditor/FormEditorPage';

// リッチなセル描画用コンポーネント
const CellContent = ({ question, answer }: { question: QuestionData, answer: any }) => {
  if (answer === null || answer === undefined || answer === '') {
    return <span className="text-gray-300 italic text-xs">未回答</span>;
  }

  switch (question.type) {
    case 'date_time': {
      const date = new Date(answer);
      if (isNaN(date.getTime())) return <span className="text-sm">{String(answer)}</span>;
      
      const fmt = question.dateTimeSettings?.format || {};
      const dateParts = [];
      if (fmt.year) dateParts.push(`${date.getFullYear()}年`);
      if (fmt.month) dateParts.push(`${date.getMonth() + 1}月`);
      if (fmt.date) dateParts.push(`${date.getDate()}日`);
      
      const timeParts = [];
      if (fmt.hour) timeParts.push(`${date.getHours()}時`);
      if (fmt.minute) timeParts.push(`${date.getMinutes()}分`);
      if (fmt.second) timeParts.push(`${date.getSeconds()}秒`);

      return (
        <div className="flex items-center gap-1.5 text-gray-700 text-sm">
          <Calendar className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
          <span className="font-bold whitespace-nowrap">
            {dateParts.join('')} {timeParts.join('')}
          </span>
        </div>
      );
    }

    case 'grid_radio': {
      if (typeof answer !== 'object') return <span className="text-sm">{String(answer)}</span>;
      return (
        <div className="space-y-1 py-1">
          {Object.entries(answer).map(([row, col]) => (
            <div key={row} className="text-xs flex gap-1.5 leading-relaxed">
              <span className="font-bold text-gray-400 flex-shrink-0">{row}:</span>
              <span className="text-gray-800 break-words font-medium">{Array.isArray(col) ? col.join('、') : String(col)}</span>
            </div>
          ))}
        </div>
      );
    }

    case 'file_upload': {
      if (!Array.isArray(answer)) return <span className="text-sm">{String(answer)}</span>;
      return (
        <div className="flex flex-col gap-1.5 py-1">
          {answer.map((file: any, i: number) => {
            const isImage = file.type?.startsWith('image/');
            const isPdf = file.type === 'application/pdf' || file.name?.endsWith('.pdf');
            
            return (
              <a
                key={i}
                href={file.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 p-1.5 pr-3 bg-white border border-gray-100 rounded-lg hover:border-blue-200 hover:bg-blue-50 transition-all group max-w-full shadow-sm"
              >
                <div className="w-6 h-6 rounded flex-shrink-0 bg-gray-50 border border-gray-100 overflow-hidden flex items-center justify-center">
                  {isImage && (file.thumbnailUrl || file.url) ? (
                    <img src={file.thumbnailUrl || file.url} className="w-full h-full object-cover" alt="" />
                  ) : isPdf ? (
                    <FileText className="w-3.5 h-3.5 text-red-500" />
                  ) : (
                    <Paperclip className="w-3.5 h-3.5 text-blue-500" />
                  )}
                </div>
                <span className="text-[10px] font-bold text-gray-500 truncate group-hover:text-blue-700">
                  {file.name || '不明なファイル'}
                </span>
              </a>
            );
          })}
        </div>
      );
    }

    case 'checkbox': {
      if (!Array.isArray(answer)) return <span className="text-sm">{String(answer)}</span>;
      return (
        <span className="text-sm text-gray-700 font-medium">
          {answer.join('、')}
        </span>
      );
    }

    case 'long_text_md': {
      // HTMLタグを除去し、改行だけを活かす
      const plainText = answer.replace(/<[^>]*>/g, (tag: string) => (tag === '</p>' || tag === '<br>' || tag === '<br/>' ? '\n' : ''));
      return (
        <div className="text-sm text-gray-600 whitespace-pre-wrap leading-relaxed py-1 line-clamp-6">
          {plainText}
        </div>
      );
    }

    default:
      return <span className="text-sm whitespace-pre-wrap">{String(answer)}</span>;
  }
};

export default function SheetTab({ questions, responses, indexMap, isAnonymous }: TabProps) {
  const [, setSearchParams] = useSearchParams();
  const [stickyLabels, setStickyLabels] = useState(true);

  const goToQuestion = (questionId: string) => {
    setSearchParams({ mode: 'responses', tab: 'question', questionId });
  };

  const goToIndividual = (responseId: string) => {
    setSearchParams({ mode: 'responses', tab: 'individual', responseId });
  };

  return (
    <div className="h-full flex flex-col p-4 gap-3 bg-gray-50">

      {/* ── ツールバー ── */}
      <div className="flex items-center justify-between flex-shrink-0">
        <p className="text-xs text-gray-400 font-medium">
          {responses.length} 件の回答 · {questions.length} 問
          {isAnonymous && <span className="ml-2 px-1.5 py-0.5 bg-gray-800 text-white text-[10px] font-bold rounded-full">🕶 匿名</span>}
        </p>
        <button
          onClick={() => setStickyLabels(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors border ${
            stickyLabels
              ? 'bg-purple-50 text-purple-700 border-purple-200'
              : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
          }`}
        >
          {stickyLabels ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
          ラベルを固定
        </button>
      </div>

      {/* ── テーブルコンテナ（角丸・shadow・2方向スクロール） ── */}
      <div className="flex-1 overflow-auto rounded-xl border border-gray-200 shadow-sm bg-white min-h-0">
        <table className="border-collapse text-sm" style={{ minWidth: 'max-content' }}>
          <thead>
            <tr>
              {/* 左上コーナー（固定） */}
              <th
                className={`${stickyLabels ? 'sticky top-0 left-0 z-30' : ''} bg-gray-100 border-b border-r border-gray-200 px-4 py-3 text-left font-bold text-gray-600 whitespace-nowrap`}
                style={{ minWidth: 180 }}
              >
                {isAnonymous ? '回答者' : '名前'}
              </th>
              {/* 各質問ヘッダー（上部固定） */}
              {questions.map(q => (
                <th
                  key={q.id}
                  className={`${stickyLabels ? 'sticky top-0 z-20' : ''} bg-gray-100 border-b border-r border-gray-200 px-4 py-3 text-left font-bold text-gray-600 cursor-pointer hover:bg-purple-50 hover:text-purple-700 transition-colors whitespace-nowrap`}
                  style={{ minWidth: 180, maxWidth: 260 }}
                  onClick={() => goToQuestion(q.id)}
                  title="質問別タブで見る"
                >
                  <span className="truncate block max-w-[240px]">{q.title || '無題の質問'}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {responses.map((resp) => {
              const displayName = getDisplayName(resp, indexMap, isAnonymous);
              // 常に個人別タブに飛べるようにする
              const isClickable = true;

              return (
                <tr key={resp.response_id} className="hover:bg-gray-50 transition-colors">
                  {/* 回答者名セル（左固定） */}
                  <td
                    className={`${stickyLabels ? 'sticky left-0 z-10' : ''} bg-white border-b border-r border-gray-200 px-4 py-3 font-medium whitespace-nowrap cursor-pointer hover:bg-purple-50 hover:text-purple-700`}
                    style={{ minWidth: 180 }}
                    onClick={() => goToIndividual(resp.response_id)}
                    title="個人別タブで見る"
                  >
                    <div className="flex items-center gap-2">
                      {/* アバターは匿名でない時だけ表示 */}
                      {!(resp.is_anonymous || isAnonymous) && (
                        <div className="w-7 h-7 rounded-full bg-purple-100 overflow-hidden flex-shrink-0 flex items-center justify-center text-xs font-bold text-purple-700">
                          {resp.avatar_link
                            ? <img src={resp.avatar_link} className="w-full h-full object-cover" alt="" />
                            : resp.name_english?.charAt(0) || '?'
                          }
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-bold text-gray-800">{displayName}</p>
                        {isClickable && resp.name_kanji && (
                          <p className="text-[10px] text-gray-400">{resp.name_kanji}</p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* 各質問の回答セル */}
                  {questions.map(q => {
                    const raw = resp.content?.[q.id];

                    return (
                      <td
                        key={q.id}
                        className="border-b border-r border-gray-200 px-4 py-3 text-gray-700 align-top"
                        style={{ minWidth: 180, maxWidth: 280 }}
                      >
                        <CellContent question={q} answer={raw} />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
