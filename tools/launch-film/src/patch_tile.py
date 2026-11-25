path = r'D:\document\development\aigc-studio\tools\launch-film\src\scenesA.tsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

old = """        <div style={{ position: 'relative', width: 250, height: 250, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', overflow: 'hidden', clipPath: CLIP.chamfer(14) }}>
          {[0, 1, 2, 3].map((idx) => (
            <div key={idx} style={{ position: 'relative', width: 125, height: 125 }}>
              <Image src={WORKSHOP_ART.tileBefore} style={{ position: 'absolute', inset: 0, width: 125, height: 125, objectFit: 'cover', opacity: 1 - tileMix }} />
              <Image src={WORKSHOP_ART.tileAfter} style={{ position: 'absolute', inset: 0, width: 125, height: 125, objectFit: 'cover', opacity: tileMix }} />
            </div>
          ))}
          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 2, background: tileMix > 0.6 ? C.mint : C.accent }} />
          <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 2, background: tileMix > 0.6 ? C.mint : C.accent }} />
        </div>"""

new = """        <div style={{ position: 'relative', width: 250, height: 250, clipPath: CLIP.chamfer(14), overflow: 'hidden' }}>
          <Image src={WORKSHOP_ART.tileBefore} style={{ position: 'absolute', inset: 0, width: 250, height: 250, objectFit: 'cover', opacity: 1 - tileMix }} />
          <Image src={WORKSHOP_ART.tileScreenshot} style={{ position: 'absolute', inset: 0, width: 250, height: 250, objectFit: 'cover', objectPosition: 'center top', opacity: tileMix }} />
        </div>"""

c = c.replace(old, new, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('tile replaced')
