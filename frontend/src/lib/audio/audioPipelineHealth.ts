/**
 * Live health readout of the outgoing mic pipeline (useVadAutoGate in CallRoomPage, plus the
 * GTCRN stage inside it), read by the always-on telemetry every sample and by the "通話の診断"
 * recorder as a probe.
 *
 * Exists to pin down "mic shows ON but nobody hears me" calls: the pipeline is
 *   raw mic -> [GTCRN ctx: clone -> capture -> worker -> playback] -> [gate ctx: clone -> delay ->
 *   voice finish -> gain] -> sender
 * and the signal level at each tap says exactly which stage turns sound into silence.
 *
 * Readers must not reset anything: telemetry and the diagnostics recorder read on their own
 * schedules, so everything here is either instantaneous or cumulative.
 */

export type AudioPipelineHealth = Record<string, string | number | boolean | null | undefined | Record<string, unknown>>;

let provider: (() => AudioPipelineHealth) | null = null;

/** Installs the current pipeline's reader. Returns an unregister that only removes this one. */
export function setAudioPipelineHealthProvider(p: () => AudioPipelineHealth): () => void {
  provider = p;
  return () => {
    if (provider === p) provider = null;
  };
}

export function readAudioPipelineHealth(): AudioPipelineHealth | undefined {
  if (!provider) return undefined;
  try {
    return provider();
  } catch (e) {
    return { err: String(e) };
  }
}

/** Peak level an AnalyserNode currently holds, dBFS rounded to 1dB. Exact digital silence is
 *  reported as -999, distinct from a real (however quiet) mic noise floor. */
export function analyserPeakDb(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  if (peak === 0) return -999;
  return Math.round(20 * Math.log10(peak));
}

/** Creates a tap: connect anything to the returned analyser, then read() it. */
export function createLevelTap(ctx: BaseAudioContext): { node: AnalyserNode; read: () => number } {
  const node = ctx.createAnalyser();
  node.fftSize = 2048;
  const buf = new Float32Array(node.fftSize);
  return { node, read: () => analyserPeakDb(node, buf) };
}

/** Compact "readyState/muted/enabled" for a MediaStreamTrack: e.g. "live", "live+m", "ended+d". */
export function trackStateTag(track: MediaStreamTrack | null | undefined): string {
  if (!track) return 'none';
  return `${track.readyState}${track.muted ? '+m' : ''}${track.enabled ? '' : '+d'}`;
}
