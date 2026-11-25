path = r'D:\document\development\aigc-studio\tools\launch-film\src\visuals.tsx'
with open(path, 'r', encoding='utf-8') as f:
    c = f.read()

old = "  tileBefore: 'art/tile-before.webp',\n  tileAfter: 'art/tile-after.webp',"
new = "  tileBefore: 'art/tile-before.webp',\n  tileAfter: 'art/tile-after.webp',\n  tileScreenshot: 'art/workshop-tile-new.png',\n  cutoutScreenshot: 'art/workshop-cutout-new.png',"
c = c.replace(old, new, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('visuals patched')
