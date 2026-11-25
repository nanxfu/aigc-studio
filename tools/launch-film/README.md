# AIGC Studio 宣传片：把想法，留在画面里。

自主创作版本，约 59 秒 / 1920×1080 / 30fps / 中文 / 无旁白。

## 看成片

- `out/aigc-studio-launch.mp4`：配乐与拟音。
- `out/aigc-studio-launch-nobgm.mp4`：相同画面，保留拟音，便于另配音乐。
- `out/qa/motion-contact-sheet-final.png`：十段镜头的关键帧联系图。
- `FINAL-REVIEW.md`：终检结论及已知限制。

## 创意与真实性

以产品自己的纸白、墨黑、相纸和创作画布为视觉基础，按三类人群重排成十段：普通生图、游戏资产和技术算力；中间经过助手提案、模型比较、视频入口和本地归档，最后回到品牌。场景 UI 为本片独立绘制，画面以项目公开示例和实测资产为素材，不是产品录屏。

工程独立创建，没有引用 `tools/promo` 的废弃稿。作品来自仓库公开的 `docs/assets/showcase/` 与模型实测图，工坊展示使用仓库中的 RGB 原图、RGBA 抠图和 PBR 通道示例。未发出新的收费生成请求。

生成过程经过剪辑压缩，不能据此判断生成速度。视频段展示 MiniMax H3 的真实首尾帧与参数入口；右侧标为“首帧素材演示”，所示是静态参考素材，不是新生成的视频结果。全片动画由 Remotion 确定性合成。

## 修改和渲染

```powershell
npm ci
npm run studio
npm run check
npm run render
npm run render:clean
```

- `src/timeline.ts` 是镜头、字幕、转场和拟音时间线的唯一来源。
- `src/scenes.tsx` 是十段镜头；`src/visuals.tsx` 是共享视觉组件。字幕轨是唯一的全片解说显示层，场景单独预览仍保留字幕。
- `src/workbench.ts` 把时间线拆成可编辑轨道，镜头开放标题，独立字幕轨开放文案与字号；场景内字幕在整片和拆解导入时隐藏，避免字幕重复。
- `scripts/capture.mjs` 仅用于需要展示真实产品录屏素材时重新采集页面；本版使用独立绘制的宣传 UI。
- `node scripts/stills.mjs` 重出逐镜头关键帧。
- `.venv/Scripts/python.exe scripts/verify-audio.py` 对两个 MP4 做音频轨道差分、SFX/BGM 延迟与峰值检查；使用 numpy / scipy 和 ffmpeg。节拍切点需结合当前音乐编辑手动审听，旧版分析峰值不代表新版切点验证。

最终 MP4、页面纹理、音频和分析结果保存在本目录内，受 `.gitignore` 排除，复制工程时请连同 `public/` 一起保留。

## 动效工作台

本机启动方式：

```powershell
node "C:\Users\79121\.agents\skills\video-shotcraft\workbench\scripts\open.mjs" "D:\document\development\aigc-studio\tools\launch-film"
```

打开 `http://localhost:5198/?import=project`，可改镜头顺序、时长、标题、字幕和音量，再导出 MP4。界面只承诺清单实际开放的属性；片内颜色和镜头运动需改源文件。

## 声音来源

配乐是 Lily J 的 **House Vibez**（Mixkit），截取与首尾淡化记录见 `AUDIO-CREDITS.md`。四个 Freesound 实物拟音均为 CC0；确切来源、许可、文件哈希与测量见 `public/audio/sfx/audio-manifest.json`，署名记录见同目录 `FREESOUND-CREDITS.md`。

音频信号测量不等于主观试听。声音音色、实际播放设备上的掩蔽和音乐气质仍需人工聆听评估。
