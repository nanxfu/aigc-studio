export const SITE = {
  name: 'AIGC Studio',
  domain: 'https://aigc-studio.app',
  github: 'https://github.com/nanxfu/aigc-studio',
  releases: 'https://github.com/nanxfu/aigc-studio/releases',
  version: '0.15.0',
  license: 'MIT',
  title: 'AIGC Studio — 桌面端开源生图工作台',
  description:
    '不用高显存显卡，不折腾 ComfyUI。挂载 Kaggle 免费双 T4 或 Colab 算力，在本地桌面运行 FLUX.2、Qwen-Image、SDXL 等 7 款开源生图模型，产物全部存盘本地。',
};

export interface ModelSpec {
  id: string;
  label: string;
  family: string;
  params: string;
  steps: string;
  steadySec: string;
  vram: string;
  license: string;
  commercial: boolean;
  zhSupport: boolean;
  providers: string;
  bestFor: string;
  summary: string;
  showcase: {
    image: string;
    title: string;
    measuredNote: string;
    prompt: string;
    pos?: string;
  };
}

export const MODELS: ModelSpec[] = [
  {
    id: 'flux2-klein-4b',
    label: 'FLUX.2 Klein 4B',
    family: 'FLUX',
    params: '3.88B',
    steps: '4 步',
    steadySec: '~10.2s',
    vram: '7.9 GB（双卡）',
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: true,
    providers: 'Kaggle / Colab / 私有 GPU',
    bestFor: '平面海报、商业质感、参考图控制',
    summary: '4 步出图，原生支持中英文与参考图输入，Apache-2.0 可商用。',
    showcase: {
      image: '/assets/showcase/flux2-klein-4b-kyoto-poster.webp',
      title: '极简京都旅行海报',
      measuredNote: '1152 × 640 · 实测 6.8 秒 · 费用 ¥0',
      prompt: '极简京都旅行海报，红色鸟居与竹林晨雾，顶部 KYOTO 无衬线大字，扁平矢量插画',
      pos: '50% 45%',
    },
  },
  {
    id: 'sdxl-lightning',
    label: 'SDXL Lightning',
    family: 'SDXL',
    params: '3.5B + LoRA',
    steps: '4 步',
    steadySec: '~6.2s',
    vram: '10.3 GB',
    license: 'OpenRAIL++',
    commercial: true,
    zhSupport: false,
    providers: 'Kaggle / Colab / 私有 GPU',
    bestFor: '日常快速出图、局部重绘（Inpaint）、图生图',
    summary: '默认主力模型，6 秒级稳态出图，完整支持局部涂抹重绘与整图重绘。',
    showcase: {
      image: '/assets/showcase/sdxl-lightning-cyberpunk-street.webp',
      title: '雨夜霓虹街道',
      measuredNote: '1152 × 648 · 实测 9.8 秒 · Kaggle 双 T4',
      prompt: '雨夜霓虹街道，湿润地面反射青绿与品红招牌，远处撑伞行人，电影感宽画幅',
      pos: '50% 50%',
    },
  },
  {
    id: 'qwen-image-2.1',
    label: 'Qwen-Image 2.1',
    family: 'Qwen',
    params: '7B DiT + Qwen3-VL-8B',
    steps: '8 步',
    steadySec: '~43.7s',
    vram: '16.8 GB',
    license: 'Qwen Research',
    commercial: false,
    zhSupport: true,
    providers: 'Colab / 私有 GPU',
    bestFor: '中文海报排版、精准文字渲染、多图编辑',
    summary: '中英文文字渲染与平面排版准确度高，适合需要直接出字的海报与封面。',
    showcase: {
      image: '/assets/showcase/qwen-image-2.1-botanica-poster.webp',
      title: '温室植物志海报',
      measuredNote: '768 × 1024 · 实测 39.2 秒 · Colab L4',
      prompt: '暖白纸面极简植物志海报，阳光拱形玻璃温室，顶部大字 BOTANICA 与「温室植物志」',
      pos: '50% 8%',
    },
  },
  {
    id: 'anima-turbo-v1.1',
    label: 'Anima Turbo v1.1',
    family: 'Anima',
    params: '2B DiT + Qwen3-0.6B',
    steps: '10 步',
    steadySec: '~21.6s',
    vram: '8.5 GB',
    license: 'Non-Commercial',
    commercial: false,
    zhSupport: false,
    providers: 'Kaggle / Colab / 私有 GPU',
    bestFor: '二次元角色、动漫插画、光影构图',
    summary: '二次元专精 DiT 架构，兼顾自然语言与 Danbooru 标签写法，显存占用低。',
    showcase: {
      image: '/assets/showcase/anima-turbo-v1.1-seaside-station.webp',
      title: '黄昏海边站台少女',
      measuredNote: '768 × 1024 · 实测 9.8 秒 · Colab L4',
      prompt: '银发蓝眼水手服少女站在黄昏空旷海边站台，橙紫晚霞与逆光发丝，赛璐璐插画',
      pos: '50% 10%',
    },
  },
  {
    id: 'z-image-turbo',
    label: 'Z-Image Turbo',
    family: 'Z-Image',
    params: '6B S3-DiT + Qwen3-4B',
    steps: '9 步',
    steadySec: '~30.7s',
    vram: '12.2 GB',
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: true,
    providers: 'Colab / 私有 GPU',
    bestFor: '写实街景摄影、中文招牌文字、局部重绘',
    summary: '写实摄影与自然光影细腻，原生支持中文文字与局部重绘，Apache-2.0 可商用。',
    showcase: {
      image: '/assets/showcase/z-image-turbo-alley-bookstore.webp',
      title: '雨巷旧书店',
      measuredNote: '768 × 1024 · 实测 29.2 秒 · Colab L4',
      prompt: '蓝调时刻雨后石板巷里的旧书店，木格窗透出暖黄灯光，灯笼手写「旧书与茶」',
      pos: '50% 35%',
    },
  },
  {
    id: 'sana-sprint-1.6b',
    label: 'SANA-Sprint 1.6B',
    family: 'SANA',
    params: '1.6B + Gemma-2-2B',
    steps: '2 步',
    steadySec: '~4.1s',
    vram: '10.3 GB',
    license: 'Apache-2.0',
    commercial: true,
    zhSupport: false,
    providers: 'Kaggle / Colab / 私有 GPU',
    bestFor: '快速构图起稿、水墨国风、低成本试错',
    summary: '2 步即可出 1024px 图像，4 秒级响应，适合先快速探索构图与色调。',
    showcase: {
      image: '/assets/showcase/sana-sprint-1.6b-crane-pond.webp',
      title: '红冠鹤与晨间荷塘',
      measuredNote: '1024 × 1024 · 实测 4.07 秒 · Kaggle 双 T4',
      prompt: '晨雾荷塘中的丹顶鹤，水墨写意风格，柔和晨光与细腻笔触',
      pos: '50% 45%',
    },
  },
  {
    id: 'flux2-klein-9b',
    label: 'FLUX.2 Klein 9B',
    family: 'FLUX',
    params: '9.08B',
    steps: '4 步',
    steadySec: '~130.9s',
    vram: '18.1 GB',
    license: 'FLUX Non-Commercial',
    commercial: false,
    zhSupport: true,
    providers: 'Colab / 私有 GPU（需 HF 授权）',
    bestFor: '高精度商业静物、复杂材质细节、参考图编辑',
    summary: '9B 大参数蒸馏版本，金属、玻璃、皮革等复杂材质与空间细节还原度高。',
    showcase: {
      image: '/assets/showcase/flux2-klein-9b-clockmaker-bench.webp',
      title: '钟表匠工作台',
      measuredNote: '1152 × 768 · 实测 113 秒 · Colab L4',
      prompt: '午后斜阳洒在古董钟表匠木桌上，黄铜怀表、齿轮、放大镜与悬浮尘埃，静物摄影',
      pos: '50% 50%',
    },
  },
];

export const WORKSPACE_VIEWS = [
  {
    id: 'studio',
    label: '创作工作台',
    summary: '左栏调参、中间舞台预览与就地二创（局部涂抹 / 放大 / 扩图），底栏按版本树折叠历史。',
    image: '/assets/studio-light.png',
    alt: 'AIGC Studio 桌面创作工作台界面',
  },
  {
    id: 'chat',
    label: 'AI 提案助手',
    summary: '用中文直接说想要什么画面，助手整理出可编辑提案卡（画幅、提示词、模型），确认后再跑算力。',
    image: '/assets/chat-tool.png',
    alt: 'AIGC Studio AI 创作助手与可编辑提案卡',
  },
  {
    id: 'models',
    label: '模型选择卡',
    summary: '每款模型明确标出实测耗时、中英支持、开源协议与算力来源，切换模型自动对齐有效参数。',
    image: '/assets/model-picker-dark.png',
    alt: 'AIGC Studio 模型选择卡（深色主题）',
  },
  {
    id: 'gallery',
    label: '本地作品库',
    summary: '全部图片与 meta.json 原样落盘本地目录，支持按日期浏览、搜索、收藏与参数回溯。',
    image: '/assets/gallery.png',
    alt: 'AIGC Studio 本地作品库与画廊',
  },
];

export const WORKSHOP_TOOLS = [
  {
    id: 'cutout',
    group: '平面与提取',
    name: '抹除背景',
    runtime: '云端 GPU',
    engine: 'BiRefNet（免登录）/ RMBG-2.0',
    output: 'RGBA 透明 PNG',
    desc: '一键提取前景主体并生成透明底，边缘干净，可直接用于海报合成或游戏道具。',
  },
  {
    id: 'vectorize',
    group: '平面与提取',
    name: 'SVG 矢量',
    runtime: '本机直算 · 0 GPU',
    engine: 'vtracer WASM',
    output: '可编辑 .svg',
    desc: '不占显存、不联网，秒级把扁平插画、图标与 Logo 转为可无限缩放的矢量路径。',
  },
  {
    id: 'tile',
    group: '平面与提取',
    name: '无缝平铺',
    runtime: '本机直算 · 0 GPU',
    engine: '接缝 MAE 检测 + 余弦混边',
    output: '2×2 预览 + 无缝贴图',
    desc: '自动计算四边接缝误差并平滑混边，支持 2×2 实时平铺校验，适合材质与纹理制作。',
  },
  {
    id: 'pixel-snap',
    group: '游戏与 3D',
    name: '像素对齐',
    runtime: '本机直算 · 0 GPU',
    engine: '网格探测 + Oklab 调色盘量化',
    output: '硬边像素 PNG',
    desc: '自动探测 AI 像素画里的模糊虚边与杂色，重采样对齐到真实像素格并统一色板。',
  },
  {
    id: 'sprite-slice',
    group: '游戏与 3D',
    name: '序列帧切片',
    runtime: '本机直算 · 0 GPU',
    engine: '网格切片 + 逐帧回放',
    output: 'Spritesheet + atlas.json',
    desc: '把多格角色动作图切分为标准动画帧，支持现场回放预览并一并导出图集配置文件。',
  },
  {
    id: 'pbr',
    group: '游戏与 3D',
    name: 'PBR 材质拆解',
    runtime: '云端 GPU',
    engine: 'Marigold 内在分解',
    output: 'Albedo / Normal / Roughness / Metallic',
    desc: '从单张图拆出四通道 PBR 贴图并打包为复合资产，支持画布内逐通道切换核对。',
  },
];

export const COMPARISON_ROWS = [
  {
    dim: '本地显卡要求',
    studio: '无需独显，集显轻薄本即可运行',
    comfy: '通常需要 12GB–24GB N 卡',
    web: '无需独显',
  },
  {
    dim: '安装与环境',
    studio: '双击安装包，免配 Python / CUDA / 节点',
    comfy: '需自配 Python、PyTorch、模型权重与节点',
    web: '浏览器打开即用',
  },
  {
    dim: '算力成本',
    studio: '默认 Kaggle 免费 30h/周（也支持 Colab / 私有 GPU / API）',
    comfy: '显卡硬件投入 + 电费',
    web: '按月订阅或按张扣积分，持续付费',
  },
  {
    dim: '数据归属',
    studio: '100% 落盘本地硬盘，带 meta.json 与版本树',
    comfy: '落在本地硬盘',
    web: '存在平台云端，受限于导出与留存规则',
  },
  {
    dim: '出图后处理',
    studio: '内置工坊：去背 / 转 SVG / 像素对齐 / 序列帧 / 平铺 / PBR',
    comfy: '需自行拼装对应工作流并下载额外模型',
    web: '通常需切换其他付费工具单独处理',
  },
  {
    dim: 'Agent 接入',
    studio: '内置标准 MCP Server，可接 Claude Desktop / Cursor',
    comfy: '需第三方插件封装 API',
    web: '封闭，无本地 MCP 接口',
  },
];

export const FAQS = [
  {
    q: '没有独立显卡，或者用的是轻薄本 / Mac，能运行 AIGC Studio 吗？',
    a: '可以。AIGC Studio 把本地桌面界面和云端推理彻底分开：本机只运行轻量客户端，生图推理默认交给 Kaggle 免费的 2×Tesla T4（30GB 显存）或 Google Colab 执行，出图后自动加密传回本地工作区。',
  },
  {
    q: '真的可以免费生图吗？有没有隐藏收费？',
    a: '软件本体基于 MIT 协议开源免费。算力方面，默认支持接入 Kaggle 官方每周 30 小时免费双 T4 额度，日常出图成本为 ¥0。如果需要更大显存模型（如 FLUX.2 Klein 9B、Qwen-Image 2.1）或高频商用，也可随时切换到 Google Colab、自建 GPU Worker（如 AutoDL / RunPod）或商业云 API。',
  },
  {
    q: '忘记关云端会话，会不会把 Kaggle / Colab 免费额度空烧完？',
    a: '软件内置了空闲自动休眠倒计时与防误关保护：云端会话活跃时关闭窗口默认最小化到系统托盘，避免误关导致远程实例空烧；需要彻底结束时，从托盘退出会安全关闭云端会话。',
  },
  {
    q: '支持哪些开源模型？哪些可以商用？',
    a: '内置 7 款模型：FLUX.2 Klein 4B、SDXL Lightning、SANA-Sprint 1.6B、Z-Image Turbo 为 Apache-2.0 或 OpenRAIL++ 可商用许可；Qwen-Image 2.1、Anima Turbo v1.1、FLUX.2 Klein 9B 为研究/非商用许可。模型选择卡内会明确标注协议与算力要求。',
  },
  {
    q: '不会写英文提示词，也不懂步数和 CFG 怎么办？',
    a: '参数面板会按所选模型自动只显示有效项，并支持一键中译英和词缀补全；也可以切到「AI 创作助手」，直接用中文描述想法，助手先输出可编辑提案卡（含画幅、提示词、模型），确认无误后再提交生成。',
  },
  {
    q: '生成的图片和参数存在哪里？卸载软件会丢吗？',
    a: '全部原图、参数 meta.json 以及工坊导出的多通道文件（SVG、透明 PNG、PBR 贴图）直接存在你指定的本地工作区目录里，采用开放文件夹结构，不绑定平台账号。',
  },
  {
    q: '可以让 Claude Desktop 或 Cursor 直接调用生图吗？',
    a: '可以。仓库内置标准 stdio MCP Server（提供生成、批量、放大、历史、配方等 7 个工具），运行 npm run mcp:config 即可获取配置，直接接入外部 AI 编程工具。',
  },
];
