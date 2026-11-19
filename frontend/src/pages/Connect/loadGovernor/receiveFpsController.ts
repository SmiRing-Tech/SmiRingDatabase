import { RemoteVideoTrack, Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import type { ReceiveControl, ReceiveLevel } from './governorPolicy';

/**
 * The governor's receiving steps: asks the SFU for fewer frames of other people's cameras
 * (RemoteTrackPublication.setVideoFPS) and for smaller simulcast layers of them
 * (setVideoQuality), so this device decodes less. Only used on a device the
 * governor has judged overloaded; level 0 is "everything at full rate", same as without it.
 *
 * How it works: a camera publishing VP8 with temporal layers (L1T3 — every PC Chrome, and Android
 * once useTemporalLayers has set it) can be thinned by the SFU without re-encoding: T0 is every 4th
 * frame, T1 doubles it, T2 doubles again. Measured on the temporal-layer lab (/dev/temporal-lab),
 * receiving a 720p camera: half rate cut decode time ~45%, quarter rate ~75%.
 *
 * The SFU maps a requested fps onto a layer using its own estimate of each layer's rate, and that
 * estimate was off and unstable in the lab (asking for 10 got 20fps; 6 got 20fps on one run and 8
 * got 10fps on the next). So the request is never fixed: each sample compares the frames actually
 * decoded with the target and nudges the request until they match. A stream that still arrives at
 * full rate with the request at 1 has no temporal layers (iPhone/Safari senders, H.264) and is left
 * alone.
 *
 * Per level (small / large camera tiles; shares only ever lose frame rate, from 3 on):
 *   0: full / full
 *   1: 10fps / full
 *   2: 10fps / 360p
 *   3: 5fps / 360p 10fps, plus screen shares at half rate (SHARE_TARGET)
 *   4: 5fps 180p / 180p 10fps
 *   5: 5fps 180p / 180p 5fps
 * Why this order (telemetry 2026-10..11): adaptiveStream already delivers 66% of received cameras
 * at 180p — small tiles — and at 180p a frame's fixed cost dominates (0.5ms vs 0.8ms at 360p), so
 * frame rate is the lever there. A large tile at 720p costs 2.8ms a frame; capping it at 360p cuts
 * that ~70% and keeps it smooth, where 10fps would visibly stutter. So large tiles lose resolution
 * before frame rate.
 * A share's resolution is never touched: it's what keeps its text legible, and AV1 shares have no
 * smaller layer anyway. setVideoQuality is a ceiling — adaptiveStream still picks a smaller layer
 * for a smaller tile. A sender with no lower layer (phones publish a single 360p layer) is left as
 * it is.
 * "Large" is what's on screen right now: any attached <video> (the PiP window's included) at
 * least LARGE_TILE_PX tall.
 */

const LARGE_TILE_PX = 300;
/** setVideoFPS can't be cleared once set; asking for more than any camera sends means "all layers". */
const FULL_REQUEST = 60;
/** Received fps outside target × these is off target. */
const TOO_HIGH = 1.4;
const TOO_LOW = 0.6;

const TARGETS: Record<ReceiveLevel, { small: number | null; large: number | null }> = {
  0: { small: null, large: null },
  1: { small: 10, large: null },
  2: { small: 10, large: null },
  3: { small: 5, large: 10 },
  4: { small: 5, large: 10 },
  5: { small: 5, large: 5 },
};
interface Cap {
  quality: VideoQuality;
  /** Height of the layer that quality maps to on a desktop simulcast sender. */
  height: number;
}
const CAP_360: Cap = { quality: VideoQuality.MEDIUM, height: 360 };
const CAP_180: Cap = { quality: VideoQuality.LOW, height: 180 };
const CAPS: Record<ReceiveLevel, { small: Cap | null; large: Cap | null }> = {
  0: { small: null, large: null },
  1: { small: null, large: null },
  2: { small: null, large: CAP_360 },
  3: { small: null, large: CAP_360 },
  4: { small: CAP_180, large: CAP_180 },
  5: { small: CAP_180, large: CAP_180 },
};
/** Received taller than the cap × this counts as not capped yet. */
const CAP_SLACK = 1.15;
/** Half of a share's 15fps (lib/video/screenShare.ts). */
const SHARE_TARGET = 7.5;
/**
 * A share only sends frames while something moves (~2/s when still), so its rate says nothing
 * about the layer it's getting until it's at least this busy.
 */
const SHARE_MOVING_FPS = 5;

interface StreamState {
  publication: RemoteTrackPublication;
  /** What setVideoFPS was last given; null = never called (full). */
  request: number | null;
  /** Being steered toward a target (vs left at / returned to full). */
  active: boolean;
  /** Samples to wait after changing the request before judging it again. */
  settle: number;
  /** Request at 1 and still arriving above target: nothing to slow down. */
  noLayers: boolean;
  /** Last measured decoded fps, and whether it's shown large. */
  fps: number;
  large: boolean;
  share: boolean;
  /** Height of the frames being decoded right now. */
  height: number;
  /** The quality ceiling this controller set; null = none (the default, HIGH). */
  capped: VideoQuality | null;
}

/** A remote camera or screen share and how many of its frames were decoded per second. */
export interface CameraFps {
  publication: RemoteTrackPublication;
  decodedFps: number;
  /** frameHeight of what's being decoded. */
  height: number;
}

export class ReceiveFpsController {
  private level: ReceiveLevel = 0;
  private readonly streams = new Map<string, StreamState>();

  get currentLevel() {
    return this.level;
  }

  setLevel(level: ReceiveLevel) {
    if (level === this.level) return;
    this.level = level;
    for (const stream of this.streams.values()) {
      // Going back to full re-probes next time, in case the sender has changed (codec, device).
      if (level === 0) stream.noLayers = false;
      stream.settle = 0;
      this.control(stream);
      this.controlResolution(stream);
    }
  }

  /**
   * One sample: the decoded fps of each subscribed remote camera (from the governor's receive
   * stats). Updates every stream's request toward its target.
   */
  update(cameras: CameraFps[]) {
    const seen = new Set<string>();
    for (const { publication, decodedFps, height } of cameras) {
      seen.add(publication.trackSid);
      let stream = this.streams.get(publication.trackSid);
      if (!stream || stream.publication !== publication) {
        stream = {
          publication,
          request: null,
          active: false,
          settle: 0,
          noLayers: false,
          fps: 0,
          large: false,
          share: publication.source === Track.Source.ScreenShare,
          height: 0,
          capped: null,
        };
        this.streams.set(publication.trackSid, stream);
      }
      stream.fps = decodedFps;
      stream.height = height;
      stream.large = shownHeight(publication) >= LARGE_TILE_PX;
      this.control(stream);
      this.controlResolution(stream);
    }
    for (const sid of this.streams.keys()) if (!seen.has(sid)) this.streams.delete(sid);
  }

  /** Would going to `level` slow anything down right now? (For the governor's ladder.) */
  wouldRelieve(level: ReceiveLevel): boolean {
    for (const stream of this.streams.values()) {
      if (stream.share || stream.fps < 1) continue;
      const cap = capFor(level, stream.large);
      const current = capFor(this.level, stream.large);
      if (cap && (!current || cap.height < current.height) && canCapTo(stream, cap)) return true;
    }
    for (const stream of this.streams.values()) {
      if (stream.noLayers) continue;
      // A share relieves whenever one is being received: its busy moments are what cost, and a
      // still share would read as already slow.
      if (stream.share) {
        if (level >= 3 && targetFor(this.level, true, true) === null) return true;
        continue;
      }
      if (stream.fps < 1) continue;
      const target = targetFor(level, stream.large);
      if (target !== null && stream.fps > target * TOO_HIGH) return true;
    }
    return false;
  }

  stats(): ReceiveControl {
    let throttled = 0;
    let noLayers = 0;
    let capped = 0;
    for (const stream of this.streams.values()) {
      if (stream.capped !== null) capped += 1;
      if (stream.noLayers) noLayers += 1;
      else if (stream.active && stream.request !== null && stream.request < FULL_REQUEST) throttled += 1;
    }
    return { throttled, noLayers, capped };
  }

  /** Everything back to full (the call is ending or the governor stopped). */
  dispose() {
    for (const stream of this.streams.values()) {
      if (stream.request !== null && stream.request !== FULL_REQUEST) stream.publication.setVideoFPS(FULL_REQUEST);
      if (stream.capped !== null) stream.publication.setVideoQuality(VideoQuality.HIGH);
    }
    this.streams.clear();
  }

  private control(stream: StreamState) {
    const target = targetFor(this.level, stream.large, stream.share);
    if (target === null) {
      stream.active = false;
      if (stream.request !== null && stream.request !== FULL_REQUEST) this.request(stream, FULL_REQUEST);
      return;
    }
    if (stream.noLayers) return;
    if (!stream.active || stream.request === null) {
      // A first guess just under the target; the loop below corrects it.
      stream.active = true;
      this.request(stream, Math.max(1, Math.round(target * 0.8)));
      return;
    }
    if (stream.settle > 0) {
      stream.settle -= 1;
      return;
    }
    // Nothing arriving (camera off, paused off screen), or a share sitting still: nothing to judge.
    if (stream.fps < (stream.share ? SHARE_MOVING_FPS : 1)) return;
    if (stream.fps > target * TOO_HIGH) {
      if (stream.request <= 1) stream.noLayers = true;
      else this.request(stream, Math.max(1, Math.floor(stream.request * 0.6)));
    } else if (stream.fps < target * TOO_LOW && stream.request < FULL_REQUEST) {
      this.request(stream, Math.min(FULL_REQUEST, Math.ceil(stream.request * 1.6) + 1));
    }
  }

  /** A resolution ceiling on cameras, by level and how large each is shown. Shares never. */
  private controlResolution(stream: StreamState) {
    const want = stream.share ? null : (capFor(this.level, stream.large)?.quality ?? null);
    if (want === stream.capped) return;
    stream.capped = want;
    // HIGH is LiveKit's default; setting it back clears the ceiling (adaptiveStream still applies).
    stream.publication.setVideoQuality(want ?? VideoQuality.HIGH);
  }

  private request(stream: StreamState, fps: number) {
    stream.request = fps;
    // One sample for the SFU to switch layers, then a full window measured at the new rate.
    stream.settle = 1;
    stream.publication.setVideoFPS(fps);
  }
}

function capFor(level: ReceiveLevel, large: boolean): Cap | null {
  return large ? CAPS[level].large : CAPS[level].small;
}

/** Would this ceiling bring the camera down to a smaller layer the sender actually has? */
function canCapTo(stream: StreamState, cap: Cap) {
  if (stream.height <= cap.height * CAP_SLACK) return false;
  const layers = stream.publication.trackInfo?.layers ?? [];
  // Without layer info, assume a desktop simulcast sender; the cap is harmless if it has none.
  if (layers.length === 0) return true;
  return layers.some((l) => l.height > 0 && l.height <= cap.height * CAP_SLACK && l.height < stream.height);
}

function targetFor(level: ReceiveLevel, large: boolean, share = false) {
  if (share) return level >= 3 ? SHARE_TARGET : null;
  const targets = TARGETS[level];
  return large ? targets.large : targets.small;
}

/** Tallest on-screen <video> this track is attached to, in CSS px (0 if none is visible). */
function shownHeight(publication: RemoteTrackPublication) {
  const track = publication.track;
  if (!(track instanceof RemoteVideoTrack)) return 0;
  let tallest = 0;
  for (const element of track.attachedElements) {
    tallest = Math.max(tallest, element.getBoundingClientRect().height);
  }
  return tallest;
}
