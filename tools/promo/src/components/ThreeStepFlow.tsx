import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { FONT_STACK } from './KineticHook';

export type ThreeStepFlowProps = {
  modelFrames: number;
  generateFrames: number;
  pendingFrames: number;
};

const STEPS = [
  { id: 1, label: '① 选模型 · 免费双 T4', tag: '算力费用 ¥0' },
  { id: 2, label: '② 写句人话 · 点生成', tag: '不用背英文词' },
  { id: 3, label: '③ 云端直出 · 落盘本地', tag: '马上出图' },
];

export const ThreeStepFlow: React.FC<ThreeStepFlowProps> = ({
  modelFrames,
  generateFrames,
  pendingFrames,
}) => {
  const frame = useCurrentFrame();
  const total = modelFrames + generateFrames + pendingFrames;

  let activeStep = 0;
  let folder = 'model';
  let localFrame = frame;
  let maxFrames = modelFrames;

  if (frame >= modelFrames + generateFrames) {
    activeStep = 2;
    folder = 'pending';
    localFrame = frame - modelFrames - generateFrames;
    maxFrames = pendingFrames;
  } else if (frame >= modelFrames) {
    activeStep = 1;
    folder = 'generate';
    localFrame = frame - modelFrames;
    maxFrames = generateFrames;
  }

  const idx = Math.min(maxFrames, Math.max(1, localFrame + 1));
  const imgSrc = staticFile(`frames/${folder}/${String(idx).padStart(4, '0')}.jpg`);

  // Pre-drop subtle push-in during last 30 frames (pending) + white flash at very end
  const pushScale =
    activeStep === 2
      ? interpolate(localFrame, [0, pendingFrames], [0.92, 0.96], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.in(Easing.cubic),
        })
      : 0.92;

  const preDropFlash = interpolate(frame, [total - 5, total], [0, 0.85], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

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
      {/* 顶部连贯 3 步节奏进度条 */}
      <div
        style={{
          width: '100%',
          maxWidth: 1460,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 18,
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', gap: 12 }}>
          {STEPS.map((s, i) => {
            const on = i === activeStep;
            const done = i < activeStep;
            return (
              <div
                key={s.id}
                style={{
                  padding: '10px 20px',
                  borderRadius: 999,
                  fontSize: 22,
                  fontWeight: on ? 700 : 500,
                  background: on ? '#0f1116' : done ? 'rgba(16,185,129,0.14)' : 'rgba(15,17,22,0.06)',
                  color: on ? '#ffffff' : done ? '#047857' : 'rgba(15,17,22,0.48)',
                  border: on ? '1px solid #0f1116' : '1px solid rgba(15,17,22,0.08)',
                }}
              >
                {s.label}
              </div>
            );
          })}
        </div>

        <div
          style={{
            padding: '10px 22px',
            borderRadius: 999,
            background: '#10b981',
            color: '#ffffff',
            fontSize: 22,
            fontWeight: 700,
            boxShadow: '0 8px 24px rgba(16,185,129,0.28)',
          }}
        >
          {STEPS[activeStep].tag}
        </div>
      </div>

      {/* 完整无裁切桌面端画面 */}
      <div
        style={{
          width: 1440,
          height: 900,
          transform: `scale(${pushScale})`,
          transformOrigin: '50% 4%',
          borderRadius: 18,
          overflow: 'hidden',
          boxShadow: '0 28px 80px rgba(15, 20, 35, 0.22), 0 0 0 1px rgba(15,17,22,0.08)',
          background: '#ffffff',
        }}
      >
        <Img
          src={imgSrc}
          style={{ width: 1440, height: 900, display: 'block', objectFit: 'cover' }}
        />
      </div>

      {preDropFlash > 0 ? (
        <AbsoluteFill style={{ backgroundColor: '#ffffff', opacity: preDropFlash, pointerEvents: 'none' }} />
      ) : null}
    </AbsoluteFill>
  );
};
