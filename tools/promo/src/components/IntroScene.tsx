import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { FONT_STACK } from './StudioFrame';

const BG_CARDS = [
  { src: 'showcase/flux2-klein-4b-kyoto-poster.webp', x: 110, y: 120, w: 320, rot: -7 },
  { src: 'showcase/anima-turbo-v1.1-seaside-station.webp', x: 1480, y: 110, w: 280, rot: 6 },
  { src: 'showcase/qwen-image-2.1-botanica-poster.webp', x: 140, y: 650, w: 260, rot: 5 },
  { src: 'showcase/flux2-klein-9b-clockmaker-bench.webp', x: 1440, y: 640, w: 340, rot: -5 },
];

const PILLS = [
  '免费挂载 Kaggle 30G 双卡',
  '7 款主流开源生图模型',
  '作品与版本树 100% 落盘本地',
];

export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const titleSpring = spring({ frame: frame - 6, fps, config: { damping: 16, stiffness: 120 } });
  const subSpring = spring({ frame: frame - 18, fps, config: { damping: 18, stiffness: 110 } });

  const exitOpacity = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(1200px 760px at 50% 42%, #1d202b 0%, #0b0c10 74%)',
        fontFamily: FONT_STACK,
        color: '#f7f8fa',
        justifyContent: 'center',
        alignItems: 'center',
        opacity: exitOpacity,
      }}
    >
      {/* 背景真实样张氛围层 */}
      {BG_CARDS.map((card, i) => {
        const floatY = Math.sin((frame + i * 24) / 28) * 10;
        const cardIn = interpolate(frame, [0, 22], [0, 0.24], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        return (
          <div
            key={card.src}
            style={{
              position: 'absolute',
              left: card.x,
              top: card.y + floatY,
              width: card.w,
              borderRadius: 16,
              overflow: 'hidden',
              transform: `rotate(${card.rot}deg)`,
              opacity: cardIn,
              boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
              border: '1px solid rgba(255,255,255,0.12)',
              filter: 'blur(1px)',
            }}
          >
            <Img src={staticFile(card.src)} style={{ width: '100%', display: 'block' }} />
          </div>
        );
      })}

      {/* 中心焦点文案 */}
      <div
        style={{
          zIndex: 2,
          textAlign: 'center',
          maxWidth: 1160,
          padding: '0 48px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            padding: '8px 20px',
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.18)',
            background: 'rgba(255,255,255,0.07)',
            fontSize: 20,
            fontWeight: 500,
            color: 'rgba(255,255,255,0.88)',
            marginBottom: 28,
            opacity: interpolate(frame, [0, 14], [0, 1], { extrapolateRight: 'clamp' }),
            transform: `translateY(${interpolate(frame, [0, 14], [14, 0], { extrapolateRight: 'clamp' })}px)`,
          }}
        >
          开源免费 · 桌面端 AI 图像创作与资产工作台
        </div>

        <h1
          style={{
            margin: 0,
            fontSize: 108,
            fontWeight: 800,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            background: 'linear-gradient(180deg, #ffffff 0%, #c8cdd8 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            transform: `translateY(${interpolate(titleSpring, [0, 1], [28, 0])}px) scale(${interpolate(titleSpring, [0, 1], [0.95, 1])})`,
            opacity: titleSpring,
          }}
        >
          AIGC Studio
        </h1>

        <p
          style={{
            margin: '26px 0 42px',
            fontSize: 34,
            fontWeight: 500,
            lineHeight: 1.45,
            color: 'rgba(240, 242, 248, 0.88)',
            transform: `translateY(${interpolate(subSpring, [0, 1], [22, 0])}px)`,
            opacity: subSpring,
          }}
        >
          不用买显卡、不折腾 ComfyUI
          <br />
          从一句中文灵感，到抠图 / 转矢量 / 游戏材质拆解一步到位
        </p>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', justifyContent: 'center' }}>
          {PILLS.map((label, idx) => {
            const p = spring({
              frame: frame - (28 + idx * 6),
              fps,
              config: { damping: 16, stiffness: 130 },
            });
            return (
              <span
                key={label}
                style={{
                  padding: '12px 24px',
                  borderRadius: 12,
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.14)',
                  fontSize: 22,
                  fontWeight: 500,
                  color: '#ffffff',
                  opacity: p,
                  transform: `translateY(${interpolate(p, [0, 1], [16, 0], { easing: Easing.out(Easing.cubic) })}px)`,
                }}
              >
                {label}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
