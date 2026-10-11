import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocalParticipant } from '@livekit/components-react';
import { Track, type LocalParticipant, type LocalVideoTrack } from 'livekit-client';
import { Activity, Check, Copy, Download, Loader2, X } from 'lucide-react';
import { diagEvent, diagState, downloadDiagnosticsFile } from '../../lib/connectDiagnostics';
import { copyText, diagnosticsResultMessage, type DiagnosticsController } from './useDiagnosticsController';
import {
  codecPublishOptions,
  readVideoCodecPreference,
  writeVideoCodecPreference,
  type VideoCodecPreference,
} from '../../lib/videoCodecPreference';

/**
 * UI for the in-call diagnostics recorder (lib/connectDiagnostics): a "通話の診断" row in the
 * control bar's "その他" menu, a dialog to start/stop it (plus the switches worth A/B-testing
 * while it runs), a recording pill so nobody forgets it's on, and the result dialog with the ID
 * to send. Written for non-engineers — every string here is meant to be followed without help.
 */

function useElapsed(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === null) return '0:00';
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- codec switch

/**
 * Republishes the camera with a different codec. A track's codec is fixed when it's published,
 * so switching mid-call means unpublishing it (without stopping it — the capture and any
 * background processor stay attached) and publishing it again; everyone sees this person's
 * camera blink for a moment. If the new codec fails to publish, falls back to the default so
 * the camera is never left unpublished.
 */
async function republishCamera(localParticipant: LocalParticipant, codec: VideoCodecPreference | undefined) {
  const publication = localParticipant.getTrackPublication(Track.Source.Camera);
  const track = publication?.track as LocalVideoTrack | undefined;
  if (!publication || !track) return;
  await localParticipant.unpublishTrack(track, false);
  try {
    await localParticipant.publishTrack(track, codecPublishOptions(codec));
    diagEvent('camera-republished', { codec: codec ?? 'default' });
  } catch (e) {
    diagEvent('camera-republish-failed', { codec: codec ?? 'default', error: String(e) });
    await localParticipant.publishTrack(track);
    throw e;
  }
}

function useCodecSwitch() {
  const { localParticipant, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const [codec, setCodec] = useState<VideoCodecPreference | undefined>(() => readVideoCodecPreference('camera'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    diagState('videoCodecPreference', codec ?? 'default(vp8)');
  }, [codec]);

  const select = useCallback(
    async (next: VideoCodecPreference | undefined) => {
      if (busy || next === codec) return;
      setBusy(true);
      setError('');
      writeVideoCodecPreference(next);
      setCodec(next);
      try {
        await republishCamera(localParticipant, next);
      } catch (e) {
        console.error('[Connect] camera codec switch failed:', e);
        setError('この方式に切り替えられなかったため、標準の方式に戻しました。');
        writeVideoCodecPreference(undefined);
        setCodec(undefined);
      } finally {
        setBusy(false);
      }
    },
    [busy, codec, localParticipant],
  );

  return { codec, select, busy, error, isCameraEnabled, isScreenShareEnabled };
}

// ---------------------------------------------------------------- UI pieces

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
        on ? 'bg-sky-500' : 'bg-gray-700'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
          on ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function ModalShell({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md bg-gray-900 border border-gray-700/80 rounded-2xl shadow-2xl p-5 text-white space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function ModalHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-sky-400" />
        <h3 className="font-bold text-sm">{title}</h3>
      </div>
      <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800 transition-colors">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/** Start/stop dialog, plus the switches worth comparing while recording. */
export function DiagnosticsDialog({
  controller,
  noiseCancelEnabled,
  setNoiseCancelEnabled,
  onClose,
}: {
  controller: DiagnosticsController;
  noiseCancelEnabled: boolean;
  setNoiseCancelEnabled: (value: boolean) => void;
  onClose: () => void;
}) {
  const elapsed = useElapsed(controller.startedAt);
  const codecSwitch = useCodecSwitch();

  return (
    <ModalShell onClose={onClose}>
      <ModalHeader title="通話の診断" onClose={onClose} />

      {!controller.recording ? (
        <>
          <p className="text-xs leading-relaxed text-gray-300">
            通話が重い・音が遅れる・画面が固まるといった原因を調べるために、この通話中のパソコンの動作状況（通信の速さや処理の重さなど）を記録します。
            <br />
            <span className="text-gray-400">声や映像そのものは記録されません。</span>
          </p>
          <ol className="text-xs leading-relaxed text-gray-300 list-decimal pl-5 space-y-1">
            <li>「記録を開始」を押す</li>
            <li>そのまま普段どおり通話する（重くなったら、そのまま続けてください）</li>
            <li>最後に「停止して送信」を押し、表示される診断IDを担当者に送る</li>
          </ol>
          <button
            onClick={() => {
              controller.start();
              onClose();
            }}
            className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-sm font-bold transition-colors"
          >
            記録を開始
          </button>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm font-bold">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse" />
            <span>記録中</span>
            <span className="tabular-nums text-gray-300">{elapsed}</span>
          </div>

          <div className="space-y-3 border-t border-gray-800 pt-3">
            <p className="text-[11px] font-bold text-gray-400">比較テスト（担当者に頼まれたときだけ切り替えてください）</p>

            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-gray-200">ノイズキャンセリング</p>
                <p className="text-[10px] text-gray-400">マイクメニューのものと同じスイッチです</p>
              </div>
              <Toggle on={noiseCancelEnabled} onClick={() => setNoiseCancelEnabled(!noiseCancelEnabled)} />
            </div>

            <div className="space-y-1.5">
              <div>
                <p className="text-xs font-bold text-gray-200">映像の送信方式</p>
                <p className="text-[10px] text-gray-400">
                  切り替えると、あなたのカメラ映像が一瞬止まります。
                  {codecSwitch.isScreenShareEnabled && '画面共有には、次に共有を始めたときから反映されます。'}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: undefined, label: '標準（VP8）' },
                  { value: 'h264', label: 'H.264' },
                ] as const).map((option) => {
                  const selected = codecSwitch.codec === option.value;
                  return (
                    <button
                      key={option.label}
                      onClick={() => void codecSwitch.select(option.value)}
                      disabled={codecSwitch.busy || !codecSwitch.isCameraEnabled}
                      className={`py-2 rounded-xl text-xs font-bold border transition-colors disabled:opacity-50 ${
                        selected
                          ? 'bg-sky-600/30 text-sky-300 border-sky-500/50'
                          : 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700'
                      }`}
                    >
                      {codecSwitch.busy && selected ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : option.label}
                    </button>
                  );
                })}
              </div>
              {!codecSwitch.isCameraEnabled && (
                <p className="text-[10px] text-amber-300">カメラをONにすると切り替えられます。</p>
              )}
              {codecSwitch.error && <p className="text-[10px] text-rose-300">{codecSwitch.error}</p>}
            </div>
          </div>

          <button
            onClick={() => {
              void controller.stopAndUpload();
              onClose();
            }}
            className="w-full py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-sm font-bold transition-colors"
          >
            停止して送信
          </button>
          <p className="text-[10px] text-gray-500 text-center">
            通話から退出する前に「停止して送信」を押してください。
          </p>
        </>
      )}
    </ModalShell>
  );
}

/** Upload progress / result. Rendered whenever the controller isn't idle. */
export function DiagnosticsResultDialog({ controller }: { controller: DiagnosticsController }) {
  const { phase, dismissResult } = controller;
  const [copiedAgain, setCopiedAgain] = useState(false);
  if (phase.kind === 'idle') return null;

  return (
    <ModalShell onClose={phase.kind === 'uploading' ? () => {} : dismissResult}>
      <ModalHeader title="通話の診断" onClose={phase.kind === 'uploading' ? () => {} : dismissResult} />

      {phase.kind === 'uploading' && (
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>記録を送信しています…</span>
        </div>
      )}

      {phase.kind === 'done' && (
        <>
          <p className="text-xs text-gray-300">送信が完了しました。下の診断IDを担当者に送ってください。</p>
          <div className="rounded-xl bg-gray-800 border border-gray-700 px-4 py-3 text-center">
            <p className="text-[10px] text-gray-400">診断ID</p>
            <p className="text-lg font-bold tracking-wider tabular-nums select-all">{phase.id}</p>
          </div>
          <button
            onClick={async () => setCopiedAgain(await copyText(diagnosticsResultMessage(phase.id)))}
            className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-sm font-bold transition-colors flex items-center justify-center gap-2"
          >
            {phase.copied || copiedAgain ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            <span>{phase.copied || copiedAgain ? 'コピーしました（もう一度コピー）' : '診断IDをコピー'}</span>
          </button>
        </>
      )}

      {phase.kind === 'failed' && (
        <>
          <p className="text-xs leading-relaxed text-gray-300">
            送信できませんでした。お手数ですが、下のボタンで記録をファイルとして保存し、そのファイルを担当者に送ってください。
          </p>
          <p className="text-[10px] text-gray-500 break-all">{phase.message}</p>
          <button
            onClick={() => downloadDiagnosticsFile(phase.log)}
            className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-sm font-bold transition-colors flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" />
            <span>ファイルを保存</span>
          </button>
        </>
      )}
    </ModalShell>
  );
}

/** Always-visible pill while recording, so nobody forgets it's on or can't find the stop button. */
export function DiagnosticsRecordingPill({
  controller,
  onOpen,
}: {
  controller: DiagnosticsController;
  onOpen: () => void;
}) {
  const elapsed = useElapsed(controller.startedAt);
  if (!controller.recording) return null;
  return (
    <button
      onClick={onOpen}
      className="absolute top-4 left-4 z-40 flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-950/85 border border-rose-500/50 backdrop-blur-md text-xs font-bold text-white shadow-xl hover:bg-gray-900"
    >
      <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
      <span>診断を記録中</span>
      <span className="tabular-nums text-gray-300">{elapsed}</span>
    </button>
  );
}

/** Row for the control bar's "その他" menu. */
export function DiagnosticsMenuItem({ recording, onClick }: { recording: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold text-gray-200 hover:bg-gray-800 transition-colors"
    >
      <Activity className={`w-4 h-4 ${recording ? 'text-rose-400' : 'text-sky-400'}`} />
      <span>{recording ? '通話の診断（記録中）' : '通話の診断'}</span>
    </button>
  );
}
