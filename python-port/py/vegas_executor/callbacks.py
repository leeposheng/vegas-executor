"""按鈕回呼（模組 C）：Code.gs 的 callback_query 分支＋Executor.gs 的 handleExecutorCallback_／持倉面板／日損面板的忠實移植。

與 GAS 的差異只有基礎設施：Cache／Properties → kv；LockService → kv 的行程內鎖；對執行層的 HTTP 呼叫
（callExecutorApi_／callExecutorAction_）→ 注入的 exec_api／exec_action（合併後是行程內函式呼叫）。
回傳字串與 GAS 的 textOutput_ 相同。同步函式，由 HTTP 層放進執行緒跑。
"""
import json
import math
import re

from .cards import UNDEF, _cat, _join
from .forward import CB_CONFIRM, CB_DAILY_PANEL, CB_PREFIX, CB_SKIP
from .gas_util import js_String, js_json, js_slice, js_str, js_trim, js_truthy, safe_equals, truncate
from .jsnum import js_round, to_fixed, to_number, to_string

CB_LIMIT = CB_PREFIX + "L."
CB_DAILY = CB_PREFIX + "D."
CB_DAILY_ASK = CB_DAILY + "ask"
CB_DAILY_GO = CB_DAILY + "go"
CB_DAILY_LIMIT = CB_DAILY + "lim."
CB_DAILY_COOL = CB_DAILY + "cd."
CB_CLAIM_PREFIX = "execcb_"
CB_CLAIM_TTL_SEC = 600
UPDATE_IDS_KEY = "TELEGRAM_RECENT_UPDATE_IDS"
NO_RESPONSE = "執行層沒有回應"


def _g(d, k):
    """JS 的 d.k（缺值 → undefined）。"""
    return d.get(k, UNDEF) if isinstance(d, dict) else UNDEF


def _tr(v):
    return v is not UNDEF and js_truthy(v)


def _n(v):
    """JS Number(v)；undefined → NaN。"""
    return float("nan") if v is UNDEF else to_number(v)


def _or0(v):
    """Number(v || 0)。"""
    return to_number(v) if (v is not UNDEF and js_truthy(v)) else 0.0


def _s(d, k):
    """'' + d.k 的字串化。"""
    return _cat(_g(d, k))


def _js_num_json(x):
    """放進 JSON 的數字：NaN／Infinity → null（與 JSON.stringify 相同），整數值轉 int。"""
    if isinstance(x, float):
        if not math.isfinite(x):
            return None
        if x == int(x):
            return int(x)
    return x


def _t(x):
    """數字轉 JS 字串（含 NaN）。"""
    return to_string(_js_num_json(x) if isinstance(x, float) and math.isfinite(x) else (x if not isinstance(x, float) else x))


def _fixed2(x):
    return to_fixed(x, 2)


def _real_eff(d):
    return -_or0(_g(d, "realisedPnlUsdt")), -_or0(_g(d, "effectivePnlUsdt"))


def _err_text(res):
    return js_str(res.get("error")) if isinstance(res, dict) and js_truthy(res.get("error")) else NO_RESPONSE


def pick_steps(candidates, lo, hi, cap=None):
    out = []
    for v in candidates:
        if lo <= v <= hi and v not in out:
            out.append(v)
    if hi >= lo and hi not in out:
        out.append(hi)
    out.sort()
    mx = cap if js_truthy(cap) else 5
    if len(out) > mx:
        keep = [out[-1]]
        step = (len(out) - 1) / (mx - 1) if mx > 1 else math.inf
        for k in range(mx - 2, -1, -1):
            keep.insert(0, out[int(js_round(k * step))])
        out = [v for i, v in enumerate(keep) if keep.index(v) == i]
    return out


def render_daily_panel(d):
    real, eff = _real_eff(d)
    lines = ["🛑 日損上限：已觸發" if _tr(_g(d, "blocked")) else "📊 日損上限", "─────────────",
             "真實日損：" + _fixed2(real) + " USDT"]
    if _n(_g(d, "resetCount")) > 0:
        lines.append("採計日損：" + _fixed2(eff) + " USDT（重置後重算）")
    lines.append("上限：" + _s(d, "dailyLossLimitUsdt") + " USDT")
    lines.append("今日筆數：" + (to_string(_g(d, "orders")) if _tr(_g(d, "orders")) else "0"))
    lines.append("─────────────")
    lines.append("今日已重置：" + _s(d, "resetCount") + " / " + _s(d, "resetLimit") + " 次")
    lines.append("冷卻設定：" + _s(d, "cooldownMin") + " 分鐘")
    if _tr(_g(d, "cooldownActive")):
        lines.append("❄️ 冷卻中，還有 " + _s(d, "cooldownRemainMin") + " 分鐘才會放行")
    if _n(_g(d, "resetLimit")) <= 0:
        lines.append("（重置功能已關閉：DAILY_RESET_LIMIT=0）")
    lines.append("─────────────")
    ceil = _g(d, "dailyLossCeiling")
    lines.append("上限可調範圍：10 ～ " + _cat(ceil if _tr(ceil) else _g(d, "dailyLossLimitUsdt")) + " USDT")
    lines.append("冷卻最短：" + (_cat(_g(d, "cooldownFloor")) if _tr(_g(d, "cooldownFloor")) else "0") + " 分鐘（只能調長）")
    return "\n".join(lines)


def daily_markup(d):
    rows = []
    if (_tr(_g(d, "blocked")) and _n(_g(d, "resetLimit")) > 0 and _n(_g(d, "resetsLeft")) > 0
            and not _tr(_g(d, "cooldownActive"))):
        rows.append([{"text": "♻️ 重置日損上限", "callback_data": CB_DAILY_ASK}])
    c = _g(d, "dailyLossCeiling")
    ceiling = _n(c if _tr(c) else _g(d, "dailyLossLimitUsdt"))
    if not (ceiling and not math.isnan(ceiling)):
        ceiling = 100
    limits = pick_steps([10, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300], 10, ceiling, 5)
    cur_lim = _n(_g(d, "dailyLossLimitUsdt"))
    if limits:
        rows.append([{"text": ("● " if v == cur_lim else "") + to_string(v), "callback_data": CB_DAILY_LIMIT + to_string(v)} for v in limits])
    cf = _g(d, "cooldownFloor")
    floor = _n(cf if _tr(cf) else 0)
    cools = pick_steps([0, 15, 30, 45, 60, 90, 120, 180, 240], floor, 240, 5)
    cur_cool = _n(_g(d, "cooldownMin"))
    if cools:
        rows.append([{"text": ("● " if v == cur_cool else "") + to_string(v) + "分", "callback_data": CB_DAILY_COOL + to_string(v)} for v in cools])
    return {"inline_keyboard": rows} if rows else None


def _with_markup(body, markup):
    if markup is not None:
        body["reply_markup"] = markup
    return body


def _limit_row(max_now, ceiling):
    c = _n(ceiling)
    c = c if (c and not math.isnan(c)) else 5
    row, n = [], 1
    while n <= c:
        row.append({"text": ("● " if n == max_now else "") + str(n), "callback_data": CB_LIMIT + str(n)})
        n += 1
    return row


def _split_data(data, prefix):
    return data[len(prefix):]


class Callbacks:
    def __init__(self, kv, fwd, tg_api, exec_api, exec_action, note_rejected, log):
        """exec_api(path, method, body) → dict；exec_action(action, sig_id) → dict；note_rejected(reason)。"""
        self.kv, self.fwd, self.tg_api, self.exec_api, self.exec_action = kv, fwd, tg_api, exec_api, exec_action
        self.note_rejected, self.log = note_rejected, log

    # ---- Code.gs：update_id 去重 ----
    def claim_update(self, update_id):
        if update_id is None:
            self.log("warn", "telegram_update_without_id", {})
            return True
        nid = js_trim(js_String(update_id))
        if not re.fullmatch(r"[0-9]+", nid):
            self.log("warn", "invalid_telegram_update_id", {})
            return False
        if not self.kv.try_lock(3000):
            raise RuntimeError("無法取得 Telegram update_id 鎖，請稍後重試")
        try:
            stored = self.kv.props.get(UPDATE_IDS_KEY)
            recent = []
            if stored:
                try:
                    parsed = json.loads(stored)
                    recent = [js_String(x) for x in parsed] if isinstance(parsed, list) else []
                except ValueError:
                    self.log("warn", "telegram_dedup_state_reset", {})
            if nid in recent:
                return False
            recent.append(nid)
            if len(recent) > 100:
                recent = recent[len(recent) - 100:]
            self.kv.prop_set(UPDATE_IDS_KEY, js_json(recent))
            return True
        finally:
            self.kv.release()

    def should_log_duplicate(self, update_id):
        key = "dupupd_" + js_String(update_id)
        try:
            if self.kv.cache_get(key):
                return False
            self.kv.cache_put(key, "1", 21600)
            return True
        except Exception:  # noqa: BLE001
            return True

    # ---- Code.gs：callback_query 分支 ----
    def handle_update(self, update, config):
        cb = update["callback_query"]
        msg = cb.get("message") if isinstance(cb, dict) else None
        chat = msg.get("chat") if isinstance(msg, dict) else None
        cb_chat_id = chat.get("id") if isinstance(chat, dict) else None
        if not js_truthy(cb_chat_id) or not safe_equals(js_String(cb_chat_id), config["allowedChatId"]):
            self.note_rejected("unauthorized_telegram_callback")
            return "forbidden callback"
        uid = update.get("update_id")
        if not self.claim_update(uid):
            if self.should_log_duplicate(uid):
                self.log("info", "duplicate_telegram_update_ignored", {"updateId": uid, "kind": "callback_query"})
            if js_truthy(cb.get("id")):
                self.tg_api("answerCallbackQuery", {"callback_query_id": cb["id"]})
            return "duplicate callback"
        return self.handle_executor_callback(cb, config)

    # ---- 持倉上限 ----
    def send_limit_panel(self, config):
        info = self.exec_api("/limits", "get", None)
        if not info or not js_truthy(info.get("ok")):
            self.tg_api("sendMessage", {"chat_id": str(config["allowedChatId"]),
                                        "text": "⚠️ 取不到目前的持倉上限：" + (js_str(info.get("error")) if info and js_truthy(info.get("error")) else NO_RESPONSE)})
            return
        ceiling = _g(info, "ceiling")
        c = _n(ceiling)
        c = c if (c and not math.isnan(c)) else 5
        self.tg_api("sendMessage", {
            "chat_id": str(config["allowedChatId"]),
            "text": "⚙️ 同時持倉上限\n─────────────\n目前：" + _s(info, "maxConcurrent") + " 個"
                    + ("（手動設定）" if js_truthy(info.get("overridden")) else "（環境變數預設）") + "\n"
                    + "在場：" + _s(info, "openPositions") + " 個\n可選範圍：1 ～ " + to_string(_js_num_json(c)) + "\n\n"
                    + "要超過 " + to_string(_js_num_json(c)) + "，得改 Zeabur 的 MAX_CONCURRENT_CEILING。",
            "reply_markup": {"inline_keyboard": [_limit_row(info.get("maxConcurrent"), ceiling)]}})

    def handle_limit_callback(self, wanted, query_id, msg, config):
        res = self.exec_api("/limits", "post", {"maxConcurrent": _js_num_json(wanted)})
        ok_now = bool(res and js_truthy(res.get("ok")))
        if js_truthy(query_id):
            self.tg_api("answerCallbackQuery", {"callback_query_id": query_id,
                                                "text": ("已改為 " + _s(res, "maxConcurrent") + " 個") if ok_now else ("失敗：" + _err_text(res))})
        if ok_now and msg and js_truthy(msg.get("message_id")):
            ceiling = _g(res, "ceiling")
            c = _n(ceiling)
            c = c if (c and not math.isnan(c)) else 5
            self.tg_api("editMessageText", {
                "chat_id": str(msg["chat"]["id"]), "message_id": msg["message_id"],
                "text": "⚙️ 同時持倉上限\n─────────────\n目前：" + _s(res, "maxConcurrent") + " 個（手動設定）\n在場："
                        + _s(res, "openPositions") + " 個\n可選範圍：1 ～ " + to_string(_js_num_json(c)),
                "reply_markup": {"inline_keyboard": [_limit_row(res.get("maxConcurrent"), ceiling)]}})
        self.log("info" if ok_now else "warn", "limit_changed" if ok_now else "limit_change_failed", {
            "source": "executor", "wanted": _js_num_json(wanted),
            "result": (res.get("maxConcurrent") if ok_now else (res.get("error") if res and js_truthy(res.get("error")) else "no_response"))})
        return "limit updated" if ok_now else "limit failed"

    # ---- 日損 ----
    def send_daily_panel(self, config):
        d = self.exec_api("/daily", "get", None)
        if not d or not js_truthy(d.get("ok")):
            self.tg_api("sendMessage", {
                "chat_id": str(config["allowedChatId"]),
                "text": "⚠️ 取不到日損狀態：" + _err_text(d) + "\n\n執行層可能還是舊版（/daily 這個端點不存在），或 EXECUTOR_URL 設錯了。"})
            return
        sent = self.tg_api("sendMessage", _with_markup({"chat_id": str(config["allowedChatId"]), "text": render_daily_panel(d)}, daily_markup(d)))
        if not sent:
            self.log("warn", "daily_panel_markup_failed", {"source": "executor"})
            plain = self.tg_api("sendMessage", {"chat_id": str(config["allowedChatId"]),
                                                "text": render_daily_panel(d) + "\n\n⚠️ 按鈕送不出去，只顯示數字。"})
            if not plain:
                self.log("error", "daily_panel_failed", {"source": "executor"})

    def _redraw_daily(self, chat_id, message_id):
        fresh = self.exec_api("/daily", "get", None)
        if fresh and js_truthy(fresh.get("ok")) and js_truthy(chat_id) and js_truthy(message_id):
            self.tg_api("editMessageText", _with_markup(
                {"chat_id": str(chat_id), "message_id": message_id, "text": render_daily_panel(fresh)}, daily_markup(fresh)))

    def handle_daily_callback(self, data, query_id, msg, config):
        chat = msg.get("chat") if isinstance(msg, dict) else None
        chat_id = chat.get("id") if isinstance(chat, dict) else None
        message_id = msg.get("message_id") if isinstance(msg, dict) else None

        def answer(text=None):
            if js_truthy(query_id):
                self.tg_api("answerCallbackQuery", {"callback_query_id": query_id, **({"text": text} if text is not None else {})})

        if data == CB_DAILY_ASK:
            d = self.exec_api("/daily", "get", None)
            answer()
            if not d or not js_truthy(d.get("ok")):
                return "daily state unavailable"
            real, eff = _real_eff(d)
            worst = real + _n(_g(d, "dailyLossLimitUsdt"))
            self.tg_api("editMessageText", {
                "chat_id": str(chat_id), "message_id": message_id,
                "text": "\n".join([
                    "⚠️ 確認要重置日損上限？", "─────────────",
                    "這會把風控採計的 " + _fixed2(eff) + " USDT 虧損歸零，",
                    "今天可以再虧到 " + _s(d, "dailyLossLimitUsdt") + " USDT 才會再次被擋。", "",
                    "真實日損不會改變，現在是 " + _fixed2(real) + " USDT，",
                    "重置後最壞情況會變成 " + _fixed2(worst) + " USDT。", "",
                    "重置之後還有 " + _s(d, "cooldownMin") + " 分鐘冷卻期，期間一樣不會下單。",
                    "今日剩餘重置次數：" + _s(d, "resetsLeft") + " 次（用掉就沒有了）"]),
                "reply_markup": {"inline_keyboard": [[{"text": "確定重置", "callback_data": CB_DAILY_GO},
                                                      {"text": "取消", "callback_data": CB_DAILY + "no"}]]}})
            return "daily reset confirm"

        if data == CB_DAILY_PANEL:
            answer()
            self.send_daily_panel(config)
            return "daily panel sent"

        if data.startswith(CB_DAILY_LIMIT) or data.startswith(CB_DAILY_COOL):
            is_limit = data.startswith(CB_DAILY_LIMIT)
            val = _n(_split_data(data, CB_DAILY_LIMIT if is_limit else CB_DAILY_COOL))
            jv = _js_num_json(val)
            r = self.exec_api("/limits", "post", {"dailyLossLimit": jv} if is_limit else {"resetCooldownMin": jv})
            good = bool(r and js_truthy(r.get("ok")))
            vtxt = "NaN" if (isinstance(val, float) and math.isnan(val)) else to_string(jv)
            answer(((("日損上限 → " + vtxt + " USDT") if is_limit else ("冷卻 → " + vtxt + " 分鐘")) if good else ("失敗：" + _err_text(r)))
                   if js_truthy(query_id) else None)
            if good and js_truthy(chat_id) and js_truthy(message_id):
                self._redraw_daily(chat_id, message_id)
            self.log("warn" if good else "error", "daily_setting_changed" if good else "daily_setting_failed", {
                "source": "executor", "key": "dailyLossLimit" if is_limit else "resetCooldownMin", "value": jv,
                "error": None if good else (r.get("error") if r and js_truthy(r.get("error")) else "no_response")})
            return "daily setting updated" if good else "daily setting failed"

        if data == CB_DAILY + "no":
            answer("已取消")
            cur = self.exec_api("/daily", "get", None)
            if cur and js_truthy(cur.get("ok")) and js_truthy(chat_id) and js_truthy(message_id):
                self.tg_api("editMessageText", _with_markup(
                    {"chat_id": str(chat_id), "message_id": message_id, "text": render_daily_panel(cur)}, daily_markup(cur)))
            return "daily reset cancelled"

        if data == CB_DAILY_GO:
            res = self.exec_api("/daily/reset", "post", {"confirm": True, "note": "telegram"})
            ok_now = bool(res and js_truthy(res.get("ok")))
            answer("已重置" if ok_now else ("失敗：" + _err_text(res)))
            if js_truthy(chat_id) and js_truthy(message_id):
                if ok_now:
                    body = "\n".join([
                        "♻️ 日損上限已重置", "─────────────",
                        "抹掉的採計虧損：" + _fixed2(-_or0(_g(res, "clearedUsdt"))) + " USDT",
                        "真實日損（不變）：" + _fixed2(-_or0(_g(res, "realisedPnlUsdt"))) + " USDT",
                        "今日已重置：" + _s(res, "resetCount") + " / " + _s(res, "resetLimit") + " 次",
                        "❄️ 冷卻 " + _s(res, "cooldownMin") + " 分鐘，期間不會下單"])
                else:
                    body = "⚠️ 重置失敗\n─────────────\n" + _err_text(res)
                self.tg_api("editMessageText", {"chat_id": str(chat_id), "message_id": message_id, "text": body})
            cleared = None
            if ok_now:
                cleared = float(to_fixed(-_n(_g(res, "clearedUsdt")), 2))
                cleared = _js_num_json(cleared)
            self.log("warn" if ok_now else "error", "daily_loss_reset" if ok_now else "daily_loss_reset_failed", {
                "source": "executor", "cleared": cleared, "resetCount": res.get("resetCount") if ok_now else None,
                "error": None if ok_now else (res.get("error") if res and js_truthy(res.get("error")) else "no_response")})
            return "daily reset" if ok_now else "daily reset failed"

        answer()
        return "unknown daily action"

    # ---- 進場／略過 ----
    def claim_callback(self, sig_id):
        key = CB_CLAIM_PREFIX + js_String(sig_id)
        try:
            if not self.kv.try_lock(3000):
                return False
            if self.kv.cache_get(key):
                return False
            self.kv.cache_put(key, "1", CB_CLAIM_TTL_SEC)
            return True
        except Exception:  # noqa: BLE001   快取或鎖異常不該讓按鈕失效：改由執行層冪等保護兜底
            return True
        finally:
            self.kv.release()

    def release_callback(self, sig_id):
        try:
            self.kv.cache_remove(CB_CLAIM_PREFIX + js_String(sig_id))
        except Exception:  # noqa: BLE001
            pass

    def edit_card_result(self, chat_id, message_id, head, original_text):
        rest = ""
        if js_truthy(original_text):
            lines = js_String(original_text).split("\n")
            old_head = lines.pop(0)
            rest = "\n".join(lines)
            bar = old_head.find("｜")
            if bar != -1:
                head += js_slice(old_head, len(old_head[:bar].encode("utf-16-le", "surrogatepass")) // 2)
        full = head + ("\n" + rest if rest else "")
        edited = self.tg_api("editMessageCaption", {"chat_id": str(chat_id), "message_id": message_id, "caption": full,
                                                    "reply_markup": {"inline_keyboard": []}})
        if not edited:
            self.tg_api("editMessageText", {"chat_id": str(chat_id), "message_id": message_id, "text": full,
                                            "reply_markup": {"inline_keyboard": []}})

    def handle_executor_callback(self, cb, config):
        query_id = cb.get("id")
        msg = cb.get("message")
        if isinstance(msg, dict) and not js_truthy(msg.get("text")) and js_truthy(msg.get("caption")):
            msg["text"] = msg["caption"]
        chat = msg.get("chat") if isinstance(msg, dict) else None
        chat_id = chat.get("id") if isinstance(chat, dict) else None
        data = js_str(cb.get("data"))
        frm = cb.get("from")
        from_id = frm.get("id") if isinstance(frm, dict) else None
        chat_ok = bool(js_truthy(chat_id) and safe_equals(js_String(chat_id), config["allowedChatId"]))
        if not chat_ok or not self.fwd.is_operator(from_id):
            d = {"source": "executor", "chatOk": chat_ok}
            if isinstance(frm, dict) and "id" in frm:
                d["fromId"] = from_id
            self.log("warn", "executor_callback_unauthorized", d)
            if js_truthy(query_id):
                self.tg_api("answerCallbackQuery", {"callback_query_id": query_id, "text": "未授權"})
            return "forbidden callback"
        if not data.startswith(CB_PREFIX):
            if js_truthy(query_id):
                self.tg_api("answerCallbackQuery", {"callback_query_id": query_id})
            return "ignored callback"
        if data.startswith(CB_LIMIT):
            return self.handle_limit_callback(_n(_split_data(data, CB_LIMIT)), query_id, msg, config)
        if data.startswith(CB_DAILY):
            return self.handle_daily_callback(data, query_id, msg, config)

        is_confirm = data.startswith(CB_CONFIRM)
        sig_id = _split_data(data, CB_CONFIRM if is_confirm else CB_SKIP)
        if not self.claim_callback(sig_id):
            if js_truthy(query_id):
                self.tg_api("answerCallbackQuery", {"callback_query_id": query_id, "text": "這筆已在處理或已完成，結果以上方訊息為準"})
            self.log("info", "executor_callback_duplicate", {"source": "executor", "sigId": js_slice(sig_id, -12)})
            return "duplicate callback"
        if js_truthy(query_id):
            self.tg_api("answerCallbackQuery", {"callback_query_id": query_id, "text": "確認中…" if is_confirm else "略過中…"})
        cfg = self.fwd.executor_config()
        if not cfg["enabled"]:
            self.release_callback(sig_id)
            self.edit_card_result(chat_id, msg.get("message_id"), "⚠️ 未設定執行層網址，無法處理", None)
            return "executor not configured"
        res = self.exec_action("confirm" if is_confirm else "skip", sig_id)
        ok = js_truthy(res.get("ok"))
        if not ok:
            self.release_callback(sig_id)
        decision = res.get("decision")
        if not ok:
            head = "⚠️ 連不上執行層，這筆未處理"
        elif decision == "placed":
            head = "👍 已確認（DRY_RUN，未真的送單）" if js_truthy(res.get("dryRun")) else "✅ 已進場"
        elif decision == "skipped":
            head = "⏭ 已略過"
        elif decision == "not_found":
            head = "⌛ 已失效（逾時或已處理過）"
        elif decision == "already_handling":
            head = "⏳ 已在處理中，請稍候"
        else:
            head = "⛔ 未執行：" + truncate(_join(res.get("reasons"), "；"), 120)
        drift = res.get("drift")
        if (js_truthy(drift) and drift.get("verdict") == "resize" and "fromQty" in drift and "toQty" in drift):
            head += ("\n🔄 依現價 " + _s(drift, "livePrice") + " 重算：" + _s(drift, "fromQty") + " → " + _s(drift, "toQty")
                     + " 張（漂移 " + _s(drift, "driftR") + "R，風險已拉回預算）")
        self.edit_card_result(chat_id, msg.get("message_id"), head, msg.get("text"))
        self.log("info" if (ok and decision in ("placed", "skipped")) else "warn",
                 "executor_user_confirmed" if is_confirm else "executor_user_skipped", {
                     "source": "executor", "sigId": js_slice(sig_id, -12), "decision": decision if js_truthy(decision) else "unreachable",
                     "reasons": truncate(_join(res.get("reasons"), "；"), 160)})
        return "ok"
