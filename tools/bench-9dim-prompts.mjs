/**
 * 7 模型 × 9 核心评测维度统一盲测清单（单一真源）。
 * 供 tools/bench-9dim.mjs 与 tools/build-model-samples.mjs 共用。
 */

export const BENCH_DIMS = Object.freeze([
  {
    id: '01-typography-poster',
    index: 1,
    shortZh: '文字排版',
    shortEn: 'Typography',
    titleZh: '海报排版与文字渲染',
    titleEn: 'Poster Typography & Layout',
    focusZh: '精准拼写（BREW 2026 / TOKYO ART MUSEUM）与平面留白',
    focusEn: 'Exact text spelling & Swiss grid negative space',
    featured: true,
    seed: 202601,
    prompt:
      'A minimalist Swiss-style exhibition poster for a modern coffee festival. Bold geometric shapes in terracotta, cream, and espresso brown. At the top, large clean sans-serif text reads "BREW 2026". At the bottom, smaller crisp text reads "TOKYO ART MUSEUM". Flat vector graphic aesthetic, subtle paper grain texture, balanced negative space.',
  },
  {
    id: '02-photoreal-portrait',
    index: 2,
    shortZh: '写实人像',
    shortEn: 'Portrait',
    titleZh: '极致写实人像与光影',
    titleEn: 'Photorealistic Portrait & Light',
    focusZh: '皮肤皱纹质感、眼神光与自然阴天光真实度',
    focusEn: 'Natural skin texture, catchlights & overcast film realism',
    featured: true,
    seed: 202602,
    prompt:
      'Close-up candid portrait of a 60-year-old fisherman on a misty morning dock, weathered skin with fine wrinkles and salt spray, wearing a worn yellow raincoat. Soft overcast natural light, shallow depth of field, shot on 85mm lens, f/1.8, Kodak Portra 400 film grain, hyper-realistic, authentic expression.',
  },
  {
    id: '03-spatial-binding',
    index: 3,
    shortZh: '空间遵循',
    shortEn: 'Spatial',
    titleZh: '复杂空间关系与指令遵循',
    titleEn: 'Spatial Relations & Binding',
    focusZh: '左红杯、中皮本铜笔、右玻璃多肉的方位与不串色',
    focusEn: 'Left/center/right placement & color-attribute binding',
    featured: false,
    seed: 202603,
    prompt:
      'A cozy wooden desk photographed from eye level. On the left side sits a red ceramic mug with steam rising from it. In the center is an open vintage leather notebook with a brass fountain pen resting diagonally across the pages. On the right side is a small potted succulent inside a clear glass terrarium. Warm afternoon sunlight casting long shadows from the left.',
  },
  {
    id: '04-anime-action',
    index: 4,
    shortZh: '二次元动态',
    shortEn: 'Anime',
    titleZh: '二次元动漫与动态构图',
    titleEn: 'Anime Illustration & Motion',
    focusZh: '锐利线条、赛璐璐上色、低机位透视与雨滴凝固',
    focusEn: 'Crisp cel-shading, dynamic low-angle & frozen raindrops',
    featured: true,
    seed: 202604,
    prompt:
      'Masterpiece anime illustration, a young female cyber-courier leaping across neon-lit rooftops in the rain at night, holding a glowing cyan package. Flowing jacket, dynamic low-angle perspective, raindrops frozen in mid-air, vibrant magenta and electric blue reflections, crisp cel-shading, cinematic lighting.',
  },
  {
    id: '05-material-refraction',
    index: 5,
    shortZh: '材质静物',
    shortEn: 'Product',
    titleZh: '材质折射与商业静物摄影',
    titleEn: 'Crystal Refraction & Product',
    focusZh: '翡翠水晶折射、焦散光斑与凝固水花物理质感',
    focusEn: 'Emerald glass refraction, caustics & frozen water splash',
    featured: true,
    seed: 202605,
    prompt:
      'High-end commercial product photography of a luxury perfume bottle made of faceted emerald-green crystal, resting on a wet black volcanic stone. A splash of crystal-clear water freezes dramatically behind the bottle, catching sharp studio rim lighting. Crisp reflections, caustic light patterns, ultra-detailed, 8k resolution.',
  },
  {
    id: '06-chinese-aesthetics',
    index: 6,
    shortZh: '中式美学',
    shortEn: 'Jiangnan',
    titleZh: '中式美学与意境细节',
    titleEn: 'Chinese Aesthetics & Poetics',
    focusZh: '粉墙黛瓦、乌篷船灯笼的东方建筑结构与意境',
    focusEn: 'Jiangnan architecture authenticity & ink-wash atmosphere',
    featured: false,
    seed: 202606,
    prompt:
      'An atmospheric ink-wash inspired cinematic scene of a traditional Jiangnan water town at dawn. White-walled houses with dark tiled roofs along a misty canal, a lone wooden rowing boat with a warm glowing paper lantern, willow branches hanging into the water. Subtle teal and gold color palette, serene, poetic, ultra-detailed architectural textures.',
  },
  {
    id: '07-surreal-fusion',
    index: 7,
    shortZh: '超现实融合',
    shortEn: 'Surreal',
    titleZh: '超现实主义与概念融合',
    titleEn: 'Surrealist Concept Fusion',
    focusZh: '透明玻璃鲸鱼与体内发光森林的无缝自然过渡',
    focusEn: 'Seamless fusion of glass whale and bioluminescent forest',
    featured: false,
    seed: 202607,
    prompt:
      "A surrealist oil painting of a giant translucent glass whale swimming gracefully through a starry twilight sky above a quiet desert. Inside the whale's glowing body is a miniature lush bioluminescent forest with waterfalls. Dreamlike atmosphere, rich brushstrokes, deep indigo and warm amber contrast, awe-inspiring scale.",
  },
  {
    id: '08-isometric-diorama',
    index: 8,
    shortZh: '3D 微缩',
    shortEn: '3D Diorama',
    titleZh: '3D 微缩景观与材质质感',
    titleEn: 'Isometric 3D Diorama',
    focusZh: '等距剖面结构合理性、柔和全局光与黏土磨砂质感',
    focusEn: 'Isometric cutaway geometry, soft GI & clay/matte textures',
    featured: false,
    seed: 202608,
    prompt:
      'Isometric 3D cutaway diorama of a tiny cozy ramen shop inside a giant ceramic ramen bowl. Warm glowing lanterns, miniature chef cooking behind a wooden counter, tiny steam clouds, soft clay and matte plastic textures, Octane render, soft studio global illumination, clean pastel background.',
  },
  {
    id: '09-scifi-scale',
    index: 9,
    shortZh: '宏大科幻',
    shortEn: 'Sci-Fi Scale',
    titleZh: '宏大科幻场景与景深层次',
    titleEn: 'Colossal Sci-Fi Establishing',
    focusZh: '微小人物与巨型建筑比例反差、体积光与空气透视',
    focusEn: 'Monumental scale contrast, volumetric light & fog depth',
    featured: false,
    seed: 202609,
    prompt:
      'Wide-angle cinematic establishing shot of a colossal brutalist spaceport built into a snowy mountain cliff. A massive weathered cargo spaceship is landing on a lit pad, kicking up clouds of snow and exhaust smoke. Tiny human figures in orange suits on the foreground observation deck for scale. Cinematic cold palette, dramatic volumetric light, atmospheric fog.',
  },
])

export const KAGGLE_MODELS = Object.freeze([
  'sdxl-lightning',
  'sana-sprint-1.6b',
  'anima-turbo-v1.1',
  'flux2-klein-4b',
])

export const COLAB_MODELS = Object.freeze([
  'z-image-turbo',
  'qwen-image-2.1',
  'flux2-klein-9b',
])

/** 每个模型挑一张最具代表性的实测图做 56×56 卡片海报。 */
export const POSTER_DIM_BY_MODEL = Object.freeze({
  'sdxl-lightning': '09-scifi-scale',
  'sana-sprint-1.6b': '08-isometric-diorama',
  'z-image-turbo': '02-photoreal-portrait',
  'qwen-image-2.1': '01-typography-poster',
  'flux2-klein-4b': '05-material-refraction',
  'flux2-klein-9b': '07-surreal-fusion',
  'anima-turbo-v1.1': '04-anime-action',
})
