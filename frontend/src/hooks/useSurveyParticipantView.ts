import { useState } from 'react';
import type { ActiveSurvey } from './useConnectSurvey';

/**
 * Whether a non-host participant currently has the running survey on their stage. They can
 * put it aside ("あとで回答する") and bring it back from a pill; once submitted and closed it
 * stays gone. Keyed by survey id, so a newly started survey always opens.
 */
export function useSurveyParticipantView(survey: ActiveSurvey | null) {
  const [hiddenSurveyId, setHiddenSurveyId] = useState<string | null>(null);
  const [submittedSurveyId, setSubmittedSurveyId] = useState<string | null>(null);

  const isHidden = !!survey && hiddenSurveyId === survey.id;
  const isSubmitted = !!survey && submittedSurveyId === survey.id;

  return {
    isOnStage: !!survey && !isHidden,
    showReopenPill: !!survey && isHidden && !isSubmitted,
    isSubmitted,
    hide: () => survey && setHiddenSurveyId(survey.id),
    reopen: () => setHiddenSurveyId(null),
    markSubmitted: () => survey && setSubmittedSurveyId(survey.id),
  };
}
