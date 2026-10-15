"""Telegram 文字訊息分支（模組 D）：Code.gs 的 handleTelegramMessage_ 後半、指令比對、暫停、狀態、askClaude_ 的忠實移植。

callback_query 交給模組 C 的 Callbacks；其餘（指令、陌生聊天室、問答）在這裡。
send(chat_id, text, thread_id=None)：失敗拋例外（與 sendTelegramMessage_ 相同）。
claude_fetch(url, options, service) → 回應文字，失敗拋例外（正式環境用 tg.fetch_with_retry 包 HTTP）。
"""
import json
import re

from .cards import UNDEF, _cat
from .gas_util import JS_WS, js_String, js_json, js_str, js_trim, js_truthy, safe_equals
from .intake import error_message

CLAUDE_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
PAUSED_KEY = "TELEGRAM_CHAT_PAUSED"
SIGNAL_RETRY_PREFIX = "TVRETRY_"

STRATEGY_SYSTEM_PROMPT = "\n".join([
    "你是「維加斯通道＋QQE 訊號系統」（TradingView 指標 v11.8）的交易助理。",
    "【結構】EMA 144/169 為小通道、EMA 576/676 為大通道、EMA 12 為過濾線、EMA 250/288 為過濾通道。",
    "【正式訊號六道必要閘門】小通道排列同向；收盤位於過濾線同側；QQE 出現該段動能第一根同向色柱；N 根內回踩小通道；未處於纏繞盤整；大通道方向與大小通道距離成立。訊號另標註測試型或貫穿型。",
    "【過濾通道】訊號 K 棒價格與 EMA 250/288 相交時，改列觀察型態，不給品質分級。",
    "【品質】七項計分共 100 分：乾淨插針拒絕 20、通道斜率 15、脫離通道 15、大小通道距離 15、觸碰次數少 10、近期無反向訊號 10、無 RSI+MACD 共同背離 15。預設 80 分以上為高品質、55 分以上為標準，其餘為弱訊；觸碰過多或近期出現反向訊號各降一級。",
    "【進場管理】ENTRY 為訊號 K 棒收盤價；SL 預設為近期波段高低點加 ATR 緩衝；TP1/TP2/TP3 依序為 1R/2R/3R。策略建議週期 15M–1H；連續止損 3 單應暫停交易。",
    "回答請用繁體中文，簡潔專業，以 2–4 句為主，避免空泛免責聲明與贅詞。若問題涉及使用者訊息中附上的最近訊號，請直接引用其數值分析；沒有提供的資料不要臆測。"])

MENU = "\n".join([
    "📋 可用指令", "─────────────",
    "日損　　查看當日損益、調整上限與冷卻、重置",
    "部位　　調整同時持倉上限",
    "狀態　　系統狀態與補送佇列",
    "/id　　　顯示本聊天室的 chat id",
    "選單　　這張清單", "",
    "重置鍵只在「真的被日損上限擋住」時才會出現。",
    "沒被擋住時按不到，是刻意的 —— 按不到的按鈕會養成先按再說的習慣。"])


def normalize_command(text):
    first = re.split("[" + JS_WS + "]+", js_trim(js_str(text)).lower())[0]
    first = re.sub(r"@[^" + JS_WS + r"]+\Z", "", first)
    return re.sub(r"\A/+", "", first)


def is_command(command, aliases):
    return any(re.sub(r"\A/+", "", js_String(a).lower()) == command for a in aliases)


def build_claude_content(user_text, recent):
    if not recent:
        return user_text
    blocks = ["#" + str(i + 1) + "（收到時間 " + _cat(it.get("receivedAt", UNDEF)) + "）\n" + _cat(it.get("text", UNDEF))
              for i, it in enumerate(recent)]
    return ("<recent_signals>\n以下是最近 6 小時內收到的交易訊號（由新到舊），僅供回答參考：\n\n" + "\n\n".join(blocks)
            + "\n</recent_signals>\n\n使用者問題：" + user_text)


class TelegramBot:
    def __init__(self, kv, callbacks, send, get_recent, note_rejected, log, claude_fetch=None, model=CLAUDE_MODEL):
        self.kv, self.callbacks, self.send, self.get_recent = kv, callbacks, send, get_recent
        self.note_rejected, self.log, self.claude_fetch, self.model = note_rejected, log, claude_fetch, model

    # ---- 暫停 ----
    def set_paused(self, paused):
        self.kv.prop_set(PAUSED_KEY, "true" if paused else "false")

    def is_paused(self):
        return self.kv.props.get(PAUSED_KEY) == "true"

    # ---- 陌生聊天室節流（與正式去重隔離，只用快取）----
    def claim_stranger(self, update_id, chat_id):
        if update_id is not None:
            key = "SIDU_" + js_String(update_id)
            if self.kv.cache_get(key):
                return False
            self.kv.cache_put(key, "1", 3600)
        ckey = "SIDC_" + js_String(chat_id)
        if self.kv.cache_get(ckey):
            return False
        self.kv.cache_put(ckey, "1", 60)
        return True

    # ---- 問答 ----
    def ask_claude(self, user_text, config):
        if not config.get("anthropicApiKey"):
            return "目前未啟用 AI 問答；TradingView 交易快訊仍可正常接收。"
        try:
            body = js_json({"model": self.model, "max_tokens": 500, "system": STRATEGY_SYSTEM_PROMPT,
                            "messages": [{"role": "user", "content": build_claude_content(user_text, self.get_recent())}]})
            text = self.claude_fetch(CLAUDE_URL, {
                "method": "post", "contentType": "application/json",
                "headers": {"x-api-key": config["anthropicApiKey"], "anthropic-version": "2023-06-01"},
                "payload": body}, "Claude")
            data = json.loads(text)
            if isinstance(data, dict):
                content = data.get("content")
                if isinstance(content, list) and content and isinstance(content[0], dict) and js_truthy(content[0].get("text")):
                    return content[0]["text"]
                err = data.get("error")
                raise RuntimeError(err["message"] if isinstance(err, dict) and js_truthy(err.get("message")) else "回應缺少文字內容")
            raise RuntimeError("回應缺少文字內容")
        except Exception as err:  # noqa: BLE001
            self.log("error", "claude_request_failed", {"message": error_message(err)})
            return "（AI 解讀服務暫時無法取得，請稍後再試；交易快訊推送不受影響。）"

    # ---- 入口 ----
    def handle(self, body, config):
        raw = js_str(body)
        try:
            update = json.loads(raw)
        except ValueError:
            self.log("warn", "invalid_telegram_json", {})
            return "invalid json"
        if not isinstance(update, dict):
            update = {}
        if js_truthy(update.get("callback_query")):
            return self.callbacks.handle_update(update, config)

        message = update.get("message") if isinstance(update.get("message"), dict) else None
        chat = message.get("chat") if message else None
        chat_id = chat.get("id") if isinstance(chat, dict) else None
        user_text = message.get("text") if message else None
        if not js_truthy(chat_id):
            return "ignored update"
        uid = update.get("update_id")
        thread = message.get("message_thread_id")

        if not safe_equals(js_String(chat_id), config["allowedChatId"]):
            probe = normalize_command(user_text)
            if probe in ("id", "chatid"):
                if not self.claim_stranger(uid, chat_id):
                    return "duplicate chat id request"
                self.send(chat_id, "本聊天室的 chat id：\n" + js_String(chat_id)
                          + ("\n話題 ID：\n" + js_String(thread) if js_truthy(thread) else "")
                          + "\n\n要設成訊號群組，把 chat id 填進指令碼屬性 SIGNAL_CHAT_ID；若要訊號只進某個話題，再把話題 ID 填進 SIGNAL_THREAD_ID。",
                          js_String(thread) if js_truthy(thread) else "")
                return "chat id sent"
            if self.claim_stranger(uid, chat_id):
                self.note_rejected("unauthorized_telegram_chat")
            return "forbidden chat"

        frm = message.get("from")
        if isinstance(frm, dict) and js_truthy(frm.get("is_bot")):
            return "ignored bot message"
        if not isinstance(user_text, str) or not js_trim(user_text):
            return "ignored update"

        if not self.callbacks.claim_update(uid):
            if self.callbacks.should_log_duplicate(uid):
                self.log("info", "duplicate_telegram_update_ignored", {"updateId": uid, "kind": "message"})
            return "duplicate update"

        command = normalize_command(user_text)
        if is_command(command, ["停止", "暫停", "/stop", "/pause"]):
            self.set_paused(True)
            self.send(chat_id, "⏸ Telegram 問答已暫停。TradingView 交易快訊仍會正常推送；輸入「啟用」即可恢復問答。")
            return "paused"
        if is_command(command, ["啟用", "啟動", "開始", "恢復", "/start", "/resume"]):
            self.set_paused(False)
            self.send(chat_id, "▶️ Telegram 問答已恢復。")
            return "resumed"
        if is_command(command, ["部位", "上限", "/limit", "/limits"]):
            self.callbacks.send_limit_panel(config)
            return "limit panel sent"
        if is_command(command, ["日損", "重置", "/daily", "/reset"]):
            self.callbacks.send_daily_panel(config)
            return "daily panel sent"
        if is_command(command, ["/id", "chatid"]):
            self.send(chat_id, "本聊天室的 chat id：\n" + js_String(chat_id) + "\n話題 ID（message_thread_id）：\n"
                      + (js_String(thread) if js_truthy(thread) else "無（General 或非話題群組）"))
            return "chat id sent"
        if is_command(command, ["選單", "指令", "/menu", "/help", "說明"]):
            self.send(chat_id, MENU)
            return "menu sent"
        if is_command(command, ["狀態", "/status"]):
            retry = sum(1 for k in self.kv.props if k.startswith(SIGNAL_RETRY_PREFIX))
            text = ("ℹ️ Bot 狀態：Telegram 問答暫停；TradingView 快訊維持啟用。" if self.is_paused()
                    else "ℹ️ Bot 狀態：Telegram 問答與 TradingView 快訊皆為啟用。")
            text += "\n📨 最近 6 小時快取訊號：" + str(len(self.get_recent())) + " 筆"
            if retry > 0:
                text += "\n⏱ 待補送訊號：" + str(retry) + " 筆"
            self.send(chat_id, text)
            return "status sent"
        if self.is_paused():
            self.log("info", "telegram_message_ignored_while_paused", {})
            return "paused"
        self.send(chat_id, self.ask_claude(js_trim(user_text), config))
        return "ok"


def http_fetch(url, opts, timeout=30):
    """正式環境的 fetch：(status, text, headers)；HTTP 錯誤碼照回，網路失敗拋例外。"""
    import urllib.error
    import urllib.request
    payload = opts.get("payload")
    headers = dict(opts.get("headers") or {})
    if opts.get("contentType"):
        headers["Content-Type"] = opts["contentType"]
    req = urllib.request.Request(url, data=payload.encode("utf-8") if isinstance(payload, str) else None,
                                 method=(opts.get("method") or "get").upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)


def make_claude_fetch(fetch=http_fetch, sleep=None, rng=None, log=None):
    """askClaude_ 用的 fetchWithRetry_：429／5xx／網路錯誤最多 3 次，非 2xx 最終拋例外。"""
    from .tg import fetch_with_retry

    def claude_fetch(url, options, service):
        return fetch_with_retry(url, options, service, fetch, sleep, rng, log)
    return claude_fetch
