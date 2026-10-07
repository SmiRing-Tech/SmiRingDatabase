import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { playParticipantJoinSound, playParticipantLeaveSound } from './callSounds';

/** Several people arriving or leaving together (a mini-room session closing and sending
 *  everyone back to the main room at once) collapse into one sound instead of a pile-up. */
const MIN_GAP_MS = 1500;

/** How long to stay quiet around a reconnect — see the comment in the effect. */
const RECONNECT_QUIET_MS = 3000;

/**
 * Plays a short chime when another person joins or leaves the room this client is currently
 * connected to (main room or a mini room — each is its own LiveKit room, so moving between
 * them reads as leaving one and joining the other, which is exactly what it is for the people
 * in each).
 *
 * Things that are *not* someone actually arriving/leaving, and are filtered out:
 *  - Our own connect: LiveKit doesn't emit ParticipantConnected for people already in the room
 *    when we join, and our own disconnect (leaving, or switching to a mini room) clears the
 *    roster without emitting ParticipantDisconnected for each of them.
 *  - Our own network reconnects: a full reconnect emits ParticipantDisconnected for *everyone*
 *    (while still nominally Connected, right before switching to Reconnecting), then replays
 *    them all as ParticipantConnected once back — either while still Reconnecting (resume
 *    path) or right after Reconnected (full-reconnect path). Hence the deferred state check
 *    for leaves, and the quiet window around Reconnecting/Reconnected for both.
 */
export function useParticipantPresenceSounds() {
  const room = useRoomContext();

  useEffect(() => {
    let quietUntil = 0;
    const lastPlayed = { join: 0, leave: 0 };
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const play = (kind: 'join' | 'leave') => {
      const now = performance.now();
      if (now < quietUntil || now - lastPlayed[kind] < MIN_GAP_MS) return;
      lastPlayed[kind] = now;
      if (kind === 'join') playParticipantJoinSound();
      else playParticipantLeaveSound();
    };

    // Checked one tick later, not inline: on a full reconnect LiveKit emits the whole roster's
    // ParticipantDisconnected synchronously *before* flipping state to Reconnecting, so only
    // after the current call stack finishes does room.state reveal that it wasn't real.
    const playIfStillConnected = (kind: 'join' | 'leave') => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (room.state === ConnectionState.Connected) play(kind);
      }, 0);
      timers.add(timer);
    };

    const onConnected = () => playIfStillConnected('join');
    const onDisconnected = () => playIfStillConnected('leave');
    const onReconnectEdge = () => {
      quietUntil = performance.now() + RECONNECT_QUIET_MS;
    };

    room
      .on(RoomEvent.ParticipantConnected, onConnected)
      .on(RoomEvent.ParticipantDisconnected, onDisconnected)
      .on(RoomEvent.Reconnecting, onReconnectEdge)
      .on(RoomEvent.Reconnected, onReconnectEdge);
    return () => {
      room
        .off(RoomEvent.ParticipantConnected, onConnected)
        .off(RoomEvent.ParticipantDisconnected, onDisconnected)
        .off(RoomEvent.Reconnecting, onReconnectEdge)
        .off(RoomEvent.Reconnected, onReconnectEdge);
      timers.forEach(clearTimeout);
    };
  }, [room]);
}
