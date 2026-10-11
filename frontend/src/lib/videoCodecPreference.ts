/**
 * Which video codec this browser publishes camera and screen share with — a per-browser
 * diagnostics switch, set from the "通話の診断" dialog. Unset means LiveKit's own default
 * (VP8), which nearly every PC encodes in software; H.264 is the codec most PCs have a
 * hardware encoder for, and comparing the two on a struggling machine is the point of the
 * switch.
 *
 * Supersedes the DevTools-only `smiring.debug.shareCodec` flag (screen share only); that key is
 * still honored as a fallback so existing instructions keep working.
 */
export type VideoCodecPreference = 'vp8' | 'h264';

const STORAGE_KEY = 'smiring.debug.videoCodec';
const LEGACY_SHARE_KEY = 'smiring.debug.shareCodec';

function parse(value: string | null): VideoCodecPreference | undefined {
  return value === 'h264' || value === 'vp8' ? value : undefined;
}

export function readVideoCodecPreference(source: 'camera' | 'screen' = 'camera'): VideoCodecPreference | undefined {
  try {
    const value = parse(localStorage.getItem(STORAGE_KEY));
    if (value || source === 'camera') return value;
    return parse(localStorage.getItem(LEGACY_SHARE_KEY));
  } catch {
    return undefined;
  }
}

export function writeVideoCodecPreference(codec: VideoCodecPreference | undefined) {
  try {
    if (codec) localStorage.setItem(STORAGE_KEY, codec);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: the switch just doesn't persist past this call.
  }
}

/** publishTrack() options for the preferred codec, or undefined for LiveKit's default. No backup
 *  codec: every browser decodes both, and a backup would mean encoding the video twice —
 *  polluting exactly the encoder-cost comparison this switch exists for. */
export function codecPublishOptions(codec: VideoCodecPreference | undefined) {
  return codec ? { videoCodec: codec, backupCodec: false as const } : undefined;
}
