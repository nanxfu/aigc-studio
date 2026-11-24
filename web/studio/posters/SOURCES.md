# 模型预览海报来源与处理说明

本目录现存 10 张 `<model-id>.webp` 供 `ModelCardPicker` 使用，覆盖现役 7 款本地模型及商业生图 API 家族（Kolors、FLUX.1、OpenAI GPT Image / DALL·E 3；云端 Qwen-Image 复用 `qwen-image-2.1.webp`）。构建期均小于 Vite `assetsInlineLimit: 4096`，以 data URL 内联进客户端包。

2026-11-24 起，7 款现役本地模型海报已全部替换为 `tools/bench-9dim.mjs` 在 Kaggle 2×T4 与 Colab L4 上生成的**真机实测成图**（与 `web/public/model-samples/` 同源）；商业 API 概念图由内部工具按无文字风格生成。

## 处理方式

1. 由 `tools/build-model-samples.mjs` 自动中心裁切为 1:1 正方形，缩放到 **112×112**（`Image.Resampling.LANCZOS`）；
2. 保存为 WebP：**quality=70、method=6**（单张上限 ≤3900 B，无透明通道、无文字叠加）。

## 对应关系

| 模型 ID / 家族 | 文件 | 字节 | 来源 | 算力 |
| :--- | :--- | ---: | :--- | :--- |
| `sdxl-lightning` | `sdxl-lightning.webp` | 1900 | `bench-results/9dim/sdxl-lightning/09-scifi-scale.png` | Kaggle 2×T4 实测 |
| `sana-sprint-1.6b` | `sana-sprint-1.6b.webp` | 2416 | `bench-results/9dim/sana-sprint-1.6b/08-isometric-diorama.png` | Kaggle 2×T4 实测 |
| `z-image-turbo` | `z-image-turbo.webp` | 1896 | `bench-results/9dim/z-image-turbo/02-photoreal-portrait.png` | Colab L4 实测 |
| `qwen-image-2.1` / 云端 `Qwen-Image` | `qwen-image-2.1.webp` | 1572 | `bench-results/9dim/qwen-image-2.1/01-typography-poster.png` | Colab L4 实测 |
| `flux2-klein-4b` | `flux2-klein-4b.webp` | 2346 | `bench-results/9dim/flux2-klein-4b/05-material-refraction.png` | Kaggle 2×T4 实测 |
| `flux2-klein-9b` | `flux2-klein-9b.webp` | 1980 | `bench-results/9dim/flux2-klein-9b/07-surreal-fusion.png` | Colab L4 实测 |
| `anima-turbo-v1.1` | `anima-turbo-v1.1.webp` | 3774 | `bench-results/9dim/anima-turbo-v1.1/04-anime-action.png` | Kaggle 2×T4 实测 |
| 云端 `Kolors` | `kolors.webp` | 1648 | 概念图（金色剪影光晕） | 项目内自生成 |
| 云端 `FLUX.1`（schnell / dev） | `flux1.webp` | 3268 | 概念图（粗犷建筑光束） | 项目内自生成 |
| 云端 `OpenAI`（GPT Image 1 / DALL·E 3） | `openai.webp` | 902 | 概念图（几何玻璃静物） | 项目内自生成 |
