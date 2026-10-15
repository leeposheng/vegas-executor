"""Webhook 入口（Code.gs 的 getConfig_／doPost）：密鑰驗證、來源分流、被拒請求彙總。

props_loader() 回傳「屬性字典」（GAS 的指令碼屬性；Python 版由環境變數組成，名稱相同）。
每個請求重新載入設定，與 GAS 行為一致（改了屬性不必重啟）。telegram 來源交給注入的 handler（模組 C／D）。
"""
from .gas_util import js_str, safe_equals
from .intake import Intake, error_message

REQUIRED_GAS = ["TG_TOKEN", "ALLOWED_CHAT_ID", "TRADINGVIEW_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_SECRET", "WEBAPP_URL"]
REQUIRED = ["TG_TOKEN", "ALLOWED_CHAT_ID", "TRADINGVIEW_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_SECRET"]   # Python 版不需要 WEBAPP_URL


class ConfigMissing(Exception):
    pass


def get_config(props, required=REQUIRED):
    missing = [n for n in required if not props.get(n) or not str(props.get(n)).strip()]
    if missing:
        raise ConfigMissing("缺少指令碼屬性：" + ", ".join(missing))

    def g(name):
        return str(props.get(name) or "").strip()
    return {"tgToken": g("TG_TOKEN"), "allowedChatId": g("ALLOWED_CHAT_ID"), "anthropicApiKey": g("ANTHROPIC_API_KEY"),
            "tradingViewSecret": g("TRADINGVIEW_WEBHOOK_SECRET"), "telegramSecret": g("TELEGRAM_WEBHOOK_SECRET"),
            "webAppUrl": g("WEBAPP_URL"), "signalChatId": g("SIGNAL_CHAT_ID"), "signalThreadId": g("SIGNAL_THREAD_ID")}


class Webhook:
    def __init__(self, props_loader, kv, send_factory, log, forward=None, shadow=None, telegram=None,
                 required=REQUIRED):
        """send_factory(config) -> send(chat_id, text, thread_id)；telegram(body, config) -> 回應文字。"""
        self.props_loader, self.kv, self.send_factory, self.log = props_loader, kv, send_factory, log
        self.forward, self.shadow, self.telegram, self.required = forward, shadow, telegram, required

    def do_post(self, params, body):
        params = params or {}
        source = js_str(params.get("source")).lower()
        try:
            config = get_config(self.props_loader(), self.required)
            key = js_str(params.get("key"))
            intake = Intake(config, self.kv, self.send_factory(config), self.log, self.forward, self.shadow)
            if source == "telegram":
                if not safe_equals(key, config["telegramSecret"]):
                    intake.note_rejected("telegram_auth_rejected")
                    return "forbidden"
                if self.telegram is None:
                    return "telegram handler not installed"
                return self.telegram(body, config)
            if source == "tradingview":
                if not safe_equals(key, config["tradingViewSecret"]):
                    intake.note_rejected("tradingview_auth_rejected")
                    return "forbidden"
                return intake.handle_tradingview(body, "webhook")
            intake.note_rejected("unknown_webhook_source" if source else "missing_webhook_source")
            return "unknown source"
        except Exception as err:  # noqa: BLE001
            self.log("error", "webhook_failed", {"source": source or "missing", "message": error_message(err)})
            return "error"
