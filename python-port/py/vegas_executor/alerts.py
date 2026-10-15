"""告警（SPEC §12）：未捕捉例外、對帳連續失敗、Telegram 連續送不出、gate_timeout／run_timeout。

行為：
  * `failure(key, text, threshold=1)`：同一個 key 連續失敗達 threshold 次才告警；告警後進入冷卻，
    冷卻內不重複送（避免一個故障洗版），冷卻結束若仍在失敗才再送。
  * `success(key)`：把該 key 的連續失敗歸零（並解除冷卻，下次故障立刻能再告警）。
  * 每次告警都先寫一筆 ERROR 事件（events.emit('alert')），再嘗試送 Telegram。
  * 送訊管道由 main 以 `configure(sender)` 註冊；沒註冊、沒有 token 或在沒有事件迴圈的情境下，只留事件，不送。
  * 永不拋例外：告警本身出錯不能讓主流程出錯。
  * 「Telegram 連續送不出」這類告警不能經由 Telegram 送，呼叫端用 `deliver=False`，只留事件＋stdout。
"""
import asyncio
import time

from . import events

DEFAULT_COOLDOWN_S = 900

_state = {"sender": None, "counts": {}, "last_alert": {}, "now": time.monotonic}


def configure(sender=None, *, now=None):
    _state["sender"] = sender
    if now is not None:
        _state["now"] = now


def reset():
    """測試用。"""
    _state.update(sender=None, counts={}, last_alert={}, now=time.monotonic)


def success(key):
    _state["counts"].pop(key, None)
    _state["last_alert"].pop(key, None)


def failure(key, text, *, threshold=1, cooldown_s=DEFAULT_COOLDOWN_S, deliver=True, detail=None):
    """回傳這次是否觸發告警。"""
    try:
        n = _state["counts"].get(key, 0) + 1
        _state["counts"][key] = n
        if n < threshold:
            return False
        t = _state["now"]()
        last = _state["last_alert"].get(key)
        if last is not None and (t - last) < cooldown_s:
            return False
        _state["last_alert"][key] = t
        events.emit("alert", level="ERROR", source="alerts",
                    detail={"key": key, "consecutive": n, "text": text, **(detail or {})})
        sender = _state["sender"]
        if deliver and sender is not None:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None:
                task = loop.create_task(_send(sender, f"🚨 {text}"))
                task.add_done_callback(lambda t_: t_.cancelled() or t_.exception())
        return True
    except Exception:  # noqa: BLE001
        return False


async def _send(sender, text):
    try:
        await sender(text)
    except Exception as err:  # noqa: BLE001
        events.emit("alert_send_failed", level="WARN", source="alerts", detail={"error": str(err)[:200]})
