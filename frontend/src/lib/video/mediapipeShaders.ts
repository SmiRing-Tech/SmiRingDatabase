/** Fragment shaders for the MediaPipe background processor. */

/**
 * Turns one MediaPipe confidence mask into an alpha matte.
 *
 * The matte is soft (values across the whole 0..1 range), which is what buys
 * the hair detail a binary category mask throws away. `u_lo`/`u_hi` re-shape
 * the confidence curve so semi-transparent strands stay visible without the
 * background bleeding through the body, and `u_history` blends in last frame's
 * matte to stop the edge from crawling between frames.
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

out vec4 fragColor;

void main() {
  float confidence = texture(u_mask, texCoords).r;
  float alpha = mix(confidence, 1.0 - confidence, u_invert);
  // Linear remap, deliberately not smoothstep: an S-curve pushes mid-confidence
  // pixels toward 0 or 1, which is precisely the soft hair detail we are here to
  // keep. This only clips the noise floor and saturates the solid body.
  alpha = clamp((alpha - u_lo) / max(1e-4, u_hi - u_lo), 0.0, 1.0);

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

out vec4 fragColor;

void main() {
  vec3 foreground = texture(u_frame, texCoords).rgb;
  vec2 backgroundCoords = texCoords * u_background_scale + u_background_offset;
  vec3 background = texture(u_background, backgroundCoords).rgb;
  float alpha = clamp(texture(u_alpha, texCoords).r, 0.0, 1.0);
  float blend = mix(alpha, 1.0 - alpha, u_swap_sides);
  fragColor = vec4(mix(background, foreground, blend), 1.0);
}`;
