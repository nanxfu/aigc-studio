import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { FONT_STACK } from './StudioFrame';

const GALLERY_ITEMS = [
  { src: 'showcase/sdxl-lightning-cyberpunk-street.webp', tag: 'SDXL Lightning' },
  { src: 'showcase/flux2-klein-4b-kyoto-poster.webp', tag: 'FLUX.2 Klein 4B' },
  { src: 'showcase/qwen-image-2.1-botanica-poster.webp', tag: 'Qwen-Image 2.1' },
  { src: 'showcase/anima-turbo-v1.1-seaside-station.webp', tag: 'Anima Turbo' },
  { src: 'showcase/z-image-turbo-alley-bookstore.webp', tag: 'Z-Image Turbo' },
  { src: 'showcase/flux2-klein-9b-clockmaker-bench.webp', tag: 'FLUX.2 Klein 9B' },
  { src: 'showcase/sana-sprint-1.6b-crane-pond.webp', tag: 'SANA-Sprint' },
];

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardSpring = spring({ frame: frame - 8, fps, config: { damping: 17, stiffness: 115 } });
  const scrollX = interpolate(frame, [0, 120], [0, -260], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(1100px 700px at 50% 45%, #1d202b 0%, #0a0b0f 75%)',
        fontFamily: FONT_STACK,
        color: '#ffffff',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {/* 底部横向样张画廊条 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          paddingLeft: 40,
          transform: `translateX(${scrollX}px)`,
          opacity: 0.32,
        }}
      >
        {GALLERY_ITEMS.map((item) => (
          <div
            key={item.src}
            style={{
              width: 340,
              height: 440,
              flexShrink: 0,
              borderRadius: 18,
              overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.14)',
              position: 'relative',
            }}
          >
            <Img
              src={staticFile(item.src)}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
            <span
              style={{
                position: 'absolute',
                left: 14,
                bottom: 14,
                padding: '4px 10px',
                borderRadius: 999,
                background: 'rgba(10,11,15,0.72)',
                fontSize: 15,
                fontWeight: 500,
              }}
            >
              {item.tag}
            </span>
          </div>
        ))}
      </div>

      {/* 居中收尾 CTA 卡 */}
      <div
        style={{
          zIndex: 3,
          padding: '54px 72px',
          borderRadius: 28,
          background: 'rgba(16, 18, 24, 0.86)',
          border: '1px solid rgba(255,255,255,0.16)',
          boxShadow: '0 40px 100px rgba(0,0,0,0.65)',
          backdropFilter: 'blur(16px)',
          textAlign: 'center',
          transform: `translateY(${interpolate(cardSpring, [0, 1], [30, 0])}px) scale(${interpolate(cardSpring, [0, 1], [0.94, 1])})`,
          opacity: cardSpring,
        }}
      >
        <div
          style={{
            display: 'inline-block',
            padding: '7px 18px',
            borderRadius: 999,
            background: 'rgba(255,255,255,0.1)',
            fontSize: 19,
            fontWeight: 600,
            marginBottom: 20,
          }}
        >
          MIT 开源协议 · 免费下载使用
        </div>
        <h2
          style={{
            margin: 0,
            fontSize: 64,
            fontWeight: 800,
            letterSpacing: '-0.02em',
          }}
        >
          AIGC Studio
        </h2>
        <p
          style={{
            margin: '16px 0 32px',
            fontSize: 28,
            color: 'rgba(245, 246, 250, 0.85)',
            fontWeight: 500,
          }}
        >
          把专业级开源生图门槛降到双击打开
        </p>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 16,
            padding: '14px 28px',
            borderRadius: 14,
            background: '#ffffff',
            color: '#0d0e12',
            fontSize: 24,
            fontWeight: 700,
          }}
        >
          <span>github.com/nanxfu/aigc-studio</span>
        </div>
        <div
          style={{
            marginTop: 20,
            fontSize: 19,
            color: 'rgba(255,255,255,0.6)',
          }}
        >
          支持 Windows · macOS · Linux 桌面端 & MCP Agent 接入
        </div>
      </div>
    </AbsoluteFill>
  );
};
