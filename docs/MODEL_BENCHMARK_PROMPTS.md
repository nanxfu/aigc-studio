# 7 模型 9 维统一盲测提示词（Benchmark Prompts）

为了直观对比 AIGC Studio 内置的 **7 款开源生图模型**（覆盖极速蒸馏、大参数底座、中英双语排版及二次元特化模型）的能力边界，以下 9 组英文提示词对应 **9 个核心评测维度**。

- 真实 GPU 跑出的 7×9 全套原图与元数据 JSON 见 [`bench-results/9dim/`](../bench-results/9dim/)；
- 在线同题 A/B 与 2.4× 放大镜对比见官网 [模型实测页](https://aigc-studio-8rj.pages.dev/models)（或本机运行 `site/` 查看）。

---

## 1. 海报排版与文字渲染（文字准确度与平面设计感）

> 重点观察 `Qwen-Image 2.1`、`FLUX.2 Klein`、`Z-Image Turbo` 与 `SDXL Lightning` 在精准拼写和留白排版上的差距。

```text
A minimalist Swiss-style exhibition poster for a modern coffee festival. Bold geometric shapes in terracotta, cream, and espresso brown. At the top, large clean sans-serif text reads "BREW 2026". At the bottom, smaller crisp text reads "TOKYO ART MUSEUM". Flat vector graphic aesthetic, subtle paper grain texture, balanced negative space.
```

## 2. 极致写实人像与光影（皮肤质感、眼神光与自然度）

> 重点观察人脸是否出现塑料感、过度磨皮，以及自然阴天光的真实度。

```text
Close-up candid portrait of a 60-year-old fisherman on a misty morning dock, weathered skin with fine wrinkles and salt spray, wearing a worn yellow raincoat. Soft overcast natural light, shallow depth of field, shot on 85mm lens, f/1.8, Kodak Portra 400 film grain, hyper-realistic, authentic expression.
```

## 3. 复杂空间关系与指令遵循（方位、数量与属性绑定）

> 重点观察「左、中、右」三个物体的位置是否正确，颜色和材质是否发生串色（例如红色跑到笔记本上）。

```text
A cozy wooden desk photographed from eye level. On the left side sits a red ceramic mug with steam rising from it. In the center is an open vintage leather notebook with a brass fountain pen resting diagonally across the pages. On the right side is a small potted succulent inside a clear glass terrarium. Warm afternoon sunlight casting long shadows from the left.
```

## 4. 二次元动漫与动态构图（画风表现与透视张力）

> 重点观察 `Anima Turbo v1.1` 与通用模型在线条锐利度、赛璐璐上色、透视张力及雨滴动态模糊上的差异。

```text
Masterpiece anime illustration, a young female cyber-courier leaping across neon-lit rooftops in the rain at night, holding a glowing cyan package. Flowing jacket, dynamic low-angle perspective, raindrops frozen in mid-air, vibrant magenta and electric blue reflections, crisp cel-shading, cinematic lighting.
```

## 5. 材质折射与商业静物摄影（玻璃、液体与物理光影）

> 重点观察透明翡翠水晶的折射、焦散光斑以及凝固水花的物理真实感。

```text
High-end commercial product photography of a luxury perfume bottle made of faceted emerald-green crystal, resting on a wet black volcanic stone. A splash of crystal-clear water freezes dramatically behind the bottle, catching sharp studio rim lighting. Crisp reflections, caustic light patterns, ultra-detailed, 8k resolution.
```

## 6. 中式美学与意境细节（东方建筑结构与文化理解）

> 重点观察粉墙黛瓦、乌篷船等中式元素是否出现「日式化」或结构畸变。

```text
An atmospheric ink-wash inspired cinematic scene of a traditional Jiangnan water town at dawn. White-walled houses with dark tiled roofs along a misty canal, a lone wooden rowing boat with a warm glowing paper lantern, willow branches hanging into the water. Subtle teal and gold color palette, serene, poetic, ultra-detailed architectural textures.
```

## 7. 超现实主义与概念融合（跨元素自然过渡）

> 重点观察模型如何将「透明鲸鱼」与「体内发光森林」融合，而不显得生硬拼贴。

```text
A surrealist oil painting of a giant translucent glass whale swimming gracefully through a starry twilight sky above a quiet desert. Inside the whale's glowing body is a miniature lush bioluminescent forest with waterfalls. Dreamlike atmosphere, rich brushstrokes, deep indigo and warm amber contrast, awe-inspiring scale.
```

## 8. 3D 微缩景观与材质质感（等距视角与几何结构）

> 重点观察微缩结构的合理性、柔和全局光照以及黏土/磨砂材质的表现。

```text
Isometric 3D cutaway diorama of a tiny cozy ramen shop inside a giant ceramic ramen bowl. Warm glowing lanterns, miniature chef cooking behind a wooden counter, tiny steam clouds, soft clay and matte plastic textures, Octane render, soft studio global illumination, clean pastel background.
```

## 9. 宏大科幻场景与景深层次（大尺度比例感与体积光）

> 重点观察前景微小人物与巨型建筑/飞船的比例反差，以及大雾和烟尘的空气透视感。

```text
Wide-angle cinematic establishing shot of a colossal brutalist spaceport built into a snowy mountain cliff. A massive weathered cargo spaceship is landing on a lit pad, kicking up clouds of snow and exhaust smoke. Tiny human figures in orange suits on the foreground observation deck for scale. Cinematic cold palette, dramatic volumetric light, atmospheric fog.
```
