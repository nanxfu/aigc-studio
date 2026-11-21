"""进程内事件总线：给 ``GET /events``（SSE）提供任务状态、进度与阶段变化。

为什么需要独立模块：事件的生产者分散在任务入队（HTTP 层）、执行器（daemon）、
阶段切换（state）与收尾（_finish_job）；消费端只有一个 SSE 处理器。把环形缓冲、
订阅者上限与重放规则收在一处，生产方只调 ``publish``，不必知道有几个客户端。

设计约束（对应 M3_PRIVATE_WORKER_AND_MCP_PLAN.md §3.4）：
- **最多 4 条并发事件流**：超出时 ``subscribe()`` 返回 None，HTTP 层回 429；
- **重放最近 200 条**：客户端用 ``Last-Event-ID`` 重连，缺省从头重放当前缓冲；
- **不阻塞生产者**：订阅者队列满时丢弃该条（SSE 只降延迟，最终状态仍以 ``/job`` 为准）；
- **线程安全**：发布与订阅可来自任意线程（HTTP / job worker / 信号）。

事件形状：``{"id": int, "event": "job"|"state", "data": dict}``。
``id`` 单调递增，跨重连保持可比较；进程重启后从 1 重新开始（客户端重连时若
``Last-Event-ID`` 大于当前最大 id，按“从头重放”处理，不会卡死）。
"""

from __future__ import annotations

import queue
import threading
from collections import deque

# 重放窗口与并发流上限：与协议文档保持一致，改这里要同步 §3.4。
EVENT_REPLAY_MAX = 200
EVENT_MAX_STREAMS = 4
# 单个订阅者的缓冲：只影响短时突发，满了丢事件而不是阻塞 job worker。
EVENT_QUEUE_MAX = 64


class EventHub:
    """环形事件缓冲 + 订阅者集合；所有方法都不抛异常。"""

    def __init__(
        self,
        *,
        replay_max: int = EVENT_REPLAY_MAX,
        max_streams: int = EVENT_MAX_STREAMS,
        queue_max: int = EVENT_QUEUE_MAX,
    ) -> None:
        self._lock = threading.Lock()
        self._events: deque[dict] = deque(maxlen=max(1, int(replay_max)))
        self._subscribers: set[queue.Queue] = set()
        self._next_id = 1
        self._max_streams = max(1, int(max_streams))
        self._queue_max = max(1, int(queue_max))

    def publish(self, event: str, data: dict | None = None) -> dict | None:
        """记录一条事件并推给所有订阅者；返回事件对象（便于单测断言）。"""
        name = str(event or "").strip()
        if not name:
            return None
        payload = data if isinstance(data, dict) else {}
        with self._lock:
            item = {"id": self._next_id, "event": name, "data": payload}
            self._next_id += 1
            self._events.append(item)
            subscribers = list(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(item)
            except queue.Full:
                # SSE 只是加速通道：慢客户端丢事件，不影响任务最终状态。
                continue
            except Exception:
                continue
        return item

    def subscribe(self):
        """注册一个订阅者；超过并发上限返回 None（HTTP 层回 429）。"""
        with self._lock:
            if len(self._subscribers) >= self._max_streams:
                return None
            subscriber: queue.Queue = queue.Queue(maxsize=self._queue_max)
            self._subscribers.add(subscriber)
            return subscriber

    def unsubscribe(self, subscriber) -> None:  # noqa: ANN001
        with self._lock:
            self._subscribers.discard(subscriber)

    def replay(self, last_event_id: int | None = None) -> list[dict]:
        """``id > last_event_id`` 的事件；缺省 / 非法值按从头重放处理。"""
        with self._lock:
            events = list(self._events)
        if not isinstance(last_event_id, int) or last_event_id < 0:
            return events
        return [item for item in events if item["id"] > last_event_id]

    def stream_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def clear(self) -> None:
        """清空缓冲与订阅者（单测夹具用；不重置 id，避免已连接客户端误判重放）。"""
        with self._lock:
            self._events.clear()
            self._subscribers.clear()


# 全进程单例：daemon 与 worker_server 共用；HTTP 层只读订阅，生产者在各业务点发布。
EVENTS = EventHub()
