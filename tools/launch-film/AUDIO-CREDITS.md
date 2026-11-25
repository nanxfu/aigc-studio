# 声音素材记录

## BGM

- 曲名：House Vibez
- 作者：Lily J
- 来源：video-shotcraft 内置 Mixkit 备选素材，未从废弃宣传片取用。
- 原曲文件：`public/audio/house-vibez.mp3`
- Mixkit 媒体来源：https://assets.mixkit.co/music/745/745.mp3
- 许可入口：https://mixkit.co/license/#musicFree
- skill 原始记录：`C:/Users/79121/.agents/skills/video-shotcraft/assets/audio/ATTRIBUTION.md`
- 处理：从 7.945637666 秒开始，约 59 秒；淡入 0.35 秒，淡出 2 秒；保存为 `public/audio/music-bed.wav`，混音增益 0.28。
- 节奏：拟合约 122.07 BPM；原曲存在切分音，均匀网格并不覆盖所有瞬态。实际镜头边界由分析得到的攻击点确定。

## 拟音

四个文件全部来自 Freesound 的 HQ MP3 预览，属于有损预览文件。均为 CC0-1.0：

| 文件 | 作者 | 素材页 | 声源 |
|---|---|---|---|
| fs-464302.mp3 | eyesonlegs | https://freesound.org/people/eyesonlegs/sounds/464302/ | 纸张滑过桌面 |
| fs-579883.mp3 | yfjesse | https://freesound.org/people/yfjesse/sounds/579883/ | Pentax K1000 快门 |
| fs-730078.mp3 | brokenmachinery | https://freesound.org/people/brokenmachinery/sounds/730078/ | 轻纸张滑动 |
| fs-786019.mp3 | miyuki.y | https://freesound.org/people/miyuki.y/sounds/786019/ | MacBook 键盘 |

确切许可 URL、作者说明、采样率、峰值、来源文件哈希等见 `public/audio/sfx/audio-manifest.json`。源文件未改写，时间窗口与增益由 `src/timeline.ts` 控制，原始录音的攻击峰滞后在排程时单独扣除。

## 输出管线实测

2026-11-25，Remotion 4.0.546 / AAC / 48kHz / MP4 / 30fps。对成片抽取的音轨与四个尖锐拟音源文件做互相关：输出整体延迟 0 个样本；配乐差轨也测得 0 个样本。因此保持 `OUTPUT_AUDIO_OFFSET_SEC = 0`，不套用其他工程的 AAC 补偿常数。

最终探针、相关系数、切点回测和响度证据保存在 `out/qa/audio-verification.json`。测量只能验证信号存在、对齐和峰值，不能替代主观试听。
