import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getDiagnosticsSnapshot,
  isDiagnosticsRecording,
  startDiagnostics,
  stopDiagnostics,
  subscribeDiagnostics,
  uploadDiagnostics,
  type DiagnosticsLog,
} from '../../lib/connectDiagnostics';

/** State and actions behind the "通話の診断" UI (ConnectDiagnostics.tsx). */

type UploadPhase =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'done'; id: string; copied: boolean }
  | { kind: 'failed'; log: DiagnosticsLog; message: string };

export interface DiagnosticsController {
  recording: boolean;
  startedAt: number | null;
  phase: UploadPhase;
  start: () => void;
  stopAndUpload: () => Promise<void>;
  dismissResult: () => void;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function diagnosticsResultMessage(id: string) {
  return `SmiRing Connect 診断ID: ${id}`;
}

/**
 * Owns the recorder's lifecycle for one call. Mount it somewhere that lives for the whole call
 * (it auto-stops and uploads on unmount, i.e. when the user leaves without pressing stop).
 *
 * @param roomId The room the caller's credentials are valid for — the *current* (mini) room,
 *   since a guest's LiveKit token is scoped to exactly that room.
 * @param getContext Who/where, captured at start.
 */
export function useDiagnosticsController(
  roomId: string,
  getContext: () => Record<string, unknown>,
): DiagnosticsController {
  const snapshot = useSyncExternalStore(subscribeDiagnostics, getDiagnosticsSnapshot);
  const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
  const roomIdRef = useRef(roomId);
  const getContextRef = useRef(getContext);
  useEffect(() => {
    roomIdRef.current = roomId;
    getContextRef.current = getContext;
  });

  const start = useCallback(() => {
    setPhase({ kind: 'idle' });
    startDiagnostics(getContextRef.current());
  }, []);

  const stopAndUpload = useCallback(async () => {
    const log = stopDiagnostics();
    if (!log) return;
    setPhase({ kind: 'uploading' });
    try {
      const id = await uploadDiagnostics(roomIdRef.current, log);
      const copied = await copyText(diagnosticsResultMessage(id));
      setPhase({ kind: 'done', id, copied });
    } catch (e) {
      console.error('[Connect] diagnostics upload failed:', e);
      setPhase({ kind: 'failed', log, message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const dismissResult = useCallback(() => setPhase({ kind: 'idle' }), []);

  // Leaving the call while recording: send what we have rather than drop it. The ID can't be
  // shown any more, but the upload is stored with the person's name and time, so it can still
  // be found (connectDiagnostics.ts list).
  useEffect(() => {
    return () => {
      if (!isDiagnosticsRecording()) return;
      const log = stopDiagnostics();
      if (log) void uploadDiagnostics(roomIdRef.current, log).catch((e) => console.error('[Connect] diagnostics upload failed:', e));
    };
  }, []);

  // Closing the tab while recording would lose everything — ask first.
  useEffect(() => {
    if (!snapshot.recording) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [snapshot.recording]);

  return {
    recording: snapshot.recording,
    startedAt: snapshot.startedAt,
    phase,
    start,
    stopAndUpload,
    dismissResult,
  };
}
