# 更新日志 (CHANGELOG)

## 0.15.0 (2026-11-22)

首个独立桌面端发布候选版本，包含完整的本地工作台、多后端云端 GPU 调度、创作助手与自动更新链路：

- **独立桌面客户端（M1 / M1.5 / M2）**：脱离 DSH 宿主的 Electron 桌面端，支持多工作区切换、`safeStorage` + AES-256-GCM 凭据加密、系统托盘防烧额度保护、后台完成桌面通知与任务栏角标。
- **云端 GPU 与多模型生态**：支持 Kaggle（CLI / 内置 OAuth）与 Google Colab 双后端；覆盖 `SDXL-Lightning`、`SANA-Sprint 1.6B`、`Z-Image-Turbo`、`Qwen-Image 2.1`、`FLUX.2 Klein 4B/9B`、`Anima Turbo v1.1` 等 7 套模型，支持文生图、局部重绘、高清放大、扩图（LoRA）与多图参考生成。
- **创作助手单轨化与智能调度（M2.5 / M2.6 / M2.7）**：接入 `pi-ai` / `pi-agent-core`，支持 11 家 LLM 服务商与模型自动拉取、共用参考图条、跨后端「切换并生成」一步到位、导入裸图焦点隔离锁定，以及按工作区隔离的对话持久化。
- **发布通道与应用内更新（M2.8）**：接入 GitHub Releases 自动化构建与产物校验（`latest.yml` + `.blockmap` + `SHA256SUMS.txt`），支持 NSIS 差分更新、活跃会话/任务安装防烧额度护栏、自定义 `https://` 镜像源，以及便携版/开发态只读降级提示。
