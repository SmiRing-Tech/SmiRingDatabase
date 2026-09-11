/**
 * torch.hann_window(N, periodic=True) — the "periodic" variant PyTorch defaults to divides by
 * N itself, not N-1 like numpy.hanning's symmetric window. Getting this wrong doesn't crash
 * anything, it just quietly detunes the analysis/synthesis window from what the model was
 * trained against. GTCRN's stream/gtcrn_stream.py uses this window raised to the 0.5 power for
 * both STFT and iSTFT (torch.hann_window(512).pow(0.5)), which is what sqrtHann512 reproduces.
 */
export function periodicHann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  return w;
}

export function sqrtHann(n: number): Float32Array {
  const w = periodicHann(n);
  for (let i = 0; i < w.length; i++) w[i] = Math.sqrt(w[i]);
  return w;
}
