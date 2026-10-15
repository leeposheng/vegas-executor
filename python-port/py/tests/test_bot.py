import json

import pytest

from vegas_executor import clock
from vegas_executor.bot import TelegramBot, is_command, normalize_command
from vegas_executor.callbacks import Callbacks
from vegas_executor.forward import Forwarder
from vegas_executor.intake import Intake, KV
from vegas_executor.webhook import get_config
from .vec import load, same

V = load("bot_d.json")
FULL = {"TG_TOKEN": "123:TESTTOKEN", "ALLOWED_CHAT_ID": "111", "TRADINGVIEW_WEBHOOK_SECRET": "tv", "TELEGRAM_WEBHOOK_SECRET": "tg",
        "WEBAPP_URL": "https://x"}
T0 = 1758470000000


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "dpure"], ids=lambda v: v["id"])
def test_pure(v):
    sc = v["input"]
    a = sc["args"]
    got = normalize_command(a[0]) if "normalizeTelegramCommand_" in sc["expr"] else is_command(a[0], a[1])
    assert same(got, v["expected"], v["id"]) is None


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "dflow"], ids=lambda v: v["id"])
def test_flow(v):
    sc, exp = v["input"], v["expected"]
    clock.set_now(T0)
    rec = {"calls": [], "logs": []}
    kv = KV(now=clock.now_ms)
    kv.seed({**FULL, **(sc.get("props") or {})}, sc.get("cache"))
    claude = list(sc.get("claude") or [])

    def log(level, event, details):
        rec["logs"].append({"level": level, "event": event, "details": json.loads(json.dumps(details))})

    def send(chat_id, text, thread_id=None):
        rec["calls"].append({"fn": "send", "chatId": chat_id, "text": text, "threadId": thread_id})
        if sc.get("sendFails"):
            raise RuntimeError("Telegram HTTP 500: boom")

    def claude_fetch(url, options, service):
        rec["calls"].append({"fn": "claude", "url": url, "service": service, "options": json.loads(json.dumps(options))})
        p = claude.pop(0) if len(claude) > 1 else (claude[0] if claude else None)
        if p is None:
            raise RuntimeError("no plan")
        if p.get("throw"):
            raise RuntimeError(p["throw"])
        return p["body"]

    class FakeCallbacks(Callbacks):
        def handle_executor_callback(self, cb, config):
            rec["calls"].append({"fn": "execCallback", "data": cb["data"]})
            return "cb ok"

        def send_limit_panel(self, config):
            rec["calls"].append({"fn": "limitPanel"})

        def send_daily_panel(self, config):
            rec["calls"].append({"fn": "dailyPanel"})

    config = get_config(kv.props, ["TG_TOKEN", "ALLOWED_CHAT_ID", "TRADINGVIEW_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_SECRET", "WEBAPP_URL"])
    intake = Intake(config, kv, lambda *a: None, log)
    fwd = Forwarder(kv, None, None, None, None, log)
    cbs = FakeCallbacks(kv, fwd, lambda *a: rec["calls"].append({"fn": "tgApi", "method": a[0], "body": json.loads(json.dumps(a[1]))}) or {"message_id": 1},
                        None, None, intake.note_rejected, log)
    bot = TelegramBot(kv, cbs, send, intake.get_recent, intake.note_rejected, log, claude_fetch)
    try:
        t, outs = T0, []
        for st in sc["steps"]:
            t += st.get("dt") or 0
            clock.set_now(t)
            rec["calls"].clear(); rec["logs"].clear()
            if "lockOk" in st:
                kv.lock_available = st["lockOk"]
            result, error = None, None
            try:
                body = st["update"] if isinstance(st["update"], str) else json.dumps(st["update"])
                result = bot.handle(body, config)
            except Exception as e:  # noqa: BLE001
                error = str(e)
            outs.append({"result": result, "error": error, "calls": list(rec["calls"]), "logs": list(rec["logs"]), "t": t})
        got = {"steps": outs, "final": kv.export()}
    finally:
        clock.set_now(None)
    assert same(got, exp, v["id"]) is None


def _bot(fetch_text=None, key="k"):
    from vegas_executor.bot import TelegramBot
    logs = []
    kv = KV()
    bot = TelegramBot(kv, None, lambda *a: None, lambda: [], lambda r: None, lambda l, e, d: logs.append((l, e, d)),
                      lambda u, o, s: fetch_text)
    return bot, logs


def test_claude_invalid_json_and_null_fall_back():
    for body in ("not json", "null", ""):
        bot, logs = _bot(body)
        out = bot.ask_claude("q", {"anthropicApiKey": "k"})
        assert out.startswith("（AI 解讀服務暫時無法取得") and logs[0][1] == "claude_request_failed"


def test_make_claude_fetch_retries_then_returns_text():
    from vegas_executor.bot import make_claude_fetch
    seq = [(529, "overloaded", {}), (200, '{"content":[{"text":"hi"}]}', {})]
    sleeps = []
    f = make_claude_fetch(lambda u, o: seq.pop(0), sleeps.append, lambda: 0)
    assert json.loads(f("https://x", {"method": "post"}, "Claude"))["content"][0]["text"] == "hi" and sleeps == [500]
