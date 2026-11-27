# 空间算法实验工具

这组工具复现工坊 E0/E1/E2：固定 16 张真实图、4 类解析合成图 × 8 方向，对照现行 WebGPU/WebGL、两层软 Alpha 原型与 ZipDepth。原型没有被客户端导入；真实图没有新视角真值，不生成伪 PSNR/LPIPS 结论。

## 运行

从项目根目录使用 PowerShell 7，所有脚本先做语法检查。默认输出为 `.tmp/spatial-e0-e2-2026-11-27/`，包含模型、CPU 参考张量、冻结的渲染器副本和可独立打开的 `index.html`。

1. `node --check tools/spatial/prepare.mjs`，然后 `node tools/spatial/prepare.mjs`：校验样图、固定 SHA-256 并复制现行渲染器。重新准备会替换快照；已有报告应使用新的输出目录，不能混用不同基线。
2. 准备官方 ZipDepth revision `91f3fd21e131641f51e8d35736d1958350180e3a` 的源码到输出目录下 `zipdepth-source/`。需保留 `zipdepth/model`、`zipdepth/utils`、包入口与 `scripts/export.py`，以及 `LICENSE`、`checkpoints/zipdepth_base_npu.pth`。checkpoint SHA-256：`627c04fda584133ead4310074884a4a037061b4c01ba86e73e492ea30fab570d`。官方源：<https://github.com/fabiotosi92/ZipDepth>。
3. Python 依赖：本机使用 `torch 2.8.0+cpu`、`onnxruntime 1.27.0`、NumPy、Pillow；额外 `onnx 1.18.0` 安装在输出目录的 `python-deps/`，通过该进程的 `PYTHONPATH` 引用，无需改项目依赖。
4. `python tools/spatial/export-zipdepth.py --out <输出目录>`：保留原前向图导出静态 384² FP32，并校验 PyTorch 与 ONNX。上游导出 helper 将 learned global context 改为 average pooling，因此此处绕过 helper，不能混用它产生的参考结果。
5. 把已固定的 DA3 文件放在 `.tmp/m4e-da3-small.onnx`（注册表 `da3-small-int8`，SHA-256 `9194a0d5602d71e6407aabeb50ebe5bde9fb25d0c35514b7ef868219034e14d7`）。执行 `python tools/spatial/model-probe.py --root <项目根目录> --out <输出目录>`：生成 FP16 导出与三模型的 CPU 输出、预处理张量和深度图。ZipDepth 自带 ImageNet 归一化，输入为 RGB 0..1；DA3 输入需在外部归一化，两者分别处理。
6. `node --check tools/spatial/bench.mjs` 后运行 `node tools/spatial/bench.mjs <输出目录>`。使用 `tools/promo` 已安装的 `playwright-core` 与现有 Chrome/Edge，可通过 `IMAGEN_BROWSER` 指定浏览器。按项目 ORT-Web 1.22、WASM 单线程设置，逐值核对输出、跑解析目标和真实图对照。`--resume` 仅续跑同一输入/同一代码的未完成实验；修改原型后使用新目录重跑，不能据缓存冒充新结果。
7. `python tools/spatial/report.py --root <项目根目录> --out <输出目录>`：汇总数值与 PNG，生成可在本地打开的 HTML。
8. 可选 `python tools/spatial/audit-da3.py --root <项目根目录> --out <输出目录>`：分别关闭/启用 CPU 图优化核对现有 DA3 的跨后端差异；不同 ORT 版本用隔离目录运行，输出文件含版本号。

例：

```powershell
$experimentRoot = 'D:\document\development\aigc-studio\.tmp\spatial-e0-e2-2026-11-27'
$env:PYTHONPATH = "$experimentRoot/python-deps"
python tools/spatial/export-zipdepth.py --out $experimentRoot
python tools/spatial/model-probe.py --root 'D:\document\development\aigc-studio' --out $experimentRoot
Remove-Item Env:PYTHONPATH
node --check tools/spatial/bench.mjs
node tools/spatial/bench.mjs $experimentRoot
python tools/spatial/report.py --root 'D:\document\development\aigc-studio' --out $experimentRoot
```

## 解释结果

- `pass` 是预先设置的数值门槛：形状匹配、全有限值且 MAE / CPU 输出标准差小于 1%；不是整体图像质量或模型商用品质认证。
- FP16 先对照同一 FP16 导出的 CPU，再单列 CPU FP16 对 FP32 差异，避免混淆转换误差与执行后端误差。
- 解析场景来自独立连续函数超采样，具有正确目标视角。`oracle-alpha` 仅做上限诊断，不能当自动方法结果；自动原型仅接收 RGB 和软深度。评测裁去 30px 画框边界，固定实际运动幅度。
- 两层聚类、颜色直线估计和低频 Pull-Push 都是参考实现，不代表完整 matting、多层重建或语义补全。Alpha 边界的颜色恢复、背景补洞分别保留对照开关。
- 测试计时包括相应 API 的等待/回读；模型计时不含下载与预处理。CPU 原型逐帧耗时不能作为 WebGPU 帧率。
- 现有渲染器的缓存指纹仅采样六个值。评测每张图使用新页面、不同深度模型使用独立模块状态，避免碰撞污染实验；此处尚未修改产品代码。
- 快速不等于默认更好。最终选择见 `docs/WORKSHOP_SPATIAL_SOTA_RESEARCH.md` 的本轮实验记录。

## 检查

`node test/spatial-research.mjs` 校验已知像素保留、零位移、Alpha 估计与运动坐标。`node tools/spatial/check-report.mjs <输出目录>` 检查基线哈希、实验完整性与 HTML 资源。`node test/check-client-depth-fx.mjs` 保持现有客户端空间滤镜回归。模型和浏览器长实验不加入普通离线测试套件。

## 第二轮：实际客户端预处理与自适应参考（2026-11-28）

`node --check tools/spatial/continue-bench.mjs` 后运行 `node tools/spatial/continue-bench.mjs <新输出目录>`。此探针复用第一轮已校验的模型与渲染器副本，用 esbuild 打包当前 `runLocalDepth()`，注入本地权重运行其完整预处理/推理/归一化；ZipDepth 复用相同缩放和裁切函数，输入保持 0..1。模型选择仍隔离于研究工具。

`adaptive-ldi.mjs` 增加深度聚类、局部颜色归属、遮挡侧扩展、已知上下文评分的样例块补洞。全局聚类仍不能区分深度相近的独立对象，细栏杆的深度模糊也未解决。没有把“自适应层”当作完整对象分割或语义补全。

继续运行 `node --check tools/spatial/worker-probe.mjs`、`node tools/spatial/worker-probe.mjs <新输出目录>`，直接复用现有 `localInference.worker.js` 分别跑 16 图，核对 Worker 与直接调用的结果。时间含预处理、Worker 往返、输出归一化，排除下载、图片解码及渲染，首图包含 Session 初始化。

最后运行 `python tools/spatial/followup-report.py --out <新输出目录>` 输出第二轮 HTML、拼图与统计。结果和失败样例见调研文档 §9。

正式渲染器的六点抽样缓存已于本轮修复为弱引用身份加 `revision`：换 TypedArray 必须刷新，复用同一不可变快照可缓存；原地编辑需增加外层 `revision`。历史基线保留旧行为，历史实验仍每图独立上下文。
