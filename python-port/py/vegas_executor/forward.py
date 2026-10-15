"""Executor.gs 的「轉送、送卡、廣播、補送佇列」忠實移植（模組 B-2）。

與 GAS 的差異只有基礎設施：PropertiesService → kv.props；LockService.getUserLock → 本物件自己的鎖
（刻意不與入口的去重鎖共用：執行層離線時補送可能卡很久，不能擋住新訊號）。
對外動作皆為注入函式，所以呼叫順序與日誌可逐步與原版比對：
  post(payload, cfg) → 執行層回應 dict（ok、decision…）
  tg_api(method, body) → Telegram 回應 dict，失敗 None
  tg_send_photo(chat_id, blob, caption, markup) → Telegram 訊息 dict，失敗 None
  chart(payload) → 圖片 blob 或 None（模組 E）
  log(level, event, details)
"""
import json
import re
import threading

from . import clock
from .cards import (UNDEF, _cat, _join, _num, card_head, parse_signal_to_json, render_pending_card)  # noqa: F401
from .gas_util import js_json, js_len, js_slice, js_String, js_str, js_trim, js_truthy, redact, safe_equals, truncate
from .intake import error_message, js_round
from .jsnum import to_string
from .webhook import REQUIRED, get_config

RETRY_PREFIX = "EXECRETRY_"
RETRY_MAX_QUEUE = 50
RETRY_MAX_ATTEMPTS = 8
RETRY_MAX_AGE_MS = 2 * 60 * 60 * 1000
RETRY_MAX_BACKOFF_MIN = 15
TG_CAPTION_LIMIT = 1024
CB_PREFIX = "vg."
CB_CONFIRM = CB_PREFIX + "c."
CB_SKIP = CB_PREFIX + "s."
CB_DAILY_PANEL = CB_PREFIX + "D." + "panel"
CARD_DECISIONS = ("pending", "placed", "rejected", "error")
NO_CARD = {"cardSent": False, "broadcastSent": False}


def normalize_executor_url(raw):
    s = js_trim(js_str(raw))
    if not s:
        return ""
    m = re.match(r"^(https?://[^/\s?#]+)", s, flags=re.I)
    return m.group(1) if m else re.sub(r"/+$", "", s)


def _n(v, default=0):
    """JS Number(v || default) 的寬鬆版（只處理我們自己寫進去的 JSON）。"""
    if not js_truthy(v):
        return default
    try:
        return float(v) if not isinstance(v, (int, float)) else v
    except (TypeError, ValueError):
        return float("nan")


class Forwarder:
    def __init__(self, kv, post, tg_api, tg_send_photo, chart, log, required=REQUIRED, now=clock.now_ms, cfg_props=None):
        self.cfg_props = cfg_props   # 設定來自環境變數時使用（不寫進狀態檔）
        self.kv, self.post, self.tg_api, self.tg_send_photo, self.chart, self.log = kv, post, tg_api, tg_send_photo, chart, log
        self.required, self.now = required, now
        self.lock = threading.Lock()
        self.lock_available = True      # 測試用：模擬 tryLock 失敗

    # ---- 設定 ----
    def props(self):
        return {**self.kv.props, **self.cfg_props} if self.cfg_props else self.kv.props

    def executor_config(self):
        p = self.props()
        url = normalize_executor_url(p.get("EXECUTOR_URL"))
        secret = js_trim(js_str(p.get("EXECUTOR_WEBHOOK_SECRET")))
        return {"url": url, "secret": secret, "enabled": bool(url and secret)}

    def config(self):
        return get_config(self.props(), self.required)

    def broadcast_chat_id(self):
        p = self.props()
        cid = js_trim(js_str(p.get("SIGNAL_CHAT_ID")))
        own = js_trim(js_str(p.get("ALLOWED_CHAT_ID")))
        return "" if (cid and own and cid == own) else cid

    def broadcast_thread_id(self):
        v = js_trim(js_str(self.props().get("SIGNAL_THREAD_ID")))
        return v if re.fullmatch(r"[0-9]+", v) else ""

    def operator_ids(self):
        p = self.props()
        raw = js_trim(js_str(p.get("OPERATOR_USER_IDS")))
        if not raw:
            raw = js_trim(js_str(p.get("ALLOWED_CHAT_ID")))
        return [v for v in (js_trim(x) for x in raw.split(",")) if v]

    def is_operator(self, user_id):
        if user_id is None:
            return False
        me = js_String(user_id)
        return any(safe_equals(i, me) for i in self.operator_ids())

    # ---- 轉送 ----
    def forward_to_executor(self, signal_text, dedup_key):
        """永遠不拋例外。回傳 {cardSent, broadcastSent[, result, payload]}。"""
        try:
            cfg = self.executor_config()
            if not cfg["enabled"]:
                return dict(NO_CARD)
            parsed = parse_signal_to_json(signal_text, dedup_key, self.now())
            if not parsed["ok"]:
                self.log("warn", "executor_parse_failed", {"source": "executor", "errors": "；".join(parsed["errors"])})
                return dict(NO_CARD)
            payload = parsed["payload"]
            result = self.post(payload, cfg)
            card_sent = broadcast_sent = False
            if js_truthy(result.get("ok")):
                decision = result.get("decision")
                if decision in CARD_DECISIONS:
                    out = self.send_pending_card(payload, result, signal_text)
                    card_sent = bool(out and js_truthy(out.get("sent")))
                    broadcast_sent = bool(out and js_truthy(out.get("broadcastSent")))
                ev = ("executor_placed" if decision == "placed" else "executor_pending" if decision == "pending"
                      else "executor_error" if decision == "error" else "executor_rejected")
                self.log("warn" if decision == "rejected" else "info", ev, {
                    "source": "executor", "sigId": js_slice(payload["sig_id"], -12), "decision": decision,
                    "reasons": truncate(_join(result.get("reasons"), "；"), 200), "elapsedMs": result.get("elapsedMs")})
                return {"cardSent": card_sent, "broadcastSent": broadcast_sent, "result": result, "payload": payload}
            queued = self.enqueue_retry(payload, result.get("error"))
            d = {"source": "executor", "sigId": js_slice(payload["sig_id"], -12)}
            if "error" in result:       # JS：undefined 的欄位在 JSON 中會被省略
                d["message"] = result["error"]
            self.log("warn" if queued else "error", "executor_queued_for_retry" if queued else "executor_forward_dropped", d)
            return dict(NO_CARD)
        except Exception:  # noqa: BLE001   最外層保險：任何意外都不能影響主流程
            return dict(NO_CARD)

    # ---- 卡片 ----
    def pending_markup(self, payload, result):
        if result.get("decision") == "pending":
            add_on, over = result.get("addOn"), result.get("overLimit")
            if js_truthy(add_on):
                label = "➕ 加倉進場（第 " + _cat(add_on.get("layerNo", UNDEF)) + " 次）"
            elif js_truthy(over):
                label = "➕ 超額進場（第 " + to_string(_num(over.get("openCount", UNDEF)) + 1) + " 筆）"
            else:
                label = "✅ 進場"
            return {"inline_keyboard": [[{"text": label, "callback_data": CB_CONFIRM + payload["sig_id"]},
                                         {"text": "⏭ 略過", "callback_data": CB_SKIP + payload["sig_id"]}]]}
        if result.get("decision") == "rejected" and "daily_loss_limit" in js_str(_join(result.get("reasons"), " ")):
            return {"inline_keyboard": [[{"text": "📊 查看日損／重置", "callback_data": CB_DAILY_PANEL}]]}
        return None

    def send_pending_card(self, payload, result, original_text):
        cfg = self.config()
        text = render_pending_card(payload, result, original_text)
        markup = self.pending_markup(payload, result)
        blob = None
        if js_len(text) <= TG_CAPTION_LIMIT:
            blob = self.chart(payload)
        else:
            self.log("warn", "chart_skipped_caption_too_long", {"source": "executor", "length": js_len(text), "limit": TG_CAPTION_LIMIT})
        if blob:
            sent = self.tg_send_photo(cfg["allowedChatId"], blob, text, markup)
        else:
            body = {"chat_id": str(cfg["allowedChatId"]), "text": text}
            if markup:
                body["reply_markup"] = markup
            sent = self.tg_api("sendMessage", body)
        if not sent:
            self.log("error", "executor_card_failed", {"source": "executor", "sigId": js_slice(payload["sig_id"], -12)})
        file_id = None
        photos = sent.get("photo") if isinstance(sent, dict) else None
        if isinstance(photos, list) and photos:
            file_id = photos[-1].get("file_id")
        broadcast = self.broadcast_signal(payload, result, original_text, file_id)
        return {"sent": sent, "broadcastSent": bool(broadcast)}

    def broadcast_signal(self, payload, result, original_text, file_id):
        chat_id = self.broadcast_chat_id()
        if not chat_id:
            return None
        thread_id = self.broadcast_thread_id()
        try:
            text = render_pending_card(payload, result, original_text, True)
            base = {"chat_id": chat_id}
            if thread_id:
                base["message_thread_id"] = int(thread_id)
            sent = None
            if file_id:
                sent = self.tg_api("sendPhoto", {"photo": file_id, "caption": text, **base})
            if not sent:
                sent = self.tg_api("sendMessage", {"text": text, **base})
            self.log("info" if sent else "warn", "broadcast_sent" if sent else "broadcast_failed", {
                "source": "executor", "sigId": js_slice(js_String(payload["sig_id"]), -12),
                "threadId": thread_id or None, "withPhoto": bool(file_id and sent)})
            return sent
        except Exception as err:  # noqa: BLE001
            self.log("warn", "broadcast_failed", {"source": "executor", "message": redact(error_message(err))})
            return None

    # ---- 補送佇列 ----
    def enqueue_retry(self, payload, reason):
        try:
            if sum(1 for k in self.kv.props if k.startswith(RETRY_PREFIX)) >= RETRY_MAX_QUEUE:
                return False
            now = self.now()
            self.kv.prop_set(RETRY_PREFIX + str(now) + "_" + js_slice(payload["sig_id"], -12), js_json({
                "payload": payload, "firstFailedAt": now, "nextAttemptAt": now, "attempts": 1,
                "lastError": truncate(redact(reason), 200)}))
            return True
        except Exception:  # noqa: BLE001
            return False

    def flush_queue(self):
        """每分鐘由排程呼叫。補送時不更新 payload 的 ts：超過 60 秒會被執行層以「已過期」拒絕，那是正確行為。"""
        keys = sorted(k for k in self.kv.props if k.startswith(RETRY_PREFIX))
        if not keys:
            return
        cfg = self.executor_config()
        if not cfg["enabled"]:
            return
        if not (self.lock_available and self.lock.acquire(timeout=1)):
            return
        try:
            for key in keys:
                raw = self.kv.props.get(key)
                if not raw:
                    continue
                try:
                    item = json.loads(raw)
                except ValueError:
                    self.kv.prop_delete(key)
                    continue
                now = self.now()
                attempts = _n(item.get("attempts"), 1)
                age = now - _n(item.get("firstFailedAt"), now)
                short_id = js_slice(js_str((item.get("payload") or {}).get("sig_id")), -12)
                if age > RETRY_MAX_AGE_MS or attempts >= RETRY_MAX_ATTEMPTS:
                    self.kv.prop_delete(key)
                    self.log("error", "executor_signal_dropped", {
                        "source": "executor", "sigId": short_id, "attempts": attempts,
                        "ageMinutes": js_round(age / 60000), "lastError": item.get("lastError") or ""})
                    continue
                if now < _n(item.get("nextAttemptAt"), 0):
                    continue
                result = self.post(item["payload"], cfg)
                if js_truthy(result.get("ok")):
                    self.kv.prop_delete(key)
                    accepted = result.get("decision") == "placed"
                    self.log("info" if accepted else "warn", "executor_retry_placed" if accepted else "executor_retry_rejected", {
                        "source": "executor", "sigId": short_id, "attempts": attempts + 1, "decision": result.get("decision"),
                        "delayMinutes": js_round(age / 60000), "reasons": truncate(_join(result.get("reasons"), "；"), 200)})
                    continue
                backoff = min(2 ** (attempts - 1), RETRY_MAX_BACKOFF_MIN)
                item["attempts"] = attempts + 1
                item["nextAttemptAt"] = now + backoff * 60000
                item["lastError"] = truncate(redact(result.get("error")), 200)
                self.kv.prop_set(key, js_json(item))
        finally:
            self.lock.release()
