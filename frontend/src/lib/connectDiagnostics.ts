import { apiRequest } from './apiClient';

/**
 * In-call diagnostics recorder for SmiRing Connect — the "通話の診断" button in the call's
 * "その他" menu. Built so a non-engineer can press start at the beginning of a meeting, keep
 * talking, press stop at the end, and send the developer a short ID: the full log goes straight
 * to R2 (POST /api/connect/rooms/:roomId/diagnostics) instead of through the clipboard, since an
 * hour of samples is far past what any chat tool accepts. Developers pull it back down with
 * `backend/src/scripts/connectDiagnostics.ts`.
 *
 * Module-level on purpose, not React state: the pieces that feed it live all over the call —
 * the stats sampler, the GTCRN pipeline, the background processor, the media toggles — and a
 * singleton lets each of them report without threading a context through every layer.
 *
 * Three kinds of data end up in a log:
 *  - `events`: what happened and when — every `diagState()` change (camera/mic/noise-cancel/
 *    background/screen share/... on or off), plus discrete room events (reconnects, joins).
 *  - `samples`: the 2s WebRTC stats from useCallStatsLogger, plus one row per registered probe
 *    per tick (GTCRN inference timing and backlog, background-effect frame cost, main-thread
 *    stalls) — the numbers the events are read against.
 *  - `env`: one-off facts about the machine — CPU cores, memory, GPU renderer (software
 *    rendering shows up here), battery, and whether the browser reports hardware encoders.
 *
 * Nothing here records audio or video content.
 */

export type DiagnosticsEntry = { t: number } & Record<string, unknown>;

export interface DiagnosticsLog {
  version: 1;
  startedAt: number;
  endedAt: number;
  context: Record<string, unknown>;
  env: Record<string, unknown>;
  initialState: Record<string, unknown>;
  events: DiagnosticsEntry[];
  samples: DiagnosticsEntry[];
  /** True once MAX_SAMPLES was hit and later samples were dropped (events never are). */
  truncated: boolean;
}

/** A probe reports its numbers since the previous call — it is read once per sampling tick. */
export type DiagnosticsProbe = () => Record<string, unknown> | null | undefined;

/** ~3h of a 20-person call at the 2s sampling rate. Keeps the upload well under the backend limit. */
const MAX_SAMPLES = 150_000;
const LAG_PROBE_INTERVAL_MS = 100;

interface Session {
  startedAt: number;
  context: Record<string, unknown>;
  env: Record<string, unknown>;
  initialState: Record<string, unknown>;
  events: DiagnosticsEntry[];
  samples: DiagnosticsEntry[];
  truncated: boolean;
  stopMonitors: () => void;
}

let session: Session | null = null;
/** Latest value of every diagState() key, kept even while not recording so a new session can
 *  start from a complete snapshot of how the call is currently configured. */
const currentState: Record<string, unknown> = {};
const probes = new Map<string, DiagnosticsProbe>();

export interface DiagnosticsSnapshot {
  recording: boolean;
  startedAt: number | null;
}

let snapshot: DiagnosticsSnapshot = { recording: false, startedAt: null };
const listeners = new Set<() => void>();

function publish() {
  snapshot = { recording: !!session, startedAt: session?.startedAt ?? null };
  listeners.forEach((listener) => listener());
}

/** For useSyncExternalStore. */
export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return snapshot;
}

export function isDiagnosticsRecording(): boolean {
  return session !== null;
}

// ---------------------------------------------------------------- recording API

/** Records a discrete event (only while recording). */
export function diagEvent(type: string, data?: Record<string, unknown>) {
  session?.events.push({ t: Date.now(), type, ...data });
}

/**
 * Reports the current value of one piece of call state. Logged as a `state` event only when it
 * actually changes, so callers can simply report on every render/effect without deduplicating.
 */
export function diagState(key: string, value: unknown) {
  if (Object.is(currentState[key], value)) return;
  const from = currentState[key];
  currentState[key] = value;
  session?.events.push({ t: Date.now(), type: 'state', key, from, to: value });
}

/** Adds one stats row (only while recording). */
export function diagSample(entry: DiagnosticsEntry) {
  if (!session) return;
  if (session.samples.length >= MAX_SAMPLES) {
    session.truncated = true;
    return;
  }
  session.samples.push(entry);
}

/**
 * Registers a probe read once per sampling tick. Returns an unregister function that only
 * removes *this* probe — an outgoing instance's teardown routinely overlaps its replacement's
 * setup (GTCRN, the background processor), and must not unregister the newcomer.
 */
export function registerDiagProbe(name: string, probe: DiagnosticsProbe): () => void {
  probes.set(name, probe);
  return () => {
    if (probes.get(name) === probe) probes.delete(name);
  };
}

/** Reads every probe into the log. Called by the stats sampler on each tick while recording. */
export function collectDiagProbes(now: number) {
  if (!session) return;
  for (const [name, probe] of probes) {
    try {
      const data = probe();
      if (data) diagSample({ t: now, dir: `probe:${name}`, ...data });
    } catch (e) {
      diagSample({ t: now, dir: `probe:${name}`, error: String(e) });
    }
  }
}

export function startDiagnostics(context: Record<string, unknown>) {
  if (session) return;
  const startedAt = Date.now();
  session = {
    startedAt,
    context,
    env: {},
    initialState: { ...currentState },
    events: [],
    samples: [],
    truncated: false,
    stopMonitors: () => {},
  };
  const own = session;
  // Probes report "since the last read" — read each once now and discard it, so the first
  // recorded sample covers the first tick rather than everything since the probe was created.
  for (const probe of probes.values()) {
    try {
      probe();
    } catch {
      // Reported on the first real read instead.
    }
  }
  own.stopMonitors = startMainThreadMonitors();
  // Filled in asynchronously (high-entropy UA hints, battery, codec capability queries all
  // resolve later); the log is only serialized at stop, by which point this has long settled.
  void collectEnvironment().then((env) => {
    Object.assign(own.env, env);
  });
  publish();
}

export function stopDiagnostics(): DiagnosticsLog | null {
  const s = session;
  if (!s) return null;
  s.stopMonitors();
  session = null;
  publish();
  return {
    version: 1,
    startedAt: s.startedAt,
    endedAt: Date.now(),
    context: s.context,
    env: s.env,
    initialState: s.initialState,
    events: s.events,
    samples: s.samples,
    truncated: s.truncated,
  };
}

// ---------------------------------------------------------------- upload / fallback

/**
 * Uploads a finished log and resolves to the ID the user should send. Gzipped in the browser
 * when CompressionStream exists (an hour-long log is ~10MB of JSON, ~1MB compressed — and the
 * people this exists for are exactly the ones on struggling machines/connections). Sent as
 * application/octet-stream so the backend's global express.json() leaves it alone and the raw
 * bytes go to R2 untouched; the backend gzips it itself when it arrives uncompressed.
 */
export async function uploadDiagnostics(roomId: string, log: DiagnosticsLog): Promise<string> {
  const json = JSON.stringify(log);
  let body: Blob = new Blob([json], { type: 'application/json' });
  if (typeof CompressionStream !== 'undefined') {
    body = await new Response(body.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }
  const res = await apiRequest(`/api/connect/rooms/${encodeURIComponent(roomId)}/diagnostics`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error || `upload failed (${res.status})`);
  }
  const { id } = (await res.json()) as { id: string };
  return id;
}

/** Last resort when the upload fails: hand the user the file itself to send. */
export function downloadDiagnosticsFile(log: DiagnosticsLog) {
  const blob = new Blob([JSON.stringify(log)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date(log.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `smiring-connect-diagnostics-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------- main-thread monitors

interface PressureRecordLike {
  state: string;
}
interface PressureObserverLike {
  observe(source: 'cpu', options?: { sampleInterval?: number }): Promise<void>;
  disconnect(): void;
}
type PressureObserverCtor = new (callback: (records: PressureRecordLike[]) => void) => PressureObserverLike;

/**
 * While recording: main-thread stalls (Long Tasks API + a timer-drift probe, which also catches
 * stalls the Long Tasks API doesn't attribute, e.g. GC), the browser's own CPU pressure verdict
 * (Compute Pressure API, Chromium only), tab visibility and online state. The stall numbers are
 * the direct readout of "the screen froze / I couldn't click anything".
 */
function startMainThreadMonitors(): () => void {
  const cleanups: Array<() => void> = [];

  let longTasks = 0;
  let longTaskMs = 0;
  let longTaskMaxMs = 0;
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks += 1;
        longTaskMs += entry.duration;
        if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration;
      }
    });
    observer.observe({ type: 'longtask', buffered: false });
    cleanups.push(() => observer.disconnect());
  }

  let lagMaxMs = 0;
  let lastTick = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - LAG_PROBE_INTERVAL_MS;
    if (lag > lagMaxMs) lagMaxMs = lag;
    lastTick = now;
  }, LAG_PROBE_INTERVAL_MS);
  cleanups.push(() => clearInterval(lagTimer));

  cleanups.push(
    registerDiagProbe('main', () => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const data = {
        longTasks,
        longTaskMs: Math.round(longTaskMs),
        longTaskMaxMs: Math.round(longTaskMaxMs),
        // Background tabs clamp timers to >=1s, which reads as ~900ms of "lag" every tick —
        // that's throttling, not a stall, so it's flagged via `visible` rather than hidden.
        timerLagMaxMs: Math.round(lagMaxMs),
        visible: document.visibilityState === 'visible',
        heapMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : undefined,
      };
      longTasks = 0;
      longTaskMs = 0;
      longTaskMaxMs = 0;
      lagMaxMs = 0;
      return data;
    }),
  );

  const Pressure = (globalThis as unknown as { PressureObserver?: PressureObserverCtor }).PressureObserver;
  if (Pressure) {
    try {
      const observer = new Pressure((records) => {
        const last = records[records.length - 1];
        if (last) diagState('cpuPressure', last.state);
      });
      void observer.observe('cpu', { sampleInterval: 2000 }).catch(() => {});
      cleanups.push(() => observer.disconnect());
    } catch {
      // Permissions policy or an older implementation — the stall numbers above still work.
    }
  }

  const onVisibility = () => diagState('pageVisible', document.visibilityState === 'visible');
  const onOnline = () => diagState('online', navigator.onLine);
  onVisibility();
  onOnline();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOnline);
  cleanups.push(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOnline);
  });

  return () => cleanups.forEach((cleanup) => cleanup());
}

// ---------------------------------------------------------------- environment

/** The GPU the browser actually renders with. "SwiftShader" / "llvmpipe" / "Basic Render
 *  Driver" here means no hardware acceleration — WebGL (and so the background effect) is
 *  being emulated on the CPU. */
function webglRenderer(): Record<string, unknown> {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return { webgl: false };
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const result = {
      webgl: gl instanceof WebGL2RenderingContext ? 2 : 1,
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return result;
  } catch (e) {
    return { webgl: false, error: String(e) };
  }
}

const CODEC_PROBES: Record<string, string> = {
  vp8: 'video/VP8',
  h264: 'video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  vp9: 'video/VP9',
  av1: 'video/AV1',
};

/** Whether the browser reports a power-efficient (= hardware) encoder/decoder for each codec at
 *  the camera's 720p20 publish settings. Only a hint — the stats' encoderImplementation is the
 *  ground truth for what actually ran. */
async function codecSupport(): Promise<Record<string, unknown>> {
  const mc = navigator.mediaCapabilities;
  if (!mc?.encodingInfo) return { unavailable: true };
  const video = { width: 1280, height: 720, bitrate: 1_700_000, framerate: 20 };
  const result: Record<string, unknown> = {};
  for (const [name, contentType] of Object.entries(CODEC_PROBES)) {
    try {
      const [enc, dec] = await Promise.all([
        mc.encodingInfo({ type: 'webrtc', video: { contentType, ...video } }),
        mc.decodingInfo({ type: 'webrtc', video: { contentType, ...video } }),
      ]);
      result[name] = {
        encode: { supported: enc.supported, smooth: enc.smooth, powerEfficient: enc.powerEfficient },
        decode: { supported: dec.supported, smooth: dec.smooth, powerEfficient: dec.powerEfficient },
      };
    } catch (e) {
      result[name] = { error: String(e) };
    }
  }
  return result;
}

interface NavigatorExtras {
  deviceMemory?: number;
  connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  userAgentData?: {
    platform?: string;
    mobile?: boolean;
    brands?: Array<{ brand: string; version: string }>;
    getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
  };
  getBattery?: () => Promise<{ charging: boolean; level: number }>;
}

/** Browser, hardware, GPU and codec facts — shared with the always-on telemetry (connectTelemetry). */
export async function collectEnvironment(): Promise<Record<string, unknown>> {
  const nav = navigator as Navigator & NavigatorExtras;
  const env: Record<string, unknown> = {
    userAgent: nav.userAgent,
    platform: nav.userAgentData?.platform,
    mobile: nav.userAgentData?.mobile,
    brands: nav.userAgentData?.brands,
    cpuCores: nav.hardwareConcurrency,
    deviceMemoryGB: nav.deviceMemory,
    language: nav.language,
    screen: `${screen.width}x${screen.height}`,
    devicePixelRatio: window.devicePixelRatio,
    window: `${window.innerWidth}x${window.innerHeight}`,
    crossOriginIsolated: window.crossOriginIsolated,
    connection: nav.connection
      ? {
          effectiveType: nav.connection.effectiveType,
          downlinkMbps: nav.connection.downlink,
          rttMs: nav.connection.rtt,
          saveData: nav.connection.saveData,
        }
      : undefined,
    gpu: webglRenderer(),
  };

  const [highEntropy, battery, codecs] = await Promise.all([
    nav.userAgentData
      ?.getHighEntropyValues?.(['platformVersion', 'architecture', 'model', 'fullVersionList'])
      .catch(() => undefined),
    nav.getBattery?.().then((b) => ({ charging: b.charging, level: b.level })).catch(() => undefined),
    codecSupport().catch((e) => ({ error: String(e) })),
  ]);
  env.uaDetails = highEntropy;
  env.battery = battery;
  env.codecs = codecs;
  return env;
}
