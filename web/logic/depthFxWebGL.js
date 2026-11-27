/**
 * 工坊空间滤镜（depth-fx）的 WebGL 硬件兜底管线（16-bit 打包深度 + 全分辨率渲染）。
 *
 * 当浏览器不支持 WebGPU 时自动接管：
 *  - 16-bit RG 打包深度（65536 级精度，消除 8-bit 等高线波纹）+ RGB 引导边缘吸附采样；
 *  - 线性空间雾效与大气透视（对比度仅调制远景，前景保持原图锐度）；
 *  - 32-tap IGN Vogel Disk 防渗色景深（抑制轮廓光晕，焦内直通原图）；
 *  - 连续视差光线步进 + 背景边缘搜索补洞（双线性采样，消除针孔与锯齿撕裂）。
 *
 * 无 WebGL（如 Node 测试环境）时安全返回 `null`。
 */

import { renderBufferKey } from './renderBufferKey.js'

const MAX_GL_POINTS = 48

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

uniform sampler2D u_source;
uniform sampler2D u_depth16;
uniform sampler2D u_normal;

uniform vec4 u_dims;      // width, height, rawDepthW, rawDepthH
uniform vec4 u_mode_args; // mode (0..3), pointCount, scale, tiltShift
uniform vec4 u_color_a;   // rgb, blendScreen
uniform vec4 u_fog_a;     // density, startDepth, falloff, groundBias
uniform vec4 u_fog_b;     // horizon, hasNormal, haze, desaturate
uniform vec4 u_atmos_a;   // contrast, 0, 0, 0
uniform vec4 u_dof_a;     // focusX, focusY, aperture, blurMaxRadius
uniform vec4 u_parallax_a;// vxPx, vyPx, shiftMagPx, 0
uniform vec4 u_pt_geom[${MAX_GL_POINTS}];
uniform vec4 u_pt_ctrl[${MAX_GL_POINTS}];

vec3 srgbToLin(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(2.2));
}

vec3 linToSrgb(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float decodeDepthTexel(vec2 uv) {
  vec4 p = texture2D(u_depth16, clamp(uv, 0.0, 1.0));
  return clamp((floor(p.r * 255.0 + 0.5) * 256.0 + floor(p.g * 255.0 + 0.5)) / 65535.0, 0.0, 1.0);
}

float sampleDepthBilinear(vec2 uv) {
  vec2 rawDims = max(u_dims.zw, vec2(1.0));
  vec2 texel = 1.0 / rawDims;
  vec2 c = clamp(uv, 0.0, 0.99999) * rawDims - 0.5;
  vec2 f = fract(max(c, vec2(0.0)));
  vec2 base = (floor(max(c, vec2(0.0))) + 0.5) * texel;
  float d00 = decodeDepthTexel(base);
  float d10 = decodeDepthTexel(base + vec2(texel.x, 0.0));
  float d01 = decodeDepthTexel(base + vec2(0.0, texel.y));
  float d11 = decodeDepthTexel(base + texel);
  return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
}

float sampleRefinedDepth(vec2 uv) {
  vec2 texel = 1.0 / max(u_dims.xy, vec2(1.0));
  vec3 cRgb = texture2D(u_source, uv).rgb;
  float cD = sampleDepthBilinear(uv);
  float sumD = cD * 0.4;
  float sumW = 0.4;
  float stepMul = clamp(max(u_dims.x / max(u_dims.z, 1.0), u_dims.y / max(u_dims.w, 1.0)) * 0.72, 1.0, 2.5);
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      if (ox == 0 && oy == 0) continue;
      vec2 sUv = clamp(uv + vec2(float(ox), float(oy)) * texel * stepMul, 0.0, 1.0);
      vec3 sRgb = texture2D(u_source, sUv).rgb;
      float sD = sampleDepthBilinear(sUv);
      vec3 diff = sRgb - cRgb;
      float w = exp(-float(ox * ox + oy * oy) * 0.25 - dot(diff, diff) * 110.0);
      sumD += sD * w;
      sumW += w;
    }
  }
  return clamp(sumD / max(sumW, 1e-5), 0.0, 1.0);
}

float spatialWeightOf(vec2 uv) {
  int count = int(u_mode_args.y + 0.5);
  float aspect = u_dims.x / max(u_dims.y, 1.0);
  float weight = 1.0;
  for (int i = 0; i < ${MAX_GL_POINTS}; i++) {
    if (i >= count) break;
    vec4 g = u_pt_geom[i];
    vec4 c = u_pt_ctrl[i];
    vec2 d = vec2((uv.x - g.x) * aspect, uv.y - g.y);
    float radius = max(0.01, g.z);
    float feather = max(0.03, g.w);
    float inf = 1.0 - smoothstep(radius * (1.0 - feather * 0.35), radius, length(d));
    if (inf > 0.0) {
      float strength = max(0.0, c.x);
      if (c.y < 0.0) weight *= (1.0 - strength * inf);
      else weight += strength * inf;
    }
  }
  return max(0.0, weight);
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 texel = 1.0 / max(u_dims.xy, vec2(1.0));
  vec4 src = texture2D(u_source, uv);
  int mode = int(u_mode_args.x + 0.5);

  if (mode == 0) {
    float d = sampleRefinedDepth(uv);
    float startD = clamp(u_fog_a.y, 0.0, 1.0);
    float falloff = max(0.05, u_fog_a.z);
    float baseW = d <= startD ? 0.0 : 1.0 - exp(-(d - startD) * falloff * 4.2);
    float heightW = 1.0;
    float gb = u_fog_a.w;
    if (gb > 0.0) {
      float horizon = clamp(u_fog_b.x, 0.05, 0.98);
      float ground = smoothstep(horizon - 0.42, horizon + 0.18, uv.y);
      heightW = (1.0 - gb) + gb * (0.35 + 0.65 * ground);
      if (u_fog_b.y > 0.5) {
        vec3 n = normalize(texture2D(u_normal, uv).rgb * 2.0 - 1.0);
        heightW *= 0.82 + 0.28 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
      }
    }
    float spatial = spatialWeightOf(uv);
    float localBoost = spatial > 1.0 ? min(0.55, (spatial - 1.0) * 0.45) : 0.0;
    float effD = max(baseW, localBoost * (0.35 + 0.65 * d));
    float alpha = clamp(u_fog_a.x * effD * heightW * spatial, 0.0, 1.0);
    if (alpha <= 0.0001) {
      gl_FragColor = src;
      return;
    }
    vec3 srcLin = srgbToLin(src.rgb);
    vec3 fogLin = srgbToLin(u_color_a.rgb);
    vec3 outLin;
    if (u_color_a.w > 0.5) {
      vec3 scr = 1.0 - (1.0 - srcLin) * (1.0 - fogLin);
      outLin = mix(srcLin, scr, alpha * 0.88);
    } else {
      outLin = mix(srcLin, fogLin, alpha * 0.94);
    }
    gl_FragColor = vec4(linToSrgb(outLin), src.a);
    return;
  }

  if (mode == 1) {
    float d = sampleRefinedDepth(uv);
    float depthW = smoothstep(clamp(u_fog_a.y, 0.0, 1.0), 1.0, d);
    if (depthW <= 0.0001) {
      gl_FragColor = src;
      return;
    }
    vec3 srcLin = srgbToLin(src.rgb);
    float lum = luma(srcLin);
    vec3 colLin = mix(srcLin, vec3(lum), clamp(u_fog_b.w * depthW, 0.0, 1.0));
    colLin = mix(colLin, srgbToLin(u_color_a.rgb), clamp(u_fog_b.z * depthW, 0.0, 1.0));
    vec3 outSrgb = linToSrgb(colLin);
    float effContrast = mix(1.0, u_atmos_a.x, depthW);
    vec3 finalRgb = clamp((outSrgb - 0.5) * effContrast + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(finalRgb, src.a);
    return;
  }

  if (mode == 2) {
    float focusD = 0.0;
    float fwSum = 0.0;
    vec2 focusUv = clamp(u_dof_a.xy, 0.0, 1.0);
    for (int oy = -1; oy <= 1; oy++) {
      for (int ox = -1; ox <= 1; ox++) {
        float w = 1.0 / (1.0 + float(ox * ox + oy * oy));
        focusD += sampleRefinedDepth(clamp(focusUv + vec2(float(ox), float(oy)) * texel * 2.0, 0.0, 1.0)) * w;
        fwSum += w;
      }
    }
    focusD /= max(fwSum, 1e-5);
    float centerD = sampleRefinedDepth(uv);
    float aperture = max(0.02, u_dof_a.z);
    bool tilt = u_mode_args.w > 0.5;
    float deadzone = tilt ? aperture * 0.12 : aperture * 0.16;
    float diff = tilt ? clamp(abs(uv.y - u_dof_a.y) * 2.4, 0.0, 1.0) : (centerD - focusD);
    float cocMag = smoothstep(0.0, aperture, max(0.0, abs(diff) - deadzone));
    float signedCoc = (diff < 0.0 && !tilt) ? -cocMag : cocMag;
    float maxRadius = clamp(u_dof_a.w, 0.0, 52.0);
    float radius = cocMag * maxRadius;
    if (radius < 0.55) {
      gl_FragColor = src;
      return;
    }
    vec3 srcLin = srgbToLin(src.rgb);
    float centerW = max(0.04, 1.0 - cocMag * 0.9);
    vec3 acc = srcLin * centerW;
    float wAcc = centerW;
    float rot = ign(gl_FragCoord.xy) * 6.2831853;
    float cosR = cos(rot);
    float sinR = sin(rot);
    const int TAPS = 32;
    for (int i = 0; i < TAPS; i++) {
      float fi = float(i);
      float rNorm = sqrt((fi + 0.5) / float(TAPS));
      float theta = fi * 2.39996323;
      vec2 dir = vec2(cos(theta), sin(theta));
      vec2 rDir = vec2(dir.x * cosR - dir.y * sinR, dir.x * sinR + dir.y * cosR);
      vec2 sUv = clamp(uv + rDir * (rNorm * radius) * texel, 0.0, 1.0);
      float sD = sampleRefinedDepth(sUv);
      float sDiff = tilt ? clamp(abs(sUv.y - u_dof_a.y) * 2.4, 0.0, 1.0) : (sD - focusD);
      float sCoc = smoothstep(0.0, aperture, max(0.0, abs(sDiff) - deadzone));
      float wt = 1.0;
      if (signedCoc >= 0.0 && sD < centerD - 0.03) {
        wt = smoothstep(0.12, 0.42, sCoc) * 0.08;
      } else {
        wt = 0.2 + 0.8 * smoothstep(0.0, max(0.08, rNorm * 0.8), sCoc);
      }
      if (wt > 0.002) {
        vec3 sCol = srgbToLin(texture2D(u_source, sUv).rgb);
        float hl = 1.0 + 0.35 * pow(luma(sCol), 2.5) * sCoc;
        acc += sCol * wt * hl;
        wAcc += wt * hl;
      }
    }
    gl_FragColor = vec4(linToSrgb(acc / max(wAcc, 1e-4)), src.a);
    return;
  }

  gl_FragColor = src;
}
`

const GL_PACK_COMMON = `
precision highp float;
varying vec2 v_uv;
vec2 packD16(float d) {
  float q = floor(clamp(d, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(q / 256.0);
  float lo = clamp(q - hi * 256.0, 0.0, 255.0);
  return vec2(hi / 255.0, lo / 255.0);
}
float unpackD16(vec4 p) {
  return clamp((floor(p.r * 255.0 + 0.5) * 256.0 + floor(p.g * 255.0 + 0.5)) / 65535.0, 0.0, 1.0);
}
vec2 packU16(float val) {
  float q = floor(clamp(val, 0.0, 65535.0) + 0.5);
  float hi = floor(q / 256.0);
  float lo = clamp(q - hi * 256.0, 0.0, 255.0);
  return vec2(hi / 255.0, lo / 255.0);
}
float unpackU16(vec2 gb) {
  return floor(gb.x * 255.0 + 0.5) * 256.0 + floor(gb.y * 255.0 + 0.5);
}
vec3 srgbToLin(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
vec3 linToSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
`

const FRAG_GL_REFINE = GL_PACK_COMMON + `
uniform sampler2D u_rawDepth;
uniform sampler2D u_source;
uniform vec4 u_dims;
float decodeRaw(vec2 uv) {
  return unpackD16(texture2D(u_rawDepth, clamp(uv, 0.0, 1.0)));
}
float sampleRawBilinear(vec2 uv) {
  vec2 rawDims = max(u_dims.zw, vec2(1.0));
  vec2 texel = 1.0 / rawDims;
  vec2 c = clamp(uv, 0.0, 0.99999) * rawDims - 0.5;
  vec2 f = fract(max(c, vec2(0.0)));
  vec2 base = (floor(max(c, vec2(0.0))) + 0.5) * texel;
  float d00 = decodeRaw(base);
  float d10 = decodeRaw(base + vec2(texel.x, 0.0));
  float d01 = decodeRaw(base + vec2(0.0, texel.y));
  float d11 = decodeRaw(base + texel);
  return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
}
void main() {
  vec2 uv = v_uv;
  vec2 texel = 1.0 / max(u_dims.xy, vec2(1.0));
  vec3 cRgb = texture2D(u_source, uv).rgb;
  float cD = sampleRawBilinear(uv);
  float sumD = cD * 0.42;
  float sumW = 0.42;
  float stepMul = clamp(max(u_dims.x / max(u_dims.z, 1.0), u_dims.y / max(u_dims.w, 1.0)) * 0.72, 1.6, 3.0);
  float invColorVar = 1.0 / (2.0 * 0.035 * 0.035);
  float invSpatialVar = 1.0 / (2.0 * 1.65 * 1.65);
  for (int oy = -2; oy <= 2; oy++) {
    for (int ox = -2; ox <= 2; ox++) {
      if (ox == 0 && oy == 0) continue;
      vec2 sUv = clamp(uv + vec2(float(ox), float(oy)) * texel * stepMul, 0.0, 1.0);
      vec3 diff = texture2D(u_source, sUv).rgb - cRgb;
      float w = exp(-float(ox * ox + oy * oy) * invSpatialVar - dot(diff, diff) * invColorVar);
      sumD += sampleRawBilinear(sUv) * w;
      sumW += w;
    }
  }
  gl_FragColor = vec4(packD16(sumD / max(sumW, 1e-5)), 0.0, 1.0);
}
`

const FRAG_GL_CRISP = GL_PACK_COMMON + `
uniform sampler2D u_source;
uniform sampler2D u_depthTex;
uniform vec4 u_dims;
void main() {
  vec2 uv = v_uv;
  vec2 texel = 1.0 / max(u_dims.xy, vec2(1.0));
  vec3 centerRgb = texture2D(u_source, uv).rgb;
  float centerD = unpackD16(texture2D(u_depthTex, uv));
  float dMin = centerD;
  float dMax = centerD;
  float dLocalMin = centerD;
  float dLocalMax = centerD;
  vec3 rgbMin = centerRgb;
  vec3 rgbMax = centerRgb;
  for (int ly = -1; ly <= 1; ly++) {
    for (int lx = -1; lx <= 1; lx++) {
      if (lx == 0 && ly == 0) continue;
      float ld = unpackD16(texture2D(u_depthTex, clamp(uv + vec2(float(lx), float(ly)) * texel * 1.6, 0.0, 1.0)));
      dLocalMin = min(dLocalMin, ld);
      dLocalMax = max(dLocalMax, ld);
    }
  }
  for (int oy = -3; oy <= 3; oy++) {
    for (int ox = -3; ox <= 3; ox++) {
      if (ox == 0 && oy == 0) continue;
      vec2 pUv = clamp(uv + vec2(float(ox), float(oy)) * texel * 2.2, 0.0, 1.0);
      float pd = unpackD16(texture2D(u_depthTex, pUv));
      vec3 pRgb = texture2D(u_source, pUv).rgb;
      if (pd < dMin) { dMin = pd; rgbMin = pRgb; }
      if (pd > dMax) { dMax = pd; rgbMax = pRgb; }
    }
  }
  float span = dMax - dMin;
  float tRaw = (centerD - dMin) / max(span, 1e-4);
  float dLocalSpan = dLocalMax - dLocalMin;
  float snapMix = smoothstep(0.12, 0.20, span) * smoothstep(0.03, 0.08, dLocalSpan);
  float tailBgMix = smoothstep(0.25, 0.45, span) * smoothstep(0.84, 0.94, tRaw) * smoothstep(0.004, 0.015, dLocalSpan);
  float crispD = centerD;
  if (snapMix > 0.001 || tailBgMix > 0.001) {
    vec3 diffMin = centerRgb - rgbMin;
    vec3 diffMax = centerRgb - rgbMax;
    float eMin = dot(diffMin, diffMin);
    float eMax = dot(diffMax, diffMax);
    for (int sy = -2; sy <= 2; sy++) {
      for (int sx = -2; sx <= 2; sx++) {
        if (sx == 0 && sy == 0) continue;
        vec2 sUv = clamp(uv + vec2(float(sx), float(sy)) * texel * 2.5, 0.0, 1.0);
        float sd = unpackD16(texture2D(u_depthTex, sUv));
        vec3 sDiff = centerRgb - texture2D(u_source, sUv).rgb;
        float sErr = dot(sDiff, sDiff);
        if (sd <= dMin + 0.08) eMin = min(eMin, sErr);
        if (sd >= dMax - 0.08) eMax = min(eMax, sErr);
      }
    }
    float wColor = clamp((eMax - eMin) / max(eMin + eMax, 0.006), -1.0, 1.0);
    float wDepth = clamp((0.5 - tRaw) * 2.0, -1.0, 1.0);
    bool contaminatedFg = (tRaw < 0.72) && (eMax > 0.035) && (eMin < 0.28) && (eMax > eMin * 0.85);
    bool pickFg = contaminatedFg || ((wColor * 0.7 + wDepth * 0.3) >= -0.05);
    float effMix = pickFg ? snapMix : max(snapMix, tailBgMix * (eMax <= eMin * 0.4 ? 1.0 : 0.0));
    snapMix = effMix;
    crispD = mix(centerD, pickFg ? dMin : dMax, effMix);
  }
  gl_FragColor = vec4(packD16(crispD), snapMix, 1.0);
}
`

const FRAG_GL_BG_INIT = GL_PACK_COMMON + `
uniform sampler2D u_source;
uniform sampler2D u_crisp;
uniform vec4 u_dims;
uniform float u_outMode;
float pureCheck(vec2 uv, vec2 texel, float sd) {
  float m1 = max(
    max(abs(unpackD16(texture2D(u_crisp, clamp(uv + vec2(-texel.x, 0.0), 0.0, 1.0))) - sd),
        abs(unpackD16(texture2D(u_crisp, clamp(uv + vec2(texel.x, 0.0), 0.0, 1.0))) - sd)),
    max(abs(unpackD16(texture2D(u_crisp, clamp(uv + vec2(0.0, -texel.y), 0.0, 1.0))) - sd),
        abs(unpackD16(texture2D(u_crisp, clamp(uv + vec2(0.0, texel.y), 0.0, 1.0))) - sd))
  );
  float m2 = max(
    max(abs(unpackD16(texture2D(u_crisp, clamp(uv + vec2(-2.0 * texel.x, 0.0), 0.0, 1.0))) - sd),
        abs(unpackD16(texture2D(u_crisp, clamp(uv + vec2(2.0 * texel.x, 0.0), 0.0, 1.0))) - sd)),
    max(abs(unpackD16(texture2D(u_crisp, clamp(uv + vec2(0.0, -2.0 * texel.y), 0.0, 1.0))) - sd),
        abs(unpackD16(texture2D(u_crisp, clamp(uv + vec2(0.0, 2.0 * texel.y), 0.0, 1.0))) - sd))
  );
  return max(m1, m2);
}
vec3 cleanPlateauSrgb(vec2 uv, float refD, vec2 texel) {
  vec4 centerCrisp = texture2D(u_crisp, uv);
  if (centerCrisp.b > 0.25 || pureCheck(uv, texel, refD) > 0.12) {
    vec3 pSum = vec3(0.0);
    float pWSum = 0.0;
    for (int oy = -2; oy <= 2; oy++) {
      for (int ox = -2; ox <= 2; ox++) {
        vec2 sUv = clamp(uv + vec2(float(ox), float(oy)) * texel, 0.0, 1.0);
        float sd = unpackD16(texture2D(u_crisp, sUv));
        if (abs(sd - refD) > 0.08) continue;
        float pureW = pureCheck(sUv, texel, sd) < 0.08 ? 6.0 : 0.10;
        float wt = pureW * exp(-float(ox * ox + oy * oy) * 0.34);
        pSum += srgbToLin(texture2D(u_source, sUv).rgb) * wt;
        pWSum += wt;
      }
    }
    if (pWSum > 0.001) return linToSrgb(pSum / pWSum);
  }
  return texture2D(u_source, uv).rgb;
}
void main() {
  vec2 uv = v_uv;
  vec2 texel = 1.0 / max(u_dims.xy, vec2(1.0));
  float centerD = unpackD16(texture2D(u_crisp, uv));
  if (u_outMode < 0.5) {
    gl_FragColor = vec4(cleanPlateauSrgb(uv, centerD, texel), centerD);
    return;
  }
  float dMax5 = centerD;
  float nearMin5 = centerD;
  for (int oy = -2; oy <= 2; oy++) {
    for (int ox = -2; ox <= 2; ox++) {
      float pd = unpackD16(texture2D(u_crisp, clamp(uv + vec2(float(ox), float(oy)) * texel * 1.8, 0.0, 1.0)));
      dMax5 = max(dMax5, pd);
      nearMin5 = min(nearMin5, pd);
    }
  }
  float dMaxFg = dMax5;
  float nearMinFg = nearMin5;
  for (int d = 0; d < 8; d++) {
    float ang = (float(d) / 8.0) * 6.2831853;
    vec2 dir = vec2(cos(ang), sin(ang));
    float rimMidD = unpackD16(texture2D(u_crisp, clamp(uv + dir * texel * 11.0, 0.0, 1.0)));
    nearMinFg = min(nearMinFg, rimMidD);
    if (centerD < 0.26) {
      float rimD = unpackD16(texture2D(u_crisp, clamp(uv + dir * texel * 14.0, 0.0, 1.0)));
      dMaxFg = max(dMaxFg, max(rimMidD, rimD));
      for (int s = 1; s <= 6; s++) {
        float fgR = float(s) * 14.0;
        dMaxFg = max(dMaxFg, unpackD16(texture2D(u_crisp, clamp(uv + dir * texel * fgR, 0.0, 1.0))));
      }
    }
  }
  float fgTh = mix(0.16, 0.25, smoothstep(0.22, 0.42, centerD));
  float nearCheck = (nearMinFg < 0.22 && centerD < 0.40) ? nearMinFg : nearMin5;
  float bgTh = mix(0.15, 0.25, smoothstep(0.22, 0.42, nearCheck));
  bool isMasked = (dMaxFg - centerD > fgTh) || (centerD - nearCheck > bgTh);
  float minBgD = clamp(nearCheck + 0.16, 0.0, max(dMaxFg - 0.02, 0.0));
  float reqMinD = isMasked ? minBgD : min(centerD + 0.32, 1.49);
  float seedCode = isMasked ? 0.0 : (floor(gl_FragCoord.x) + 1.0);
  gl_FragColor = vec4(isMasked ? 0.0 : 1.0, packU16(seedCode), clamp(reqMinD / 1.5, 0.0, 1.0));
}
`

const FRAG_GL_BG_FLOOD = GL_PACK_COMMON + `
uniform sampler2D u_bgSrc;
uniform sampler2D u_inMeta;
uniform vec4 u_dims;
uniform float u_stride;
void main() {
  vec2 uv = v_uv;
  float w = u_dims.x;
  float cx = floor(gl_FragCoord.x);
  vec4 curMeta = texture2D(u_inMeta, uv);
  float reqMinD = curMeta.a * 1.5;
  bool bestValid = curMeta.r > 0.5;
  float bestSeedX = bestValid ? (unpackU16(curMeta.gb) - 1.0) : -1.0;
  float bestDist = (bestValid && bestSeedX >= 0.0) ? abs(cx - bestSeedX) : 1e9;
  for (int sgn = -1; sgn <= 1; sgn += 2) {
    float sx = clamp(cx + float(sgn) * u_stride, 0.0, w - 1.0);
    vec4 sm = texture2D(u_inMeta, vec2((sx + 0.5) / w, uv.y));
    if (sm.r < 0.5) continue;
    float candSeedX = unpackU16(sm.gb) - 1.0;
    if (candSeedX < 0.0) continue;
    float candD = texture2D(u_bgSrc, vec2((candSeedX + 0.5) / w, uv.y)).a;
    if (candD < reqMinD - 0.008) continue;
    float candDist = abs(cx - candSeedX);
    if (!bestValid || candDist < bestDist) {
      bestValid = true;
      bestSeedX = candSeedX;
      bestDist = candDist;
    }
  }
  gl_FragColor = vec4(bestValid ? 1.0 : 0.0, packU16(bestValid ? (bestSeedX + 1.0) : 0.0), curMeta.a);
}
`

const FRAG_GL_BG_RESOLVE = GL_PACK_COMMON + `
uniform sampler2D u_bgSrc;
uniform sampler2D u_inMeta;
uniform vec4 u_dims;
void main() {
  vec2 uv = v_uv;
  float w = u_dims.x;
  float h = u_dims.y;
  float cx = floor(gl_FragCoord.x);
  vec4 curMeta = texture2D(u_inMeta, uv);
  float reqMinD = curMeta.a * 1.5;
  bool valid = curMeta.r > 0.5;
  float seedX = valid ? (unpackU16(curMeta.gb) - 1.0) : -1.0;
  if (!valid || seedX < 0.0) {
    vec3 sumCol = vec3(0.0);
    float sumD = 0.0;
    float sumW = 0.0;
    for (int oy = -16; oy <= 16; oy++) {
      if (oy == 0) continue;
      float sy = clamp(uv.y + (float(oy) * 3.0) / h, 0.0, 1.0);
      vec4 sm = texture2D(u_inMeta, vec2(uv.x, sy));
      if (sm.r > 0.5) {
        float sSeed = unpackU16(sm.gb) - 1.0;
        if (sSeed >= 0.0) {
          vec4 sb = texture2D(u_bgSrc, vec2((sSeed + 0.5) / w, sy));
          if (sb.a >= reqMinD - 0.008) {
            float wt = exp(-abs(float(oy)) * 0.25);
            sumCol += srgbToLin(sb.rgb) * wt;
            sumD += sb.a * wt;
            sumW += wt;
          }
        }
      }
    }
    if (sumW > 0.0001) {
      gl_FragColor = vec4(linToSrgb(sumCol / sumW), sumD / sumW);
      return;
    }
    gl_FragColor = texture2D(u_bgSrc, uv);
    return;
  }
  vec4 bestBg = texture2D(u_bgSrc, vec2((seedX + 0.5) / w, uv.y));
  if (abs(cx - seedX) > 0.5) {
    vec3 bestLin = srgbToLin(bestBg.rgb);
    vec3 sCol = bestLin * 1.4;
    float sW = 1.4;
    for (int oy = -4; oy <= 4; oy++) {
      if (oy == 0) continue;
      float sy = clamp(uv.y + float(oy) / h, 0.0, 1.0);
      vec4 sm = texture2D(u_inMeta, vec2(uv.x, sy));
      if (sm.r > 0.5) {
        float sSeed = unpackU16(sm.gb) - 1.0;
        if (sSeed >= 0.0 && abs(cx - sSeed) > 0.5) {
          vec4 sb = texture2D(u_bgSrc, vec2((sSeed + 0.5) / w, sy));
          if (abs(sb.a - bestBg.a) < 0.04) {
            vec3 sLin = srgbToLin(sb.rgb);
            vec3 dCol = sLin - bestLin;
            float wCol = exp(-dot(dCol, dCol) * 64.0);
            if (wCol > 0.08) {
              float wt = wCol * exp(-abs(float(oy)) * 0.42);
              sCol += sLin * wt;
              sW += wt;
            }
          }
        }
      }
    }
    if (sW > 1.401) {
      gl_FragColor = vec4(linToSrgb(sCol / sW), bestBg.a);
      return;
    }
  }
  gl_FragColor = bestBg;
}
`

const FRAG_GL_PARALLAX_RAY = GL_PACK_COMMON + `
uniform sampler2D u_source;
uniform sampler2D u_crisp;
uniform sampler2D u_bgInpaint;
uniform vec4 u_dims;
uniform vec4 u_parallax_a;
float sampleCrispBilinear(vec2 uv) {
  vec2 dims = max(u_dims.xy, vec2(1.0));
  vec2 texel = 1.0 / dims;
  vec2 c = clamp(uv, 0.0, 0.99999) * dims - 0.5;
  vec2 f = fract(max(c, vec2(0.0)));
  vec2 base = (floor(max(c, vec2(0.0))) + 0.5) * texel;
  float d00 = unpackD16(texture2D(u_crisp, base));
  float d10 = unpackD16(texture2D(u_crisp, base + vec2(texel.x, 0.0)));
  float d01 = unpackD16(texture2D(u_crisp, base + vec2(0.0, texel.y)));
  float d11 = unpackD16(texture2D(u_crisp, base + texel));
  if (max(max(d00, d10), max(d01, d11)) - min(min(d00, d10), min(d01, d11)) > 0.14) {
    return unpackD16(texture2D(u_crisp, clamp(uv, 0.0, 1.0)));
  }
  return mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y);
}
vec3 sampleSourceSafeGL(vec2 uv, float refD, vec2 texel) {
  vec2 dims = max(u_dims.xy, vec2(1.0));
  vec2 c = clamp(uv * dims - 0.5, vec2(0.0), max(dims - 1.0, vec2(0.0)));
  vec2 f = fract(c);
  vec2 base = (floor(c) + 0.5) * texel;
  vec2 uv00 = clamp(base, 0.0, 1.0);
  vec2 uv10 = clamp(base + vec2(texel.x, 0.0), 0.0, 1.0);
  vec2 uv01 = clamp(base + vec2(0.0, texel.y), 0.0, 1.0);
  vec2 uv11 = clamp(base + texel, 0.0, 1.0);
  float d00 = unpackD16(texture2D(u_crisp, uv00));
  float d10 = unpackD16(texture2D(u_crisp, uv10));
  float d01 = unpackD16(texture2D(u_crisp, uv01));
  float d11 = unpackD16(texture2D(u_crisp, uv11));
  float snap = texture2D(u_crisp, clamp(uv, 0.0, 1.0)).b;
  if (max(max(d00, d10), max(d01, d11)) - min(min(d00, d10), min(d01, d11)) > 0.14 || snap > 0.25) {
    vec3 pSum = vec3(0.0);
    float pWSum = 0.0;
    for (int oy = -2; oy <= 2; oy++) {
      for (int ox = -2; ox <= 2; ox++) {
        vec2 sUv = clamp(uv + vec2(float(ox), float(oy)) * texel, 0.0, 1.0);
        float sd = unpackD16(texture2D(u_crisp, sUv));
        if (abs(sd - refD) > 0.08) continue;
        float nD1 = unpackD16(texture2D(u_crisp, clamp(sUv + vec2(texel.x, 0.0), 0.0, 1.0)));
        float nD2 = unpackD16(texture2D(u_crisp, clamp(sUv - vec2(texel.x, 0.0), 0.0, 1.0)));
        float nD3 = unpackD16(texture2D(u_crisp, clamp(sUv + vec2(0.0, texel.y), 0.0, 1.0)));
        float nD4 = unpackD16(texture2D(u_crisp, clamp(sUv - vec2(0.0, texel.y), 0.0, 1.0)));
        float nD5 = unpackD16(texture2D(u_crisp, clamp(sUv + vec2(2.0 * texel.x, 0.0), 0.0, 1.0)));
        float nD6 = unpackD16(texture2D(u_crisp, clamp(sUv - vec2(2.0 * texel.x, 0.0), 0.0, 1.0)));
        float nD7 = unpackD16(texture2D(u_crisp, clamp(sUv + vec2(0.0, 2.0 * texel.y), 0.0, 1.0)));
        float nD8 = unpackD16(texture2D(u_crisp, clamp(sUv - vec2(0.0, 2.0 * texel.y), 0.0, 1.0)));
        float mNB = max(
          max(max(abs(nD1 - sd), abs(nD2 - sd)), max(abs(nD3 - sd), abs(nD4 - sd))),
          max(max(abs(nD5 - sd), abs(nD6 - sd)), max(abs(nD7 - sd), abs(nD8 - sd)))
        );
        float pureW = mNB < 0.08 ? 6.0 : 0.10;
        float wt = pureW * exp(-float(ox * ox + oy * oy) * 0.34);
        pSum += srgbToLin(texture2D(u_source, sUv).rgb) * wt;
        pWSum += wt;
      }
    }
    if (pWSum > 0.001) return pSum / pWSum;
  }
  float w00 = (1.0 - f.x) * (1.0 - f.y) * exp(-abs(d00 - refD) * 48.0);
  float w10 = f.x * (1.0 - f.y) * exp(-abs(d10 - refD) * 48.0);
  float w01 = (1.0 - f.x) * f.y * exp(-abs(d01 - refD) * 48.0);
  float w11 = f.x * f.y * exp(-abs(d11 - refD) * 48.0);
  float wSum = w00 + w10 + w01 + w11;
  if (wSum > 0.001) {
    vec3 c00 = srgbToLin(texture2D(u_source, uv00).rgb);
    vec3 c10 = srgbToLin(texture2D(u_source, uv10).rgb);
    vec3 c01 = srgbToLin(texture2D(u_source, uv01).rgb);
    vec3 c11 = srgbToLin(texture2D(u_source, uv11).rgb);
    return (c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11) / wSum;
  }
  return srgbToLin(texture2D(u_source, uv).rgb);
}
vec4 traceRayGL(vec2 rayUv, vec2 shiftUv, float stepsF, float dz, float tol, vec2 texel) {
  vec2 prevUv = clamp(rayUv - shiftUv, 0.0, 1.0);
  float prevD = sampleCrispBilinear(prevUv);
  float prevZ = 0.0;
  bool hitValid = false;
  vec2 hitUv = prevUv;
  float hitD = prevD;
  if (prevD <= 0.005) {
    hitValid = true;
  } else {
  for (int i = 1; i <= 192; i++) {
    if (float(i) > stepsF) break;
    float z = float(i) * dz;
    vec2 pUv = clamp(rayUv + shiftUv * ((z - 0.5) * 2.0), 0.0, 1.0);
    float d = sampleCrispBilinear(pUv);
    if (z >= d - 0.002) {
      if ((z - d) > tol && (prevD - d) > 0.08) {
        hitValid = false;
        break;
      }
      if (abs(prevD - d) > 0.10) {
        hitUv = pUv;
        hitD = d;
      } else {
        float denom = (prevD - d) + (z - prevZ);
        float frac = clamp((prevD - prevZ) / max(denom, 1e-4), 0.0, 1.0);
        hitUv = mix(prevUv, pUv, frac);
        hitD = mix(prevD, d, frac);
      }
      hitValid = true;
      break;
    }
    prevZ = z;
    prevD = d;
    prevUv = pUv;
  }
  }
  if (hitValid) {
    float snapFlag = texture2D(u_crisp, clamp(hitUv, 0.0, 1.0)).b;
    return vec4(sampleSourceSafeGL(hitUv, hitD, texel), snapFlag);
  }
  vec2 prevBgUv = clamp(rayUv - shiftUv, 0.0, 1.0);
  vec4 prevBgS = texture2D(u_bgInpaint, prevBgUv);
  float prevBgZ = 0.0;
  vec2 dims = max(u_dims.xy, vec2(1.0));
  for (int j = 1; j <= 192; j++) {
    if (float(j) > stepsF) break;
    float z = float(j) * dz;
    vec2 bUv = clamp(rayUv + shiftUv * ((z - 0.5) * 2.0), 0.0, 1.0);
    vec4 bS = texture2D(u_bgInpaint, bUv);
    float bd = bS.a;
    if (z >= bd - 0.002) {
      if ((z - bd) > tol && (prevBgS.a - bd) > 0.08) {
        return vec4(srgbToLin(prevBgS.rgb), 1.0);
      }
      if (abs(prevBgS.a - bd) <= 0.03) {
        float denom = (prevBgS.a - bd) + (z - prevBgZ);
        float frac = clamp((prevBgS.a - prevBgZ) / max(denom, 1e-4), 0.0, 1.0);
        vec2 finalBgUv = mix(prevBgUv, bUv, frac);
        vec2 bc = clamp(finalBgUv * dims - 0.5, vec2(0.0), max(dims - 1.0, vec2(0.0)));
        vec2 bf = fract(bc);
        vec2 bbase = (floor(bc) + 0.5) * texel;
        vec4 s00 = texture2D(u_bgInpaint, clamp(bbase, 0.0, 1.0));
        vec4 s10 = texture2D(u_bgInpaint, clamp(bbase + vec2(texel.x, 0.0), 0.0, 1.0));
        vec4 s01 = texture2D(u_bgInpaint, clamp(bbase + vec2(0.0, texel.y), 0.0, 1.0));
        vec4 s11 = texture2D(u_bgInpaint, clamp(bbase + texel, 0.0, 1.0));
        if (max(max(s00.a, s10.a), max(s01.a, s11.a)) - min(min(s00.a, s10.a), min(s01.a, s11.a)) > 0.12) {
          return vec4(srgbToLin(texture2D(u_bgInpaint, clamp(finalBgUv, 0.0, 1.0)).rgb), 1.0);
        }
        vec3 bLin = mix(mix(srgbToLin(s00.rgb), srgbToLin(s10.rgb), bf.x), mix(srgbToLin(s01.rgb), srgbToLin(s11.rgb), bf.x), bf.y);
        return vec4(bLin, 0.0);
      }
      return vec4(srgbToLin(bS.rgb), 1.0);
    }
    prevBgZ = z;
    prevBgS = bS;
    prevBgUv = bUv;
  }
  return vec4(srgbToLin(prevBgS.rgb), 1.0);
}
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 texel = 1.0 / max(u_dims.xy, vec2(1.0));
  vec4 src = texture2D(u_source, uv);
  float shiftMag = u_parallax_a.z;
  if (shiftMag < 0.05) {
    gl_FragColor = src;
    return;
  }
  vec2 shiftUv = u_parallax_a.xy * texel;
  float maxDispPx = max(shiftMag * 2.0, 0.0);
  float stepsF = clamp(ceil(max(maxDispPx * 2.3, 56.0)), 56.0, 192.0);
  float dz = 1.0 / stepsF;
  float tol = max(dz * 1.45, 0.022);
  vec4 r0 = traceRayGL(uv, shiftUv, stepsF, dz, tol, texel);
  vec3 linCol = r0.rgb;
  if (r0.a > 0.25) {
    vec3 r1 = traceRayGL(uv + vec2(0.375, 0.125) * texel, shiftUv, stepsF, dz, tol, texel).rgb;
    vec3 r2 = traceRayGL(uv + vec2(-0.125, 0.375) * texel, shiftUv, stepsF, dz, tol, texel).rgb;
    vec3 r3 = traceRayGL(uv + vec2(-0.375, -0.125) * texel, shiftUv, stepsF, dz, tol, texel).rgb;
    vec3 r4 = traceRayGL(uv + vec2(0.125, -0.375) * texel, shiftUv, stepsF, dz, tol, texel).rgb;
    linCol = mix(linCol, (r1 + r2 + r3 + r4) * 0.25, smoothstep(0.25, 0.65, r0.a));
  }
  gl_FragColor = vec4(linToSrgb(linCol), src.a);
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

function makeProgram(gl, fragSource = FRAGMENT) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragSource)
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

function packDepth16Rgba(depth) {
  const count = depth.width * depth.height
  const out = new Uint8Array(count * 4)
  for (let i = 0; i < count; i += 1) {
    const clamped = Math.max(0, Math.min(1, Number(depth.data[i]) || 0))
    const q = Math.round(clamped * 65535)
    const idx = i * 4
    out[idx] = (q >> 8) & 255
    out[idx + 1] = q & 255
    out[idx + 2] = 0
    out[idx + 3] = 255
  }
  return out
}

function uploadRgba(gl, texture, data, width, height, nearest = false) {
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  const raw = data instanceof Uint8Array
    ? data
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, raw)
}

function createFboTarget(gl, width, height) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fbo = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fbo }
}

function ensureParallaxPipeline(state, width, height) {
  const { gl } = state
  if (!state.parallaxProgs) {
    const refine = makeProgram(gl, FRAG_GL_REFINE)
    const crisp = makeProgram(gl, FRAG_GL_CRISP)
    const bgInit = makeProgram(gl, FRAG_GL_BG_INIT)
    const bgFlood = makeProgram(gl, FRAG_GL_BG_FLOOD)
    const bgResolve = makeProgram(gl, FRAG_GL_BG_RESOLVE)
    const ray = makeProgram(gl, FRAG_GL_PARALLAX_RAY)
    if (!refine || !crisp || !bgInit || !bgFlood || !bgResolve || !ray) return null
    state.parallaxProgs = { refine, crisp, bgInit, bgFlood, bgResolve, ray }
  }
  if (!state.parallaxFbos || state.parallaxFboW !== width || state.parallaxFboH !== height) {
    if (state.parallaxFbos) {
      Object.values(state.parallaxFbos).forEach((t) => {
        if (t?.tex) gl.deleteTexture(t.tex)
        if (t?.fbo) gl.deleteFramebuffer(t.fbo)
      })
    }
    state.parallaxFbos = {
      refined: createFboTarget(gl, width, height),
      crispA: createFboTarget(gl, width, height),
      crispB: createFboTarget(gl, width, height),
      bgSrc: createFboTarget(gl, width, height),
      bgOut: createFboTarget(gl, width, height),
      metaA: createFboTarget(gl, width, height),
      metaB: createFboTarget(gl, width, height),
    }
    state.parallaxFboW = width
    state.parallaxFboH = height
    state.parallaxSig = ''
  }
  return state.parallaxProgs
}

function drawQuadPass(gl, prog, buffer, fbo, width, height, bindTextures, setUniforms) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo || null)
  gl.useProgram(prog)
  gl.viewport(0, 0, width, height)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.BLEND)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  const pos = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(pos)
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0)
  bindTextures.forEach(([name, tex], unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.uniform1i(gl.getUniformLocation(prog, name), unit)
  })
  setUniforms()
  gl.drawArrays(gl.TRIANGLES, 0, 6)
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
    if (!gl || typeof gl.createShader !== 'function') return null
    const program = makeProgram(gl)
    if (!program) return null
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    )
    surface = {
      canvas,
      gl,
      program,
      buffer,
      textures: [gl.createTexture(), gl.createTexture(), gl.createTexture()],
      uniforms: null,
      parallaxProgs: null,
      parallaxFbos: null,
      parallaxFboW: 0,
      parallaxFboH: 0,
      parallaxSig: '',
      width: 0,
      height: 0,
      sourceSig: '',
      depthSig: '',
      normalSig: '',
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
    surface.sourceSig = ''
    surface.normalSig = ''
    surface.parallaxSig = ''
  }
  return surface
}

/**
 * 用 WebGL 渲染一帧空间滤镜。
 *
 * @returns {{canvas:HTMLCanvasElement,pixels:{width:number,height:number,data:Uint8ClampedArray}|null}|null}
 */
export function renderDepthFxWebGL(image, depth, options = {}) {
  if (typeof document === 'undefined' || !document.createElement || !image?.data || !depth?.data) {
    return null
  }
  const width = Number(image.width)
  const height = Number(image.height)
  const rawDepthW = Number(depth.width)
  const rawDepthH = Number(depth.height)
  if (!width || !height || !rawDepthW || !rawDepthH) return null

  const modeStr = options.mode === 'atmosphere' || options.mode === 'dof' || options.mode === 'parallax'
    ? options.mode
    : 'fog'
  const modeIndex = modeStr === 'atmosphere' ? 1 : modeStr === 'dof' ? 2 : modeStr === 'parallax' ? 3 : 0

  try {
    const state = getSurface(width, height)
    if (!state) return null
    const { canvas, gl, program, buffer, textures } = state
    const sourceSig = `${width}x${height}:${renderBufferKey(image.data, image.revision)}`
    const depthSig = `${rawDepthW}x${rawDepthH}:${renderBufferKey(depth.data, depth.revision)}`
    if (state.sourceSig !== sourceSig) {
      uploadRgba(gl, textures[0], image.data, width, height, false)
      state.sourceSig = sourceSig
    }
    if (state.depthSig !== depthSig) {
      uploadRgba(gl, textures[1], packDepth16Rgba(depth), rawDepthW, rawDepthH, true)
      state.depthSig = depthSig
    }

    let hasNormal = false
    if (modeStr === 'fog' && options.normal?.data && options.normal.width === width && options.normal.height === height) {
      hasNormal = true
      const normalSig = `${width}x${height}:${renderBufferKey(options.normal.data, options.normal.revision)}`
      if (state.normalSig !== normalSig) {
        uploadRgba(gl, textures[2], options.normal.data, width, height, false)
        state.normalSig = normalSig
      }
    } else if (state.normalSig !== 'neutral-1x1') {
      uploadRgba(gl, textures[2], new Uint8Array([128, 128, 255, 255]), 1, 1, false)
      state.normalSig = 'neutral-1x1'
    }

    const scale = Math.max(1, Math.max(width, height) / 384)
    const amp = Math.max(0, Number(options.amplitude ?? 18)) * scale
    const vx = amp * (Number(options.shiftX) || 0)
    const vy = amp * (Number(options.shiftY) || 0)
    const shiftMag = Math.hypot(vx, vy)

    if (modeStr === 'parallax') {
      const progs = ensureParallaxPipeline(state, width, height)
      if (!progs) return null
      const fbos = state.parallaxFbos
      const pairSig = `${sourceSig}|${depthSig}`
      if (state.parallaxSig !== pairSig) {
        drawQuadPass(gl, progs.refine, buffer, fbos.refined.fbo, width, height, [
          ['u_rawDepth', textures[1]],
          ['u_source', textures[0]],
        ], () => {
          gl.uniform4f(gl.getUniformLocation(progs.refine, 'u_dims'), width, height, rawDepthW, rawDepthH)
        })
        drawQuadPass(gl, progs.crisp, buffer, fbos.crispA.fbo, width, height, [
          ['u_source', textures[0]],
          ['u_depthTex', fbos.refined.tex],
        ], () => {
          gl.uniform4f(gl.getUniformLocation(progs.crisp, 'u_dims'), width, height, rawDepthW, rawDepthH)
        })
        drawQuadPass(gl, progs.crisp, buffer, fbos.crispB.fbo, width, height, [
          ['u_source', textures[0]],
          ['u_depthTex', fbos.crispA.tex],
        ], () => {
          gl.uniform4f(gl.getUniformLocation(progs.crisp, 'u_dims'), width, height, rawDepthW, rawDepthH)
        })
        drawQuadPass(gl, progs.bgInit, buffer, fbos.bgSrc.fbo, width, height, [
          ['u_source', textures[0]],
          ['u_crisp', fbos.crispB.tex],
        ], () => {
          gl.uniform4f(gl.getUniformLocation(progs.bgInit, 'u_dims'), width, height, rawDepthW, rawDepthH)
          gl.uniform1f(gl.getUniformLocation(progs.bgInit, 'u_outMode'), 0.0)
        })
        drawQuadPass(gl, progs.bgInit, buffer, fbos.metaA.fbo, width, height, [
          ['u_source', textures[0]],
          ['u_crisp', fbos.crispB.tex],
        ], () => {
          gl.uniform4f(gl.getUniformLocation(progs.bgInit, 'u_dims'), width, height, rawDepthW, rawDepthH)
          gl.uniform1f(gl.getUniformLocation(progs.bgInit, 'u_outMode'), 1.0)
        })
        const strides = [128, 64, 32, 16, 8, 4, 2, 1]
        for (let pass = 0; pass < strides.length; pass += 1) {
          const inMeta = pass % 2 === 0 ? fbos.metaA.tex : fbos.metaB.tex
          const outFbo = pass % 2 === 0 ? fbos.metaB.fbo : fbos.metaA.fbo
          drawQuadPass(gl, progs.bgFlood, buffer, outFbo, width, height, [
            ['u_bgSrc', fbos.bgSrc.tex],
            ['u_inMeta', inMeta],
          ], () => {
            gl.uniform4f(gl.getUniformLocation(progs.bgFlood, 'u_dims'), width, height, rawDepthW, rawDepthH)
            gl.uniform1f(gl.getUniformLocation(progs.bgFlood, 'u_stride'), strides[pass])
          })
        }
        drawQuadPass(gl, progs.bgResolve, buffer, fbos.bgOut.fbo, width, height, [
          ['u_bgSrc', fbos.bgSrc.tex],
          ['u_inMeta', fbos.metaA.tex],
        ], () => {
          gl.uniform4f(gl.getUniformLocation(progs.bgResolve, 'u_dims'), width, height, rawDepthW, rawDepthH)
        })
        state.parallaxSig = pairSig
      }
      drawQuadPass(gl, progs.ray, buffer, null, width, height, [
        ['u_source', textures[0]],
        ['u_crisp', fbos.crispB.tex],
        ['u_bgInpaint', fbos.bgOut.tex],
      ], () => {
        gl.uniform4f(gl.getUniformLocation(progs.ray, 'u_dims'), width, height, rawDepthW, rawDepthH)
        gl.uniform4f(gl.getUniformLocation(progs.ray, 'u_parallax_a'), vx, vy, shiftMag, 0)
      })
      gl.finish()
      if (!options.readPixels) return { canvas, pixels: null }
      const raw = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw)
      const out = new Uint8ClampedArray(width * height * 4)
      const rowBytes = width * 4
      for (let y = 0; y < height; y += 1) {
        const srcRow = (height - 1 - y) * rowBytes
        out.set(raw.subarray(srcRow, srcRow + rowBytes), y * rowBytes)
      }
      return { canvas, pixels: { width, height, data: out } }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(program)
    gl.viewport(0, 0, width, height)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const position = gl.getAttribLocation(program, 'a_pos')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const uniforms = state.uniforms || {
      source: gl.getUniformLocation(program, 'u_source'),
      depth16: gl.getUniformLocation(program, 'u_depth16'),
      normal: gl.getUniformLocation(program, 'u_normal'),
      dims: gl.getUniformLocation(program, 'u_dims'),
      modeArgs: gl.getUniformLocation(program, 'u_mode_args'),
      colorA: gl.getUniformLocation(program, 'u_color_a'),
      fogA: gl.getUniformLocation(program, 'u_fog_a'),
      fogB: gl.getUniformLocation(program, 'u_fog_b'),
      atmosA: gl.getUniformLocation(program, 'u_atmos_a'),
      dofA: gl.getUniformLocation(program, 'u_dof_a'),
      parallaxA: gl.getUniformLocation(program, 'u_parallax_a'),
      ptGeom: gl.getUniformLocation(program, 'u_pt_geom[0]'),
      ptCtrl: gl.getUniformLocation(program, 'u_pt_ctrl[0]'),
    }
    state.uniforms = uniforms

    textures.forEach((tex, idx) => {
      gl.activeTexture(gl.TEXTURE0 + idx)
      gl.bindTexture(gl.TEXTURE_2D, tex)
    })
    gl.uniform1i(uniforms.source, 0)
    gl.uniform1i(uniforms.depth16, 1)
    gl.uniform1i(uniforms.normal, 2)

    const points = []
    if (modeStr === 'fog') {
      if (Array.isArray(options.anchors)) points.push(...options.anchors)
      if (Array.isArray(options.strokes)) points.push(...options.strokes)
    }
    const ptCount = Math.min(MAX_GL_POINTS, points.length)
    const geomArr = new Float32Array(MAX_GL_POINTS * 4)
    const ctrlArr = new Float32Array(MAX_GL_POINTS * 4)
    for (let i = 0; i < ptCount; i += 1) {
      const pt = points[i]
      if (!pt || !Number.isFinite(Number(pt.x)) || !Number.isFinite(Number(pt.y))) continue
      geomArr[i * 4] = Number(pt.x)
      geomArr[i * 4 + 1] = Number(pt.y)
      geomArr[i * 4 + 2] = Math.max(0.01, Number(pt.radius) || 0.18)
      geomArr[i * 4 + 3] = Math.max(0.03, Number(pt.feather) || 0.65)
      ctrlArr[i * 4] = Math.max(0, Number(pt.strength) || 0.8)
      ctrlArr[i * 4 + 1] = pt.mode === 'subtract' ? -1 : 1
    }
    gl.uniform4fv(uniforms.ptGeom, geomArr)
    gl.uniform4fv(uniforms.ptCtrl, ctrlArr)

    const colorRgb = colorTuple(
      modeStr === 'atmosphere'
        ? (options.color || '#BFD5DC')
        : (options.color || options.fog?.color || '#EDE9DF'),
    )
    const blurMaxRadius = Math.max(0, Number(options.blur ?? 7)) * scale

    gl.uniform4f(uniforms.dims, width, height, rawDepthW, rawDepthH)
    gl.uniform4f(uniforms.modeArgs, modeIndex, ptCount, scale, options.tiltShift === true ? 1 : 0)
    gl.uniform4f(uniforms.colorA, colorRgb[0], colorRgb[1], colorRgb[2], options.blend === 'screen' ? 1 : 0)
    gl.uniform4f(
      uniforms.fogA,
      Number(options.density ?? 0.45),
      Number(options.startDepth ?? (modeStr === 'atmosphere' ? 0.12 : 0.25)),
      Math.max(0.05, Number(options.falloff) || 1.4),
      Number(options.groundBias ?? 0.45),
    )
    gl.uniform4f(
      uniforms.fogB,
      Math.max(0.05, Math.min(0.98, Number(options.horizon) || 0.6)),
      hasNormal ? 1 : 0,
      Number(options.haze ?? 0.28),
      Number(options.desaturate ?? 0.35),
    )
    gl.uniform4f(uniforms.atmosA, Number(options.contrast ?? 0.88), 0, 0, 0)
    gl.uniform4f(
      uniforms.dofA,
      Math.max(0, Math.min(1, Number(options.focusX ?? 0.5))),
      Math.max(0, Math.min(1, Number(options.focusY ?? 0.5))),
      Number(options.aperture ?? 0.18),
      blurMaxRadius,
    )
    gl.uniform4f(uniforms.parallaxA, vx, vy, shiftMag, 0)

    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.finish()

    if (!options.readPixels) {
      return { canvas, pixels: null }
    }

    const raw = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    const out = new Uint8ClampedArray(width * height * 4)
    const rowBytes = width * 4
    for (let y = 0; y < height; y += 1) {
      const srcRow = (height - 1 - y) * rowBytes
      out.set(raw.subarray(srcRow, srcRow + rowBytes), y * rowBytes)
    }
    return { canvas, pixels: { width, height, data: out } }
  } catch {
    return null
  }
}
