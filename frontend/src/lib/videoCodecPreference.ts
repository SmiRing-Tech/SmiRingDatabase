/**
 * Which video codec this browser publishes camera and screen share with — a diagnostics switch,
 * set from the "通話の診断" dialog. Unset means LiveKit's own default (VP8), which nearly every PC
 * encodes in software; H.264 is the codec most PCs have a hardware encoder for, and comparing the
 * two on a struggling machine is the point of the switch.
 *
 * Kept in memory only, so it lasts until the page is closed or reloaded. It used to live in
 * localStorage, and a switch flipped for one test silently kept the next day's whole meeting on
 * H.264 (2026-10-15) — a diagnostics setting shouldn't outlive the session it was flipped in. Any
 * value left in storage by that version (or the old DevTools-only `smiring.debug.shareCodec`
 * flag) is removed on load.
 */
export type VideoCodecPreference = 'vp8' | 'h264';

let current: VideoCodecPreference | undefined;

try {
  localStorage.removeItem('smiring.debug.videoCodec');
  localStorage.removeItem('smiring.debug.shareCodec');
} catch {
  // Blocked storage: nothing could have been left there either.
}

/** One switch for both camera and screen share. */
export function readVideoCodecPreference(): VideoCodecPreference | undefined {
  return current;
}

export function writeVideoCodecPreference(codec: VideoCodecPreference | undefined) {
  current = codec;
}

/** publishTrack() options for the preferred codec, or undefined for LiveKit's default. No backup
 *  codec: every browser decodes both, and a backup would mean encoding the video twice —
 *  polluting exactly the encoder-cost comparison this switch exists for. */
export function codecPublishOptions(codec: VideoCodecPreference | undefined) {
  return codec ? { videoCodec: codec, backupCodec: false as const } : undefined;
}
