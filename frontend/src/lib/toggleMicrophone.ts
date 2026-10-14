import { Track, type LocalAudioTrack, type LocalParticipant } from 'livekit-client';
import { diagEvent } from './connectDiagnostics';

/** Where a mute click came from: the main window's mic button, or the Picture-in-Picture window's. */
export type MicToggleOrigin = 'main' | 'pip';

/**
 * What LiveKit and the browser think of the mic right now, as plain switches. `serverMuted` is
 * what the SFU was last told (an upstream-paused track reports muted to everyone even while the
 * local UI shows unmuted), so a click whose `wantEnabled` disagrees with it is the smoking gun.
 */
function micSnapshot(local: LocalParticipant) {
  const pub = local.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track as LocalAudioTrack | undefined;
  const raw = track?.mediaStreamTrack;
  return {
    published: !!pub,
    pubMuted: pub?.isMuted,
    upstreamPaused: track?.isUpstreamPaused,
    rawEnabled: raw?.enabled,
    rawMuted: raw?.muted,
    rawState: raw?.readyState,
    senderHasTrack: track?.sender ? !!track.sender.track : undefined,
  };
}

/**
 * Toggles the microphone and records the click, how long LiveKit took, whether it threw, and the
 * mic's state before and after. Telemetry-only: the toggle itself behaves exactly as a bare
 * `setMicrophoneEnabled(!isEnabled)` with the same error logging.
 */
export async function toggleMicrophone(
  local: LocalParticipant,
  wasEnabled: boolean,
  origin: MicToggleOrigin,
): Promise<void> {
  const before = micSnapshot(local);
  const startedAt = performance.now();
  diagEvent('mic-toggle-click', { origin, wantEnabled: !wasEnabled, ...before });
  try {
    await local.setMicrophoneEnabled(!wasEnabled);
    diagEvent('mic-toggle-done', {
      origin,
      wantEnabled: !wasEnabled,
      ms: Math.round(performance.now() - startedAt),
      isMicrophoneEnabled: local.isMicrophoneEnabled,
      ...micSnapshot(local),
    });
  } catch (e) {
    diagEvent('mic-toggle-failed', {
      origin,
      wantEnabled: !wasEnabled,
      ms: Math.round(performance.now() - startedAt),
      error: String(e),
      ...micSnapshot(local),
    });
    console.error(origin === 'pip' ? '[PiP] Failed to toggle microphone:' : 'Failed to toggle mic:', e);
  }
}
