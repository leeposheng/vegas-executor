"""單一時間注入點。所有「現在」都從這裡讀，測試時覆寫（SPEC §2）。"""
import time

_override = None


def now_ms() -> int:
    if _override is not None:
        return int(_override)
    return int(time.time() * 1000)


def set_now(ms):
    """測試用：凍結時鐘；傳 None 還原。"""
    global _override
    _override = ms
