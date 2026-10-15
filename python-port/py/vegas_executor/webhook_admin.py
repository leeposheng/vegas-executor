"""模組 G：Telegram／TradingView Webhook 管理（Code.gs 的 setupTelegramWebhook／resetTelegramWebhook／
diagnoseTelegramWebhook／showTradingViewWebhookUrl 的指令列版）。

用法（在終端機設好環境變數後執行；金鑰只讀環境變數，不會寫進任何檔案）：
  python -m vegas_executor.webhook_admin check          # 必要設定是否齊全（不連網）
  python -m vegas_executor.webhook_admin diagnose       # 查 Telegram 記錄的 Webhook 狀態（只讀）
  python -m vegas_executor.webhook_admin tv-url         # 印出 TradingView 要填的網址（含密鑰，勿外流）
  python -m vegas_executor.webhook_admin gen-secret     # 產生一組新密鑰（64 位 hex）
  python -m vegas_executor.webhook_admin set            # 【切換用】把 Telegram 指到 WEBAPP_URL
  python -m vegas_executor.webhook_admin reset          # 同上，並丟掉積壓的 update
  python -m vegas_executor.webhook_admin reset-drop     # reset＋清掉去重記錄與暫停狀態（服務需先停止）

set／reset／reset-drop 會改變「Telegram 的更新送到哪裡」，是切換的步驟，請依 CUTOVER.md 執行。
"""
import datetime
import json
import os
import sys
import urllib.parse
import uuid

from .gas_util import js_slice, redact
from .jsnum import js_json
from .webhook import REQUIRED_GAS, ConfigMissing, get_config

BOT_API = "https://api.telegram.org/bot"
KV_DROP_KEYS = ["LAST_TELEGRAM_UPDATE_ID", "TELEGRAM_RECENT_UPDATE_IDS", "TELEGRAM_CHAT_PAUSED"]


def encode_uri_component(s):
    return urllib.parse.quote(str(s), safe="-_.!~*'()")


def append_query(base, params):
    query = "&".join(encode_uri_component(k) + "=" + encode_uri_component(v) for k, v in params.items())
    return base + ("?" if "?" not in base else "&") + query


def telegram_url(config):
    return append_query(config["webAppUrl"], {"source": "telegram", "key": config["telegramSecret"]})


def tradingview_url(config):
    return append_query(config["webAppUrl"], {"source": "tradingview", "key": config["tradingViewSecret"]})


def set_webhook_request(config, drop_pending):
    """回傳 (網址, JSON 本文字串)。欄位順序與 GAS 相同。"""
    body = {"url": telegram_url(config),
            # 允許少量併行；callback_query 不列入的話，按鈕點擊不會送過來。
            "max_connections": 5, "allowed_updates": ["message", "callback_query"],
            "drop_pending_updates": bool(drop_pending)}
    return BOT_API + config["tgToken"] + "/setWebhook", js_json(body)


def _iso_seconds(sec):
    d = datetime.datetime.fromtimestamp(sec, datetime.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (d.microsecond // 1000)


def _or(v, default):
    return v if (v not in (None, "", 0, False)) else default


def diagnose_lines(text, config):
    """對應 diagnoseTelegramWebhook 的輸出（逐行）。"""
    try:
        data = json.loads(text)
    except ValueError:
        return ["無法解析回應：" + redact(text)]
    info = data.get("result") if isinstance(data, dict) else None
    info = info if isinstance(info, dict) and info else {}
    expected = telegram_url(config)
    url = _or(info.get("url"), None)
    pending = _or(info.get("pending_update_count"), 0)
    err_msg = _or(info.get("last_error_message"), None)
    report = {
        "urlConfigured": bool(url),
        "urlTail": js_slice(str(info["url"]), -12) if url else None,
        "urlMatchesCurrentDeployment": info.get("url") == expected,
        "pendingUpdateCount": pending,
    }
    if "max_connections" in info:
        report["maxConnections"] = info["max_connections"]
    report["allowedUpdates"] = _or(info.get("allowed_updates"), "(未限制)") if info.get("allowed_updates") != [] else []
    report["lastErrorAt"] = _iso_seconds(info["last_error_date"]) if _or(info.get("last_error_date"), None) else None
    report["lastErrorMessage"] = err_msg
    report["lastSynchronizationErrorAt"] = (_iso_seconds(info["last_synchronization_error_date"])
                                            if _or(info.get("last_synchronization_error_date"), None) else None)
    lines = [json.dumps(report, ensure_ascii=False, indent=2)]
    if isinstance(pending, (int, float)) and pending > 0:
        lines.append("\n⚠️ 佇列裡有 " + str(pending) + " 筆未確認的 update，Telegram 會持續重送它們。\n"
                     "   執行 resetTelegramWebhook() 可以清空。")
    if err_msg:
        lines.append("\n⚠️ Telegram 最後一次投遞失敗的原因：" + str(err_msg) +
                     "\n   這一行就是根因。把它貼出來才能對症處理。")
    if info.get("url") and info.get("url") != expected:
        lines.append("\n⚠️ Telegram 打的網址，跟這份指令碼目前的部署網址不一樣。"
                     "\n   意思是：你改的程式沒有在跑。執行 resetTelegramWebhook() 重新指過來。")
    p = info.get("pending_update_count")
    if not err_msg and not (isinstance(p, (int, float)) and not isinstance(p, bool) and p > 0):
        lines.append("\n✅ Webhook 狀態正常，沒有積壓也沒有投遞錯誤。")
    return lines


def set_webhook_lines(status, text):
    return ["Telegram setWebhook HTTP " + str(status), redact(text)]


# ---------------- 指令列 ----------------
def _config(env):
    return get_config(env, REQUIRED_GAS)


def _http(url, body=None, fetch=None):
    from .botrt import default_fetch
    f = fetch or default_fetch
    opts = {"method": "get"} if body is None else {"method": "post", "contentType": "application/json", "payload": body}
    status, text, _ = f(url, opts)
    return status, text


def run(cmd, env, out=print, fetch=None, kv_path=None):
    if cmd == "gen-secret":
        out(uuid.uuid4().hex + uuid.uuid4().hex)
        return 0
    try:
        config = _config(env)
    except ConfigMissing as err:
        out(str(err).replace("指令碼屬性", "環境變數"))
        return 2
    if cmd == "check":
        out("設定檢查完成：必要的環境變數皆存在。")
        return 0
    if cmd == "tv-url":
        out(tradingview_url(config))
        return 0
    if cmd == "diagnose":
        status, text = _http(BOT_API + config["tgToken"] + "/getWebhookInfo", None, fetch)
        for line in diagnose_lines(text, config):
            out(line)
        return 0
    if cmd in ("set", "reset", "reset-drop"):
        url, body = set_webhook_request(config, cmd != "set")
        status, text = _http(url, body, fetch)
        for line in set_webhook_lines(status, text):
            out(line)
        if cmd == "reset":
            out("已重設 Webhook 並清空積壓佇列。請接著執行 diagnose 確認。")
        if cmd == "reset-drop":
            n = _drop_kv_keys(kv_path or os.path.join(env.get("DATA_DIR") or "data", "bot_kv.json"))
            out("Telegram Webhook 已重設；舊佇列、去重記錄及暫停狀態已清除（%s）。" % n)
        return 0 if status == 200 else 1
    out("未知指令：" + str(cmd) + "\n" + __doc__)
    return 2


def _drop_kv_keys(path):
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return "找不到本機狀態檔，略過"
    props = d.get("props") or {}
    gone = [k for k in KV_DROP_KEYS if props.pop(k, None) is not None]
    d["props"] = props
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False)
    os.replace(tmp, path)
    return "已刪除 " + (", ".join(gone) or "（無）")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    return run(argv[0] if argv else "", os.environ)


if __name__ == "__main__":
    sys.exit(main())
