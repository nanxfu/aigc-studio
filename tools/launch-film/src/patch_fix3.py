path = r'D:\document\development\aigc-studio\tools\launch-film\src\scenesA.tsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

# ── 1. 彻底移除 title-demote IIFE，恢复干净的 headline div ──
old_iife_open = """{/* Headline with spotlight-sweep + title-demote-to-label */}
      {(() => {
        const demote = ramp(f, 56, 18, outCubic);
        const titleScale = mix(1, 0.46, demote);
        const titleX = mix(0, -36, demote);
        const titleY = mix(0, -54, demote);
        const titleOpacity = ramp(f, 4, 12) * (f > 100 ? 1 - ramp(f, 100, 10) : 1);
        return (
      <div style={{ position: 'absolute', left: 72, top: 92, opacity: titleOpacity, transform: `translate(${titleX}px, ${titleY}px) scale(${titleScale})`, transformOrigin: 'left top', zIndex: 10 }}>"""

new_iife_open = """{/* Headline with spotlight-sweep */}
      <div style={{ position: 'absolute', left: 72, top: 92, opacity: ramp(f, 4, 12) }}>"""

c = c.replace(old_iife_open, new_iife_open, 1)

# 移除 IIFE 结尾的 ); })()}
old_iife_close = """        </div>
        );
      })()} """
new_iife_close = """        </div>"""
c = c.replace(old_iife_close, new_iife_close, 1)

# ── 2. Bumper 第四张卡：右侧图片换成干净的生成图（不用截图）──
# 现在 Bumper 第四张 card 用的是 TEXTURES.studioReady，
# 换成 ART.botanical（和第一张不同，用 ART.crane 清雅无边界感）
c = c.replace(
    "{ text: '本地运行', sub: '零 Python 依赖', src: TEXTURES.studioReady, bg: C.ink, fg: C.paper, clip: 'none' }",
    "{ text: '本地运行', sub: '零 Python 依赖', src: ART.crane, bg: C.ink, fg: C.paper, clip: 'none' }",
    1
)

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('fix3 done')
