/**
 * 工坊空间滤镜（depth-fx）的 SOTA WebGPU 计算着色器实时管线。
 *
 * 相比原 CPU 512px/320px 降采样路径，本管线实现：
 *  1. 全分辨率 / 舞台原生分辨率实时计算 + 源/深度纹理 GPU 常驻缓存，调参与呼吸动画零重传；
 *  2. Joint Bilateral Depth Upsampling（以原图高分 RGB 引导 `r32float` 深度吸附物体边缘）；
 *  3. 线性空间高度指数雾 & 大气透视（对比度仅调制远景，前景 100% 保持原图锐度）；
 *  4. Near/Far 分离三 Pass 物理散景 DoF（Vogel Disk + IGN 抖动 + 5×5 双边抛光 + 防前景渗色光晕）；
 *  5. LDI 思路遮挡背景外扩补洞 + 连续反向视差光线步进（双线性滤波，消除针孔与“梳子齿”撕裂）。
 *
 * 无 WebGPU 或着色器不可用时返回 `null`，调用方无缝回退 `depthFxWebGL.js` / `depthFx.js`。
 */

import { normalPixelsFromDepth } from './depthFx.js'

const MAX_SPATIAL_POINTS = 100

const WGSL_COMMON = /* wgsl */ `
struct SpatialPoint {
  geom: vec4<f32>,  // x, y, radius, feather
  ctrl: vec4<f32>,  // strength, modeSign (+1 add / -1 subtract), 0, 0
};

struct Params {
  dims: vec4<f32>,      // width, height, rawDepthW, rawDepthH
  modeArgs: vec4<f32>,  // mode (0 fog, 1 atmos, 2 dof, 3 parallax), pointCount, scale, tiltShift
  colorA: vec4<f32>,    // rgb (fog/air color sRGB 0..1), blendScreen (0/1)
  fogA: vec4<f32>,      // density, startDepth, falloff, groundBias
  fogB: vec4<f32>,      // horizon, hasNormal, haze, desaturate
  atmosA: vec4<f32>,    // contrast, 0, 0, 0
  dofA: vec4<f32>,      // focusX, focusY, aperture, blurMaxRadius
  parallaxA: vec4<f32>, // vxPx, vyPx, shiftMagPx, 0
};

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  return pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
}

fn luminance(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn ign(pixel: vec2<f32>) -> f32 {
  let magic = vec3<f32>(0.06711056, 0.00583715, 52.9829189);
  return fract(magic.z * fract(dot(pixel, magic.xy)));
}

fn sampleRawDepthBilinear(uRawDepth: texture_2d<f32>, uv: vec2<f32>, rawDims: vec2<f32>) -> f32 {
  let maxCoord = vec2<i32>(max(i32(rawDims.x) - 1, 0), max(i32(rawDims.y) - 1, 0));
  let c = clamp(uv * rawDims - 0.5, vec2<f32>(0.0), vec2<f32>(maxCoord));
  let i0 = vec2<i32>(floor(c));
  let f = fract(c);
  let d00 = textureLoad(uRawDepth, clamp(i0, vec2<i32>(0), maxCoord), 0).r;
  let d10 = textureLoad(uRawDepth, clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), maxCoord), 0).r;
  let d01 = textureLoad(uRawDepth, clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), maxCoord), 0).r;
  let d11 = textureLoad(uRawDepth, clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), maxCoord), 0).r;
  return clamp(mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y), 0.0, 1.0);
}

fn loadRefinedDepth(uDepth: texture_2d<f32>, uv: vec2<f32>, dims: vec2<f32>) -> f32 {
  let maxCoord = vec2<i32>(max(i32(dims.x) - 1, 0), max(i32(dims.y) - 1, 0));
  let c = clamp(uv * dims - 0.5, vec2<f32>(0.0), vec2<f32>(maxCoord));
  let i0 = vec2<i32>(floor(c));
  let f = fract(c);
  let d00 = textureLoad(uDepth, clamp(i0, vec2<i32>(0), maxCoord), 0).r;
  let d10 = textureLoad(uDepth, clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), maxCoord), 0).r;
  let d01 = textureLoad(uDepth, clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), maxCoord), 0).r;
  let d11 = textureLoad(uDepth, clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), maxCoord), 0).r;
  return clamp(mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y), 0.0, 1.0);
}

fn sampleCrispDepthSafe(uCrisp: texture_2d<f32>, uv: vec2<f32>, dims: vec2<f32>) -> f32 {
  let maxCoord = vec2<i32>(max(i32(dims.x) - 1, 0), max(i32(dims.y) - 1, 0));
  let c = clamp(uv * dims - 0.5, vec2<f32>(0.0), vec2<f32>(maxCoord));
  let i0 = vec2<i32>(floor(c));
  let f = fract(c);
  let d00 = textureLoad(uCrisp, clamp(i0, vec2<i32>(0), maxCoord), 0).r;
  let d10 = textureLoad(uCrisp, clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), maxCoord), 0).r;
  let d01 = textureLoad(uCrisp, clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), maxCoord), 0).r;
  let d11 = textureLoad(uCrisp, clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), maxCoord), 0).r;
  let dMin = min(min(d00, d10), min(d01, d11));
  let dMax = max(max(d00, d10), max(d01, d11));
  if (dMax - dMin > 0.12) {
    let iNear = clamp(vec2<i32>(round(c)), vec2<i32>(0), maxCoord);
    return textureLoad(uCrisp, iNear, 0).r;
  }
  return clamp(mix(mix(d00, d10, f.x), mix(d01, d11, f.x), f.y), 0.0, 1.0);
}

fn sampleSourceCrispSafe(
  uSource: texture_2d<f32>,
  uCrisp: texture_2d<f32>,
  uv: vec2<f32>,
  refD: f32,
  dims: vec2<f32>
) -> vec3<f32> {
  let maxCoord = vec2<i32>(max(i32(dims.x) - 1, 0), max(i32(dims.y) - 1, 0));
  let c = clamp(uv * dims - 0.5, vec2<f32>(0.0), vec2<f32>(maxCoord));
  let i0 = vec2<i32>(floor(c));
  let f = fract(c);

  let c00 = clamp(i0, vec2<i32>(0), maxCoord);
  let c10 = clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), maxCoord);
  let c01 = clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), maxCoord);
  let c11 = clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), maxCoord);

  let d00 = textureLoad(uCrisp, c00, 0).r;
  let d10 = textureLoad(uCrisp, c10, 0).r;
  let d01 = textureLoad(uCrisp, c01, 0).r;
  let d11 = textureLoad(uCrisp, c11, 0).r;

  let dMin4 = min(min(d00, d10), min(d01, d11));
  let dMax4 = max(max(d00, d10), max(d01, d11));
  let iBase = clamp(vec2<i32>(round(c)), vec2<i32>(0), maxCoord);
  let snapAtC = textureLoad(uCrisp, iBase, 0).g;

  if (dMax4 - dMin4 > 0.14 || snapAtC > 0.25) {
    // 断崖 ±2px 内常混有对侧抗锯齿底色（产生黑体亮边/亮天暗弧/黄肩暗齿）；
    // 仅给距离断崖 >= 2px（±2px 四邻皆同深度）的高原内侧纯净像素高权重，同时保留发丝等极细结构。
    var pSum = vec3<f32>(0.0);
    var pWSum: f32 = 0.0;
    for (var oy: i32 = -2; oy <= 2; oy = oy + 1) {
      for (var ox: i32 = -2; ox <= 2; ox = ox + 1) {
        let sc = clamp(iBase + vec2<i32>(ox, oy), vec2<i32>(0), maxCoord);
        let sd = textureLoad(uCrisp, sc, 0).r;
        if (abs(sd - refD) > 0.08) { continue; }
        let dL1 = textureLoad(uCrisp, clamp(sc + vec2<i32>(-1, 0), vec2<i32>(0), maxCoord), 0).r;
        let dR1 = textureLoad(uCrisp, clamp(sc + vec2<i32>(1, 0), vec2<i32>(0), maxCoord), 0).r;
        let dT1 = textureLoad(uCrisp, clamp(sc + vec2<i32>(0, -1), vec2<i32>(0), maxCoord), 0).r;
        let dB1 = textureLoad(uCrisp, clamp(sc + vec2<i32>(0, 1), vec2<i32>(0), maxCoord), 0).r;
        let dL2 = textureLoad(uCrisp, clamp(sc + vec2<i32>(-2, 0), vec2<i32>(0), maxCoord), 0).r;
        let dR2 = textureLoad(uCrisp, clamp(sc + vec2<i32>(2, 0), vec2<i32>(0), maxCoord), 0).r;
        let dT2 = textureLoad(uCrisp, clamp(sc + vec2<i32>(0, -2), vec2<i32>(0), maxCoord), 0).r;
        let dB2 = textureLoad(uCrisp, clamp(sc + vec2<i32>(0, 2), vec2<i32>(0), maxCoord), 0).r;
        let maxNB = max(
          max(max(abs(dL1 - sd), abs(dR1 - sd)), max(abs(dT1 - sd), abs(dB1 - sd))),
          max(max(abs(dL2 - sd), abs(dR2 - sd)), max(abs(dT2 - sd), abs(dB2 - sd)))
        );
        let pureW = select(0.10, 6.0, maxNB < 0.08);
        let distW = exp(-f32(ox * ox + oy * oy) * 0.34);
        let wt = pureW * distW;
        pSum = pSum + srgbToLinear(textureLoad(uSource, sc, 0).rgb) * wt;
        pWSum = pWSum + wt;
      }
    }
    if (pWSum > 0.001) {
      return pSum / pWSum;
    }
  }

  let wB00 = (1.0 - f.x) * (1.0 - f.y);
  let wB10 = f.x * (1.0 - f.y);
  let wB01 = (1.0 - f.x) * f.y;
  let wB11 = f.x * f.y;

  let w00 = wB00 * exp(-abs(d00 - refD) * 48.0);
  let w10 = wB10 * exp(-abs(d10 - refD) * 48.0);
  let w01 = wB01 * exp(-abs(d01 - refD) * 48.0);
  let w11 = wB11 * exp(-abs(d11 - refD) * 48.0);
  let wSum = w00 + w10 + w01 + w11;

  let col00 = srgbToLinear(textureLoad(uSource, c00, 0).rgb);
  let col10 = srgbToLinear(textureLoad(uSource, c10, 0).rgb);
  let col01 = srgbToLinear(textureLoad(uSource, c01, 0).rgb);
  let col11 = srgbToLinear(textureLoad(uSource, c11, 0).rgb);

  if (wSum > 0.001) {
    return (col00 * w00 + col10 * w10 + col01 * w01 + col11 * w11) / wSum;
  }
  let iNear = clamp(vec2<i32>(round(c)), vec2<i32>(0), maxCoord);
  return srgbToLinear(textureLoad(uSource, iNear, 0).rgb);
}
`

/**
 * Pass 0: Joint Bilateral Depth Upsampling (JBU)
 * 把低分辨率推理深度图精准吸附到原图 RGB 轮廓上，消除人物发丝/衣缘的深度半透明过渡带。
 */
const COMPUTE_REFINE_DEPTH_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uRawDepth: texture_2d<f32>;
@group(0) @binding(1) var uSource: texture_2d<f32>;
@group(0) @binding(2) var uSamp: sampler;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var outRefinedDepth: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.dims.x);
  let h = u32(params.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let pixelCoord = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let uv = pixelCoord / params.dims.xy;
  let texel = vec2<f32>(1.0) / params.dims.xy;

  let centerRgb = textureSampleLevel(uSource, uSamp, uv, 0.0).rgb;
  let centerDepth = sampleRawDepthBilinear(uRawDepth, uv, params.dims.zw);
  let upRatio = max(params.dims.x / max(params.dims.z, 1.0), params.dims.y / max(params.dims.w, 1.0));
  // 即使输入深度已预放大到原图尺寸（如落盘读回的 depth.png），仍做轻量 RGB 引导边缘吸附，
  // 把发丝/轮廓处的粗糙深度台阶精准拉回到真实前景轮廓上。
  let stepMul = clamp(max(upRatio * 0.72, 1.6), 1.6, 3.0);

  var sumD: f32 = centerDepth * 0.42;
  var sumW: f32 = 0.42;
  let invColorVar = 1.0 / (2.0 * 0.035 * 0.035);
  let invSpatialVar = 1.0 / (2.0 * 1.65 * 1.65);

  for (var oy: i32 = -2; oy <= 2; oy = oy + 1) {
    for (var ox: i32 = -2; ox <= 2; ox = ox + 1) {
      if (ox == 0 && oy == 0) { continue; }
      let sUv = clamp(uv + vec2<f32>(f32(ox), f32(oy)) * texel * stepMul, vec2<f32>(0.0), vec2<f32>(1.0));
      let sRgb = textureSampleLevel(uSource, uSamp, sUv, 0.0).rgb;
      let sDepth = sampleRawDepthBilinear(uRawDepth, sUv, params.dims.zw);
      let diffRgb = sRgb - centerRgb;
      let colorDistSq = dot(diffRgb, diffRgb);
      let spatialDistSq = f32(ox * ox + oy * oy);
      let wSample = exp(-spatialDistSq * invSpatialVar - colorDistSq * invColorVar);
      sumD = sumD + sDepth * wSample;
      sumW = sumW + wSample;
    }
  }

  let refined = clamp(sumD / max(sumW, 1e-5), 0.0, 1.0);
  textureStore(outRefinedDepth, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(refined, 0.0, 0.0, 1.0));
}
`

/**
 * Pass 0a-2: 视差专用的 RGB 引导深度去糊化（Color-Guided Shock Filter，7x7 密集采样 ±6px）。
 * 仅在真前景-背景断崖处（span > 0.12）把模糊深度斜坡与抗锯齿暗边统一吸附回前景高原或纯净背景高原，
 * 消除模糊过渡带产生的洋葱圈/幽灵轮廓；人脸、路面等平滑连续深度保持原样。
 */
const COMPUTE_CRISP_DEPTH_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uSource: texture_2d<f32>;
@group(0) @binding(1) var uRefinedDepth: texture_2d<f32>;
@group(0) @binding(2) var uSamp: sampler;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var outCrispDepth: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.dims.x);
  let h = u32(params.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let uv = (vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5)) / params.dims.xy;
  let texel = vec2<f32>(1.0) / params.dims.xy;
  let centerRgb = textureSampleLevel(uSource, uSamp, uv, 0.0).rgb;
  let centerD = loadRefinedDepth(uRefinedDepth, uv, params.dims.xy);

  var dMin: f32 = centerD;
  var dMax: f32 = centerD;
  var dLocalMin: f32 = centerD;
  var dLocalMax: f32 = centerD;
  var rgbMin: vec3<f32> = centerRgb;
  var rgbMax: vec3<f32> = centerRgb;

  for (var ly: i32 = -1; ly <= 1; ly = ly + 1) {
    for (var lx: i32 = -1; lx <= 1; lx = lx + 1) {
      if (lx == 0 && ly == 0) { continue; }
      let lUv = clamp(uv + vec2<f32>(f32(lx), f32(ly)) * texel * 1.6, vec2<f32>(0.0), vec2<f32>(1.0));
      let ld = loadRefinedDepth(uRefinedDepth, lUv, params.dims.xy);
      dLocalMin = min(dLocalMin, ld);
      dLocalMax = max(dLocalMax, ld);
    }
  }

  for (var oy: i32 = -3; oy <= 3; oy = oy + 1) {
    for (var ox: i32 = -3; ox <= 3; ox = ox + 1) {
      if (ox == 0 && oy == 0) { continue; }
      let pUv = clamp(uv + vec2<f32>(f32(ox), f32(oy)) * texel * 2.2, vec2<f32>(0.0), vec2<f32>(1.0));
      let pd = loadRefinedDepth(uRefinedDepth, pUv, params.dims.xy);
      let pRgb = textureSampleLevel(uSource, uSamp, pUv, 0.0).rgb;
      if (pd < dMin) {
        dMin = pd;
        rgbMin = pRgb;
      }
      if (pd > dMax) {
        dMax = pd;
        rgbMax = pRgb;
      }
    }
  }

  let span = dMax - dMin;
  let localSpan = dLocalMax - dLocalMin;
  let tRaw = (centerD - dMin) / max(span, 1e-4);
  // 仅允许位于真实深度过渡斜坡上的像素（localSpan > 0.03）被锐化吸附；另对深背景侧微量扩散尾（d ~ 0.94..0.968）压平至纯背景高原，消除梯度天空细弧
  var snapMix = smoothstep(0.12, 0.20, span) * smoothstep(0.03, 0.08, localSpan);
  let tailBgMix = smoothstep(0.25, 0.45, span) * smoothstep(0.84, 0.94, tRaw) * smoothstep(0.004, 0.015, localSpan);
  var crispD = centerD;
  if (snapMix > 0.001 || tailBgMix > 0.001) {
    var dMinDiff = centerRgb - rgbMin;
    var dMaxDiff = centerRgb - rgbMax;
    var eMin: f32 = dot(dMinDiff, dMinDiff);
    var eMax: f32 = dot(dMaxDiff, dMaxDiff);
    // 多材质角点防误吸（如深灰路面紧邻暗躯干与白斑马线）：取 min(dMin附近最匹配色差) vs min(dMax附近最匹配色差)
    for (var sy: i32 = -2; sy <= 2; sy = sy + 1) {
      for (var sx: i32 = -2; sx <= 2; sx = sx + 1) {
        if (sx == 0 && sy == 0) { continue; }
        let sUv = clamp(uv + vec2<f32>(f32(sx), f32(sy)) * texel * 2.5, vec2<f32>(0.0), vec2<f32>(1.0));
        let sd = loadRefinedDepth(uRefinedDepth, sUv, params.dims.xy);
        let sDiff = centerRgb - textureSampleLevel(uSource, uSamp, sUv, 0.0).rgb;
        let sErr = dot(sDiff, sDiff);
        if (sd <= dMin + 0.08) { eMin = min(eMin, sErr); }
        if (sd >= dMax - 0.08) { eMax = min(eMax, sErr); }
      }
    }
    let wColor = clamp((eMax - eMin) / max(eMin + eMax, 0.006), -1.0, 1.0);
    let wDepth = clamp((0.5 - tRaw) * 2.0, -1.0, 1.0);
    // 平衡前景抗锯齿混色阈值：保住暗发丝/胡须/头轮廓连续性，同时避免把背景侧暗缝像素拖到前景
    let contaminatedFg = (tRaw < 0.72) && (eMax > 0.035) && (eMin < 0.28) && (eMax > eMin * 0.85);
    let pickFg = contaminatedFg || ((wColor * 0.7 + wDepth * 0.3) >= -0.05);
    let snapD = select(dMax, dMin, pickFg);
    let effMix = select(max(snapMix, tailBgMix * select(0.0, 1.0, eMax <= eMin * 0.4)), snapMix, pickFg);
    snapMix = effMix;
    crispD = mix(centerD, snapD, effMix);
  }

  textureStore(outCrispDepth, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(crispD, snapMix, centerD, 1.0));
}
`

/**
 * Pass 0b-1: 初始化背景补洞层（屏蔽前景断崖内部与外扩 5px 杂边，但阈值 > 0.26 避开地平线等真实浅阶背景）。
 */
const COMPUTE_BG_MASK_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uSource: texture_2d<f32>;
@group(0) @binding(1) var uCrispDepth: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var outBg: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var outMeta: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dstDims = textureDimensions(outBg);
  if (gid.x >= dstDims.x || gid.y >= dstDims.y) { return; }

  let uv = (vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5)) / vec2<f32>(dstDims);
  let texel = vec2<f32>(1.0) / params.dims.xy;
  let centerD = sampleCrispDepthSafe(uCrispDepth, uv, params.dims.xy);
  let centerCol = sampleSourceCrispSafe(uSource, uCrispDepth, uv, centerD, params.dims.xy);

  var dMax5: f32 = centerD;
  var nearMin5: f32 = centerD;
  for (var oy: i32 = -2; oy <= 2; oy = oy + 1) {
    for (var ox: i32 = -2; ox <= 2; ox = ox + 1) {
      let pUv = clamp(uv + vec2<f32>(f32(ox), f32(oy)) * texel * 1.8, vec2<f32>(0.0), vec2<f32>(1.0));
      let pd = sampleCrispDepthSafe(uCrispDepth, pUv, params.dims.xy);
      dMax5 = max(dMax5, pd);
      nearMin5 = min(nearMin5, pd);
    }
  }
  var dMaxFg: f32 = dMax5;
  var nearMinFg: f32 = nearMin5;
  for (var d: i32 = 0; d < 8; d = d + 1) {
    let ang = (f32(d) / 8.0) * 6.2831853;
    let dir = vec2<f32>(cos(ang), sin(ang));
    let rimMidUv = clamp(uv + dir * texel * 11.0, vec2<f32>(0.0), vec2<f32>(1.0));
    let rimMidD = sampleCrispDepthSafe(uCrispDepth, rimMidUv, params.dims.xy);
    nearMinFg = min(nearMinFg, rimMidD);
    // 仅对真前景核（centerD < 0.26）执行外圈 14px + 84px 非对称向内侵蚀，严禁把紧邻远水的 0.35 木栈道尖角或中景黄盒当成前景抹掉
    if (centerD < 0.26) {
      let rimUv = clamp(uv + dir * texel * 14.0, vec2<f32>(0.0), vec2<f32>(1.0));
      dMaxFg = max(dMaxFg, max(rimMidD, sampleCrispDepthSafe(uCrispDepth, rimUv, params.dims.xy)));
      for (var stepIdx: i32 = 1; stepIdx <= 6; stepIdx = stepIdx + 1) {
        let fgR = f32(stepIdx) * 14.0;
        let fgUv = clamp(uv + dir * texel * fgR, vec2<f32>(0.0), vec2<f32>(1.0));
        dMaxFg = max(dMaxFg, sampleCrispDepthSafe(uCrispDepth, fgUv, params.dims.xy));
      }
    }
  }

  let fgThresh = mix(0.16, 0.25, smoothstep(0.22, 0.42, centerD));
  let nearCheck = select(nearMin5, nearMinFg, nearMinFg < 0.22 && centerD < 0.40);
  let bgThresh = mix(0.15, 0.25, smoothstep(0.22, 0.42, nearCheck));
  let isMasked = (dMaxFg - centerD > fgThresh) || (centerD - nearCheck > bgThresh);
  let dMax = dMaxFg;
  let nearMin = nearCheck;
  let valid = select(1.0, 0.0, isMasked);
  let seedX = select(-1.0, f32(gid.x), !isMasked);
  // outMeta.w 编码阈值：未掩码像素存 centerD >= 0（需 > centerD + 0.32 才被更深背景覆写，保护 0.43 木栈道不被 0.72 远水覆盖）；
  // 已掩码像素存 -(minBgD + 1.0) < 0：仅需大于近处前景高原 nearMin + 0.16，既能彻底屏蔽 0.03~0.09 前景核，
  // 又绝不会误杀紧邻地平线的 0.75 路面或紧邻水面的 0.42 木栈道。
  let minBgD = clamp(nearMin + 0.16, 0.0, max(dMax - 0.02, 0.0));
  let metaW = select(-(minBgD + 1.0), centerD, !isMasked);
  textureStore(outBg, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(centerCol, centerD));
  textureStore(outMeta, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(centerD, valid, seedX, metaW));
}
`

/**
 * Pass 0b-2: 1D 水平跳跃传播（Jump Flooding Algorithm: 128, 64, 32, 16, 8, 4, 2），
 * 精确把洞边缘最近的有效背景像素水平延伸到洞内，彻底杜绝跨带条纹与远景水色越过木栈道盖洞。
 */
const COMPUTE_BG_FLOOD_WGSL = /* wgsl */ `
@group(0) @binding(0) var uInBg: texture_2d<f32>;
@group(0) @binding(1) var uInMeta: texture_2d<f32>;
@group(0) @binding(2) var outBg: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var outMeta: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> jfaParams: vec4<i32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(outBg);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let c = vec2<i32>(i32(gid.x), i32(gid.y));
  let maxX = i32(dims.x) - 1;
  let curBg = textureLoad(uInBg, c, 0);
  let curMeta = textureLoad(uInMeta, c, 0);
  let metaW = curMeta.w;
  let reqMinD = select(-(metaW + 1.0), metaW + 0.32, metaW >= 0.0);

  var bestBg = curBg;
  var bestD = curMeta.x;
  var bestValid = curMeta.y;
  var bestSeedX = curMeta.z;
  var bestDist = select(1e9, abs(f32(c.x) - bestSeedX), bestValid > 0.5 && bestSeedX >= 0.0);

  let stride = jfaParams.x;
  for (var sign: i32 = -1; sign <= 1; sign = sign + 2) {
    let sx = clamp(c.x + sign * stride, 0, maxX);
    let sm = textureLoad(uInMeta, vec2<i32>(sx, c.y), 0);
    if (sm.y < 0.5 || sm.z < 0.0) { continue; }
    let candD = sm.x;
    if (candD < reqMinD) { continue; }
    let candSeedX = sm.z;
    let candDist = abs(f32(c.x) - candSeedX);

    if (bestValid < 0.5 || candDist < bestDist) {
      bestBg = textureLoad(uInBg, vec2<i32>(sx, c.y), 0);
      bestD = candD;
      bestValid = 1.0;
      bestSeedX = candSeedX;
      bestDist = candDist;
    }
  }

  textureStore(outBg, c, bestBg);
  textureStore(outMeta, c, vec4<f32>(bestD, bestValid, bestSeedX, metaW));
}
`

/**
 * Pass 0b-3: JFA 最后一跳（stride=1）+ 仅在整行无有效背景时执行的垂直兜底。
 */
const COMPUTE_BG_FALLBACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var uInBg: texture_2d<f32>;
@group(0) @binding(1) var uInMeta: texture_2d<f32>;
@group(0) @binding(2) var outBg: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var outMeta: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(outBg);
  if (gid.x >= dims.x || gid.y >= dims.y) { return; }

  let c = vec2<i32>(i32(gid.x), i32(gid.y));
  let maxX = i32(dims.x) - 1;
  let maxY = i32(dims.y) - 1;
  let curBg = textureLoad(uInBg, c, 0);
  let curMeta = textureLoad(uInMeta, c, 0);
  let metaW = curMeta.w;
  let reqMinD = select(-(metaW + 1.0), metaW + 0.32, metaW >= 0.0);

  var bestBg = curBg;
  var bestD = curMeta.x;
  var bestValid = curMeta.y;
  var bestSeedX = curMeta.z;
  var bestDist = select(1e9, abs(f32(c.x) - bestSeedX), bestValid > 0.5 && bestSeedX >= 0.0);

  for (var sign: i32 = -1; sign <= 1; sign = sign + 2) {
    let sx = clamp(c.x + sign, 0, maxX);
    let sm = textureLoad(uInMeta, vec2<i32>(sx, c.y), 0);
    if (sm.y < 0.5 || sm.z < 0.0) { continue; }
    let candD = sm.x;
    if (candD < reqMinD) { continue; }
    let candSeedX = sm.z;
    let candDist = abs(f32(c.x) - candSeedX);
    if (bestValid < 0.5 || candDist < bestDist) {
      bestBg = textureLoad(uInBg, vec2<i32>(sx, c.y), 0);
      bestD = candD;
      bestValid = 1.0;
      bestSeedX = candSeedX;
      bestDist = candDist;
    }
  }

  if (bestValid < 0.5) {
    var sumCol = vec3<f32>(0.0);
    var sumD: f32 = 0.0;
    var sumW: f32 = 0.0;
    for (var oy: i32 = -16; oy <= 16; oy = oy + 1) {
      if (oy == 0) { continue; }
      let sc = vec2<i32>(c.x, clamp(c.y + oy * 3, 0, maxY));
      let sm = textureLoad(uInMeta, sc, 0);
      if (sm.y > 0.5 && sm.x >= reqMinD) {
        let sBg = textureLoad(uInBg, sc, 0);
        let wt = exp(-f32(abs(oy)) * 0.25);
        sumCol = sumCol + sBg.rgb * wt;
        sumD = sumD + sm.x * wt;
        sumW = sumW + wt;
      }
    }
    if (sumW > 0.0001) {
      let avgD = sumD / sumW;
      textureStore(outBg, c, vec4<f32>(sumCol / sumW, avgD));
      textureStore(outMeta, c, vec4<f32>(avgD, 1.0, f32(c.x), metaW));
      return;
    }
  }

  textureStore(outBg, c, bestBg);
  textureStore(outMeta, c, vec4<f32>(bestD, bestValid, bestSeedX, metaW));
  // 对被前景掩码的空洞区域，做色差严格受限的局部垂直柔和平滑，消除 1D 水平 JFA 复制单像素木栈道边缘产生的横条纹（绝不跨斑马线黑白边界混合）。
  if (metaW < 0.0 && bestValid > 0.5) {
    var sCol = bestBg.rgb * 1.4;
    var sW: f32 = 1.4;
    for (var oy: i32 = -4; oy <= 4; oy = oy + 1) {
      if (oy == 0) { continue; }
      let sc = vec2<i32>(c.x, clamp(c.y + oy, 0, maxY));
      let sm = textureLoad(uInMeta, sc, 0);
      if (sm.y > 0.5 && sm.w < 0.0 && abs(sm.x - bestD) < 0.04) {
        let sBg = textureLoad(uInBg, sc, 0).rgb;
        let dCol = sBg - bestBg.rgb;
        let colDistSq = dot(dCol, dCol);
        // 严格阻断斑马线等高对比边跨行混色，只融合同色平缓木纹接缝
        let wCol = exp(-colDistSq * 64.0);
        if (wCol > 0.08) {
          let wt = wCol * exp(-f32(abs(oy)) * 0.42);
          sCol = sCol + sBg * wt;
          sW = sW + wt;
        }
      }
    }
    textureStore(outBg, c, vec4<f32>(sCol / max(sW, 1e-4), bestD));
  }
}
`

/**
 * Mode 3: 亚像素极线高度场光线追踪（Sub-Pixel Epipolar Raytrace）+ 背墙遮挡剔除 + 水平纯净背景补洞。
 * 步长 <= 0.45px 确保细发丝/肩线零漏采；当光线穿过从背景陡降到前景的背面断崖时直接转交背景补洞纹理。
 */
const COMPUTE_PARALLAX_RAY_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uSource: texture_2d<f32>;
@group(0) @binding(1) var uCrispDepth: texture_2d<f32>;
@group(0) @binding(2) var uBgInpaint: texture_2d<f32>;
@group(0) @binding(3) var uSamp: sampler;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var outImage: texture_storage_2d<rgba8unorm, write>;

fn traceParallaxSample(
  rayUv: vec2<f32>,
  shiftUv: vec2<f32>,
  steps: i32,
  dz: f32,
  tol: f32
) -> vec4<f32> {
  let dims = params.dims.xy;
  var prevUv = clamp(rayUv - shiftUv, vec2<f32>(0.0), vec2<f32>(1.0));
  var prevD = sampleCrispDepthSafe(uCrispDepth, prevUv, dims);
  var prevZ: f32 = 0.0;

  var hitValid = false;
  var hitUv = prevUv;
  var hitD = prevD;

  if (prevD <= 0.005) {
    hitValid = true;
    hitUv = prevUv;
    hitD = prevD;
  } else {
    for (var i: i32 = 1; i <= steps; i = i + 1) {
      let z = f32(i) * dz;
      let pUv = clamp(rayUv + shiftUv * ((z - 0.5) * 2.0), vec2<f32>(0.0), vec2<f32>(1.0));
      let d = sampleCrispDepthSafe(uCrispDepth, pUv, dims);
      if (z >= d - 0.002) {
        if ((z - d) > tol && (prevD - d) > 0.08) {
          hitValid = false;
          break;
        }
        if (abs(prevD - d) > 0.10) {
          hitUv = pUv;
          hitD = d;
        } else {
          let denom = (prevD - d) + (z - prevZ);
          let frac = clamp((prevD - prevZ) / max(denom, 1e-4), 0.0, 1.0);
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
    let maxCoord = vec2<i32>(max(i32(dims.x) - 1, 0), max(i32(dims.y) - 1, 0));
    let cIdx = clamp(vec2<i32>(round(hitUv * dims - 0.5)), vec2<i32>(0), maxCoord);
    let snapFlag = textureLoad(uCrispDepth, cIdx, 0).g;
    let col = sampleSourceCrispSafe(uSource, uCrispDepth, hitUv, hitD, dims);
    return vec4<f32>(col, snapFlag);
  }
  // L1 双层高度场光线追踪（在已抹除前景的 uBgInpaint 上用最近整数纹素步进，平滑区直接子像素双线性返回 0.0 避免叠加 4x RGSS 灰带）：
  let bgMaxC = vec2<i32>(max(i32(dims.x) - 1, 0), max(i32(dims.y) - 1, 0));
  var prevBgUv = clamp(rayUv - shiftUv, vec2<f32>(0.0), vec2<f32>(1.0));
  var prevBgS = textureLoad(uBgInpaint, clamp(vec2<i32>(round(prevBgUv * dims - 0.5)), vec2<i32>(0), bgMaxC), 0);
  var prevBgZ: f32 = 0.0;
  for (var j: i32 = 1; j <= steps; j = j + 1) {
    let z = f32(j) * dz;
    let bUv = clamp(rayUv + shiftUv * ((z - 0.5) * 2.0), vec2<f32>(0.0), vec2<f32>(1.0));
    let bIdx = clamp(vec2<i32>(round(bUv * dims - 0.5)), vec2<i32>(0), bgMaxC);
    let bS = textureLoad(uBgInpaint, bIdx, 0);
    let bd = bS.a;
    if (z >= bd - 0.002) {
      if ((z - bd) > tol && (prevBgS.a - bd) > 0.08) {
        return vec4<f32>(prevBgS.rgb, 1.0);
      }
      if (abs(prevBgS.a - bd) <= 0.03) {
        let denom = (prevBgS.a - bd) + (z - prevBgZ);
        let frac = clamp((prevBgS.a - prevBgZ) / max(denom, 1e-4), 0.0, 1.0);
        let finalBgUv = mix(prevBgUv, bUv, frac);
        let c = clamp(finalBgUv * dims - 0.5, vec2<f32>(0.0), vec2<f32>(bgMaxC));
        let i0 = vec2<i32>(floor(c));
        let f = fract(c);
        let s00 = textureLoad(uBgInpaint, clamp(i0, vec2<i32>(0), bgMaxC), 0);
        let s10 = textureLoad(uBgInpaint, clamp(i0 + vec2<i32>(1, 0), vec2<i32>(0), bgMaxC), 0);
        let s01 = textureLoad(uBgInpaint, clamp(i0 + vec2<i32>(0, 1), vec2<i32>(0), bgMaxC), 0);
        let s11 = textureLoad(uBgInpaint, clamp(i0 + vec2<i32>(1, 1), vec2<i32>(0), bgMaxC), 0);
        let dMin4 = min(min(s00.a, s10.a), min(s01.a, s11.a));
        let dMax4 = max(max(s00.a, s10.a), max(s01.a, s11.a));
        if (dMax4 - dMin4 > 0.12) {
          return vec4<f32>(textureLoad(uBgInpaint, clamp(vec2<i32>(round(c)), vec2<i32>(0), bgMaxC), 0).rgb, 1.0);
        }
        let bCol = mix(mix(s00.rgb, s10.rgb, f.x), mix(s01.rgb, s11.rgb, f.x), f.y);
        return vec4<f32>(bCol, 0.0);
      }
      return vec4<f32>(bS.rgb, 1.0);
    }
    prevBgZ = z;
    prevBgS = bS;
    prevBgUv = bUv;
  }
  return vec4<f32>(prevBgS.rgb, 1.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.dims.x);
  let h = u32(params.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let uv = (vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5)) / params.dims.xy;
  let texel = vec2<f32>(1.0) / params.dims.xy;
  let shiftMag = params.parallaxA.z;

  if (shiftMag < 0.05) {
    textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), textureSampleLevel(uSource, uSamp, uv, 0.0));
    return;
  }

  let shiftUv = params.parallaxA.xy * texel;
  let maxDispPx = max(shiftMag * 2.0, 0.0);
  let steps = clamp(i32(ceil(max(maxDispPx * 2.3, 56.0))), 56, 192);
  let dz = 1.0 / f32(steps);
  let tol = max(dz * 1.45, 0.022);

  let r0 = traceParallaxSample(uv, shiftUv, steps, dz, tol);
  var linCol = r0.rgb;
  // 在断崖边界与遮挡补洞边缘（snapFlag > 0.25）开启 4x RGSS 亚像素抗锯齿，消除弯曲轮廓锯齿与接缝
  if (r0.a > 0.25) {
    let r1 = traceParallaxSample(uv + vec2<f32>(0.375, 0.125) * texel, shiftUv, steps, dz, tol);
    let r2 = traceParallaxSample(uv + vec2<f32>(-0.125, 0.375) * texel, shiftUv, steps, dz, tol);
    let r3 = traceParallaxSample(uv + vec2<f32>(-0.375, -0.125) * texel, shiftUv, steps, dz, tol);
    let r4 = traceParallaxSample(uv + vec2<f32>(0.125, -0.375) * texel, shiftUv, steps, dz, tol);
    linCol = mix(linCol, (r1.rgb + r2.rgb + r3.rgb + r4.rgb) * 0.25, smoothstep(0.25, 0.65, r0.a));
  }

  let srcAlpha = textureSampleLevel(uSource, uSamp, uv, 0.0).a;
  textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(linearToSrgb(linCol), srcAlpha));
}
`

/**
 * Mode 0 (Fog) & Mode 1 (Atmosphere) 单 Pass 线性空间渲染。
 */
const COMPUTE_FOG_ATMOS_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uSource: texture_2d<f32>;
@group(0) @binding(1) var uRefinedDepth: texture_2d<f32>;
@group(0) @binding(2) var uNormal: texture_2d<f32>;
@group(0) @binding(3) var uSamp: sampler;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var<storage, read> points: array<SpatialPoint>;
@group(0) @binding(6) var outImage: texture_storage_2d<rgba8unorm, write>;

fn spatialWeightOf(uv: vec2<f32>) -> f32 {
  let count = min(i32(params.modeArgs.y), 100);
  let aspect = params.dims.x / max(params.dims.y, 1.0);
  var weight: f32 = 1.0;
  for (var i: i32 = 0; i < count; i = i + 1) {
    let pt = points[i];
    let dx = (uv.x - pt.geom.x) * aspect;
    let dy = uv.y - pt.geom.y;
    let radius = max(0.01, pt.geom.z);
    let feather = max(0.03, pt.geom.w);
    let dist = length(vec2<f32>(dx, dy));
    let inf = 1.0 - smoothstep(radius * (1.0 - feather * 0.35), radius, dist);
    if (inf > 0.0) {
      let strength = max(0.0, pt.ctrl.x);
      if (pt.ctrl.y < 0.0) {
        weight = weight * (1.0 - strength * inf);
      } else {
        weight = weight + strength * inf;
      }
    }
  }
  return max(0.0, weight);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.dims.x);
  let h = u32(params.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let pixelCoord = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let uv = pixelCoord / params.dims.xy;
  let srcSample = textureSampleLevel(uSource, uSamp, uv, 0.0);
  let d = loadRefinedDepth(uRefinedDepth, uv, params.dims.xy);
  let mode = i32(params.modeArgs.x + 0.5);

  if (mode == 1) {
    let startDepth = clamp(params.fogA.y, 0.0, 1.0);
    let depthWeight = smoothstep(startDepth, 1.0, d);
    if (depthWeight <= 0.0001) {
      textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), srcSample);
      return;
    }
    let srcLin = srgbToLinear(srcSample.rgb);
    let lumLin = luminance(srcLin);
    let desat = clamp(params.fogB.w * depthWeight, 0.0, 1.0);
    var colLin = mix(srcLin, vec3<f32>(lumLin), desat);
    let hazeAmount = clamp(params.fogB.z * depthWeight, 0.0, 1.0);
    let airLin = srgbToLinear(params.colorA.rgb);
    colLin = mix(colLin, airLin, hazeAmount);
    let outSrgb = linearToSrgb(colLin);
    // 对比度只对远景起作用，确保前景主体 100% 锐利不发灰。
    let effContrast = mix(1.0, params.atmosA.x, depthWeight);
    let finalRgb = clamp((outSrgb - vec3<f32>(0.5)) * effContrast + vec3<f32>(0.5), vec3<f32>(0.0), vec3<f32>(1.0));
    textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(finalRgb, srcSample.a));
    return;
  }

  let startDepth = clamp(params.fogA.y, 0.0, 1.0);
  let falloff = max(0.05, params.fogA.z);
  let baseDepthW = select(1.0 - exp(-(d - startDepth) * falloff * 4.2), 0.0, d <= startDepth);

  var heightW: f32 = 1.0;
  let groundBias = params.fogA.w;
  if (groundBias > 0.0) {
    let horizon = clamp(params.fogB.x, 0.05, 0.98);
    let ground = smoothstep(horizon - 0.42, horizon + 0.18, uv.y);
    heightW = (1.0 - groundBias) + groundBias * (0.35 + 0.65 * ground);
    if (params.fogB.y > 0.5) {
      let n = normalize(textureSampleLevel(uNormal, uSamp, uv, 0.0).rgb * 2.0 - 1.0);
      heightW = heightW * (0.82 + 0.28 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
    }
  }

  let spatial = spatialWeightOf(uv);
  let localBoost = select(0.0, min(0.55, (spatial - 1.0) * 0.45), spatial > 1.0);
  let effDepth = max(baseDepthW, localBoost * (0.35 + 0.65 * d));
  let alpha = clamp(params.fogA.x * effDepth * heightW * spatial, 0.0, 1.0);
  if (alpha <= 0.0001) {
    textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), srcSample);
    return;
  }

  let srcLin = srgbToLinear(srcSample.rgb);
  let fogLin = srgbToLinear(params.colorA.rgb);
  var blendedLin: vec3<f32>;
  if (params.colorA.w > 0.5) {
    let mixAmt = alpha * 0.88;
    let screenLin = vec3<f32>(1.0) - (vec3<f32>(1.0) - srcLin) * (vec3<f32>(1.0) - fogLin);
    blendedLin = mix(srcLin, screenLin, mixAmt);
  } else {
    let mixAmt = alpha * 0.94;
    blendedLin = mix(srcLin, fogLin, mixAmt);
  }
  textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(linearToSrgb(blendedLin), srcSample.a));
}
`

/**
 * Mode 2 Pass 1: 计算有符号弥散圆 CoC + 邻域前景 CoC 膨胀信息。
 */
const COMPUTE_DOF_COC_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uRefinedDepth: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var outCoc: texture_storage_2d<rgba16float, write>;

fn computeFocusDepth() -> f32 {
  let focusUv = clamp(params.dofA.xy, vec2<f32>(0.0), vec2<f32>(1.0));
  let texel = vec2<f32>(1.0) / params.dims.xy;
  var sum: f32 = 0.0;
  var wSum: f32 = 0.0;
  for (var oy: i32 = -2; oy <= 2; oy = oy + 1) {
    for (var ox: i32 = -2; ox <= 2; ox = ox + 1) {
      let sUv = clamp(focusUv + vec2<f32>(f32(ox), f32(oy)) * texel * 1.5, vec2<f32>(0.0), vec2<f32>(1.0));
      let w = 1.0 / (1.0 + f32(ox * ox + oy * oy));
      sum = sum + loadRefinedDepth(uRefinedDepth, sUv, params.dims.xy) * w;
      wSum = wSum + w;
    }
  }
  return sum / max(wSum, 1e-5);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.dims.x);
  let h = u32(params.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let pixelCoord = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let uv = pixelCoord / params.dims.xy;
  let d = loadRefinedDepth(uRefinedDepth, uv, params.dims.xy);
  let focusD = computeFocusDepth();
  let aperture = max(0.02, params.dofA.z);
  let tilt = params.modeArgs.w > 0.5;
  let deadzone = select(aperture * 0.16, aperture * 0.12, tilt);

  var diff: f32;
  if (tilt) {
    diff = clamp(abs(uv.y - params.dofA.y) * 2.4, 0.0, 1.0);
  } else {
    diff = d - focusD;
  }
  let mag = max(0.0, abs(diff) - deadzone);
  let cocMag = smoothstep(0.0, aperture, mag);
  let signedCoc = select(cocMag, -cocMag, diff < 0.0 && !tilt);
  let nearCoc = max(-signedCoc, 0.0);
  let farCoc = max(signedCoc, 0.0);
  textureStore(outCoc, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(signedCoc, nearCoc, farCoc, d));
}
`

/**
 * Mode 2 Pass 2: Near/Far 分离物理散景采集（48-tap Vogel Disk + IGN 旋转 + 防前景渗色 + 近景膨胀溢出）。
 */
const COMPUTE_DOF_BOKEH_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uSource: texture_2d<f32>;
@group(0) @binding(1) var uCoc: texture_2d<f32>;
@group(0) @binding(2) var uSamp: sampler;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var outFarBokeh: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var outNearBokeh: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.dims.x);
  let h = u32(params.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let pixelCoord = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let uv = pixelCoord / params.dims.xy;
  let texel = vec2<f32>(1.0) / params.dims.xy;
  let maxRadius = clamp(params.dofA.w, 0.0, 58.0);

  let centerSrc = textureSampleLevel(uSource, uSamp, uv, 0.0);
  let centerLin = srgbToLinear(centerSrc.rgb);
  let centerInfo = textureSampleLevel(uCoc, uSamp, uv, 0.0);
  let centerSigned = centerInfo.x;
  let centerNear = centerInfo.y;
  let centerFar = centerInfo.z;
  let centerDepth = centerInfo.w;

  // 探测最大前景虚化半径，使虚化的前景能柔和溢出覆盖在清晰中景上。
  var maxNearCoc: f32 = centerNear;
  if (maxRadius >= 1.0) {
    let probeSpan = maxRadius * 0.72;
    for (var py: i32 = -2; py <= 2; py = py + 1) {
      for (var px: i32 = -2; px <= 2; px = px + 1) {
        if (px == 0 && py == 0) { continue; }
        let pUv = clamp(uv + vec2<f32>(f32(px), f32(py)) * 0.5 * probeSpan * texel, vec2<f32>(0.0), vec2<f32>(1.0));
        maxNearCoc = max(maxNearCoc, textureSampleLevel(uCoc, uSamp, pUv, 0.0).y);
      }
    }
  }

  let farRadius = centerFar * maxRadius;
  let nearRadius = maxNearCoc * maxRadius;
  if (farRadius < 0.5 && nearRadius < 0.5) {
    textureStore(outFarBokeh, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(centerLin, 0.0));
    textureStore(outNearBokeh, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(0.0));
    return;
  }

  let taps = 48u;
  let goldenAngle = 2.39996323;
  let rot = ign(pixelCoord) * 6.2831853;
  let cosRot = cos(rot);
  let sinRot = sin(rot);

  var farAcc = vec3<f32>(0.0);
  var farW: f32 = 0.0;
  if (farRadius >= 0.5) {
    let centerW = max(0.04, 1.0 - centerFar * 0.90);
    farAcc = centerLin * centerW;
    farW = centerW;
    for (var i: u32 = 0u; i < taps; i = i + 1u) {
      let rNorm = sqrt((f32(i) + 0.5) / f32(taps));
      let theta = f32(i) * goldenAngle;
      let dir = vec2<f32>(cos(theta), sin(theta));
      let rDir = vec2<f32>(dir.x * cosRot - dir.y * sinRot, dir.x * sinRot + dir.y * cosRot);
      let sUv = clamp(uv + rDir * (rNorm * farRadius) * texel, vec2<f32>(0.0), vec2<f32>(1.0));
      let sInfo = textureSampleLevel(uCoc, uSamp, sUv, 0.0);
      let sFar = sInfo.z;
      let sDepth = sInfo.w;

      // 关键防渗色：若采样点在焦内或比当前像素明显更近，直接拒收，彻底消灭主体周围的轮廓光环。
      var wt: f32 = 1.0;
      if (sDepth < centerDepth - 0.028) {
        wt = smoothstep(0.12, 0.45, abs(sInfo.x)) * 0.06;
      } else {
        wt = 0.18 + 0.82 * smoothstep(0.0, max(0.08, rNorm * 0.78), sFar);
      }
      if (wt > 0.002) {
        let sCol = srgbToLinear(textureSampleLevel(uSource, uSamp, sUv, 0.0).rgb);
        // 轻微高光散景增强，还原镜头光斑质感。
        let highlight = 1.0 + 0.42 * pow(luminance(sCol), 2.5) * sFar;
        let finalW = wt * highlight;
        farAcc = farAcc + sCol * finalW;
        farW = farW + finalW;
      }
    }
  } else {
    farAcc = centerLin;
    farW = 1.0;
  }

  var nearPremul = vec3<f32>(0.0);
  var nearAlphaAcc: f32 = 0.0;
  var nearTotalW: f32 = 0.0;
  if (nearRadius >= 0.5) {
    for (var i: u32 = 0u; i < taps; i = i + 1u) {
      let rNorm = sqrt((f32(i) + 0.5) / f32(taps));
      let theta = f32(i) * goldenAngle;
      let dir = vec2<f32>(cos(theta), sin(theta));
      let rDir = vec2<f32>(dir.x * cosRot - dir.y * sinRot, dir.x * sinRot + dir.y * cosRot);
      let sUv = clamp(uv + rDir * (rNorm * nearRadius) * texel, vec2<f32>(0.0), vec2<f32>(1.0));
      let sInfo = textureSampleLevel(uCoc, uSamp, sUv, 0.0);
      let sNear = sInfo.y;
      let cov = smoothstep(rNorm * 0.75, rNorm * 0.75 + 0.25, sNear);
      let sCol = srgbToLinear(textureSampleLevel(uSource, uSamp, sUv, 0.0).rgb);
      nearPremul = nearPremul + sCol * cov;
      nearAlphaAcc = nearAlphaAcc + cov;
      nearTotalW = nearTotalW + 1.0;
    }
  }

  let farOut = farAcc / max(farW, 1e-4);
  let nearAlpha = clamp(nearAlphaAcc / max(nearTotalW, 1.0), 0.0, 1.0);
  let nearOut = select(vec3<f32>(0.0), nearPremul / max(nearAlphaAcc, 1e-4) * nearAlpha, nearAlphaAcc > 1e-4);

  textureStore(outFarBokeh, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(farOut, centerFar));
  textureStore(outNearBokeh, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(nearOut, nearAlpha));
}
`

/**
 * Mode 2 Pass 3: 5×5 CoC-加权平滑抛光 + 焦内锐利原图合成 + Premultiplied Near 叠加。
 */
const COMPUTE_DOF_COMPOSITE_WGSL = WGSL_COMMON + /* wgsl */ `
@group(0) @binding(0) var uSource: texture_2d<f32>;
@group(0) @binding(1) var uCoc: texture_2d<f32>;
@group(0) @binding(2) var uFarBokeh: texture_2d<f32>;
@group(0) @binding(3) var uNearBokeh: texture_2d<f32>;
@group(0) @binding(4) var uSamp: sampler;
@group(0) @binding(5) var<uniform> params: Params;
@group(0) @binding(6) var outImage: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.dims.x);
  let h = u32(params.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }

  let pixelCoord = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let uv = pixelCoord / params.dims.xy;
  let texel = vec2<f32>(1.0) / params.dims.xy;

  let srcSample = textureSampleLevel(uSource, uSamp, uv, 0.0);
  let srcLin = srgbToLinear(srcSample.rgb);
  let centerInfo = textureSampleLevel(uCoc, uSamp, uv, 0.0);
  let centerFar = centerInfo.z;
  let centerDepth = centerInfo.w;
  let nearLayer = textureSampleLevel(uNearBokeh, uSamp, uv, 0.0);

  var farClean = textureSampleLevel(uFarBokeh, uSamp, uv, 0.0).rgb;
  if (centerFar > 0.03) {
    var acc = farClean * 0.25;
    var wSum: f32 = 0.25;
    for (var oy: i32 = -2; oy <= 2; oy = oy + 1) {
      for (var ox: i32 = -2; ox <= 2; ox = ox + 1) {
        if (ox == 0 && oy == 0) { continue; }
        let sUv = clamp(uv + vec2<f32>(f32(ox), f32(oy)) * texel * 1.4, vec2<f32>(0.0), vec2<f32>(1.0));
        let sInfo = textureSampleLevel(uCoc, uSamp, sUv, 0.0);
        let dDiff = abs(sInfo.w - centerDepth);
        let wDepth = exp(-dDiff * dDiff * 180.0);
        let wCoc = smoothstep(0.0, 0.12, sInfo.z);
        let wt = wDepth * wCoc * exp(-f32(ox * ox + oy * oy) * 0.16);
        acc = acc + textureSampleLevel(uFarBokeh, uSamp, sUv, 0.0).rgb * wt;
        wSum = wSum + wt;
      }
    }
    farClean = acc / max(wSum, 1e-4);
  }

  // 焦内像素保持 100% 原图锐度，随 CoC 平滑过渡到远景散景，最后叠加前景预乘溢出层。
  let farMix = smoothstep(0.0, 0.16, centerFar);
  var composed = mix(srcLin, farClean, farMix);
  let nearAlpha = clamp(nearLayer.a, 0.0, 1.0);
  composed = composed * (1.0 - nearAlpha) + nearLayer.rgb;

  textureStore(outImage, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(linearToSrgb(composed), srcSample.a));
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

function bufferFingerprint(data) {
  if (!data || !data.length) return '0'
  const n = data.length
  const mid = Math.floor(n / 2)
  const q1 = Math.floor(n / 4)
  const q3 = Math.floor((n * 3) / 4)
  return `${n}:${data[0]}:${data[q1]}:${data[mid]}:${data[q3]}:${data[n - 1]}`
}

let gpuStatePromise = null
let gpuFailed = false

function resetGpuState() {
  if (gpuStatePromise) {
    gpuStatePromise.then((state) => {
      if (state?.textures) {
        Object.values(state.textures).forEach((tex) => {
          if (tex && typeof tex.destroy === 'function') {
            try { tex.destroy() } catch {}
          }
        })
      }
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
        const viewCanvas = document.createElement('canvas')
        const ctx = canvas.getContext('webgpu')
        if (!ctx) return null

        const refineDepthPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_REFINE_DEPTH_WGSL }), entryPoint: 'main' },
        })
        const crispDepthPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_CRISP_DEPTH_WGSL }), entryPoint: 'main' },
        })
        const bgMaskPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_BG_MASK_WGSL }), entryPoint: 'main' },
        })
        const bgFloodPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_BG_FLOOD_WGSL }), entryPoint: 'main' },
        })
        const bgFallbackPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_BG_FALLBACK_WGSL }), entryPoint: 'main' },
        })
        const parallaxMpiPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_PARALLAX_RAY_WGSL }), entryPoint: 'main' },
        })
        const fogAtmosPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_FOG_ATMOS_WGSL }), entryPoint: 'main' },
        })
        const dofCocPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_DOF_COC_WGSL }), entryPoint: 'main' },
        })
        const dofBokehPipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_DOF_BOKEH_WGSL }), entryPoint: 'main' },
        })
        const dofCompositePipeline = device.createComputePipeline({
          layout: 'auto',
          compute: { module: device.createShaderModule({ code: COMPUTE_DOF_COMPOSITE_WGSL }), entryPoint: 'main' },
        })
        const blitPipeline = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module: device.createShaderModule({ code: BLIT_WGSL }), entryPoint: 'vs' },
          fragment: { module: device.createShaderModule({ code: BLIT_WGSL }), entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list' },
        })

        const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
        const uniformBuffer = device.createBuffer({
          size: 128,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        const pointsBuffer = device.createBuffer({
          size: MAX_SPATIAL_POINTS * 32,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        })
        const jfaStrides = [128, 64, 32, 16, 8, 4, 2]
        const jfaBuffers = jfaStrides.map((stride) => {
          const buf = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
          device.queue.writeBuffer(buf, 0, new Int32Array([stride, 0, 0, 0]))
          return buf
        })

        return {
          device,
          format,
          canvas,
          viewCanvas,
          ctx,
          refineDepthPipeline,
          crispDepthPipeline,
          bgMaskPipeline,
          bgFloodPipeline,
          bgFallbackPipeline,
          parallaxMpiPipeline,
          fogAtmosPipeline,
          dofCocPipeline,
          dofBokehPipeline,
          dofCompositePipeline,
          blitPipeline,
          sampler,
          uniformBuffer,
          pointsBuffer,
          jfaBuffers,
          width: 0,
          height: 0,
          rawDepthW: 0,
          rawDepthH: 0,
          textures: null,
          bindGroups: null,
          sourceSig: '',
          depthSig: '',
          normalSig: '',
          bgInpaintedSig: '',
        }
      } catch {
        gpuFailed = true
        return null
      }
    })()
  }
  return gpuStatePromise
}

function ensureSurfaceResources(state, width, height, rawDepthW, rawDepthH) {
  const { device, canvas, ctx, format } = state
  if (
    state.width === width
    && state.height === height
    && state.rawDepthW === rawDepthW
    && state.rawDepthH === rawDepthH
    && state.textures
  ) {
    return
  }
  if (state.textures) {
    Object.values(state.textures).forEach((tex) => {
      if (tex && typeof tex.destroy === 'function') {
        try { tex.destroy() } catch {}
      }
    })
  }
  canvas.width = width
  canvas.height = height
  ctx.configure({ device, format, alphaMode: 'premultiplied' })

  const sampleUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  const storageUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
  const outputUsage = storageUsage | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST

  const bgW = width
  const bgH = height
  const texSource = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: sampleUsage | GPUTextureUsage.COPY_SRC })
  const texNormal = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: sampleUsage })
  const texRawDepth = device.createTexture({ size: [rawDepthW, rawDepthH, 1], format: 'r32float', usage: sampleUsage })
  const texRefinedDepth = device.createTexture({ size: [width, height, 1], format: 'rgba16float', usage: storageUsage })
  const texCrispDepth = device.createTexture({ size: [width, height, 1], format: 'rgba16float', usage: storageUsage })
  const texBgA = device.createTexture({ size: [bgW, bgH, 1], format: 'rgba16float', usage: storageUsage })
  const texBgB = device.createTexture({ size: [bgW, bgH, 1], format: 'rgba16float', usage: storageUsage })
  const texMetaA = device.createTexture({ size: [bgW, bgH, 1], format: 'rgba16float', usage: storageUsage })
  const texMetaB = device.createTexture({ size: [bgW, bgH, 1], format: 'rgba16float', usage: storageUsage })
  const texCoc = device.createTexture({ size: [width, height, 1], format: 'rgba16float', usage: storageUsage })
  const texFarBokeh = device.createTexture({ size: [width, height, 1], format: 'rgba16float', usage: storageUsage })
  const texNearBokeh = device.createTexture({ size: [width, height, 1], format: 'rgba16float', usage: storageUsage })
  const texOutput = device.createTexture({ size: [width, height, 1], format: 'rgba8unorm', usage: outputUsage })

  state.textures = {
    texSource,
    texNormal,
    texRawDepth,
    texRefinedDepth,
    texCrispDepth,
    texBgA,
    texBgB,
    texMetaA,
    texMetaB,
    texCoc,
    texFarBokeh,
    texNearBokeh,
    texOutput,
  }
  state.halfDims = [bgW, bgH]

  state.bindGroups = {
    bgRefineDepth: device.createBindGroup({
      layout: state.refineDepthPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texRawDepth.createView() },
        { binding: 1, resource: texSource.createView() },
        { binding: 2, resource: state.sampler },
        { binding: 3, resource: { buffer: state.uniformBuffer } },
        { binding: 4, resource: texRefinedDepth.createView() },
      ],
    }),
    bgCrispDepth: device.createBindGroup({
      layout: state.crispDepthPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texSource.createView() },
        { binding: 1, resource: texRefinedDepth.createView() },
        { binding: 2, resource: state.sampler },
        { binding: 3, resource: { buffer: state.uniformBuffer } },
        { binding: 4, resource: texCoc.createView() },
      ],
    }),
    bgCrispDepthP2: device.createBindGroup({
      layout: state.crispDepthPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texSource.createView() },
        { binding: 1, resource: texCoc.createView() },
        { binding: 2, resource: state.sampler },
        { binding: 3, resource: { buffer: state.uniformBuffer } },
        { binding: 4, resource: texCrispDepth.createView() },
      ],
    }),
    bgMask: device.createBindGroup({
      layout: state.bgMaskPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texSource.createView() },
        { binding: 1, resource: texCrispDepth.createView() },
        { binding: 3, resource: { buffer: state.uniformBuffer } },
        { binding: 4, resource: texBgA.createView() },
        { binding: 5, resource: texMetaA.createView() },
      ],
    }),
    bgFloodPasses: state.jfaBuffers.map((buf, pass) => device.createBindGroup({
      layout: state.bgFloodPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: (pass % 2 === 0 ? texBgA : texBgB).createView() },
        { binding: 1, resource: (pass % 2 === 0 ? texMetaA : texMetaB).createView() },
        { binding: 2, resource: (pass % 2 === 0 ? texBgB : texBgA).createView() },
        { binding: 3, resource: (pass % 2 === 0 ? texMetaB : texMetaA).createView() },
        { binding: 4, resource: { buffer: buf } },
      ],
    })),
    bgFallbackBA: device.createBindGroup({
      layout: state.bgFallbackPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texBgB.createView() },
        { binding: 1, resource: texMetaB.createView() },
        { binding: 2, resource: texBgA.createView() },
        { binding: 3, resource: texMetaA.createView() },
      ],
    }),
    bgParallaxMpi: device.createBindGroup({
      layout: state.parallaxMpiPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texSource.createView() },
        { binding: 1, resource: texCrispDepth.createView() },
        { binding: 2, resource: texBgA.createView() },
        { binding: 3, resource: state.sampler },
        { binding: 4, resource: { buffer: state.uniformBuffer } },
        { binding: 5, resource: texOutput.createView() },
      ],
    }),
    bgFogAtmos: device.createBindGroup({
      layout: state.fogAtmosPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texSource.createView() },
        { binding: 1, resource: texRefinedDepth.createView() },
        { binding: 2, resource: texNormal.createView() },
        { binding: 3, resource: state.sampler },
        { binding: 4, resource: { buffer: state.uniformBuffer } },
        { binding: 5, resource: { buffer: state.pointsBuffer } },
        { binding: 6, resource: texOutput.createView() },
      ],
    }),
    bgDofCoc: device.createBindGroup({
      layout: state.dofCocPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texRefinedDepth.createView() },
        { binding: 1, resource: { buffer: state.uniformBuffer } },
        { binding: 2, resource: texCoc.createView() },
      ],
    }),
    bgDofBokeh: device.createBindGroup({
      layout: state.dofBokehPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texSource.createView() },
        { binding: 1, resource: texCoc.createView() },
        { binding: 2, resource: state.sampler },
        { binding: 3, resource: { buffer: state.uniformBuffer } },
        { binding: 4, resource: texFarBokeh.createView() },
        { binding: 5, resource: texNearBokeh.createView() },
      ],
    }),
    bgDofComposite: device.createBindGroup({
      layout: state.dofCompositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texSource.createView() },
        { binding: 1, resource: texCoc.createView() },
        { binding: 2, resource: texFarBokeh.createView() },
        { binding: 3, resource: texNearBokeh.createView() },
        { binding: 4, resource: state.sampler },
        { binding: 5, resource: { buffer: state.uniformBuffer } },
        { binding: 6, resource: texOutput.createView() },
      ],
    }),
    bgBlit: device.createBindGroup({
      layout: state.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: texOutput.createView() },
        { binding: 1, resource: state.sampler },
      ],
    }),
  }
  state.width = width
  state.height = height
  state.rawDepthW = rawDepthW
  state.rawDepthH = rawDepthH
  state.sourceSig = ''
  state.depthSig = ''
  state.normalSig = ''
  state.bgInpaintedSig = ''
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

function constantNormalPixels(width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128
    data[i + 1] = 128
    data[i + 2] = 255
    data[i + 3] = 255
  }
  return { width, height, data }
}

/**
 * 用 WebGPU 计算着色器渲染一帧空间滤镜（雾效 / 大气透视 / 景深 / 2.5D 视差）。
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} image
 * @param {{width:number,height:number,data:Float32Array}} depth
 * @param {object} [options]
 * @param {boolean} [options.readPixels] true 时回读全分辨率 RGBA 供直接落盘。
 * @returns {Promise<{canvas:HTMLCanvasElement,pixels:{width:number,height:number,data:Uint8ClampedArray}|null}|null>}
 */
export async function renderDepthFxWebGPU(image, depth, options = {}) {
  if (!image?.data || !image.width || !image.height || !depth?.data || !depth.width || !depth.height) {
    return null
  }
  const state = await ensureGPU()
  if (!state) return null

  const width = Number(image.width)
  const height = Number(image.height)
  const rawDepthW = Number(depth.width)
  const rawDepthH = Number(depth.height)
  const modeStr = options.mode === 'atmosphere' || options.mode === 'dof' || options.mode === 'parallax'
    ? options.mode
    : 'fog'
  const modeIndex = modeStr === 'atmosphere' ? 1 : modeStr === 'dof' ? 2 : modeStr === 'parallax' ? 3 : 0

  try {
    ensureSurfaceResources(state, width, height, rawDepthW, rawDepthH)
    const { device, canvas, ctx, textures, bindGroups, uniformBuffer, pointsBuffer } = state

    const sourceSig = `${width}x${height}:${bufferFingerprint(image.data)}`
    const depthSig = `${rawDepthW}x${rawDepthH}:${bufferFingerprint(depth.data)}`
    const sourceChanged = state.sourceSig !== sourceSig
    const depthChanged = state.depthSig !== depthSig

    if (sourceChanged) {
      writeRgbaTexture(device, textures.texSource, image, width, height)
      state.sourceSig = sourceSig
    }
    if (depthChanged) {
      const depthF32 = depth.data instanceof Float32Array ? depth.data : new Float32Array(depth.data)
      device.queue.writeTexture(
        { texture: textures.texRawDepth },
        depthF32,
        { bytesPerRow: rawDepthW * 4 },
        [rawDepthW, rawDepthH, 1],
      )
      state.depthSig = depthSig
    }

    let hasNormal = false
    if (modeStr === 'fog' && options.normal?.data && options.normal.width === width && options.normal.height === height) {
      hasNormal = true
      const normalSig = `${width}x${height}:${bufferFingerprint(options.normal.data)}`
      if (state.normalSig !== normalSig) {
        writeRgbaTexture(device, textures.texNormal, options.normal, width, height)
        state.normalSig = normalSig
      }
    } else if (modeStr === 'fog' && state.normalSig !== 'neutral') {
      const neutral = constantNormalPixels(width, height)
      writeRgbaTexture(device, textures.texNormal, neutral, width, height)
      state.normalSig = 'neutral'
    }

    const points = []
    if (modeStr === 'fog') {
      if (Array.isArray(options.anchors)) points.push(...options.anchors)
      if (Array.isArray(options.strokes)) points.push(...options.strokes)
      const count = Math.min(MAX_SPATIAL_POINTS, points.length)
      if (count > 0) {
        const ptData = new Float32Array(count * 8)
        for (let i = 0; i < count; i += 1) {
          const pt = points[i]
          if (!pt || !Number.isFinite(Number(pt.x)) || !Number.isFinite(Number(pt.y))) continue
          const base = i * 8
          ptData[base] = Number(pt.x)
          ptData[base + 1] = Number(pt.y)
          ptData[base + 2] = Math.max(0.01, Number(pt.radius) || 0.18)
          ptData[base + 3] = Math.max(0.03, Number(pt.feather) || 0.65)
          ptData[base + 4] = Math.max(0, Number(pt.strength) || 0.8)
          ptData[base + 5] = pt.mode === 'subtract' ? -1 : 1
        }
        device.queue.writeBuffer(pointsBuffer, 0, ptData)
      }
    }

    const scale = Math.max(1, Math.max(width, height) / 384)
    const colorRgb = colorTuple(
      modeStr === 'atmosphere'
        ? (options.color || '#BFD5DC')
        : (options.color || options.fog?.color || '#EDE9DF'),
    )
    const amp = Math.max(0, Number(options.amplitude ?? 18)) * scale
    const vx = amp * (Number(options.shiftX) || 0)
    const vy = amp * (Number(options.shiftY) || 0)
    const shiftMag = Math.hypot(vx, vy)
    const blurMaxRadius = Math.max(0, Number(options.blur ?? 7)) * scale

    const gridW = Math.min(width, 640)
    const gridH = Math.min(height, 640)

    const uData = new Float32Array([
      width, height, rawDepthW, rawDepthH,
      modeIndex, Math.min(MAX_SPATIAL_POINTS, points.length), scale, options.tiltShift === true ? 1 : 0,
      colorRgb[0], colorRgb[1], colorRgb[2], options.blend === 'screen' ? 1 : 0,
      Number(options.density ?? 0.45), Number(options.startDepth ?? (modeStr === 'atmosphere' ? 0.12 : 0.25)),
      Math.max(0.05, Number(options.falloff) || 1.4), Number(options.groundBias ?? 0.45),
      Math.max(0.05, Math.min(0.98, Number(options.horizon) || 0.6)), hasNormal ? 1 : 0,
      Number(options.haze ?? 0.28), Number(options.desaturate ?? 0.35),
      Number(options.contrast ?? 0.88), gridW, gridH, 0,
      Math.max(0, Math.min(1, Number(options.focusX ?? 0.5))),
      Math.max(0, Math.min(1, Number(options.focusY ?? 0.5))),
      Number(options.aperture ?? 0.18),
      blurMaxRadius,
      vx, vy, shiftMag, 0,
    ])
    device.queue.writeBuffer(uniformBuffer, 0, uData)

    const wgX = Math.ceil(width / 8)
    const wgY = Math.ceil(height / 8)
    const encoder = device.createCommandEncoder()

    if (sourceChanged || depthChanged) {
      const pRefine = encoder.beginComputePass()
      pRefine.setPipeline(state.refineDepthPipeline)
      pRefine.setBindGroup(0, bindGroups.bgRefineDepth)
      pRefine.dispatchWorkgroups(wgX, wgY)
      pRefine.end()
    }

    if (modeStr === 'parallax') {
      if (shiftMag < 0.05) {
        encoder.copyTextureToTexture({ texture: textures.texSource }, { texture: textures.texOutput }, [width, height, 1])
      } else {
        const pairSig = `${sourceSig}|${depthSig}`
        if (state.bgInpaintedSig !== pairSig) {
          const pCrisp = encoder.beginComputePass()
          pCrisp.setPipeline(state.crispDepthPipeline)
          pCrisp.setBindGroup(0, bindGroups.bgCrispDepth)
          pCrisp.dispatchWorkgroups(wgX, wgY)
          pCrisp.end()

          const pCrisp2 = encoder.beginComputePass()
          pCrisp2.setPipeline(state.crispDepthPipeline)
          pCrisp2.setBindGroup(0, bindGroups.bgCrispDepthP2)
          pCrisp2.dispatchWorkgroups(wgX, wgY)
          pCrisp2.end()

          const [w0, h0] = state.halfDims
          const hx = Math.ceil(w0 / 8)
          const hy = Math.ceil(h0 / 8)
          const pMask = encoder.beginComputePass()
          pMask.setPipeline(state.bgMaskPipeline)
          pMask.setBindGroup(0, bindGroups.bgMask)
          pMask.dispatchWorkgroups(hx, hy)
          pMask.end()

          for (let pass = 0; pass < bindGroups.bgFloodPasses.length; pass += 1) {
            const pFlood = encoder.beginComputePass()
            pFlood.setPipeline(state.bgFloodPipeline)
            pFlood.setBindGroup(0, bindGroups.bgFloodPasses[pass])
            pFlood.dispatchWorkgroups(hx, hy)
            pFlood.end()
          }
          const pFallback = encoder.beginComputePass()
          pFallback.setPipeline(state.bgFallbackPipeline)
          pFallback.setBindGroup(0, bindGroups.bgFallbackBA)
          pFallback.dispatchWorkgroups(hx, hy)
          pFallback.end()
          state.bgInpaintedSig = pairSig
        }

        const pMpi = encoder.beginComputePass()
        pMpi.setPipeline(state.parallaxMpiPipeline)
        pMpi.setBindGroup(0, bindGroups.bgParallaxMpi)
        pMpi.dispatchWorkgroups(wgX, wgY)
        pMpi.end()
      }
    } else if (modeStr === 'dof') {
      const pCoc = encoder.beginComputePass()
      pCoc.setPipeline(state.dofCocPipeline)
      pCoc.setBindGroup(0, bindGroups.bgDofCoc)
      pCoc.dispatchWorkgroups(wgX, wgY)
      pCoc.end()

      const pBokeh = encoder.beginComputePass()
      pBokeh.setPipeline(state.dofBokehPipeline)
      pBokeh.setBindGroup(0, bindGroups.bgDofBokeh)
      pBokeh.dispatchWorkgroups(wgX, wgY)
      pBokeh.end()

      const pComp = encoder.beginComputePass()
      pComp.setPipeline(state.dofCompositePipeline)
      pComp.setBindGroup(0, bindGroups.bgDofComposite)
      pComp.dispatchWorkgroups(wgX, wgY)
      pComp.end()
    } else {
      const pFog = encoder.beginComputePass()
      pFog.setPipeline(state.fogAtmosPipeline)
      pFog.setBindGroup(0, bindGroups.bgFogAtmos)
      pFog.dispatchWorkgroups(wgX, wgY)
      pFog.end()
    }

    if (options.readPixels) {
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256
      const readBuffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      encoder.copyTextureToBuffer(
        { texture: textures.texOutput },
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
      return { canvas, pixels: { width, height, data: out } }
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
    const { viewCanvas } = state
    if (viewCanvas.width !== width || viewCanvas.height !== height) {
      viewCanvas.width = width
      viewCanvas.height = height
    }
    const vctx = viewCanvas.getContext('2d')
    if (vctx) {
      vctx.clearRect(0, 0, width, height)
      vctx.drawImage(canvas, 0, 0)
      return { canvas: viewCanvas, pixels: null }
    }
    return { canvas, pixels: null }
  } catch {
    resetGpuState()
    return null
  }
}
