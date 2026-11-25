import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { C, CLIP, FONT, MONO, inQuad, mix, outCubic, ramp, smooth } from './visuals';

/** transition-hidden-cut -> versus-slam: 15-degree diagonal halves collide with impact flash */
export const VersusSlamTransition: React.FC<{ leftLabel?: string; rightLabel?: string }> = ({
  leftLabel = '生成图像',
  rightLabel = '内置工坊',
}) => {
  const f = useCurrentFrame(); // 16f total
  const slam = ramp(f, 0, 8, inQuad);
  const flash = f >= 7 && f <= 10 ? 1 - (f - 7) / 4 : 0;
  const exit = ramp(f, 11, 5, outCubic);
  const shakeX = f === 8 ? 10 : f === 9 ? -7 : 0;
  const lx = mix(-1080, 0, slam) - mix(0, 1920, exit);
  const rx = mix(1080, 0, slam) + mix(0, 1920, exit);

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', transform: `translateX(${shakeX}px)`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: C.ink,
          clipPath: CLIP.diagHalfL,
          transform: `translateX(${lx}px)`,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 180,
          color: C.paper,
          fontFamily: FONT,
          fontSize: 76,
          fontWeight: 800,
          letterSpacing: -2,
        }}
      >
        {leftLabel}
      </div>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: C.accent,
          clipPath: CLIP.diagHalfR,
          transform: `translateX(${rx}px)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingRight: 180,
          color: '#fff',
          fontFamily: FONT,
          fontSize: 76,
          fontWeight: 800,
          letterSpacing: -2,
        }}
      >
        {rightLabel}
      </div>
      {flash > 0 && (
        <AbsoluteFill style={{ background: '#ffffff', opacity: flash * 0.85 }} />
      )}
    </AbsoluteFill>
  );
};

/** theme-switch-moves -> theme-sweep-toggle: 15-degree diagonal light beam sweeps into dark mode */
export const ThemeSweepTransition: React.FC = () => {
  const f = useCurrentFrame(); // 16f total
  const p = ramp(f, 0, 15, outCubic);
  const x = mix(-220, 2140, p);
  const tail = clamp01(1 - (f - 12) / 4);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 50, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          top: -120,
          bottom: -120,
          left: x - 260,
          width: 280,
          background: `linear-gradient(90deg, transparent, ${C.ink}ee 55%, ${C.ink})`,
          transform: 'skewX(-15deg)',
          opacity: tail,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: -120,
          bottom: -120,
          left: x,
          width: 8,
          background: '#fff',
          boxShadow: `0 0 28px 6px ${C.cobalt}, 0 0 12px 2px #fff`,
          transform: 'skewX(-15deg)',
          opacity: tail,
        }}
      />
    </AbsoluteFill>
  );
};

/** wipe-transitions -> blinds-slice: 12 3D vertical slats flip across */
export const BlindsSliceTransition: React.FC<{ color?: string }> = ({ color = C.ink }) => {
  const f = useCurrentFrame(); // 16f total
  const slats = 12;
  const w = 1920 / slats;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 50, perspective: 1200 }}>
      {Array.from({ length: slats }).map((_, i) => {
        const delay = i * 0.55;
        const rot = interpolate(f, [delay, delay + 6, delay + 11], [-90, 0, 90], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const visible = f >= delay && f <= delay + 11;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: i * w,
              top: 0,
              width: w + 2,
              height: 1080,
              background: i % 3 === 0 ? C.accent : color,
              opacity: visible ? 1 : 0,
              transform: `rotateY(${rot}deg)`,
              backfaceVisibility: 'hidden',
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/** transition-hidden-cut -> invisible-cut: skewed foreground card sweeps across viewport */
export const InvisibleCardWipe: React.FC = () => {
  const f = useCurrentFrame(); // 14f total
  const p = ramp(f, 0, 14, smooth);
  const x = mix(-2350, 2250, p);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', zIndex: 50, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          top: -80,
          bottom: -80,
          left: x,
          width: 2150,
          background: C.ink,
          transform: 'skewX(-12deg)',
          boxShadow: '0 0 80px rgba(0,0,0,0.65)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 28, letterSpacing: 6, color: '#5b5b66' }}>
          AIGC STUDIO // WORKSPACE
        </span>
      </div>
    </AbsoluteFill>
  );
};

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}
