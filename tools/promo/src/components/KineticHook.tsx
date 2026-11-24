import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export const FONT_STACK =
  '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const KineticHook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Beat 0 (0..15): 没有 4090？
  // Beat 1 (15..30): 不想配 ComfyUI？
  // Beat 2-3 (30..60): 3 步出图 · ¥0
  const phase = frame < 15 ? 0 : frame < 30 ? 1 : 2;
  const localFrame = phase === 0 ? frame : phase === 1 ? frame - 15 : frame - 30;

  const punch = spring({
    frame: localFrame,
    fps,
    config: { damping: 14, stiffness: 260, mass: 0.6 },
  });
  const scale = interpolate(punch, [0, 1], [1.18, 1]);

  if (phase === 0) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: '#090a0d',
          fontFamily: FONT_STACK,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            fontSize: 128,
            fontWeight: 900,
            letterSpacing: '-0.03em',
            color: '#ffffff',
            transform: `scale(${scale})`,
          }}
        >
          没有 4090？
        </div>
      </AbsoluteFill>
    );
  }

  if (phase === 1) {
    return (
      <AbsoluteFill
        style={{
          backgroundColor: '#f4f5f7',
          fontFamily: FONT_STACK,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            fontSize: 112,
            fontWeight: 900,
            letterSpacing: '-0.03em',
            color: '#0b0c10',
            transform: `scale(${scale})`,
          }}
        >
          不想折腾 ComfyUI？
        </div>
      </AbsoluteFill>
    );
  }

  const subOpacity = interpolate(localFrame, [4, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  return (
    <AbsoluteFill
      style={{
        background: 'radial-gradient(900px 560px at 50% 45%, #161b22 0%, #090a0d 72%)',
        fontFamily: FONT_STACK,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 32,
          transform: `scale(${scale})`,
        }}
      >
        <span
          style={{
            fontSize: 116,
            fontWeight: 900,
            letterSpacing: '-0.03em',
            color: '#ffffff',
          }}
        >
          3 步出图
        </span>
        <span
          style={{
            fontSize: 124,
            fontWeight: 900,
            letterSpacing: '-0.03em',
            color: '#10b981',
          }}
        >
          ¥0
        </span>
      </div>
      <div
        style={{
          marginTop: 28,
          fontSize: 28,
          fontWeight: 600,
          letterSpacing: '0.06em',
          color: 'rgba(255,255,255,0.64)',
          opacity: subOpacity,
        }}
      >
        AIGC Studio · 开源桌面端
      </div>
    </AbsoluteFill>
  );
};
