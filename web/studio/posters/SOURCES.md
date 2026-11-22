# 模型预览海报来源与处理说明

本目录现存 10 张 `<model-id>.webp` 供 `ModelCardPicker` 使用，覆盖现役 7 款本地模型及 M3.5 商业生图 API 家族（Kolors、FLUX.1、OpenAI GPT Image / DALL·E 3；云端 Qwen-Image 复用 `qwen-image-2.1.webp`）。构建期均小于 Vite `assetsInlineLimit: 4096`，以 data URL 内联进客户端包。

本地原型图来自 [Pexels](https://www.pexels.com/)（按 [Pexels License](https://www.pexels.com/license/) 免费使用）及仓内实测成图（`flux2-klein-9b-clockmaker-bench.webp`）；商业 API 概念图由内部工具按无文字风格生成。

## 处理方式

1. 统一中心裁切为 1:1 正方形，缩放到 **112×112**（`Image.Resampling.LANCZOS`）；
2. 保存为 WebP：**quality=70、method=6**（单张均小于 4KB，无透明通道、无文字叠加）。

预算实测：10 张 raw 合计 **21730 B**（原 6 张 13088 B + 本轮新增 4 张 8642 B），单张 898~3268 B，均小于 Vite `assetsInlineLimit: 4096` 内联阈值。

## 对应关系

| 模型 ID / 家族 | 文件 | 字节 | 来源 | 许可 |
| :--- | :--- | ---: | :--- | :--- |
| `sdxl-lightning` | `sdxl-lightning.webp` | 898 | Pexels #29068570 (Barna Morvai) | Pexels License |
| `sana-sprint-1.6b` | `sana-sprint-1.6b.webp` | 2614 | Pexels #34480659 (Eren Arıcı) | Pexels License |
| `z-image-turbo` | `z-image-turbo.webp` | 2556 | Pexels #34779917 (Jenny Mavimiro) | Pexels License |
| `qwen-image-2.1` / 云端 `Qwen-Image` | `qwen-image-2.1.webp` | 2740 | Pexels #14832531 (Alina Skazka) | Pexels License |
| `flux2-klein-4b` | `flux2-klein-4b.webp` | 2634 | Pexels #12602053 (Merlin Lightpainting) | Pexels License |
| `flux2-klein-9b` | `flux2-klein-9b.webp` | 2824 | `docs/assets/showcase/flux2-klein-9b-clockmaker-bench.webp` | 仓内实测成图 |
| `anima-turbo-v1.1` | `anima-turbo-v1.1.webp` | 1646 | Pexels #38293324 (Fenn) | Pexels License |
| 云端 `Kolors` | `kolors.webp` | 1648 | 概念图（金色剪影光晕） | 项目内自生成 |
| 云端 `FLUX.1`（schnell / dev） | `flux1.webp` | 3268 | 概念图（粗犷建筑光束） | 项目内自生成 |
| 云端 `OpenAI`（GPT Image 1 / DALL·E 3） | `openai.webp` | 902 | 概念图（几何玻璃静物） | 项目内自生成 |

## 复用与重命名

- **`anima-turbo-v1.1.webp` 由 `anima-light-lavender.webp` 重命名而来**：只改文件名，未换图、未重新编码，来源与作者不变。旧文件名不再存在，`ModelCardPicker` 的 import 已同步。
- `sdxl-lightning` 与 `flux2-klein-4b` 的来源记录迁移自 `design-demos/assets/SOURCES.md`。

## 选图说明（本轮新增 3 张）

- **`sana-sprint-1.6b`**：夜间高速公路的车辆光轨（Eren Arıcı）。画面由高对比度的流动光束构成，112px 与 56px 缩略下仍能读出「光轨/速度」，对应「2 步极速、轻量灵感探索」的定位。
- **`z-image-turbo`**：香港楼宇外墙的橙红霓虹店招（Jenny Mavimiro）。写实夜景加发光汉字招牌，缩略下可直接读出「摄影 + 文字」，对应「8 步写实摄影、中英双语文字」。
- **`qwen-image-2.1`**：整面由重复排印 `TERRAZA` 组成的绿色招牌（Alina Skazka）。字形重复排列构成主体，缩略下直接读出「排版」，对应「强排版/多图编辑」。
- **`anima-turbo-v1.1`**：沿用原二次元角色手办特写（Fenn）。该图是物理手办照片，只作「概念示意」，不是该模型的出图样例。

## 下线清理

阶段十七下线 6 款模型，对应海报已从本目录删除：`sdxl-turbo`、`hyper-sdxl-8step`、`playground-v2.5`、`sdxl-base`、`realvis-v5`、`animagine-xl-3.1`。
删除前已 grep 全仓（`src/`、`tools/`、`test/`、`docs/` 非 archive），这些海报文件路径除 `ModelCardPicker.jsx` 外没有其它引用。

## 来源记录补充

新增 3 张的页面 URL 与作者取自 Pexels 搜索结果的索引元数据：`www.pexels.com` 详情页对自动化访问返回 Cloudflare 403，未逐页打开核验；
直链（`images.pexels.com` CDN）可正常下载（HTTP 200），三张都下载后用 `read_image` 目检确认画面与定位相符。
