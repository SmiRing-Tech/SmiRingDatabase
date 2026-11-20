import type { CamFpsStep, VideoLevel } from './governorPolicy';

/**
 * Where the load governor starts a call on this browser (2026-11-20): the level it spent the most
 * time at in the last call of 3 minutes or more, for up to two weeks — or, with nothing
 * remembered, the middle (720p 10fps, 'high' kept). A machine that needs the lighter steps no
 * longer goes through the heaviest settings at the start of every call; one that doesn't is lifted
 * within about a minute by the governor's fast restore (the start counts as a brief episode).
 *
 * Only this device's own sending side is remembered — the camera's frame rate and resolution and
 * the background on 'balanced' — capped at 540p 10fps. The receiving steps depend on who else is
 * in the call, and nobody should start a call in photo mode.
 */
export interface StartLevel {
  video: VideoLevel;
  camFps: CamFpsStep;
  bgBalanced: boolean;
}

const KEY = 'smiring.connect.startLevel';
const MAX_AGE_MS = 14 * 24 * 3600_000;
/** A call shorter than this (camera on) says too little to remember. */
export const START_LEVEL_MIN_CALL_MS = 180_000;

/** With nothing remembered: 720p at 10fps, the background on 'high'. */
export const FIRST_CALL_START: StartLevel = { video: 0, camFps: 2, bgBalanced: false };

export function readStartLevel(): { level: StartLevel; remembered: boolean } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StartLevel> & { savedAt?: number };
      if (typeof parsed.savedAt === 'number' && Date.now() - parsed.savedAt < MAX_AGE_MS) {
        return { level: normalize(parsed), remembered: true };
      }
    }
  } catch {
    // Unreadable or blocked storage: treat as nothing remembered.
  }
  return { level: FIRST_CALL_START, remembered: false };
}

export function writeStartLevel(level: StartLevel): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...normalize(level), savedAt: Date.now() }));
  } catch {
    // Full or disabled storage: the next call starts in the middle again.
  }
}

/** Caps at 540p 10fps; the frame-rate steps only exist at full resolution. */
export function normalize(level: Partial<StartLevel>): StartLevel {
  const video: VideoLevel = level.video === 1 || level.video === 2 ? 1 : 0;
  const camFps: CamFpsStep = video === 0 && (level.camFps === 1 || level.camFps === 2) ? level.camFps : 0;
  return { video, camFps, bgBalanced: level.bgBalanced === true };
}

/** The background quality to build at the start of a call: 'balanced' when that's remembered. */
export function startBackgroundQuality<Q extends string>(quality: Q): Q | 'balanced' {
  return readStartLevel().level.bgBalanced ? 'balanced' : quality;
}
