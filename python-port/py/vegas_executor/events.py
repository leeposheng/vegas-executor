"""結構化事件日誌（SPEC §12，延續 GAS「TG 訊號」日誌）。

欄位對應 GAS 日誌的七欄：時間(ts)／等級(level)／來源(source)／事件(event)／說明(detail，JSON)／
耗時(durationMs)／事件ID(eventId)。事件名一律 snake_case，沿用既有名稱：
  webhook_rejected、executor_pending、executor_rejected、tradingview_signal_sent、broadcast_sent、
  chart_image_ok、chart_image_failed、duplicate_telegram_update_ignored。

設計原則：
  1. **永不影響主流程**：寫檔失敗、磁碟滿、路徑不存在都只吞掉（並在 stderr 提示一次），絕不拋例外。
  2. 寫入 `events.jsonl`（每行一筆 JSON），超過大小就輪轉（.1 最新、.N 最舊，超過份數的丟掉）。
  3. 記憶體保留最近 N 筆，讓 GET /events 在沒有檔案時也能用。
  4. WARN／ERROR 同步印到 stdout，雲端日誌收集器看得到；INFO 只進檔案，避免與既有 log 重複。
  5. 不記錄任何金鑰：呼叫端負責不放；這裡再把常見金鑰欄位名的值遮掉（深度防禦）。
"""
import json
import os
import sys
import threading
from collections import deque

from . import clock

LEVELS = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}
SECRET_KEYS = ("secret", "token", "passphrase", "apikey", "api_key", "password", "authorization",
               "x-executor-key", "x-control-key")

_lock = threading.Lock()
_state = {
    "path": None, "max_bytes": 2_000_000, "backups": 3, "ring": deque(maxlen=500),
    "seq": 0, "write_errors": 0, "warned": False,
}


def configure(path=None, *, max_bytes=2_000_000, backups=3, ring=500):
    with _lock:
        _state.update(path=path, max_bytes=int(max_bytes), backups=int(backups),
                      ring=deque(_state["ring"], maxlen=int(ring)), write_errors=0, warned=False)
    if path:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        except OSError:
            pass


def configure_from_env(env, data_dir):
    """EVENTS_FILE（預設 <DATA_DIR>/events.jsonl；設成 off 關閉寫檔）、EVENTS_MAX_BYTES、EVENTS_BACKUPS。"""
    raw = (env.get("EVENTS_FILE") or "").strip()
    path = None if raw.lower() in ("off", "none", "false", "0") else (raw or os.path.join(data_dir, "events.jsonl"))

    def num(name, default):
        try:
            v = int(float(env.get(name) or default))
            return v if v > 0 else default
        except (TypeError, ValueError):
            return default
    configure(path, max_bytes=num("EVENTS_MAX_BYTES", 2_000_000), backups=num("EVENTS_BACKUPS", 3))
    return path


def reset():
    """測試用。"""
    with _lock:
        _state.update(path=None, ring=deque(maxlen=500), seq=0, write_errors=0, warned=False)


def _mask(x, depth=0):
    if depth > 6:
        return "…"
    if isinstance(x, dict):
        return {str(k): ("***" if any(s in str(k).lower() for s in SECRET_KEYS) else _mask(v, depth + 1))
                for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_mask(v, depth + 1) for v in x]
    if isinstance(x, float) and (x != x or x in (float("inf"), float("-inf"))):
        return None
    if isinstance(x, (str, int, float, bool)) or x is None:
        return x
    return str(x)


def _iso(ms):
    from .store import iso
    return iso(ms)


def _rotate(path, backups):
    for i in range(backups - 1, 0, -1):
        src, dst = f"{path}.{i}", f"{path}.{i + 1}"
        if os.path.exists(src):
            os.replace(src, dst)
    if backups >= 1:
        os.replace(path, f"{path}.1")
    else:
        os.remove(path)


def _write(line):
    path = _state["path"]
    if not path:
        return
    try:
        try:
            if os.path.getsize(path) + len(line) > _state["max_bytes"]:
                _rotate(path, _state["backups"])
        except FileNotFoundError:
            pass
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as err:  # noqa: BLE001  日誌寫不進去不能拖垮下單
        _state["write_errors"] += 1
        if not _state["warned"]:
            _state["warned"] = True
            print(f"[events] 事件日誌寫入失敗（之後不再提示）：{err}", file=sys.stderr, flush=True)


def emit(event, *, level="INFO", source="executor", detail=None, duration_ms=None, event_id=None):
    """記一筆事件。永不拋例外；回傳該筆（失敗時回傳 None）。"""
    try:
        lvl = str(level).upper()
        if lvl not in LEVELS:
            lvl = "INFO"
        with _lock:
            _state["seq"] += 1
            seq = _state["seq"]
            ms = clock.now_ms()
            rec = {
                "ts": _iso(ms), "level": lvl, "source": str(source), "event": str(event),
                "detail": _mask(detail) if detail is not None else {},
                "durationMs": None if duration_ms is None else duration_ms,
                "eventId": event_id or f"{ms:x}-{seq}",
            }
            _state["ring"].append(rec)
            line = json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"
            _write(line)
        if LEVELS[lvl] >= LEVELS["WARN"]:
            print(f"[event] {lvl} {rec['source']} {rec['event']} "
                  f"{json.dumps(rec['detail'], ensure_ascii=False, separators=(',', ':'))}", flush=True)
        return rec
    except Exception:  # noqa: BLE001
        return None


def tail(limit=50, *, level=None, event=None):
    """最近的事件（新→舊）。level 為最低等級；event 為完整事件名。"""
    try:
        n = max(1, min(int(limit), 500))
    except (TypeError, ValueError):
        n = 50
    floor = LEVELS.get(str(level).upper(), 0) if level else 0
    with _lock:
        rows = list(_state["ring"])
    out = []
    for r in reversed(rows):
        if LEVELS.get(r["level"], 0) < floor:
            continue
        if event and r["event"] != event:
            continue
        out.append(r)
        if len(out) >= n:
            break
    return out


def stats():
    with _lock:
        return {"file": _state["path"], "buffered": len(_state["ring"]), "writeErrors": _state["write_errors"]}
