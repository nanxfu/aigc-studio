const rawSiteUrl = (import.meta.env.PUBLIC_SITE_URL || 'https://aigc-studio.app').trim().replace(/\/+$/, '');

export const SITE = {
  name: 'AIGC Studio',
  domain: rawSiteUrl,
  github: 'https://github.com/nanxfu/aigc-studio',
  releases: 'https://github.com/nanxfu/aigc-studio/releases',
  latestRelease: 'https://github.com/nanxfu/aigc-studio/releases/latest',
  version: '0.15.0',
  license: 'MIT',
  title: 'AIGC Studio — 本地桌面生图工作台',
  description:
    '界面留在本地，算力交给云端。免买显卡、免配环境，就能运行 7 款开源生图模型，原图与资产保存在自己硬盘。',
};

export const DOWNLOAD = {
  winInstallerName: `aigc-studio-${SITE.version}-x64.exe`,
  winPortableName: `aigc-studio-${SITE.version}-portable.exe`,
  winUrl: SITE.latestRelease,
  sourceUrl: `${SITE.github}#readme`,
  platformsNote: '首批公开安装包已验证 Windows x64（安装版 / 便携版）；macOS 与 Linux 当前支持通过 Node 源码运行。',
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
    description: '轻薄本或核显电脑免买高显存显卡、免配 Python 与节点，通过 Kaggle 免费双卡或 Colab 跑开源模型并本地存图。',
    readTime: '4 分钟',
    audience: '无独显 / 轻薄本创作者',
  },
  {
    slug: 'aigc-studio-vs-comfyui',
    path: '/guides/aigc-studio-vs-comfyui',
    tag: 'COMPARISON',
    title: 'AIGC Studio 与 ComfyUI 选型对照',
    shortTitle: 'vs ComfyUI 选型',
    description: '从显卡门槛、冷启动、参数控制、后处理与适用边界，客观拆解什么时候该用 AIGC Studio，什么时候仍应选 ComfyUI。',
    readTime: '5 分钟',
    audience: '开源生图选型评估者',
  },
  {
    slug: 'ai-pixel-art-sprite',
    path: '/guides/ai-pixel-art-sprite',
    tag: 'GAME ASSET',
    title: '游戏像素画网格对齐与序列帧 Atlas 导出',
    shortTitle: '像素对齐与序列帧',
    description: '解决 AI 生成像素画的虚边、混色与歪斜网格问题，在本机离线完成 Oklab 色板量化、帧切片预览与 atlas.json 整包导出。',
    readTime: '5 分钟',
    audience: '独立游戏开发者 / 美术',
  },
  {
    slug: 'ai-image-to-svg',
    path: '/guides/ai-image-to-svg',
    tag: 'VECTOR',
    title: '本机零显存将 AI 插画转换为可编辑 SVG',
    shortTitle: '本地转 SVG 矢量',
    description: '基于本机 WASM 版 VTracer，不占显存也不上传云端，把扁平插画、图标与徽章直接转成可进 Figma / Illustrator 的矢量路径。',
    readTime: '4 分钟',
    audience: '平面设计师 / UI 设计师',
  },
  {
    slug: 'mcp-claude-cursor-image',
    path: '/guides/mcp-claude-cursor-image',
    tag: 'AGENT / MCP',
    title: '通过 MCP 让 Claude Desktop / Cursor 调用本地生图',
    shortTitle: 'MCP 接入 Agent',
    description: '三步接入内置标准 MCP Server，让外部编程助手与桌面工作台共享同一套会话、队列与本地 outputs 目录。',
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
    summary: '4 步出图，原生支持中英文与参考图，Apache-2.0 可商用。',
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
    summary: '默认主力，6 秒级响应，局部涂抹重绘和整图重绘都支持。',
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
    summary: '中英文文字渲染与版式准确度高，适合要出字的海报与封面。',
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
    summary: '二次元专精架构，自然语言和标签写法都支持，显存占用低。',
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
    summary: '写实摄影与自然光影细腻，原生支持中文与局部重绘，可商用。',
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
    summary: '2 步直出 1024px 图像，4 秒一张，适合先快速敲定构图。',
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
    summary: '9B 大参数版本，金属、玻璃、皮革等材质细节还原度高。',
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
    summary: '左栏调参，中间看图与局部重绘、放大、扩图，底栏按版本树收拢历史。',
    image: '/assets/studio-light.png',
    alt: 'AIGC Studio 创作工作台',
  },
  {
    id: 'chat',
    label: '提案助手',
    summary: '直接用中文说想要什么画面，先出可编辑提案卡（画幅、词、模型），确认后再跑算力。',
    image: '/assets/chat-tool.png',
    alt: 'AIGC Studio 提案卡界面',
  },
  {
    id: 'models',
    label: '模型选择',
    summary: '标明耗时、中英支持与开源许可，切模型时界面自动对齐有效参数。',
    image: '/assets/model-picker-dark.png',
    alt: 'AIGC Studio 模型选择界面',
  },
  {
    id: 'gallery',
    label: '本地作品库',
    summary: '所有图片与参数文件原样留在本地文件夹，按日期浏览、筛选与复现。',
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
    desc: '提取主体并输出干净透明底，拿去合成海报或做道具。',
  },
  {
    id: 'vectorize',
    group: '平面与提取',
    name: '转 SVG 矢量',
    local: true,
    runtime: '本机直算',
    engine: 'vtracer WASM',
    output: '可编辑 .svg',
    desc: '不占显存、不联网，把扁平插画与图标秒转成可缩放路径。',
  },
  {
    id: 'tile',
    group: '平面与提取',
    name: '无缝平铺',
    local: true,
    runtime: '本机直算',
    engine: '接缝检测 + 余弦混边',
    output: '2×2 无缝贴图',
    desc: '自动修平四边接缝并支持 2×2 实时校验，适合材质与底纹。',
  },
  {
    id: 'pixel-snap',
    group: '游戏与 3D',
    name: '像素对齐',
    local: true,
    runtime: '本机直算',
    engine: '网格探测 + Oklab 量化',
    output: '硬边像素图',
    desc: '消除模糊虚边与杂色，重采样对齐到真实像素格并统一色板。',
  },
  {
    id: 'sprite-slice',
    group: '游戏与 3D',
    name: '序列帧切片',
    local: true,
    runtime: '本机直算',
    engine: '网格切片 + 帧回放',
    output: '图集 + atlas.json',
    desc: '将多格角色动作图切成标准动画帧，支持现场回放与整包导出。',
  },
  {
    id: 'pbr',
    group: '游戏与 3D',
    name: 'PBR 材质拆解',
    local: false,
    runtime: '云端 GPU',
    engine: 'Marigold 内在分解',
    output: '四通道 PBR 贴图',
    desc: '从单张图拆出 Albedo、Normal、Roughness 与 Metallic 四通道。',
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
    a: '可以。界面运行在本机，生图推理按需交给 Kaggle 免费双 T4 或 Google Colab，出图后原图自动传回本地硬盘。首批公开安装包已验证 Windows x64（安装版与便携版）；macOS 与 Linux 当前可通过 Node 源码本地运行。',
  },
  {
    q: '真的可以免费起步吗？有没有隐藏收费？',
    a: '软件按 MIT 协议开源免费。默认接入 Kaggle 每周 30 小时免费算力。需要更大显存或长驻服务时，也可切到 Colab、私有服务器或商业 API。',
  },
  {
    q: '忘了关云端会话，会把免费额度空烧完吗？',
    a: '不会。内置空闲休眠与防误关保护：有活跃会话时关窗口会缩到托盘，从托盘退出时会自动停掉远端实例。',
  },
  {
    q: '哪些模型可以直接商用？',
    a: 'FLUX.2 Klein 4B、SDXL Lightning、SANA-Sprint 1.6B 与 Z-Image Turbo 为可商用开源许可。其余三款为研究/非商用许可，软件内均有明确标注。',
  },
  {
    q: '不会写英文提示词或调参数怎么办？',
    a: '面板只显示当前模型真正生效的选项，并支持中译英。也可以用中文直接和提案助手沟通，先确认画幅与词再出图。',
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
