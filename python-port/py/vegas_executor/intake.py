"""訊號入口（模組 A）：Code.gs 的 handleTradingViewSignal_／去重／補送佇列／最近訊號／被拒請求彙總的忠實移植。

與 GAS 的差異只有基礎設施：CacheService＋PropertiesService → KV（可存檔）；LockService → 行程內鎖。
所有「現在」都經由 clock；對外動作（轉給執行層、送 Telegram、轉影子服務、寫日誌）都是注入的函式，
所以順序與回傳值可以逐步與原版 GAS 比對。同步函式：由 HTTP 層放進執行緒跑，不阻塞事件迴圈。
"""
import json
import math
import os
import threading
from datetime import datetime, timedelta, timezone

from . import clock
from .gas_util import (js_String, js_len, js_str, js_json, js_trim, js_truthy, is_expected_signal, redact,
                       sha256_hex, truncate)

CACHE_MAX_TTL_S = 21600
DEDUP_TTL_S = 1800
RETRY_PREFIX = "TVRETRY_"
RETRY_MAX_QUEUE = 50
RETRY_MAX_ATTEMPTS = 10
RETRY_MAX_AGE_MS = 6 * 60 * 60 * 1000
RETRY_MAX_BACKOFF_MIN = 30
RECENT_KEY = "tv:recent"
RECENT_MAX = 5
MAINT_FLAG_KEY = "maint:pending"
REJECT_COUNT_KEY = "reject:count"
REJECT_LOGGED_KEY = "reject:logged"
REJECT_SUMMARY_S = 600
TAIPEI = timezone(timedelta(hours=8))


def error_message(err):
    return str(err) if str(err) else err.__class__.__name__


def js_round(x):
    return math.floor(x + 0.5)


class KV:
    """CacheService（有 TTL、可被逐出）＋ PropertiesService（持久）的合併替身。path 有給就存檔。"""

    def __init__(self, path=None, now=clock.now_ms):
        self.path, self.now = path, now
        self.props, self.cache = {}, {}
        self.lock = threading.RLock()
        self.lock_available = True      # 測試用：模擬 tryLock 失敗
        self.lock_seq = None            # 測試用：依序決定每次 tryLock 的結果
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    d = json.load(f)
                self.props = dict(d.get("props") or {})
                self.cache = {k: tuple(v) for k, v in (d.get("cache") or {}).items()}
            except (OSError, ValueError):
                pass

    def seed(self, props=None, cache=None):
        self.props = {k: str(v) for k, v in (props or {}).items()}
        self.cache = {k: (v[0], v[1]) for k, v in (cache or {}).items()}

    def _flush(self):
        if not self.path:
            return
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"props": self.props, "cache": {k: list(v) for k, v in self.cache.items()}}, f, ensure_ascii=False)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def cache_get(self, key):
        e = self.cache.get(key)
        if e is None:
            return None
        if e[1] <= self.now():
            del self.cache[key]
            return None
        return e[0]

    def cache_put(self, key, value, ttl_s):
        self.cache[key] = (str(value), self.now() + ttl_s * 1000)
        self._flush()

    def cache_remove(self, key):
        self.cache.pop(key, None)
        self._flush()

    def prop_set(self, key, value):
        self.props[key] = str(value)
        self._flush()

    def prop_delete(self, key):
        self.props.pop(key, None)
        self._flush()

    def try_lock(self, timeout_ms):
        ok = self.lock_seq.pop(0) if self.lock_seq else self.lock_available
        return ok and self.lock.acquire(timeout=timeout_ms / 1000)

    def release(self):
        try:
            self.lock.release()
        except RuntimeError:
            pass

    def export(self):
        props = {}
        for k, v in self.props.items():
            try:
                props[k] = json.loads(v)
            except ValueError:
                props[k] = v
        t = self.now()
        return {"props": props, "cache": {k: [v[0], v[1]] for k, v in self.cache.items() if v[1] > t}}


class Intake:
    def __init__(self, config, kv, send, log, forward=None, shadow=None, now=clock.now_ms):
        """send(chat_id, text, thread_id)：失敗拋例外；forward(text, key)→{cardSent, broadcastSent}；
        shadow(text, key)；log(level, event, details)。forward／shadow 為 None 代表沒安裝。"""
        self.config, self.kv, self.send, self.log = config, kv, send, log
        self.forward, self.shadow, self.now = forward, shadow, now

    # ---- 去重 ----
    def reserve(self, signal_text):
        key = "tv:" + sha256_hex(signal_text)
        if not self.kv.try_lock(3000):
            raise RuntimeError("無法取得訊號去重鎖，請稍後重試")
        try:
            if self.kv.cache_get(key):
                return None
            self.kv.cache_put(key, "processing", DEDUP_TTL_S)
            return key
        finally:
            self.kv.release()

    # ---- 送原始訊號 ----
    def has_group(self):
        c = self.config
        return bool(c.get("signalChatId")) and c.get("signalChatId") != c.get("allowedChatId")

    def deliver_raw(self, text, targets):
        failed, last = [], ""
        c = self.config
        for target in targets or []:
            try:
                if target == "private":
                    self.send(c["allowedChatId"], text, None)
                elif target == "group":
                    self.send(c["signalChatId"], text, c.get("signalThreadId"))
                else:   # "signal"：舊版補送紀錄沒有 targets 欄位
                    to_group = bool(c.get("signalChatId"))
                    self.send(c["signalChatId"] if to_group else c["allowedChatId"], text,
                              c.get("signalThreadId") if to_group else "")
            except Exception as err:  # noqa: BLE001
                failed.append(target)
                last = error_message(err)
        return {"failed": failed, "error": last}

    # ---- 補送佇列 ----
    def mark_maintenance(self):
        self.kv.cache_put(MAINT_FLAG_KEY, "1", CACHE_MAX_TTL_S)

    def enqueue_retry(self, text, dedup_key, reason, targets):
        try:
            if sum(1 for k in self.kv.props if k.startswith(RETRY_PREFIX)) >= RETRY_MAX_QUEUE:
                return False
            now = self.now()
            key = RETRY_PREFIX + str(now) + "_" + js_String(dedup_key)[-12:]
            self.kv.prop_set(key, js_json({
                "text": text, "dedupKey": dedup_key,
                "targets": targets if isinstance(targets, list) and targets else ["signal"],
                "firstFailedAt": now, "nextAttemptAt": now, "attempts": 1,
                "lastError": truncate(redact(reason), 200)}))
            self.mark_maintenance()
            return True
        except Exception:  # noqa: BLE001
            return False

    def process_retries(self):
        """回傳仍在等待補送的筆數。"""
        snapshot = dict(self.kv.props)
        remaining = 0
        for key in sorted(k for k in snapshot if k.startswith(RETRY_PREFIX)):
            try:
                item = json.loads(snapshot[key])
            except ValueError:
                self.kv.prop_delete(key)
                self.log("error", "tradingview_retry_record_corrupted", {})
                continue
            now = self.now()
            attempts = int(item.get("attempts") or 1)
            age = now - int(item.get("firstFailedAt") or now)
            fingerprint = js_str(item.get("dedupKey"))[-12:]
            if age > RETRY_MAX_AGE_MS or attempts >= RETRY_MAX_ATTEMPTS:
                self.kv.prop_delete(key)
                self.log("error", "tradingview_signal_dropped", {
                    "fingerprint": fingerprint, "attempts": attempts, "ageMinutes": js_round(age / 60000),
                    "lastError": item.get("lastError") or ""})
                continue
            if now < int(item.get("nextAttemptAt") or 0):
                remaining += 1
                continue
            delay_min = max(1, js_round(age / 60000))
            delayed = "⏱ 延遲送達（首次傳送失敗，約晚 " + str(delay_min) + " 分鐘補送）\n" + item["text"]
            targets = item["targets"] if isinstance(item.get("targets"), list) and item["targets"] else ["signal"]
            result = self.deliver_raw(delayed, targets)
            if not result["failed"]:
                self.kv.prop_delete(key)
                self.remember_recent(item["text"])
                self.log("info", "tradingview_signal_retry_sent", {
                    "fingerprint": fingerprint, "attempts": attempts + 1, "delayMinutes": delay_min,
                    "targets": ",".join(targets)})
            else:
                backoff = min(2 ** (attempts - 1), RETRY_MAX_BACKOFF_MIN)
                item["targets"] = result["failed"]
                item["attempts"] = attempts + 1
                item["nextAttemptAt"] = now + backoff * 60000
                item["lastError"] = truncate(redact(result["error"]), 200)
                self.kv.prop_set(key, js_json(item))
                remaining += 1
                self.log("warn", "tradingview_signal_retry_failed", {
                    "fingerprint": fingerprint, "attempts": item["attempts"], "nextRetryMinutes": backoff,
                    "targets": ",".join(result["failed"])})
        return remaining

    # ---- 最近訊號 ----
    def get_recent(self):
        raw = self.kv.cache_get(RECENT_KEY)
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except ValueError:
            return []
        return parsed if isinstance(parsed, list) else []

    def remember_recent(self, signal_text):
        try:
            if not self.kv.try_lock(2000):
                return
            try:
                recent = self.get_recent()
                stamp = datetime.fromtimestamp(self.now() / 1000, TAIPEI).strftime("%Y-%m-%d %H:%M")
                recent.insert(0, {"receivedAt": stamp, "text": truncate(signal_text, 1500)})
                self.kv.cache_put(RECENT_KEY, js_json(recent[:RECENT_MAX]), CACHE_MAX_TTL_S)
            finally:
                self.kv.release()
        except Exception:  # noqa: BLE001
            pass

    # ---- 被拒絕請求的彙總（驗證失敗不灌爆日誌）----
    def note_rejected(self, reason):
        try:
            count = int(self.kv.cache_get(REJECT_COUNT_KEY) or 0) + 1
            if self.kv.cache_get(REJECT_LOGGED_KEY):
                self.kv.cache_put(REJECT_COUNT_KEY, str(count), CACHE_MAX_TTL_S)
                return
            self.kv.cache_put(REJECT_LOGGED_KEY, "1", REJECT_SUMMARY_S)
            self.kv.cache_put(REJECT_COUNT_KEY, "0", CACHE_MAX_TTL_S)
            self.log("warn", "webhook_rejected", {"source": "rejected", "reason": reason, "countSinceLastSummary": count})
        except Exception:  # noqa: BLE001
            pass

    # ---- TradingView 訊號主流程 ----
    def handle_tradingview(self, body, origin=None):
        started = self.now()
        via = origin if js_truthy(origin) else "webhook"
        text = js_trim(js_str(body))
        if not text:
            self.log("warn", "empty_tradingview_payload", {"origin": via})
            return "empty payload"
        if not is_expected_signal(text):
            self.log("warn", "unexpected_tradingview_payload", {"origin": via, "bodyLength": js_len(text)})
            return "ignored unexpected signal"
        dedup = self.reserve(text)
        if not dedup:
            self.log("info", "duplicate_tradingview_signal_ignored", {"origin": via})
            return "duplicate"
        try:
            try:
                forwarded = {"cardSent": False, "broadcastSent": False}
                if self.forward is not None:
                    r = self.forward(text, dedup)
                    if js_truthy(r):
                        forwarded = r if isinstance(r, dict) else {}
                card_sent = js_truthy(forwarded.get("cardSent"))
                bcast_sent = js_truthy(forwarded.get("broadcastSent"))
                has_group = self.has_group()
                targets = []
                if not card_sent:
                    targets.append("private")
                if has_group and not bcast_sent:
                    targets.append("group")
                delivery = self.deliver_raw(text, targets)
                self.remember_recent(text)
                via_text = ("private_card" if card_sent else "private_raw") + (
                    "|" + ("group_broadcast" if bcast_sent else "group_raw") if has_group else "")
                if not delivery["failed"]:
                    self.log("info", "tradingview_signal_sent", {
                        "origin": via, "fingerprint": dedup[-12:], "via": via_text,
                        "elapsedMs": self.now() - started})
                    return "ok"
                queued = self.enqueue_retry(text, dedup, delivery["error"], delivery["failed"])
                delivered_anything = card_sent or bcast_sent or len(delivery["failed"]) < len(targets)
                if not queued and not delivered_anything:
                    self.kv.cache_remove(dedup)
                self.log("error", "tradingview_signal_queued_for_retry" if queued else "tradingview_signal_delivery_failed", {
                    "origin": via, "fingerprint": dedup[-12:], "via": via_text,
                    "failedTargets": ",".join(delivery["failed"]), "elapsedMs": self.now() - started,
                    "message": delivery["error"]})
                return "queued" if queued else "error"
            except Exception as err:  # noqa: BLE001   非預期例外：保守起見兩邊都補
                fallback = ["private"] + (["group"] if self.has_group() else [])
                queued = self.enqueue_retry(text, dedup, error_message(err), fallback)
                if not queued:
                    self.kv.cache_remove(dedup)
                self.log("error", "tradingview_signal_queued_for_retry" if queued else "tradingview_signal_delivery_failed", {
                    "origin": via, "fingerprint": dedup[-12:], "elapsedMs": self.now() - started,
                    "message": error_message(err)})
                return "queued" if queued else "error"
        finally:
            if self.shadow is not None:
                self.shadow(text, dedup)
