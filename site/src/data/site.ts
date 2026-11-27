const rawSiteUrl = (import.meta.env.PUBLIC_SITE_URL || 'https://aigc-studio-8rj.pages.dev').trim().replace(/\/+$/, '');

export const SITE = {
  name: 'AIGC Studio',
  domain: rawSiteUrl,
  github: 'https://github.com/nanxfu/aigc-studio',
  releases: 'https://github.com/nanxfu/aigc-studio/releases',
  latestRelease: 'https://github.com/nanxfu/aigc-studio/releases/latest',
  version: '0.16.0',
  license: 'MIT',
  title: 'AIGC Studio — 本地桌面生图工作台',
  description:
    '在本地管理提示词、图片和版本；按需调用云端 GPU，运行 7 款开源生图模型。原图与导出文件保存在自己的硬盘。',
};

export const DOWNLOAD = {
  winInstallerName: `aigc-studio-${SITE.version}-x64.exe`,
  winPortableName: `aigc-studio-${SITE.version}-portable.exe`,
  winUrl: SITE.latestRelease,
  sourceUrl: `${SITE.github}#readme`,
  platformsNote: '安装包目前仅提供 Windows x64（安装版 / 便携版）；macOS 与 Linux 可通过 Node 20+ 从源码运行。',
};

export interface GuideMeta {
  slug: string;
  path: string;
  tag: string;
  title: string;
  shortTitle: string;
  description: string;
  readTime: string;
  audience: string;
}

export const GUIDES: GuideMeta[] = [
  {
    slug: 'free-gpu-no-comfyui',
    path: '/guides/free-gpu-no-comfyui',
    tag: 'ARCHITECTURE',
    title: '无独立显卡运行开源生图模型指南',
    shortTitle: '免显卡上手指南',
    description: '用轻薄本或核显电脑运行开源模型：不用独立显卡和 Python 环境，连接 Kaggle 或 Colab，生成结果会保存回本地。',
    readTime: '4 分钟',
    audience: '无独显 / 轻薄本创作者',
  },
  {
    slug: 'aigc-studio-vs-comfyui',
    path: '/guides/aigc-studio-vs-comfyui',
    tag: 'COMPARISON',
    title: 'AIGC Studio 与 ComfyUI 选型对照',
    shortTitle: 'vs ComfyUI 选型',
    description: '对比显卡要求、环境维护、参数控制和后处理，帮助你判断 AIGC Studio 与 ComfyUI 哪个更适合当前任务。',
    readTime: '5 分钟',
    audience: '开源生图选型评估者',
  },
  {
    slug: 'ai-pixel-art-sprite',
    path: '/guides/ai-pixel-art-sprite',
    tag: 'GAME ASSET',
    title: '游戏像素画网格对齐与序列帧 Atlas 导出',
    shortTitle: '像素对齐与序列帧',
    description: '在本机修复像素画的虚边、混色和网格偏移，预览每一帧，并将图集和 atlas.json 一起导出。',
    readTime: '5 分钟',
    audience: '独立游戏开发者 / 美术',
  },
  {
    slug: 'ai-image-to-svg',
    path: '/guides/ai-image-to-svg',
    tag: 'VECTOR',
    title: '本机零显存将 AI 插画转换为可编辑 SVG',
    shortTitle: '本地转 SVG 矢量',
    description: '用本机 WASM 版 VTracer 将扁平插画、图标和徽章转成可编辑 SVG，不占显存，也不会上传文件。',
    readTime: '4 分钟',
    audience: '平面设计师 / UI 设计师',
  },
  {
    slug: 'mcp-claude-cursor-image',
    path: '/guides/mcp-claude-cursor-image',
    tag: 'AGENT / MCP',
    title: '通过 MCP 让 Claude Desktop / Cursor 调用本地生图',
    shortTitle: 'MCP 接入 Agent',
    description: '按三步配置内置 MCP Server，让 Claude Desktop 或 Cursor 使用同一会话、队列和本地 outputs 目录。',
    readTime: '6 分钟',
    audience: '开发者 / AI 工作流用户',
  },
];

export interface ModelSpec {
  id: string;
  label: string;
  shortTag: string;
  params: string;
  steps: string;
  steadySec: string;
  secNum: number;
  vram: string;
  vramNum: number;
  license: string;
  commercial: boolean;
  zhSupport: boolean;
  kaggleReady: boolean;
  providers: string;
  bestFor: string;
  summary: string;
  showcase: {
    image: string;
    title: string;
    size: string;
    measuredSec: string;
    prompt: string;
    pos?: string;
  };
}

export const MODELS: ModelSpec[] = [
  {
    id: 'flux2-klein-4b',
    label: 'FLUX.2 Klein 4B',
    shortTag: '平面海报',
    params: '3.88B',
    steps: '4 步',
    steadySec: '10.2s',
    secNum: 10.2,
    vram: '7.9 GB',
    vramNum: 7.9,
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: true,
    kaggleReady: true,
    providers: 'Kaggle / Colab / 私有 GPU',
    bestFor: '平面海报、商业质感、参考图控制',
    summary: '4 步出图，支持中英文提示词和参考图；Apache-2.0，可商用。',
    showcase: {
      image: '/assets/showcase/flux2-klein-4b-kyoto-poster.webp',
      title: '京都旅行海报',
      size: '1152 × 640',
      measuredSec: '6.8s',
      prompt: '极简京都旅行海报，红色鸟居与竹林晨雾，顶部 KYOTO 无衬线大字，扁平矢量插画',
      pos: '50% 45%',
    },
  },
  {
    id: 'sdxl-lightning',
    label: 'SDXL Lightning',
    shortTag: '日常主力',
    params: '3.5B',
    steps: '4 步',
    steadySec: '6.2s',
    secNum: 6.2,
    vram: '10.3 GB',
    vramNum: 10.3,
    license: 'OpenRAIL++',
    commercial: true,
    zhSupport: false,
    kaggleReady: true,
    providers: 'Kaggle / Colab / 私有 GPU',
    bestFor: '日常出图、局部重绘、图生图',
    summary: '单张约 6 秒，适合日常出图；支持局部重绘和图生图。',
    showcase: {
      image: '/assets/showcase/sdxl-lightning-cyberpunk-street.webp',
      title: '雨夜霓虹街道',
      size: '1152 × 648',
      measuredSec: '9.8s',
      prompt: '雨夜霓虹街道，湿润地面反射青绿与品红招牌，远处撑伞行人，电影感宽画幅',
      pos: '50% 50%',
    },
  },
  {
    id: 'qwen-image-2.1',
    label: 'Qwen-Image 2.1',
    shortTag: '中文排版',
    params: '7B DiT',
    steps: '8 步',
    steadySec: '43.7s',
    secNum: 43.7,
    vram: '16.8 GB',
    vramNum: 16.8,
    license: 'Qwen Research',
    commercial: false,
    zhSupport: true,
    kaggleReady: false,
    providers: 'Colab / 私有 GPU',
    bestFor: '中文海报、文字渲染、多图编辑',
    summary: '中英文文字渲染和版式控制较好，适合海报与封面。',
    showcase: {
      image: '/assets/showcase/qwen-image-2.1-botanica-poster.webp',
      title: '温室植物志',
      size: '768 × 1024',
      measuredSec: '39.2s',
      prompt: '暖白纸面极简植物志海报，阳光拱形玻璃温室，顶部大字 BOTANICA 与「温室植物志」',
      pos: '50% 8%',
    },
  },
  {
    id: 'anima-turbo-v1.1',
    label: 'Anima Turbo v1.1',
    shortTag: '二次元',
    params: '2B DiT',
    steps: '10 步',
    steadySec: '21.6s',
    secNum: 21.6,
    vram: '8.5 GB',
    vramNum: 8.5,
    license: 'Non-Commercial',
    commercial: false,
    zhSupport: false,
    kaggleReady: true,
    providers: 'Kaggle / Colab / 私有 GPU',
    bestFor: '动漫角色、插画光影',
    summary: '适合二次元角色和插画；支持自然语言与标签写法，显存占用较低。',
    showcase: {
      image: '/assets/showcase/anima-turbo-v1.1-seaside-station.webp',
      title: '黄昏海边站台',
      size: '768 × 1024',
      measuredSec: '9.8s',
      prompt: '银发蓝眼水手服少女站在黄昏空旷海边站台，橙紫晚霞与逆光发丝，赛璐璐插画',
      pos: '50% 10%',
    },
  },
  {
    id: 'z-image-turbo',
    label: 'Z-Image Turbo',
    shortTag: '写实街景',
    params: '6B S3-DiT',
    steps: '9 步',
    steadySec: '30.7s',
    secNum: 30.7,
    vram: '12.2 GB',
    vramNum: 12.2,
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: true,
    kaggleReady: false,
    providers: 'Colab / 私有 GPU',
    bestFor: '写实摄影、中文招牌、局部重绘',
    summary: '适合写实摄影和自然光影；支持中文提示词与局部重绘，Apache-2.0，可商用。',
    showcase: {
      image: '/assets/showcase/z-image-turbo-alley-bookstore.webp',
      title: '雨巷旧书店',
      size: '768 × 1024',
      measuredSec: '29.2s',
      prompt: '蓝调时刻雨后石板巷里的旧书店，木格窗透出暖黄灯光，灯笼手写「旧书与茶」',
      pos: '50% 35%',
    },
  },
  {
    id: 'sana-sprint-1.6b',
    label: 'SANA-Sprint 1.6B',
    shortTag: '极速起稿',
    params: '1.6B',
    steps: '2 步',
    steadySec: '4.1s',
    secNum: 4.1,
    vram: '10.3 GB',
    vramNum: 10.3,
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: false,
    kaggleReady: true,
    providers: 'Kaggle / Colab / 私有 GPU',
    bestFor: '快速起稿、水墨国风、构图试错',
    summary: '2 步生成 1024px 图像，约 4 秒一张，适合先确定构图。',
    showcase: {
      image: '/assets/showcase/sana-sprint-1.6b-crane-pond.webp',
      title: '晨间荷塘',
      size: '1024 × 1024',
      measuredSec: '4.1s',
      prompt: '晨雾荷塘中的丹顶鹤，水墨写意风格，柔和晨光与细腻笔触',
      pos: '50% 45%',
    },
  },
  {
    id: 'flux2-klein-9b',
    label: 'FLUX.2 Klein 9B',
    shortTag: '静物材质',
    params: '9.08B',
    steps: '4 步',
    steadySec: '130.9s',
    secNum: 130.9,
    vram: '18.1 GB',
    vramNum: 18.1,
    license: 'FLUX Non-Commercial',
    commercial: false,
    zhSupport: true,
    kaggleReady: false,
    providers: 'Colab / 私有 GPU',
    bestFor: '静物摄影、复杂材质、参考图编辑',
    summary: '9B 版本，适合表现金属、玻璃和皮革等材质细节。',
    showcase: {
      image: '/assets/showcase/flux2-klein-9b-clockmaker-bench.webp',
      title: '钟表匠工作台',
      size: '1152 × 768',
      measuredSec: '113s',
      prompt: '午后斜阳洒在古董钟表匠木桌上，黄铜怀表、齿轮、放大镜与悬浮尘埃，静物摄影',
      pos: '50% 50%',
    },
  },
];

export const BENCH_TASKS = [
  {
    id: '01-typography-poster',
    label: '文字海报',
    summary: '同一段英文海报词，看各模型对字形、配色与留白的控制。',
    prompt: 'Minimalist Swiss coffee festival poster, bold terracotta & espresso shapes, top text "BREW 2026", bottom text "TOKYO ART MUSEUM".',
  },
  {
    id: '02-photoreal-portrait',
    label: '人像光影',
    summary: '85mm 胶片风老渔夫特写，对比皮肤纹理、眼神与自然光。',
    prompt: 'Close-up candid portrait of a 60-year-old fisherman on a misty morning dock, yellow raincoat, 85mm f/1.8, Kodak Portra 400.',
  },
  {
    id: '05-material-refraction',
    label: '材质折射',
    summary: '切面绿水晶香水瓶与定格水花，检验光学反射与焦散细节。',
    prompt: 'Luxury emerald-green faceted crystal perfume bottle on wet black volcanic stone, frozen water splash, sharp rim light.',
  },
  {
    id: '06-chinese-aesthetics',
    label: '江南晨雾',
    summary: '白墙黛瓦、孤舟纸灯与柳枝，对比东方意境与建筑细节。',
    prompt: 'Atmospheric Jiangnan water town at dawn, white walls and dark tiles, lone wooden boat with warm paper lantern, hanging willows.',
  },
];

export const WORKSPACE_VIEWS = [
  {
    id: 'studio',
    label: '创作工作台',
    summary: '左侧调参，中间查看和编辑图片，底部按版本树查看历史。',
    image: '/assets/studio-light.png',
    alt: 'AIGC Studio 创作工作台',
  },
  {
    id: 'chat',
    label: '提案助手',
    summary: '用中文描述画面，先生成可编辑提案卡，确认后再开始生成。',
    image: '/assets/chat-tool.png',
    alt: 'AIGC Studio 提案卡界面',
  },
  {
    id: 'models',
    label: '模型选择',
    summary: '查看耗时、语言支持和许可；切换模型后只显示可用参数。',
    image: '/assets/model-picker-dark.png',
    alt: 'AIGC Studio 模型选择界面',
  },
  {
    id: 'gallery',
    label: '本地作品库',
    summary: '图片和参数文件保存在本地文件夹，可按日期浏览、筛选和复现。',
    image: '/assets/gallery.png',
    alt: 'AIGC Studio 本地作品库',
  },
];

export const WORKSHOP_TOOLS = [
  {
    id: 'cutout',
    group: '平面与提取',
    name: '抹除背景',
    local: false,
    runtime: '云端 GPU',
    engine: 'BiRefNet / RMBG-2.0',
    output: '透明 PNG',
    desc: '提取主体并输出透明 PNG，用于海报合成或游戏素材。',
  },
  {
    id: 'vectorize',
    group: '平面与提取',
    name: '转 SVG 矢量',
    local: true,
    runtime: '本机直算',
    engine: 'vtracer WASM',
    output: '可编辑 .svg',
    desc: '在本机将扁平插画和图标转换为可缩放路径，不占显存，也不联网。',
  },
  {
    id: 'tile',
    group: '平面与提取',
    name: '无缝平铺',
    local: true,
    runtime: '本机直算',
    engine: '接缝检测 + 余弦混边',
    output: '2×2 无缝贴图',
    desc: '处理四边接缝，并用 2×2 预览检查结果，适合材质和底纹。',
  },
  {
    id: 'pixel-snap',
    group: '游戏与 3D',
    name: '像素对齐',
    local: true,
    runtime: '本机直算',
    engine: '网格探测 + Oklab 量化',
    output: '硬边像素图',
    desc: '去除虚边和杂色，将图像对齐到像素网格并统一色板。',
  },
  {
    id: 'sprite-slice',
    group: '游戏与 3D',
    name: '序列帧切片',
    local: true,
    runtime: '本机直算',
    engine: '网格切片 + 帧回放',
    output: '图集 + atlas.json',
    desc: '将多格动作图切成动画帧，逐帧检查后导出图集。',
  },
  {
    id: 'pbr',
    group: '游戏与 3D',
    name: 'PBR 材质拆解',
    local: false,
    runtime: '云端 GPU',
    engine: 'Marigold 内在分解',
    output: '四通道 PBR 贴图',
    desc: '从单张图生成 Albedo、Normal、Roughness 和 Metallic 四张贴图。',
  },
];

export const COMPARISON_ROWS = [
  {
    dim: '显卡要求',
    studio: '无需独显，轻薄本即可运行',
    comfy: '通常需要 12GB–24GB N 卡',
    web: '无需独显',
  },
  {
    dim: '上手门槛',
    studio: '双击安装，免配环境与节点',
    comfy: '需自配 Python、CUDA 与权重',
    web: '浏览器打开即用',
  },
  {
    dim: '算力费用',
    studio: '默认 Kaggle 每周 30 小时免费',
    comfy: '显卡投入与电费',
    web: '按月订阅或按张扣费',
  },
  {
    dim: '文件归属',
    studio: '原图、参数与版本树直存本地',
    comfy: '存在本地硬盘',
    web: '存在云端平台',
  },
  {
    dim: '后处理工坊',
    studio: '内置去背、SVG、像素、序列帧、PBR',
    comfy: '需另找节点与额外权重',
    web: '通常需切换其他工具',
  },
  {
    dim: 'Agent 接入',
    studio: '内置 MCP，可接 Claude / Cursor',
    comfy: '需第三方插件封装',
    web: '无本地接口',
  },
];

export const FAQS = [
  {
    q: '没有独立显卡，轻薄本能用吗？支持哪些操作系统？',
    a: '可以。界面运行在本机，生图推理按需交给 Kaggle 免费双 T4 或 Google Colab，出图后原图自动传回本地硬盘。安装包目前仅提供 Windows x64（安装版与便携版）；macOS 与 Linux 可通过 Node 20+ 从源码运行。',
  },
  {
    q: '可以免费使用吗？是否存在隐藏收费？',
    a: '软件按 MIT 协议开源免费。默认接入 Kaggle 每周 30 小时免费算力。需要更大显存或长驻服务时，也可切到 Colab、私有服务器或商业 API。',
  },
  {
    q: '忘记关闭云端会话会怎样？',
    a: '有任务运行时关闭窗口会先缩到托盘；从托盘退出时会停止远端实例。空闲会话会自动休眠。',
  },
  {
    q: '哪些模型可以直接商用？',
    a: 'FLUX.2 Klein 4B、SDXL Lightning、SANA-Sprint 1.6B 与 Z-Image Turbo 为可商用开源许可。其余三款为研究/非商用许可，软件内均有明确标注。',
  },
  {
    q: '不会写英文提示词怎么办？',
    a: '面板只显示当前模型可用的选项，并支持中译英。也可以先用中文写提案，确认画幅和提示词后再生成。',
  },
  {
    q: '生成的图片存在哪里？卸载软件会丢吗？',
    a: '原图、参数文件以及工坊导出的透明图、SVG 与 PBR 贴图都以普通文件夹形式留在你指定的本地目录，不绑定账号。',
  },
  {
    q: '可以让 Claude 或 Cursor 直接调用生图吗？',
    a: '可以。项目内置标准 MCP Server，配置后可在外部编程工具里发起生图、放大与查看历史。',
  },
];

export const SITE_EN = {
  ...SITE,
  title: 'AIGC Studio — Local-First Desktop AI Image Workbench',
  description:
    'Keep your workspace and files on your own drive while running 7 open-source image models on free cloud GPUs—no dedicated GPU or Python setup required.',
};

export const DOWNLOAD_EN = {
  ...DOWNLOAD,
  platformsNote:
    'Prebuilt installers currently ship for Windows x64 (installer / portable); macOS and Linux run from source with Node 20+.',
};

export const GUIDES_EN: GuideMeta[] = [
  {
    slug: 'free-gpu-no-comfyui',
    path: '/en/guides/free-gpu-no-comfyui',
    tag: 'ARCHITECTURE',
    title: 'Run Open-Source Image Models Without a Dedicated GPU',
    shortTitle: 'Free Cloud GPU Guide',
    description:
      'Run open-source diffusion models on an ultrabook or Mac without a discrete GPU or Python setup—powered by free Kaggle dual-T4 or Colab with local file sync.',
    readTime: '4 min read',
    audience: 'Ultrabook & Mac creators',
  },
  {
    slug: 'aigc-studio-vs-comfyui',
    path: '/en/guides/aigc-studio-vs-comfyui',
    tag: 'COMPARISON',
    title: 'AIGC Studio vs. ComfyUI: Which Should You Choose?',
    shortTitle: 'vs. ComfyUI',
    description:
      'Compare GPU requirements, environment upkeep, parameter ergonomics, post-processing, and workflow ceiling to pick the right tool for your work.',
    readTime: '5 min read',
    audience: 'Creators evaluating open-source tools',
  },
  {
    slug: 'ai-pixel-art-sprite',
    path: '/en/guides/ai-pixel-art-sprite',
    tag: 'GAME ASSET',
    title: 'Pixel Art Grid Snapping & Sprite Sheet Atlas Export',
    shortTitle: 'Pixel Snap & Sprites',
    description:
      'Fix blurry edges, mixels, and noisy palettes offline on your machine: grid detection, Oklab color quantization, frame preview, and atlas.json export.',
    readTime: '5 min read',
    audience: 'Indie game devs & 2D artists',
  },
  {
    slug: 'ai-image-to-svg',
    path: '/en/guides/ai-image-to-svg',
    tag: 'VECTOR',
    title: 'Convert AI Illustrations to Editable SVG Locally (0 VRAM)',
    shortTitle: 'Local Image to SVG',
    description:
      'Built-in offline WASM VTracer converts flat illustrations, icons, and badges into clean, Figma-ready vector paths without touching the cloud.',
    readTime: '4 min read',
    audience: 'Graphic & UI designers',
  },
  {
    slug: 'mcp-claude-cursor-image',
    path: '/en/guides/mcp-claude-cursor-image',
    tag: 'AGENT / MCP',
    title: 'Connect Claude Desktop & Cursor to Local Generation via MCP',
    shortTitle: 'MCP for Claude / Cursor',
    description:
      'Configure the built-in standard MCP Server in three steps so your coding agent shares the same GPU session, queue, and local outputs folder.',
    readTime: '6 min read',
    audience: 'Developers & AI workflow builders',
  },
];

export const MODELS_EN: ModelSpec[] = [
  {
    ...MODELS[0],
    shortTag: 'Graphic Posters',
    steps: '4 steps',
    providers: 'Kaggle / Colab / Private GPU',
    bestFor: 'Posters, commercial finish, reference image control',
    summary: '4-step generation with native bilingual prompts, reference images, and an Apache-2.0 commercial license.',
    showcase: {
      ...MODELS[0].showcase,
      title: 'Kyoto Travel Poster',
      prompt: 'Minimalist Kyoto travel poster with red torii gate and bamboo mist, bold sans-serif KYOTO header, flat vector style',
    },
  },
  {
    ...MODELS[1],
    shortTag: 'Daily Workhorse',
    steps: '4 steps',
    providers: 'Kaggle / Colab / Private GPU',
    bestFor: 'Daily generation, inpainting, img2img',
    summary: 'Default workhorse at ~6s per image; full support for local inpainting and image-to-image.',
    showcase: {
      ...MODELS[1].showcase,
      title: 'Rainy Neon Street',
      prompt: 'Rain-slicked neon alley at night reflecting cyan and magenta signs, lone pedestrian with umbrella, cinematic wide frame',
    },
  },
  {
    ...MODELS[2],
    shortTag: 'Typography',
    steps: '8 steps',
    providers: 'Colab / Private GPU',
    bestFor: 'Bilingual typography, posters, multi-image editing',
    summary: 'High-accuracy English & Chinese text rendering and layout control for posters and covers.',
    showcase: {
      ...MODELS[2].showcase,
      title: 'Botanica Conservatory',
      prompt: 'Warm off-white botanical exhibition poster, sunlit arched glass conservatory, top serif title BOTANICA',
    },
  },
  {
    ...MODELS[3],
    shortTag: 'Anime',
    steps: '10 steps',
    providers: 'Kaggle / Colab / Private GPU',
    bestFor: 'Anime characters, cel lighting & illustration',
    summary: 'Dedicated 2B anime DiT supporting natural language and Danbooru tags with low VRAM overhead.',
    showcase: {
      ...MODELS[3].showcase,
      title: 'Dusk Seaside Station',
      prompt: 'Silver-haired girl in sailor uniform at an empty seaside train platform at dusk, warm sunset rim lighting, cel illustration',
    },
  },
  {
    ...MODELS[4],
    shortTag: 'Photorealism',
    steps: '9 steps',
    providers: 'Colab / Private GPU',
    bestFor: 'Photorealistic scenes, signage, inpainting',
    summary: 'Crisp natural lighting and photorealistic textures with native inpainting and Apache-2.0 commercial use.',
    showcase: {
      ...MODELS[4].showcase,
      title: 'Rainy Alley Bookshop',
      prompt: 'Quiet stone-paved alley bookshop at blue hour after rain, warm amber light glowing through wooden lattice windows',
    },
  },
  {
    ...MODELS[5],
    shortTag: 'Rapid Drafts',
    steps: '2 steps',
    providers: 'Kaggle / Colab / Private GPU',
    bestFor: 'Instant thumbnails, ink wash, layout exploration',
    summary: '2-step 1024px generation in ~4 seconds—ideal for rapid composition exploration.',
    showcase: {
      ...MODELS[5].showcase,
      title: 'Morning Lotus Pond',
      prompt: 'Red-crowned crane in a misty morning lotus pond, expressive ink-wash painting with soft dawn light',
    },
  },
  {
    ...MODELS[6],
    shortTag: 'Materials & Still Life',
    steps: '4 steps',
    providers: 'Colab / Private GPU',
    bestFor: 'Product still life, complex materials, reference edits',
    summary: '9B flagship model excelling at metal, glass, leather, and intricate material fidelity.',
    showcase: {
      ...MODELS[6].showcase,
      title: 'Clockmaker Workbench',
      prompt: 'Late afternoon sunbeams across an antique clockmaker wooden bench, brass pocket watch, gears, loupe, and floating dust',
    },
  },
];

export const BENCH_TASKS_EN = [
  {
    ...BENCH_TASKS[0],
    label: 'Typography Poster',
    summary: 'Same English poster prompt testing glyph accuracy, color blocking, and whitespace balance.',
  },
  {
    ...BENCH_TASKS[1],
    label: 'Portrait Lighting',
    summary: '85mm film-style close-up of a weathered fisherman comparing skin texture, gaze, and natural light.',
  },
  {
    ...BENCH_TASKS[2],
    label: 'Glass Refraction',
    summary: 'Faceted emerald crystal perfume bottle with frozen splash testing reflections and caustics.',
  },
  {
    ...BENCH_TASKS[3],
    label: 'Water Town Dawn',
    summary: 'Whitewashed walls, dark tiles, wooden boat, and paper lantern testing atmospheric depth.',
  },
];

export const WORKSPACE_VIEWS_EN = [
  {
    ...WORKSPACE_VIEWS[0],
    label: 'Creative Studio',
    summary: 'Tune active parameters on the left, review, inpaint, upscale, or outpaint on stage, and track versions below.',
    alt: 'AIGC Studio Creative Workbench',
  },
  {
    ...WORKSPACE_VIEWS[1],
    label: 'Proposal Assistant',
    summary: 'Describe your idea in plain language to draft editable prompt cards and inspect plans before spending GPU time.',
    alt: 'AIGC Studio Proposal Card UI',
  },
  {
    ...WORKSPACE_VIEWS[2],
    label: 'Model Picker',
    summary: 'Latency, language support, and open-source licenses are clearly labeled; switching models updates only valid controls.',
    alt: 'AIGC Studio Model Picker UI',
  },
  {
    ...WORKSPACE_VIEWS[3],
    label: 'Local Gallery',
    summary: 'All images and meta.json files stay on your own disk—browse by date, filter, and reproduce any run.',
    alt: 'AIGC Studio Local Gallery',
  },
];

export const WORKSHOP_TOOLS_EN = [
  {
    ...WORKSHOP_TOOLS[0],
    group: 'Graphic & Extract',
    name: 'Remove Background',
    runtime: 'Cloud GPU',
    output: 'Transparent PNG',
    desc: 'Extract subjects onto clean alpha transparency ready for posters or game sprites.',
  },
  {
    ...WORKSHOP_TOOLS[1],
    group: 'Graphic & Extract',
    name: 'Vectorize to SVG',
    runtime: 'Local · 0 VRAM',
    output: 'Editable .svg',
    desc: 'Zero VRAM, zero upload—turn flat illustrations and icons into crisp scalable paths locally.',
  },
  {
    ...WORKSHOP_TOOLS[2],
    group: 'Graphic & Extract',
    name: 'Seamless Tile',
    runtime: 'Local · 0 VRAM',
    engine: 'Seam Detection + Cosine Blend',
    output: '2×2 Seamless Texture',
    desc: 'Automatically smooths opposing seams with live 2×2 preview for materials and backgrounds.',
  },
  {
    ...WORKSHOP_TOOLS[3],
    group: 'Game & 3D',
    name: 'Pixel Snap',
    runtime: 'Local · 0 VRAM',
    engine: 'Grid Detection + Oklab Quantize',
    output: 'Crisp Pixel Art',
    desc: 'Eliminates fuzzy anti-aliasing and mixels by snapping to a real pixel grid and clean palette.',
  },
  {
    ...WORKSHOP_TOOLS[4],
    group: 'Game & 3D',
    name: 'Sprite Slicer',
    runtime: 'Local · 0 VRAM',
    engine: 'Grid Slice + Frame Playback',
    output: 'Spritesheet + atlas.json',
    desc: 'Slices multi-frame action sheets with live frame-by-frame playback and atlas.json export.',
  },
  {
    ...WORKSHOP_TOOLS[5],
    group: 'Game & 3D',
    name: 'PBR Material Split',
    runtime: 'Cloud GPU',
    engine: 'Marigold Intrinsic Decomposition',
    output: '4-Channel PBR Maps',
    desc: 'Extracts Albedo, Normal, Roughness, and Metallic maps from a single input image.',
  },
];

export const COMPARISON_ROWS_EN = [
  {
    dim: 'GPU Requirement',
    studio: 'No dGPU needed; runs on any ultrabook',
    comfy: 'Usually requires 12–24GB NVIDIA GPU',
    web: 'No local GPU needed',
  },
  {
    dim: 'Setup Effort',
    studio: 'Install & run; zero Python or node setup',
    comfy: 'Manual Python, CUDA, and weight setup',
    web: 'Browser-ready',
  },
  {
    dim: 'Compute Cost',
    studio: 'Default 30 hrs/week free on Kaggle',
    comfy: 'GPU hardware & electricity',
    web: 'Monthly subscription or per-image credits',
  },
  {
    dim: 'File Ownership',
    studio: 'Originals, params & version trees saved locally',
    comfy: 'Saved on local disk',
    web: 'Stored on cloud servers',
  },
  {
    dim: 'Post-Processing',
    studio: 'Built-in cutout, SVG, pixel, sprite, and PBR',
    comfy: 'Requires custom nodes & extra weights',
    web: 'Usually requires external apps',
  },
  {
    dim: 'Agent Integration',
    studio: 'Built-in MCP for Claude Desktop & Cursor',
    comfy: 'Needs third-party API wrappers',
    web: 'No local integration',
  },
];

export const FAQS_EN = [
  {
    q: 'Can I use it on a laptop without a dedicated GPU? Which OSes are supported?',
    a: 'Yes. The workbench runs locally while inference runs on free Kaggle dual-T4 GPUs or Google Colab, saving every image back to your drive. Prebuilt installers target Windows x64 (installer & portable); macOS and Linux run from source on Node 20+.',
  },
  {
    q: 'Is it free? Are there any hidden fees?',
    a: 'AIGC Studio is open source under the MIT License. It connects to Kaggle’s free 30 hrs/week GPU quota by default, and also supports Colab, private GPU servers, or commercial APIs if you need more headroom.',
  },
  {
    q: 'Will forgetting to close a session burn through my free GPU quota?',
    a: 'No. Built-in idle auto-shutdown and tray protection minimize the window to the system tray when a session is active, and cleanly stop the remote kernel when you quit.',
  },
  {
    q: 'Which models allow commercial use?',
    a: 'FLUX.2 Klein 4B, SDXL Lightning, SANA-Sprint 1.6B, and Z-Image Turbo carry permissive commercial licenses. Non-commercial research models are clearly badged in the UI.',
  },
  {
    q: 'What if I am not sure how to craft prompts or tune sampler parameters?',
    a: 'Only active parameters for the selected model are shown, with built-in prompt refinement and translation. You can also chat with the Proposal Assistant to draft editable cards before running a job.',
  },
  {
    q: 'Where are generated images stored? Will uninstalling delete them?',
    a: 'Every image, meta.json, SVG, and PBR map lives in plain folders inside your chosen local workspace—zero cloud lock-in.',
  },
  {
    q: 'Can Claude Desktop or Cursor trigger local image generation directly?',
    a: 'Yes. Configure the built-in standard MCP Server to generate, upscale, and inspect your local history directly from your coding agent.',
  },
];

export function getSiteContent(lang: 'zh' | 'en' = 'zh') {
  if (lang === 'en') {
    return {
      site: SITE_EN,
      download: DOWNLOAD_EN,
      guides: GUIDES_EN,
      models: MODELS_EN,
      benchTasks: BENCH_TASKS_EN,
      workspaceViews: WORKSPACE_VIEWS_EN,
      workshopTools: WORKSHOP_TOOLS_EN,
      comparisonRows: COMPARISON_ROWS_EN,
      faqs: FAQS_EN,
    };
  }
  return {
    site: SITE,
    download: DOWNLOAD,
    guides: GUIDES,
    models: MODELS,
    benchTasks: BENCH_TASKS,
    workspaceViews: WORKSPACE_VIEWS,
    workshopTools: WORKSHOP_TOOLS,
    comparisonRows: COMPARISON_ROWS,
    faqs: FAQS,
  };
}
