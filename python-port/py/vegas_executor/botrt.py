"""Telegram 層組裝（模組 A–D 接線）：把訊號入口、轉送、按鈕、指令組成一個 do_post(params, body)。

預設關閉（BOT_ENABLED 未設為 true 時 main 不會建立它），所以不影響現有 TV→GAS→Zeabur→TG 流程。
設定沿用 GAS 的指令碼屬性名稱，改由環境變數提供：
  TG_TOKEN、ALLOWED_CHAT_ID、TRADINGVIEW_WEBHOOK_SECRET、TELEGRAM_WEBHOOK_SECRET（必填）
  SIGNAL_CHAT_ID、SIGNAL_THREAD_ID、OPERATOR_USER_IDS、ANTHROPIC_API_KEY（選填）
轉送執行層是行程內函式呼叫（bridge）；按鈕呼叫執行層走 127.0.0.1（loopback）。
"""
import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request
import uuid

from . import bridge, events, loopback, tg
from .chart import Blob, Chart
from .bot import TelegramBot, make_claude_fetch
from .callbacks import Callbacks
from .executor import handle_signal
from .forward import Forwarder
from .gas_util import js_str
from .intake import Intake, KV
from .syslog import log_fields
from .webhook import REQUIRED, Webhook, get_config

CHART_PROP_NAMES = ["CHART_IMG_API_KEY", "CHART_MAX_PARAMS", "CHART_EMA_ORDER", "CHART_SHOW_LEVELS", "CHART_LEVEL_SET",
                    "CHART_HIDE_LEGEND_KEYS", "CHART_WATERMARK", "CHART_WIDTH", "CHART_HEIGHT", "CHART_THEME",
                    "CHART_EMA_COLORS", "CHART_LEVEL_COLORS", "CHART_LEVEL_TEXT_COLORS", "CHART_LEVEL_TEXT_FIELD",
                    "CHART_TV_EXCHANGE", "CHART_CANDLE_UP", "CHART_CANDLE_DOWN", "CHART_EMA_STUDY_NAME"]
PROP_NAMES = ["TG_TOKEN", "ALLOWED_CHAT_ID", "TRADINGVIEW_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_SECRET", "SIGNAL_CHAT_ID",
              "SIGNAL_THREAD_ID", "OPERATOR_USER_IDS", "ANTHROPIC_API_KEY"] + CHART_PROP_NAMES


def default_fetch(url, opts, timeout=30):
    """(status, text, headers)。payload 是 dict → 表單；是字串 → 原樣（JSON）。HTTP 錯誤碼照回，網路失敗拋例外。"""
    payload = opts.get("payload")
    data = urllib.parse.urlencode(payload).encode() if isinstance(payload, dict) else (
        payload.encode("utf-8") if isinstance(payload, str) else None)
    headers = {"User-Agent": "vegas-executor/py", **(opts.get("headers") or {})}
    if opts.get("contentType"):
        headers["Content-Type"] = opts["contentType"]
    req = urllib.request.Request(url, data=data, method=(opts.get("method") or "get").upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)


def default_fetch_bin(url, opts, timeout=30):
    """(status, bytes, headers)：取圖用。HTTP 錯誤碼照回，網路失敗拋例外。"""
    payload = opts.get("payload")
    headers = {"User-Agent": "vegas-executor/py", **(opts.get("headers") or {})}
    if opts.get("contentType"):
        headers["Content-Type"] = opts["contentType"]
    req = urllib.request.Request(url, data=payload.encode("utf-8") if isinstance(payload, str) else None,
                                 method=(opts.get("method") or "get").upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def encode_multipart(fields, boundary):
    """fields：[(名稱, 字串 | Blob)] → multipart/form-data 本文（bytes）。"""
    out = []
    for name, val in fields:
        out.append(("--" + boundary + "\r\n").encode())
        if isinstance(val, Blob):
            out.append(('Content-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: image/png\r\n\r\n'
                        % (name, (val.name or "file").replace('"', "_"))).encode("utf-8"))
            out.append(val.data)
        else:
            out.append(('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode())
            out.append(js_str(val).encode("utf-8"))
        out.append(b"\r\n")
    out.append(("--" + boundary + "--\r\n").encode())
    return b"".join(out)


def default_fetch_form(url, fields, timeout=30):
    """multipart 上傳（sendPhoto）。回 (status, text)。"""
    boundary = "----vegas" + uuid.uuid4().hex
    req = urllib.request.Request(url, data=encode_multipart(fields, boundary), method="POST", headers={
        "Content-Type": "multipart/form-data; boundary=" + boundary, "User-Agent": "vegas-executor/py"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def missing_props(env):
    return [n for n in REQUIRED if not str(env.get(n) or "").strip()]


class BotRuntime:
    def __init__(self, config, store, env, *, fetch=default_fetch, fetch_bin=default_fetch_bin, fetch_form=default_fetch_form, sleep=None, rng=None, kv=None, loop_fetch=loopback.json_fetch):
        self.config, self.store, self.fetch, self.sleep, self.rng = config, store, fetch, sleep, rng
        self.loop = None
        miss = missing_props(env)
        if miss:
            raise RuntimeError("Telegram 層缺少設定：" + "、".join(miss))
        self.props = {n: str(env[n]) for n in PROP_NAMES if env.get(n) is not None}
        base = "http://127.0.0.1:" + str(int(config["port"]))
        self.base, self.secret = base, config["webhookSecret"]
        cfg_props = {**self.props, "EXECUTOR_URL": base, "EXECUTOR_WEBHOOK_SECRET": self.secret}
        self.kv = kv or KV(path=config["dataDir"].rstrip("/\\") + "/bot_kv.json")
        self.chart = Chart(self.props, fetch_bin, fetch_form, self.log)
        self.fwd = Forwarder(self.kv, self._post, self.tg_api, self.chart.send_photo, self.chart.fetch_image, self.log,
                             cfg_props=cfg_props)
        self.exec_api = loopback.make_exec_api(base, self.secret, loop_fetch)
        self.exec_action = loopback.make_exec_action(base, self.secret, loop_fetch)
        self.claude_fetch = make_claude_fetch(fetch, sleep, rng, self.log)
        self.webhook = Webhook(lambda: self.props, self.kv, self._send_factory, self.log,
                               forward=self.fwd.forward_to_executor, shadow=None, telegram=self._telegram)

    # ---- 基礎 ----
    def log(self, level, event, details=None):
        f = log_fields(level, event, details)
        events.emit(event, level=str(level).upper(), source=f["source"], detail=f["details"], duration_ms=f["elapsedMs"])

    def _post(self, payload, cfg):
        ctx = {"config": self.config, "store": self.store}
        return bridge.make_post(handle_signal, self.loop, ctx)(payload, cfg)

    def tg_api(self, method, body):
        """Telegram Bot API（JSON）。失敗回 None，不拋例外（與 tgApi_ 相同）。"""
        try:
            status, text, _ = self.fetch("https://api.telegram.org/bot" + self.props["TG_TOKEN"] + "/" + method, {
                "method": "post", "contentType": "application/json", "payload": json.dumps(body, ensure_ascii=False)})
            data = json.loads(text)
            return data.get("result") if isinstance(data, dict) and data.get("ok") else None
        except Exception:  # noqa: BLE001
            return None

    def _send_factory(self, config):
        def send(chat_id, text, thread_id=None):
            tg.send_message(config["tgToken"], chat_id, text, self.fetch, thread_id, self.sleep, self.rng, self.log)
        return send

    def _telegram(self, body, config):
        send = self._send_factory(config)
        intake = Intake(config, self.kv, send, self.log, self.fwd.forward_to_executor)
        cbs = Callbacks(self.kv, self.fwd, self.tg_api, self.exec_api, self.exec_action, intake.note_rejected, self.log)
        bot = TelegramBot(self.kv, cbs, lambda cid, text, thread=None: send(cid, text, thread), intake.get_recent,
                          intake.note_rejected, self.log, self.claude_fetch)
        return bot.handle(body, config)

    # ---- 對外 ----
    def do_post(self, params, body):
        """同步函式：由 HTTP 層放進執行緒跑。"""
        return self.webhook.do_post(params, body)

    def tick(self):
        """每分鐘：執行層補送佇列＋訊號補送佇列（對應 GAS 的時間觸發器）。"""
        try:
            self.fwd.flush_queue()
        except Exception as err:  # noqa: BLE001
            self.log("error", "executor_flush_failed", {"source": "executor", "message": str(err)[:200]})
        try:
            config = get_config(self.props)
            Intake(config, self.kv, self._send_factory(config), self.log, self.fwd.forward_to_executor).process_retries()
        except Exception as err:  # noqa: BLE001
            self.log("error", "tradingview_retry_failed", {"source": "bot", "message": str(err)[:200]})

    async def tick_loop(self, every_s=60):
        while True:
            await asyncio.sleep(every_s)
            await asyncio.to_thread(self.tick)
