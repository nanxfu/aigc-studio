path_a = r'D:\document\development\aigc-studio\tools\launch-film\src\scenesA.tsx'
with open(path_a, 'r', encoding='utf-8') as f:
    c = f.read()

# ── 1. 确保 "说个大概" 标题没有缩小动画（移除任何 demote 残留）──
# 把 opacity: ramp(f, 4, 12) 保持不变，确认没有 transform
# 检查并还原为干净的无 transform 版本
old_title = "      <div style={{ position: 'absolute', left: 72, top: 92, opacity: ramp(f, 4, 12) }}>"
new_title = "      <div style={{ position: 'absolute', left: 72, top: 92, opacity: ramp(f, 4, 12) }}>"
# 只是确认存在，不改

# ── 2. 替换 tile 展示区：用 tile-seamed.svg + tile-seamless.svg ──
# 移除之前的 workshop-tile-new.png 方案，换成两个 SVG 并排 + 箭头
old_tile = """        <div style={{ position: 'relative', width: 250, height: 250, clipPath: CLIP.chamfer(14), overflow: 'hidden' }}>
          <Image src={WORKSHOP_ART.tileBefore} style={{ position: 'absolute', inset: 0, width: 250, height: 250, objectFit: 'cover', opacity: 1 - tileMix }} />
          <Image src={WORKSHOP_ART.tileScreenshot} style={{ position: 'absolute', inset: 0, width: 250, height: 250, objectFit: 'cover', objectPosition: 'center top', opacity: tileMix }} />
        </div>"""

new_tile = """        <div style={{ position: 'relative', width: 250, height: 250, display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* 有缝 SVG */}
          <div style={{ flex: 1, position: 'relative', opacity: 1 - tileMix * 0.5 }}>
            <Image src="art/tile-seamed.svg" style={{ width: 100, height: 100, clipPath: CLIP.chamfer(10), display: 'block' }} />
            <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, color: C.secondary, textAlign: 'center' }}>有缝</div>
          </div>
          {/* 箭头 */}
          <svg width="28" height="20" viewBox="0 0 28 20" style={{ flexShrink: 0 }}>
            <path d={`M2 10 L${mix(2, 22, tileMix)} 10 M${mix(14, 18, tileMix)} 4 L${mix(14, 26, tileMix)} 10 L${mix(14, 18, tileMix)} 16`}
              stroke={tileMix > 0.5 ? C.mint : C.accent} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round"
              opacity={Math.max(0.3, tileMix)}
            />
          </svg>
          {/* 无缝 SVG */}
          <div style={{ flex: 1, position: 'relative', opacity: 0.3 + tileMix * 0.7 }}>
            <Image src="art/tile-seamless.svg" style={{ width: 100, height: 100, clipPath: CLIP.chamfer(10), display: 'block' }} />
            <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 11, color: tileMix > 0.5 ? C.mint : C.secondary, textAlign: 'center' }}>无缝</div>
          </div>
        </div>"""

c = c.replace(old_tile, new_tile, 1)

with open(path_a, 'w', encoding='utf-8') as f:
    f.write(c)
print('fix2 done')
