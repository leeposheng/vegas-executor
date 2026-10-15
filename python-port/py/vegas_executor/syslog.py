"""模組 F：logEvent_ 的欄位規則（來源判定、耗時分離）。

GAS 把日誌暫存進指令碼屬性、再批次寫到試算表「系統日誌」；Python 端直接寫 events.jsonl
（見 events.py，同樣七欄、自動輪轉），所以佇列／批次／刪列的機制不需要移植。這裡只保留會影響內容的規則。
"""
from .gas_util import js_str, js_truthy
from .jsnum import is_number


def log_fields(level, event, details=None):
    """回傳 {source, level, event, details, elapsedMs}，規則與 logEvent_ 相同。"""
    d = dict(details or {})
    safe = {k: v for k, v in d.items() if k not in ("source", "elapsedMs")}
    ev = js_str(event)
    if js_truthy(d.get("source")):
        source = js_str(d["source"])
    elif "tradingview" in ev:
        source = "tradingview"
    elif "telegram" in ev:
        source = "telegram"
    elif "claude" in ev:
        source = "claude"
    elif js_truthy(d.get("service")):
        source = js_str(d["service"])
    else:
        source = "system"
    el = d.get("elapsedMs")
    elapsed = el if is_number(el) else None
    return {"source": source, "level": level, "event": ev, "details": safe, "elapsedMs": elapsed}
