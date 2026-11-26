/**
 * 本机 GPU 推理引擎与绘画权重的单源资产表。
 *
 * 这里只放纯数据，Host、Web Client 与离线测试共用：
 *  - 引擎包与模型权重都按 SHA-256 固定版本，下载后必须逐字节校验；
 *  - 每个 presetId 独立声明文件、体积、最低显存与采样参数；
 *  - 没有可靠 GGUF 转换文件的模型显式标记 `available: false`，不伪造下载地址。
 */

export const LOCAL_GPU_PRESET = 'realvisxl-lightning'
export const LOCAL_GPU_ENGINE_MARKER = 'engine.sha256'

const RELEASE_TAG = 'master-1133-52491bd'
const RELEASE_BASE = `https://github.com/leejet/stable-diffusion.cpp/releases/download/${RELEASE_TAG}`

/**
 * 引擎包。Vulkan 随安装包内置；CUDA 仅在检测到 NVIDIA 独显、用户启用本机引擎时按需准备。
 * `archives` 按顺序解压；CUDA 的 cudart 包提供运行期 DLL。
 */
export const LOCAL_GPU_ENGINE = Object.freeze({
  id: 'vulkan',
  label: 'Vulkan',
  file: 'sd-master-52491bd-bin-win-vulkan-x64.zip',
  url: `${RELEASE_BASE}/sd-master-52491bd-bin-win-vulkan-x64.zip`,
  bytes: 31_077_895,
  sha256: '976ed26dfc06c16b720fdf272d6445cdd7fe42056f2b1f53e4359e25d5a1d1f1',
  archives: Object.freeze([
    Object.freeze({
      file: 'sd-master-52491bd-bin-win-vulkan-x64.zip',
      url: `${RELEASE_BASE}/sd-master-52491bd-bin-win-vulkan-x64.zip`,
      bytes: 31_077_895,
      sha256: '976ed26dfc06c16b720fdf272d6445cdd7fe42056f2b1f53e4359e25d5a1d1f1',
    }),
  ]),
})

export const LOCAL_GPU_CUDA_ENGINE = Object.freeze({
  id: 'cuda',
  label: 'CUDA',
  file: 'sd-master-52491bd-bin-win-cuda12-x64.zip',
  url: `${RELEASE_BASE}/sd-master-52491bd-bin-win-cuda12-x64.zip`,
  bytes: 976_650_737,
  sha256: '328d385394e571a6dd3d4e85d3097f9ccad372511f761f3beced83d69fd0a7cd',
  archives: Object.freeze([
    Object.freeze({
      file: 'sd-master-52491bd-bin-win-cuda12-x64.zip',
      url: `${RELEASE_BASE}/sd-master-52491bd-bin-win-cuda12-x64.zip`,
      bytes: 413_198_691,
      sha256: '328d385394e571a6dd3d4e85d3097f9ccad372511f761f3beced83d69fd0a7cd',
    }),
    Object.freeze({
      file: 'cudart-sd-bin-win-cu12-x64.zip',
      url: `${RELEASE_BASE}/cudart-sd-bin-win-cu12-x64.zip`,
      bytes: 563_452_046,
      sha256: 'fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d',
    }),
  ]),
})

export const LOCAL_GPU_ENGINES = Object.freeze({
  vulkan: LOCAL_GPU_ENGINE,
  cuda: LOCAL_GPU_CUDA_ENGINE,
})

function asset(id, label, files, extra = {}) {
  return Object.freeze({
    id,
    label,
    available: true,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    ...extra,
  })
}

const REALVIS_REVISION = '91480522810fb0f920f7de5eab984b4eb8569dcf'
const FLUX_REVISION = '3b1f5a9dc3abb32238b053aeb3d823c30afdacbd'
const FLUX2_BASE_REVISION = 'e7b7dc27f91deacad38e78976d1f2b499d76a294'
const QWEN3_4B_REVISION = '22c9fc8a8c7700b76a1789366280a6a5a1ad1120'
const Z_IMAGE_REVISION = 'c61c0e422dc8b541b7548cf33a4ef8302b0f8085'
const Z_IMAGE_BASE_REVISION = 'f332072aa78be7aecdf3ee76d5c247082da564a6'
const QWEN3_4B_INSTRUCT_REVISION = 'a06e946bb6b655725eafa393f4a9745d460374c9'

/**
 * 按 presetId 索引的本机绘画模型资产。
 *
 * `files[].key` 对应 local-gpu.json 的 modelPath / vaePath / llmPath；
 * 额外文本编码器与独立 VAE 走同一套文件表，setup 会按 key 保存映射。
 */
export const LOCAL_GPU_MODEL_ASSETS = Object.freeze({
  'realvisxl-lightning': asset(
    'realvisxl-lightning',
    'RealVisXL V5 Lightning',
    [
      {
        key: 'modelPath',
        file: 'realvisxl-v5.0-lightning-Q4_K.gguf',
        url: `https://huggingface.co/off-grid-ai/realvisxl-v5.0-lightning-GGUF/resolve/${REALVIS_REVISION}/realvisxl-v5.0-lightning-Q4_K.gguf`,
        bytes: 2_797_755_008,
        sha256: '2c821ab5b61c572b7085d7951e5247a05688e5f77c64d84724073235cb90875e',
      },
      {
        key: 'vaePath',
        file: 'sdxl-vae-fp16-fix.safetensors',
        url: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/207b116dae70ace3637169f1ddd2434b91b3a8cd/sdxl_vae.safetensors',
        bytes: 334_641_162,
        sha256: '235745af8d86bf4a4c1b5b4f529868b37019a10f7c0b2e79ad0abca3a22bc6e1',
      },
    ],
    {
      minVramMb: 3100,
      loader: 'sdxl',
      splitDiffusion: false,
      sampling: Object.freeze({ sampleMethod: 'euler_a', scheduler: 'discrete' }),
    },
  ),
  'flux2-klein-4b': asset(
    'flux2-klein-4b',
    'FLUX.2 Klein 4B',
    [
      {
        key: 'modelPath',
        file: 'flux-2-klein-4b-Q4_0.gguf',
        url: `https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF/resolve/${FLUX_REVISION}/flux-2-klein-4b-Q4_0.gguf`,
        bytes: 2_460_378_560,
        sha256: 'd1023499ef3f2f82ff7c50e6778495195c1b6cc34835741778868428111f9ff4',
      },
      {
        key: 'vaePath',
        file: 'flux2-vae.safetensors',
        url: `https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/${FLUX2_BASE_REVISION}/vae/diffusion_pytorch_model.safetensors`,
        bytes: 168_120_878,
        sha256: 'ca70d2202afe6415bdbcb8793ba8cd99fd159cfe6192381504d6c4d3036e0f04',
      },
      {
        key: 'llmPath',
        file: 'Qwen3-4B-Q4_K_M.gguf',
        url: `https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/${QWEN3_4B_REVISION}/Qwen3-4B-Q4_K_M.gguf`,
        bytes: 2_497_281_312,
        sha256: 'f6f851777709861056efcdad3af01da38b31223a3ba26e61a4f8bf3a2195813a',
      },
    ],
    {
      minVramMb: 5400,
      loader: 'flux2',
      splitDiffusion: true,
      sampling: Object.freeze({ sampleMethod: 'euler', scheduler: 'flux2' }),
    },
  ),
  'z-image-turbo': asset(
    'z-image-turbo',
    'Z-Image Turbo',
    [
      {
        key: 'modelPath',
        file: 'z_image_turbo-Q4_K.gguf',
        url: `https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/${Z_IMAGE_REVISION}/z_image_turbo-Q4_K.gguf`,
        bytes: 3_864_250_304,
        sha256: '14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd',
      },
      {
        key: 'vaePath',
        file: 'z-image-ae.safetensors',
        url: `https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/resolve/${Z_IMAGE_BASE_REVISION}/vae/diffusion_pytorch_model.safetensors`,
        bytes: 167_666_902,
        sha256: 'f5b59a26851551b67ae1fe58d32e76486e1e812def4696a4bea97f16604d40a3',
      },
      {
        key: 'llmPath',
        file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
        url: `https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/${QWEN3_4B_INSTRUCT_REVISION}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf`,
        bytes: 2_497_281_120,
        sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
      },
    ],
    {
      minVramMb: 7400,
      loader: 'z-image',
      splitDiffusion: true,
      sampling: Object.freeze({ sampleMethod: 'euler' }),
    },
  ),
  'sana-sprint-1.6b': Object.freeze({
    id: 'sana-sprint-1.6b',
    label: 'SANA-Sprint 1.6B',
    available: false,
    files: Object.freeze([]),
    bytes: 0,
    minVramMb: 5200,
    reason: '当前官方转换仓库只提供 SANA-Sprint 0.6B 的 GGUF，1.6B 暂无可校验的本机权重。',
  }),
})

/** 兼容旧调用：默认模型（RealVisXL）的权重文件表。 */
export const LOCAL_GPU_WEIGHTS = LOCAL_GPU_MODEL_ASSETS[LOCAL_GPU_PRESET].files

export function localGpuAssetOf(presetId) {
  const id = typeof presetId === 'string' ? presetId.trim() : ''
  return id ? LOCAL_GPU_MODEL_ASSETS[id] ?? null : null
}

export function localGpuAssetBytesOf(presetId) {
  return localGpuAssetOf(presetId)?.bytes ?? 0
}

export function localGpuEngineOf(backend = 'vulkan') {
  return LOCAL_GPU_ENGINES[backend === 'cuda' ? 'cuda' : 'vulkan']
}
