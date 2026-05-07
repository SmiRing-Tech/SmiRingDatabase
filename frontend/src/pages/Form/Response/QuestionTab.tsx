import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  PieChart, Pie, Cell, Tooltip,
  BarChart, Bar, XAxis, YAxis,
} from 'recharts';
import type { TabProps, ResponseSummary } from './types';
import { getDisplayName, CHART_COLORS } from './types';
import type { QuestionData } from '../FormEditor/FormEditorPage';
import NavSelector from './NavSelector';
import { richTextStyles } from '../../../components/ui/RichTextEditor';
import { ResponseCopyButton } from './components/ResponseCopyButton';
import { supabase } from '../../../lib/supabase';
import { 
  Download, ExternalLink, File as FileIcon, FileImage, 
  FileText, FileArchive, FileVideo, Music 
} from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

// ─── ResponsiveContainer 代替: ResizeObserver でコンテナ幅を計測 ─
function useContainerWidth(ref: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return width;
}

// ─── モーダルの型 ────────────────────────────────────
type ModalState = {
  questionTitle: string;
  optionLabel: string;
  respondents: { displayName: string; avatarLink: string | null }[];
};

// ─── メインコンポーネント ─────────────────────────────
export default function QuestionTab({ questions, responses, indexMap, isAnonymous }: TabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuestionId = searchParams.get('questionId') || null;

  const initialIndex = urlQuestionId
    ? Math.max(0, questions.findIndex(q => q.id === urlQuestionId))
    : 0;
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [modal, setModal] = useState<ModalState | null>(null);

  useEffect(() => {
    if (urlQuestionId) {
      const idx = questions.findIndex(q => q.id === urlQuestionId);
      if (idx >= 0) setSelectedIndex(idx);
    }
  }, [urlQuestionId, questions]);

  if (questions.length === 0) return null;

  const total = questions.length;
  const selectedQuestion = questions[selectedIndex];

  const navigateTo = (index: number) => {
    const clamped = Math.max(0, Math.min(total - 1, index));
    setSelectedIndex(clamped);
    const qId = questions[clamped]?.id;
    if (qId) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('questionId', qId);
        return next;
      });
    }
  };

  const openModal = (optionLabel: string, userIds: string[]) => {
    const respondents = userIds.map(uid => {
      const r = responses.find(r => r.user_id === uid);
      return {
        displayName: r ? getDisplayName(r, indexMap, isAnonymous) : '不明なユーザー',
        avatarLink: (r?.is_anonymous || isAnonymous) ? null : (r?.avatar_link ?? null),
      };
    });
    setModal({ questionTitle: selectedQuestion.title || '無題の質問', optionLabel, respondents });
  };

  // NavSelector用のアイテムリスト
  const navItems = questions.map((q, i) => ({
    label: `Q${i + 1}: ${q.title || '無題の質問'}`,
    sublabel: typeLabel(q.type),
  }));

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── ナビゲーションヘッダー ── */}
      <div className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-center gap-2 flex-shrink-0">
        <button
          onClick={() => navigateTo(selectedIndex - 1)}
          disabled={selectedIndex === 0}
          className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          title="前の質問"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>

        <NavSelector
          items={navItems}
          selectedIndex={selectedIndex}
          onChange={navigateTo}
        />

        <button
          onClick={() => navigateTo(selectedIndex + 1)}
          disabled={selectedIndex === total - 1}
          className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          title="次の質問"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* ── チャートコンテンツ ── */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto">
          {/* 質問タイトル */}
          <div className="mb-8">
            <p className="text-xs font-bold text-purple-400 uppercase tracking-widest mb-1">
              {typeLabel(selectedQuestion.type)}
            </p>
            <h3 className="text-2xl font-bold text-gray-800">{selectedQuestion.title || '無題の質問'}</h3>
            {selectedQuestion.description && (
              <p className="text-sm text-gray-500 mt-2"
                dangerouslySetInnerHTML={{ __html: selectedQuestion.description.replace(/<[^>]*>/g, '') }} />
            )}
            <p className="text-sm text-gray-400 mt-3">
              {responses.filter(r => {
                const v = r.content?.[selectedQuestion.id];
                return v !== null && v !== undefined && v !== '';
              }).length} 件の回答
            </p>
          </div>

          {/* チャート */}
          {(selectedQuestion.type === 'radio' || (selectedQuestion.type === 'dropdown' && !selectedQuestion.dropdownSettings?.multiple)) && (
            <PieChartView question={selectedQuestion} responses={responses} onBarClick={openModal} />
          )}
          {(selectedQuestion.type === 'checkbox' || selectedQuestion.type === 'scale' || (selectedQuestion.type === 'dropdown' && selectedQuestion.dropdownSettings?.multiple)) && (
            <BarChartView question={selectedQuestion} responses={responses} onBarClick={openModal} />
          )}
          {selectedQuestion.type === 'grid_radio' && (
            <GridBarView question={selectedQuestion} responses={responses} onBarClick={openModal} />
          )}
          {(selectedQuestion.type === 'short_text' || 
             selectedQuestion.type === 'long_text_md' || 
             selectedQuestion.type === 'date_time') && (
            <TextBubbleView question={selectedQuestion} responses={responses} indexMap={indexMap} isAnonymous={isAnonymous} />
          )}
          {selectedQuestion.type === 'file_upload' && (
            <FileResponseView question={selectedQuestion} responses={responses} indexMap={indexMap} isAnonymous={isAnonymous} />
          )}
        </div>
      </div>

      {modal && <RespondentModal modal={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

// ─── 🥧 円グラフ ──────────────────────────────────────
function PieChartView({ question, responses, onBarClick }: {
  question: QuestionData; responses: ResponseSummary[];
  onBarClick: (label: string, userIds: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);

  const countMap = new Map<string | number, string[]>();
  responses.forEach(r => {
    const val = r.content?.[question.id];
    if (val === null || val === undefined) return;
    if (!countMap.has(val)) countMap.set(val, []);
    countMap.get(val)!.push(r.user_id);
  });

  if (countMap.size === 0) return <EmptyChart />;

  const data = Array.from(countMap.entries()).map(([key, userIds], i) => {
    const labelStr = String(key);
    // テキストベースで現在の選択肢にあるか確認
    const isCurrent = question.options.some(o => o.text === labelStr);
    const label = isCurrent ? labelStr : `${labelStr} (旧選択肢)`;
    
    return { name: label, value: userIds.length, userIds, fill: CHART_COLORS[i % CHART_COLORS.length] };
  });
  const total = data.reduce((s, d) => s + d.value, 0);
  const h = 280;
  const cx = width / 2, cy = h / 2;

  const renderLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }: any) => {
    if (percent < 0.06) return null;
    const RADIAN = Math.PI / 180;
    const r = innerRadius + (outerRadius - innerRadius) * 0.5;
    return (
      <text x={cx + r * Math.cos(-midAngle * RADIAN)} y={cy + r * Math.sin(-midAngle * RADIAN)}
        fill="white" textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight="bold">
        {`${Math.round(percent * 100)}%`}
      </text>
    );
  };

  return (
    <div>
      <div ref={containerRef} className="w-full">
        {width > 0 && (
          <PieChart width={width} height={h}>
            <Pie data={data} cx={cx} cy={cy}
              innerRadius={65} outerRadius={110}
              dataKey="value" labelLine={false} label={renderLabel}
              isAnimationActive={false}
              onClick={(d: any) => onBarClick(d.name as string, d.userIds as string[])} cursor="pointer"
            >
              {data.map((d, i) => <Cell key={i} fill={d.fill} />)}
            </Pie>
            <Tooltip formatter={(v: unknown) => {
              const val = Number(v ?? 0);
              return [`${val}件 (${Math.round(val / total * 100)}%)`, ''];
            }} />
          </PieChart>
        )}
      </div>

      {/* 凡例 */}
      <div className="mt-4 space-y-2">
        {data.map((d, i) => (
          <button key={i} onClick={() => onBarClick(d.name, d.userIds)}
            className="w-full flex items-center gap-3 hover:bg-gray-50 rounded-lg p-2 transition-colors text-left">
            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: d.fill }} />
            <span className="text-sm text-gray-700 flex-1 truncate">{d.name}</span>
            <span className="text-sm font-bold text-gray-500">
              {d.value}件 ({Math.round(d.value / total * 100)}%)
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── 📊 棒グラフ (Rechartsの美しさを保ちつつグループ化に対応) ────────────────────────
function BarChartView({ question, responses, onBarClick }: {
  question: QuestionData; responses: ResponseSummary[];
  onBarClick: (label: string, userIds: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);

  const countMap = new Map<string | number, string[]>();
  const totalRespondents = responses.filter(r => {
    const val = r.content?.[question.id];
    return val !== null && val !== undefined && (Array.isArray(val) ? val.length > 0 : val !== '');
  }).length;

  responses.forEach(r => {
    const val = r.content?.[question.id];
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      val.forEach((text: any) => {
        const textStr = String(text);
        if (!countMap.has(textStr)) countMap.set(textStr, []);
        countMap.get(textStr)!.push(r.user_id);
      });
    } else {
      const textStr = String(val);
      if (!countMap.has(textStr)) countMap.set(textStr, []);
      countMap.get(textStr)!.push(r.user_id);
    }
  });

  // 平均値の計算 (スケール用)
  const scaleStats = useMemo(() => {
    if (question.type !== 'scale') return null;
    let sum = 0;
    let validCount = 0;
    responses.forEach(r => {
      const val = Number(r.content?.[question.id]);
      if (r.content?.[question.id] !== null && r.content?.[question.id] !== undefined && !isNaN(val)) {
        sum += val;
        validCount++;
      }
    });
    return {
      avg: validCount > 0 ? (sum / validCount).toFixed(1) : '0.0',
      total: validCount
    };
  }, [question, responses]);

  if (countMap.size === 0) return <EmptyChart />;

  // 最大値を見つける (全グラフでスケールを統一するため)
  let overallMaxCount = 0;
  countMap.forEach(ids => { if (ids.length > overallMaxCount) overallMaxCount = ids.length; });
  // スケールに余裕を持たせる
  const xDomainMax = Math.max(5, Math.ceil(overallMaxCount * 1.1));

  // データをラベルごとにグループ化
  type Group = { label: string | null; items: any[] };
  const groups: Group[] = [];
  const processedKeys = new Set<string>();

  if (question.type === 'scale') {
    // 🌟 スケール専用のグループ生成
    const scaleItems = [];
    const min = question.scale?.min ?? 1;
    const max = question.scale?.max ?? 5;
    for (let v = min; v <= max; v++) {
      const vStr = String(v);
      const userIds = countMap.get(vStr) ?? [];
      let name = vStr;
      if (v === min && question.scale?.minLabel) name += ` (${question.scale.minLabel})`;
      if (v === max && question.scale?.maxLabel) name += ` (${question.scale.maxLabel})`;
      
      scaleItems.push({ name, value: userIds.length, userIds });
      processedKeys.add(vStr);
    }
    groups.push({ label: null, items: scaleItems });
  } else {
    // 🌟 通常のオプションベースのグループ生成
    let currentGroup: Group = { label: null, items: [] };
    question.options.forEach(opt => {
      if (opt.isLabel) {
        if (currentGroup.items.length > 0 || currentGroup.label) {
          groups.push(currentGroup);
        }
        currentGroup = { label: opt.text, items: [] };
      } else {
        const count = countMap.get(opt.text)?.length ?? 0;
        currentGroup.items.push({
          name: opt.text,
          value: count,
          userIds: countMap.get(opt.text) ?? [],
        });
        processedKeys.add(opt.text);
      }
    });
    if (currentGroup.items.length > 0 || currentGroup.label) {
      groups.push(currentGroup);
    }
  }

  // 旧選択肢のグループ
  const oldItems = Array.from(countMap.entries())
    .filter(([key]) => !processedKeys.has(String(key)))
    .map(([key, userIds]) => ({
      name: String(key),
      value: userIds.length,
      userIds: userIds,
    }));
  
  if (oldItems.length > 0) {
    groups.push({ label: 'その他の過去の回答', items: oldItems });
  }

  const barH = 44;

  return (
    <div ref={containerRef} className="w-full space-y-8">
      {/* スケール用サマリー */}
      {scaleStats && (
        <div className="flex items-center gap-6 p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100/50 animate-in fade-in slide-in-from-top-2">
          <div>
            <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mb-1">平均スコア</p>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-black text-indigo-600">{scaleStats.avg}</span>
              <span className="text-xs font-bold text-indigo-400">/ {question.scale?.max}</span>
            </div>
          </div>
          <div className="h-10 w-px bg-indigo-100" />
          <div>
            <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mb-1">有効回答数</p>
            <p className="text-lg font-bold text-indigo-600">{scaleStats.total} <span className="text-xs font-medium">件</span></p>
          </div>
        </div>
      )}

      {width > 0 && groups.map((group, gIdx) => {
        if (group.items.length === 0) return null;
        const chartHeight = group.items.length * barH + 40; // 軸の余白分
        const isLastGroup = gIdx === groups.length - 1;

        return (
          <div key={gIdx} className="animate-in fade-in duration-500">
            {group.label && (
              <div className="mb-2 flex items-center gap-2">
                <div className="h-4 w-1 bg-blue-500 rounded-full" />
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">
                  {group.label}
                </span>
              </div>
            )}
            <BarChart
              width={width}
              height={chartHeight}
              data={group.items}
              layout="vertical"
              margin={{ left: 0, right: 40, top: 10, bottom: 0 }}
            >
              <XAxis 
                type="number" 
                hide={!isLastGroup} 
                domain={[0, xDomainMax]} 
                tick={{ fontSize: 10, fill: '#94a3b8' }}
                axisLine={{ stroke: '#e2e8f0' }}
              />
              <YAxis 
                type="category" 
                dataKey="name" 
                width={120} 
                tick={{ fontSize: 11, fill: '#475569' }}
                axisLine={{ stroke: '#e2e8f0' }}
              />
              <Tooltip 
                cursor={{ fill: '#f8fafc' }}
                formatter={(v: unknown) => {
                  const count = Number(v ?? 0);
                  const p = totalRespondents > 0 ? Math.round((count / totalRespondents) * 100) : 0;
                  return [`${count}件 (${p}%)`, '回答数'];
                }}
              />
              <Bar 
                dataKey="value" 
                isAnimationActive={false}
                radius={[0, 4, 4, 0]}
                onClick={(d: any) => d.value > 0 && onBarClick(d.name, d.userIds)}
                cursor="pointer"
              >
                {group.items.map((_, i) => (
                  <Cell 
                    key={i} 
                    fill={question.type === 'scale' ? '#6366f1' : CHART_COLORS[i % CHART_COLORS.length]} 
                    fillOpacity={0.8} 
                  />
                ))}
              </Bar>
            </BarChart>
          </div>
        );
      })}
    </div>
  );
}

// ─── 📊📊 グリッド ────────────────────────────────────
function GridBarView({ question, responses, onBarClick }: {
  question: QuestionData; responses: ResponseSummary[];
  onBarClick: (label: string, userIds: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);

  return (
    <div ref={containerRef} className="w-full space-y-8">
      {question.gridRows.map((row, ri) => {
        const countMap = new Map<string | number, string[]>();
        responses.forEach(r => {
          const gridAns = r.content?.[question.id];
          if (!gridAns || typeof gridAns !== 'object') return;
          // 行・列ともにテキストベースで取得
          const val = gridAns[row.text];
          if (val !== null && val !== undefined) {
            if (Array.isArray(val)) {
              val.forEach((v: any) => {
                const vStr = String(v);
                if (!countMap.has(vStr)) countMap.set(vStr, []);
                countMap.get(vStr)!.push(r.user_id);
              });
            } else {
              const vStr = String(val);
              if (!countMap.has(vStr)) countMap.set(vStr, []);
              countMap.get(vStr)!.push(r.user_id);
            }
          }
        });

        const data = question.gridCols.map(col => ({
          name: col.text || String(col.id),
          value: countMap.get(col.text)?.length ?? 0,
          userIds: countMap.get(col.text) ?? [],
          label: `${row.text}: ${col.text}`,
        }));

        // 現在の列設定にない回答（旧選択肢）があれば追加
        const currentColTexts = new Set(question.gridCols.map(c => c.text));
        countMap.forEach((userIds, text) => {
          if (!currentColTexts.has(String(text))) {
            data.push({
              name: `${text} (旧選択肢)`,
              value: userIds.length,
              userIds: userIds,
              label: `${row.text}: ${text} (旧選択肢)`,
            });
          }
        });

        const h = Math.max(160, data.length * 44);

        return (
          <div key={row.id}>
            <p className="text-sm font-bold text-gray-600 mb-3">▸ {row.text || `行 ${ri + 1}`}</p>
            {width > 0 && (
              <BarChart width={width} height={h} data={data} layout="vertical"
                margin={{ left: 8, right: 32, top: 4, bottom: 4 }}>
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: unknown) => [`${Number(v ?? 0)}件`, '回答数']} />
                <Bar dataKey="value" radius={[0, 6, 6, 0]} cursor="pointer" isAnimationActive={false}
                  onClick={(d: any) => Number(d.value) > 0 && onBarClick(d.payload.label as string, d.payload.userIds as string[])}>
                  {data.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Bar>
              </BarChart>
            )}
          </div>
        );
      })}
    </div>
  );
}



// ─── 💬 テキスト吹き出し ─────────────────────────────
const formatValue = (value: any, question: QuestionData) => {
  if (!value) return '';
  const valStr = String(value);

  try {
    if (question.type === 'date_time' && question.dateTimeSettings) {
      const d = new Date(valStr);
      if (isNaN(d.getTime())) return valStr;

      const fmt = question.dateTimeSettings.format;
      const hasDate = fmt.year || fmt.month || fmt.date;
      const hasTime = fmt.hour || fmt.minute;

      if (hasDate && hasTime) {
        return d.toLocaleString('ja-JP', { 
          year: fmt.year ? 'numeric' : undefined,
          month: fmt.month ? 'long' : undefined,
          day: fmt.date ? 'numeric' : undefined,
          weekday: hasDate ? 'short' : undefined,
          hour: fmt.hour ? '2-digit' : undefined,
          minute: fmt.minute ? '2-digit' : undefined,
        });
      } else if (hasDate) {
        return d.toLocaleDateString('ja-JP', { 
          year: fmt.year ? 'numeric' : undefined,
          month: fmt.month ? 'long' : undefined,
          day: fmt.date ? 'numeric' : undefined,
          weekday: 'short'
        });
      } else if (hasTime) {
        return d.toLocaleTimeString('ja-JP', { 
          hour: fmt.hour ? '2-digit' : undefined,
          minute: fmt.minute ? '2-digit' : undefined,
        });
      }
    }
  } catch (e) {
    console.error('Format error:', e);
  }

  return valStr;
};

function TextBubbleView({ question, responses, indexMap, isAnonymous }: {
  question: QuestionData; responses: ResponseSummary[]; indexMap: Map<string, number>; isAnonymous: boolean;
}) {
  const answered = responses.filter(r => {
    const v = r.content?.[question.id];
    return v !== null && v !== undefined && v !== '';
  });
  if (answered.length === 0) return <EmptyChart />;

  return (
    <div className="space-y-3">
      {answered.map(r => {
        const rawValue = r.content?.[question.id];
        const isLongText = question.type === 'long_text_md';
        const formattedText = isLongText ? String(rawValue ?? '') : formatValue(rawValue, question);
        const date = new Date(r.submitted_at).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });

        return (
          <div key={r.response_id} className="flex gap-3 items-start">
            <div className="w-8 h-8 rounded-full bg-purple-100 flex-shrink-0 flex items-center justify-center text-sm font-bold text-purple-700 overflow-hidden">
              {!(r.is_anonymous || isAnonymous) && r.avatar_link
                ? <img src={r.avatar_link} className="w-full h-full object-cover" alt="" />
                : getDisplayName(r, indexMap, isAnonymous).charAt(0)}
            </div>
            <div className="flex-1 bg-white rounded-2xl rounded-tl-none px-4 py-3 border border-gray-100 shadow-sm">
              <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-50">
                <span className="text-xs font-bold text-gray-500">{getDisplayName(r, indexMap, isAnonymous)}</span>
                <span className="text-[10px] text-gray-300">{date}</span>
              </div>
              {isLongText ? (
                <div className="relative">
                  <div 
                    className={`text-sm text-gray-700 break-words ${richTextStyles} pb-4`}
                    dangerouslySetInnerHTML={{ __html: formattedText }}
                  />
                  <div className="flex justify-end pt-2 mt-2 border-t border-gray-50">
                    <ResponseCopyButton html={formattedText} />
                  </div>
                </div>
              ) : (
                <div className="relative">
                  <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{formattedText}</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── 📂 ファイル回答表示 ─────────────────────────────
const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const FileIconComponent = ({ type }: { type: string }) => {
  if (type.startsWith('image/')) return <FileImage className="w-5 h-5 text-blue-500" />;
  if (type.startsWith('video/')) return <FileVideo className="w-5 h-5 text-purple-500" />;
  if (type.startsWith('audio/')) return <Music className="w-5 h-5 text-pink-500" />;
  if (type.includes('pdf')) return <FileText className="w-5 h-5 text-red-500" />;
  if (type.includes('zip') || type.includes('archive')) return <FileArchive className="w-5 h-5 text-orange-500" />;
  return <FileIcon className="w-5 h-5 text-gray-500" />;
};

const PdfPreview = ({ url }: { url: string }) => {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let isMounted = true;
    const generate = async () => {
      try {
        const loadingTask = pdfjsLib.getDocument(url);
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 0.4 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.height = viewport.height;
        canvas.width = viewport.width;
        await (page as any).render({ canvasContext: context, viewport }).promise;
        
        if (isMounted) setThumbnail(canvas.toDataURL());
      } catch (err) {
        console.error('PDF preview failed:', err);
        if (isMounted) setError(true);
      }
    };
    generate();
    return () => { isMounted = false; };
  }, [url]);

  if (thumbnail) return <img src={thumbnail} className="w-full h-full object-cover" alt="" />;
  return (
    <div className="flex flex-col items-center justify-center gap-2">
      <FileText className={`w-6 h-6 ${error ? 'text-red-300' : 'text-red-500 animate-pulse'}`} />
      {!error && <span className="text-[8px] text-gray-400 font-bold uppercase">Loading PDF...</span>}
    </div>
  );
};

function FileResponseView({ question, responses, indexMap, isAnonymous }: {
  question: QuestionData; responses: ResponseSummary[]; indexMap: Map<string, number>; isAnonymous: boolean;
}) {
  const answered = responses.filter(r => {
    const v = r.content?.[question.id];
    return Array.isArray(v) && v.length > 0;
  });

  if (answered.length === 0) return <EmptyChart />;

  return (
    <div className="space-y-6">
      {answered.map(r => {
        const files = (r.content?.[question.id] || []) as any[];
        return (
          <div key={r.response_id} className="flex gap-4 items-start">
            <div className="w-10 h-10 rounded-full bg-purple-100 flex-shrink-0 flex items-center justify-center text-sm font-bold text-purple-700 overflow-hidden shadow-sm">
              {!(r.is_anonymous || isAnonymous) && r.avatar_link
                ? <img src={r.avatar_link} className="w-full h-full object-cover" alt="" />
                : getDisplayName(r, indexMap, isAnonymous).charAt(0)}
            </div>
            <div className="flex-1 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-gray-700">{getDisplayName(r, indexMap, isAnonymous)}</span>
                <span className="text-[10px] text-gray-400 font-medium">
                  {new Date(r.submitted_at).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {files.map((file, fIdx) => {
                  const isImage = file.type?.startsWith('image/');
                  const isPdf = file.type?.includes('pdf');
                  const fileUrl = file.url || '';

                  return (
                    <div key={fIdx} className="group bg-white border border-gray-100 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-blue-100 transition-all">
                      {(isImage || isPdf) ? (
                        <div className="aspect-video bg-gray-50 relative overflow-hidden flex items-center justify-center">
                          {isImage ? (
                            <img src={fileUrl} className="w-full h-full object-cover" alt={file.name} />
                          ) : (
                            <PdfPreview url={fileUrl} />
                          )}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                             <a href={fileUrl} target="_blank" rel="noreferrer" className="p-2 bg-white rounded-full shadow-lg hover:scale-110 transition-transform">
                               <ExternalLink className="w-4 h-4 text-gray-700" />
                             </a>
                          </div>
                        </div>
                      ) : (
                        <div className="aspect-video bg-gray-50 flex items-center justify-center border-b border-gray-50">
                          <FileIconComponent type={file.type} />
                        </div>
                      )}
                      <div className="p-3">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-gray-800 truncate" title={file.name}>{file.name}</p>
                            <p className="text-[10px] text-gray-400 font-medium">{formatSize(file.size || 0)}</p>
                          </div>
                          <a 
                            href={fileUrl} 
                            download={file.name}
                            className="p-1.5 bg-gray-50 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors flex-shrink-0"
                            title="ダウンロード"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        </div>
                        {!isImage && (
                          <a 
                            href={fileUrl} 
                            target="_blank" 
                            rel="noreferrer"
                            className="w-full py-1.5 flex items-center justify-center gap-1.5 text-[10px] font-bold text-gray-500 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
                          >
                            <ExternalLink className="w-3 h-3" /> ブラウザで開く
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── 回答なし ─────────────────────────────────────────
function EmptyChart() {
  return <p className="text-sm text-gray-400 italic text-center py-8">回答データがありません</p>;
}

// ─── 回答者モーダル ───────────────────────────────────
function RespondentModal({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}>
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col animate-in zoom-in-95 duration-200 relative"
        onClick={e => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors">
          <X className="w-5 h-5" />
        </button>
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <p className="text-xs text-gray-400 font-medium mb-1 pr-8">{modal.questionTitle}</p>
          <h3 className="text-xl font-bold text-gray-900">{modal.optionLabel}</h3>
          <p className="text-sm text-gray-500 mt-1">{modal.respondents.length} 件の回答</p>
        </div>
        <div className="overflow-y-auto p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {modal.respondents.map((r, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                <div className="w-9 h-9 rounded-full bg-purple-100 flex-shrink-0 overflow-hidden flex items-center justify-center text-sm font-bold text-purple-700">
                  {r.avatarLink
                    ? <img src={r.avatarLink} className="w-full h-full object-cover" alt="" />
                    : r.displayName.charAt(0)}
                </div>
                <span className="text-sm font-medium text-gray-700 truncate">{r.displayName}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 質問タイプの表示名 ───────────────────────────────
function typeLabel(type: string): string {
  const map: Record<string, string> = {
    radio: 'ラジオボタン', dropdown: 'ドロップダウン', checkbox: 'チェックボックス',
    scale: 'スケール', grid_radio: 'グリッド', short_text: '短文入力', long_text_md: '長文入力',
  };
  return map[type] ?? type;
}
