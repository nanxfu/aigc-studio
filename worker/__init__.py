"""远端源码包（Kaggle 容器内运行）。

`worker/` 在仓库里按标准 Python 包维护，推 Kaggle 时由 `server/kernel.js` 把整包压成 ZIP
内嵌进启动器，部署形态对业务代码完全透明。

**sys.path 需要两条路径**（启动器 `worker/_entry.py` 与 `test/worker/support.py` 都已满足）：

- 仓库根：供包内绝对导入 `from worker.config import ...` / `from worker.state import ...`；
- `worker/` 本身：供过渡期的扁平导入 `from log_ring import log` / `from tunnel import ...`
  （这些模块还没迁到包内绝对导入，`from worker.log_ring import ...` 会拿到第二份模块实例，
  日志环与 `_START_TS` 都会分叉）。

所以本地调试要么 `PYTHONPATH=<repo根>:<repo根>/worker python -m worker.daemon`，要么直接
`python worker/daemon.py`（脚本所在目录会自动进 `sys.path`，再补一个仓库根即可）。只配一条
路径会得到 `ModuleNotFoundError`，不是代码问题。
"""
