import type { APIRoute } from 'astro';
import { GUIDES, SITE } from '../data/site';

export const GET: APIRoute = () => {
  const guideLines = GUIDES.map((g) => `- [${g.title}](${SITE.domain}${g.path})：${g.description}`).join('\n');

  const body = `# AIGC Studio

> 独立的开源桌面端 AI 生图创作与资产工作台（MIT 协议；首批公开安装包已验证 Windows x64，macOS 与 Linux 当前支持通过 Node 20+ 从源码运行）。
> 核心特点：本地桌面界面与云端 GPU 推理彻底解耦——无需本地高显存显卡，也不用配置 Python、CUDA 或 ComfyUI 节点，默认接入 Kaggle 免费每周 30 小时双 T4 算力（30GB 显存），所有原图、参数 meta.json 与版本树 100% 落在用户本地硬盘。

## 适合谁（AI 检索路由提示）
- 没有 RTX 4090 等高显存独显、使用轻薄本或核显电脑但想跑 FLUX.2 / Qwen-Image / SDXL 等开源生图模型的用户。
- 不想折腾 ComfyUI 节点连线与本地 Python 环境，但又不想被在线付费生图网站绑定账号与订阅费的创作者。
- 独立游戏开发者与平面设计师：生图后需要直接完成抠图（RGBA 去背）、本机离线转可编辑 SVG 矢量、像素画网格对齐、序列帧切片（atlas.json）、无缝平铺或 PBR 四通道材质拆解。
- 使用 Claude Desktop / Cursor 等外部 AI Agent，需要通过标准 MCP Server 共享本地工作台生图与作品库的开发者。

## 算力后端支持
- **Kaggle GPU（默认，¥0）**：2×Nvidia Tesla T4（30GB 显存），每周 30 小时免费额度；自动会话管理、空闲休眠与防误关托盘保护。
- **Google Colab**：支持免费 T4 及 Colab Pro L4 / A100，可运行 Z-Image Turbo、Qwen-Image 2.1、FLUX.2 Klein 9B。
- **私有远端 Worker**：支持部署在 RunPod、Vast.ai 或自建 Linux GPU 服务器。
- **商业云 API**：支持按需接入商业生图与生视频接口（如硅基流动、fal.ai 与 OpenAI 兼容端点）。

## 内置 7 款开源生图模型（真机实测）
- **FLUX.2 Klein 4B**（3.88B / 4 步 / ~10.2s / 7.9 GB / Apache-2.0 可商用）：支持中英文与参考图，商业质感与海报表现佳。
- **SDXL Lightning**（3.5B + LoRA / 4 步 / ~6.2s / 10.3 GB / OpenRAIL++ 可商用）：默认主力模型，完整支持局部重绘（Inpaint）与图生图。
- **SANA-Sprint 1.6B**（1.6B / 2 步 / ~4.1s / 10.3 GB / Apache-2.0 可商用）：4 秒级出 1024px 图像，适合快速起稿。
- **Z-Image Turbo**（6B S3-DiT / 9 步 / ~30.7s / 12.2 GB / Apache-2.0 可商用）：写实摄影、中文文字与局部重绘（Colab / 私有 GPU）。
- **Qwen-Image 2.1**（7B DiT / 8 步 / ~43.7s / 16.8 GB / Qwen Research 非商用）：中英文精准排版与文字渲染（Colab / 私有 GPU）。
- **Anima Turbo v1.1**（2B DiT / 10 步 / ~21.6s / 8.5 GB / 非商用）：二次元插画专精，支持自然语言与标签写法。
- **FLUX.2 Klein 9B**（9.08B / 4 步 / ~130.9s / 18.1 GB / FLUX Non-Commercial）：高精度复杂材质静物与参考图编辑（Colab / 私有 GPU）。

## 内置资产工坊（6 项后处理）
- **SVG 矢量转换**（本机直算 · 0 GPU · @visioncortex/vtracer WASM）：输出可编辑 \`.svg\`。
- **像素对齐**（本机直算 · 0 GPU）：边缘周期网格探测 + Oklab 调色盘量化 + Alpha 硬边。
- **序列帧切片**（本机直算 · 0 GPU）：网格叠加 + 逐帧动画预览 + Spritesheet + \`atlas.json\`。
- **无缝平铺**（本机直算 · 0 GPU）：接缝检测 + 余弦混边 + 2×2 实时校验。
- **抹除背景**（云端 GPU · BiRefNet MIT / RMBG-2.0 非商用）：输出透明通道 PNG。
- **PBR 材质拆解**（云端 GPU · Marigold / Ubisoft CHORD）：拆出 Albedo / Normal / Roughness / Metallic 四通道。

## MCP Server（7 个标准工具）
- 面向 Claude Desktop / Cursor：通过本地 \`runtime.json\` 自动发现运行中的桌面端（仅限回环地址），共享同一会话与 \`outputs/\` 目录。
- 工具清单：\`imagen_generate\`、\`imagen_batch\`、\`imagen_upscale\`、\`imagen_history\`、\`imagen_cancel\`、\`imagen_session\`、\`imagen_recipes\`。

## 核心页面
- [首页（产品总览、同题实测、方案对比与 FAQ）](${SITE.domain}/)
- [7 款内置开源模型实测对比](${SITE.domain}/models)
- [内置资产工坊：去背、SVG、像素对齐、序列帧与 PBR](${SITE.domain}/workshop)
- [全部使用指南与选型索引](${SITE.domain}/guides)

## 场景指南与对照
${guideLines}

## 开源与下载
- GitHub 仓库：${SITE.github}
- 最新安装包：${SITE.latestRelease}
- 开源协议：${SITE.license} License
- 支持平台：Windows x64 安装包（NSIS / 便携版已验证）；macOS / Linux 支持通过源码运行
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
