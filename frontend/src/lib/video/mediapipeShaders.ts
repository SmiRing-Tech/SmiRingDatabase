/** Fragment shaders for the MediaPipe background processor. */

/**
 * Turns one MediaPipe confidence mask into an alpha matte.
 *
 * The matte is soft (values across the whole 0..1 range), which is what buys
 * the hair detail a binary category mask throws away. `u_lo`/`u_hi` re-shape
 * the confidence curve so semi-transparent strands stay visible without the
 * background bleeding through the body, and `u_history` blends in last frame's
 * matte to stop the edge from crawling between frames.
 *
 * Two edge styles (see matteStyle.ts). 'ramp' (u_contour = 0): the lo/hi remap above, one bilinear
 * read of the mask. 'contour' (u_contour = 1): keep the smooth confidence field instead — read
 * through the fused blur-and-upsample kernel (u_fused) and skip the remap — and let the composite
 * cut it at its iso-line (see compositeFragmentShader).
 */
export const alphaFragmentShader = `#version 300 es
precision highp float;
in vec2 texCoords;

uniform sampler2D u_mask;       // MediaPipe confidence mask
uniform sampler2D u_history;    // previous frame's matte (temporal smoothing)
uniform float u_invert;         // 1.0 when the mask is background confidence
uniform float u_lo;             // confidence below this is fully background
uniform float u_hi;             // confidence above this is fully foreground
uniform float u_history_weight; // 0 = no temporal smoothing, ->1 = very sticky
uniform float u_contour;        // 1 = store the raw field for the composite to cut, 0 = lo/hi ramp here
uniform vec2 u_fused;           // contour: x = tap spacing in mask px (0 = plain bilinear read), y = outer tap weight
uniform vec2 u_mask_grid;       // the model's own mask grid; 0 = the mask texture is that grid already

out vec4 fragColor;

// 4x4 bilinear taps around the sample point: blurs and upsamples in one pass (weights: matteStyle.ts).
float fusedMask(vec2 uv) {
  vec2 grid = u_mask_grid.x > 0.0 ? u_mask_grid : vec2(textureSize(u_mask, 0));
  vec2 tapStep = u_fused.x / grid;
  float outer = u_fused.y;
  float inner = 0.5 - outer;
  vec4 offsets = vec4(-1.5, -0.5, 0.5, 1.5);
  vec4 weights = vec4(outer, inner, inner, outer);
  float sum = 0.0;
  for (int y = 0; y < 4; y++) {
    float row = 0.0;
    for (int x = 0; x < 4; x++) {
      row += weights[x] * texture(u_mask, uv + vec2(offsets[x], offsets[y]) * tapStep).r;
    }
    sum += weights[y] * row;
  }
  return sum;
}

void main() {
  float confidence = u_fused.x > 0.0 ? fusedMask(texCoords) : texture(u_mask, texCoords).r;
  float alpha = mix(confidence, 1.0 - confidence, u_invert);
  // Linear remap, deliberately not smoothstep: an S-curve pushes mid-confidence
  // pixels toward 0 or 1, which is precisely the soft hair detail we are here to
  // keep. This only clips the noise floor and saturates the solid body.
  float ramp = clamp((alpha - u_lo) / max(1e-4, u_hi - u_lo), 0.0, 1.0);
  alpha = mix(ramp, alpha, u_contour);

  // Temporal smoothing, but only where the matte is actually holding still.
  // A flat blend steadies the edge in stationary areas and smears it into a
  // trail wherever the subject moves, so fade the history out in proportion to
  // how much this pixel just changed: fast motion gets the fresh value intact.
  float previous = texture(u_history, texCoords).r;
  float motion = abs(alpha - previous);
  float weight = u_history_weight * (1.0 - smoothstep(0.04, 0.30, motion));
  alpha = mix(alpha, previous, weight);

  fragColor = vec4(alpha, alpha, alpha, 1.0);
}`;

/**
 * Separable 9-tap Gaussian. Used twice: with a small step to feather the matte,
 * and with a larger step (over a downsampled copy) to blur the background.
 */
export const gaussianFragmentShader = `#version 300 es
precision highp float;
in vec2 texCoords;

uniform sampler2D u_texture;
uniform vec2 u_step; // direction * texel size * spread

out vec4 fragColor;

const float w0 = 0.2270270270;
const float w1 = 0.1945945946;
const float w2 = 0.1216216216;
const float w3 = 0.0540540541;
const float w4 = 0.0162162162;

void main() {
  vec4 sum = texture(u_texture, texCoords) * w0;
  sum += (texture(u_texture, texCoords + u_step * 1.0) + texture(u_texture, texCoords - u_step * 1.0)) * w1;
  sum += (texture(u_texture, texCoords + u_step * 2.0) + texture(u_texture, texCoords - u_step * 2.0)) * w2;
  sum += (texture(u_texture, texCoords + u_step * 3.0) + texture(u_texture, texCoords - u_step * 3.0)) * w3;
  sum += (texture(u_texture, texCoords + u_step * 4.0) + texture(u_texture, texCoords - u_step * 4.0)) * w4;
  fragColor = sum;
}`;

/** Straight texture copy, used to downsample the frame before blurring it. */
export const copyFragmentShader = `#version 300 es
precision highp float;
in vec2 texCoords;
uniform sampler2D u_texture;
out vec4 fragColor;
void main() {
  fragColor = texture(u_texture, texCoords);
}`;

/**
 * Final pass: blends the sharp frame over the blurred background using the
 * matte. This is the only pass that flips Y (see mediapipeGL.ts).
 */
export const compositeFragmentShader = `#version 300 es
precision highp float;
in vec2 texCoords;

uniform sampler2D u_frame;
uniform sampler2D u_background;
uniform sampler2D u_alpha;
// Cover-fit mapping for the background. The blurred-frame background shares the
// frame's aspect, so it passes scale (1,1) / offset (0,0); a still image of a
// different aspect gets cropped to fill instead of stretched.
uniform vec2 u_background_scale;
uniform vec2 u_background_offset;
// 0 = the effect replaces the background (normal), 1 = it replaces the subject.
// Swapping which side the matte selects is all it takes.
uniform float u_swap_sides;
// x = contour style (0/1), y = threshold on the confidence field, z = anti-aliasing width in output pixels.
uniform vec3 u_edge;

out vec4 fragColor;

void main() {
  vec3 foreground = texture(u_frame, texCoords).rgb;
  vec2 backgroundCoords = texCoords * u_background_scale + u_background_offset;
  vec3 background = texture(u_background, backgroundCoords).rgb;
  float field = texture(u_alpha, texCoords).r;
  // Contour style: cut the smooth field at its iso-line. fwidth() is the field's change per output
  // pixel, so the step is about u_edge.z pixels wide wherever the edge is steep or shallow — a
  // crisp curved edge instead of a blurred one (the signed-distance-font trick). Ramp style passes
  // the matte through untouched. Derivatives are taken here, before any branch.
  float halfWidth = max(fwidth(field) * u_edge.z * 0.5, 1e-4);
  float contour = smoothstep(u_edge.y - halfWidth, u_edge.y + halfWidth, field);
  float alpha = clamp(mix(field, contour, u_edge.x), 0.0, 1.0);
  float blend = mix(alpha, 1.0 - alpha, u_swap_sides);
  fragColor = vec4(mix(background, foreground, blend), 1.0);
}`;
