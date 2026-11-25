export const LOCAL_GPU_PRESET = 'realvisxl-lightning'
export const LOCAL_GPU_ENGINE_MARKER = 'engine.sha256'

export const LOCAL_GPU_ENGINE = Object.freeze({
  file: 'sd-master-79dc7ca-bin-win-vulkan-x64.zip',
  url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1127-79dc7ca/sd-master-79dc7ca-bin-win-vulkan-x64.zip',
  bytes: 30_956_796,
  sha256: 'cc504eabda2001367ab21d752b27da60a884e7c5c61f84d79e006b5ea4e5dc9f',
})

export const LOCAL_GPU_WEIGHTS = Object.freeze([
  Object.freeze({
    key: 'modelPath',
    file: 'realvisxl-v5.0-lightning-Q4_K.gguf',
    url: 'https://huggingface.co/off-grid-ai/realvisxl-v5.0-lightning-GGUF/resolve/91480522810fb0f920f7de5eab984b4eb8569dcf/realvisxl-v5.0-lightning-Q4_K.gguf',
    bytes: 2_797_755_008,
    sha256: '2c821ab5b61c572b7085d7951e5247a05688e5f77c64d84724073235cb90875e',
  }),
  Object.freeze({
    key: 'vaePath',
    file: 'sdxl-vae-fp16-fix.safetensors',
    url: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/207b116dae70ace3637169f1ddd2434b91b3a8cd/sdxl_vae.safetensors',
    bytes: 334_641_162,
    sha256: '235745af8d86bf4a4c1b5b4f529868b37019a10f7c0b2e79ad0abca3a22bc6e1',
  }),
])
