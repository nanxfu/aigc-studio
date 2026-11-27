/**
 * 物理动态打光的 WebGL 实时预览（M4.2e-3 轨道 1）。
 *
 * 与 `relight.js` 的 CPU 基准共用同一组输入：
 *   albedo / normal / roughness / metallic / depth。
 * 浏览器有 WebGL 时由 GPU 逐像素着色，拖动光源时无需回主线程做像素循环；
 * 无 WebGL、上下文创建失败或 shader 编译失败时返回 null，调用方回退 CPU 实现。
 */

import { normalPixelsFromDepth, pixelsFromDepth } from './depthFx.js'

const VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

const FRAGMENT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform sampler2D u_roughness;
uniform sampler2D u_metallic;
uniform sampler2D u_depth;
uniform vec2 u_light;
uniform vec3 u_color;
uniform float u_light_z;
uniform float u_intensity;
uniform float u_ambient;
uniform float u_rim;

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 base = texture2D(u_albedo, uv);
  float depth = 1.0 - texture2D(u_depth, uv).r;
  vec3 normal = normalize(texture2D(u_normal, uv).rgb * 2.0 - 1.0);
  float roughness = mix(0.04, 1.0, texture2D(u_roughness, uv).r);
  float metallic = texture2D(u_metallic, uv).r;
  vec3 lightDir = normalize(vec3((u_light.x - uv.x) * 3.2, -(u_light.y - uv.y) * 3.2, u_light_z));
  float attenuation = u_intensity / (1.0 + depth * 1.8);
  float pointFalloff = 1.0 / (1.0 + (pow(u_light.x - uv.x, 2.0) + pow(u_light.y - uv.y, 2.0)) * 2.1);
  float diffuse = max(dot(normal, lightDir), 0.0) * attenuation * pointFalloff;
  vec3 halfDir = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float specular = pow(max(dot(normal, halfDir), 0.0), mix(80.0, 6.0, roughness))
    * (1.0 - roughness * 0.7) * attenuation * pointFalloff;
  float rim = pow(1.0 - max(normal.z, 0.0), 3.0) * u_rim * attenuation;
  vec3 albedo = base.rgb;
  vec3 color = albedo * (u_ambient + u_color * diffuse)
    + mix(u_color, albedo, metallic) * specular
    + albedo * rim * u_color;
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), base.a);
}
`

function compile(gl, type, source) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function makeProgram(gl) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (!vertex || !fragment) return null
  const program = gl.createProgram()
  if (!program) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

function uploadTexture(gl, texture, pixels) {
  if (!texture) return false
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    pixels.width,
    pixels.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels.data instanceof Uint8Array
      ? pixels.data
      : new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength),
  )
  return true
}

function grayscalePixels(width, height, value = 128) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = value
    data[index + 1] = value
    data[index + 2] = value
    data[index + 3] = 255
  }
  return { width, height, data }
}

function colorTuple(hex) {
  const text = typeof hex === 'string' ? hex.trim().replace(/^#/, '') : ''
  const full = text.length === 3 ? text.split('').map((ch) => ch + ch).join('') : text
  if (!/^[0-9a-f]{6}$/i.test(full)) return [1, 1, 1]
  return [
    Number.parseInt(full.slice(0, 2), 16) / 255,
    Number.parseInt(full.slice(2, 4), 16) / 255,
    Number.parseInt(full.slice(4, 6), 16) / 255,
  ]
}

let surface = null

function getSurface(width, height) {
  if (!surface) {
    const canvas = document.createElement('canvas')
    let gl = null
    try {
      gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
      })
    } catch {
      gl = null
    }
    if (!gl) return null
    const program = makeProgram(gl)
    if (!program) return null
    surface = {
      canvas,
      gl,
      program,
      buffer: gl.createBuffer(),
      textures: Array.from({ length: 5 }, () => gl.createTexture()),
      uniforms: null,
      width: 0,
      height: 0,
    }
  }
  const { gl, canvas } = surface
  if (gl.isContextLost?.()) {
    surface = null
    return getSurface(width, height)
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
    surface.width = width
    surface.height = height
  }
  return surface
}

/**
 * 用 WebGL 渲染一帧物理打光。
 *
 * @returns {HTMLCanvasElement|null} 可继续 `toDataURL()` 的离屏画布；不可用时 null。
 */
export function renderPhysicalRelightWebGL(image, depth, options = {}) {
  if (typeof document === 'undefined' || !document.createElement || !image || !depth) return null
  const width = Number(image.width)
  const height = Number(image.height)
  if (!width || !height) return null
  const state = getSurface(width, height)
  if (!state) return null
  const { canvas, gl, program, buffer, textures } = state
  try {
    const normal = options.normal?.data ? options.normal : normalPixelsFromDepth(depth)
    const depthPixels = pixelsFromDepth(depth)
    const albedo = options.albedo?.data ? options.albedo : image
    const roughness = options.roughness?.data ? options.roughness : grayscalePixels(width, height, 150)
    const metallic = options.metallic?.data ? options.metallic : grayscalePixels(width, height, 0)
    const layers = [
      albedo,
      normal,
      roughness,
      metallic,
      depthPixels,
    ]
    if (!layers.every((pixels, index) => uploadTexture(gl, textures[index], pixels))) return null
    gl.useProgram(program)
    gl.viewport(0, 0, width, height)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    const position = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const uniforms = state.uniforms || {
      albedo: gl.getUniformLocation(program, 'u_albedo'),
      normal: gl.getUniformLocation(program, 'u_normal'),
      roughness: gl.getUniformLocation(program, 'u_roughness'),
      metallic: gl.getUniformLocation(program, 'u_metallic'),
      depth: gl.getUniformLocation(program, 'u_depth'),
      light: gl.getUniformLocation(program, 'u_light'),
      lightZ: gl.getUniformLocation(program, 'u_light_z'),
      color: gl.getUniformLocation(program, 'u_color'),
      intensity: gl.getUniformLocation(program, 'u_intensity'),
      ambient: gl.getUniformLocation(program, 'u_ambient'),
      rim: gl.getUniformLocation(program, 'u_rim'),
    }
    state.uniforms = uniforms
    textures.forEach((texture, index) => {
      gl.activeTexture(gl.TEXTURE0 + index)
      gl.bindTexture(gl.TEXTURE_2D, texture)
    })
    gl.uniform1i(uniforms.albedo, 0)
    gl.uniform1i(uniforms.normal, 1)
    gl.uniform1i(uniforms.roughness, 2)
    gl.uniform1i(uniforms.metallic, 3)
    gl.uniform1i(uniforms.depth, 4)
    gl.uniform2f(
      uniforms.light,
      Math.max(0, Math.min(1, Number(options.lightX ?? 0.5))),
      Math.max(0, Math.min(1, Number(options.lightY ?? 0.35))),
    )
    gl.uniform1f(uniforms.lightZ, Math.max(0.15, Number(options.lightZ ?? 0.72)))
    gl.uniform3fv(uniforms.color, colorTuple(options.color || '#FFF4E0'))
    gl.uniform1f(uniforms.intensity, Math.max(0, Number(options.intensity ?? 1.2)))
    gl.uniform1f(uniforms.ambient, Math.max(0, Number(options.ambient ?? 0.28)))
    gl.uniform1f(uniforms.rim, Math.max(0, Number(options.rim ?? 0.7)))
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.finish()
    return canvas
  } catch {
    return null
  }
}
