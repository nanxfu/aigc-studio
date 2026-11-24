import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT_STACK } from './KineticHook';

export const BonusWorkshop: React.FC<{ workshopFrames: number }> = ({ workshopFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const idx = Math.min(workshopFrames, Math.max(1, frame + 1));
  const enter = spring({ frame, fps, config: { damping: 16, stiffness: 180 } });

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(1200px 760px at 50% 10%, #eef0f5 0%, #dde1ea 100%)',
        fontFamily: FONT_STACK,
        justifyContent: 'flex-start',
        alignItems: 'center',
        padding: '32px 64px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 1460,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 18,
          opacity: enter,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 40, fontWeight: 800, color: '#0f1116' }}>
          出完图，顺手抠图 / 转 SVG
        </h2>
        <span
          style={{
            padding: '8px 20px',
            borderRadius: 999,
            background: '#0f1116',
            color: '#ffffff',
            fontSize: 21,
            fontWeight: 600,
          }}
        >
          内置资产工坊 · 本地直出
        </span>
      </div>

      <div
        style={{
          width: 1440,
          height: 900,
          transform: `scale(${interpolate(frame, [0, workshopFrames], [0.91, 0.935])})`,
          transformOrigin: '50% 4%',
          borderRadius: 18,
          overflow: 'hidden',
          boxShadow: '0 28px 80px rgba(15, 20, 35, 0.22), 0 0 0 1px rgba(15,17,22,0.08)',
          background: '#ffffff',
        }}
      >
        <Img
          src={staticFile(`frames/workshop/${String(idx).padStart(4, '0')}.jpg`)}
          style={{ width: 1440, height: 900, display: 'block', objectFit: 'cover' }}
        />
      </div>
    </AbsoluteFill>
  );
};

export const MinimalOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 16, stiffness: 150 } });

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(1000px 640px at 50% 45%, #191c26 0%, #090a0d 72%)',
        fontFamily: FONT_STACK,
        color: '#ffffff',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          transform: `scale(${interpolate(pop, [0, 1], [0.92, 1])})`,
          opacity: pop,
        }}
      >
        <div
          style={{
            fontSize: 96,
            fontWeight: 900,
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
          }}
        >
          AIGC Studio
        </div>
        <div
          style={{
            marginTop: 22,
            fontSize: 34,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.82)',
          }}
        >
          双击打开 · 本地存图 · MIT 开源
        </div>
        <div
          style={{
            marginTop: 40,
            display: 'inline-block',
            padding: '16px 36px',
            borderRadius: 14,
            background: '#ffffff',
            color: '#090a0d',
            fontSize: 28,
            fontWeight: 800,
            letterSpacing: '-0.01em',
          }}
        >
          github.com/nanxfu/aigc-studio
        </div>
        <div
          style={{
            marginTop: 22,
            fontSize: 21,
            color: 'rgba(255,255,255,0.5)',
          }}
        >
          Windows · macOS · Linux
        </div>
      </div>
    </AbsoluteFill>
  );
};
