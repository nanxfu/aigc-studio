/**
 * 工坊感知测试用的合成图像样本（M4.2c）。
 *
 * 六类场景各一个 256×256 的确定性样本：不依赖真实素材、每次运行结果完全一致，
 * 便于断言「L1 分流是否命中」而不把测试绑到某张图。像素逻辑测试与渲染测试共用同一批样本，
 * 避免两处各写一套构造代码。
 *
 * 每个样本只强调的是**类间可分**的那几条特征（见各函数注释），不是真实素材的还原。
 */

/** 创建可写 RGBA 图像：`set` 逐点写、`fill` 整幅填充，默认 Alpha 255。 */
export function createImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  function set(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const offset = (y * width + x) * 4
    data[offset] = r
    data[offset + 1] = g
    data[offset + 2] = b
    data[offset + 3] = a
  }
  function fill(r, g, b, a = 255) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, r, g, b, a)
    }
  }
  return { width, height, data, set, fill }
}

/** 确定性整数散列：同一坐标每次运行时都是同一个值。 */
export function hash2(x, y, salt = 1) {
  let value = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0
  value = (value ^ (value >>> 13)) * 1274126177
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295
}

const clamp255 = (value) => Math.max(0, Math.min(255, Math.round(value)))

/**
 * 普通风景照：横向渐变的天空 + 地面 + 太阳光斑 + 细碎噪声。
 *
 * 关键特征：色彩极多、外框不纯、纹理细碎、左右两侧差异巨大（四边接不上）、无周期网格。
 */
export function buildPhoto(size = 256) {
  const image = createImage(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const horizon = size * 0.62
      const noise = (hash2(x, y, 3) - 0.5) * 18
      if (y < horizon) {
        const r = 70 + (x / size) * 120 + noise
        const g = 110 + (x / size) * 100 + noise
        const b = 190 + (x / size) * 40 + noise
        image.set(x, y, clamp255(r), clamp255(g), clamp255(b))
      } else {
        const t = (y - horizon) / (size - horizon)
        const r = 90 + t * 90 + noise * 2
        const g = 120 - t * 40 + noise * 2
        const b = 60 + t * 30 + noise
        image.set(x, y, clamp255(r), clamp255(g), clamp255(b))
      }
    }
  }
  const cx = size * 0.76
  const cy = size * 0.2
  const radius = size * 0.11
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - cx, y - cy)
      if (distance > radius) continue
      const blend = 1 - distance / radius
      image.set(x, y, clamp255(255 - 20 * blend), clamp255(240 - 10 * blend), clamp255(180 + 50 * blend))
    }
  }
  return image
}

/**
 * 白底游戏道具：纯白背景 + 居中的径向渐变酒瓶轮廓。
 *
 * 关键特征：外框纯白、主体居中、明暗层次丰富（量化后色桶很多）。
 */
export function buildProp(size = 256) {
  const image = createImage(size, size)
  image.fill(255, 255, 255)
  const cx = size / 2
  const cy = size / 2
  const radiusX = size * 0.24
  const radiusY = size * 0.32
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - cx) / radiusX
      const ny = (y - cy) / radiusY
      const distance = Math.hypot(nx, ny)
      if (distance > 1) continue
      const shade = 1 - distance
      const r = 40 + shade * 170
      const g = 30 + shade * 90
      const b = 110 + shade * 120
      const rim = distance > 0.94 ? 0.6 : 1
      image.set(x, y, clamp255(r * rim), clamp255(g * rim), clamp255(b * rim))
    }
  }
  return image
}

/**
 * 像素画：16×16 个逻辑格、每格放大到 16×16 物理像素，6 色调色盘。
 *
 * 关键特征：强周期网格（cell=16）、极少颜色、几乎全是纯色像素。
 */
export function buildPixelArt(size = 256) {
  const cells = 16
  const cell = size / cells
  const palette = [
    [24, 24, 40],
    [232, 88, 96],
    [248, 200, 96],
    [96, 200, 168],
    [64, 112, 208],
    [248, 248, 248],
  ]
  const image = createImage(size, size)
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const color = palette[(gx * 7 + gy * 13 + ((gx * gy) % 5)) % palette.length]
      for (let y = gy * cell; y < (gy + 1) * cell; y++) {
        for (let x = gx * cell; x < (gx + 1) * cell; x++) {
          image.set(x, y, color[0], color[1], color[2])
        }
      }
    }
  }
  return image
}

/**
 * 4×4 序列帧：每个 64px 格子里画一个动作块，格间留白。
 *
 * 关键特征：横纵两轴都有规整的内部空白格线，格心内容随帧变化。
 */
export function buildSpriteSheet(size = 256) {
  const rows = 4
  const cols = 4
  const cell = size / cols
  const inset = 10
  const image = createImage(size, size)
  image.fill(255, 255, 255)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < cols; column++) {
      const frame = row * cols + column
      const baseX = column * cell + inset
      const baseY = row * cell + inset
      const swing = Math.round((frame % 4) * 2)
      const r = 40 + (frame % 4) * 50
      const g = 160 - (frame % 3) * 30
      const b = 200 - (frame % 5) * 25
      for (let y = 0; y < cell - inset * 2; y++) {
        for (let x = 0; x < cell - inset * 2; x++) {
          // 每帧在块里挖一个随帧移动的缺口，避免整幅图退化成纯色块阵列。
          const inside = x > 6 + swing && x < 30 + swing && y > 6 && y < 30
          if (inside) image.set(baseX + x, baseY + y, 255, 255, 255)
          else image.set(baseX + x, baseY + y, clamp255(r), clamp255(g), clamp255(b))
        }
      }
    }
  }
  return image
}

/**
 * 无缝材质：以 64×64 为周期的平滑砖墙场（叠四个谐波，全部按 64 整除周期）。
 *
 * 关键特征：四边天然接得上（周期整除图幅、边界处连续）、色彩丰富、九宫格能量均匀、
 * 外框不纯。刻意做成平滑场而不是高频噪声：真实的无缝贴图相邻像素是连续的，
 * 纯随机噪声反而接不上；也刻意不放硬边砖缝——硬边会让「首列 vs 末列」的接缝读数虚高。
 */
export function buildTexture(size = 256) {
  const period = 64
  const tau = Math.PI * 2
  const image = createImage(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const rx = (x % period) / period
      const ry = (y % period) / period
      const field = 0.5
        + 0.22 * Math.sin(tau * rx) * Math.cos(tau * ry)
        + 0.14 * Math.sin(tau * 2 * rx + 1.1)
        + 0.1 * Math.cos(tau * 3 * ry + 0.4)
        + 0.06 * Math.sin(tau * 2 * (rx + ry))
        + 0.04 * Math.cos(tau * 4 * (rx - ry) + 2.2)
      image.set(
        x,
        y,
        clamp255(60 + field * 300),
        clamp255(50 + field * 230),
        clamp255(40 + field * 170),
      )
    }
  }
  return image
}

/**
 * 扁平图标：白底上的三块纯色几何形状（圆 / 矩形 / 三角），总共 4 种颜色。
 *
 * 关键特征：极少颜色、色彩高度集中、大量纯色像素、无周期网格。
 */
export function buildIcon(size = 256) {
  const image = createImage(size, size)
  image.fill(255, 255, 255)
  const cx = size * 0.42
  const cy = size * 0.4
  const radius = size * 0.2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - cx, y - cy) <= radius) {
        image.set(x, y, 216, 64, 72)
        continue
      }
      if (x > size * 0.52 && x < size * 0.84 && y > size * 0.56 && y < size * 0.74) {
        image.set(x, y, 44, 92, 196)
        continue
      }
      if (y > size * 0.62 && y < size * 0.86) {
        const half = (y - size * 0.62) * 0.6
        if (Math.abs(x - size * 0.3) <= half) image.set(x, y, 52, 168, 120)
      }
    }
  }
  return image
}

/** 六类样本的清单（含期望场景与主推荐工具），供逻辑测试遍历断言。 */
export const SCENE_SAMPLES = [
  { name: '普通风景照', image: buildPhoto(), scene: 'illustration_or_photo', tool: 'cutout' },
  { name: '白底道具', image: buildProp(), scene: 'isolated_prop', tool: 'cutout' },
  { name: '像素画', image: buildPixelArt(), scene: 'pixel_art', tool: 'pixel-snap' },
  { name: '4×4 序列帧', image: buildSpriteSheet(), scene: 'sprite_sheet', tool: 'sprite-slice' },
  { name: '无缝材质', image: buildTexture(), scene: 'seamless_texture', tool: 'tile' },
  { name: '扁平图标', image: buildIcon(), scene: 'flat_icon_logo', tool: 'vectorize' },
]

/** 按名称取样本。 */
export function sampleByName(name) {
  return SCENE_SAMPLES.find((sample) => sample.name === name) || null
}
