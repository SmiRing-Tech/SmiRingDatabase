/**
 * The localStorage debug flags Connect reads, with what each does — printed to the console when a
 * call starts (and recorded in telemetry) so it's obvious which ones are in effect. Setting or
 * removing one prints `undefined` in the console; that's normal. Flags are read when joining, so
 * reload before joining after changing one.
 */
const KNOWN_DEBUG_FLAGS: Record<string, string> = {
  'smiring.debug.segHalf': 'OBSOLETE (every frame sent has its own matte now) — remove it',
  'smiring.debug.segExact': 'OBSOLETE (every-frame segmentation is the default now) — remove it',
  'smiring.debug.loadGovernor': "load governor mode ('observe' = judge only, 'off' = nothing)",
  'smiring.debug.loadPanel': 'live load governor readout on screen',
  'smiring.debug.recvLevel': 'force a receive level (1-5)',
  'smiring.debug.forceShareStep': 'walk the screen-share fallback steps on a timer',
  'smiring.debug.bgPipeline': "background effect pipeline ('main' = main thread)",
  'smiring.debug.videoCodec': 'camera codec',
  'smiring.debug.shareCodec': 'screen-share codec',
  'smiring.debug.shareStats': 'screen-share stats logging',
};

/** Every known flag currently set, as { key: value }. */
export function activeDebugFlags(): Record<string, string> {
  const active: Record<string, string> = {};
  try {
    for (const key of Object.keys(KNOWN_DEBUG_FLAGS)) {
      const value = localStorage.getItem(key);
      if (value !== null) active[key] = value;
    }
  } catch {
    // Blocked storage: no flags can be set either.
  }
  return active;
}

/** Prints the active flags (or that there are none) to the console. Returns them. */
export function logActiveDebugFlags(): Record<string, string> {
  const active = activeDebugFlags();
  const keys = Object.keys(active);
  if (keys.length === 0) {
    console.info('[SmiRing debug] no debug flags set');
  } else {
    for (const key of keys) {
      console.info(`[SmiRing debug] ${key} = '${active[key]}' — ${KNOWN_DEBUG_FLAGS[key]}`);
    }
  }
  return active;
}
