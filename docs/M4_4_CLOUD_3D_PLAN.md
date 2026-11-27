# M4.4 专项规划：云端 GPU 3D 资产自部署闭环

> **状态**：调研与架构设计完成（2026-11-26）；按「**纯云端 GPU 自部署、暂不接入商业 3D API**」收敛边界。**M4.4a-1 契约与落盘已完成（2026-11-27，离线可验收）**，a-2 起按四段推进。  
> **上位文档**：[`ROADMAP.md`](ROADMAP.md)、[`M4_VIDEO_AND_GAME_ASSET_PLAN.md`](M4_VIDEO_AND_GAME_ASSET_PLAN.md)、[`GPU_RUNTIME_BASELINE_PLAN.md`](GPU_RUNTIME_BASELINE_PLAN.md)

---

## 1. 目标与明确边界

1. **只走云端 GPU 自部署闭环，暂不接入商业 3D API**：不依赖 Tripo / Meshy / Hunyuan3D 商业托管接口，核心推理运行在自有云端 GPU 后端（Kaggle / Colab / RunPod / Vast.ai / SaladCloud / 私有 Docker Worker）。
2. **本机不做 3D 模型生成，只做流畅 `.glb` 交互预览**：端侧无 CUDA 核显（如 AMD 880M）与轻量本机保持纯浏览体验，通过 Three.js 在桌面客户端预览模型、切换线框/材质与导出 `.glb` / `.zip`。
3. **不破坏现有 3.16 GB 轻量 2D/视频容器基线**：2D 扩散、LoRA 与工坊（`BiRefNet` / `Marigold` / `Ubisoft CHORD`）继续沿用 `pytorch:2.6.0-cuda12.4-cudnn9-runtime` 镜像；凡强依赖 `nvcc` 现场编译 CUDA 光栅化算子的重型 3D 管线，独立拆出 **`aigc-worker-3d:devel`** 镜像，与现有 `aigc-worker` 隔离发布。

---

## 2. 开源 Image-to-3D 选型调研（Hugging Face & 上游仓库实测核对，2026-11-26）

3D 生成在计算结构上天然分为 **第一段（几何网格 Shape）** 与 **第二段（多视角纹理与 PBR 烘焙 Paint/Texture）**：真正抬高显存（21–29 GB）并强绑 `nvcc` 编译（`nvdiffrast`、`custom_rasterizer`、`o-voxel`）的是第二段。

| 模型 / 仓库 | 许可与门控 | 实查权重规模 | 核心依赖与编译门槛 | 实测显存与耗时定位 | 产物能力 | 结论定位 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **[`microsoft/TRELLIS.2-4B`](https://huggingface.co/microsoft/TRELLIS.2-4B)** | **MIT**（免登录） | **16.24 GB**（多阶段拆包） | **重编译**：`nvdiffrast` + `nvdiffrec` + `CuMesh` + `flexgemm` + `o-voxel` + `flash-attn` | **24 GB–48 GB**（需 4090 / A5000 / L40S） | 3A 级完整 PBR `.glb`（O-Voxel） | **24GB 容器旗舰备选**（依赖全预编译 `devel` 镜像，不适合在 Kaggle/Colab 临时 pip） |
| **[`tencent/Hunyuan3D-2.1`](https://huggingface.co/tencent/Hunyuan3D-2.1)** | 社区研究/非商用（免登录） | **14.91 GB**（Shape `dit` 7.37 GB + `vae` 0.66 GB + `paintpbr` ~6.88 GB） | **中等编译**：`hy3dpaint/custom_rasterizer`（单个 CUDAExtension）+ `trimesh`/`pymeshlab`/`xatlas`/`open3d` | Shape **10 GB**，Paint **21 GB**（单卡全开 29 GB；顺序卸载 + `--low_vram_mode` 可压进 **24 GB**，双 T4 可分卡） | 完整 PBR `.glb`（Albedo / Roughness / Metallic / 法线） | **24GB 容器主力**（且代码结构与分阶段卸载最清晰） |
| **[`tencent/Hunyuan3D-2mini`](https://huggingface.co/tencent/Hunyuan3D-2mini)** | 同上（免登录） | `dit-v2-mini-turbo` **3.82 GB** + `vae` **0.41 GB** = **4.23 GB** | **仅 Shape 无 CUDA 编译**（标准 PyTorch + `trimesh`/等值面提取） | **6–8 GB**（Kaggle 15GB T4 轻松跑） | 纯几何白模 `.glb`（若再接贴图仍需 Paint 管线） | **M4.4a 轻量闭环探路首选**（零 CUDA 编译，先跑通全链路 `.glb` 回传与 Three.js 预览） |
| **[`stabilityai/stable-point-aware-3d`](https://huggingface.co/stabilityai/stable-point-aware-3d)（SPAR3D）** | Stability AI Community License（HF `gated: auto`） | **7.33 GB** 单 `model.safetensors` | **轻编译**：`texture_baker`（单 CUDA/C++ 扩展）+ `uv_unwrapper`（纯 C++ 扩展）+ AlphaCLIP | 默认 **10.5 GB**，`SPAR3D_LOW_VRAM=1` 压至 **~7 GB**（T4 16GB 可跑） | 秒级前馈 UV 展开 + 基础 PBR `.glb`（含 delighting / roughness / metallic） | **16GB T4 带贴图轻量候选**（几何精细度弱于 Hunyuan2.1/TRELLIS.2，但速度快、适合 Kaggle/Colab） |
| [`VAST-AI/TripoSG`](https://huggingface.co/VAST-AI/TripoSG) | **MIT**（免登录） | **7.95 GB** | 纯 PyTorch / `diffusers` + `diso` / `trimesh` | **~8 GB** | 仅高保真几何白模（无自带纹理模块） | 备选白模 |
| [`stepfun-ai/Step1X-3D`](https://huggingface.co/stepfun-ai/Step1X-3D) | Apache-2.0（免登录） | 19.64 GB | `pytorch3d` + `kaolin` + `torch-cluster` | **27–29 GB 起步**（32GB+ 推荐） | PBR `.glb` | **暂不纳入**（对 24GB 4090/A5000 过于苛刻） |

---

## 3. 分阶段云端架构路线（M4.4a → M4.4b）

核心原则：**先用低编译门槛方案把「Worker 生成 `.glb` → `/artifact` 二进制传输 → Host 落盘 → 版本树与 Three.js 预览」整条协议闭环跑通，再上线 24GB+ `devel` 旗舰容器**，避免一开始被 5 个 CUDA 扩展编译卡死在第一步。

### 阶段一（M4.4a）：协议与端到端闭环先行（15–16 GB 云 GPU，如 Kaggle 2×T4 / Colab T4）

1. **模型切入点**：
   - 首选 **`Hunyuan3D-2mini`（`turbo` 4.23 GB 几何白模）** 作为免 CUDA 扩展编译的零风险探路模型，或在有预装 `nvcc` 的 Kaggle/Colab 环境增量安装 `SPAR3D`（`7.33 GB`，带纹理 `.glb`）；
   - 输入图强制先经过本机端侧 `rmbg-1.4` 或工坊 `BiRefNet` 去背得到干净 RGBA（图生 3D 对纯背景透明图最敏感，可复用现有工坊去背产物或自动前置去背）。
2. **协议与工程改动（复用现有协议 v2，零魔改）**：
   - **Worker（[`worker/`](../worker/)）**：
     - [`worker/transport/validator.py`](../worker/transport/validator.py) 新增远端工坊/生成工具 `tool = "mesh3d"`（与 `pbr` 同构，接收单张预处理参考图）；
     - 新增 `worker/inference/mesh3d.py` 运行推理导出标准 `.glb` 到临时产物目录；
     - 复现工坊内存守则：几何/贴图阶段严格顺序释放模型并 `gc.collect()` + `torch.cuda.empty_cache()`，防止连续出 2D/3D 爆内存；
     - 复用 [`worker/transport/http_server.py`](../worker/transport/http_server.py#L260-L320) 的 `GET /artifact?id=&index=` 与 `media_type="model/gltf-binary"` 二进制流传输（`.glb` 通常 5–30 MB，**严禁走 `image_b64` JSON 内联**）。
   - **Host（[`server/`](../server/)）**：
     - [`shared/contract.js`](../shared/contract.js) 已有 `MEDIA_TYPES = ['image', 'video', 'mesh3d']`，需在契约补充 `WORKSHOP.mesh3d` 或专门的 `MESH3D` 参数边界（**a-1 采用专门的 `MESH3D`**，边界走 `limits.mesh3d`：3D 是任务不是通道，不登记进 `WORKSHOP.tools`，也不写 `meta.channels[]`）；
     - [`server/output.js`](../server/output.js#L315-L470) 目前在 `saveJobOutput` 硬编码了 `video` vs `image`，需正式扩展对 `mediaType === 'mesh3d'` 的处理：将 `/artifact` 下载的二进制写入 **`01.glb`**（可选附带 `preview.png` 缩略图供作品库/胶片条快速展示，避免列表渲染大量 WebGL Canvas），并在 `meta.json` 写入 `mediaType: 'mesh3d'`；
     - 确保 `GET /api/file` 对 `.glb` 返回正确的 MIME（`model/gltf-binary`）与 Range 支持。
   - **前端（[`web/`](../web/)）**：
     - 安装并按需懒加载 **`three`**（`GLTFLoader` + `OrbitControls` + 轻量环境光/方向光，仅打开 3D 产物或进入预览时动态 `import()`，不膨胀 2D 首屏包体积）；
     - 新增 **`web/studio/stage/Mesh3DViewer.jsx`**：支持鼠标旋转缩放、线框切换（Wireframe）、法线着色切换、自动居中归一化尺寸、底部保留一键导出 `.glb`（后续可扩展导出 `.zip` 拆解贴图包）；
     - **胶片条 / 版本树兼容**：利用现有 `rootImage` 追溯链路，将「2D 道具概念图 → 去背 RGBA → `.glb` 3D 模型」完整串在同一棵作品版本树下（`lineage.js` 新增 `mesh3d` 图标/类型，胶片条缩略图优先展示 `preview.png` 渲染预览图或 3D 角标）。

### 阶段二（M4.4b）：旗舰 3A PBR 自部署容器（24 GB+ RunPod / Vast.ai / Salad / 私有机）

当 M4.4a 的协议、落盘和前端 Three.js 预览彻底稳固后，再补齐重装自部署容器：
1. **独立 Dockerfile：`worker/deploy/Dockerfile.3d`**（发布为 `ghcr.io/<owner>/aigc-worker-3d:devel`）：
   - 基础镜像切换为 **`pytorch/pytorch:2.6.0-cuda12.4-cudnn9-devel`**（含 `nvcc` 完整工具链，仅在 GitHub Actions 按 3D Tag/手动触发构建，不影响现有 3.16 GB 2D 镜像）；
   - 构建期预编译并锁定 **`hy3dpaint/custom_rasterizer`**（以及视选型加入 `nvdiffrast` / `CuMesh` / `o-voxel` / `flexgemm`），容器启动零编译、开箱即用；
   - 通过 `/health` 扩展 `capabilities: ["image", "workshop", "mesh3d"]`（或 `worker_profile: "3d-devel"`），使 Host 能明确识别当前连上的云端 GPU 节点是否支持完整 3D PBR 模型，**在 15GB/runtime 节点上提前拦截不支持的重型 3D 模型**而不是等跑一半报错。
2. **旗舰模型接入优先级**：
   - **第一主力：`Hunyuan3D-2.1`**：实测单卡 24 GB 可跑通分段卸载策略（Stage 1 Shape 加载 → 导出白模 → 卸载 Shape & 清显存 → Stage 2 `hy3dpaint` 生成多视角 PBR 贴图 → 烘焙导出带 PBR 材质的 `.glb`）；若接入 Kaggle 2×T4，还可验证 `device_shape=cuda:0` + `device_paint=cuda:1` 双卡分配方案；
   - **第二主力：`TRELLIS.2-4B`（MIT 协议）**：全部依赖预编译入 `Dockerfile.3d` 后接入，补齐纯 MIT 商用友好型 3A 级原生 PBR 选项（满足既需要 MIT 协议又需要极致纹理的创作者）。

---

## 4. 关键取舍与启动前待拍板项

在动手写 M4.4 代码前，有 3 个设计分叉点需确认清楚（可按需逐项敲定）：

1. **M4.4a 探路第一模型的选择**：
   - 选 **`Hunyuan3D-2mini`（Shape-only 白模）** 优先，还是直接上 **`SPAR3D`（含基础贴图，但需先解决 HF gated 与 `texture_baker` 在 Kaggle T4 的现场编译测试）**？
   - *建议*：用 **`Hunyuan3D-2mini`**（免登录、免编译 CUDA 扩展）在 1–2 天内先把 `/artifact → 01.glb → Three.js Mesh3DViewer` 全闭环彻底跑稳；紧接着就能在已有基础设施上平滑插入 `SPAR3D` 和 `Dockerfile.3d`（`Hunyuan3D-2.1` / `TRELLIS.2`），风险最低。
2. **3D 在 UI 中的入口位置**：
   - 作为独立工坊工具第 7 项（`工坊 → 生成 3D`，直接对当前去背图/道具图出 `.glb`，沿用工坊「一图一任务 + 版本树」心智），还是放在顶部 `[创作 | 工坊 | 作品库]` 的模型卡 `3D` Tab 里？
   - *建议*：**Image-to-3D 天然贴合「先出 2D 概念图 → 进工坊去背 → 一键转 3D `.glb`」**，放在**工坊（「游戏与 3D」分栏末端新增 `转 3D 模型` 工具）+ Stage 动作坞快捷入口**最顺滑；模型卡的 `3D` Tab 则只作版本树筛选/状态展示。
3. **2D → 3D 的多视角协作**：
   - 现有 `spritesheet-2x2` LoRA 后续优化后可作为辅助，但 `Hunyuan3D-2mini / 2.1` 与 `TRELLIS.2` 本身针对**单张透明背景正视/斜45°孤立道具图**效果最佳，默认流程应优先喂入**去背后的单物体 RGBA 图**。
