import { VideoOff } from 'lucide-react';
import type { CameraOffNotice, GovernorMode } from './useLoadGovernor';
import type { GovernorStep, LoadSample } from './governorPolicy';

/** Shown when the governor had to switch the camera off; says why and what can be done. */
export function CameraOffDialog({
  notice,
  onClose,
  onTurnOffBackground,
}: {
  notice: CameraOffNotice;
  onClose: () => void;
  /** Background effect users: switch it off (the camera can then come back on lighter). */
  onTurnOffBackground: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-700 bg-gray-900 p-5 text-white shadow-2xl space-y-3">
        <div className="flex items-center gap-2">
          <VideoOff className="w-5 h-5 text-rose-400" />
          <h2 className="font-bold">カメラをOFFにしました</h2>
        </div>
        {notice.withBackground ? (
          <p className="text-sm text-gray-300 leading-relaxed">
            パソコンの負荷が高く、音声が途切れるおそれがあったため、カメラをOFFにしました。
            カメラをONにするには、背景エフェクトをOFFにする必要があります。
          </p>
        ) : (
          <p className="text-sm text-gray-300 leading-relaxed">
            パソコンの負荷が高く、音声が途切れるおそれがあったため、カメラをOFFにしました。
            カメラボタンからONに戻せますが、負荷が高いままだと再びOFFになることがあります。
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {notice.withBackground && (
            <button
              onClick={() => {
                onTurnOffBackground();
                onClose();
              }}
              className="px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm font-semibold"
            >
              背景エフェクトをOFFにする
            </button>
          )}
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-bold">
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

/** Live readout for calibration (localStorage smiring.debug.loadPanel = '1'). */
export function LoadGovernorPanel({
  mode,
  step,
}: {
  mode: GovernorMode;
  step: (GovernorStep & { sample: LoadSample }) | null;
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
        {st ? `${st.bgDowngraded ? 'bg↓ ' : ''}video${st.video}${st.cameraOffByGovernor ? ' camOFF' : ''}` : '-'}
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
              ? `${s.recv.streams}本 ${fmt(s.recv.decodedFps, 1)}fps decode ${fmt(s.recv.decodeMsPerFrame, 1)}ms drop ${fmt(s.recv.droppedPerSec, 1)}/s freeze ${s.recv.freezes} ${s.recv.maxHeight}p`
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
