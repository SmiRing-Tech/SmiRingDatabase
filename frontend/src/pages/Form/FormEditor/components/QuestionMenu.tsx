// src/components/FormEditor/components/QuestionMenu.tsx

import { useState } from 'react';
import { 
  CircleDot, CheckSquare, SquareChevronDown, LineDotRightHorizontal, 
  LayoutGrid, ArrowLeft, PenLine, NotebookPen, Image as ImageIcon, Trash2, Settings, Calendar 
} from 'lucide-react';
import type { QuestionData } from '../FormEditorPage';
import QuestionSettingsModal from './QuestionSettingsModal';

type QuestionMenuProps = {
  currentType: string;
  isActive: boolean;
  onChangeType: (type: string) => void;
  onDelete: () => void;
  question: QuestionData;
  onChange: (updates: Partial<QuestionData>) => void;
};

export default function QuestionMenu({ currentType, isActive, onChangeType, onDelete, question, onChange }: QuestionMenuProps) {
  const [isTypeMenuOpen, setIsTypeMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const questionTypes = [
    { value: 'radio',        label: 'ラジオボタン',        icon: CircleDot },
    { value: 'checkbox',     label: 'チェックボックス',     icon: CheckSquare },
    { value: 'dropdown',     label: 'ドロップダウン',       icon: SquareChevronDown },
    { value: 'scale',        label: 'スケール',            icon: LineDotRightHorizontal },
    { value: 'grid_radio',   label: 'グリッド',            icon: LayoutGrid },
    { value: 'short_text',   label: '短文入力',            icon: PenLine },
    { value: 'long_text_md', label: '長文入力',            icon: NotebookPen },
    { value: 'date_time',    label: '日時選択',            icon: Calendar },
  ];

  // 有効な設定があるかどうかを判定（その形式で使える設定のみをチェック）
  const hasActiveSettings = 
    (['radio', 'checkbox', 'dropdown'].includes(question.type) && question.allowCustomAnswer) ||
    (question.type === 'checkbox' && question.checkboxValidation?.enabled) ||
    (question.type === 'short_text' && (question.shortTextValidation?.enabled || question.shortTextMultiple?.enabled));

  // 🌟 PC用（右側に浮かぶ）とスマホ用（下部に固定）の共通・個別クラス
  const visibilityClass = isActive 
    ? "opacity-100 pointer-events-auto" 
    : "opacity-0 pointer-events-none";
  const desktopClass = "hidden md:flex absolute -right-52 top-0 flex-col w-48 bg-white shadow-lg border border-gray-100 rounded-xl p-2 space-y-1";
  const mobileClass = "flex md:hidden fixed bottom-0 left-0 right-0 w-full bg-white shadow-[0_-10px_20px_rgba(0,0,0,0.1)] border-t border-gray-200 p-2 pb-safe z-[50]";

  // --- 状態1: 質問形式の選択メニュー ---
  if (isTypeMenuOpen) {
    return (
      <>
        {/* PC表示 */}
        <div className={`${desktopClass} ${visibilityClass}`}>
          <button onClick={() => setIsTypeMenuOpen(false)} className="flex items-center p-2 hover:bg-gray-100 rounded-md text-gray-600 transition-colors font-bold text-sm border-b border-gray-100 mb-1">
            <ArrowLeft className="w-4 h-4 mr-2" />
            質問形式
          </button>
          {questionTypes.map(({ value, label, icon: Icon }) => (
            <button key={value} onClick={() => { onChangeType(value); setIsTypeMenuOpen(false); }}
              className={`flex items-center gap-2 text-left px-3 py-2 text-sm rounded-md transition-colors group ${currentType === value ? 'bg-blue-100 text-blue-700 font-bold' : 'hover:bg-gray-50 text-gray-700'}`}
            >
              <Icon className={`w-4 h-4 shrink-0 ${currentType === value ? 'text-blue-600' : 'text-gray-400 group-hover:text-blue-600'}`} strokeWidth={2.5} />
              {label}
            </button>
          ))}
        </div>

        {/* スマホ表示 (横スクロール) */}
        <div className={`${mobileClass} ${visibilityClass} flex-row overflow-x-auto gap-2 px-4 items-center`}>
          <button onClick={() => setIsTypeMenuOpen(false)} className="p-2 shrink-0 bg-gray-100 rounded-full text-gray-600 active:bg-gray-200">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="w-px h-6 bg-gray-200 shrink-0 mx-1" />
          {questionTypes.map(({ value, label, icon: Icon }) => (
            <button key={value} onClick={() => { onChangeType(value); setIsTypeMenuOpen(false); }}
              className={`flex items-center gap-1.5 shrink-0 px-4 py-2.5 text-sm rounded-full font-bold transition-colors ${currentType === value ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-100 text-gray-700'}`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>
      </>
    );
  }

  // --- 状態2: 通常のメインメニュー ---
  return (
    <>
      {/* モーダル */}
      {isSettingsOpen && (
        <QuestionSettingsModal
          question={question}
          onChange={onChange}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}

      {/* PC表示 */}
      <div className={`${desktopClass} ${visibilityClass}`}>
        <button onClick={() => setIsTypeMenuOpen(true)} className="flex items-center p-2 hover:bg-blue-50 rounded-md text-gray-600 transition-colors group">
          <svg className="w-5 h-5 mr-3 text-gray-400 group-hover:text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" /></svg>
          <span className="text-sm font-medium">質問形式</span>
        </button>
        <button className="flex items-center p-2 hover:bg-blue-50 rounded-md text-gray-600 transition-colors group">
          <ImageIcon className="w-5 h-5 mr-3 text-gray-400 group-hover:text-blue-600" />
          <span className="text-sm font-medium">画像を挿入</span>
        </button>
        <button 
          onClick={() => setIsSettingsOpen(true)} 
          className="flex items-center p-2 hover:bg-blue-50 rounded-md text-gray-600 transition-colors group"
        >
          <div className="relative mr-3">
            <Settings className="w-5 h-5 text-gray-400 group-hover:text-blue-600" />
            {hasActiveSettings && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-blue-500 rounded-full" />
            )}
          </div>
          <span className="text-sm font-medium">詳細設定</span>
          {hasActiveSettings && (
            <span className="ml-auto text-[10px] font-bold text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded-full">ON</span>
          )}
        </button>
        <hr className="border-gray-100 my-1" />
        <button onClick={onDelete} className="flex items-center p-2 hover:bg-red-50 rounded-md text-red-500 transition-colors group">
          <Trash2 className="w-5 h-5 mr-3 text-red-400 group-hover:text-red-600" />
          <span className="text-sm font-medium">削除</span>
        </button>
      </div>

      {/* スマホ表示 (等間隔のボトムツールバー) */}
      <div className={`${mobileClass} ${visibilityClass} flex-row justify-around items-center`}>
        <button onClick={() => setIsTypeMenuOpen(true)} className="flex flex-col items-center justify-center p-2 text-gray-600 active:text-blue-600 w-20">
          <svg className="w-6 h-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" /></svg>
          <span className="text-[10px] font-bold">形式</span>
        </button>
        <button className="flex flex-col items-center justify-center p-2 text-gray-600 active:text-blue-600 w-20">
          <ImageIcon className="w-6 h-6 mb-1" />
          <span className="text-[10px] font-bold">画像</span>
        </button>
        <button 
          onClick={() => setIsSettingsOpen(true)}
          className="flex flex-col items-center justify-center p-2 text-gray-600 active:text-blue-600 w-20 relative"
        >
          <div className="relative">
            <Settings className="w-6 h-6 mb-1" />
            {hasActiveSettings && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-blue-500 rounded-full border-2 border-white" />
            )}
          </div>
          <span className="text-[10px] font-bold">設定</span>
        </button>
        <button onClick={onDelete} className="flex flex-col items-center justify-center p-2 text-red-500 active:text-red-600 w-20">
          <Trash2 className="w-6 h-6 mb-1" />
          <span className="text-[10px] font-bold">削除</span>
        </button>
      </div>
    </>
  );
}