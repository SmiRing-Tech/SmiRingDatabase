import BackgroundControls from '../../pages/Connect/BackgroundControls';
import type { BackgroundEffectState } from '../../pages/Connect/useBackgroundEffect';

/**
 * Background picker for the pre-join screen.
 *
 * Deliberately an inline panel rather than a modal: the effect renders in
 * <PreJoin>'s own preview just above, and covering that preview with a dialog
 * would hide the one thing the user is trying to look at while choosing.
 *
 * Purely presentational — the state and the processor live in usePreJoinBackground.
 */
export default function PreJoinBackgroundPanel({
  open,
  state,
}: {
  open: boolean;
  state: BackgroundEffectState;
}) {
  if (!open) return null;

  return (
    <div className="max-w-[480px] mx-auto mt-2 px-1">
      <div className="rounded-2xl border border-slate-200 bg-slate-900 p-4 shadow-sm text-white">
        <BackgroundControls state={state} />
      </div>
    </div>
  );
}
