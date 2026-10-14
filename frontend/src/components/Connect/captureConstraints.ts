import { isMobileDevice } from '../../pages/Connect/backgroundLibrary';

/**
 * Requested as `{ ideal: ... }` rather than LiveKit's `VideoPresets.h720.resolution`
 * shorthand, which flattens down to bare numeric constraints — bare numbers mean
 * "exact match required" per the WebRTC spec, not "aim for this". That's mostly
 * fine on the very first getUserMedia() call, but `stopProcessor()` re-applies the
 * same constraints to the live camera track when a background effect is turned
 * off, and an exact 16:9 match isn't always satisfiable a second time depending on
 * the camera/driver's state at that point — when it isn't, the browser has fallen
 * back to some other mode the device offers (observed as the preview clipping to a
 * square). `ideal` asks for the same thing without a hard failure mode.
 *
 * Mobile captures at 360p rather than 720p, matching the single, un-simulcast
 * publishEncoding CallRoomPage gives phones (see roomOptions there) — capturing
 * 720p just to immediately encode it down to 360p wastes exactly the CPU/battery
 * budget this is meant to save. See MOBILE_VIDEO_ENCODING's comment for the rest
 * of the reasoning.
 */
export const VIDEO_CAPTURE_CONSTRAINTS: MediaTrackConstraints = isMobileDevice()
  ? {
      width: { ideal: 640 },
      height: { ideal: 360 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 30 },
    }
  : {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      aspectRatio: { ideal: 16 / 9 },
      // 20fps, matching the publish-side maxFramerate override in CallRoomPage's roomOptions
      // and the background effect's segmentationFps — see DESKTOP_VIDEO_ENCODING's comment for
      // why all three need to move together (capturing/segmenting faster than the encoder
      // actually sends just burns battery encoding frames simulcast will never transmit).
      frameRate: { ideal: 20 },
    };
