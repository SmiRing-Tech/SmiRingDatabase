import {
  BackupCodecPolicy,
  Track,
  type LocalParticipant,
  type LocalVideoTrack,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCodec,
} from 'livekit-client';

/**
 * How Connect shares a screen.
 *
 * Default: VP8, capture capped at 1080p, at most 15fps, degradationPreference 'maintain-resolution'
 * (a squeezed uplink or CPU drops frames, never pixels — the 2026-10-15 meeting's share shrank to
 * 180p before that), with the usual 720p/5fps simulcast layer for small tiles.
 *
 * AV1 at the screen's own size (up to 2560x1600) is available from the "通話の診断" codec switch
 * only. It was the default for a day: /dev/share-lab (mostly-still screenshots) and Google Meet
 * measured it light on an M4, but in a real call (2026-10-16) the same M4 sharing a browser being
 * scrolled and clicked through took 12-40ms/frame with spikes to 95-400ms, starved the noise
 * cancel (5ms -> 30-230ms per chunk) and broke the audio — while reporting no CPU limitation.
 * Until the lab shows a setting that holds up on moving content, it stays opt-in. When used:
 *  - LiveKit publishes it as L1T3 with contentHint 'motion' (its workaround for Chrome's
 *    screen-share SVC path).
 *  - Viewers that can't decode AV1 get VP8 alongside, only while one is in the room
 *    (BackupCodecPolicy.SIMULCAST); LiveKit's default would switch everyone to VP8.
 *  - Fallback, as load governor steps (pages/Connect/loadGovernor/governorPolicy.ts):
 *    S1 AV1 -> VP8 1080p (a republish; first when the share's own encoder is the overload),
 *    remembered for VP8_MEMORY_DAYS; S2 VP8 at 720p, the floor.
 */

/** Capture cap: fit within this, never upscale. */
const SHARE_MAX = { width: 2560, height: 1600 };
const SHARE_FPS = 15;
const VP8_MAX = { width: 1920, height: 1080 };
const VP8_FLOOR = { width: 1280, height: 720 };

const AV1_ENCODING = { maxBitrate: 3_000_000, maxFramerate: SHARE_FPS, priority: 'high' as const };
/** Same as publishDefaults.screenShareEncoding (CallRoomPage roomOptions). */
const VP8_ENCODING = { maxBitrate: 4_000_000, maxFramerate: SHARE_FPS, priority: 'high' as const };

const VP8_MEMORY_KEY = 'smiring.share.vp8Until';
const VP8_MEMORY_DAYS = 14;

export type ShareCodec = 'av1' | 'vp8' | 'h264';

/** Same test LiveKit applies before honouring videoCodec 'av1' (Safari/Firefox report it but can't). */
function canEncodeAv1() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua) || (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua))) return false;
  return RTCRtpSender.getCapabilities?.('video')?.codecs.some((c) => c.mimeType.toLowerCase() === 'video/av1') ?? false;
}

/**
 * The codec a new share starts with: VP8 unless the diagnostics switch asks for AV1 or H.264.
 * AV1 also needs a browser that can encode it and no recent fallback on this device.
 */
export function shareCodecFor(preference: 'vp8' | 'h264' | 'av1' | undefined): ShareCodec {
  if (preference === 'h264') return 'h264';
  if (preference !== 'av1' || !canEncodeAv1()) return 'vp8';
  try {
    const until = Number(localStorage.getItem(VP8_MEMORY_KEY));
    return Number.isFinite(until) && until > Date.now() ? 'vp8' : 'av1';
  } catch {
    return 'av1';
  }
}

function rememberShareFallback() {
  try {
    localStorage.setItem(VP8_MEMORY_KEY, String(Date.now() + VP8_MEMORY_DAYS * 24 * 3600_000));
  } catch {
    // Blocked storage: the next AV1 share just tries again.
  }
}

function captureConstraints(max: { width: number; height: number }): MediaTrackConstraints {
  return { width: { max: max.width }, height: { max: max.height }, frameRate: { max: SHARE_FPS } };
}

/** getDisplayMedia options for a new share. */
export function shareCaptureOptions(codec: ShareCodec): ScreenShareCaptureOptions {
  return {
    // Explicit max constraints rather than LiveKit's `resolution`, which Chrome gets as `ideal`
    // (and a smaller screen would be scaled *up* to meet it).
    // (LiveKit types `video` as only { displaySurface }, but passes the object to getDisplayMedia as is.)
    video: captureConstraints(codec === 'av1' ? SHARE_MAX : VP8_MAX) as ScreenShareCaptureOptions['video'],
    // Spend bits on sharpness over motion (LiveKit overrides it to 'motion' for AV1 — see above).
    contentHint: 'detail',
    // Don't offer this very tab in the picker: sharing the call into itself is a hall of mirrors.
    selfBrowserSurface: 'exclude',
  };
}

export function sharePublishOptions(codec: ShareCodec): TrackPublishOptions {
  const common = {
    // Explicit, because publishDefaults' 'maintain-framerate' (meant for cameras) would otherwise
    // apply here too.
    degradationPreference: 'maintain-resolution' as const,
  };
  if (codec === 'av1') {
    return {
      ...common,
      videoCodec: 'av1',
      screenShareEncoding: AV1_ENCODING,
      backupCodec: { codec: 'vp8', encoding: VP8_ENCODING },
      backupCodecPolicy: BackupCodecPolicy.SIMULCAST,
    };
  }
  return { ...common, videoCodec: codec as VideoCodec, backupCodec: false, screenShareEncoding: VP8_ENCODING };
}

function screenTrack(localParticipant: LocalParticipant) {
  return localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as LocalVideoTrack | undefined;
}

/** The codec the current share was published with, or null when not sharing. */
export function currentShareCodec(localParticipant: LocalParticipant): ShareCodec | null {
  const track = screenTrack(localParticipant);
  if (!track || track.mediaStreamTrack.readyState !== 'live') return null;
  return (track.codec as ShareCodec | undefined) ?? 'vp8';
}

let switching = false;

/**
 * True while S1 republishes the share: isScreenShareEnabled briefly reads false in between, and
 * whatever reacts to the share starting/stopping (the auto PiP window) should sit it out.
 */
export function isShareSwitching() {
  return switching;
}

/** S1: republish the running share as VP8 at 1080p, keeping the captured track (no picker). */
export async function switchShareToVp8(localParticipant: LocalParticipant): Promise<boolean> {
  const track = screenTrack(localParticipant);
  if (!track || track.mediaStreamTrack.readyState !== 'live') return false;
  switching = true;
  try {
    rememberShareFallback();
    await track.mediaStreamTrack.applyConstraints(captureConstraints(VP8_MAX)).catch(() => {});
    await localParticipant.unpublishTrack(track, false);
    await localParticipant.publishTrack(track, { source: Track.Source.ScreenShare, ...sharePublishOptions('vp8') });
    return true;
  } finally {
    switching = false;
  }
}

/** S2 and its undo: VP8 share capped at 720p, or back to 1080p. */
export async function setShareFloor(localParticipant: LocalParticipant, floor: boolean): Promise<void> {
  const track = screenTrack(localParticipant);
  if (!track || track.mediaStreamTrack.readyState !== 'live') return;
  await track.mediaStreamTrack.applyConstraints(captureConstraints(floor ? VP8_FLOOR : VP8_MAX));
}
