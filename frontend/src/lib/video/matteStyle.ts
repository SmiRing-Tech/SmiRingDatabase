import type { SegmentationQuality } from './MediapipeBackgroundProcessor';

/**
 * How each model's confidence mask becomes the cut-out edge. Shared by the main-thread processor,
 * the compositor worker and the segmenter worker, so it imports nothing at runtime (workers must
 * not pull in MediapipeBackgroundProcessor).
 *
 *  - 'contour' (both models): the 256x144 balanced mask is nearly binary, so turning it into alpha with a
 *    linear ramp leaves its pixel grid visible as stair-steps. Instead the matte keeps the smooth
 *    confidence FIELD (upsampled with a blur-and-upsample kernel, temporally smoothed), and the
 *    composite cuts it at its iso-line with an anti-aliased step. The edge is a smooth curve and
 *    stays sharp. One matte pass at quarter resolution, no feather passes.
 *    Tuned in /dev/matte-lab (contour edge, fused blur 0.5, softness 2); measured there at about a
 *    third of the old matte stage's GPU time.
 *    The multiclass `high` model was checked by eye in the lab too and looks right with the same
 *    settings.
 *  - 'ramp': the previous style — linear lo/hi ramp at half resolution plus a matte-resolution
 *    feather (MatteOptions.matteLo/matteHi/edgeFeather). No model uses it now; kept as the
 *    fallback style for a future model whose soft mask a hard cut would spoil.
 */
export interface MatteStyle {
  edge: 'ramp' | 'contour';
  /** Matte resolution as a fraction of the frame. */
  matteScale: 0.5 | 0.25;
  /** contour: gaussian-equivalent spread folded into the mask read, in mask pixels (see fusedKernel). */
  maskBlur: number;
  /** contour: where the edge sits on the confidence field. */
  threshold: number;
  /** contour: anti-aliasing width of the edge, in output pixels. */
  softness: number;
}

export const MATTE_STYLE: Record<SegmentationQuality, MatteStyle> = {
  balanced: { edge: 'contour', matteScale: 0.25, maskBlur: 0.5, threshold: 0.5, softness: 2 },
  high: { edge: 'contour', matteScale: 0.25, maskBlur: 0.5, threshold: 0.5, softness: 2 },
};

/** Height of each model's own mask, in pixels; the width follows the camera's aspect. */
export const MODEL_MASK_HEIGHT: Record<SegmentationQuality, number> = { balanced: 144, high: 256 };

/** Standard deviation, in taps, of the 9-tap gaussian in mediapipeShaders (what a blur step spreads). */
const GAUSSIAN_TAP_SIGMA = 1.6894;

/**
 * The fused kernel: 4x4 bilinear taps at (±0.5, ±1.5) x spacing, weights (outer, inner, inner,
 * outer) per axis with inner = 0.5 - outer. Matched by variance to a separate gaussian pass of the
 * same maskBlur (9 taps, step = maskBlur) followed by a bilinear upsample — i.e. what the
 * three-pass version did. Spacing stays 1 mask px while the weights can absorb the spread (keeps
 * the kernel monotonic), and only grows past that.
 */
export function fusedKernel(maskBlur: number): { spacing: number; outer: number } {
  const variance = (GAUSSIAN_TAP_SIGMA * maskBlur) ** 2 + 1 / 3;
  const tent = 1 / 6; // variance of one bilinear read
  if (variance <= tent + 0.25 + 1) {
    return { spacing: 1, outer: Math.min(0.25, Math.max(0, (variance - tent - 0.25) / 4)) };
  }
  return { spacing: Math.sqrt((variance - tent) / 1.25), outer: 0.25 };
}
