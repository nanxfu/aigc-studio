import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { SHOTS, SFX, TRANSITIONS } from './timeline';
import { C, CLIP, MONO } from './visuals';

// VTT cues hard-coded from vo-main.vtt (edge-tts timing reference)
const VO_CUES: Array<{ from: number; to: number; text: string }> = [
  { from: 0.0,   to: 6.1,  text: '我做了一个开源免费的桌面端 AI 创作工作台，下载下来就能用，不用自己配环境。' },
  { from: 6.1,   to: 18.4, text: '平时做图或做游戏素材，最麻烦的其实不是生成，而是生成之后还有一堆后处理。\n我干脆把这些功能整合到了一起。' },
  { from: 18.4,  to: 29.4, text: '不知道怎么写提示词，内置助手帮你整理。图生成好了可以直接去背、转 SVG、做无缝贴图。\n做游戏素材还有像素对齐、序列帧切片和 PBR 材质生成。' },
  { from: 29.4,  to: 41.7, text: '生图、视频、画廊管理和 MCP 也都支持。\n没有显卡也不用担心，连接 Kaggle 每周 30 小时免费 GPU，能白嫖就先白嫖。' },
  { from: 41.7,  to: 47.4, text: '项目已经开源，完全免费，感兴趣的话欢迎来玩，也欢迎提 Issue。' },
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