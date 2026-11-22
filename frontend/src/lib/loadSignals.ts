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
  | {
      kind: 'audio-chunk';
      level: number;
      maxLevel: number;
      passthrough: boolean;
      /**
       * Noise cancellation is actually struggling with this chunk (GtcrnNoiseCancelTrack's
       * chunkStressed): passed through raw, inference near the chunk's own length, the chunk
       * reaching the worker late, or still heavy at the lightest level. Not just "at the lightest
       * level" — the level only steps back down after 10s calm per level, so that stayed true for
       * tens of seconds after a stall was over (2026-11-20: the background dropped to 'balanced'
       * for it with inference back at 9-21ms per 64ms chunk).
       */
      stressed: boolean;
    }
  /** Noise-cancel playback stats, cumulative since the stream started. */
  | {
      kind: 'audio-playback';
      underrunCount: number;
      /** Time played from the raw mic because processed audio was late, ms (cumulative). */
      filledMs: number;
    }
  /** Noise cancellation gave up for this call (it falls back to the raw mic by itself). */
  | { kind: 'audio-overload' }
  /** Background effect totals over the last `seconds` (roughly 1s). */
  | {
      kind: 'background';
      frames: number;
      seconds: number;
      costMsTotal: number;
      expectedFps: number;
      /** Longest gap between output frames, ms (worker pipeline only). */
      maxGapMs?: number;
      /** How long frames were held for their own matte (matteSync / photo mode), ms avg. */
      matteDelayMs?: number;
      /** matteSync: share of held frames that went out with the matte made from that very frame, %. */
      ownMattePct?: number;
      /** matteSync: frames sent with the latest matte because the segmenter stopped answering. */
      forcedOut?: number;
      /** matteSync: frames not sent because no matte was asked for them (segmenter busy or not due). */
      unmatched?: number;
      /** Frames dropped because their matte was too old to send. */
      staleDropped?: number;
      /** Segmentations in this report, their average round trip (asked -> matte ready) and the
       *  segmenter worker's own time per segmentation, ms (worker pipeline only). */
      segmentations?: number;
      segmentRoundTripMs?: number;
      segmenterWorkMs?: number;
      /** Worker pipeline: each worker thread's time in this report, ms (compositor; segmenter). */
      threadMs?: { compositor: number; segmenter: number };
      /** Worker pipeline: frames read from the camera, the longest gap between their capture
       *  timestamps (ms), and the time reading waited on the output (ms). See CompositorStats. */
      input?: { frames: number; maxGapMs: number; outputWaitMs: number };
    };

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
