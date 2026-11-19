import type { GovernorMode } from './useLoadGovernor';
import type { GovernorStep, LoadSample } from './governorPolicy';

/** Live readout for calibration (localStorage smiring.debug.loadPanel = '1'). */
export function LoadGovernorPanel({
  mode,
  step,
  forcedRecv,
}: {
  mode: GovernorMode;
  step: (GovernorStep & { sample: LoadSample }) | null;
  /** Receive level forced by smiring.debug.recvLevel, if any. */
  forcedRecv?: number | null;
}) {
  const s = step?.sample;
  const st = step?.state;
  const fmt = (v: number | undefined, digits = 0) => (v === undefined ? '-' : v.toFixed(digits));
  const pressureColor =
    step?.verdict.pressure === 'overloaded'
      ? 'text-rose-400'
      : step?.verdict.pressure === 'calm'
        ? 'text-emerald-400'
        : 'text-amber-300';
  return (
    <div className="fixed bottom-24 left-3 z-[60] rounded-xl bg-black/80 border border-gray-700 px-3 py-2 text-[11px] leading-5 text-gray-200 font-mono pointer-events-none">
      <div>
        governor: {mode} | level{' '}
        {st
          ? `${st.bgDowngraded ? 'bg↓ ' : ''}video${st.video} recv${forcedRecv ?? st.recv}${forcedRecv != null ? '(強制)' : ''}${
              st.shareVp8 ? ' share→VP8' : ''
            }${st.share1080 ? ' share1080p' : ''}${st.share720 ? ' share720p' : ''}${st.photo ? ' photo' : ''}`
          : '-'}
      </div>
      <div className={pressureColor}>
        {step?.verdict.pressure ?? '...'} {step?.verdict.reasons.join(' ')}
      </div>
      {s && (
        <>
          <div>
            encCPU {fmt(s.encoderCpuFraction === undefined ? undefined : s.encoderCpuFraction * 100)}% | lag{' '}
            {fmt(s.mainLagMaxMs)}ms | longtask {fmt(s.longTaskMsPerSec)}ms/s
          </div>
          <div>
            bg {s.bgActive ? `${fmt(s.bgFps, 1)}/${fmt(s.bgExpectedFps)}fps ${fmt(s.bgCostMs, 1)}ms` : 'off'} | audio{' '}
            {s.audioActive ? `stress ${s.audioStressedChunks}/${s.audioChunks} pass ${s.audioPassthroughChunks} underrun ${s.audioUnderruns}` : 'off'}
          </div>
          <div>
            recv{' '}
            {s.recv?.streams
              ? `${s.recv.streams}本 ${fmt(s.recv.decodedFps, 1)}fps decode ${fmt(s.recv.decodeMsPerFrame, 1)}ms drop ${fmt(s.recv.droppedPerSec, 1)}/s freeze ${s.recv.freezes} ${s.recv.maxHeight}p | 間引き${s.recvControl?.throttled ?? 0}本 層なし${s.recvControl?.noLayers ?? 0}本`
              : 'none'}
          </div>
          <div>
            react {s.render ? `${fmt(s.render.perSec, 1)}回/s ${fmt(s.render.msPerSec, 1)}ms/s max ${fmt(s.render.maxMs, 1)}ms` : '-'}
          </div>
          <div>
            cam {s.cameraOn ? 'on' : 'off'} | share {s.sharing ? 'on' : 'off'} | {s.visible ? 'visible' : 'hidden'}
          </div>
        </>
      )}
    </div>
  );
}
