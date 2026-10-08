import { createPortal } from 'react-dom';
import { ClipboardList, Minus } from 'lucide-react';
import FormAnswerPage from '../../pages/Form/Answer/FormAnswerPage';
import type { ActiveSurvey } from '../../hooks/useConnectSurvey';
import type { FormGuest } from '../../lib/formGuest';

/** The survey form, sized to fill the call's stage (the film strip of faces stays beside/below it). */
export function SurveyStagePanel({
  survey,
  guest,
  isSubmitted,
  onHide,
  onSubmitted,
}: {
  survey: ActiveSurvey;
  guest?: FormGuest;
  isSubmitted: boolean;
  onHide: () => void;
  onSubmitted: () => void;
}) {
  return (
    <div className="w-full h-full bg-blue-50 rounded-2xl overflow-hidden flex flex-col shadow-2xl animate-in fade-in zoom-in-95 duration-200">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 bg-gray-900 text-white border-b border-gray-800">
        <ClipboardList className="w-4 h-4 text-sky-400 shrink-0" />
        <span className="flex-1 min-w-0 truncate text-xs font-bold">アンケート: {survey.form_title}</span>
        <button
          onClick={onHide}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-gray-300 hover:text-white hover:bg-gray-800 transition-colors shrink-0"
        >
          <Minus className="w-3.5 h-3.5" />
          {isSubmitted ? '閉じる' : 'あとで回答する'}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <FormAnswerPage
          key={survey.id}
          formId={survey.form_id}
          guest={guest}
          embedded={{ onClose: onHide, onSubmitted }}
        />
      </div>
    </div>
  );
}

export function SurveyReopenPill({ onClick }: { onClick: () => void }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <button
      onClick={onClick}
      className="fixed top-14 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold rounded-full shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200 active:scale-95"
    >
      <ClipboardList className="w-4 h-4" />
      アンケートに回答する
    </button>,
    document.body,
  );
}
