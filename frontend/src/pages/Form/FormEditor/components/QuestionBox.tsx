import React, { useState, useRef, useEffect } from 'react';
import QuestionMenu from './QuestionMenu';
import { CircleDot, CheckSquare, SquareChevronDown, LineDotRightHorizontal, LayoutGrid, PenLine, NotebookPen, GripVertical, GripHorizontal, Calendar, UploadCloud } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import RichTextEditor from '../../../../components/ui/RichTextEditor';
import type { QuestionData } from '../FormEditorPage';
import { CustomDropdown, type DropdownOption } from '../../../../components/ui/CustomDropdown';
import { SmartDateTimePicker } from '../../../../components/ui/SmartDateTimePicker';

type QuestionBoxProps = {
  question: QuestionData;
  isActive: boolean;
  isSortingGlobal?: boolean;
  isDragging?: boolean;
  dragHandleProps?: any;
  onStartSorting?: () => void;
  onCancelSorting?: () => void;
  onChange: (updates: Partial<QuestionData>) => void;
  onDelete: () => void;
  formTimezone?: string;
};

export default function QuestionBox({ 
  question, 
  isActive, 
  isSortingGlobal, 
  isDragging,
  dragHandleProps, 
  onStartSorting,
  onCancelSorting,
  onChange, 
  onDelete,
  formTimezone
}: QuestionBoxProps) {
  
  const questionTypeIcons: Record<string, React.ElementType> = {
    radio: CircleDot, 
    checkbox: CheckSquare, 
    dropdown: SquareChevronDown,
    scale: LineDotRightHorizontal, 
    grid_radio: LayoutGrid, 
    short_text: PenLine, 
    long_text_md: NotebookPen,
    date_time: Calendar,
    file_upload: UploadCloud,
  };

  // --- 共通の操作ロジック（親の onChange を呼ぶ） ---
  const handleAddOption = () => onChange({ options: [...question.options, { id: Date.now(), text: '' }] });
  const handleUpdateOption = (id: number, text: string) => onChange({ options: question.options.map(opt => opt.id === id ? { ...opt, text } : opt) });
  const handleRemoveOption = (id: number) => { if (question.options.length > 1) onChange({ options: question.options.filter(opt => opt.id !== id) }); };

  // --- グリッドの操作ロジック ---
  const handleAddGridRow = () => onChange({ gridRows: [...question.gridRows, { id: Date.now(), text: '' }] });
  const handleUpdateGridRow = (id: number, text: string) => onChange({ gridRows: question.gridRows.map(r => r.id === id ? { ...r, text } : r) });
  const handleRemoveGridRow = (id: number) => { if (question.gridRows.length > 1) onChange({ gridRows: question.gridRows.filter(r => r.id !== id) }); };

  const handleAddGridCol = () => onChange({ gridCols: [...question.gridCols, { id: Date.now(), text: '' }] });
  const handleUpdateGridCol = (id: number, text: string) => onChange({ gridCols: question.gridCols.map(c => c.id === id ? { ...c, text } : c) });
  const handleRemoveGridCol = (id: number) => { if (question.gridCols.length > 1) onChange({ gridCols: question.gridCols.filter(c => c.id !== id) }); };

  // --- D&D ロジック ---
  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    const { source, destination, type } = result;
    if (source.index === destination.index) return;

    if (type === 'options') {
      const newOptions = Array.from(question.options);
      const [moved] = newOptions.splice(source.index, 1);
      newOptions.splice(destination.index, 0, moved);
      onChange({ options: newOptions });
    } else if (type === 'gridRows') {
      const newRows = Array.from(question.gridRows);
      const [moved] = newRows.splice(source.index, 1);
      newRows.splice(destination.index, 0, moved);
      onChange({ gridRows: newRows });
    } else if (type === 'gridCols') {
      const newCols = Array.from(question.gridCols);
      const [moved] = newCols.splice(source.index, 1);
      newCols.splice(destination.index, 0, moved);
      onChange({ gridCols: newCols });
    }
  };

  // --- スケールのスクロール制御（UIの見た目だけなのでローカルState） ---
  const scaleRef = useRef<HTMLDivElement>(null);
  const [showRightShadow, setShowRightShadow] = useState(false);
  const [showLeftShadow, setShowLeftShadow] = useState(false);

  const handleScaleScroll = () => {
    const el = scaleRef.current;
    if (!el) return;
    setShowLeftShadow(el.scrollLeft > 0);
    setShowRightShadow(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  useEffect(() => {
    handleScaleScroll();
  }, [question.scale.min, question.scale.max]);


  // --- UI: ラジオ・チェックボックス ---
  const renderListOptions = (type: string) => {
    return (
      <Droppable droppableId={`options-${question.id}`} type="options">
        {(provided) => (
          <div 
            className="pt-4 space-y-2"
            ref={provided.innerRef}
            {...provided.droppableProps}
          >
            {question.options.map((opt, index) => {
              const isDuplicate = question.options.some(other => other.id !== opt.id && other.text.trim() !== '' && other.text.trim() === opt.text.trim());
              return (
                <Draggable key={opt.id.toString()} draggableId={opt.id.toString()} index={index}>
                  {(provided, snapshot) => (
                    <div 
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      style={provided.draggableProps.style}
                      className={`space-y-1 ${snapshot.isDragging ? 'opacity-80 bg-white rounded-lg shadow-md z-50 p-2 -mx-2' : ''}`}
                    >
                      <div className="flex items-center space-x-3 group/option">
                        <div 
                          {...provided.dragHandleProps} 
                          className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing transition-colors"
                        >
                          <GripVertical className="w-4 h-4" />
                        </div>
                        {type === 'radio' && <div className={`w-5 h-5 border-2 ${isDuplicate ? 'border-red-300' : 'border-gray-300'} rounded-full flex-shrink-0`} />}
                        {type === 'checkbox' && <div className={`w-5 h-5 border-2 ${isDuplicate ? 'border-red-300' : 'border-gray-300'} rounded-md flex-shrink-0`} />}
                        
                        <input 
                          type="text" 
                          value={opt.text}
                          placeholder={`選択肢 ${index + 1}`}
                          onChange={(e) => handleUpdateOption(opt.id, e.target.value)}
                          className={`flex-1 text-sm border-b transition-colors focus:outline-none py-1 ${
                            isDuplicate 
                              ? 'border-red-500 text-red-600 focus:border-red-600' 
                              : 'border-transparent focus:border-blue-500 hover:border-gray-200 text-gray-700'
                          }`} 
                        />
                        <button 
                          onClick={() => handleRemoveOption(opt.id)}
                          className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
                        >
                          ✕
                        </button>
                      </div>
                      {isDuplicate && (
                        <p className="text-[10px] text-red-500 font-bold pl-12 animate-in fade-in slide-in-from-top-1">
                          「{opt.text}」はすでに存在します
                        </p>
                      )}
                    </div>
                  )}
                </Draggable>
              );
            })}
            {provided.placeholder}
            <div className="flex items-center space-x-2 pt-2 cursor-pointer text-blue-500 hover:text-blue-700 pl-7" onClick={handleAddOption}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              <span className="text-sm font-bold">選択肢を追加</span>
            </div>
            {/* 選択肢ごとのカスタム設定がある場合の表示バッジ */}
            {question.allowCustomAnswer && (
              <p className="text-xs text-blue-500 font-medium pt-1 pl-12">＋ カスタム回答が有効</p>
            )}
            {question.type === 'checkbox' && question.checkboxValidation?.enabled && (
              <p className="text-xs text-orange-500 font-medium pt-1 pl-12">
                ※ 選択数の制限: {question.checkboxValidation.min !== '' ? `${question.checkboxValidation.min}個以上` : ''}{question.checkboxValidation.min !== '' && question.checkboxValidation.max !== '' ? ' / ' : ''}{question.checkboxValidation.max !== '' ? `${question.checkboxValidation.max}個以下` : ''}
              </p>
            )}
          </div>
        )}
      </Droppable>
    );
  };

  // --- UI: ドロップダウン ---
  const renderDropdown = () => {
    return (
      <div className="pt-4">
        <div className="w-full md:w-2/3 border border-gray-300 rounded-md bg-white shadow-sm overflow-hidden">
          <div className="flex items-center justify-between p-3 bg-gray-50 border-b border-gray-200">
            <span className="text-sm text-gray-500">
              {question.dropdownSettings?.multiple ? '回答者はここから複数を選びます' : '回答者はここから1つ選びます'}
            </span>
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
          </div>
          <Droppable droppableId={`dropdown-${question.id}`} type="options">
            {(provided) => (
              <div 
                className="p-2 space-y-1 bg-white"
                ref={provided.innerRef}
                {...provided.droppableProps}
              >
                {(() => {
                  let itemCount = 0;
                  return question.options.map((opt, index) => {
                    if (!opt.isLabel) itemCount++;
                    const displayIndex = itemCount;
                    const isDuplicate = question.options.some(other => !other.isLabel && other.id !== opt.id && other.text.trim() !== '' && other.text.trim() === opt.text.trim());
                    
                    return (
                      <Draggable key={opt.id.toString()} draggableId={opt.id.toString()} index={index}>
                        {(provided, snapshot) => (
                          <div 
                            ref={provided.innerRef}
                            {...provided.draggableProps}
                            style={provided.draggableProps.style}
                            className={`space-y-1 ${snapshot.isDragging ? 'opacity-80 bg-white rounded-lg shadow-md z-50' : ''}`}
                          >
                            <div className={`flex items-center space-x-3 group/option p-2 hover:bg-gray-50 rounded-md transition-colors ${snapshot.isDragging ? 'bg-gray-50' : ''}`}>
                              <div 
                                {...provided.dragHandleProps} 
                                className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing transition-colors"
                              >
                                <GripVertical className="w-4 h-4" />
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  const newOptions = question.options.map(o => o.id === opt.id ? { ...o, isLabel: !o.isLabel } : o);
                                  onChange({ options: newOptions });
                                }}
                                className={`px-2 py-0.5 text-[10px] font-bold rounded-md transition-all ${opt.isLabel ? 'bg-purple-600 text-white shadow-sm' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}
                                title={opt.isLabel ? "通常アイテムに戻す" : "セクションラベルにする"}
                              >
                                {opt.isLabel ? 'LABEL' : 'ITEM'}
                              </button>
                              <span className={`font-bold w-5 text-right flex-shrink-0 ${opt.isLabel ? 'opacity-0' : (isDuplicate ? 'text-red-300' : 'text-gray-400')}`}>
                                {!opt.isLabel && `${displayIndex}.`}
                              </span>
                              <input 
                                type="text" value={opt.text} placeholder={opt.isLabel ? "セクションの見出しを入力..." : `選択肢 ${displayIndex}`}
                                onChange={(e) => handleUpdateOption(opt.id, e.target.value)}
                                className={`flex-1 text-sm bg-transparent border-b transition-colors focus:outline-none py-1 ${
                                  opt.isLabel ? 'font-bold text-purple-700 border-purple-200 focus:border-purple-500' :
                                  isDuplicate 
                                    ? 'border-red-500 text-red-600 focus:border-red-600' 
                                    : 'border-transparent focus:border-blue-500'
                                }`} 
                              />
                              <button onClick={() => handleRemoveOption(opt.id)} className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0">✕</button>
                            </div>
                            {isDuplicate && !opt.isLabel && (
                              <p className="text-[10px] text-red-500 font-bold pl-16 animate-in fade-in slide-in-from-top-1">
                                「{opt.text}」はすでに存在します
                              </p>
                            )}
                          </div>
                        )}
                      </Draggable>
                    );
                  });
                })()}
                {provided.placeholder}
                <div className="flex items-center space-x-2 pt-2 cursor-pointer text-blue-500 hover:text-blue-700 p-2 pl-9" onClick={handleAddOption}>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                  <span className="text-sm font-bold">選択肢を追加</span>
                </div>
              </div>
            )}
          </Droppable>
        </div>
      </div>
    );
  };

  // --- UI: スケール ---
  const renderScale = () => {
    const minOptions: DropdownOption[] = [
      { value: '0', label: '0' },
      { value: '1', label: '1' },
    ];
    const maxOptions: DropdownOption[] = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => ({
      value: n.toString(),
      label: n.toString(),
    }));

    return (
      <div className="pt-4 space-y-4">
        <div className="flex items-center space-x-3">
          <div className="w-20">
            <CustomDropdown
              options={minOptions}
              value={question.scale.min.toString()}
              onChange={(val) => onChange({ scale: { ...question.scale, min: Number(val) } })}
              className="!py-1.5 !px-3 !text-sm"
            />
          </div>
          <span className="text-gray-400 font-medium">〜</span>
          <div className="w-20">
            <CustomDropdown
              options={maxOptions}
              value={question.scale.max.toString()}
              onChange={(val) => onChange({ scale: { ...question.scale, max: Number(val) } })}
              className="!py-1.5 !px-3 !text-sm"
            />
          </div>
        </div>
        <div className="bg-gray-50 p-6 rounded-xl mt-2 border border-gray-100">
          <div className="flex items-center space-x-4">
            <input 
              type="text" placeholder="下限ラベル(任意)" 
              value={question.scale.minLabel} 
              onChange={e => onChange({ scale: { ...question.scale, minLabel: e.target.value }})} 
              className="w-24 flex-shrink-0 text-sm text-center border-b border-gray-300 focus:border-blue-500 focus:outline-none bg-transparent pb-1 transition-colors" 
            />
            <div className="relative flex-1 overflow-hidden">
              {showLeftShadow && <div className="absolute left-0 top-0 bottom-0 w-24 bg-gradient-to-r from-gray-50 to-transparent z-10 pointer-events-none" />}
              {showRightShadow && <div className="absolute right-0 top-0 bottom-0 w-24 bg-gradient-to-l from-gray-50 to-transparent z-10 pointer-events-none" />}
              <div ref={scaleRef} onScroll={handleScaleScroll} className="overflow-x-auto">
                <div className="flex justify-center space-x-4 md:space-x-8 pb-1 min-w-max mx-auto">
                  {Array.from({ length: question.scale.max - question.scale.min + 1 }).map((_, i) => {
                    const num = question.scale.min + i;
                    return (
                      <div key={num} className="flex flex-col items-center space-y-2">
                        <span className="text-gray-700 font-bold">{num}</span>
                        <div className="w-5 h-5 border-2 border-gray-400 rounded-full bg-white shadow-sm" />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <input 
              type="text" placeholder="上限ラベル(任意)" 
              value={question.scale.maxLabel} 
              onChange={e => onChange({ scale: { ...question.scale, maxLabel: e.target.value }})} 
              className="w-24 flex-shrink-0 text-sm text-center border-b border-gray-300 focus:border-blue-500 focus:outline-none bg-transparent pb-1 transition-colors" 
            />
          </div>
        </div>
      </div>
    );
  };

  // --- UI: 長文入力 ---
  const renderMarkdown = () => {
    return (
      <div className="bg-gray-50 p-3 rounded-md border border-gray-200">
        <RichTextEditor 
          placeholder="回答者はここに長文を入力します。" 
          readOnly={true} 
        />
      </div>
    );
  };

  // ---  短文入力（フォーマット指定付き） ---
  const renderShortText = () => {
    const validationEnabled = question.shortTextValidation?.enabled;
    const multipleEnabled = question.shortTextMultiple?.enabled;
    
    return (
      <div className="pt-4 space-y-3">
        <input 
          type="text" 
          placeholder="回答者はここに短文を入力します。" 
          readOnly
          className="w-full md:w-1/2 border-b border-gray-300 border-dotted focus:outline-none py-2 text-sm text-gray-400 bg-transparent"
        />
        {/* 設定状況のバッジ */}
        {(validationEnabled || multipleEnabled) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {multipleEnabled && (
              <span className="inline-flex items-center gap-1 text-xs text-blue-600 bg-blue-50 border border-blue-200 px-2 py-1 rounded-full font-medium">
                複数回答: {question.shortTextMultiple?.style === 'none' ? 'なし' : question.shortTextMultiple?.style === 'bullet' ? '箇条書き' : question.shortTextMultiple?.style === 'number' ? '番号付き' : '矢印'}
              </span>
            )}
            {validationEnabled && (
              <span className="inline-flex items-center gap-1 text-xs text-orange-600 bg-orange-50 border border-orange-200 px-2 py-1 rounded-full font-medium">
                ※ 検証: {question.shortTextValidation?.type}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  // --- グリッド（プレビュー直接編集型） ---
  const renderGrid = () => {
    return (
      <div className="pt-4">
        <div className="flex justify-end items-center gap-3 mb-4">
          <div className="bg-gray-100 p-1 rounded-lg inline-flex">
            <button 
              onClick={() => onChange({ gridInputType: 'radio' })}
              className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${question.gridInputType === 'radio' ? 'bg-white shadow-sm text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}
            >
              ラジオ (単一)
            </button>
            <button 
              onClick={() => onChange({ gridInputType: 'checkbox' })}
              className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${question.gridInputType === 'checkbox' ? 'bg-white shadow-sm text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}
            >
              チェック (複数)
            </button>
          </div>
        </div>

        <div className="bg-gray-50 p-6 pb-3 rounded-xl border border-gray-200">
          <div className="flex justify-end mb-2">
            <button onClick={handleAddGridCol} className="text-blue-500 hover:text-blue-700 flex items-center font-bold text-sm">
              <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
              列を追加
            </button>
          </div>

          <div className="overflow-x-auto px-6 pb-3">
            <table className="w-full text-sm text-left border-separate border-spacing-y-2 border-spacing-x-4">
              <Droppable droppableId={`gridCols-${question.id}`} direction="horizontal" type="gridCols">
                {(provided) => (
                  <thead>
                    <tr ref={provided.innerRef} {...provided.droppableProps}>
                      <th className="pb-4 min-w-[120px]"></th>
                      {question.gridCols.map((col, index) => {
                        const isDuplicate = question.gridCols.some(other => other.id !== col.id && other.text.trim() !== '' && other.text.trim() === col.text.trim());
                        return (
                          <Draggable key={`col-${col.id.toString()}`} draggableId={`col-${col.id.toString()}`} index={index}>
                            {(provided, snapshot) => (
                              <th 
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                style={provided.draggableProps.style}
                                className={`pb-4 min-w-[100px] text-center group/col relative ${snapshot.isDragging ? 'opacity-80 bg-blue-50 z-50 rounded-lg shadow-sm' : ''}`}
                              >
                                <div className="flex flex-col items-center gap-1">
                                  <div 
                                    {...provided.dragHandleProps} 
                                    className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing transition-colors"
                                    title="列を移動"
                                  >
                                    <GripHorizontal className="w-4 h-4" />
                                  </div>
                                  <div className="flex items-center gap-1 w-full">
                                    <input 
                                      type="text" value={col.text} placeholder={`列 ${index + 1}`}
                                      onChange={e => handleUpdateGridCol(col.id, e.target.value)}
                                      className={`w-full text-center bg-transparent border-b transition-colors focus:outline-none pb-1 font-bold ${
                                        isDuplicate 
                                          ? 'border-red-500 text-red-600 focus:border-red-600' 
                                          : 'border-gray-300 focus:border-blue-500 text-gray-700'
                                      }`}
                                    />
                                    <button onClick={() => handleRemoveGridCol(col.id)} className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0">✕</button>
                                  </div>
                                </div>
                                {isDuplicate && (
                                  <p className="absolute left-1/2 -translate-x-1/2 -bottom-2 text-[8px] text-red-500 font-bold whitespace-nowrap bg-white px-1">重複</p>
                                )}
                              </th>
                            )}
                          </Draggable>
                        );
                      })}
                      {provided.placeholder}
                    </tr>
                  </thead>
                )}
              </Droppable>
              <Droppable droppableId={`gridRows-${question.id}`} type="gridRows">
                {(provided) => (
                  <tbody ref={provided.innerRef} {...provided.droppableProps}>
                      {question.gridRows.map((row, rowIndex) => {
                        const isDuplicate = question.gridRows.some(other => other.id !== row.id && other.text.trim() !== '' && other.text.trim() === row.text.trim());
                        return (
                          <Draggable key={`row-${row.id.toString()}`} draggableId={`row-${row.id.toString()}`} index={rowIndex}>
                            {(provided, snapshot) => (
                              <tr 
                                ref={provided.innerRef}
                                {...provided.draggableProps}
                                style={provided.draggableProps.style}
                                className={`group/row ${snapshot.isDragging ? 'opacity-80 bg-blue-50 z-50 shadow-sm' : ''}`}
                              >
                                <td className="py-2 px-2 relative">
                                  <div className="flex items-center gap-2">
                                    <div 
                                      {...provided.dragHandleProps} 
                                      className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing transition-colors flex-shrink-0"
                                      title="行を移動"
                                    >
                                      <GripVertical className="w-4 h-4" />
                                    </div>
                                    <input 
                                      type="text" value={row.text} placeholder={`行 ${rowIndex + 1}`}
                                      onChange={e => handleUpdateGridRow(row.id, e.target.value)}
                                      className={`flex-1 bg-transparent border-b transition-colors focus:outline-none py-1 font-bold ${
                                        isDuplicate 
                                          ? 'border-red-500 text-red-600 focus:border-red-600' 
                                          : 'border-transparent focus:border-blue-500 text-gray-700'
                                      }`}
                                    />
                                    <button onClick={() => handleRemoveGridRow(row.id)} className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0">✕</button>
                                  </div>
                                  {isDuplicate && (
                                    <p className="absolute left-10 -bottom-1 text-[8px] text-red-500 font-bold whitespace-nowrap bg-white px-1">重複しています</p>
                                  )}
                                </td>
                                {question.gridCols.map(col => (
                                  <td key={col.id} className="py-2 text-center border-y border-gray-100 shadow-sm bg-white">
                                    <div className={`mx-auto w-5 h-5 border-2 border-gray-300 ${question.gridInputType === 'radio' ? 'rounded-full' : 'rounded-md'}`} />
                                  </td>
                                ))}
                              </tr>
                            )}
                          </Draggable>
                        );
                      })}
                    {provided.placeholder}
                    <tr>
                      <td className="pt-4 pl-2">
                        <button onClick={handleAddGridRow} className="text-blue-500 hover:text-blue-700 flex items-center font-bold text-sm pl-7">
                          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                          行を追加
                        </button>
                      </td>
                      <td colSpan={question.gridCols.length} />
                    </tr>
                  </tbody>
                )}
              </Droppable>
            </table>
          </div>
        </div>
      </div>
    );
  };

  // --- UI: 日時選択 ---
  const renderDateTime = () => {
    return (
      <div className="pt-4 max-w-sm">
        <SmartDateTimePicker
          value={null}
          onChange={() => {}}
          format={{
            year: question.dateTimeSettings.format.year,
            month: question.dateTimeSettings.format.month,
            date: question.dateTimeSettings.format.date,
            hour: question.dateTimeSettings.format.hour,
            minute: question.dateTimeSettings.format.minute,
            second: question.dateTimeSettings.format.second,
            timezone: question.dateTimeSettings.format.timezone,
          }}
          timezone={formTimezone}
          is24h={question.dateTimeSettings.is24h}
          placeholder="回答者はここをクリックして選択します"
        />
        <p className="mt-2 text-[10px] text-gray-400 font-medium ml-1">
          ※ エディタ上ではプレビューのみ可能です
        </p>
      </div>
    );
  };

  // --- UI: ファイルアップロード ---
  const renderFileUpload = () => {
    return (
      <div className="pt-4 p-6 bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center gap-2">
        <UploadCloud className="w-10 h-10 text-gray-300" />
        <p className="text-sm font-bold text-gray-400">回答者はここにファイルをアップロードします</p>
        <div className="flex flex-wrap gap-2 justify-center mt-2">
          <span className="text-[10px] bg-white px-2 py-1 rounded border border-gray-100 text-gray-500 font-bold uppercase tracking-wider">
            最大 {question.fileUploadSettings?.maxFiles || 1} 個
          </span>
          <span className="text-[10px] bg-white px-2 py-1 rounded border border-gray-100 text-gray-500 font-bold uppercase tracking-wider">
            1ファイル最大 {question.fileUploadSettings?.maxSizeMB || 10} MB
          </span>
          <span className="text-[10px] bg-white px-2 py-1 rounded border border-gray-100 text-gray-500 font-bold uppercase tracking-wider">
            許可: {question.fileUploadSettings?.allowedTypes?.join(', ') || 'image, pdf'}
          </span>
        </div>
      </div>
    );
  };

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className={`relative w-full transition-all duration-150 ease-in-out 
        ${isActive && !isSortingGlobal ? 'border-3 border-blue-500' : 'border-3 border-gray-200'} 
        ${isSortingGlobal ? 'shadow-lg border-blue-400 scale-[0.98]' : 'shadow-sm p-6 pt-8 group focus-within:ring-2 focus-within:ring-blue-200'}
        ${isDragging ? 'bg-blue-200 ring-2 ring-blue-400 z-[100]' : 'bg-white'}
        rounded-xl`}>
        
        {/* 全体移動用のメインハンドル (絶対にアンマウントさせない) */}
        <div className={`absolute top-0 left-0 right-0 flex justify-center items-center group/main-handle z-50 pointer-events-none ${isSortingGlobal ? 'h-full bg-transparent' : 'h-8'}`}>
          <div 
            {...dragHandleProps}
            onPointerDown={() => {
              onStartSorting?.();
              dragHandleProps?.onPointerDown?.();
            }}
            onPointerUp={() => {
              // ドラッグが行われず、ただクリックして離しただけの場合はキャンセル
              if (!isDragging) {
                onCancelSorting?.();
              }
            }}
            className={`pointer-events-auto cursor-move flex items-center justify-center transition-all ${isSortingGlobal ? 'w-full h-full opacity-0' : 'w-16 h-1.5 rounded-full bg-gray-100 group-hover/main-handle:bg-blue-100 group-hover/main-handle:w-20'}`}
            title="質問を移動"
          >
            {!isSortingGlobal && (
              <GripHorizontal className="w-4 h-4 text-gray-300 group-hover/main-handle:text-blue-400" />
            )}
          </div>
        </div>

        {isSortingGlobal ? (
          /* --- コンパクト表示 --- */
          <div className="w-full px-6 py-3 flex items-center gap-5 pointer-events-none">
            <div className="text-blue-500">
              <GripVertical className="w-6 h-6" />
            </div>
            <div className="flex items-center gap-4 flex-1 min-w-0">
              <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
                {(() => {
                  const Icon = questionTypeIcons[question.type];
                  return <Icon className="w-6 h-6 text-blue-600" />;
                })()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-blue-500 uppercase tracking-wider mb-0.5">{question.type}</p>
                <h4 className="font-bold text-gray-800 truncate text-lg">
                  {question.title || '無題の質問'}
                </h4>
              </div>
            </div>
          </div>
        ) : (
          /* --- 通常表示 --- */
          <>
            {(() => {
              const Icon = questionTypeIcons[question.type];
        return Icon ? (
          <div className="absolute top-4 right-4 p-2 bg-blue-50 rounded-lg">
            <Icon className="w-5 h-5 text-blue-400" strokeWidth={2} />
          </div>
        ) : null;
      })()}
      
      <div className="flex flex-col space-y-4">
        
        <input 
          type="text" 
          placeholder="質問" 
          value={question.title}
          onChange={e => onChange({ title: e.target.value })}
          className="w-full md:w-2/3 text-xl font-medium bg-gray-50 p-3 rounded-md border-b-2 border-transparent focus:border-blue-600 focus:bg-white focus:outline-none transition-colors"
        />
        <RichTextEditor 
          value={question.description} 
          placeholder='質問の説明（任意）' 
          onChange={(html) => onChange({ description: html })}
        />

        {question.type === 'radio' && renderListOptions('radio')}
        {question.type === 'checkbox' && renderListOptions('checkbox')}
        {question.type === 'dropdown' && renderDropdown()}
        {question.type === 'scale' && renderScale()}
        {question.type === 'grid_radio' && renderGrid()}
        {question.type === 'short_text' && renderShortText()}
        {question.type === 'long_text_md' && renderMarkdown()}
        {question.type === 'date_time' && renderDateTime()}
        {question.type === 'file_upload' && renderFileUpload()}
        
        {!['radio', 'checkbox', 'dropdown', 'scale', 'long_text_md', 'short_text', 'grid_radio', 'date_time', 'file_upload'].includes(question.type) && (
          <div className="pt-4 p-4 bg-red-50 text-red-600 rounded-md flex items-center justify-center">
            <span className="font-bold">Invalid Question Type (未実装の形式です)</span>
          </div>
        )}

        <div className="pt-4 mt-4 border-t border-gray-100 flex justify-end">
          <label className="flex items-center cursor-pointer gap-2 group">
            <span className={`text-sm font-bold transition-colors ${question.isRequired ? 'text-blue-700' : 'text-gray-500 group-hover:text-gray-700'}`}>
              必須
            </span>
            <div className="relative">
              <input 
                type="checkbox" 
                className="sr-only" 
                checked={question.isRequired || false}
                onChange={(e) => onChange({ isRequired: e.target.checked })}
              />
              <div className={`block w-10 h-6 rounded-full transition-colors ${question.isRequired ? 'bg-blue-600' : 'bg-gray-200'}`}></div>
              <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${question.isRequired ? 'transform translate-x-4' : ''}`}></div>
            </div>
          </label>
        </div>
      </div>

            <QuestionMenu 
              currentType={question.type}
              onChangeType={(newType) => onChange({ type: newType })}
              isActive={isActive}
              onDelete={onDelete}
              question={question}
              onChange={onChange}
            />
          </>
        )}
      </div>
    </DragDropContext>
  );
}