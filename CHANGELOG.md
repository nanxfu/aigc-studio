# 更新日志 (CHANGELOG)

## Unreleased（M4.2c 工坊静默感知与极简引导，2026-11-24）

> 对应 [`docs/WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md`](docs/WORKSHOP_GUIDED_UX_AND_PERCEPTION_PLAN.md)：工坊的「类 Jev」感知层在本地静默工作，界面则收束成黑白灰工作室该有的样子——单行顶栏、工具分栏一次平铺、控件优先的参数卡、画布操作区一个接力胶囊。**Phase 1a** 落地感知底座与 Host 溯源；**Phase 1b** 按评审把初版 UI 收束回产品调性；**Phase 1c** 移除底栏、统一「应用即落盘」，并补齐版本树里的 `workshop` 语义。

### Phase 1a：感知底座与溯源

- **感知层（新模块）**：[`web/logic/workshopPerception.js`](web/logic/workshopPerception.js) 把三路信号融合成一份确定性输出（Choice 六类场景概率分布 / Noul 六个动作概率 / Score 专业倾向度）——`preset.sceneTags`（模型天生擅长什么）+ `rootPrompt` 原生提示词关键词 + 256px 采样像素特征（Alpha 占比、外框纯色度、主体色数与集中度、纯色像素占比、3×3 分块均匀度、序列帧空白格线、周期像素格）。纯函数、无 DOM、无网络、无模型，`<10ms` 出首屏态；提示词与模型标签只做加分，不越过强的图像证据。
- **契约（`shared/contract.js`）**：`WORKSHOP` 新增 `scenes`（`illustration_or_photo` / `isolated_prop` / `pixel_art` / `sprite_sheet` / `seamless_texture` / `flat_icon_logo`）与 `professionalThreshold: 0.45`。工具 id、通道白名单与保存契约完全不变。
- **Host 溯源**：[`server/output.js`](server/output.js) 的 `readHistoryItem` 追加只读 `rootPrompt` / `rootPresetId`——沿 `rootImage` 读根作品 meta 拿回原生提示词与预设 id（`memo.contexts` 缓存、600 字符截断、导入图与无上级根为 `null`），因为工坊保存会把 `params.prompt` 覆写成作品名或工具 id，当前 prompt 已不可信。`params.prompt` 的既有重现语义零改动。
- **模型资产**：`models/*.json` 允许可选 `sceneTags`（按契约白名单校验、去重、非空数组，[`tools/build-assets.mjs`](tools/build-assets.mjs) 投影透传），[`shared/models-guide.js`](shared/models-guide.js) 新增 `presetSceneTags(preset)`。首个使用者 `anima-turbo-v1.1`（`["illustration_or_photo"]`）。

### Phase 1b：界面收束

- **单行顶栏 + 按领域分栏全平铺（[`Workshop.jsx`](web/studio/workshop/Workshop.jsx)）**：去掉「资产工坊 + 两行副标题」标题块与「返回创作」按钮（全局 TopBar 已常驻三段切换），顶栏压到单行约 46px；六个工具按 `平面与提取`（抹除背景 / SVG 矢量 / 无缝平铺）与 `游戏与 3D`（像素对齐 / 序列帧 / PBR）分栏**一次平铺**，组间用极小号组名与细竖线分隔，**不折叠、不下拉、不二级切换**，窄屏横向顺滑滚动；每个工具带 `<Icon>`，首推工具旁一枚轻量推荐点（不再是文字角标）。
- **切换动效**：工具条复用顶栏同源的 `useSlidingThumb` 滑动高亮胶囊（`--ofs-time-slide` / `--ofs-ease-spring`），左侧参数卡按 `key={tool}` 重新挂载并播一次 `--ofs-time-feedback` 切入过渡；`prefers-reduced-motion` 由 `base.css` 全局规则统一降到 0.01ms。
- **静默感知，前台不做选择题**：删除通栏 `.ofs-workshop-scene` 卡片、6 枚场景芯片与「手动覆盖 / 恢复自动识别」，`perceiveWorkshopWork` 同步去掉 `sceneOverride` 入参与 `overridden` 出参（分类器只做内部实现）；判定为完整画作 / 摄影且专业度低时，只在 `.ofs-workshop-canvas-stage` 顶部边缘飘一条半透明、可关闭（`✕`）的提示，带纯文字链接 `返回创作台精修 ›`（不放实心主按钮）。
- **控件优先参数卡（[`WorkshopParams.jsx`](web/studio/workshop/WorkshopParams.jsx)）**：说明与示意图改为参数卡标题右侧 `?` 按钮按需展开，**无本地记录时默认折叠**，展开后是「一句话说明 → Before/After 示意 → 识别场景解读」；像素格距 / 接缝 MAE / 帧尺寸保持单行轻提示；`ModelSelect` 许可移到「模型」标签行右侧（`免登录 · 极速 · MIT`），去掉灰色通栏协议块，`RMBG-2.0` / `Ubisoft CHORD` 的受限提醒只在**选中它时**以紧凑警告出现（`cutoutHint` / `pbrHint` 随之删除）。
- **示意图渲染修复（[`samples.jsx`](web/studio/workshop/samples.jsx)）**：修掉 `<Arrow x="56" />` 字符串传参导致 `x + 5.6` 变成 `"565.6"`、箭头头部飞出画布只剩横杠的 Bug（改为 `x={56}`，并在渲染测试里加断言防回潮）；`CutoutSample` 在棋盘格一侧先垫一层实心底色再叠主体，抠图后的椭圆不再透出格子。
- **底栏原位接力**：删除独立 `.ofs-workshop-handoff` 卡片行，底栏状态行右侧只放 **1 个**最匹配的接力胶囊（`继续：拆解 PBR 材质 ›`），`title` 带「为什么推荐 / 会先保存」；点击仍是**先落盘再切焦点**，版本树可追溯且不丢中间产物。
- **清理**：词典由 1298 键精简到 1277 键（删场景芯片、折叠开关、说明标题、协议长文等 21 个冗余键），[`workshop.css`](web/styles/workshop.css) 按新骨架重写（旧的分组开关 / 场景卡 / 接力卡样式全部移除），[`responsive.css`](web/styles/responsive.css) 同步收口。

### Phase 1b 补丁：顶栏焦点与左栏高度（2026-11-24 二次打磨）

- **工具分栏各成一枚胶囊**：两个领域不再共用一条轨道——`平面与提取` 与 `游戏与 3D` 各自一枚独立胶囊（组名在胶囊最左，与按钮之间一条 hairline），胶囊之间留白分隔；窄屏仍整体横向滚动。新增 `.ofs-workshop-cluster` / `-cluster-label` / `-cluster-thumb`，移除旧的 `.ofs-workshop-tools-group` / `-tools-sep` / `-tools-thumb`。
- **选中项改成墨色实心胶囊**：原来白底 pill 落在 `#f4f4f6` 轨道上、明度差约 3%，几乎看不出当前工具；现在选中项是 `--ofs-accent-grad` 实心胶囊 + 反白文字（深色主题自动反相成浅色胶囊），推荐点也随底反相，成为整页唯一的强焦点。首帧未测量时由 `.is-on` 自带墨色底兜底，不会出现白字压在浅底上。
- **滑块支持多容器（[`useSlidingThumb.js`](web/studio/hooks/useSlidingThumb.js)）**：容器里找不到当前项时收起滑块（不再停在旧坐标），两枚胶囊各持一个实例；顶栏 tab 的行为不变。
- **最近作品高度封顶**：缩略图网格 `max-height: clamp(96px, 26vh, 208px)` + 内部滚动（允许最后一行露半格，常显细滚动条），作品再多也不会把工具参数顶出首屏；`本地上传` 从整行虚线按钮 + 一行说明收进该卡标题行（`+ 本地上传`），再省约 52px。
- **修掉模型许可占位符丢失**：`studio.workshop.modelLicenseInline` 词典值曾被写成 `{license}`，界面上只剩「MIT」；补回 `{grade} · {license}`（显示 `免登录 · 极速 · MIT`），并在渲染测试里断言许可文案必须同时含档位与协议，`zh` / `en` 的占位符集合也做了一次交叉核对。

- **工具链与测试**：[`tools/preview/app.jsx`](tools/preview/app.jsx) 补漏掉的 `workshop.css` 引入，[`tools/preview/scenarios.mjs`](tools/preview/scenarios.mjs) 新增 `workshop-tools` / `workshop-dark` 两个预览场景；[`test/check-client-workshop.mjs`](test/check-client-workshop.mjs) 重写为 15 项（单行顶栏结构、静默感知与轻提示可关闭、`?` 展开与箭头几何断言、底栏接力先保存），[`test/check-client-workshop-perception.mjs`](test/check-client-workshop-perception.mjs) 17 项（分组名改为 `plane` / `game3d`，并断言外部 `sceneOverride` 被忽略），[`test/host-workshop.mjs`](test/host-workshop.mjs) 15 项（根作品先验溯源）。`npm run test:client` 25/25 步、`npm run test:contract` 3/3 步、`npm run test:host` 37/37 步、`npm run build` 全绿；`tools/preview` 浅 / 深色对比图已重新截取。

### Phase 1c：底栏取消（应用即落盘）与工坊版本语义

- **移除 `.ofs-workshop-foot`（[`Workshop.jsx`](web/studio/workshop/Workshop.jsx)、[`workshop.css`](web/styles/workshop.css)）**：整行底栏（保存到作品库 / 导出 ZIP / 状态行）删除，页面回到「单行工具顶栏 + 两栏主体」，画布与操作区吃满全高；后端 `GET /api/workshop/export` 契约与 [`web/api/workshop.js`](web/api/workshop.js) 的 ZIP 下载函数保留，只是不在工坊占 UI。
- **统一「预览不写盘，应用即落盘」**：调参只更新前端实时预览；本机确定性算子点「应用」、矢量点「生成 SVG」后直接 `POST /api/workshop/save` 落盘进作品库，随后切焦点到新作品（`actions.workshopSaved`）、发全局 Toast；保存失败保留当前结果，只在参数按钮下方留一行 `保存失败：原因`。GPU 算子（抹除背景 / PBR）仍是「提交任务 → 宿主落盘」，提交成功后由排队进度接上单行读数，完成走 Toast。`keepResultRef` / `keepToolOnNextWorkRef` 防止切焦点时清掉刚算出的结果或让感知改掉当前工具。
- **接力胶囊迁入画布操作区**：[`WorkshopStage.jsx`](web/studio/workshop/WorkshopStage.jsx) 的 `.ofs-workshop-canvas-actions` 同排左侧只放 1 个最匹配的下一步；应用即落盘后 `data-needs-save="false"`，点击直接带着已保存的新作品切工具、不重复保存，只有测试注入 / 老数据里未落盘的 `result` 才兜底先保存。
- **版本树独立 `workshop` 语义（[`web/logic/lineage.js`](web/logic/lineage.js)、[`VersionPanel.jsx`](web/studio/filmstrip/VersionPanel.jsx)、[`Filmstrip.jsx`](web/studio/Filmstrip.jsx)）**：`LINEAGE_KINDS` 增加 `workshop`，判定顺序改为 `upscale → outpaint → inpaint → workshop → img2img/text`，节点透传 `workshopTool` / `channelCount`；新增 `workshopToolOfJob()`（`remove-bg → cutout`、`pbr → pbr`），在途 GPU 任务的幽灵行也标成工坊加工。版本行按工具选图标、优先显示具体工具名，摘要显示「工具名 · N 通道」，不再把 `cutout` 这类英文 slug 当生成提示词。
- **修复两处体验缺陷**：
  - **胶囊滑块切换时文字与底色错位**：滑块改为 `background: #fff` + `mix-blend-mode: difference`（胶囊 `isolation: isolate`），文字不随选中态换色、由滑块就地反相——不再出现「白字先跑到浅色轨道上」，深浅主题自动反相；`useSlidingThumb` 在容器里没有当前项时停用过渡，焦点换回另一枚胶囊时直接落定，不从上一次的旧坐标滑进来。
  - **最近作品缩略图挤成一团**：4 列在 302px 侧栏里只剩 59px，`max-height` + 内部滚动还让最后一行露半格；改为 3 列 × 2 行、最多 6 张（`MAX_RECENT_WORKS`），卡片高度恒定、不再裁切，第 7 张起提示行改口「只列最近 6 张；更多在作品库」。
- **文案与测试**：删除保存 / 导出 / 状态行等 14 个失效键，新增 `appliedSaved` / `vectorizedSaved` / `sideHintMore` / `filmstrip.versionKind.workshop` / `filmstrip.workshopChannels`，`生成 SVG` 双语文案同步（zh/en 1268 键同构）；[`test/lineage.mjs`](test/lineage.mjs) 19 项（工坊节点 + 在途幽灵），[`test/check-client-workshop.mjs`](test/check-client-workshop.mjs) 19 项（应用即落盘成功 / 失败、SVG 落盘、GPU 参数、新位置接力、版本面板工坊行与幽灵行），[`test/check-client-logic.mjs`](test/check-client-logic.mjs) 增加「底栏键已清理」断言、渲染测试新增可选 canvas 替身（`createTestClient({ canvas: true })`）覆盖真实编码路径。

## Unreleased（M4.2a/b 资产工坊与复合资产包，2026-11-23）

> 对应 [`docs/M4_VIDEO_AND_GAME_ASSET_PLAN.md`](docs/M4_VIDEO_AND_GAME_ASSET_PLAN.md) 的 M4.2 后半段：出图之后的高频加工第一次有了落点——独立「工坊」页、复合资产包（一张作品带多通道）、纯本机确定性算子，以及走任务队列的抹除背景 / PBR 拆解。同时修复切视频工作台时的 `presetAvailableForProvider` 未定义崩溃。

- **修复（切视频工作台报错）**：[`web/logic/preset.js`](web/logic/preset.js) 用 `export ... from` 转发算力来源判定，但模块内的 `modePresetCandidateOf()` 会直接调用 `presetAvailableForProvider`；纯 re-export 不建立本地绑定，切「视频」时抛 `ReferenceError: presetAvailableForProvider is not defined`、界面无反应。改为先 import 再 export，并在 [`test/check-client-video.mjs`](test/check-client-video.mjs) 补带 `provider` 的候选解析回归用例。
- **契约（`shared/contract.js`）**：新增 `WORKSHOP`（六类工具 id、通道角色 / 格式白名单、保存与导出体积上限、像素 / 序列帧 / 平铺 / 矢量 / 抹除背景 / PBR 的算子边界与模型清单）与 4 条路由（`/api/workshop/save`、`/export`、`/vectorize`、`/op`）；`REQUEST_TOOLS` 扩展为五类（`generate / upscale / outpaint / remove-bg / pbr`），`daemonContract().limits.workshop` 随协议下发远端；新增 host 错误码 `vectorizer_unavailable`（503）。
- **Host**：新增 [`server/workshop.js`](server/workshop.js) 与 [`server/routes/workshop.js`](server/routes/workshop.js)——复合资产包落盘（主图 `01.png` + `<role>.<ext>` 通道 + `meta.channels[]`，`sourceImage` / `rootImage` 继承来源作品版本树）、ZIP 导出（复用 [`server/bundle.js`](server/bundle.js) 的纯 JS `createZip`，整目录打包）、SVG 矢量（[`@visioncortex/vtracer`](package.json) Node WASM，0 Python / 0 GPU，失败回 503）、GPU 算子提交（`remove-bg` / `pbr` 进现有串行队列）；[`server/output.js`](server/output.js) 的历史条目新增 `channels[]` / `workshop` / `workshopTool` / `workshopParams`，并支持 `results[].channel` 多通道落盘（第一个通道即画廊主图，PBR 四通道仍是一张卡）。
- **客户端工作台**：顶栏改为三段 `[创作 ▾ | 工坊 | 作品库]`（原「画廊」文案统一为「作品库」）；新增独立工坊页 [`web/studio/workshop/Workshop.jsx`](web/studio/workshop/Workshop.jsx) + `WorkshopParams.jsx` / `WorkshopStage.jsx` / `pixels.js`（预览与应用分离、棋盘格透明底、网格、2×2 平铺、逐帧动画、通道切换条、保存 / 导出 ZIP）；本机算法落在 [`web/logic/workshop.js`](web/logic/workshop.js)（像素网格探测、Oklab 调色盘量化、接缝 MAE 与余弦混边、序列帧切片与 atlas、平铺几何）；舞台动作坞新增第三组「抹除背景 / 进工坊 ↗」（[`ImageDock.jsx`](web/studio/stage/ImageDock.jsx)），视频作品仍不渲染动作坞。
- **导航细节**：从作品库 / 工坊单击「创作」直接回到工作台并保留上一次的创作类型（生图 / 视频），不再先弹类型菜单等二次确认；已在创作页时点「创作」才开合类型菜单。`check-client-workshop.mjs` 补两个视图来源的回归用例，真实浏览器冒烟 8/8。
- **M4.2b 专业加工**：像素对齐（边缘周期网格自动探测 + Oklab 中位切分 / K-Means 量化 + Alpha 硬边）、序列帧切片（网格 + 动画预览 + `atlas.json` + `spritesheet` 双通道）、无缝平铺（接缝读数 + 混边）、PBR 材质拆解（`Marigold` 基线 / `Ubisoft CHORD` 研究许可，albedo / normal / roughness / metallic 四通道切换条）。
- **GPU 后处理链路**：[`server/jobs/validator.js`](server/jobs/validator.js)、[`server/jobs/queue.js`](server/jobs/queue.js) 支持 `remove-bg` / `pbr`（模型白名单、源图边界、steps 钳制、结果按通道归一）；[`worker/daemon.py`](worker/daemon.py)、[`worker/transport/validator.py`](worker/transport/validator.py)、[`worker/config.py`](worker/config.py) 新增工坊分支（RMBG-2.0 / BiRefNet 抠图、Marigold PBR 四通道、`chord` 未接入时明确失败），执行结束统一释放模型与显存；[`test/mock-daemon.py`](test/mock-daemon.py) 同步支持两种工具。
- **文档与测试**：[`docs/DESIGN.md`](docs/DESIGN.md) 新增 §16「资产工坊」、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 新增 §2.25、[`docs/SPEC.md`](docs/SPEC.md) 补 4 条路由与 §5.26/§5.27；新增 [`test/host-workshop.mjs`](test/host-workshop.mjs)（14 项）、[`test/host-workshop-gpu.mjs`](test/host-workshop-gpu.mjs)（9 项）、[`test/check-client-workshop.mjs`](test/check-client-workshop.mjs)（10 项）、[`test/check-client-workshop-logic.mjs`](test/check-client-workshop-logic.mjs)（13 项）、[`test/worker/test_workshop.py`](test/worker/test_workshop.py)（36 项）。真实浏览器端到端冒烟（导入 → 四种本机算子保存 → SVG 通道读回 → ZIP 导出 → 动作坞进工坊）15/15 通过。
- **补修与真机 GPU 验收（Kaggle Tesla T4，2026-11-23）**：
  - 修复 [`server/paths.js`](server/paths.js) 缺 `.svg` MIME 类型（`image/svg+xml; charset=utf-8`）、[`Workshop.jsx`](web/studio/workshop/Workshop.jsx) GPU 完成后异步切换回 `source` 的竞态、[`WorkshopStage.jsx`](web/studio/workshop/WorkshopStage.jsx) 对 `svg`/`atlas.json` 通道的文本/图片预览支持、以及[`workshop.css`](web/styles/workshop.css)/[`responsive.css`](web/styles/responsive.css) 侧栏阴影裁切、窄标签省略、禁态按钮与窄屏工具条换行问题。
  - 修复真机暴露的两处 Worker 缺陷与一处分类缺口：[`worker/inference/game_ops.py`](worker/inference/game_ops.py) 的 Marigold PBR 改走 `iid_pipe.image_processor.visualize_intrinsics(...)` 并显式清理管线句柄、BiRefNet 输入张量对齐模型权重 `fp16` `dtype` 并在 `.sigmoid()` 后转回 `fp32`；[`worker/daemon.py`](worker/daemon.py) 的 `classify_workshop_failure` 接入 `is_gated_repo_error` 返回 `model_gated`。
  - 真机实测（[`test/gpu-live.mjs`](test/gpu-live.mjs) `--workshop`，768×768，`result_mode=binary` + `/artifact` SHA-256 校验）：`BiRefNet` 12.1s 完成 RGBA 去背（峰值显存 8889 MiB，前景实心 `alpha=255` 更干净）；带授权 `HF_TOKEN` 实测 `RMBG-2.0` 11.4s 完成（峰值显存 10193 MiB，外缘收紧更干脆；无授权时准确返回 `model_gated`）；`Marigold` PBR（4 步）35.2s 完成四通道（峰值 10837 MiB，`albedo/normal` 质量佳，`roughness/metallic` 在纯色棚拍背景道具上受限于 InteriorVerse 室内域先验）；释放显存后复测 `sdxl-lightning` 3.52s 正常出图不 OOM。已将 `WORKSHOP.cutout.defaultModel`（[`shared/contract.js`](shared/contract.js)）切换为免登录开箱即用的 `birefnet`，并在卡片与提示文案标注 `RMBG-2.0` 的受限授权要求。

## Unreleased（交互收敛：草稿因果对齐、光桌分叉态与参考图飞入动效，2026-11-23）

- **左栏状态去横幅化**：移除 [`web/studio/Rail.jsx`](web/studio/Rail.jsx) 顶部「基于此图：…」「已修改… · 尚未生成」文字状态条（清理对应字典键与 `.ofs-tuning*` 样式），查看历史作品与开始改词时不再出现顶部警告条和输入跳动。
- **就地信号与顶/底分工**：
  - 顶部「提示词」标题行右侧在相对原作品有改动时给出轻量 `重置参数`（`.ofs-reset-params`，零额外行高），不给「提示词」分组亮圆点或变色；
  - 其余分组（「参考图 / 画面设置 / 排除项 / 高级参数 / 张数」）在相对原作品有改动时于标题旁亮起与胶片条同色系的 `.ofs-fieldset-dot`（纯逻辑 `formSectionChangesOf` 落在 [`web/logic/form.js`](web/logic/form.js)）；
  - 页脚保持单一主按钮，在改写态切为 `生成新图` / `生成新视频`，直接说明提交后果。
- **光桌分叉取景态**：[`web/studio/Stage.jsx`](web/studio/Stage.jsx) 在作品预览态且左栏存在未提交修改时进入 `.is-draft-fork`——原图相纸柔顺缩退微倾（悬停可回浮查看细节），前景叠出实时跟随目标画幅 `--ofs-fork-r` 滑移的虚线取景框 `.ofs-fork-frame` 与 `将生成新图 · {spec}` 徽标，点「重置参数」通过 `usePresence` 播 220ms 退场并回弹原图。
- **模型切换 / 设为参考图收口与抛物线飞入动效**：[`web/studio/useStudio.js`](web/studio/useStudio.js) 与 [`web/studio/hooks/useStudioForm.js`](web/studio/hooks/useStudioForm.js) 新增 `startNewDraftFromWork()`，在作品上切模型或点「设为参考图」时统一切入新建草稿并按能力位挂入参考图（[`web/logic/reference.js`](web/logic/reference.js) 拦截视频条目）；新增 [`web/studio/ReferenceFlyOverlay.jsx`](web/studio/ReferenceFlyOverlay.jsx)，当舞台作品显式加入支持原生参考的左栏/助手槽位时，播放 580ms 非线性抛物线（上抛 → 下落 → 回弹填充放大）副本飞入动效。
- **文档与测试**：同步 [`docs/DESIGN.md`](docs/DESIGN.md) §15 与 [`docs/SPEC.md`](docs/SPEC.md) §5.25；[`test/check-client-logic.mjs`](test/check-client-logic.mjs)、[`test/check-client-draft.mjs`](test/check-client-draft.mjs)、[`test/reference.mjs`](test/reference.mjs) 补充对应断言；`npm run build`、`npm run test:contract`（3/3 步）与 `npm run test:client`（22/22 步）通过。

## Unreleased（M4.2 视频舞台与抽帧接力，2026-11-23）

> 对应 [`docs/M4_VIDEO_AND_GAME_ASSET_PLAN.md`](docs/M4_VIDEO_AND_GAME_ASSET_PLAN.md) 的 M4.2 前半段：视频产物第一次「能看、能玩、能接着做」——原生播放、逐分辨率读数、首尾帧一键取回成普通作品。

- **舞台播放**：视频作品在 [`web/studio/Stage.jsx`](web/studio/Stage.jsx) 用原生 `<video controls autoPlay loop playsInline preload="metadata">` 播放（`/api/file` 早已支持 Range 206 与 `video/mp4`），放大层同样换成 `<video>`；不再挂「点开大图」「对比原图」「以此图重绘」这些图片专属动作，动作坞整体让位。
- **抽帧接力**：新增 [`web/logic/video.js`](web/logic/video.js)（目标时刻 `frameSeekOf` / 产物命名 `frameNameOf` / 画布尺寸 `frameCanvasSize` / 可抽帧判定）与舞台抽帧条（`取首帧` / `取尾帧`）：渲染进程用 `<canvas>` 把该帧导成 PNG，经 `/api/import` 落成一张**普通作品**——之后既能进参考图槽做 I2V，也能直接开图片工具重绘，版本树与历史全部复用现有链路，Host 不依赖 ffmpeg。[`web/studio/useStudio.js`](web/studio/useStudio.js) 新增 `importFrame` action（复用导入预检与体积护栏）。
- **读数口径**：题注、胶片条、聊天气泡统一显示片长（`5 秒`）而不是生成耗时；聊天聚焦视图的视频结果换成带控制条的播放器，隐藏「继续涂抹」这类图像动作。
- **双模式工作台与视频创作体验完善**：顶栏新增 `[生图 | 视频]` 创作模式切换，与 [`ModelCardPicker.jsx`](web/studio/ModelCardPicker.jsx) 双向联动并恢复「本地 / 各服务商」主 Tab + 次级模态筛选条；视频左栏替换为「视频画幅」（含 `21:9`、挂首帧自动锁定）、一级展开的「视频参数」、带 `首帧 / 尾帧` 角标与「对调首尾」的首尾帧槽（过滤视频作品）；视频空白/等待态舞台改用暗色导演取景框与运镜灵感；修复请求体显式透传 `ratio` 防止 `21:9` 768p 被宽高钳制误判。
- **文档与测试**：[`docs/DESIGN.md`](docs/DESIGN.md) 更新 §14、[`docs/ROADMAP.md`](docs/ROADMAP.md) 与 [`docs/M4_VIDEO_AND_GAME_ASSET_PLAN.md`](docs/M4_VIDEO_AND_GAME_ASSET_PLAN.md) 同步 M4.2 前半与 M4.2a/b 规格；[`test/check-client-cloud.mjs`](test/check-client-cloud.mjs) 与 [`test/check-client-video.mjs`](test/check-client-video.mjs) 补全二维模型卡、模式切换、视频画幅/首尾帧与导演取景框用例；`npm run test:client` 22/22 步通过，`npm run build:web` 构建通过。

## Unreleased（M4.1 硅基流动视频主链路，2026-11-23）

> 对应 [`docs/M4_VIDEO_AND_GAME_ASSET_PLAN.md`](docs/M4_VIDEO_AND_GAME_ASSET_PLAN.md) 的 M4.0 / M4.1：把商业 API 从「文生图」扩展到「文生视频 / 首尾帧图生视频」，并让视频产物进入同一套任务、落盘、历史与舞台。

- **共享目录**：[`shared/image-providers.js`](shared/image-providers.js) 为硅基流动新增视频模型目录（现役 `MiniMaxAI/MiniMax-H3`，另保留 `Wan-AI/Wan2.2-T2V-A14B` / `Wan-AI/Wan2.2-I2V-A14B` 兼容条目、默认模型卡不展示），与生图模型共用 `cloud:<vendor>:<model>` 预设 id；新增 `cloudVideoPresetOf()` / `videoApiModelOf()`，预设带 `mediaType: 'video'`、`category: 'video'` 与 `video` 能力块（时长档位 / 分辨率 / 画幅 / 首尾帧上限）。模型卡按既有 `presetCategoryOf` 自动出现「视频」分类。
- **契约**：[`shared/contract.js`](shared/contract.js) 新增 `VIDEO`（5–15 秒、480p/768p、6 种画幅、15 分钟轮询预算、128 MiB 下载上限）与 6 个 `video_api_*` 错误码；[`server/image-api.js`](server/image-api.js) 的错误归一支持 `codePrefix`，视频复用同一套「余额 → 鉴权 → 限流 → 能力 → 其他」判定。
- **适配层**：新增 [`server/video-api.js`](server/video-api.js)：`POST /video/submit` → 轮询 `POST /video/status`（`InQueue` / `InProgress` / `Succeed` / `Failed`）→ 立即下载到任务临时目录。支持两种提交体形状：MiniMax 的 `duration` / `resolution` / `ratio` + `images[{ url, role }]`（首帧 `first_frame`、尾帧 `last_frame`，data URL）与 Wan 的 `image_size` + `image`（首帧 data URL，可带负向词）；结果 URL 过期前即时落盘，单拍轮询抖动不判死。落盘前用 `probeMp4Size()` 从 MP4 `stsd`/`avc1` 读真实宽高——传参考图时输出画幅由图片比例决定，不能按请求参数推算。
- **真机验收（2026-11-23，硅基流动 MiniMax-H3，480p / 5 秒）**：文生视频 389.2s 出片（含约 4s 排队）→ 864×480 / 756 KB；首帧图生视频 75.6s 出片 → 640×640 / 809 KB（首帧为 1024×1024，验证「画幅随图」）；两份 `.mp4` 均为 h264、5.17s，`ffprobe` 与 `probeMp4Size()` 读数一致。**Host 端到端**（起真实 `server/standalone.js` → 写入凭据 → 切 `cloud-api` → 提交视频任务）105.6s 完成：阶段「提交视频任务 → 生成中 → 下载中 → 完成」，产物 `01.mp4` 864×480 / 887 KB / `duration=5`，`/history` 条目 `mediaType=video` 且 `provider=cloud-api`，`/api/file` 带 `Range` 返回 `206 video/mp4`。产物样张仅本地保留（`.tmp/m4-live/`，不入库）。
- **队列与落盘**：[`server/jobs/queue.js`](server/jobs/queue.js) 新增视频任务分支（`mediaType: 'video'`、固定单条、参考图槽映射首尾帧、T2V 带参考图入队即拒），阶段依次为「提交视频任务 / 排队中 / 生成中 / 下载中」；[`server/output.js`](server/output.js) 支持写 `01.mp4`、`meta.mediaType = 'video'`、`images[].mediaType` / `duration`，历史条目同步透传；`saveTo` 按媒体类型补 `.mp4`，[`server/paths.js`](server/paths.js) 登记 `video/mp4` / `video/webm`。
- **界面**：模型卡视频模型展示单条估价与「时长 · 分辨率」，不再显示固定步数；左栏高级设置对视频模型切换为「视频参数」（时长滑杆 5–15 秒、480p/768p 分段、随机种子），固定时长模型只读展示；页脚改为「时长 · 分辨率 · 单条」并隐藏张数；舞台用原生 `<video controls autoPlay loop>` 播放，放大层同样可播放，胶片条与画廊卡片用首帧缩略图；表单快照 / 作品回填 / 重新生成补齐 `duration` / `resolution` / `mediaType`。
- **测试**：新增 [`test/cloud-video.mjs`](test/cloud-video.mjs) 6 项（视频目录与预设解析、MP4 容器宽高解析、MiniMax 提交体与首尾帧 role、Wan I2V 提交体、错误归一、JobQueue 端到端落盘与历史条目）；`npm run test:contract` 15/15、`npm run test:client` 21/21 步、`npm run test:host` 35/35 步、`python test/worker/run.py` 578 项通过。

## Unreleased（M3.5 Phase B/C：Agent 视觉回看与探索护栏，2026-11-23）

> 对应 [`docs/CLOUD_API_AND_AGENT_EXPLORE_PLAN.md`](docs/CLOUD_API_AND_AGENT_EXPLORE_PLAN.md) Phase B / C。补齐「Agent 真的看得见图」与「授权后按硬预算自动抽卡」两块能力；`npm test` 57/57 步全绿。

- **视觉回看（Phase B）**：新增 [`server/agent/inspect.js`](server/agent/inspect.js) 与 `imagen_inspect` 只读工具。沿用 Host 零图像依赖原则（不引入 sharp / jimp / PIL），直接读产物字节转 pi-ai 原生 `image` 块，靠 `INTENT.inspectMaxBytes`（2MB）/ `inspectMaxImages`（4）与 `resolveOutputPath` 路径护栏控制成本；视觉门控由 pi-ai 在 LLM 边界完成（纯文本模型自动忽略），[`server/llm/config.js`](server/llm/config.js) 的 `piModelOf()` 接入全量 `pi-ai` 内置目录与推荐列表（未命中时才回退 `modelCapabilitiesOf`），`server/agent/tools.js` 新增 `content` 透传通道并补齐 `imagen_batch` 产图提取。系统提示 Layer 3 固化四维审图规范与「针对具体缺陷改词」要求。
- **探索护栏（Phase C 服务端）**：`ui_propose_explore` 方案卡（策略 / 轮数 / 总张数 / 预估费用）触发新的 `explore` SSE 事件；授权后 `exploreBudget` 经 `streamAgentChat` → `/api/agent/chat` → `agent.run` 全链路下发，运行时按轮数放大步数上限（封顶 40）、`beforeToolCall` 做单次前瞻余量拦截（失败提交不扣预算）、逐次累计产图数并发 `explore-progress`，达到 `maxImages` 发 `budget-exhausted` 并封禁后续生图工具同时保留最终文字总结轮，最终以 `stopReason='budget-exhausted'` 收敛。未授权时保持默认 6 步，不自动抽卡。
- **探索交互（Phase C 前端）**：探索卡展示硬预算胶囊与「开始探索」；点击后运行中助手气泡实时承接 `explore-progress` / `budget-exhausted` 渲染 `exploreProgress` 进度条与结束标记；多图结果网格新增「并排对比 / 回到网格」切换；聚焦视图新增「选这张继续做变体」，带图片路径回流新一轮对话；探索策略与预算经 `agentThreadMessages` 写回多轮上下文。双语新增 `studio.chat.explore.*`（1082 键同构）。
- **文档与测试**：[`docs/SPEC.md`](docs/SPEC.md) 补 3 个 SSE 事件与预算下发说明，[`docs/ROADMAP.md`](docs/ROADMAP.md) / 专项规划标记 Phase A/B/C 全部完成；`agent-runtime` 23 项、`chat-timeline` 13 项、`check-client-chat` 33 项、`host-e2e` 65 项（工具清单补齐 12 个）。

## Unreleased（界面收敛：算力弹层与运行设置，2026-11-23）

> 一次只做「减法」的整理：两个界面的信息都在，但复述、嵌套与永远点不动的控件被拿掉了。

- **算力状态弹层**：从 [`web/studio/TopBar.jsx`](web/studio/TopBar.jsx) 拆出 [`web/studio/ComputePopover.jsx`](web/studio/ComputePopover.jsx)（顶栏只剩触发胶囊，弹层的取数、2 分钟节流静默刷新与呈现都归自己），面板收成四段「状态 → 额度 → 环境检查 → 动作」，一段一条发丝线：状态段把来源、设备、实测秒/张、闲置关机并成一行读数；额度段去掉重复的「3 / 30 小时 + 已用 3 / 30 小时」，Kaggle 只留环形仪表 + 已用/总量，Colab 的 CCU 改 56px 读数位（余额 <15 / <3 转琥珀 / 红，不再画没有分母的圆环）；环境检查三项全过收成一行「环境检查通过」，失败项才各占一行并带 `标签 · 读数`，「检查环境」降为这一行的三级动作；动作区只给当下可执行的一个（唤醒 / 关闭云端），不再摆永远置灰的另一半。配额读不到时整段换成回退说明，不再同时显示空环。阶段徽章与就绪态提示语删除（标签与读数已经说完）。
- **运行设置（云端算力）**：[`web/studio/settings/SettingsForm.jsx`](web/studio/settings/SettingsForm.jsx) 的来源 / 加速器 / 显卡改为统一的单选胶囊（原生单选点隐去，选中态只由底色 + 描边 + 字重表达，`:has(input:focus-visible)` 保留键盘焦点环）；Colab 授权块并入来源区块、去掉了「卡里套卡」与重复的「Colab Pro（需授权）」标题，状态胶囊挂到区块标题行右端；三步进度只在未授权时出现，已授权时下方只留一句「凭据保存在本机」；重复的「仅保存在本机 / 授权一次即可复用」脚注删除。
- **弹层修正（第二轮）**：Colab 余额已读到、耗速没读到时不再反过来说「还没读到额度」——额度面板改成按来源显式分支，缺哪一段就少一行；未启动的会话不再显示「闲置 30 分钟关机」（没有可关的东西）；授权成功时账号行省掉「账号」两字，把整行宽度让给邮箱，长地址不再被截断成 `xxx@gmail.c…`。
- **运行设置（续）**：Colab / 私有 Worker / 商业 API 三块共用一套 `.ofs-settings-block-head`（裸图标 + 来源名 + 一行状态 / 说明 + 可选状态胶囊），删掉两套几乎一样的头部实现与 28px 描边图标方块；来源胶囊改成两行式（名字 + 限定词，限定词 11px `ink-3`），四个来源并排成一行，名字统一取 `providerLabelOf`（与顶栏胶囊、状态弹层同名），因此删掉 `studio.settings.provider.{kaggle,colab,private-worker,cloud-api}` 四个长名键与 `studio.settings.cloudApi.title`；HF Token 占位符去掉与「来源：宿主配置」重复的「已配置」；折叠行补 32px 热区与悬停底色。
- **商业 API 区块（第三轮）**：四段灰字各压成一句——副标题改成功能口径「按张计费，不占用会话与队列。」，「模型在创作页顶栏的模型选择器里切换。」只在没有模型字段时出现（custom 端点自带说明，不再两句都说一遍），Key 状态去掉重复的服务商名（`硅基流动 已保存 Key` → `已保存 Key`），`Key 加密保存在本机，只用于直接调用所选服务商。` → `Key 加密保存在本机。`，能力边界压成一句「阶段 A 仅支持文生图；重绘、扩图等请切回 Kaggle 或私有 Worker。」。接口地址从「用动作当标签」改成字段行（`接口地址 + 当前端点 + 修改`），custom 端点始终展开；选中项不再显示「已配」角标（Key 行已经说了），外链「获取 Key ↗」降为次级字重，占位符不再重复「多个用逗号分隔」。
- **设计规范**：[`docs/DESIGN.md`](docs/DESIGN.md) 新增 §12「算力状态弹层」与 §13「运行设置（云端算力）」，§3 补单选胶囊的写法（含两行式与四列矩阵）。
- **预览与测试**：`tools/preview` 新增 `settings-compute*` / `settings-appearance` / `compute-popover-*`（离线 / 排队 / 失败 / Colab / Worker / 商业 API / 深色）场景，SettingsForm 首次有可截图的对版入口；`test/check-client-shell.mjs`、`test/check-client-kaggle.mjs` 的结构断言改为新骨架（健康卡 3 张 → 检查区 1 行）。`npm run test:client` 21/21 步通过；`npm test` 56/57 步通过，唯一失败项为 `smoke-image`（本机已有实例在运行，单实例锁按设计退出，与本轮无关）。

## Unreleased（M3.5 Phase A：商业生图 API，2026-11-23）

> 对应 [`docs/CLOUD_API_AND_AGENT_EXPLORE_PLAN.md`](docs/CLOUD_API_AND_AGENT_EXPLORE_PLAN.md) Phase A：先打通「填 Key → 文生图 → 落本地 outputs」的主链路，Agent 看图（Phase B）与探索预算（Phase C）后续迭代。

- **契约与清单**：新增 [`shared/image-providers.js`](shared/image-providers.js) 作为商业生图服务商与云端模型的唯一来源（硅基流动 / fal.ai / OpenAI / 自定义 OpenAI 兼容端点），模型声明能力位（负向词 / 步数 / 引导强度 / 种子 / 单次张数 / 预估单价）；`shared/contract.js` 的 `PROVIDERS` 新增 `cloud-api`（`kind: 'cloud-api'`，0 秒就绪、无生命周期管理），并新增 6 个可执行错误码（`image_api_not_configured / unauthorized / rate_limited / insufficient_balance / unsupported / failed`）与双语文案。
- **云端模型进现有目录**：`presetById()` 支持 `cloud:<vendor>:<model>` 预设；`/api/state.presets` 在 `cloud-api` 下只下发当前服务商的云端模型，切回 Kaggle / Colab / 私有 Worker 时恢复本地 7 个 diffusers 预设。本地预设的缺省可用来源改为「除 cloud-api 外的全部来源」，避免商业 API 下出现「看起来可选、点了必失败」的模型卡。
- **执行链路**：新增 [`server/image-api.js`](server/image-api.js)（OpenAI Images / 硅基流动同步请求、fal 队列提交→轮询→取结果、成图下载与体积/类型护栏、上游错误归一）与 [`server/providers/cloud-api.js`](server/providers/cloud-api.js)（只校验服务商 / 模型 / Key，不产生远端会话）；`SessionManager` 为 cloud-api 提供「校验凭据 → ready」分支，不挂健康轮询、不写会话记录、不参与空闲关机；`JobQueue` 按 provider 分流，逐张请求并复用 `saveJobOutput` / 版本树 / 交付路径。
- **能力门控**：阶段 A 只支持文生图；扩图 / 超分 / 参考图 / 局部重绘在入队阶段返回 `image_api_unsupported` 并提示切换算力来源，不静默丢参数。模型不支持的负向词 / 步数 / 引导强度也不下发，`meta.params` 里记 0 / 空串。
- **设置存储**：`app-config` 新增 `compute.imageApi`（vendor / model / baseUrl）与加密凭据 `credentials/image-api.json`（按服务商分仓，切换服务商不丢上一家的 Key），公开视图只回 `hasApiKey` / `apiKeysConfigured`；`POST /api/app-settings` 新增 `imageApi` 白名单字段，`/api/state` 与 `/api/app-settings` 下发脱敏摘要。
- **设置界面**：算力来源新增「商业生图 API（按张计费）」；设置抽屉新增服务商 / 模型 / 端点 / Key 区块，隐藏空闲关机、HF Token 与预挂载，并说明阶段 A 的能力边界；模型不支持的参数在卡片上直接标注。
- **图片适配细节**：硅基流动按模型推荐画幅就近映射（Qwen-Image 16:9 → `1664x928`，Kolors 竖幅 → `720x1280` 等）；OpenAI 按比例映射到合法尺寸（`1536x1024` / `1024x1536` / `1024x1024`）；fal 队列在总预算内轮询，网络抖动不判死。
- **测试**：新增 [`test/cloud-api.mjs`](test/cloud-api.mjs) 8 项（清单与来源门控、三类厂商协议、错误归一、provider 凭据、SessionManager 0 秒 ready、JobQueue 端到端落盘与能力拒绝）与 [`test/check-client-cloud.mjs`](test/check-client-cloud.mjs) 3 项（设置表单脏判定 / 换服务商重置 / 设置抽屉渲染 / 云端模型卡）；`npm run test:contract` 15/15、`test:client` 21/21 步、`test:host` 34/34 步全部通过。

## Unreleased（GPU 运行时基线阶段 0，2026-11-22）

> 对应 [`docs/GPU_RUNTIME_BASELINE_PLAN.md`](docs/GPU_RUNTIME_BASELINE_PLAN.md) §10 阶段 0：只做镜像与压测准备，不启动任何 GPU 实例。

- **镜像基线**：[`worker/deploy/Dockerfile`](worker/deploy/Dockerfile) 从 `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04`（Python 3.10）切到 `pytorch/pytorch:2.6.0-cuda12.4-cudnn9-runtime`（Python 3.11 + torch 2.6.0 + CUDA 12.4），base 经 `ARG BASE_IMAGE` 传入以便 CI 固定 digest；构建期断言解释器版本、`torch 2.6.0`、`torch.version.cuda == '12.4'` 与六个核心包的精确版本，任一不符即失败。
- **依赖锁定**：[`worker/requirements-gpu.txt`](worker/requirements-gpu.txt) 全部精确锁定（`torch==2.6.0+cu124` / `torchvision==0.21.0+cu124` / `diffusers==0.43.0` / `transformers==5.23.0` / `accelerate==1.15.0` / `peft==0.21.3` / `huggingface_hub==1.33.0` / `safetensors==0.8.0` / `pillow==13.0.0`），避免 pip 在构建期把预装 torch 换成新版。
- **容器权限**：镜像改为 **root 运行**，消除 `USER worker` 与 RunPod `/workspace`（`root:root`）的写入权限死锁（此前会静默回退 `/tmp/hf` 并写爆容器盘）；入口脚本的 `/tmp/hf` 回退只作为显式 `--user` 覆盖时的安全网，并新增一行 `cpu_offload` / `hf_home` 启动日志。
- **`cpuOffload` 压测开关**：新增 [`worker/inference/policy.py`](worker/inference/policy.py)（`auto` / `on` / `off` 纯函数）与 `worker_server.py --cpu-offload`（等价环境变量 `AIGC_WORKER_CPU_OFFLOAD`）；覆写在 `daemon.ensure_pipeline` 计算缓存键**之前**生效，切模式会重新加载而不是命中旧管线；`/health.cpu_offload` 上报 `{mode, source, effective}`。默认 `auto` 返回原 spec，缓存键与改造前逐字节一致。
- **CI 构建**：新增 [`.github/workflows/worker-image.yml`](.github/workflows/worker-image.yml)：清理 runner 预装工具链释放磁盘 → 离线基线校验 → buildx 构建（GHA 缓存）→ 体积闸门（压缩 ≤8GB / 未压缩 ≤10GB）→ 无卡冒烟（镜像内断言协议版本、Python 3.11、torch/diffusers/transformers 版本、`cpu_offload=off` 生效、Token 不进 `/health`、无卡时 `gpu_unavailable`）→ 推送 GHCR（`edge` / `sha-*` / `worker-v*` 版本号）。
- **离线校验**：新增 [`tools/check-worker-image.py`](tools/check-worker-image.py)（`npm run worker:check`），交叉校验 base tag、root 运行、依赖锁定与 Dockerfile 断言是否自洽、入口脚本 Token/`--no-install`、`.dockerignore` 与「海外节点不得设 hf-mirror」。
- **部署文档**：[`worker/deploy/README.md`](worker/deploy/README.md) 补充 GHCR 取镜像、镜像体积闸门、`cpuOffload` 开关与「RunPod / Vast 不要设 `HF_ENDPOINT=hf-mirror.com`」；`start-container.sh` 不再默认设国内镜像源，增量安装改为复用锁定清单。
- **测试**：新增 `test/worker/test_policy.py` 17 项（模式归一、优先级、覆写不就地修改、缓存键随模式变化、`build_pipeline` 直连路径）；`test_health.py` 补齐 `cpu_offload` 字段断言；`python test/worker/run.py` 566 项通过（24 skip）。
- **CI 实测闭环（2026-11-22）**：`worker-image` 在 GitHub 托管 runner 上构建通过（[run 45028811155](https://github.com/nanxfu/aigc-studio/actions/runs/45028811155) / [run 45030026313](https://github.com/nanxfu/aigc-studio/actions/runs/45030026313)）：**压缩 3.16GB / 未压缩 6.07GB**（闸门 8GB / 10GB），无卡冒烟通过；镜像 `ghcr.io/nanxfu/aigc-worker:edge`（`sha-e316532`，digest `sha256:0963c3aa…`）已公开可拉取。体积闸门同时修正口径：`docker image inspect .Size` 对拉取镜像等于压缩层之和，未压缩改用容器内 `du -skx /`。

## Unreleased（M3.2 云端协议 v2 / M3.3 MCP，2026-11-22）

### M3.2 云端协议 v2（Host + Worker 步数）

- **二进制产物通道**：新增 [`server/net-stream.js`](server/net-stream.js)（流式写盘 + 边下边算 sha256 + 单段 Range 续传，fetch 失败降级 curl）；`server/remote.js` 新增 `downloadArtifact()` 与 `openEvents()`（SSE 解析、`Last-Event-ID`、断流不影响任务）。
- **能力协商**：`JobQueue` 用 `provider.binary/events` + `/health.capabilities` 双重确认；只有远端真的声明 `result_modes` 含 `binary` 才下发 `result_mode=binary`，旧 daemon / 旧 Worker 自动回退 inline，行为与 0.15 一致。Kaggle/Colab 的能力位同步打开（仍以远端自报为准）。
- **产物落盘**：`saveJobOutput` 支持 `result.tempPath`（binary 下载到 `%TEMP%/aigc-studio/artifacts/<jobId>/`），哈希不一致删除半截文件并重试；单张失败重试 2 次后报 `artifact_failed`（Host 按单张拆分远端 job，失败会明确报出而不是静默丢图），任务收尾统一清理临时目录。
- **扩散步数**：`Job` / `JobStore` 增加 `step/steps`，`/job` 与 `/events` 的 `progress` 同步下发；`worker/daemon.py` 按 pipeline `__call__` 签名注入 `callback_on_step_end`（旧管线回退 `callback`），1 秒节流、每张开始归零。
- **UI**：任务卡 / 进度胶囊显示「正在生成第 x/y 张 · 12/28 步」，超分等无步数任务保持原文案。
- **轮询兜底**：Host 的 `onProgress` 同时读取 `/job` 的 `progress.step/steps`，即使 SSE 被代理 100 秒超时切断（RunPod HTTP proxy）也能显示步数。
- **容器入口**：新增 `worker/deploy/docker-entrypoint.sh`，支持 `AIGC_WORKER_TOKEN` 环境变量与 `HF_HOME` 不可写时回退 `/tmp/hf`，便于 RunPod / Vast 直接跑镜像；选型见 `docs/GPU_PROVIDER_COMPARISON.md`。
- **测试**：新增 [`test/remote-v2.mjs`](test/remote-v2.mjs) 8 项（完整下载 / 206 续传 / 416 重下 / 哈希校验 / SSE 解析 / binary 落盘 / inline 兼容）；Python 全套 549 项通过（新增步数进度 3 项）。

### M3.3 MCP Server

- **工具规格单源**：新增 [`shared/tool-specs.js`](shared/tool-specs.js)（名称 / 描述 / JSON Schema，纯数据）；`server/tools.js` 只按名称取规格并附加 `execute`，不再维护第二份描述。
- **发现文件**：新增 [`server/runtime-file.js`](server/runtime-file.js)；`server/standalone.js` 监听成功后原子写 `<dataDir>/runtime.json`（0600，含 `pid/port/origin/token/version/protocol/workspace`），正常退出删除（Windows 硬杀残留由 MCP 的 pid 存活检查识别）。
- **MCP 入口**：[`mcp/server.mjs`](mcp/server.mjs) 使用 `@modelcontextprotocol/sdk` 的 stdio 传输，7 个 `imagen_*` 工具映射本地 `/api/*`；只连回环、每次调用重读 runtime.json、Token 只放请求头、stdout 只有 JSON-RPC；`--print-config` 输出 Claude Desktop / Cursor 配置。
- **打包**：`electron-builder.yml` 的 `files` 已含 `mcp/**` 与 `shared/**`；`test:packaged` 增加 `mcp/server.mjs` 与 `shared/tool-specs.js` 存在性检查。
- **测试**：新增 [`test/mcp-server.mjs`](test/mcp-server.mjs) 9 项（initialize / tools/list / 生成 / 历史 / 取消 / stdout 纯净 / runtime 缺失）与 [`test/tool-specs.mjs`](test/tool-specs.mjs) 5 项（规格与注册面逐字一致）。

### M3.1-c 真机部署（AutoDL）

- 新增 [`worker/deploy/start-container.sh`](worker/deploy/start-container.sh)：自动选数据盘（`/root/autodl-tmp` → `/workspace` → 当前目录）、复用/生成 0600 Token、预装 torch 时只增量装 diffusers、后台启动并等待 `/healthz`。
- `worker/worker_server.py` 新增 `--prepare-only` 与 `--preload-json`：无卡模式只装依赖 + 按白名单预拉权重，不启动 HTTP、不检查 CUDA。
- **状态（已冻结）**：AutoDL 实名后创建 `v-48g` 实例实测，因基础镜像 Python 3.8 不兼容及 `v-48g` 单价过高，68 分钟 0 产出后已关机止损并冻结 AutoDL 接入（见 [`docs/AUTODL_WORKER_RESEARCH.md`](docs/AUTODL_WORKER_RESEARCH.md) §7/§9），转向 RunPod / Vast.ai 容器方案（见 [`docs/GPU_RUNTIME_BASELINE_PLAN.md`](docs/GPU_RUNTIME_BASELINE_PLAN.md)）。

## Unreleased（M3.0 底座 / M3.1-a 私有 Worker 服务，2026-11-22）

- **产品版本与协议版本分离**：`shared/contract.js` 新增 `APP_VERSION`（`0.15.0`，与 `package.json` 一致）与 `PROTOCOL_VERSION`（`2.0.0`）；`daemonContract().version`、注入配置版本、`worker/daemon.py`、`worker/contract.json`、`test/mock-daemon.py`、`test/tunnel-probe.py` 统一为协议版本。客户端小版本升级不再要求远端 daemon / 私有 Worker 同步重装。
- **算力来源注册表**：新增契约 `PROVIDERS` 能力位（`kind` / `reattach` / `pendingCleanup` / `remoteShutdown` / `idleTimeout` / `logs` / `binary` / `events` / `owned`）与 `server/providers/index.js`；`server/session.js` 不再写死 `kaggle/colab`，长驻 Worker 走「连接 + 协议校验 + 健康轮询」，跳过 Kernel 目录、ntfy 会合与空闲关机。
- **会话记录 v1/v2**：Kaggle/Colab 仍写 v1；Worker 写 v2（`provider/endpointUrl/token/handle`），新客户端同时读取，v2 未知来源安全拒绝；恢复按记录来源切换 provider，Worker 不可达写入 `worker_unreachable` 并保留记录。
- **设置与模型能力域**：`SETTINGS.providers` 只含当前可选项（仍为 Kaggle/Colab），模型能力判定与展示名改用全部已知来源；Agent 工具与提示词里的「Kaggle GPU / Kernel」改为「当前算力来源 / 会话」；新增 5 个 Worker 错误码与双语文案。
- **测试**：新增 `test/session-worker.mjs`（注册表、记录 v2、fake worker 的 start/stop/restore、协议不匹配、token 不泄漏）；`npm run test:contract` 15/15、`test:client` 19/19 步、`test:host` 30/30 步、`test:worker` 528 项全部通过。

### M3.1-a 私有 Worker 服务（Host 接入待续）

- **常驻入口**：`worker/worker_server.py` 可运行（默认 `127.0.0.1:8765`、Bearer 鉴权、`--token-file`/`AIGC_WORKER_TOKEN`、SIGTERM 优雅退出、stdout 只输出一行 ready JSON）；运行时启动抽到 `worker/runtime.py`，与 Kaggle/Colab daemon 共用 GPU 探测 / 依赖 / 预加载逻辑。
- **协议 v2 端点**：`/healthz`（免鉴权存活探针）、`/artifact`（单段 Range + ETag + sha256，`result_mode=binary` 时 PNG 落盘）、`/events`（SSE、15 秒心跳、`Last-Event-ID` 重放 200 条、并发 4 条）；`/health` 增加 `protocol_version / capabilities / hardware`；`/shutdown` 默认 403，仅 `--allow-shutdown` 生效。
- **产物生命周期**：binary 结果写入临时目录，`results[]` 只带元数据；任务淘汰与进程退出清理；同机多 Worker 只清自己的目录。
- **部署**：`worker/deploy/Dockerfile`、`docker-compose.yml`（`--gpus all`、模型缓存卷、healthcheck）、systemd 单元、SSH 隧道 / Caddy TLS 文档；`worker/requirements-gpu.txt`。
- **测试**：新增 `test/worker/test_protocol_v2.py` 18 项（产物落盘/Range/416/304、事件重放/上限、`/healthz`、关机闸门、`result_mode` 校验）；Python 全套 546 项通过。

## 0.15.0 (2026-11-22)

首个独立桌面端发布候选版本，包含完整的本地工作台、多后端云端 GPU 调度、创作助手与自动更新链路：

- **独立桌面客户端（M1 / M1.5 / M2）**：脱离 DSH 宿主的 Electron 桌面端，支持多工作区切换、`safeStorage` + AES-256-GCM 凭据加密、系统托盘防烧额度保护、后台完成桌面通知与任务栏角标。
- **云端 GPU 与多模型生态**：支持 Kaggle（CLI / 内置 OAuth）与 Google Colab 双后端；覆盖 `SDXL-Lightning`、`SANA-Sprint 1.6B`、`Z-Image-Turbo`、`Qwen-Image 2.1`、`FLUX.2 Klein 4B/9B`、`Anima Turbo v1.1` 等 7 套模型，支持文生图、局部重绘、高清放大、扩图（LoRA）与多图参考生成。
- **创作助手单轨化与智能调度（M2.5 / M2.6 / M2.7）**：接入 `pi-ai` / `pi-agent-core`，支持 11 家 LLM 服务商与模型自动拉取、共用参考图条、跨后端「切换并生成」一步到位、导入裸图焦点隔离锁定，以及按工作区隔离的对话持久化。
- **发布通道与应用内更新（M2.8）**：接入 GitHub Releases 自动化构建与产物校验（`latest.yml` + `.blockmap` + `SHA256SUMS.txt`），支持 NSIS 差分更新、活跃会话/任务安装防烧额度护栏、自定义 `https://` 镜像源，以及便携版/开发态只读降级提示。
