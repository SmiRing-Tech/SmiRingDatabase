import {
  Users,
  ClipboardList,
  BarChart3,
  Sparkles,
  TrendingUp,
} from 'lucide-react';

export default function EventOperationTab() {
  return (
    <div className="space-y-8 pb-20 animate-in fade-in duration-200">
      
      {/* ヘッダーエリア */}
      <div className="bg-gradient-to-r from-sky-50 via-blue-50 to-indigo-50 border border-sky-150/70 p-6 md:p-8 rounded-3xl flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sky-100/80 text-sky-700 text-xs font-black uppercase tracking-wider">
            <Sparkles className="w-3.5 h-3.5" />
            <span>運営・アナリティクス機能（開発中）</span>
          </div>
          <h2 className="text-xl md:text-2xl font-black text-slate-900 tracking-tight">
            イベント運営ダッシュボード
          </h2>
          <p className="text-xs md:text-sm text-slate-500 font-medium max-w-2xl leading-relaxed">
            イベントごとの参加申込者管理、当日の出席確認、事後アンケートの自動集計、そして全体の動員推移や参加者エンゲージメントのアナリティクスをここで一括管理できるようになります。
          </p>
        </div>
      </div>

      {/* 3大機能プレビューグリッド */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* 1. 申込者・参加者管理 */}
        <div className="bg-white rounded-3xl border border-slate-150 p-6 shadow-xs flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-sky-50 border border-sky-150 text-sky-600 flex items-center justify-center">
              <Users className="w-6 h-6" />
            </div>
            <h3 className="text-base font-black text-slate-900">
              申込者・参加者管理
            </h3>
            <p className="text-xs text-slate-500 font-medium leading-relaxed">
              各イベントの申込者リスト、当日のチェックイン管理、参加者ごとの属性データや質問事項を確認できます。
            </p>
          </div>
          <div className="pt-4 border-t border-slate-50">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full">
              Coming Soon
            </span>
          </div>
        </div>

        {/* 2. 事後アンケート集計 */}
        <div className="bg-white rounded-3xl border border-slate-150 p-6 shadow-xs flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-150 text-indigo-600 flex items-center justify-center">
              <ClipboardList className="w-6 h-6" />
            </div>
            <h3 className="text-base font-black text-slate-900">
              事後アンケート集計
            </h3>
            <p className="text-xs text-slate-500 font-medium leading-relaxed">
              My Forms と連携し、イベント終了後のアンケート自動配信と満足度スコア・感想コメントの自動グラフ化を行います。
            </p>
          </div>
          <div className="pt-4 border-t border-slate-50">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full">
              Coming Soon
            </span>
          </div>
        </div>

        {/* 3. 全体アナリティクス */}
        <div className="bg-white rounded-3xl border border-slate-150 p-6 shadow-xs flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-150 text-emerald-600 flex items-center justify-center">
              <BarChart3 className="w-6 h-6" />
            </div>
            <h3 className="text-base font-black text-slate-900">
              イベント推移アナリティクス
            </h3>
            <p className="text-xs text-slate-500 font-medium leading-relaxed">
              月別開催数、総参加者数の推移、リピート率、人気テーマの分析など、SmiRing全体のイベント効果を可視化します。
            </p>
          </div>
          <div className="pt-4 border-t border-slate-50">
            <span className="text-[11px] font-black uppercase tracking-wider text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full">
              Coming Soon
            </span>
          </div>
        </div>

      </div>

      {/* アナリティクスモックプレビューカード */}
      <div className="bg-white rounded-3xl border border-slate-150 p-6 md:p-8 space-y-6 opacity-70">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-slate-400" />
            <h4 className="text-sm font-black text-slate-700">
              イベント動員トレンド（プレビュー）
            </h4>
          </div>
          <span className="text-xs text-slate-400 font-bold">デモ表示</span>
        </div>

        <div className="h-48 rounded-2xl bg-slate-50 flex items-center justify-center border border-dashed border-slate-200">
          <div className="text-center space-y-1">
            <BarChart3 className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="text-xs font-bold text-slate-400">
              データ収集開始後にグラフが表示されます
            </p>
          </div>
        </div>
      </div>

    </div>
  );
}
