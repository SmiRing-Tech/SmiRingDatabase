import { useSyncExternalStore } from 'react';
import { RoomEvent, type Room } from 'livekit-client';

/**
 * Who is in the load governor's photo mode (their camera sends a still every second or more,
 * see governorPolicy step 8), so their tile can say so instead of looking frozen.
 *
 * Sent over the data channel rather than participant attributes: attributes need
 * canUpdateOwnMetadata on the token, which would also let anyone rewrite their own name and
 * avatar (metadata). While on, the sender repeats it every REBROADCAST_MS so people who join later
 * learn it too; a receiver forgets anyone it hasn't heard from in EXPIRE_MS (a sender that left
 * or crashed never says "off").
 */

const TOPIC = 'smiring.camera-photo';
const REBROADCAST_MS = 5_000;
const EXPIRE_MS = 13_000;

const remote = new Map<string, number>();
let localOn = false;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Listens for other participants' photo mode. Returns a stop function. */
export function startCameraPhotoReceiver(room: Room): () => void {
  const onData = (payload: Uint8Array, participant?: { identity: string }, _kind?: unknown, topic?: string) => {
    if (topic !== TOPIC || !participant) return;
    let on = false;
    try {
      on = JSON.parse(decoder.decode(payload))?.on === true;
    } catch {
      return;
    }
    const had = remote.has(participant.identity);
    if (on) remote.set(participant.identity, Date.now());
    else remote.delete(participant.identity);
    if (had !== on) changed();
  };
  const onLeft = (participant: { identity: string }) => {
    if (remote.delete(participant.identity)) changed();
  };
  const expire = setInterval(() => {
    const now = Date.now();
    let any = false;
    for (const [identity, at] of remote) {
      if (now - at > EXPIRE_MS) {
        remote.delete(identity);
        any = true;
      }
    }
    if (any) changed();
  }, 3_000);
  room.on(RoomEvent.DataReceived, onData);
  room.on(RoomEvent.ParticipantDisconnected, onLeft);
  return () => {
    clearInterval(expire);
    room.off(RoomEvent.DataReceived, onData);
    room.off(RoomEvent.ParticipantDisconnected, onLeft);
    if (remote.size) {
      remote.clear();
      changed();
    }
  };
}

let broadcastTimer: ReturnType<typeof setInterval> | null = null;

function broadcast(room: Room, on: boolean) {
  void room.localParticipant
    .publishData(encoder.encode(JSON.stringify({ on })), { reliable: true, topic: TOPIC })
    .catch(() => {});
}

/** Turns this participant's photo mode signal on or off (idempotent). */
export function setLocalCameraPhoto(room: Room, on: boolean) {
  if (on === localOn) return;
  localOn = on;
  changed();
  if (broadcastTimer !== null) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  broadcast(room, on);
  if (on) broadcastTimer = setInterval(() => broadcast(room, true), REBROADCAST_MS);
}

/** Whether this participant's camera is in photo mode (for their tile). */
export function useCameraPhoto(identity: string | undefined, isLocal: boolean): boolean {
  useSyncExternalStore(subscribe, () => version);
  if (isLocal) return localOn;
  return !!identity && remote.has(identity);
}
