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
- 健康检查走免鉴权的 `/healthz`。

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

## 8. 安全基线

- 默认只监听 `127.0.0.1`；容器内 `0.0.0.0` 仅用于端口映射，宿主机侧绑回环；
- 非回环地址必须 `https://`（Host 侧强制），公网明文 HTTP 会被拒绝；
- Token 32 字节随机 hex，文件 0600，不进日志、不进 `/health`；
- `/healthz` 不泄露 phase / 设备 / 版本；
- 不接受任意 shell：Worker 只执行协议内的 `pipeline/tasks`；
- 产物目录 0700 / 文件 0600，任务淘汰与进程退出时清理。
