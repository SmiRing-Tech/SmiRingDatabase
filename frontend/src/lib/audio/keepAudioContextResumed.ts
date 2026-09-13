/**
 * Best-effort unlock for an AudioContext stuck `suspended` under the browser's autoplay policy.
 *
 * A single `resume()` call right after construction (what both call sites here used to do alone)
 * is not reliable: this pipeline is built from deep inside async work — mic permission, LiveKit's
 * ICE negotiation, an ONNX model download/compile on first use — so by the time `resume()` runs,
 * the user gesture that started the join (or the noise-cancel toggle) can already be too stale
 * for stricter browsers (notably Safari/WebKit, and in-app webviews) to honor it. `resume()`
 * fails silently in that case — no rejection, no error — and the graph runs and produces samples
 * that never reach the destination: the track looks live and unmuted, but nothing is audible.
 * That silent failure is exactly what made this bug read as "mic looks on but nobody can hear
 * me", fixed by toggling noise-cancel or rejoining (a fresh, still-valid gesture lands closer to
 * the `resume()` call and succeeds).
 *
 * Fix: keep retrying `resume()` on every subsequent page interaction until the context actually
 * reports `running`, so whichever tap/click happens next — not just the specific one that built
 * this graph — is what unlocks it.
 */
export function keepAudioContextResumed(ctx: AudioContext): () => void {
  const events = ['pointerdown', 'keydown', 'touchend'] as const;

  const detach = () => {
    events.forEach((e) => document.removeEventListener(e, onInteraction));
  };

  const tryResume = () => {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  };

  function onInteraction() {
    tryResume();
    if (ctx.state === 'running') detach();
  }

  tryResume();
  if (ctx.state !== 'running') {
    events.forEach((e) => document.addEventListener(e, onInteraction, { passive: true }));
  }

  return detach;
}
