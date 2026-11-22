/**
 * "Your internet connection is unstable" — shown only when this device's own connection is
 * really bad, and taken down once it has been fine for a while (2026-11-21).
 *
 * Judged every governor sample (2s) from two things that only a bad connection produces:
 *  - our mic's packet loss as the server reports it (RTCP; only while the mic is sending), and
 *  - the round trip to the server.
 * Not the uplink estimate: it also sits low whenever there is little to send (camera off), which
 * would read as "bad" in ordinary calls. Not LiveKit's connectionQuality either: it flipped to
 * 'poor' and back up to 148 times in one ordinary call.
 *
 * Replayed over every call recorded 2026-10-22 .. 11-21 (170 calls), these numbers showed it in
 * 12 calls, mostly once for under a minute; among them the two calls with a really bad uplink
 * (2026-11-15: 10 minutes over 3 times; 2026-11-21: listeners lost ~27 bits of speech in 15 min).
 */
export const NETWORK_WARNING = {
  /** A sample is bad at this much mic packet loss, % ... */
  lossPct: 10,
  /** ... or this long a round trip, ms. */
  rttMs: 1000,
  /** Shown when this many of the last `windowSamples` samples (2s each) were bad. */
  windowSamples: 15,
  showBadSamples: 5,
  /** Taken down after this many good samples in a row (30s). */
  clearGoodSamples: 15,
  /** Not shown again sooner than this after it was taken down. */
  cooldownMs: 120_000,
};

export interface NetworkWarningState {
  shown: boolean;
  recent: boolean[];
  goodRun: number;
  hiddenAt: number | null;
}

export function initialNetworkWarningState(): NetworkWarningState {
  return { shown: false, recent: [], goodRun: 0, hiddenAt: null };
}

export function isBadNetworkSample(micLossPct: number | undefined, rttMs: number | undefined): boolean {
  return (micLossPct !== undefined && micLossPct >= NETWORK_WARNING.lossPct) || (rttMs !== undefined && rttMs >= NETWORK_WARNING.rttMs);
}

export function stepNetworkWarning(
  state: NetworkWarningState,
  now: number,
  bad: boolean,
): { state: NetworkWarningState; change: 'show' | 'hide' | null } {
  const recent = [...state.recent, bad].slice(-NETWORK_WARNING.windowSamples);
  const goodRun = bad ? 0 : state.goodRun + 1;
  const badCount = recent.filter(Boolean).length;
  if (
    !state.shown &&
    badCount >= NETWORK_WARNING.showBadSamples &&
    (state.hiddenAt === null || now - state.hiddenAt >= NETWORK_WARNING.cooldownMs)
  ) {
    return { state: { shown: true, recent, goodRun, hiddenAt: state.hiddenAt }, change: 'show' };
  }
  if (state.shown && goodRun >= NETWORK_WARNING.clearGoodSamples) {
    return { state: { shown: false, recent, goodRun, hiddenAt: now }, change: 'hide' };
  }
  return { state: { ...state, recent, goodRun }, change: null };
}
