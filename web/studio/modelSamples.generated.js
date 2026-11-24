/**
 * 自动生成文件，请勿手改：由 tools/build-model-samples.mjs 根据 bench-results/9dim/ 生成。
 */

export const SAMPLE_DIMS = [
  {
    "id": "01-typography-poster",
    "index": 1,
    "shortZh": "文字排版",
    "shortEn": "Typography",
    "titleZh": "海报排版与文字渲染",
    "titleEn": "Poster Typography & Layout",
    "focusZh": "精准拼写（BREW 2026 / TOKYO ART MUSEUM）与平面留白",
    "focusEn": "Exact text spelling & Swiss grid negative space",
    "featured": true,
    "seed": 202601
  },
  {
    "id": "02-photoreal-portrait",
    "index": 2,
    "shortZh": "写实人像",
    "shortEn": "Portrait",
    "titleZh": "极致写实人像与光影",
    "titleEn": "Photorealistic Portrait & Light",
    "focusZh": "皮肤皱纹质感、眼神光与自然阴天光真实度",
    "focusEn": "Natural skin texture, catchlights & overcast film realism",
    "featured": true,
    "seed": 202602
  },
  {
    "id": "03-spatial-binding",
    "index": 3,
    "shortZh": "空间遵循",
    "shortEn": "Spatial",
    "titleZh": "复杂空间关系与指令遵循",
    "titleEn": "Spatial Relations & Binding",
    "focusZh": "左红杯、中皮本铜笔、右玻璃多肉的方位与不串色",
    "focusEn": "Left/center/right placement & color-attribute binding",
    "featured": false,
    "seed": 202603
  },
  {
    "id": "04-anime-action",
    "index": 4,
    "shortZh": "二次元动态",
    "shortEn": "Anime",
    "titleZh": "二次元动漫与动态构图",
    "titleEn": "Anime Illustration & Motion",
    "focusZh": "锐利线条、赛璐璐上色、低机位透视与雨滴凝固",
    "focusEn": "Crisp cel-shading, dynamic low-angle & frozen raindrops",
    "featured": true,
    "seed": 202604
  },
  {
    "id": "05-material-refraction",
    "index": 5,
    "shortZh": "材质静物",
    "shortEn": "Product",
    "titleZh": "材质折射与商业静物摄影",
    "titleEn": "Crystal Refraction & Product",
    "focusZh": "翡翠水晶折射、焦散光斑与凝固水花物理质感",
    "focusEn": "Emerald glass refraction, caustics & frozen water splash",
    "featured": true,
    "seed": 202605
  },
  {
    "id": "06-chinese-aesthetics",
    "index": 6,
    "shortZh": "中式美学",
    "shortEn": "Jiangnan",
    "titleZh": "中式美学与意境细节",
    "titleEn": "Chinese Aesthetics & Poetics",
    "focusZh": "粉墙黛瓦、乌篷船灯笼的东方建筑结构与意境",
    "focusEn": "Jiangnan architecture authenticity & ink-wash atmosphere",
    "featured": false,
    "seed": 202606
  },
  {
    "id": "07-surreal-fusion",
    "index": 7,
    "shortZh": "超现实融合",
    "shortEn": "Surreal",
    "titleZh": "超现实主义与概念融合",
    "titleEn": "Surrealist Concept Fusion",
    "focusZh": "透明玻璃鲸鱼与体内发光森林的无缝自然过渡",
    "focusEn": "Seamless fusion of glass whale and bioluminescent forest",
    "featured": false,
    "seed": 202607
  },
  {
    "id": "08-isometric-diorama",
    "index": 8,
    "shortZh": "3D 微缩",
    "shortEn": "3D Diorama",
    "titleZh": "3D 微缩景观与材质质感",
    "titleEn": "Isometric 3D Diorama",
    "focusZh": "等距剖面结构合理性、柔和全局光与黏土磨砂质感",
    "focusEn": "Isometric cutaway geometry, soft GI & clay/matte textures",
    "featured": false,
    "seed": 202608
  },
  {
    "id": "09-scifi-scale",
    "index": 9,
    "shortZh": "宏大科幻",
    "shortEn": "Sci-Fi Scale",
    "titleZh": "宏大科幻场景与景深层次",
    "titleEn": "Colossal Sci-Fi Establishing",
    "focusZh": "微小人物与巨型建筑比例反差、体积光与空气透视",
    "focusEn": "Monumental scale contrast, volumetric light & fog depth",
    "featured": false,
    "seed": 202609
  }
]

export const MODEL_SAMPLES = {
  "sdxl-lightning": {
    "01-typography-poster": {
      "url": "/model-samples/sdxl-lightning/01-typography-poster.webp",
      "seconds": 11.2,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "02-photoreal-portrait": {
      "url": "/model-samples/sdxl-lightning/02-photoreal-portrait.webp",
      "seconds": 6,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "03-spatial-binding": {
      "url": "/model-samples/sdxl-lightning/03-spatial-binding.webp",
      "seconds": 6.1,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "04-anime-action": {
      "url": "/model-samples/sdxl-lightning/04-anime-action.webp",
      "seconds": 6.2,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "05-material-refraction": {
      "url": "/model-samples/sdxl-lightning/05-material-refraction.webp",
      "seconds": 6.3,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "06-chinese-aesthetics": {
      "url": "/model-samples/sdxl-lightning/06-chinese-aesthetics.webp",
      "seconds": 6.4,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "07-surreal-fusion": {
      "url": "/model-samples/sdxl-lightning/07-surreal-fusion.webp",
      "seconds": 6.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "08-isometric-diorama": {
      "url": "/model-samples/sdxl-lightning/08-isometric-diorama.webp",
      "seconds": 6.6,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "09-scifi-scale": {
      "url": "/model-samples/sdxl-lightning/09-scifi-scale.webp",
      "seconds": 6.8,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    }
  },
  "sana-sprint-1.6b": {
    "01-typography-poster": {
      "url": "/model-samples/sana-sprint-1.6b/01-typography-poster.webp",
      "seconds": 7.8,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "02-photoreal-portrait": {
      "url": "/model-samples/sana-sprint-1.6b/02-photoreal-portrait.webp",
      "seconds": 7.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "03-spatial-binding": {
      "url": "/model-samples/sana-sprint-1.6b/03-spatial-binding.webp",
      "seconds": 7.7,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "04-anime-action": {
      "url": "/model-samples/sana-sprint-1.6b/04-anime-action.webp",
      "seconds": 8.1,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "05-material-refraction": {
      "url": "/model-samples/sana-sprint-1.6b/05-material-refraction.webp",
      "seconds": 8.3,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "06-chinese-aesthetics": {
      "url": "/model-samples/sana-sprint-1.6b/06-chinese-aesthetics.webp",
      "seconds": 8.1,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "07-surreal-fusion": {
      "url": "/model-samples/sana-sprint-1.6b/07-surreal-fusion.webp",
      "seconds": 7.6,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "08-isometric-diorama": {
      "url": "/model-samples/sana-sprint-1.6b/08-isometric-diorama.webp",
      "seconds": 7.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "09-scifi-scale": {
      "url": "/model-samples/sana-sprint-1.6b/09-scifi-scale.webp",
      "seconds": 7.7,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    }
  },
  "z-image-turbo": {
    "01-typography-poster": {
      "url": "/model-samples/z-image-turbo/01-typography-poster.webp",
      "seconds": 55.7,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "02-photoreal-portrait": {
      "url": "/model-samples/z-image-turbo/02-photoreal-portrait.webp",
      "seconds": 33.3,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "03-spatial-binding": {
      "url": "/model-samples/z-image-turbo/03-spatial-binding.webp",
      "seconds": 31,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "04-anime-action": {
      "url": "/model-samples/z-image-turbo/04-anime-action.webp",
      "seconds": 30.3,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "05-material-refraction": {
      "url": "/model-samples/z-image-turbo/05-material-refraction.webp",
      "seconds": 30.4,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "06-chinese-aesthetics": {
      "url": "/model-samples/z-image-turbo/06-chinese-aesthetics.webp",
      "seconds": 30.4,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "07-surreal-fusion": {
      "url": "/model-samples/z-image-turbo/07-surreal-fusion.webp",
      "seconds": 30.7,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "08-isometric-diorama": {
      "url": "/model-samples/z-image-turbo/08-isometric-diorama.webp",
      "seconds": 30.5,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "09-scifi-scale": {
      "url": "/model-samples/z-image-turbo/09-scifi-scale.webp",
      "seconds": 30.6,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    }
  },
  "qwen-image-2.1": {
    "01-typography-poster": {
      "url": "/model-samples/qwen-image-2.1/01-typography-poster.webp",
      "seconds": 115.1,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "02-photoreal-portrait": {
      "url": "/model-samples/qwen-image-2.1/02-photoreal-portrait.webp",
      "seconds": 42.4,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "03-spatial-binding": {
      "url": "/model-samples/qwen-image-2.1/03-spatial-binding.webp",
      "seconds": 42.2,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "04-anime-action": {
      "url": "/model-samples/qwen-image-2.1/04-anime-action.webp",
      "seconds": 42.1,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "05-material-refraction": {
      "url": "/model-samples/qwen-image-2.1/05-material-refraction.webp",
      "seconds": 41.9,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "06-chinese-aesthetics": {
      "url": "/model-samples/qwen-image-2.1/06-chinese-aesthetics.webp",
      "seconds": 42.1,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "07-surreal-fusion": {
      "url": "/model-samples/qwen-image-2.1/07-surreal-fusion.webp",
      "seconds": 42.1,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "08-isometric-diorama": {
      "url": "/model-samples/qwen-image-2.1/08-isometric-diorama.webp",
      "seconds": 42.2,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "09-scifi-scale": {
      "url": "/model-samples/qwen-image-2.1/09-scifi-scale.webp",
      "seconds": 42.4,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    }
  },
  "flux2-klein-4b": {
    "01-typography-poster": {
      "url": "/model-samples/flux2-klein-4b/01-typography-poster.webp",
      "seconds": 11.9,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "02-photoreal-portrait": {
      "url": "/model-samples/flux2-klein-4b/02-photoreal-portrait.webp",
      "seconds": 12.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "03-spatial-binding": {
      "url": "/model-samples/flux2-klein-4b/03-spatial-binding.webp",
      "seconds": 11.9,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "04-anime-action": {
      "url": "/model-samples/flux2-klein-4b/04-anime-action.webp",
      "seconds": 11.3,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "05-material-refraction": {
      "url": "/model-samples/flux2-klein-4b/05-material-refraction.webp",
      "seconds": 11.3,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "06-chinese-aesthetics": {
      "url": "/model-samples/flux2-klein-4b/06-chinese-aesthetics.webp",
      "seconds": 11.7,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "07-surreal-fusion": {
      "url": "/model-samples/flux2-klein-4b/07-surreal-fusion.webp",
      "seconds": 11.8,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "08-isometric-diorama": {
      "url": "/model-samples/flux2-klein-4b/08-isometric-diorama.webp",
      "seconds": 11.6,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "09-scifi-scale": {
      "url": "/model-samples/flux2-klein-4b/09-scifi-scale.webp",
      "seconds": 11.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    }
  },
  "flux2-klein-9b": {
    "01-typography-poster": {
      "url": "/model-samples/flux2-klein-9b/01-typography-poster.webp",
      "seconds": 127.2,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "02-photoreal-portrait": {
      "url": "/model-samples/flux2-klein-9b/02-photoreal-portrait.webp",
      "seconds": 39.3,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "03-spatial-binding": {
      "url": "/model-samples/flux2-klein-9b/03-spatial-binding.webp",
      "seconds": 39.2,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "04-anime-action": {
      "url": "/model-samples/flux2-klein-9b/04-anime-action.webp",
      "seconds": 39,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "05-material-refraction": {
      "url": "/model-samples/flux2-klein-9b/05-material-refraction.webp",
      "seconds": 39,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "06-chinese-aesthetics": {
      "url": "/model-samples/flux2-klein-9b/06-chinese-aesthetics.webp",
      "seconds": 38.9,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "07-surreal-fusion": {
      "url": "/model-samples/flux2-klein-9b/07-surreal-fusion.webp",
      "seconds": 38.5,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "08-isometric-diorama": {
      "url": "/model-samples/flux2-klein-9b/08-isometric-diorama.webp",
      "seconds": 38.7,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    },
    "09-scifi-scale": {
      "url": "/model-samples/flux2-klein-9b/09-scifi-scale.webp",
      "seconds": 38.6,
      "width": 1024,
      "height": 1024,
      "provider": "colab",
      "device": "NVIDIA L4"
    }
  },
  "anima-turbo-v1.1": {
    "01-typography-poster": {
      "url": "/model-samples/anima-turbo-v1.1/01-typography-poster.webp",
      "seconds": 19.9,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "02-photoreal-portrait": {
      "url": "/model-samples/anima-turbo-v1.1/02-photoreal-portrait.webp",
      "seconds": 19.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "03-spatial-binding": {
      "url": "/model-samples/anima-turbo-v1.1/03-spatial-binding.webp",
      "seconds": 18.8,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "04-anime-action": {
      "url": "/model-samples/anima-turbo-v1.1/04-anime-action.webp",
      "seconds": 19.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "05-material-refraction": {
      "url": "/model-samples/anima-turbo-v1.1/05-material-refraction.webp",
      "seconds": 19.4,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "06-chinese-aesthetics": {
      "url": "/model-samples/anima-turbo-v1.1/06-chinese-aesthetics.webp",
      "seconds": 19.3,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "07-surreal-fusion": {
      "url": "/model-samples/anima-turbo-v1.1/07-surreal-fusion.webp",
      "seconds": 19.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "08-isometric-diorama": {
      "url": "/model-samples/anima-turbo-v1.1/08-isometric-diorama.webp",
      "seconds": 19.5,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    },
    "09-scifi-scale": {
      "url": "/model-samples/anima-turbo-v1.1/09-scifi-scale.webp",
      "seconds": 19.2,
      "width": 1024,
      "height": 1024,
      "provider": "kaggle",
      "device": "Tesla T4"
    }
  }
}
