import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';

export const C = {
  paper: '#f5f5f6',
  white: '#ffffff',
  ink: '#141416',
  ink2: '#1d1d22',
  secondary: '#52525a',
  gray: '#9898a2',
  line: '#dedee3',
  accent: '#e8533f',
  mint: '#24b47e',
  cobalt: '#4c7cff',
  amber: '#f59e0b',
};

export const FONT = '"Segoe UI", "Microsoft YaHei", sans-serif';
export const MONO = '"Cascadia Mono", "SFMono-Regular", Consolas, monospace';

export const out = Easing.bezier(0.22, 1, 0.36, 1);
export const outQuint = Easing.out(Easing.poly(5));
export const outCubic = Easing.out(Easing.cubic);
export const inQuad = Easing.in(Easing.quad);
export const smooth = Easing.bezier(0.65, 0, 0.35, 1);
export const snap = Easing.bezier(0.34, 1.56, 0.64, 1);
export const backOut = Easing.out(Easing.back(1.8));

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (n: number, a = 0, b = 1) => Math.max(a, Math.min(b, n));
export const ramp = (f: number, start: number, duration: number, easing = out) =>
  interpolate(f, [start, start + Math.max(1, duration)], [0, 1], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

// Irregular geometric clip-path presets
export const CLIP = {
  chamfer: (cut = 26) =>
    `polygon(${cut}px 0, 100% 0, 100% calc(100% - ${cut}px), calc(100% - ${cut}px) 100%, 0 100%, 0 ${cut}px)`,
  slashLeft: 'polygon(0 0, 100% 0, 82% 100%, 0 100%)',
  slashMid: 'polygon(18% 0, 100% 0, 82% 100%, 0 100%)',
  slashRight: 'polygon(18% 0, 100% 0, 100% 100%, 0 100%)',
  diagHalfL: 'polygon(0 0, 56% 0, 44% 100%, 0 100%)',
  diagHalfR: 'polygon(56% 0, 100% 0, 100% 100%, 44% 100%)',
  hex: 'polygon(14% 0, 86% 0, 100% 50%, 86% 100%, 14% 100%, 0 50%)',
};

export const ART = {
  botanical: 'art/qwen-image-2.1-botanica-poster.webp',
  kyoto: 'art/flux2-klein-4b-kyoto-poster.webp',
  crane: 'art/sana-sprint-1.6b-crane-pond.webp',
  shop: 'art/z-image-turbo-alley-bookstore.webp',
  clock: 'art/flux2-klein-9b-clockmaker-bench.webp',
  anime: 'art/anima-turbo-v1.1-seaside-station.webp',
  street: 'art/sdxl-lightning-cyberpunk-street.webp',
};

export const BENCH = {
  flux4b_typo: 'art/bench/flux2-klein-4b-01-typography-poster.png',
  flux4b_spatial: 'art/bench/flux2-klein-4b-03-spatial-binding.png',
  flux4b_anime: 'art/bench/flux2-klein-4b-04-anime-action.png',
  flux4b_chinese: 'art/bench/flux2-klein-4b-06-chinese-aesthetics.png',
  flux4b_diorama: 'art/bench/flux2-klein-4b-08-isometric-diorama.png',
  flux4b_scifi: 'art/bench/flux2-klein-4b-09-scifi-scale.png',
  flux9b_portrait: 'art/bench/flux2-klein-9b-02-photoreal-portrait.png',
  flux9b_anime: 'art/bench/flux2-klein-9b-04-anime-action.png',
  flux9b_material: 'art/bench/flux2-klein-9b-05-material-refraction.png',
  flux9b_scifi: 'art/bench/flux2-klein-9b-09-scifi-scale.png',
  qwen_typo: 'art/bench/qwen-image-2.1-01-typography-poster.png',
  qwen_chinese: 'art/bench/qwen-image-2.1-06-chinese-aesthetics.png',
  qwen_diorama: 'art/bench/qwen-image-2.1-08-isometric-diorama.png',
  qwen_scifi: 'art/bench/qwen-image-2.1-09-scifi-scale.png',
  z_portrait: 'art/bench/z-image-turbo-02-photoreal-portrait.png',
  z_material: 'art/bench/z-image-turbo-05-material-refraction.png',
  z_chinese: 'art/bench/z-image-turbo-06-chinese-aesthetics.png',
  z_scifi: 'art/bench/z-image-turbo-09-scifi-scale.png',
  anima_anime: 'art/bench/anima-turbo-v1.1-04-anime-action.png',
  anima_diorama: 'art/bench/anima-turbo-v1.1-08-isometric-diorama.png',
  sana_diorama: 'art/bench/sana-sprint-1.6b-08-isometric-diorama.png',
  sdxl_diorama: 'art/bench/sdxl-lightning-08-isometric-diorama.png',
};

export const NINE_DIM = {
  sdxl: 'art/9dim/sdxl-lightning/07-surreal-fusion.webp',
  sana: 'art/9dim/sana-sprint-1.6b/08-isometric-diorama.webp',
  flux4b: 'art/9dim/flux2-klein-4b/03-spatial-binding.webp',
  flux9b: 'art/9dim/flux2-klein-9b/05-material-refraction.webp',
  qwen: 'art/9dim/qwen-image-2.1/01-typography-poster.webp',
  zimage: 'art/9dim/z-image-turbo/09-scifi-scale.webp',
  anima: 'art/9dim/anima-turbo-v1.1/04-anime-action.webp',
  realvis: 'art/9dim/z-image-turbo/02-photoreal-portrait.webp',
  wall: [
    'art/9dim/flux2-klein-9b/05-material-refraction.webp',
    'art/9dim/qwen-image-2.1/08-isometric-diorama.webp',
    'art/9dim/z-image-turbo/09-scifi-scale.webp',
    'art/9dim/anima-turbo-v1.1/04-anime-action.webp',
    'art/9dim/flux2-klein-4b/07-surreal-fusion.webp',
    'art/9dim/sana-sprint-1.6b/06-chinese-aesthetics.webp',
    'art/9dim/flux2-klein-9b/02-photoreal-portrait.webp',
    'art/9dim/qwen-image-2.1/03-spatial-binding.webp',
    'art/9dim/z-image-turbo/05-material-refraction.webp',
    'art/9dim/anima-turbo-v1.1/08-isometric-diorama.webp',
    'art/9dim/sdxl-lightning/09-scifi-scale.webp',
    'art/9dim/flux2-klein-4b/06-chinese-aesthetics.webp',
    'art/9dim/qwen-image-2.1/04-anime-action.webp',
    'art/9dim/flux2-klein-9b/07-surreal-fusion.webp',
    'art/9dim/z-image-turbo/06-chinese-aesthetics.webp',
    'art/9dim/sana-sprint-1.6b/09-scifi-scale.webp',
    'art/9dim/anima-turbo-v1.1/01-typography-poster.webp',
    'art/9dim/flux2-klein-4b/08-isometric-diorama.webp',
  ],
};

export const WORKSHOP_ART = {
  source: 'art/01-workshop-source.png',
  cutout: 'art/02-cutout-birefnet.png',
  albedo: 'art/03-pbr-albedo.png',
  normal: 'art/03-pbr-normal.png',
  roughness: 'art/03-pbr-roughness.png',
  metallic: 'art/03-pbr-metallic.png',
  pixelBefore: 'art/pixel-before.webp',
  pixelAfter: 'art/pixel-after.webp',
  spriteSheet: 'art/sprite-sheet.webp',
  spriteFrames: ['art/sprite-0.webp', 'art/sprite-1.webp', 'art/sprite-2.webp', 'art/sprite-3.webp'],
  tileBefore: 'art/tile-before.webp',
  tileAfter: 'art/tile-after.webp',
  vectorBefore: 'art/vector-before.webp',
  vectorAfter: 'art/vector-after.svg',
};

export const TEXTURES = {
  studioReady: 'textures/studio-ready.png',
  chatComposed: 'textures/chat-composed.png',
  modelPicker: 'textures/model-picker.png',
  workshopPbr: 'textures/workshop-pbr.png',
  workshopCutout: 'textures/workshop-cutout.png',
  studioVideo: 'textures/studio-video.png',
  studioGallery: 'textures/studio-gallery.png',
};

export const Image: React.FC<{ src: string; style?: React.CSSProperties }> = ({ src, style }) => (
  <Img src={staticFile(src)} style={{ display: 'block', ...style }} />
);

export const Backdrop: React.FC<{ dark?: boolean; bg?: string; children: React.ReactNode }> = ({
  dark = false,
  bg,
  children,
}) => (
  <AbsoluteFill
    style={{
      background: bg ?? (dark ? C.ink : C.paper),
      color: dark ? C.paper : C.ink,
      fontFamily: FONT,
      overflow: 'hidden',
    }}
  >
    {children}
  </AbsoluteFill>
);

export const GridField: React.FC<{ dark?: boolean; opacity?: number }> = ({ dark = false, opacity = 0.06 }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      backgroundImage: `linear-gradient(${dark ? '#fff' : '#141416'} 1px, transparent 1px), linear-gradient(90deg, ${dark ? '#fff' : '#141416'} 1px, transparent 1px)`,
      backgroundSize: '64px 64px',
      opacity,
      pointerEvents: 'none',
    }}
  />
);

export const BrandIcon: React.FC<{ size?: number; dark?: boolean; color?: string }> = ({
  size = 52,
  dark = false,
  color,
}) => {
  const stroke = color ?? (dark ? C.paper : C.ink);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
};

export const TopTagBar: React.FC<{ section: string; tag?: string; dark?: boolean }> = ({
  section,
  tag,
  dark = false,
}) => (
  <div
    style={{
      position: 'absolute',
      left: 72,
      right: 72,
      top: 30,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      zIndex: 30,
    }}
  >
    <BrandIcon size={26} dark={dark} />
    <span
      style={{
        fontFamily: FONT,
        fontSize: 20,
        fontWeight: 700,
        letterSpacing: 1.8,
        color: dark ? C.paper : C.ink,
      }}
    >
      AIGC STUDIO
    </span>
    {tag && (
      <span
        style={{
          marginLeft: 8,
          padding: '4px 12px',
          background: dark ? '#27272e' : '#e6e6eb',
          color: dark ? '#c8c8d2' : '#3a3a44',
          fontFamily: MONO,
          fontSize: 15,
          fontWeight: 600,
          clipPath: CLIP.chamfer(7),
        }}
      >
        {tag}
      </span>
    )}
    <span
      style={{
        marginLeft: 'auto',
        fontFamily: MONO,
        fontSize: 18,
        fontWeight: 600,
        letterSpacing: 1,
        color: dark ? '#8d8d98' : '#70707a',
      }}
    >
      {section}
    </span>
  </div>
);

export const Checkerboard: React.FC<{ size?: number; dark?: boolean }> = ({ size = 26, dark = false }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      backgroundColor: dark ? '#202026' : '#f4f4f6',
      backgroundImage: dark
        ? 'linear-gradient(45deg,#2c2c34 25%,transparent 25%),linear-gradient(-45deg,#2c2c34 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2c2c34 75%),linear-gradient(-45deg,transparent 75%,#2c2c34 75%)'
        : 'linear-gradient(45deg,#d6d6dc 25%,transparent 25%),linear-gradient(-45deg,#d6d6dc 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d6d6dc 75%),linear-gradient(-45deg,transparent 75%,#d6d6dc 75%)',
      backgroundSize: `${size}px ${size}px`,
      backgroundPosition: `0 0, 0 ${size / 2}px, ${size / 2}px -${size / 2}px, -${size / 2}px 0`,
    }}
  />
);

/** FUI/HUD 4-corner L-bracket lock-on (reticle-lock-on) */
export const ReticleBrackets: React.FC<{
  progress: number;
  color?: string;
  size?: number;
  thickness?: number;
  spread?: number;
}> = ({ progress, color = C.accent, size = 26, thickness = 3.5, spread = 90 }) => {
  const offset = mix(spread, -4, progress);
  const common: React.CSSProperties = {
    position: 'absolute',
    width: size,
    height: size,
    pointerEvents: 'none',
    opacity: clamp(progress * 2),
  };
  return (
    <>
      <div style={{ ...common, left: offset, top: offset, borderLeft: `${thickness}px solid ${color}`, borderTop: `${thickness}px solid ${color}` }} />
      <div style={{ ...common, right: offset, top: offset, borderRight: `${thickness}px solid ${color}`, borderTop: `${thickness}px solid ${color}` }} />
      <div style={{ ...common, left: offset, bottom: offset, borderLeft: `${thickness}px solid ${color}`, borderBottom: `${thickness}px solid ${color}` }} />
      <div style={{ ...common, right: offset, bottom: offset, borderRight: `${thickness}px solid ${color}`, borderBottom: `${thickness}px solid ${color}` }} />
    </>
  );
};

/** Riso misregistration impact wrapper (misregistration-hit) */
export const RisoHitText: React.FC<{
  frame: number;
  hitAt: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ frame, hitAt, children, style }) => {
  const dt = frame - hitAt;
  const active = dt >= 0 && dt < 7;
  const dx = active ? (dt % 2 === 0 ? 7 : -5) * (1 - dt / 7) : 0;
  const dy = active ? (dt % 3 === 0 ? -3 : 2) * (1 - dt / 7) : 0;
  return (
    <div style={{ position: 'relative', ...style }}>
      {active && (
        <>
          <div style={{ position: 'absolute', inset: 0, color: '#ff3b30', opacity: 0.72, transform: `translate(${dx}px, ${dy}px)`, pointerEvents: 'none', mixBlendMode: 'screen' }}>
            {children}
          </div>
          <div style={{ position: 'absolute', inset: 0, color: '#00d2ff', opacity: 0.72, transform: `translate(${-dx}px, ${-dy}px)`, pointerEvents: 'none', mixBlendMode: 'screen' }}>
            {children}
          </div>
        </>
      )}
      <div style={{ position: 'relative' }}>{children}</div>
    </div>
  );
};

/** Blurred artwork atmospheric backdrop + glow-orb-ambient */
export const BlurredBackdrop: React.FC<{
  src: string;
  frame: number;
  blurPx?: number;
  brightness?: number;
  orbColorA?: string;
  orbColorB?: string;
}> = ({
  src,
  frame,
  blurPx = 38,
  brightness = 0.44,
  orbColorA = 'rgba(232,83,63,0.34)',
  orbColorB = 'rgba(76,124,255,0.28)',
}) => {
  const driftX = Math.sin(frame * 0.03) * 28;
  const driftY = Math.cos(frame * 0.025) * 22;
  const scale = 1.12 + Math.sin(frame * 0.02) * 0.03;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: C.ink, pointerEvents: 'none' }}>
      <Img
        src={staticFile(src)}
        style={{
          position: 'absolute',
          inset: -60,
          width: 'calc(100% + 120px)',
          height: 'calc(100% + 120px)',
          objectFit: 'cover',
          filter: `blur(${blurPx}px) saturate(1.32) brightness(${brightness})`,
          transform: `translate(${driftX}px, ${driftY}px) scale(${scale})`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 120 + Math.sin(frame * 0.035) * 90,
          top: -120 + Math.cos(frame * 0.03) * 60,
          width: 780,
          height: 780,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${orbColorA} 0%, transparent 70%)`,
          filter: 'blur(70px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: 60 + Math.cos(frame * 0.032) * 80,
          bottom: -140 + Math.sin(frame * 0.028) * 60,
          width: 840,
          height: 840,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${orbColorB} 0%, transparent 70%)`,
          filter: 'blur(80px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse 1400px 900px at 50% 45%, transparent 35%, rgba(12,12,16,0.55) 100%)',
        }}
      />
    </div>
  );
};

/** 45-deg glossy sheen sweep overlay (sheen-sweep) */
export const SheenSweep: React.FC<{ frame: number; start: number; duration?: number }> = ({
  frame,
  start,
  duration = 20,
}) => {
  const p = ramp(frame, start, duration, outCubic);
  if (p <= 0 || p >= 1) return null;
  const x = mix(-260, 1100, p);
  return (
    <div
      style={{
        position: 'absolute',
        top: -80,
        bottom: -80,
        left: x,
        width: 140,
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.38), transparent)',
        transform: 'skewX(-28deg)',
        pointerEvents: 'none',
      }}
    />
  );
};
