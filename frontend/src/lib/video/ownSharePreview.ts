import { useSyncExternalStore } from 'react';

/**
 * Whether the presenter sees their own screen share live, in the call window and the PiP window
 * alike. Off by default: showing your own screen inside the screen you're sharing makes the
 * "hall of mirrors" — the share shows the call, which shows the share, ... — which looks broken
 * to everyone and keeps every frame changing, so the encoder never gets a still screen to rest on.
 * The tile shows a "sharing your screen" card instead, with a button to opt into the preview.
 */
let preview = false;
const listeners = new Set<() => void>();

export function setOwnSharePreview(value: boolean) {
  preview = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOwnSharePreview() {
  return useSyncExternalStore(subscribe, () => preview);
}
