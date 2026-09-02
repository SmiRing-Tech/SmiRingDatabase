import { ClipboardList } from 'lucide-react';

export default function SurveyPage() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 py-20 text-center">
      <div className="w-16 h-16 rounded-2xl bg-sky-50 flex items-center justify-center border border-sky-100 mb-4">
        <ClipboardList className="w-8 h-8 text-sky-400" />
      </div>
      <h1 className="text-xl font-black text-gray-900">アンケート</h1>
      <p className="text-sm text-slate-400 mt-2">準備中です</p>
    </div>
  );
}
