import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { SHOTS, SFX, TRANSITIONS } from './timeline';
import { C, CLIP, MONO } from './visuals';

// VTT cues hard-coded from vo-main.vtt (edge-tts timing reference)
const VO_CUES: Array<{ from: number; to: number; text: string }> = [
  { from: 0.10,  to: 6.89,  text: '我做了个开源的 AI 创作工作台，不用配置复杂环境，点开就能跑。' },
  { from: 6.84,  to: 12.16, text: '随便写个模糊想法，Agent 自动帮你理顺参数出图。' },
  { from: 12.16, to: 26.49, text: '出完图后可以在工坊里去除背景、转矢量、做无缝贴图，\n游戏常用的像素对齐、序列帧和 PBR 材质也都有，不用再切软件。' },
  { from: 26.49, to: 32.67, text: '本地没显卡也没事，直接白嫖 Kaggle 每周三十小时的免费算力。' },
  { from: 32.67, to: 40.96, text: '生图、视频、画廊、MCP 全都在这一个桌面端里，开源免费，欢迎拿去折腾。' },
];

const Subtitles: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sec = f / fps;
  const cue = VO_CUES.find((c) => sec >= c.from && sec < c.to);
  if (!cue) return null;

  // fade in first 0.25s, fade out last 0.25s of cue
  const elapsed = sec - cue.from;
  const remaining = cue.to - sec;
  const opacity = Math.min(1, elapsed / 0.25, remaining / 0.25);

  return (
    <div
      style={{
        position: 'absolute',
        left: 72,
        right: 72,
        bottom: 52,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 100,
        opacity,
      }}
    >
      <div
        style={{
          maxWidth: 1400,
          padding: '14px 32px',
          background: 'rgba(0,0,0,0.58)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          clipPath: CLIP.chamfer(10),
          textAlign: 'center',
        }}
      >
        {cue.text.split('\n').map((line, i) => (
          <div
            key={i}
            style={{
              fontSize: 28,
              fontWeight: 600,
              color: '#f0f0f2',
              lineHeight: 1.55,
              letterSpacing: 0.3,
              textShadow: '0 1px 6px rgba(0,0,0,0.7)',
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};

export const LaunchFilm: React.FC<{ bgm?: boolean; vo?: boolean; subs?: boolean }> = ({
  bgm = true,
  vo = true,
  subs = true,
}) => (
  <AbsoluteFill style={{ background: '#141416' }}>
    {SHOTS.map((s) => (
      <Sequence key={s.id} from={s.from} durationInFrames={s.duration}>
        <s.component {...s.props} duration={s.duration} hideNarrativeCaption />
      </Sequence>
    ))}
    {TRANSITIONS.map((t) => (
      <Sequence key={t.id} from={t.from} durationInFrames={t.duration}>
        <t.component />
      </Sequence>
    ))}
    {bgm && <Audio src={staticFile('audio/music-bed-45s.wav')} volume={vo ? 0.18 : 0.36} />}
    {vo && <Audio src={staticFile('audio/vo-main.mp3')} volume={1.0} />}
    {SFX.map((s) => (
      <Sequence key={s.id} from={s.from} durationInFrames={s.duration}>
        <Audio src={staticFile(s.src)} volume={s.volume * (vo ? 0.5 : 1)} />
      </Sequence>
    ))}
    {vo && subs && <Subtitles />}
  </AbsoluteFill>
);