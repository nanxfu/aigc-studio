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

export type ZoomKeyframe = {
  frame: number;
  scale: number;
  originX: number; // 0..1 relative to video width
  originY: number; // 0..1 relative to video height
};

export type StudioFrameProps = {
  frameDir: string;
  frameCount: number;
  badge: string;
  headline: string;
  subline: string;
  zoomKeyframes?: ZoomKeyframe[];
  darkStage?: boolean;
};

export const FONT_STACK =
  '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const StudioFrame: React.FC<StudioFrameProps> = ({
  frameDir,
  frameCount,
  badge,
  headline,
  subline,
  zoomKeyframes,
  darkStage = false,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 18, stiffness: 110, mass: 0.9 },
  });

  const exitOpacity = interpolate(
    frame,
    [durationInFrames - 10, durationInFrames],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // Subtle outer-window breathing motion (never crops inner UI edges)
  const breatheScale = interpolate(
    frame,
    [0, durationInFrames * 0.5, durationInFrames],
    [0.91, 0.935, 0.915],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.inOut(Easing.cubic),
    },
  );

  const cardTranslateY = interpolate(enter, [0, 1], [46, 0]);
  const cardRotateX = interpolate(enter, [0, 1], [6, 0]);
  const cardScale = interpolate(enter, [0, 1], [0.94, 1]);

  const headerOpacity = interpolate(frame, [4, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const headerY = interpolate(frame, [4, 18], [16, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  const bg = darkStage
    ? 'radial-gradient(1200px 680px at 50% 10%, #232530 0%, #0d0e12 70%)'
    : 'radial-gradient(1200px 720px at 20% 0%, #f4f5f8 0%, #e7e9ef 60%, #dfe2ea 100%)';

  const ink = darkStage ? '#f5f6f9' : '#111216';
  const mutedInk = darkStage ? 'rgba(245,246,249,0.72)' : 'rgba(17,18,22,0.68)';

  return (
    <AbsoluteFill
      style={{
        background: bg,
        fontFamily: FONT_STACK,
        opacity: exitOpacity,
        justifyContent: 'flex-start',
        alignItems: 'center',
        padding: '38px 72px 44px',
        perspective: 1400,
      }}
    >
      {/* 顶部大字卖点 */}
      <div
        style={{
          width: '100%',
          maxWidth: 1520,
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 20,
          opacity: headerOpacity,
          transform: `translateY(${headerY}px)`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span
            style={{
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: '0.04em',
              padding: '6px 14px',
              borderRadius: 999,
              background: darkStage ? 'rgba(255,255,255,0.12)' : '#111216',
              color: '#ffffff',
            }}
          >
            {badge}
          </span>
          <h2
            style={{
              margin: 0,
              fontSize: 36,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: ink,
            }}
          >
            {headline}
          </h2>
        </div>
        <span
          style={{
            fontSize: 21,
            fontWeight: 500,
            color: mutedInk,
          }}
        >
          {subline}
        </span>
      </div>

      {/* 桌面客户端窗口容器 */}
      <div
        style={{
          width: 1440,
          height: 900,
          transform: `translateY(${cardTranslateY}px) rotateX(${cardRotateX}deg) scale(${cardScale * breatheScale})`,
          transformOrigin: '50% 8%',
          borderRadius: 18,
          overflow: 'hidden',
          boxShadow: darkStage
            ? '0 36px 96px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255,255,255,0.12)'
            : '0 32px 84px rgba(15, 20, 35, 0.22), 0 0 0 1px rgba(17,18,22,0.08)',
          background: '#ffffff',
          position: 'relative',
        }}
      >
        <Img
          src={staticFile(`${frameDir}/${String(Math.min(frameCount, Math.max(1, frame + 1))).padStart(4, '0')}.jpg`)}
          style={{
            width: 1440,
            height: 900,
            display: 'block',
            objectFit: 'cover',
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
