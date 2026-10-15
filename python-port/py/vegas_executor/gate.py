"""下單路徑序列化閘（對應 serialize.js 的 Gate）。

語意（逐點對應 Node 版）：
  * 先進先出，一次只跑一個；整個行程共用一條佇列。
  * maxWaitMs：排隊太久 → 這一筆「根本沒開始」，丟 gate_timeout，放掉即可。
  * maxRunMs ：開始執行後太久 → 只放掉「呼叫端」，丟 run_timeout；
    工作本身「不會被取消」（請求可能已送達交易所），佇列等它自然結束才放行下一筆。
  * depth 供 /health 使用。
計時用單調時鐘（真實時間），不受測試用的凍結時鐘影響。
"""
import asyncio
import time

from . import alerts, events


class GateError(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


def _mono_ms():
    return time.monotonic() * 1000.0


def _round_js(x):
    import math
    return int(math.floor(x + 0.5))


def _swallow(task):
    if not task.cancelled():
        task.exception()


class Gate:
    def __init__(self, maxWaitMs=None, maxRunMs=None):
        self.maxWaitMs = maxWaitMs or 20000
        self.maxRunMs = 30000 if maxRunMs is None else maxRunMs
        self._tail = None
        self.depth = 0

    @property
    def queued(self):
        return self.depth

    async def run(self, fn, label=None):
        """fn 為 async callable。"""
        self.depth += 1
        enqueued = _mono_ms()
        prev = self._tail
        started = asyncio.Event()

        async def work():
            if prev is not None:
                try:
                    await prev
                except BaseException:
                    pass
            waited = _mono_ms() - enqueued
            if waited > self.maxWaitMs:
                events.emit("gate_timeout", level="ERROR", source="gate",
                            detail={"label": label, "waitedMs": int(waited), "maxWaitMs": self.maxWaitMs})
                alerts.failure("gate_timeout", f"下單排隊逾時（{label or '未標記'}，等了 {_round_js(waited / 1000)} 秒）："
                               "前一筆可能卡在交易所回應，請確認。", cooldown_s=600)
                raise GateError(
                    f"排隊等待 {_round_js(waited / 1000)} 秒已超過上限 "
                    f"{_round_js(self.maxWaitMs / 1000)} 秒，拒絕執行"
                    + (f"（{label}）" if label else "")
                    + "。前一筆下單可能卡在交易所回應。",
                    "gate_timeout")
            started.set()
            return await fn()

        task = asyncio.ensure_future(work())
        self._tail = task
        task.add_done_callback(lambda t: setattr(self, "depth", self.depth - 1))
        task.add_done_callback(_swallow)

        if not self.maxRunMs:
            return await task

        starter = asyncio.ensure_future(started.wait())
        await asyncio.wait({task, starter}, return_when=asyncio.FIRST_COMPLETED)
        if not starter.done():
            starter.cancel()
        if task.done():
            return task.result()
        done, _ = await asyncio.wait({task}, timeout=self.maxRunMs / 1000.0)
        if done:
            return task.result()
        events.emit("run_timeout", level="ERROR", source="gate",
                    detail={"label": label, "maxRunMs": self.maxRunMs})
        alerts.failure("run_timeout", f"下單執行逾時（{label or '未標記'}，超過 {_round_js(self.maxRunMs / 1000)} 秒）："
                       "請立刻到交易所確認這筆是否已成交。", cooldown_s=600)
        raise GateError(
            f"執行超過 {_round_js(self.maxRunMs / 1000)} 秒未完成"
            + (f"（{label}）" if label else "")
            + "。請到交易所確認這筆是否已成交。",
            "run_timeout")
