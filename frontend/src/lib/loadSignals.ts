/**
 * Push-style load measurements from the call's heavy stages, for the load governor
 * (pages/Connect/loadGovernor). The stages report what they measure anyway; whoever listens
 * aggregates. Cheap when nobody listens: emitting is a loop over an empty set.
 *
 * Separate from connectDiagnostics' probes on purpose: probes are read-and-reset by the
 * diagnostics recorder, and the governor must not steal (or be starved of) those readings.
 */

export type LoadSignal =
  /** One noise-cancel chunk (64ms of audio) was produced. */
  | { kind: 'audio-chunk'; level: number; maxLevel: number; passthrough: boolean }
  /** Noise-cancel playback stats, cumulative since the stream started. */
  | { kind: 'audio-playback'; underrunCount: number }
  /** Noise cancellation gave up for this call (it falls back to the raw mic by itself). */
  | { kind: 'audio-overload' }
  /** Background effect totals over the last `seconds` (roughly 1s). */
  | { kind: 'background'; frames: number; seconds: number; costMsTotal: number; expectedFps: number };

type Listener = (signal: LoadSignal) => void;

const listeners = new Set<Listener>();

export function emitLoadSignal(signal: LoadSignal) {
  for (const listener of listeners) {
    try {
      listener(signal);
    } catch (err) {
      console.error('[loadSignals] listener failed:', err);
    }
  }
}

export function subscribeLoadSignals(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
