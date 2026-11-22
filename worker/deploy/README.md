# 私有 GPU Worker 部署

长驻 Worker 是「固定地址 + Bearer Token」的 HTTP 服务，不依赖 ntfy / cloudflared。
本文覆盖 Docker、systemd、SSH 隧道与反代四种形态，以及排障命令。

> 协议：Host↔Worker `2.0.0`。客户端连接后先读 `GET /health.protocol_version`，
> 主版本不一致会拒绝发送任务（`protocol_mismatch`）。

## 1. 生成 Token

```bash
python3 -c "import secrets; print(secrets.token_hex(32))" > worker-token.txt
chmod 600 worker-token.txt
```

Token 只通过 `Authorization: Bearer <token>` 传输；不要写进 URL、不要提交到仓库。
共享 Worker **不要**打开 `--allow-shutdown`：Host 的「断开」默认只释放连接。

## 2. Docker（推荐）

```bash
# 仓库根目录
docker compose -f worker/deploy/docker-compose.yml up -d --build
docker compose -f worker/deploy/docker-compose.yml logs -f worker
```

- 端口默认绑定 `127.0.0.1:8765`（只给本机/SSH 隧道用）；
- 模型缓存在命名卷 `hf-cache`（`/models/hf`），容器重建不重下权重；
- 依赖在镜像构建期安装，启动带 `--no-install`；
- 健康检查走免鉴权的 `/healthz`；
- 受限模型需要 HuggingFace Token：在 compose 的 `environment` 里加 `HF_TOKEN`，
  或启动参数加 `--hf-token`（两者都只注入进程环境，不落日志）。

裸机 / 租用容器用 `--work-dir /root/autodl-tmp` 时，Worker 会自动把 `HF_HOME`
与 `AIGC_WORKER_ARTIFACT_DIR` 指到该盘（已显式设置的环境变量优先），避免写爆系统盘。

公网访问：让 Caddy/Nginx 终止 TLS 后反代到 `127.0.0.1:8765`，或直接用 SSH 隧道。
**不要**把 8765 明文暴露到公网。

## 3. 裸机 systemd

```bash
sudo useradd --system --create-home aigc
sudo mkdir -p /opt/aigc-studio /etc/aigc /var/lib/aigc/{hf,artifacts}
sudo chown -R aigc:aigc /opt/aigc-studio /var/lib/aigc
sudo -u aigc python3 -m venv /opt/aigc-studio/.venv
sudo -u aigc /opt/aigc-studio/.venv/bin/pip install -r /opt/aigc-studio/worker/requirements-gpu.txt

sudo install -m 600 -o root -g root worker-token.txt /etc/aigc/worker-token
sudo cp worker/deploy/aigc-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aigc-worker
sudo journalctl -u aigc-worker -f
```

`/etc/aigc/worker-token` 由 root 持有即可：服务以 `aigc` 用户运行，读取 0600 文件需要
把属主改成 `aigc`（`chown aigc:aigc`），或改用 `AIGC_WORKER_TOKEN` 环境变量（systemd
`EnvironmentFile`，同样 0600）。

## 3.5 租用容器（AutoDL / 恒源云 / RunPod）

这类环境本身就是一个运行中的容器：不能 Docker-in-Docker，也没有 systemd；系统盘通常只有
30GB，数据盘在 `/root/autodl-tmp`。用通用脚本启动：

```bash
# 仓库放到实例上（git clone 或 scp 整个仓库）
cd /root/aigc-studio

# 有卡启动（默认 127.0.0.1:8765，自动选数据盘、生成 Token、增量装依赖）
bash worker/deploy/start-container.sh

# AutoDL 自定义服务（控制台 6006 端口 → HTTPS 域名）
bash worker/deploy/start-container.sh --port 6006

# 无卡模式准备：只装依赖 + 预拉权重，不启动 HTTP、不要求 CUDA
#   pipeline.json 与 /generate 的 pipeline 同形（可从 models/*.json 的 pipeline 字段复制）
bash worker/deploy/start-container.sh --prepare-only --preload-json @/root/autodl-tmp/pipeline.json
```

脚本行为：

- 数据盘按 `/root/autodl-tmp` → `/workspace` → `$HOME/aigc-worker` → `$PWD/aigc-worker` 选择，
  `HF_HOME` / `HF_HUB_CACHE` / `AIGC_WORKER_ARTIFACT_DIR` 全部指到该盘；
- 预装 `torch` 时只增量安装 `diffusers / transformers / accelerate / peft / sentencepiece` 等，
  不重下 3GB torch；没有 torch 时按 `requirements-gpu.txt` 安装 cu124；
- Token 生成到 `<data>/worker-token`（0600），启动完成后打印一次，粘贴到客户端设置页；
- 后台启动并等待 `/healthz` 就绪，日志写 `<data>/worker.log`；
- `HF_ENDPOINT` 默认 `https://hf-mirror.com`（国内加速），显式设置优先。

> **停止进程 ≠ 停止计费**：AutoDL 等按小时计费平台只有实例关机才停 GPU 费用。
> 断开客户端连接、`kill` Worker 进程都不会停止计费；结束实验务必在控制台或 API 关机。

## 3.6 RunPod / Vast.ai（容器原生平台）

这两个平台支持直接跑我们的镜像，不需要在实例里装环境：

```bash
# 构建（仓库根目录）
docker build -f worker/deploy/Dockerfile -t ghcr.io/<owner>/aigc-worker:0.15.0 .
docker push ghcr.io/<owner>/aigc-worker:0.15.0
```

平台侧只需要：

- Image：上面的 GHCR 镜像；
- Port：`8765`（RunPod 加到 Expose HTTP Ports；Vast 用 `-p 8765:8765`）；
- Env：`AIGC_WORKER_TOKEN=<32 字节随机 hex>`、`HF_HOME=/workspace/hf`、`HF_ENDPOINT=https://hf-mirror.com`；
- 存储：RunPod 挂 Network Volume 到 `/workspace`；Vast 选 50GB+ 本地盘；
- Vast 会替换镜像入口点（SSH 模式），需在 `onstart` 里执行
  `python3 /app/worker/worker_server.py --host 0.0.0.0 --port 8765 --no-install`，
  并选驱动 >=550 的 host（镜像基于 CUDA 12.4）。

入口脚本 `docker-entrypoint.sh` 会把 `AIGC_WORKER_TOKEN` 写成容器内 0600 临时文件，并在
`HF_HOME` 不可写时回退 `/tmp/hf`。RunPod 的 HTTPS 代理地址形如
`https://<pod-id>-8765.proxy.runpod.net`；Vast 用 SSH 隧道后填 `http://127.0.0.1:8765`。
RunPod 代理有 100 秒单连接超时，SSE 会被切断，但 Host 已支持从 `/job` 轮询驱动步数，
不影响任务与进度。完整对比见 [`docs/GPU_PROVIDER_COMPARISON.md`](../../docs/GPU_PROVIDER_COMPARISON.md)。

## 4. SSH 隧道（内网机器，不开公网端口）

```bash
ssh -N -L 8765:127.0.0.1:8765 user@gpu-box
```

Host 端地址填 `http://127.0.0.1:8765`。回环地址允许明文 HTTP；这是唯一允许 `http://` 的场景。

## 5. 反代 + TLS

Caddy 示例（Worker 只监听回环，公网只开 443）：

```caddyfile
gpu.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

SSE（`/events`）需要关闭缓冲：Caddy 默认不缓冲；Nginx 要加 `proxy_buffering off;`
与 `proxy_read_timeout 3600s;`，否则进度事件会被攒着不发。

## 6. 接口速查

| 端点 | 鉴权 | 说明 |
| :--- | :--- | :--- |
| `GET /healthz` | 否 | 存活探针，只回 `{"ok":true}` |
| `GET /health` | 是 | `phase / protocol_version / capabilities / hardware / queue_depth` |
| `POST /generate` | 是 | 入队；`result_mode: inline \| binary` |
| `GET /job?id=` | 是 | 任务状态；binary 模式的 results 只带元数据 |
| `GET /artifact?id=&index=` | 是 | 二进制产物；单段 Range + ETag |
| `GET /events` | 是 | SSE：`job` / `state`，15 秒心跳，`Last-Event-ID` 重放 |
| `GET /logs?since=` | 是 | 日志环尾部 |
| `POST /shutdown` | 是 | 默认 403；仅 `--allow-shutdown` 时生效 |

## 7. 排障

```bash
# 存活
curl -s http://127.0.0.1:8765/healthz

# 详细健康（含能力与 GPU）
TOKEN=$(cat worker-token.txt)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/health | python3 -m json.tool

# 事件流（Ctrl-C 退出）
curl -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/events
```

常见错误码：

| 错误 | 含义 | 处理 |
| :--- | :--- | :--- |
| `load_failed: 无法确认 GPU 可用性` | 容器没拿到 GPU / torch 装错 | 检查 `docker run --gpus all`、驱动与 CUDA 版本 |
| `gpu_unavailable` | `torch.cuda.is_available()` 为 False | 同上；确认 `nvidia-smi` 在容器内可见 |
| `worker_unreachable`（Host） | 地址不通 | 检查端口、防火墙、SSH 隧道 |
| `worker_unauthorized`（Host） | Token 不匹配 | 重新填写 Token |
| `protocol_mismatch`（Host） | 协议主版本不一致 | 升级 Worker 或客户端 |
| `shutdown_disabled` | 共享 Worker 未开远程关机 | 这是预期行为；本机托管再加 `--allow-shutdown` |

## 8. 从 AIGC Studio 连接

本机 Docker / SSH 隧道就绪后，在客户端「运行设置 → 云端算力」选择「私有 Worker」：

1. **Worker 地址**：本机 Docker 或 SSH 隧道填 `http://127.0.0.1:8765`；
   远程反代填 `https://gpu.example.com`（非回环地址必须 HTTPS）。
2. **访问令牌**：粘贴第 1 节生成的 Token；Token 只保存在应用数据目录的
   `credentials/workers.json`（AES-256-GCM），不会写进设置文件或日志。
3. **测试连接**：显示协议版本、GPU 型号与显存；协议主版本不一致会直接提示升级。
4. 保存后点顶栏「连接」；断开只释放本地连接，**不会**停止共享 Worker 进程。
   空闲退出由 Worker 启动参数 `--idle-timeout` 决定（默认 0 = 常驻）。

> 反向代理挂在子路径（如 `https://example.com/worker`）时，Health / Artifact / Events
> 会沿该子路径拼接；代理需要同时转发 `/worker/health`、`/worker/artifact`、`/worker/events`。

## 9. 安全基线

- 默认只监听 `127.0.0.1`；容器内 `0.0.0.0` 仅用于端口映射，宿主机侧绑回环；
- 非回环地址必须 `https://`（Host 侧强制），公网明文 HTTP 会被拒绝；
- Token 32 字节随机 hex，文件 0600，不进日志、不进 `/health`；
- `/healthz` 不泄露 phase / 设备 / 版本；
- 不接受任意 shell：Worker 只执行协议内的 `pipeline/tasks`；
- 产物目录 0700 / 文件 0600，任务淘汰与进程退出时清理。
