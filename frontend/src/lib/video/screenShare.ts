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
 * How Connect shares a screen (decided 2026-10-15 from /dev/share-lab and Google Meet's own
 * webrtc-internals dump):
 *
 *  - AV1 at the screen's own size, capped at 2560x1600, at most 15fps. Meet shares in AV1 at the
 *    tab's own size; on an M4 the lab measured AV1 at full size keeping text near-identical to the
 *    original (~52-55dB on still frames vs ~36dB for VP8 scaled to 1080p) while using fewer bits
 *    and decoding in ~2ms/frame vs VP8's 5-8. LiveKit publishes AV1 screen shares as L1T3 with
 *    contentHint 'motion' (its workaround for Chrome's screen-share SVC path); measured the same
 *    still-frame quality as 'detail', so its default is kept.
 *  - Text over motion: degradationPreference 'maintain-resolution', so a squeezed uplink or CPU
 *    drops frames, never pixels (the 2026-10-15 meeting's share shrank to 180p before this).
 *  - Viewers that can't decode AV1 (Safari, older iPhones/iPads): VP8 is sent alongside, only while
 *    such a viewer is in the room (BackupCodecPolicy.SIMULCAST). LiveKit's default policy would
 *    instead switch the whole share to VP8 for everyone the moment one such viewer joins.
 *  - Browsers that can't encode AV1 (Safari, Firefox): LiveKit itself falls back to VP8.
 *
 * Fallback when the sharer's machine can't keep up — steps of the load governor
 * (pages/Connect/loadGovernor/governorPolicy.ts), after the camera has been lightened:
 *  S1: AV1 -> VP8 at 1080p (a republish: viewers see the share pause for about a second). One-way
 *      for this share; remembered for VP8_MEMORY_DAYS so the next share starts on VP8.
 *  S2: VP8 at 720p — the floor; below that only the frame rate drops.
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

/** AV1 unless the browser can't encode it or this device recently had to fall back to VP8. */
export function rememberedShareCodec(): ShareCodec {
  if (!canEncodeAv1()) return 'vp8';
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
    // Blocked storage: the next share just tries AV1 again.
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
