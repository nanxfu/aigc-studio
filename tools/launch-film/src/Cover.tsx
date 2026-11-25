import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { NINE_DIM, C, CLIP, FONT, MONO, BrandIcon, Image, GridField } from './visuals';

export const Cover: React.FC = () => {
  const f = useCurrentFrame();
  const pan = f * 0.6;
  const row1 = NINE_DIM.wall.slice(0, 9);
  const row2 = NINE_DIM.wall.slice(9, 18);
  const row3 = [...NINE_DIM.wall.slice(4, 9), ...NINE_DIM.wall.slice(0, 4)];
  const TILE_W = 370;
  const TILE_H = 260;
  const GAP = 8;

  return (
    <AbsoluteFill style={{ background: C.ink, fontFamily: FONT, overflow: 'hidden' }}>

      {/* 图墙铺满全屏 6 行 */}
      <div style={{ position: 'absolute', inset: 0 }}>
        {[row1, row2, row3, row1, row2, row3].map((row, ri) => {
          const dir = ri % 2 === 0 ? 1 : -1;
          const speed = 0.7 + ri * 0.04;
          const offset = dir > 0
            ? -(pan * speed) % (TILE_W + GAP)
            : -(TILE_W + GAP) + (pan * speed) % (TILE_W + GAP);
          return (
            <div key={ri} style={{ display: 'flex', gap: GAP, position: 'absolute', top: ri * (TILE_H + GAP) - 10, left: offset, width: (TILE_W + GAP) * 14 }}>
              {[...row, ...row, ...row].map((src, i) => (
                <Image key={i} src={src} style={{ width: TILE_W, height: TILE_H, objectFit: 'cover', flexShrink: 0 }} />
              ))}
            </div>
          );
        })}
      </div>

      {/* 遮罩：中段开始压暗，下半完全黑 */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(180deg, transparent 30%, rgba(14,14,18,0.6) 52%, rgba(14,14,18,0.95) 65%, #0e0e12 75%)',
      }} />

      <GridField dark opacity={0.02} />

      {/* 文字区：从 y=870 开始，确保在全黑区域内 */}
      <div style={{ position: 'absolute', left: 60, right: 60, top: 870 }}>

        {/* 品牌 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 28 }}>
          <BrandIcon size={34} dark />
          <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, letterSpacing: 2.5, color: 'rgba(255,255,255,0.38)' }}>
            AIGC STUDIO
          </span>
        </div>

        {/* 主标题 */}
        <div style={{ fontSize: 100, fontWeight: 880, letterSpacing: -3.5, lineHeight: 1.05, color: '#fff' }}>
          开源桌面端
          <br />
          <span style={{ color: C.accent }}>AI 创作</span>
          <br />
          工作台
        </div>

        {/* 副标题 */}
        <div style={{ marginTop: 28, fontSize: 28, fontWeight: 500, color: 'rgba(255,255,255,0.5)', lineHeight: 1.6 }}>
          写中文直接出图 · 内置工坊一键后处理
          <br />
          Kaggle 免费算力，不用配环境
        </div>

        {/* 标签 */}
        <div style={{ marginTop: 32, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {['MIT 开源', '30h/周免费算力', '8 款内置模型', '零 Python'].map((tag) => (
            <div key={tag} style={{
              padding: '7px 16px',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.15)',
              clipPath: CLIP.chamfer(7),
              fontFamily: MONO, fontSize: 18,
              color: 'rgba(255,255,255,0.6)',
            }}>
              {tag}
            </div>
          ))}
        </div>
      </div>

      {/* 底部 accent 线 */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 5, background: C.accent }} />
    </AbsoluteFill>
  );
};