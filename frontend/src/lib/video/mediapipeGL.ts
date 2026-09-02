/**
 * Minimal WebGL2 helpers for the MediaPipe background processor.
 *
 * Orientation convention used across the pipeline:
 *   - every intermediate pass renders with `flipY = false` (identity texcoords),
 *     so a texture keeps whatever orientation it was created with;
 *   - only the final composite pass flips Y, and it flips the camera frame, the
 *     blurred background and the alpha matte together, so they stay aligned
 *     while the visible output ends up right side up (texImage2D puts row 0 of
 *     the frame at v=0, GL draws v=0 at the bottom).
 */

export type GLProgram<U extends string> = {
  program: WebGLProgram;
  position: number;
  uniforms: Record<U, WebGLUniformLocation | null>;
};

export function vertexShaderSource(flipY: boolean) {
  return `#version 300 es
  in vec2 position;
  out vec2 texCoords;
  void main() {
    texCoords = (position + 1.0) / 2.0;
    ${flipY ? 'texCoords.y = 1.0 - texCoords.y;' : ''}
    gl_Position = vec4(position, 0.0, 1.0);
  }`;
}

export function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}`);
  }
  return shader;
}

export function createProgram<U extends string>(
  gl: WebGL2RenderingContext,
  fragmentSource: string,
  uniformNames: readonly U[],
  flipY = false,
): GLProgram<U> {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource(flipY));
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders are reference-counted by the program; detaching lets the driver free them.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${info}`);
  }

  const uniforms = {} as Record<U, WebGLUniformLocation | null>;
  for (const name of uniformNames) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }

  return { program, position: gl.getAttribLocation(program, 'position'), uniforms };
}

/** A colour texture plus the framebuffer that renders into it. */
export type RenderTarget = {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
};

export function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

export function createRenderTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): RenderTarget {
  const texture = createTexture(gl);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // RGBA8 everywhere: renderable in core WebGL2 with no float-buffer extension,
  // and 8 bits of alpha is plenty for a matte.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete (0x${status.toString(16)})`);
  }

  return { texture, framebuffer, width, height };
}

export function deleteRenderTarget(gl: WebGL2RenderingContext, target: RenderTarget) {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

export function createQuadBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  return buffer;
}

/** Binds the quad, sizes the viewport to the target, and issues the draw. */
export function drawQuad(
  gl: WebGL2RenderingContext,
  quadBuffer: WebGLBuffer,
  positionLocation: number,
  target: RenderTarget | null,
  viewportWidth: number,
  viewportHeight: number,
) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
  gl.viewport(0, 0, viewportWidth, viewportHeight);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

export function bindTextureUnit(
  gl: WebGL2RenderingContext,
  unit: number,
  texture: WebGLTexture,
  location: WebGLUniformLocation | null,
) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (location) gl.uniform1i(location, unit);
}
