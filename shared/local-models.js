/**
 * 本机端侧模型与内置算子统一注册表（单源真相：Host / Web Client 共用）。
 *
 * 设计约束：
 *  - 本文件只允许纯数据与纯函数（不得 import `node:*`），以便浏览器端与 Node Host 共用；
 *  - 所有随包不携带、按需下载到本机的 ONNX 模型均在这里登记唯一 id / 下载地址 / 字节数 /
 *    SHA-256 / 首选执行后端（preferredEps）/ 协议标签与预处理规格；
 *  - `BUILTIN_LOCAL_ENGINES` 记录随包内置（无需下载）或规划中的本机能力，供设置页统一展示；
 *  - `server/local-models.js` 依此做统一下载、校验、开关、缓存目录管理与进度回报；
 *  - 客户端（`web/logic/localInference.js`）依此走统一的 Inference Web Worker 执行推理。
 */

/** @typedef {'vision' | 'cutout'} LocalModelTask */

export const LOCAL_MODELS = Object.freeze([
  Object.freeze({
    id: 'mobileclip-s0-fp16',
    task: 'vision',
    label: 'MobileCLIP-S0',
    grade: '视觉感知 (L2)',
    runtime: 'wasm',
    preferredEps: Object.freeze(['wasm']),
    repo: 'Xenova/mobileclip_s0',
    revision: '757d59c9c6870a76a4b0306f05f5061bca15c39f',
    asset: 'onnx/vision_model_fp16.onnx',
    url: 'https://huggingface.co/Xenova/mobileclip_s0/resolve/757d59c9c6870a76a4b0306f05f5061bca15c39f/onnx/vision_model_fp16.onnx',
    sha256: '22b1d36ecc6837e8205aee05003440a25e1c1ee0c7e2945dbb9dd597211c59dc',
    bytes: 22_876_479,
    file: 'mobileclip-s0/vision_model_fp16.onnx',
    legacyWorkspaceSubpath: 'mobileclip-s0/vision_model_fp16.onnx',
    envPathKey: 'AIGC_STUDIO_WORKSHOP_VISION_MODEL',
    envDisableKey: 'AIGC_STUDIO_WORKSHOP_VISION',
    optional: true,
    license: Object.freeze({
      name: 'Apple ML-MobileCLIP License',
      kind: 'other',
      commercial: 'unverified',
    }),
    input: Object.freeze({
      width: 256,
      height: 256,
      inputName: 'pixel_values',
      outputName: 'image_embeds',
    }),
  }),
  Object.freeze({
    id: 'rmbg-1.4-fp16',
    task: 'cutout',
    label: 'RMBG-1.4 (FP16 · 本机 GPU)',
    grade: '本机 WebGPU',
    runtime: 'webgpu',
    preferredEps: Object.freeze(['webgpu', 'wasm']),
    repo: 'briaai/RMBG-1.4',
    revision: 'da1d078376e6691105a5530a374a010627fc60b5',
    asset: 'onnx/model_fp16.onnx',
    url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/da1d078376e6691105a5530a374a010627fc60b5/onnx/model_fp16.onnx',
    sha256: '9fdfdb41866d872e0acf4a010c35c1a8547bf0eebe0d1544406bbf1c824cb59d',
    bytes: 88_217_533,
    file: 'rmbg-1.4/model_fp16.onnx',
    envPathKey: 'AIGC_STUDIO_LOCAL_CUTOUT_FP16_MODEL',
    optional: true,
    license: Object.freeze({
      name: 'BRIA RMBG-1.4',
      kind: 'non-commercial',
      commercial: false,
    }),
    input: Object.freeze({
      width: 1024,
      height: 1024,
      mean: Object.freeze([0.5, 0.5, 0.5]),
      std: Object.freeze([1, 1, 1]),
      inputName: 'input',
      outputName: 'output',
    }),
  }),
  Object.freeze({
    id: 'rmbg-1.4-q8',
    task: 'cutout',
    label: 'RMBG-1.4 (INT8 · 本机 CPU)',
    grade: '本机 CPU 兼容',
    runtime: 'wasm',
    preferredEps: Object.freeze(['wasm']),
    repo: 'briaai/RMBG-1.4',
    revision: 'da1d078376e6691105a5530a374a010627fc60b5',
    asset: 'onnx/model_quantized.onnx',
    url: 'https://huggingface.co/briaai/RMBG-1.4/resolve/da1d078376e6691105a5530a374a010627fc60b5/onnx/model_quantized.onnx',
    sha256: 'a6648479275dfd0ede0f3a8abc20aa5c437b394681b05e5af6d268250aaf40f3',
    bytes: 44_403_226,
    file: 'rmbg-1.4/model_quantized.onnx',
    envPathKey: 'AIGC_STUDIO_LOCAL_CUTOUT_Q8_MODEL',
    optional: true,
    license: Object.freeze({
      name: 'BRIA RMBG-1.4',
      kind: 'non-commercial',
      commercial: false,
    }),
    input: Object.freeze({
      width: 1024,
      height: 1024,
      mean: Object.freeze([0.5, 0.5, 0.5]),
      std: Object.freeze([1, 1, 1]),
      inputName: 'input',
      outputName: 'output',
    }),
  }),
])

/** 随包内置（零下载）及规划中的本机推理引擎，供设置页统一查阅。 */
export const BUILTIN_LOCAL_ENGINES = Object.freeze([
  Object.freeze({
    id: 'vtracer-wasm',
    task: 'vectorize',
    status: 'builtin',
    packageName: '@visioncortex/vtracer',
    runtime: 'node-wasm',
  }),
  Object.freeze({
    id: 'canvas-deterministic',
    task: 'image-ops',
    status: 'builtin',
    packageName: 'Web Canvas / Oklab',
    runtime: 'browser',
  }),
  Object.freeze({
    id: 'sd-cpp-vulkan',
    task: 'generate',
    status: 'planned',
    packageName: 'stable-diffusion.cpp (GGUF)',
    runtime: 'vulkan',
  }),
])

const BY_ID = new Map(LOCAL_MODELS.map((item) => [item.id, item]))

/** 按 id 查找本机模型元信息；未登记返回 null。 */
export function localModelById(id) {
  if (typeof id !== 'string' || !id.trim()) return null
  return BY_ID.get(id.trim()) ?? null
}

/** 列出指定任务类型下的全部本机模型（例如 `'vision'` / `'cutout'`）。 */
export function localModelsForTask(task) {
  return LOCAL_MODELS.filter((item) => item.task === task)
}
