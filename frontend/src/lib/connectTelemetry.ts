import { apiRequest } from './apiClient';
import { collectEnvironment } from './connectDiagnostics';

/**
 * Always-on, numbers-only load telemetry for SmiRing Connect: what the load governor measured and
 * decided during every call, uploaded automatically so its thresholds can be tuned from real calls
 * without anyone pressing the diagnostics button. No audio, video or content — just the governor's
 * samples, its actions, and the machine's facts (browser, GPU, cores).
 *
 * Uploaded in parts (POST /api/connect/rooms/:roomId/telemetry?session=..&seq=..): every few
 * minutes, and once more when the call ends. Small parts so the last one fits a keepalive request
 * when the tab is closing. Read back with backend/src/scripts/connectTelemetry.ts.
 */

const FLUSH_INTERVAL_MS = 3 * 60_000;

export type TelemetryEntry = { t: number; type: string } & Record<string, unknown>;

interface Session {
  roomId: string;
  id: string;
  startedAt: number;
  seq: number;
  context: Record<string, unknown>;
  env?: Record<string, unknown>;
  entries: TelemetryEntry[];
  timer: ReturnType<typeof setInterval>;
  onPageHide: () => void;
}

let session: Session | null = null;

function newSessionId(startedAt: number) {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${new Date(startedAt).toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${random}`;
}

/** Starts a telemetry session for one call (a new call replaces the previous session). */
export function startTelemetry(roomId: string, context: Record<string, unknown>) {
  stopTelemetry();
  const startedAt = Date.now();
  const onPageHide = () => void flush(true);
  const current: Session = {
    roomId,
    id: newSessionId(startedAt),
    startedAt,
    seq: 0,
    context,
    entries: [],
    timer: setInterval(() => void flush(false), FLUSH_INTERVAL_MS),
    onPageHide,
  };
  session = current;
  window.addEventListener('pagehide', onPageHide);
  void collectEnvironment()
    .then((env) => {
      current.env = env;
    })
    .catch(() => {});
}

export function recordTelemetry(type: string, data: Record<string, unknown> = {}) {
  session?.entries.push({ t: Date.now(), type, ...data });
}

/** Ends the session and sends what's left. */
export function stopTelemetry() {
  const current = session;
  if (!current) return;
  session = null;
  clearInterval(current.timer);
  window.removeEventListener('pagehide', current.onPageHide);
  void send(current, true);
}

async function flush(keepalive: boolean) {
  if (session) await send(session, keepalive);
}

async function send(current: Session, keepalive: boolean) {
  if (current.entries.length === 0 && current.seq > 0) return;
  const entries = current.entries;
  current.entries = [];
  const seq = current.seq++;
  const part = {
    version: 1,
    session: current.id,
    seq,
    roomId: current.roomId,
    startedAt: current.startedAt,
    sentAt: Date.now(),
    // The facts only need to travel once; the first part carries whatever has resolved by then,
    // and the next part carries it if it hadn't.
    ...(seq === 0 || (seq === 1 && current.env) ? { context: current.context, env: current.env } : {}),
    entries,
  };
  try {
    let body: Blob = new Blob([JSON.stringify(part)], { type: 'application/json' });
    if (typeof CompressionStream !== 'undefined') {
      body = await new Response(body.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    }
    const query = `session=${encodeURIComponent(current.id)}&seq=${seq}`;
    const res = await apiRequest(`/api/connect/rooms/${encodeURIComponent(current.roomId)}/telemetry?${query}`, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/octet-stream' },
      keepalive,
    });
    if (!res.ok) console.warn('[telemetry] upload failed:', res.status);
  } catch (err) {
    console.warn('[telemetry] upload failed:', err);
  }
}
