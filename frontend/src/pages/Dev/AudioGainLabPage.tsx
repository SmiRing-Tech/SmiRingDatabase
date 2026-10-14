import { useCallback, useEffect, useRef, useState } from 'react';
import { AUDIO_CAPTURE_CONSTRAINTS } from '../../components/Connect/captureConstraints';
import { GtcrnNoiseCancelTrack } from '../../lib/audio/gtcrn/GtcrnNoiseCancelTrack';
import { keepAudioContextResumed } from '../../lib/audio/keepAudioContextResumed';
import { loadLevelMeter, MeteredStage } from '../../lib/audio/levelMeter';
import { amplitudeToDb, powerToDb, SILENCE_DB, type LevelSummary } from '../../lib/audio/levelStats';
import {
  DEFAULT_VOICE_FINISH,
  loadVoiceFinish,
  VoiceFinishChain,
  type VoiceCompression,
  type VoiceFinishParams,
} from '../../lib/audio/voiceFinish';
import type { VoiceLevelerState } from '../../lib/audio/voiceLeveler.worklet';

/**
 * Bench for "why does the other side sound quieter than on Zoom?" — measures speech level at
 * each point of the outgoing mic path, plus (optionally) what another tab is playing, so the
 * cause can be pinned down before anything gets built to fix it:
 *
 *  - マイク: the capture track exactly as the browser delivers it, i.e. after its own echo
 *    cancellation / noise suppression / AGC (on by default, as in the app — see
 *    AUDIO_CAPTURE_CONSTRAINTS). Low here = the mic/AGC is the problem.
 *  - GTCRN後: the same audio after the real GtcrnNoiseCancelTrack. The gate graph after it in
 *    the call is a 0/1 gain, and Opus doesn't change level, so this is what gets sent. Lower
 *    than マイク by more than a dB or two = noise cancellation is eating speech level.
 *  - 仕上げ後: an experimental VoiceFinishChain (EQ + compressor, lib/audio/voiceFinish.ts) after
 *    GTCRN, tunable live, for hearing whether it makes speech clearer before it goes in the call.
 *  - タブ音声: any tab's audio output via getDisplayMedia — Zoom's web client, Meet, or a Connect
 *    call in another tab — for comparing what each app actually plays out, same speaker, same
 *    passage.
 *
 * All stages present are measured over the same take, so they're directly comparable. Headline
 * number is the ITU-T P.56 active speech level (see lib/audio/levelStats.ts).
 *
 * Public in production like the blur lab (App.tsx): it only touches the visitor's own mic and
 * this site's own model files, and the point is being able to send it to someone whose machine
 * is the one that sounds quiet.
 */

type StageId = 'mic' | 'gtcrn' | 'finish' | 'tab';
const STAGE_IDS: StageId[] = ['mic', 'gtcrn', 'finish', 'tab'];
const STAGE_LABELS: Record<StageId, string> = {
  mic: 'マイク（ブラウザ処理後）',
  gtcrn: 'GTCRN後（＝今の通話で送信される音）',
  finish: '仕上げ後（試作）',
  tab: 'タブ音声（そのタブが再生している音）',
};

interface CaptureConfig {
  deviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  gtcrn: boolean;
  /** Adds the experimental 仕上げ stage. Its settings are tuned live, outside this config. */
  finish: boolean;
}

const APP_CAPTURE: CaptureConfig = {
  deviceId: '',
  echoCancellation: AUDIO_CAPTURE_CONSTRAINTS.echoCancellation === true,
  noiseSuppression: AUDIO_CAPTURE_CONSTRAINTS.noiseSuppression === true,
  autoGainControl: AUDIO_CAPTURE_CONSTRAINTS.autoGainControl === true,
  // On by default in the call (CallRoomPage's noiseCancelEnabled).
  gtcrn: true,
  // Not in the app (yet).
  finish: false,
};

const TOGGLES: Array<{ key: keyof Omit<CaptureConfig, 'deviceId'>; label: string }> = [
  { key: 'autoGainControl', label: 'ブラウザAGC' },
  { key: 'noiseSuppression', label: 'ブラウザのノイズ抑制' },
  { key: 'echoCancellation', label: 'エコーキャンセル' },
  { key: 'gtcrn', label: 'GTCRN（アプリのノイズキャンセル）' },
  { key: 'finish', label: '仕上げ（試作）を追加' },
];


const TAKE_SECONDS = [10, 20, 30, 60] as const;

const READING_PASSAGE =
  '今日は留学の準備について話します。まず、パスポートとビザの申請は早めに済ませておくことが大切です。' +
  '次に、現地での住まいと銀行口座の手続きを確認しておきましょう。航空券は、出発日が決まったらなるべく早く予約すると安く済みます。' +
  '最後に、困ったときに相談できる連絡先を、紙にも書いて持っておくと安心です。';

interface TakeResult {
  id: number;
  label: string;
  at: string;
  config: string;
  actualSettings: string;
  device: string;
  tab: string | null;
  stages: Partial<Record<StageId, LevelSummary>>;
  /** Blob URLs of what each stage sounded like during the take. */
  recordings: Partial<Record<StageId, string>>;
}

/** Opus where the browser can, as in the call itself (Opus keeps levels as they are, so a
 *  recording plays back as loud as the stage was); otherwise whatever it records natively. */
const RECORDING_MIME =
  typeof MediaRecorder === 'undefined'
    ? ''
    : (['audio/webm;codecs=opus', 'audio/mp4;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '');

interface Recording {
  /** Resolves to a blob URL, or null if nothing was recorded. */
  stop: () => Promise<string | null>;
}

function startRecording(stream: MediaStream): Recording | null {
  if (typeof MediaRecorder === 'undefined') return null;
  try {
    const recorder = new MediaRecorder(stream, { mimeType: RECORDING_MIME || undefined, audioBitsPerSecond: 64_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    // Also settles if the track ends mid-take (e.g. tab sharing stopped), which stops the recorder.
    const stopped = new Promise<string | null>((resolve) => {
      recorder.onstop = () =>
        resolve(chunks.length > 0 ? URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType })) : null);
      recorder.onerror = () => resolve(null);
    });
    recorder.start();
    return {
      stop: () => {
        if (recorder.state !== 'inactive') recorder.stop();
        return stopped;
      },
    };
  } catch {
    return null;
  }
}

const revokeRecordings = (results: TakeResult[]) => {
  for (const r of results) for (const url of Object.values(r.recordings)) if (url) URL.revokeObjectURL(url);
};

interface LiveLevel {
  rmsDb: number;
  peakDb: number;
}

const onOff = (v: boolean) => (v ? 'ON' : 'OFF');

const COMPRESSION_LABELS: Record<VoiceCompression, string> = { off: 'なし', light: '弱', strong: '強' };

const describeFinish = (f: VoiceFinishParams) =>
  `低域カット ${onOff(f.lowCut)} / 明瞭度 +${f.presenceDb}dB / コンプ ${COMPRESSION_LABELS[f.compression]} / 音量 ${f.gainDb >= 0 ? '+' : ''}${f.gainDb}dB / 高域補完 ${f.air}` +
  (f.leveler ? ` / レベラー 目標${f.levelerTargetDb}dB 最大+${f.levelerMaxGainDb}dB` : ' / レベラー OFF');

const describeConfig = (c: CaptureConfig, f: VoiceFinishParams) =>
  `AGC ${onOff(c.autoGainControl)} / NS ${onOff(c.noiseSuppression)} / AEC ${onOff(c.echoCancellation)} / GTCRN ${onOff(c.gtcrn)}` +
  (c.finish ? ` / 仕上げ: ${describeFinish(f)}` : '');

/** What the browser actually applied — it's free to ignore a constraint, and some do. */
const describeSettings = (s: MediaTrackSettings) =>
  `AGC=${s.autoGainControl ?? '?'} NS=${s.noiseSuppression ?? '?'} AEC=${s.echoCancellation ?? '?'} ${s.sampleRate ?? '?'}Hz`;

const fmtDb = (db: number | null | undefined) =>
  db === null || db === undefined ? '—' : db <= SILENCE_DB ? '無音' : db.toFixed(1);

const fmtDelta = (a: number | null | undefined, b: number | null | undefined) => {
  if (a === null || a === undefined || b === null || b === undefined) return '';
  const d = a - b;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}`;
};

const METER_MIN_DB = -70;
const meterPct = (db: number) => Math.max(0, Math.min(100, ((db - METER_MIN_DB) / -METER_MIN_DB) * 100));

function Meter({ label, level }: { label: string; level: LiveLevel | undefined }) {
  const rms = level?.rmsDb ?? SILENCE_DB;
  const peak = level?.peakDb ?? SILENCE_DB;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-300">{label}</span>
        <span className="tabular-nums text-gray-400">
          {level ? `RMS ${fmtDb(rms)} dB / ピーク ${fmtDb(peak)} dB` : '未接続'}
        </span>
      </div>
      <div className="relative h-3 rounded bg-gray-800 overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${meterPct(rms)}%` }} />
        <div
          className={`absolute inset-y-0 w-0.5 ${peak > -1 ? 'bg-rose-500' : 'bg-amber-300'}`}
          style={{ left: `${meterPct(peak)}%` }}
        />
        {/* -26 dB: ITU-T's standard normalisation level for test speech, as a visual anchor. */}
        <div className="absolute inset-y-0 w-px bg-sky-400/70" style={{ left: `${meterPct(-26)}%` }} />
      </div>
    </div>
  );
}

export default function AudioGainLabPage() {
  const [config, setConfig] = useState<CaptureConfig>(APP_CAPTURE);
  const [micOn, setMicOn] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [status, setStatus] = useState('停止中');
  const [error, setError] = useState('');
  const [actualSettings, setActualSettings] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [tabLabel, setTabLabel] = useState<string | null>(null);
  // Bumped whenever a stage is created or disposed, so effects that route stages re-run.
  const [stageEpoch, setStageEpoch] = useState(0);
  const [live, setLive] = useState<Partial<Record<StageId, LiveLevel>>>({});
  const [levelerLive, setLevelerLive] = useState<VoiceLevelerState | null>(null);
  const [monitor, setMonitor] = useState<'off' | 'mic' | 'gtcrn' | 'finish'>('off');
  const [finishParams, setFinishParams] = useState<VoiceFinishParams>(DEFAULT_VOICE_FINISH);
  const finishParamsRef = useRef(finishParams);
  const finishChainRef = useRef<VoiceFinishChain | null>(null);
  useEffect(() => {
    finishParamsRef.current = finishParams;
    finishChainRef.current?.apply(finishParams);
  }, [finishParams]);
  const [takeSec, setTakeSec] = useState<number>(20);
  const [takeLabel, setTakeLabel] = useState('');
  const [takeProgress, setTakeProgress] = useState<number | null>(null);
  const [results, setResults] = useState<TakeResult[]>([]);
  const [copied, setCopied] = useState(false);

  const audioRef = useRef<{ ctx: AudioContext; ready: Promise<void>; detach: () => void; monitorGain: GainNode } | null>(
    null,
  );
  const stagesRef = useRef<Partial<Record<StageId, MeteredStage>>>({});
  const tabStreamRef = useRef<MediaStream | null>(null);
  const takeRef = useRef<{
    startedAt: number;
    durationMs: number;
    timer: ReturnType<typeof setTimeout>;
    recordings: Partial<Record<StageId, Recording>>;
    result: Omit<TakeResult, 'stages' | 'recordings'>;
  } | null>(null);
  // For revoking the recordings' blob URLs on unmount.
  const resultsRef = useRef(results);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  /** Must be called from a click handler, before any await, so the context starts running. */
  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const ctx = new AudioContext();
      const detach = keepAudioContextResumed(ctx);
      void ctx.resume().catch(() => {});
      const monitorGain = ctx.createGain();
      monitorGain.connect(ctx.destination);
      audioRef.current = {
        ctx,
        ready: Promise.all([loadLevelMeter(ctx), loadVoiceFinish(ctx)]).then(() => undefined),
        detach,
        monitorGain,
      };
    }
    return audioRef.current;
  }, []);

  // --- mic + GTCRN stages: rebuilt whenever the capture settings change ---
  useEffect(() => {
    if (!micOn) return;
    const audio = audioRef.current;
    if (!audio) return;
    // The registry object itself never changes; only its entries do.
    const stages = stagesRef.current;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let gtcrn: GtcrnNoiseCancelTrack | null = null;
    let finishSource: MediaStreamAudioSourceNode | null = null;
    let finishChain: VoiceFinishChain | null = null;
    const owned: StageId[] = [];

    const addStage = (id: StageId, track: MediaStreamTrack) => {
      stages[id] = new MeteredStage(audio.ctx, new MediaStream([track]));
      owned.push(id);
      setStageEpoch((n) => n + 1);
    };

    void (async () => {
      try {
        const opened = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: config.deviceId ? { exact: config.deviceId } : undefined,
            echoCancellation: config.echoCancellation,
            noiseSuppression: config.noiseSuppression,
            autoGainControl: config.autoGainControl,
          },
        });
        // Cleanup may already have run while the permission prompt was up, with nothing to stop.
        if (cancelled) {
          opened.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = opened;
        await audio.ready;
        if (cancelled) return;
        const track = stream.getAudioTracks()[0];
        setDeviceLabel(track.label);
        setActualSettings(describeSettings(track.getSettings()));
        // Labels are only filled in once mic permission has been granted, i.e. now.
        void navigator.mediaDevices
          .enumerateDevices()
          .then((list) => !cancelled && setDevices(list.filter((d) => d.kind === 'audioinput')));
        addStage('mic', track);

        if (config.gtcrn) {
          setStatus('GTCRN を読み込み中…（初回は数秒かかります）');
          const created = await GtcrnNoiseCancelTrack.create(
            track,
            () => true,
            () => setError('この機械では GTCRN が処理しきれず、生マイクをそのまま通しています（GTCRN後 = マイク になります）。'),
          );
          if (cancelled) {
            created.stop();
            return;
          }
          gtcrn = created;
          addStage('gtcrn', created.track);
        }

        if (config.finish) {
          // After GTCRN when it's on — where it would sit in the call — else straight off the mic.
          finishSource = audio.ctx.createMediaStreamSource(new MediaStream([gtcrn?.track ?? track]));
          finishChain = new VoiceFinishChain(audio.ctx, finishParamsRef.current);
          finishChainRef.current = finishChain;
          const destination = audio.ctx.createMediaStreamDestination();
          finishSource.connect(finishChain.input);
          finishChain.output.connect(destination);
          addStage('finish', destination.stream.getAudioTracks()[0]);
        }
        setStatus('計測できます');
      } catch (e) {
        if (!cancelled) {
          setError(`マイクを開始できませんでした: ${String(e)}`);
          setStatus('停止中');
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const id of owned) {
        stages[id]?.dispose();
        delete stages[id];
      }
      finishSource?.disconnect();
      finishChain?.disconnect();
      if (finishChainRef.current === finishChain) finishChainRef.current = null;
      gtcrn?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      setStageEpoch((n) => n + 1);
    };
  }, [micOn, config]);

  const startMic = () => {
    ensureAudio();
    setError('');
    setStatus('マイクを起動中…');
    setMicOn(true);
  };

  const stopMic = () => {
    setMicOn(false);
    setMonitor('off');
    setStatus('停止中');
  };

  // --- tab audio stage ---
  const removeTab = useCallback(() => {
    stagesRef.current.tab?.dispose();
    delete stagesRef.current.tab;
    tabStreamRef.current?.getTracks().forEach((t) => t.stop());
    tabStreamRef.current = null;
    setTabLabel(null);
    setStageEpoch((n) => n + 1);
  }, []);

  const addTab = async () => {
    const audio = ensureAudio();
    setError('');
    let stream: MediaStream;
    try {
      // Video is required by the API; it's captured at 1fps and never looked at. No processing
      // on the audio: the point is measuring exactly what that tab plays out.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 1 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
      } as DisplayMediaStreamOptions);
    } catch (e) {
      if ((e as DOMException)?.name !== 'NotAllowedError') setError(`タブを取り込めませんでした: ${String(e)}`);
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      setError('音声が共有されませんでした。共有ダイアログで「タブ」を選び、「タブの音声も共有する」をオンにしてください。');
      return;
    }
    await audio.ready;
    removeTab();
    tabStreamRef.current = stream;
    stagesRef.current.tab = new MeteredStage(audio.ctx, new MediaStream([track]));
    setTabLabel(stream.getVideoTracks()[0]?.label || track.label || 'タブ');
    setStageEpoch((n) => n + 1);
    // The browser's own "共有を停止" bar ends the track.
    track.addEventListener('ended', removeTab);
  };

  // --- headphone monitor ---
  useEffect(() => {
    const audio = audioRef.current;
    const stage = monitor === 'off' ? undefined : stagesRef.current[monitor];
    if (!audio || !stage) return;
    stage.source.connect(audio.monitorGain);
    return () => {
      try {
        stage.source.disconnect(audio.monitorGain);
      } catch {
        // Already fully disconnected by dispose().
      }
    };
  }, [monitor, stageEpoch]);

  // --- live readout + take progress ---
  useEffect(() => {
    const id = setInterval(() => {
      const next: Partial<Record<StageId, LiveLevel>> = {};
      for (const stageId of STAGE_IDS) {
        const stage = stagesRef.current[stageId];
        if (!stage) continue;
        const { power, peak } = stage.live;
        next[stageId] = { rmsDb: powerToDb(power), peakDb: amplitudeToDb(peak) };
      }
      setLive(next);
      setLevelerLive(finishChainRef.current?.levelerState ?? null);
      const take = takeRef.current;
      if (take) setTakeProgress(Math.min(1, (performance.now() - take.startedAt) / take.durationMs));
    }, 100);
    return () => clearInterval(id);
  }, []);

  // --- takes ---
  const finishTake = useCallback(async () => {
    const take = takeRef.current;
    if (!take) return;
    takeRef.current = null;
    clearTimeout(take.timer);
    const stages: Partial<Record<StageId, LevelSummary>> = {};
    for (const id of STAGE_IDS) {
      const summary = stagesRef.current[id]?.endTake();
      if (summary) stages[id] = summary;
    }
    setTakeProgress(null);
    setTakeLabel('');
    const recordings: Partial<Record<StageId, string>> = {};
    await Promise.all(
      STAGE_IDS.map(async (id) => {
        const url = await take.recordings[id]?.stop();
        if (url) recordings[id] = url;
      }),
    );
    setResults((r) => [...r, { ...take.result, stages, recordings }]);
  }, []);

  const startTake = () => {
    const present = STAGE_IDS.filter((id) => stagesRef.current[id]);
    if (present.length === 0) return;
    const recordings: Partial<Record<StageId, Recording>> = {};
    for (const id of present) {
      const stage = stagesRef.current[id]!;
      stage.startTake();
      const recording = startRecording(stage.stream);
      if (recording) recordings[id] = recording;
    }
    const durationMs = takeSec * 1000;
    takeRef.current = {
      startedAt: performance.now(),
      durationMs,
      timer: setTimeout(() => void finishTake(), durationMs),
      recordings,
      result: {
        id: Date.now(),
        label: takeLabel.trim() || `計測 ${results.length + 1}`,
        at: new Date().toLocaleTimeString(),
        config: micOn ? describeConfig(config, finishParams) : '（マイクなし）',
        actualSettings: micOn ? actualSettings : '',
        device: micOn ? deviceLabel : '',
        tab: tabLabel,
      },
    };
    setTakeProgress(0);
  };

  // Unmount: stop everything this page opened.
  useEffect(
    () => () => {
      const take = takeRef.current;
      if (take) {
        clearTimeout(take.timer);
        for (const recording of Object.values(take.recordings)) void recording?.stop().then((url) => url && URL.revokeObjectURL(url));
      }
      revokeRecordings(resultsRef.current);
      tabStreamRef.current?.getTracks().forEach((t) => t.stop());
      const audio = audioRef.current;
      if (audio) {
        audio.detach();
        void audio.ctx.close().catch(() => {});
      }
    },
    [],
  );

  const reportMarkdown = useCallback(() => {
    const lines = [
      '## 音量計測（/dev/audio-gain-lab）',
      `- ブラウザ: ${navigator.userAgent}`,
      `- 日付: ${new Date().toLocaleString()}`,
      '- 発話レベル = ITU-T P.56 アクティブ音声レベル（dBov ≒ dBFS RMS）。単位は全て dB。',
      '',
      '| 計測 | 段 | 発話レベル | 対マイク | 発話率 | ノイズ床 | 大きめ(p95) | ピーク | クリップ | 構成 | 実際の設定 | デバイス |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const r of results) {
      for (const id of STAGE_IDS) {
        const s = r.stages[id];
        if (!s) continue;
        const isMicPath = id !== 'tab';
        lines.push(
          `| ${r.label} | ${STAGE_LABELS[id]} | ${fmtDb(s.activeLevelDb)} | ${
            id === 'gtcrn' || id === 'finish' ? fmtDelta(s.activeLevelDb, r.stages.mic?.activeLevelDb) : ''
          } | ${s.activityPct.toFixed(0)}% | ${fmtDb(s.noiseFloorDb)} | ${fmtDb(s.loudDb)} | ${fmtDb(s.peakDb)} | ${
            s.clippedSamples
          } | ${isMicPath ? r.config : ''} | ${isMicPath ? r.actualSettings : ''} | ${isMicPath ? r.device : r.tab ?? ''} |`,
        );
      }
    }
    return lines.join('\n');
  }, [results]);

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(reportMarkdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(`コピーできませんでした: ${String(e)}`);
    }
  };

  const taking = takeProgress !== null;
  const anyStage = Object.keys(live).length > 0;
  const selectClass = 'bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 disabled:opacity-50';
  const buttonClass = 'px-4 py-2 rounded-lg font-bold disabled:opacity-50';

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 p-6 space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold">音量計測</h1>
        <p className="text-xs text-gray-400">
          LiveKit サーバー不要。マイクの音を「ブラウザ処理後」「GTCRN後」の各段で同時に測り、同じ文章を読んだときの発話レベルを比較します。
          ほかのタブ（Zoom のブラウザ版・Meet・Connect）が再生している音も取り込んで測れます。
        </p>
        <p className="text-xs text-gray-400">
          状態: <span className="text-gray-200">{status}</span>
        </p>
      </header>

      {error && <p className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded-lg p-3">{error}</p>}

      <section className="space-y-3 border border-gray-800 rounded-2xl p-4">
        <h2 className="font-bold text-sm">1. 音源</h2>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          {!micOn ? (
            <button onClick={startMic} className={`${buttonClass} bg-indigo-600 hover:bg-indigo-500`}>
              マイク開始
            </button>
          ) : (
            <button onClick={stopMic} disabled={taking} className={`${buttonClass} bg-gray-800 hover:bg-gray-700`}>
              マイク停止
            </button>
          )}
          <label className="space-y-1">
            <span className="block text-gray-400">マイク</span>
            <select
              value={config.deviceId}
              onChange={(e) => setConfig((c) => ({ ...c, deviceId: e.target.value }))}
              disabled={taking}
              className={`${selectClass} max-w-64`}
            >
              <option value="">既定のマイク</option>
              {devices
                .filter((d) => d.deviceId && d.deviceId !== 'default')
                .map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </option>
                ))}
            </select>
          </label>
          {TOGGLES.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={config[key]}
                onChange={(e) => setConfig((c) => ({ ...c, [key]: e.target.checked }))}
                disabled={taking}
              />
              {label}
            </label>
          ))}
          <button
            onClick={() => setConfig((c) => ({ ...APP_CAPTURE, deviceId: c.deviceId }))}
            disabled={taking}
            className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
          >
            本番と同じ設定に戻す
          </button>
        </div>
        {micOn && actualSettings && (
          <p className="text-[11px] text-gray-500">
            実際に適用された設定: {actualSettings}（{deviceLabel}）
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 text-xs">
          {!tabLabel ? (
            <button onClick={() => void addTab()} disabled={taking} className={`${buttonClass} bg-emerald-700 hover:bg-emerald-600`}>
              タブ音声を追加
            </button>
          ) : (
            <button onClick={removeTab} disabled={taking} className={`${buttonClass} bg-gray-800 hover:bg-gray-700`}>
              タブ音声を外す
            </button>
          )}
          <span className="text-gray-400">{tabLabel ? `取り込み中: ${tabLabel}` : '共有ダイアログで「タブ」を選び、「タブの音声も共有する」をオンにしてください（Chrome / Edge）。'}</span>
        </div>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-gray-400">ヘッドホンで聴く</span>
          <select value={monitor} onChange={(e) => setMonitor(e.target.value as typeof monitor)} className={selectClass}>
            <option value="off">聴かない</option>
            <option value="mic" disabled={!live.mic}>
              マイク
            </option>
            <option value="gtcrn" disabled={!live.gtcrn}>
              GTCRN後
            </option>
            <option value="finish" disabled={!live.finish}>
              仕上げ後
            </option>
          </select>
          <span className="text-gray-500">スピーカーだとハウリングします。</span>
        </label>
        {/* Chrome's echo canceller takes everything Chrome plays out as the echo reference, so
            monitoring yourself (or playing back a recording) mid-take makes it treat your own
            voice as echo — eating consonants and word endings in a way a real call never would. */}
        {config.echoCancellation && (
          <p className={`text-[11px] ${monitor !== 'off' ? 'text-amber-300' : 'text-gray-500'}`}>
            エコーキャンセル ON のまま自分の声を聴いたり録音を再生したりすると、エコーキャンセラーが自分の声を「エコー」とみなして子音や語尾を削ります（実際の通話では起きない現象です）。
            エコーキャンセル ON の音を確かめるときは「聴かない」にして録音し、後から再生してください。
          </p>
        )}

        {config.finish && (
          <div className="space-y-2 border-t border-gray-800 pt-3 text-xs">
            <p className="text-gray-400">
              仕上げ（試作）の設定 — 計測中以外はいつでも変えられ、すぐ反映されます。「ヘッドホンで聴く」を「仕上げ後」にして喋りながら調整できます。
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={finishParams.lowCut}
                  onChange={(e) => setFinishParams((f) => ({ ...f, lowCut: e.target.checked }))}
                  disabled={taking}
                />
                低域カット（90Hz以下）
              </label>
              <label className="flex items-center gap-1.5">
                明瞭度（3kHz）
                <input
                  type="range"
                  min={0}
                  max={8}
                  step={1}
                  value={finishParams.presenceDb}
                  onChange={(e) => setFinishParams((f) => ({ ...f, presenceDb: Number(e.target.value) }))}
                  disabled={taking}
                />
                <span className="tabular-nums w-10">+{finishParams.presenceDb}dB</span>
              </label>
              <label className="flex items-center gap-1.5">
                コンプレッサー
                <select
                  value={finishParams.compression}
                  onChange={(e) => setFinishParams((f) => ({ ...f, compression: e.target.value as VoiceCompression }))}
                  disabled={taking}
                  className={selectClass}
                >
                  {(Object.keys(COMPRESSION_LABELS) as VoiceCompression[]).map((c) => (
                    <option key={c} value={c}>
                      {COMPRESSION_LABELS[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                音量
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={finishParams.gainDb}
                  onChange={(e) => setFinishParams((f) => ({ ...f, gainDb: Number(e.target.value) }))}
                  disabled={taking}
                />
                <span className="tabular-nums w-10">
                  {finishParams.gainDb >= 0 ? '+' : ''}
                  {finishParams.gainDb}dB
                </span>
              </label>
              <label className="flex items-center gap-1.5">
                高域補完（8kHz以上を疑似生成）
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={finishParams.air}
                  onChange={(e) => setFinishParams((f) => ({ ...f, air: Number(e.target.value) }))}
                  disabled={taking}
                />
                <span className="tabular-nums w-10">{finishParams.air === 0 ? 'OFF' : finishParams.air}</span>
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={finishParams.leveler}
                  onChange={(e) => setFinishParams((f) => ({ ...f, leveler: e.target.checked }))}
                  disabled={taking}
                />
                レベラー（声の大きさを数秒かけて揃える）
              </label>
              <label className="flex items-center gap-1.5">
                目標
                <input
                  type="range"
                  min={-34}
                  max={-14}
                  step={1}
                  value={finishParams.levelerTargetDb}
                  onChange={(e) => setFinishParams((f) => ({ ...f, levelerTargetDb: Number(e.target.value) }))}
                  disabled={taking || !finishParams.leveler}
                />
                <span className="tabular-nums w-12">{finishParams.levelerTargetDb}dB</span>
              </label>
              <label className="flex items-center gap-1.5">
                最大
                <input
                  type="range"
                  min={0}
                  max={18}
                  step={1}
                  value={finishParams.levelerMaxGainDb}
                  onChange={(e) => setFinishParams((f) => ({ ...f, levelerMaxGainDb: Number(e.target.value) }))}
                  disabled={taking || !finishParams.leveler}
                />
                <span className="tabular-nums w-12">+{finishParams.levelerMaxGainDb}dB</span>
              </label>
              {finishParams.leveler && levelerLive && (
                <span className="tabular-nums text-gray-300">
                  いまのゲイン {levelerLive.gainDb >= 0 ? '+' : ''}
                  {levelerLive.gainDb.toFixed(1)}dB ／ 声の大きさ {levelerLive.speechDb === null ? '—' : `${levelerLive.speechDb.toFixed(1)}dB`}
                  {levelerLive.speaking ? ' ●発話中' : ' ○（保持中）'}
                </span>
              )}
              <button
                onClick={() => setFinishParams(DEFAULT_VOICE_FINISH)}
                disabled={taking}
                className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50"
              >
                初期値に戻す
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3 border border-gray-800 rounded-2xl p-4">
        <h2 className="font-bold text-sm">2. レベル</h2>
        <div className="space-y-3">
          {STAGE_IDS.map((id) => (
            <Meter key={id} label={STAGE_LABELS[id]} level={live[id]} />
          ))}
        </div>
        <p className="text-[11px] text-gray-500">
          緑 = 直近0.1秒の RMS、黄の線 = 直近1秒のピーク（赤 = ほぼ 0dBFS で音割れ寸前）、青の線 = −26 dB（ITU-T の試験音声の標準レベル）。
        </p>
      </section>

      <section className="space-y-3 border border-gray-800 rounded-2xl p-4">
        <h2 className="font-bold text-sm">3. 計測</h2>
        <p className="text-xs text-gray-400">「計測開始」を押したら、下の文章を普段どおりの声で読んでください。読み終わっても計測時間いっぱいまで続けて大丈夫です（間は発話レベルに含まれません）。</p>
        <blockquote className="text-sm leading-relaxed bg-gray-900 border border-gray-800 rounded-xl p-3">{READING_PASSAGE}</blockquote>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="space-y-1">
            <span className="block text-gray-400">ラベル（例: 内蔵マイク 50cm）</span>
            <input
              value={takeLabel}
              onChange={(e) => setTakeLabel(e.target.value)}
              disabled={taking}
              className={`${selectClass} w-56`}
            />
          </label>
          <label className="space-y-1">
            <span className="block text-gray-400">計測秒数</span>
            <select value={takeSec} onChange={(e) => setTakeSec(Number(e.target.value))} disabled={taking} className={selectClass}>
              {TAKE_SECONDS.map((s) => (
                <option key={s} value={s}>
                  {s}秒
                </option>
              ))}
            </select>
          </label>
          {!taking ? (
            <button onClick={startTake} disabled={!anyStage} className={`${buttonClass} bg-indigo-600 hover:bg-indigo-500`}>
              計測開始
            </button>
          ) : (
            <button onClick={() => void finishTake()} className={`${buttonClass} bg-rose-600 hover:bg-rose-500`}>
              ここで終了
            </button>
          )}
        </div>
        {taking && (
          <div className="h-2 rounded bg-gray-800 overflow-hidden">
            <div className="h-full bg-indigo-500" style={{ width: `${(takeProgress ?? 0) * 100}%` }} />
          </div>
        )}
      </section>

      <section className="space-y-3 border border-gray-800 rounded-2xl p-4">
        <div className="flex items-center gap-3">
          <h2 className="font-bold text-sm">4. 結果</h2>
          <button
            onClick={() => void copyReport()}
            disabled={results.length === 0}
            className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-xs font-bold"
          >
            {copied ? 'コピーしました' : '表をコピー（Markdown）'}
          </button>
          <button
            onClick={() => {
              revokeRecordings(results);
              setResults([]);
            }}
            disabled={results.length === 0 || taking}
            className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-xs"
          >
            クリア
          </button>
        </div>
        {results.length === 0 ? (
          <p className="text-xs text-gray-500">まだ計測していません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-[11px] tabular-nums">
              <thead className="text-gray-400">
                <tr>
                  {['計測', '段', '発話レベル', '対マイク', '発話率', 'ノイズ床', '大きめ(p95)', 'ピーク', 'クリップ', '録音', '構成'].map((h) => (
                    <th key={h} className="text-left font-semibold pr-4 pb-1">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.flatMap((r) =>
                  STAGE_IDS.filter((id) => r.stages[id]).map((id, i) => {
                    const s = r.stages[id]!;
                    return (
                      <tr key={`${r.id}-${id}`} className={i === 0 ? 'border-t border-gray-800' : ''}>
                        <td className="pr-4 py-1">{i === 0 ? `${r.label}（${r.at}）` : ''}</td>
                        <td className="pr-4">{STAGE_LABELS[id]}</td>
                        <td className="pr-4 font-bold text-gray-100">{fmtDb(s.activeLevelDb)}</td>
                        <td className="pr-4">{id === 'gtcrn' || id === 'finish' ? fmtDelta(s.activeLevelDb, r.stages.mic?.activeLevelDb) : ''}</td>
                        <td className="pr-4">{s.activityPct.toFixed(0)}%</td>
                        <td className="pr-4">{fmtDb(s.noiseFloorDb)}</td>
                        <td className="pr-4">{fmtDb(s.loudDb)}</td>
                        <td className="pr-4">{fmtDb(s.peakDb)}</td>
                        <td className={`pr-4 ${s.clippedSamples > 0 ? 'text-rose-400' : ''}`}>{s.clippedSamples}</td>
                        <td className="pr-4 py-1">
                          {r.recordings[id] ? (
                            <audio controls preload="metadata" src={r.recordings[id]} className="h-8 w-56" />
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="pr-4 text-gray-400">{id === 'tab' ? r.tab : r.config}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="text-[11px] text-gray-500 space-y-1">
          <p>発話レベル: 声が出ている部分だけの平均レベル（ITU-T P.56）。間の長さに左右されないので、同じ文章を読んだ計測どうしを比べられます。</p>
          <p>対マイク: GTCRN を通したことで発話レベルが何 dB 変わったか。大きくマイナスなら、ノイズキャンセルが声まで削っています。</p>
          <p>
            録音: 「GTCRN後」が相手に送られる音そのものです（通話と同じ Opus で録音しているので、音量はそのまま）。いつも Connect を聞いている音量・ヘッドホンのまま再生すると、相手にどう聞こえているかに近くなります。
            本当に相手の耳に届いた音を確かめたいときは、別の端末で Connect に入り、その端末でこのページの「タブ音声を追加」から Connect のタブを録音してください。
          </p>
          <p>
            Zoom と比べるには: 相手に同じ文章を読んでもらい、それを受け取るこちら側で、Zoom のブラウザ版（app.zoom.us）や Meet、Connect を開いたタブを「タブ音声を追加」で取り込んで計測します。
            デスクトップ版 Zoom アプリはタブではないので取り込めません（Windows なら共有ダイアログで画面全体＋システム音声を選べば測れます）。
          </p>
        </div>
      </section>
    </div>
  );
}
