# AIGC Studio 宣传短片自动化管线

基于 **Playwright（自动驱动预览录屏）+ Remotion（React 代码化剪辑、镜头聚焦缩放与中文包装）** 的可复现产品短片流水线。

## 目录结构

- `record.mjs`：启动 `tools/preview.mjs`（`?clean=1` 无浮窗模式），自动驱动界面点击并导出干净 MP4 素材到 `public/clips/`，同时将 `docs/assets/showcase/` 同步到 `public/showcase/`。
- `src/PromoZh.tsx`：主宣传片时间轴（5 个章节：开场定位 → 模型与作品切换 → AI 助手提案卡 → 资产工坊 → 开源收尾）。
- `src/components/StudioFrame.tsx`：桌面窗口包装组件，支持入场透视动效与局部镜头缩放（`zoomKeyframes`）。
- `out/aigc-studio-promo-zh.mp4`：渲染产出的 1080p 30fps 成片。

## 常用命令

```powershell
# 1. 自动录制界面操作素材（会临时占用 5188 端口）
npm run record

# 2. 启动 Remotion Studio 实时预览与调整时间轴
npm run studio

# 3. 渲染导出最终 MP4 成片
npm run render

# 一键重新录制并重新渲染（UI 改版后直接跑这一条即可刷新视频）
npm run build:promo
```
