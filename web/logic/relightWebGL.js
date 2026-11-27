/**
 * 物理动态打光（M4.2e-3 / M4.2g）的 WebGL 1 实时预览兜底实现。
 *
 * 浏览器不支持 WebGPU 时自动接管；与 `relightWebGPU.js` / `relight.js` 对齐：
 * 相机空间 Z 轴、线性空间光照、高频微凹凸法线、16 步屏幕空间阴影与自发光保护。
 * 无 WebGL、上下文创建失败或 shader 编译失败时返回 null，调用方继续回退 CPU。
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
uniform sampler2D u_source;
uniform vec2 u_light;
uniform vec3 u_color;
uniform float u_light_z;
uniform float u_intensity;
uniform float u_ambient;
uniform float u_rim;
uniform float u_shadow;
uniform float u_spot_radius;
uniform float u_detail_bump;
uniform vec2 u_texel;
uniform float u_aspect;
uniform float u_has_pbr_normal;

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float sampleDepth(vec2 uv) {
  return 1.0 - texture2D(u_depth, clamp(uv, 0.0, 1.0)).r;
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 albedoSample = texture2D(u_albedo, uv);
  vec4 sourceSample = texture2D(u_source, uv);
  vec3 albedo = pow(max(albedoSample.rgb, vec3(0.0)), vec3(2.2));
  vec3 sourceLin = pow(max(sourceSample.rgb, vec3(0.0)), vec3(2.2));
  float depth = sampleDepth(uv);

  float minDim = 1.0 / max(max(u_texel.x, u_texel.y), 1e-5);
  float span = max(1.0, floor(minDim / 256.0 + 0.5));
  vec2 stepUv = u_texel * span;
  float dL = sampleDepth(uv - vec2(stepUv.x, 0.0));
  float dR = sampleDepth(uv + vec2(stepUv.x, 0.0));
  float dT = sampleDepth(uv - vec2(0.0, stepUv.y));
  float dB = sampleDepth(uv + vec2(0.0, stepUv.y));
  float depthGrad = max(abs(dR - dL), abs(dB - dT));
  float cliff = smoothstep(0.08, 0.24, depthGrad);

  vec3 normal = normalize(texture2D(u_normal, uv).rgb * 2.0 - 1.0);
  if (u_has_pbr_normal < 0.5 && cliff > 0.0) {
    normal = normalize(mix(normal, vec3(0.0, 0.0, 1.0), cliff * 0.55));
  }
  float bumpAmp = u_detail_bump * (1.0 - cliff * 0.90) * (u_has_pbr_normal > 0.5 ? 0.25 : 1.0);
  if (bumpAmp > 0.001) {
    float lL = luma(texture2D(u_albedo, clamp(uv - vec2(u_texel.x, 0.0), 0.0, 1.0)).rgb);
    float lR = luma(texture2D(u_albedo, clamp(uv + vec2(u_texel.x, 0.0), 0.0, 1.0)).rgb);
    float lT = luma(texture2D(u_albedo, clamp(uv - vec2(0.0, u_texel.y), 0.0, 1.0)).rgb);
    float lB = luma(texture2D(u_albedo, clamp(uv + vec2(0.0, u_texel.y), 0.0, 1.0)).rgb);
    normal = normalize(vec3(normal.x - (lR - lL) * bumpAmp * 1.8, normal.y + (lB - lT) * bumpAmp * 1.8, max(0.12, normal.z)));
  }

  float roughness = clamp(mix(0.08, 0.96, texture2D(u_roughness, uv).r), 0.08, 0.96);
  float metallic = clamp(texture2D(u_metallic, uv).r, 0.0, 1.0);

  vec3 delta = vec3((u_light.x - uv.x) * u_aspect, -(u_light.y - uv.y), (u_light_z + depth) * 0.55);
  float dist = max(length(delta), 1e-4);
  vec3 lightDir = delta / dist;
  vec3 halfDir = normalize(lightDir + vec3(0.0, 0.0, 1.0));
  float distAtten = 1.0 / (1.0 + dist * dist * 0.65);
  float spotFactor = 1.0;
  if (u_spot_radius > 0.01) {
    float radial = length((uv - u_light) * vec2(u_aspect, 1.0));
    spotFactor = 1.0 - smoothstep(u_spot_radius * 0.45, u_spot_radius, radial);
  }

  float shadow = 1.0;
  float skyFade = 1.0 - smoothstep(0.58, 0.82, depth);
  vec2 dxy = u_light - uv;
  float dist2D = length(dxy);
  if (u_shadow > 0.001 && skyFade > 0.01 && dist2D > 0.004) {
    float stepScale = min(dist2D, 0.14) / dist2D;
    float startZ = -depth * 0.55;
    float targetZ = max(0.05, u_light_z) * 0.55;
    float slopeBias = 0.015 + (1.0 - max(normal.z, 0.0)) * 0.018;
    float vis = 1.0;
    for (int i = 1; i <= 16; i += 1) {
      float frac = (float(i) - 0.5) / 16.0;
      float t = frac * stepScale;
      vec2 sUv = uv + dxy * t;
      if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) break;
      float rayZ = mix(startZ, targetZ, t);
      float sceneZ = -sampleDepth(sUv) * 0.55;
      float pen = sceneZ - rayZ;
      if (pen > slopeBias && pen < 0.095) {
        float edgeFade = 1.0 - smoothstep(0.0475, 0.095, pen);
        float occ = smoothstep(slopeBias, slopeBias + 0.025, pen) * edgeFade;
        vis = min(vis, 1.0 - occ * mix(0.82, 0.30, frac));
      }
    }
    shadow = mix(1.0, clamp(vis, 0.22, 1.0), u_shadow * skyFade);
  }

  float rawNdl = dot(normal, lightDir);
  float diffuse = clamp((rawNdl + 0.20) / 1.20, 0.0, 1.0);
  float specPower = mix(80.0, 6.0, roughness);
  float specGain = u_has_pbr_normal > 0.5 ? 1.0 : 0.5;
  float specular = pow(max(dot(normal, halfDir), 0.0), specPower)
    * (1.0 - roughness * 0.7) * specGain * max(rawNdl, 0.0);

  vec3 keyLin = pow(max(u_color, vec3(0.0)), vec3(2.2)) * u_intensity * distAtten * spotFactor;
  float normLen2D = length(normal.xy);
  float lightLen2D = max(length(lightDir.xy), 1e-4);
  float rimAlign = normLen2D > 1e-4
    ? clamp(dot(normal.xy / normLen2D, lightDir.xy / lightLen2D) * 0.5 + 0.5, 0.0, 1.0)
    : 0.5;
  float rimScale = u_has_pbr_normal > 0.5 ? 0.90 : 0.45;
  float rim = pow(1.0 - max(normal.z, 0.0), 2.5) * (1.0 - cliff * 0.90) * u_rim * rimScale * (0.25 + 0.75 * rimAlign) * (0.45 + 0.55 * shadow);

  float ambientTerm = pow(clamp(u_ambient, 0.0, 1.0), 1.6) * (0.9 + depth * 0.15);
  float srcLum = luma(sourceSample.rgb);
  float srcMax = max(sourceSample.r, max(sourceSample.g, sourceSample.b));
  float srcSat = (srcMax - min(sourceSample.r, min(sourceSample.g, sourceSample.b))) / max(srcMax, 1e-4);
  float emissiveMask = smoothstep(0.68, 0.96, srcLum) * smoothstep(0.22, 0.60, srcSat) * 0.75;

  vec3 rawColor = albedo * (ambientTerm + keyLin * diffuse * shadow)
    + mix(keyLin, albedo * keyLin, metallic) * specular * shadow
    + albedo * rim * pow(max(u_color, vec3(0.0)), vec3(2.2))
    + sourceLin * emissiveMask;

  vec3 over = max(rawColor - vec3(0.82), vec3(0.0));
  vec3 filmic = min(rawColor, vec3(0.82)) + over / (vec3(1.0) + over * 1.45);
  vec3 srgb = pow(clamp(filmic, 0.0, 1.0), vec3(1.0 / 2.2));
  gl_FragColor = vec4(srgb, sourceSample.a);
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
      textures: Array.from({ length: 6 }, () => gl.createTexture()),
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
 * 用 WebGL 渲染一帧物理打光（WebGPU 不可用时的快速硬件兜底）。
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
    const roughness = options.roughness?.data ? options.roughness : grayscalePixels(width, height, 140)
    const metallic = options.metallic?.data ? options.metallic : grayscalePixels(width, height, 0)
    const layers = [
      albedo,
      normal,
      roughness,
      metallic,
      depthPixels,
      image,
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
      source: gl.getUniformLocation(program, 'u_source'),
      light: gl.getUniformLocation(program, 'u_light'),
      lightZ: gl.getUniformLocation(program, 'u_light_z'),
      color: gl.getUniformLocation(program, 'u_color'),
      intensity: gl.getUniformLocation(program, 'u_intensity'),
      ambient: gl.getUniformLocation(program, 'u_ambient'),
      rim: gl.getUniformLocation(program, 'u_rim'),
      shadow: gl.getUniformLocation(program, 'u_shadow'),
      spotRadius: gl.getUniformLocation(program, 'u_spot_radius'),
      detailBump: gl.getUniformLocation(program, 'u_detail_bump'),
      texel: gl.getUniformLocation(program, 'u_texel'),
      aspect: gl.getUniformLocation(program, 'u_aspect'),
      hasPbrNormal: gl.getUniformLocation(program, 'u_has_pbr_normal'),
    }
    state.uniforms = uniforms
    textures.forEach((texture, index) => {
      gl.activeTexture(gl.TEXTURE0 + index)
      gl.bindTexture(gl.TEXTURE_2D, texture)
    })
    const spotFocus = Math.max(0, Math.min(1, Number(options.spot ?? 0)))
    const spotRadius = spotFocus > 0.01 ? 1.25 + (0.24 - 1.25) * spotFocus : 0
    gl.uniform1i(uniforms.albedo, 0)
    gl.uniform1i(uniforms.normal, 1)
    gl.uniform1i(uniforms.roughness, 2)
    gl.uniform1i(uniforms.metallic, 3)
    gl.uniform1i(uniforms.depth, 4)
    gl.uniform1i(uniforms.source, 5)
    gl.uniform2f(
      uniforms.light,
      Math.max(0, Math.min(1, Number(options.lightX ?? 0.42))),
      Math.max(0, Math.min(1, Number(options.lightY ?? 0.3))),
    )
    gl.uniform1f(uniforms.lightZ, Math.max(0.08, Math.min(1.2, Number(options.lightZ ?? 0.42))))
    gl.uniform3fv(uniforms.color, colorTuple(options.color || '#FFF4E0'))
    gl.uniform1f(uniforms.intensity, Math.max(0, Number(options.intensity ?? 1.35)))
    gl.uniform1f(uniforms.ambient, Math.max(0, Math.min(1, Number(options.ambient ?? 0.32))))
    gl.uniform1f(uniforms.rim, Math.max(0, Number(options.rim ?? 0.7)))
    gl.uniform1f(uniforms.shadow, Math.max(0, Math.min(1, Number(options.shadow ?? 0.85))))
    gl.uniform1f(uniforms.spotRadius, spotRadius)
    gl.uniform1f(uniforms.detailBump, Math.max(0, Math.min(1, Number(options.detailBump ?? 0.28))))
    gl.uniform2f(uniforms.texel, 1 / Math.max(1, width), 1 / Math.max(1, height))
    gl.uniform1f(uniforms.aspect, width / Math.max(1, height))
    gl.uniform1f(uniforms.hasPbrNormal, options.hasPbrNormal === true ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.finish()
    return canvas
  } catch {
    return null
  }
}
