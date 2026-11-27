import type { APIRoute } from 'astro';
import { GUIDES_EN, SITE_EN } from '../../data/site';

export const GET: APIRoute = () => {
  const guideLines = GUIDES_EN.map((g) => `- [${g.title}](${SITE_EN.domain}${g.path}): ${g.description}`).join('\n');

  const body = `# AIGC Studio

> An independent open-source desktop AI image generation & asset workbench (MIT License; Windows x64 installer & portable validated, macOS & Linux supported from source via Node 20+).
> Key architecture: The local desktop UI is decoupled from cloud GPU inference—no dedicated high-VRAM GPU, Python, CUDA, or ComfyUI node setup required. Connects by default to Kaggle's free 30 hrs/week dual-T4 quota (30GB VRAM), while keeping every image, meta.json, and version tree on your local drive.

## Who It Is For
- Creators on ultrabooks or Macs without high-VRAM discrete GPUs who want to run FLUX.2, Qwen-Image, SDXL, and other open-source models.
- Users who prefer not to maintain ComfyUI node graphs and Python environments, yet want local file ownership instead of cloud subscriptions.
- Indie game developers and graphic designers needing built-in post-processing: background cutout (alpha PNG), offline WASM image-to-SVG, pixel grid snapping, sprite sheet slicing (atlas.json), seamless tiling, and 4-channel PBR material decomposition.
- Developers using Claude Desktop or Cursor who want a standard local MCP Server sharing the same session, queue, and outputs directory.

## Supported Compute Backends
- **Kaggle GPU (Default, $0)**: 2×Nvidia Tesla T4 (30GB VRAM), 30 free hours/week; includes auto idle shutdown and tray protection.
- **Google Colab**: Free T4 and Colab Pro L4 / A100 for Z-Image Turbo, Qwen-Image 2.1, and FLUX.2 Klein 9B.
- **Private Remote Worker**: Deploy on RunPod, Vast.ai, or your own Linux GPU server.
- **Commercial Cloud APIs**: Connect image and video APIs on demand (fal.ai, SiliconFlow, and OpenAI-compatible endpoints).

## 7 Built-In Open-Source Models (Measured)
- **FLUX.2 Klein 4B** (3.88B / 4 steps / ~10.2s / 7.9 GB / Apache-2.0 Commercial): Native bilingual prompts & reference images, commercial finish.
- **SDXL Lightning** (3.5B + LoRA / 4 steps / ~6.2s / 10.3 GB / OpenRAIL++ Commercial): Default workhorse with full inpainting and img2img support.
- **SANA-Sprint 1.6B** (1.6B / 2 steps / ~4.1s / 10.3 GB / Apache-2.0 Commercial): ~4s 1024px output for rapid layout exploration.
- **Z-Image Turbo** (6B S3-DiT / 9 steps / ~30.7s / 12.2 GB / Apache-2.0 Commercial): Photorealism, signage & inpainting (Colab / Private GPU).
- **Qwen-Image 2.1** (7B DiT / 8 steps / ~43.7s / 16.8 GB / Qwen Research Non-Commercial): Accurate EN/ZH typography & posters (Colab / Private GPU).
- **Anima Turbo v1.1** (2B DiT / 10 steps / ~21.6s / 8.5 GB / Non-Commercial): Dedicated anime DiT supporting natural language and Danbooru tags.
- **FLUX.2 Klein 9B** (9.08B / 4 steps / ~130.9s / 18.1 GB / FLUX Non-Commercial): Complex material fidelity & reference editing (Colab / Private GPU).

## Built-In Asset Workshop (6 Post-Processing Tools)
- **Vectorize to SVG** (Local · 0 VRAM · @visioncortex/vtracer WASM): Editable \`.svg\`.
- **Pixel Snap** (Local · 0 VRAM): Edge-period grid detection + Oklab palette quantization + hard alpha.
- **Sprite Slicer** (Local · 0 VRAM): Grid overlay + live animation playback + Spritesheet + \`atlas.json\`.
- **Seamless Tile** (Local · 0 VRAM): Seam detection + cosine edge blending + 2×2 live check.
- **Remove Background** (Cloud GPU · BiRefNet MIT / RMBG-2.0 Non-Commercial): Transparent PNG.
- **PBR Material Split** (Cloud GPU · Marigold / Ubisoft CHORD): Albedo / Normal / Roughness / Metallic maps.

## MCP Server (7 Standard Tools)
- For Claude Desktop / Cursor: auto-discovers the running desktop app via \`runtime.json\` (loopback only) and shares the active session & \`outputs/\` folder.
- Tools: \`imagen_generate\`, \`imagen_batch\`, \`imagen_upscale\`, \`imagen_history\`, \`imagen_cancel\`, \`imagen_session\`, \`imagen_recipes\`.

## Core Pages (English)
- [Home (Overview, Benchmarks, Comparison & FAQ)](${SITE_EN.domain}/en/)
- [7 Built-In Models Benchmarked](${SITE_EN.domain}/en/models)
- [AI Image GPU Ladder & Compatibility Check](${SITE_EN.domain}/en/hardware)
- [Asset Workshop: Cutout, SVG, Pixel Snap & PBR](${SITE_EN.domain}/en/workshop)
- [All Guides & Comparisons](${SITE_EN.domain}/en/guides)

## Guides
${guideLines}

## Open Source & Downloads
- GitHub Repository: ${SITE_EN.github}
- Latest Installer: ${SITE_EN.latestRelease}
- License: ${SITE_EN.license} License
- Platforms: Windows x64 installer & portable (macOS / Linux via Node 20+ source)
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
