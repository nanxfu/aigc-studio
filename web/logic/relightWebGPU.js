/**
 * 物理动态打光（M4.2e-3 / M4.2g）的 WebGPU 计算着色器实时管线。
 *
 * 相比 WebGL 1 片段路径，WebGPU 管线额外提供：
 *  1. `r32float` 全精度深度输入（消除 8-bit 深度量化在平缓天空/墙面引起的等高线波纹）；
 *  2. 32 步屏幕空间光线步进投射阴影（SSS）+ 7×7 深度双边去噪 + SSAO + 远景天空衰减；
 *  3. 线性空间 Cook-Torrance GGX PBR + 原图高频微法线（Detail Bump）+ 自发光保护；
 *  4. 可选 2.5D 屏幕空间间接漫反射反弹（GI / Color Bleeding）。
 *
 * 无 WebGPU、适配器不可用、着色器编译失败或设备丢失时返回 `null`，调用方无缝回退
 * `renderPhysicalRelightWebGL` 或 CPU `applyPhysicalRelight`。
 */

import { normalPixelsFromDepth, resizeDepth } from './depthFx.js'

const WGSL_COMMON = /* wgsl */ `
struct Params {
  lightPos: vec4<f32>,     // x, y in [0..1], z (>0 in front of image), spotRadius
  lightColor: vec4<f32>,   // rgb, intensity
  fillPos: vec4<f32>,      // x, y, z, fillIntensity
  fillColor: vec4<f32>,    // rgb, rimStrength
  flags: vec4<f32>,        // ambient, shadowStrength, detailBump, hasPbr
  texSize: vec4<f32>,      // width, height, aspect(w/h), giStrength
};

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  return pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
}

fn filmicCurve(x: vec3<f32>) -> vec3<f32> {
  let knee = vec3<f32>(0.82);
  let over = max(x - knee, vec3<f32>(0.0));
  return min(x, knee) + over / (vec3<f32>(1.0) + over * 1.45);
}

fn ign(pixel: vec2<f32>) -> f32 {
  let magic = vec3<f32>(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(pixel, magic.xy)));
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn saturationOf(c: vec3<f32>) -> f32 {
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  return (mx - mn) / max(mx, 1e-4);
}

fn ggxD(ndh: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let denom = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / max(3.14159265 * denom * denom, 1e-5);
}

fn schlickF(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn smithG(ndv: f32, ndl: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  let gv = ndv / (ndv * (1.0 - k) + k);
  let gl = ndl / (ndl * (1.0 - k) + k);
  return gv * gl;
}

fn sampleDepthFloat(uDepth: texture_2d<f32>, uv: vec2<f32>, texSize: vec2<f32>) -> f32 {
  let c = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.9999)) * texSize;
  let i0 = vec2<i32>(floor(c));
  let f = fract(c);
  let maxCoord = vec2<i32>(i32(texSize.x) - 1, i32(texSize.y) - 1);
  let d00 = textureLoad(uDepth, clamp(i0, vec2<i32>(0), maxCoord), 0).r;
  let d10 = textureLoad(uDepth, clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), maxCoord), 0).r;
  let d01 = textureLoad(uDepth, clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), maxCoord), 0).r;
  let d11 = textureLoad(uDepth, clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), maxCoord), 0).r;
  return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
}
`

const COMPUTE_SHADOW_AO_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uDepth: texture_2d<f32>;
@group(0) @binding(1) var uNormal: texture_2d<f32>;
@group(0) @binding(2) var uSamp: sampler;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var outShadowAO: texture_storage_2d<rgba8unorm, write>;

const Z_SCALE: f32 = 0.55;

fn computeSSAO(uv: vec2<f32>, depthCenter: f32, pixelCoord: vec2<f32>) -> f32 {
  let texel = vec2<f32>(1.0) / params.texSize.xy;
  let jitter = ign(pixelCoord) * 6.2831853;
  var occ: f32 = 0.0;
  let taps = 12;
  for (var i = 0; i < taps; i = i + 1) {
    let fi = f32(i);
    let ang = jitter + fi * 2.3999632;
    let rad = (0.3 + 0.7 * ((fi + 0.5) / f32(taps))) * 14.0;
    let sUv = uv + vec2<f32>(cos(ang), sin(ang)) * rad * texel;
    if (sUv.x >= 0.0 && sUv.x <= 1.0 && sUv.y >= 0.0 && sUv.y <= 1.0) {
      let sDepth = sampleDepthFloat(uDepth, sUv, params.texSize.xy);
      let diff = depthCenter - sDepth;
      if (diff > 0.005 && diff < 0.11) {
        let rangeW = 1.0 - smoothstep(0.035, 0.11, diff);
        occ = occ + smoothstep(0.005, 0.03, diff) * rangeW;
      }
    }
  }
  return clamp(1.0 - (occ / f32(taps)) * 1.10, 0.44, 1.0);
}

fn computeShadow(uv: vec2<f32>, depthCenter: f32, normal: vec3<f32>, pixelCoord: vec2<f32>) -> f32 {
  let shadowStrength = params.flags.y;
  if (shadowStrength <= 0.001) { return 1.0; }

  let skyFade = 1.0 - smoothstep(0.58, 0.82, depthCenter);
  if (skyFade <= 0.01) { return 1.0; }

  let startZ = -depthCenter * Z_SCALE;
  let lightZ = max(0.05, params.lightPos.z) * Z_SCALE;
  let deltaXY = params.lightPos.xy - uv;
  let dist2D = length(deltaXY);
  if (dist2D < 0.004) { return 1.0; }

  let maxMarch = min(dist2D, 0.14);
  let stepScale = maxMarch / dist2D;
  let steps = 32;
  let jitter = ign(pixelCoord);

  let slopeBias = 0.015 + (1.0 - max(normal.z, 0.0)) * 0.018;
  let thickness = 0.095;
  var vis: f32 = 1.0;

  for (var i = 1; i <= steps; i = i + 1) {
    let frac = (f32(i) - 0.5 + jitter * 0.85) / f32(steps);
    let t = frac * stepScale;
    let sUv = uv + deltaXY * t;
    if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) { break; }

    let rayZ = mix(startZ, lightZ, t);
    let sceneZ = -sampleDepthFloat(uDepth, sUv, params.texSize.xy) * Z_SCALE;
    let pen = sceneZ - rayZ;
    if (pen > slopeBias && pen < thickness) {
      let edgeFade = 1.0 - smoothstep(thickness * 0.50, thickness, pen);
      let occ = smoothstep(slopeBias, slopeBias + 0.025, pen) * edgeFade;
      let penumbra = mix(0.82, 0.30, frac);
      vis = min(vis, 1.0 - occ * penumbra);
    }
  }
  return mix(1.0, clamp(vis, 0.22, 1.0), shadowStrength * skyFade);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.texSize.x);
  let h = u32(params.texSize.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let pixelCoord = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let uv = pixelCoord / params.texSize.xy;
  let depthCenter = sampleDepthFloat(uDepth, uv, params.texSize.xy);
  let N = normalize(textureSampleLevel(uNormal, uSamp, uv, 0.0).rgb * 2.0 - 1.0);

  let shadow = computeShadow(uv, depthCenter, N, pixelCoord);
  let ao = computeSSAO(uv, depthCenter, pixelCoord);
  textureStore(outShadowAO, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(shadow, ao, 0.0, 1.0));
}
`

const COMPUTE_DENOISE_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uRawShadowAO: texture_2d<f32>;
@group(0) @binding(1) var uDepth: texture_2d<f32>;
@group(0) @binding(2) var uSamp: sampler;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var outCleanShadowAO: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.texSize.x);
  let h = u32(params.texSize.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let uv = (vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5)) / params.texSize.xy;
  let texel = vec2<f32>(1.0) / params.texSize.xy;
  let centerD = sampleDepthFloat(uDepth, uv, params.texSize.xy);
  var accum = vec2<f32>(0.0);
  var wSum: f32 = 0.0;

  for (var dy = -3; dy <= 3; dy = dy + 1) {
    for (var dx = -3; dx <= 3; dx = dx + 1) {
      let sUv = clamp(uv + vec2<f32>(f32(dx), f32(dy)) * texel * 2.2, vec2<f32>(0.0), vec2<f32>(1.0));
      let sD = sampleDepthFloat(uDepth, sUv, params.texSize.xy);
      let dDiff = abs(sD - centerD);
      let wDepth = exp(-dDiff * dDiff * 520.0);
      let wSpatial = exp(-f32(dx * dx + dy * dy) * 0.12);
      let wt = wDepth * wSpatial;
      let val = textureSampleLevel(uRawShadowAO, uSamp, sUv, 0.0).rg;
      accum = accum + val * wt;
      wSum = wSum + wt;
    }
  }
  let clean = accum / max(wSum, 1e-4);
  textureStore(outCleanShadowAO, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(clean.x, clean.y, 0.0, 1.0));
}
`

const COMPUTE_DIRECT_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uAlbedo: texture_2d<f32>;
@group(0) @binding(1) var uNormal: texture_2d<f32>;
@group(0) @binding(2) var uRoughness: texture_2d<f32>;
@group(0) @binding(3) var uMetallic: texture_2d<f32>;
@group(0) @binding(4) var uDepth: texture_2d<f32>;
@group(0) @binding(5) var uShadowAO: texture_2d<f32>;
@group(0) @binding(6) var uSource: texture_2d<f32>;
@group(0) @binding(7) var uSamp: sampler;
@group(0) @binding(8) var<uniform> params: Params;
@group(0) @binding(9) var outDirect: texture_storage_2d<rgba16float, write>;

const Z_SCALE: f32 = 0.55;

fn computeNormalWithDetail(uv: vec2<f32>) -> vec4<f32> {
  let texel = vec2<f32>(1.0) / params.texSize.xy;
  let span = max(1.0, floor(min(params.texSize.x, params.texSize.y) / 256.0 + 0.5));
  let stepUv = texel * span;
  let dL = sampleDepthFloat(uDepth, uv - vec2<f32>(stepUv.x, 0.0), params.texSize.xy);
  let dR = sampleDepthFloat(uDepth, uv + vec2<f32>(stepUv.x, 0.0), params.texSize.xy);
  let dT = sampleDepthFloat(uDepth, uv - vec2<f32>(0.0, stepUv.y), params.texSize.xy);
  let dB = sampleDepthFloat(uDepth, uv + vec2<f32>(0.0, stepUv.y), params.texSize.xy);
  let depthGrad = max(abs(dR - dL), abs(dB - dT));
  let cliff = smoothstep(0.08, 0.24, depthGrad);

  var n = normalize(textureSampleLevel(uNormal, uSamp, uv, 0.0).rgb * 2.0 - 1.0);
  let hasPbr = params.flags.w > 0.5;
  if (!hasPbr && cliff > 0.0) {
    n = normalize(mix(n, vec3<f32>(0.0, 0.0, 1.0), cliff * 0.55));
  }

  let bumpAmp = params.flags.z * (1.0 - cliff * 0.90) * select(1.0, 0.25, hasPbr);
  if (bumpAmp > 0.001) {
    let lL = luminance(textureSampleLevel(uAlbedo, uSamp, uv - vec2<f32>(texel.x, 0.0), 0.0).rgb);
    let lR = luminance(textureSampleLevel(uAlbedo, uSamp, uv + vec2<f32>(texel.x, 0.0), 0.0).rgb);
    let lT = luminance(textureSampleLevel(uAlbedo, uSamp, uv - vec2<f32>(0.0, texel.y), 0.0).rgb);
    let lB = luminance(textureSampleLevel(uAlbedo, uSamp, uv + vec2<f32>(0.0, texel.y), 0.0).rgb);
    let gx = (lR - lL) * bumpAmp * 1.8;
    let gy = (lB - lT) * bumpAmp * 1.8;
    n = normalize(vec3<f32>(n.x - gx, n.y + gy, max(0.12, n.z)));
  }
  return vec4<f32>(n, cliff);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.texSize.x);
  let h = u32(params.texSize.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let uv = (vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5)) / params.texSize.xy;
  let albedoSample = textureSampleLevel(uAlbedo, uSamp, uv, 0.0);
  let sourceSample = textureSampleLevel(uSource, uSamp, uv, 0.0);
  let albedo = srgbToLinear(albedoSample.rgb);
  let sourceLin = srgbToLinear(sourceSample.rgb);

  let depth = sampleDepthFloat(uDepth, uv, params.texSize.xy);
  let nInfo = computeNormalWithDetail(uv);
  let N = nInfo.xyz;
  let cliff = nInfo.w;

  let sao = textureSampleLevel(uShadowAO, uSamp, uv, 0.0).rg;
  let shadow = sao.x;
  let ao = sao.y;

  let roughness = clamp(mix(0.08, 0.96, textureSampleLevel(uRoughness, uSamp, uv, 0.0).r), 0.08, 0.96);
  let metallic = clamp(textureSampleLevel(uMetallic, uSamp, uv, 0.0).r, 0.0, 1.0);
  let hasPbr = params.flags.w > 0.5;

  let aspect = params.texSize.z;
  let P = vec3<f32>(uv.x * aspect, uv.y, -depth * Z_SCALE);
  let L_pos = vec3<f32>(params.lightPos.x * aspect, params.lightPos.y, params.lightPos.z * Z_SCALE);
  let delta = L_pos - P;
  let toLightRaw = vec3<f32>(delta.x, -delta.y, delta.z);
  let dist = max(length(toLightRaw), 1e-4);
  let L = toLightRaw / dist;
  let V = vec3<f32>(0.0, 0.0, 1.0);
  let H = normalize(L + V);

  let distAtten = 1.0 / (1.0 + dist * dist * 0.65);
  var spotFactor: f32 = 1.0;
  if (params.lightPos.w > 0.01) {
    let radial = length((uv - params.lightPos.xy) * vec2<f32>(aspect, 1.0));
    spotFactor = 1.0 - smoothstep(params.lightPos.w * 0.45, params.lightPos.w, radial);
  }

  let rawNdl = dot(N, L);
  let ndl = clamp((rawNdl + 0.20) / 1.20, 0.0, 1.0);
  let ndv = max(dot(N, V), 0.05);
  let ndh = max(dot(N, H), 0.0);
  let hdv = max(dot(H, V), 0.0);

  let f0 = mix(vec3<f32>(0.04), albedo, metallic);
  let F = schlickF(hdv, f0);
  let D = ggxD(ndh, roughness);
  let G = smithG(ndv, max(rawNdl, 0.05), roughness);
  let specGain = select(0.50, 1.0, hasPbr);
  let specular = ((D * G * F) / max(4.0 * ndv * max(rawNdl, 0.08), 0.08)) * max(rawNdl, 0.0) * specGain;
  let kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);

  let keyLightCol = srgbToLinear(params.lightColor.rgb) * params.lightColor.w * distAtten * spotFactor;
  let directKey = (kD * albedo * ndl + specular) * keyLightCol * shadow;

  var fillContrib = vec3<f32>(0.0);
  if (params.fillPos.w > 0.001) {
    let F_pos = vec3<f32>(params.fillPos.x * aspect, params.fillPos.y, params.fillPos.z * Z_SCALE);
    let fDelta = F_pos - P;
    let fVec = normalize(vec3<f32>(fDelta.x, -fDelta.y, fDelta.z));
    let fNdl = clamp((dot(N, fVec) + 0.25) / 1.25, 0.0, 1.0);
    let fAtten = 1.0 / (1.0 + dot(fDelta, fDelta) * 0.45);
    fillContrib = albedo * (1.0 - metallic * 0.5) * srgbToLinear(params.fillColor.rgb) * params.fillPos.w * fNdl * fAtten;
  }

  let norm2D = length(N.xy);
  let light2D = max(length(L.xy), 1e-4);
  let rimAlign = select(0.5, clamp(dot(N.xy / norm2D, L.xy / light2D) * 0.5 + 0.5, 0.0, 1.0), norm2D > 1e-4);
  let fresnel = pow(1.0 - max(N.z, 0.0), 2.5) * (1.0 - cliff * 0.90);
  let rimScale = select(0.45, 0.90, hasPbr);
  let rimContrib = albedo * srgbToLinear(params.lightColor.rgb) * params.fillColor.w * rimScale * fresnel * (0.25 + 0.75 * rimAlign) * (0.45 + 0.55 * shadow);

  let perceptualAmbient = pow(clamp(params.flags.x, 0.0, 1.0), 1.6);
  let ambientTerm = perceptualAmbient * ao * (0.90 + depth * 0.15);
  let ambientContrib = albedo * ambientTerm;

  let srcLum = luminance(sourceSample.rgb);
  let srcSat = saturationOf(sourceSample.rgb);
  let emissiveMask = smoothstep(0.68, 0.96, srcLum) * smoothstep(0.22, 0.60, srcSat) * 0.75;
  let emissiveContrib = sourceLin * emissiveMask;

  let linearOut = directKey + fillContrib + rimContrib + ambientContrib + emissiveContrib;
  textureStore(outDirect, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(linearOut, sourceSample.a));
}
`

const COMPUTE_GI_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uDirect: texture_2d<f32>;
@group(0) @binding(1) var uNormal: texture_2d<f32>;
@group(0) @binding(2) var uDepth: texture_2d<f32>;
@group(0) @binding(3) var uAlbedo: texture_2d<f32>;
@group(0) @binding(4) var uSamp: sampler;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var outGI: texture_storage_2d<rgba8unorm, write>;

const Z_SCALE: f32 = 0.55;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.texSize.x);
  let h = u32(params.texSize.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let pixelCoord = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let uv = pixelCoord / params.texSize.xy;
  let directSample = textureSampleLevel(uDirect, uSamp, uv, 0.0);
  let directLinear = directSample.rgb;

  let giStrength = params.texSize.w;
  if (giStrength <= 0.001) {
    let finalCol = linearToSrgb(filmicCurve(directLinear));
    textureStore(outGI, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(finalCol, directSample.a));
    return;
  }

  let depthCenter = sampleDepthFloat(uDepth, uv, params.texSize.xy);
  let N = normalize(textureSampleLevel(uNormal, uSamp, uv, 0.0).rgb * 2.0 - 1.0);
  let albedo = srgbToLinear(textureSampleLevel(uAlbedo, uSamp, uv, 0.0).rgb);

  let dirs = 12;
  let rings = 6;
  let baseAngle = ign(pixelCoord) * 6.2831853;
  let maxRadiusUv = 0.20;
  var bounce = vec3<f32>(0.0);
  let radJitter = ign(pixelCoord + vec2<f32>(17.3, 9.1));

  for (var d = 0; d < dirs; d = d + 1) {
    let ang = baseAngle + (f32(d) / f32(dirs)) * 6.2831853;
    let dir2D = vec2<f32>(cos(ang), sin(ang));
    var maxSlope: f32 = -0.35;

    for (var r = 1; r <= rings; r = r + 1) {
      let frac = pow((f32(r) - 0.35 + radJitter * 0.5) / f32(rings), 1.4);
      let sUv = uv + dir2D * (frac * maxRadiusUv);
      if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) { break; }

      let sDepth = sampleDepthFloat(uDepth, sUv, params.texSize.xy);
      let dz = (depthCenter - sDepth) * Z_SCALE;
      let distXY = frac * maxRadiusUv;
      let slope = dz / max(distXY, 1e-4);

      if (slope > maxSlope && abs(depthCenter - sDepth) < 0.28) {
        maxSlope = slope;
        let sampleRad = textureSampleLevel(uDirect, uSamp, sUv, 0.0).rgb;
        let sN = normalize(textureSampleLevel(uNormal, uSamp, sUv, 0.0).rgb * 2.0 - 1.0);
        let dirView = normalize(vec3<f32>(dir2D.x, -dir2D.y, clamp(slope, 0.05, 2.0)));
        let recvCos = max(dot(N, dirView), 0.18);
        let emitCos = max(dot(sN, -dirView), 0.22);
        let falloff = 1.0 / (1.0 + distXY * 12.0);
        bounce = bounce + sampleRad * recvCos * emitCos * falloff;
      }
    }
  }

  let indirect = (bounce / max(f32(dirs) * 0.42, 1.0)) * (albedo * 0.7 + vec3<f32>(0.08)) * giStrength;
  let finalCol = linearToSrgb(filmicCurve(directLinear + indirect));
  textureStore(outGI, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(finalCol, directSample.a));
}
`

const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var uTex: texture_2d<f32>;
@group(0) @binding(1) var uSamp: sampler;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) idx: u32) -> VOut {
  var pos = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  var out: VOut;
  let p = pos[idx];
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  return textureSample(uTex, uSamp, in.uv);
}
`

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

function constantPixels(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 255
  }
  return { width, height, data }
}

let gpuStatePromise = null
let gpuFailed = false

function resetGpuState() {
  if (gpuStatePromise) {
    gpuStatePromise.then((state) => {
      if (state?.textures) Object.values(state.textures).forEach((tex) => { try { tex.destroy() } catch {} })
    }).catch(() => {})
  }
  gpuStatePromise = null
}

async function ensureGPU() {
  if (gpuFailed || typeof navigator === 'undefined' || !navigator.gpu || typeof document === 'undefined') {
    return null
  }
  if (!gpuStatePromise) {
    gpuStatePromise = (async () => {
      try {
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) return null
        const device = await adapter.requestDevice()
        if (!device) return null
        device.lost?.then(() => { resetGpuState() }).catch(() => {})
        const format = navigator.gpu.getPreferredCanvasFormat()
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('webgpu')
        if (!ctx) return null

        const shadowPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_SHADOW_AO_WGSL }), entryPoint: 'main' },
        })
        const denoisePipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_DENOISE_WGSL }), entryPoint: 'main' },
        })
        const directPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_DIRECT_WGSL }), entryPoint: 'main' },
        })
        const giPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_GI_WGSL }), entryPoint: 'main' },
        })
        const blitPipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module: device.createShaderModule({ code: BLIT_WGSL }), entryPoint: 'vs' },
          fragment: { module: device.createShaderModule({ code: BLIT_WGSL }), entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        })

        const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
        const uniformBuffer = device.createBuffer({
          size: 96,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })

        return {
          device,
          format,
          canvas,
          ctx,
          shadowPipeline,
          denoisePipeline,
          directPipeline,
          giPipeline,
          blitPipeline,
          sampler,
          uniformBuffer,
          width: 0,
          height: 0,
          textures: null,
          bindGroups: null,
        }
      } catch {
        gpuFailed = true
        return null
      }
    })()
  }
  return gpuStatePromise
}

function ensureSurfaceResources(state, width, height) {
  const { device, canvas, ctx, format } = state
  if (state.width === width && state.height === height && state.textures) return
  if (state.textures) {
    Object.values(state.textures).forEach((tex) => { try { tex.destroy() } catch {} })
  }
  canvas.width = width
  canvas.height = height
  ctx.configure({ device, format, alphaMode: 'premultiplied' })

  const sampleUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  const storageUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
  const outputUsage = storageUsage | GPUTextureUsage.COPY_SRC

  const texSource = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: sampleUsage })
  const texAlbedo = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: sampleUsage })
  const texNormal = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: sampleUsage })
  const texRough = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: sampleUsage })
  const texMetal = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: sampleUsage })
  const texDepth = device.createTexture({ size: [width, height, 1], format: 'r32float', usage: sampleUsage })
  const texRawShadow = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: storageUsage })
  const texCleanShadow = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: storageUsage })
  const texDirect = device.createTexture({ size: [width, height, 1], format: 'rgba16float', usage: storageUsage })
  const texGI = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: outputUsage })

  state.textures = {
    texSource,
    texAlbedo,
    texNormal,
    texRough,
    texMetal,
    texDepth,
    texRawShadow,
    texCleanShadow,
    texDirect,
    texGI,
  }
  state.bindGroups = {
    bgShadow: device.createBindGroup({
      layout: state.shadowPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texDepth.createView() },
        { binding: 1, resource: texNormal.createView() },
        { binding: 2, resource: state.sampler },
        { binding: 3, resource: { buffer: state.uniformBuffer } },
        { binding: 4, resource: texRawShadow.createView() },
      ],
    }),
    bgDenoise: device.createBindGroup({
      layout: state.denoisePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texRawShadow.createView() },
        { binding: 1, resource: texDepth.createView() },
        { binding: 2, resource: state.sampler },
        { binding: 3, resource: { buffer: state.uniformBuffer } },
        { binding: 4, resource: texCleanShadow.createView() },
      ],
    }),
    bgDirect: device.createBindGroup({
      layout: state.directPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texAlbedo.createView() },
        { binding: 1, resource: texNormal.createView() },
        { binding: 2, resource: texRough.createView() },
        { binding: 3, resource: texMetal.createView() },
        { binding: 4, resource: texDepth.createView() },
        { binding: 5, resource: texCleanShadow.createView() },
        { binding: 6, resource: texSource.createView() },
        { binding: 7, resource: state.sampler },
        { binding: 8, resource: { buffer: state.uniformBuffer } },
        { binding: 9, resource: texDirect.createView() },
      ],
    }),
    bgGI: device.createBindGroup({
      layout: state.giPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texDirect.createView() },
        { binding: 1, resource: texNormal.createView() },
        { binding: 2, resource: texDepth.createView() },
        { binding: 3, resource: texAlbedo.createView() },
        { binding: 4, resource: state.sampler },
        { binding: 5, resource: { buffer: state.uniformBuffer } },
        { binding: 6, resource: texGI.createView() },
      ],
    }),
    bgBlit: device.createBindGroup({
      layout: state.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texGI.createView() },
        { binding: 1, resource: state.sampler },
      ],
    }),
  }
  state.width = width
  state.height = height
}

function writeRgbaTexture(device, texture, pixels, width, height) {
  const raw = pixels.data instanceof Uint8Array
    ? pixels.data
    : new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength)
  device.queue.writeTexture(
    { texture },
    raw,
    { bytesPerRow: width * 4 },
    [width, height, 1],
  )
}

/**
 * 用 WebGPU 计算着色器渲染一帧物理动态打光。
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} image
 * @param {{width:number,height:number,data:Float32Array}} depth
 * @param {object} [options]
 * @param {boolean} [options.readPixels] true 时回读全分辨率 RGBA 供直接落盘，否则返回 `canvas` 供 `toDataURL()` 预览。
 * @returns {Promise<{canvas:HTMLCanvasElement,pixels:{width:number,height:number,data:Uint8ClampedArray}|null}|null>}
 */
export async function renderPhysicalRelightWebGPU(image, depth, options = {}) {
  if (!image?.data || !image.width || !image.height || !depth?.data) return null
  const state = await ensureGPU()
  if (!state) return null
  const width = Number(image.width)
  const height = Number(image.height)
  const field = depth.width === width && depth.height === height
    ? depth
    : resizeDepth(depth, width, height)
  if (!field) return null

  try {
    ensureSurfaceResources(state, width, height)
    const { device, canvas, ctx, textures, bindGroups, uniformBuffer } = state

    const albedo = options.albedo?.data && options.albedo.width === width && options.albedo.height === height
      ? options.albedo
      : image
    const normal = options.normal?.data && options.normal.width === width && options.normal.height === height
      ? options.normal
      : normalPixelsFromDepth(field)
    const roughness = options.roughness?.data && options.roughness.width === width && options.roughness.height === height
      ? options.roughness
      : constantPixels(width, height, 140)
    const metallic = options.metallic?.data && options.metallic.width === width && options.metallic.height === height
      ? options.metallic
      : constantPixels(width, height, 0)

    writeRgbaTexture(device, textures.texSource, image, width, height)
    writeRgbaTexture(device, textures.texAlbedo, albedo, width, height)
    writeRgbaTexture(device, textures.texNormal, normal, width, height)
    writeRgbaTexture(device, textures.texRough, roughness, width, height)
    writeRgbaTexture(device, textures.texMetal, metallic, width, height)

    const depthF32 = field.data instanceof Float32Array ? field.data : new Float32Array(field.data)
    device.queue.writeTexture(
      { texture: textures.texDepth },
      depthF32,
      { bytesPerRow: width * 4 },
      [width, height, 1],
    )

    const lightX = Math.max(0, Math.min(1, Number(options.lightX ?? 0.42)))
    const lightY = Math.max(0, Math.min(1, Number(options.lightY ?? 0.3)))
    const lightZ = Math.max(0.08, Math.min(1.2, Number(options.lightZ ?? 0.42)))
    const spotFocus = Math.max(0, Math.min(1, Number(options.spot ?? 0)))
    const spotRadius = spotFocus > 0.01 ? 1.25 + (0.24 - 1.25) * spotFocus : 0
    const keyRgb = colorTuple(options.color || '#FFF4E0')
    const intensity = Math.max(0, Number(options.intensity ?? 1.35))
    const rim = Math.max(0, Number(options.rim ?? 0.7))
    const ambient = Math.max(0, Math.min(1, Number(options.ambient ?? 0.32)))
    const shadowStrength = Math.max(0, Math.min(1, Number(options.shadow ?? 0.85)))
    const detailBump = Math.max(0, Math.min(1, Number(options.detailBump ?? 0.28)))
    const giStrength = options.gi === true ? 0.55 : Math.max(0, Number(options.gi) || 0)

    // 温和冷色辅助补光置于主光水平对侧，避免阴影死黑同时保持主光方向主导。
    const fillX = 1 - lightX
    const fillY = Math.min(0.85, lightY + 0.12)
    const uData = new Float32Array([
      lightX, lightY, lightZ, spotRadius,
      keyRgb[0], keyRgb[1], keyRgb[2], intensity,
      fillX, fillY, 0.45, 0.22,
      0.38, 0.62, 1.0, rim,
      ambient, shadowStrength, detailBump, options.hasPbrNormal === true ? 1 : 0,
      width, height, width / Math.max(1, height), giStrength,
    ])
    device.queue.writeBuffer(uniformBuffer, 0, uData)

    const wgX = Math.ceil(width / 8)
    const wgY = Math.ceil(height / 8)
    const encoder = device.createCommandEncoder()

    const p1 = encoder.beginComputePass()
    p1.setPipeline(state.shadowPipeline)
    p1.setBindGroup(0, bindGroups.bgShadow)
    p1.dispatchWorkgroups(wgX, wgY)
    p1.end()

    const p2 = encoder.beginComputePass()
    p2.setPipeline(state.denoisePipeline)
    p2.setBindGroup(0, bindGroups.bgDenoise)
    p2.dispatchWorkgroups(wgX, wgY)
    p2.end()

    const p3 = encoder.beginComputePass()
    p3.setPipeline(state.directPipeline)
    p3.setBindGroup(0, bindGroups.bgDirect)
    p3.dispatchWorkgroups(wgX, wgY)
    p3.end()

    const p4 = encoder.beginComputePass()
    p4.setPipeline(state.giPipeline)
    p4.setBindGroup(0, bindGroups.bgGI)
    p4.dispatchWorkgroups(wgX, wgY)
    p4.end()

    let pixels = null
    if (options.readPixels) {
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256
      const readBuffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      encoder.copyTextureToBuffer(
        { texture: textures.texGI },
        { buffer: readBuffer, bytesPerRow },
        [width, height, 1],
      )
      device.queue.submit([encoder.finish()])
      await readBuffer.mapAsync(GPUMapMode.READ)
      const mapped = new Uint8Array(readBuffer.getMappedRange())
      const out = new Uint8ClampedArray(width * height * 4)
      for (let y = 0; y < height; y += 1) {
        const srcOff = y * bytesPerRow
        const dstOff = y * width * 4
        out.set(mapped.subarray(srcOff, srcOff + width * 4), dstOff)
      }
      readBuffer.unmap()
      readBuffer.destroy()
      pixels = { width, height, data: out }
      return { canvas, pixels }
    }

    const rPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    })
    rPass.setPipeline(state.blitPipeline)
    rPass.setBindGroup(0, bindGroups.bgBlit)
    rPass.draw(6)
    rPass.end()

    device.queue.submit([encoder.finish()])
    await device.queue.onSubmittedWorkDone()
    return { canvas, pixels: null }
  } catch {
    resetGpuState()
    return null
  }
}
