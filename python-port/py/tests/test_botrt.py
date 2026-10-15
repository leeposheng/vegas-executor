"""Telegram 層端到端：TestClient 當伺服器，假 Telegram，走完 收訊號 → 卡片 → 按鈕 → 改寫 → 指令。"""
import json
import urllib.parse

import pytest

from vegas_executor import clock
from vegas_executor.app import create_app
from vegas_executor.botrt import BotRuntime, missing_props
from vegas_executor.intake import KV
from starlette.testclient import TestClient
from .test_app import NOW, WH, make  # noqa: F401

ENV = {"TG_TOKEN": "123:TESTTOKEN", "ALLOWED_CHAT_ID": "111", "TRADINGVIEW_WEBHOOK_SECRET": "tv-secret", "TELEGRAM_WEBHOOK_SECRET": "tg-secret",
       "SIGNAL_CHAT_ID": "-100", "SIGNAL_THREAD_ID": "9"}
SIGNAL = ("《維加斯訊號》交易訊號\n─────────────\n[時間] 2026-09-21 20:13:00\n[幣種] BTCUSDT.P\n[週期] 15分鐘\n[時區] Asia/Taipei\n"
          "[品質] 標準\n[分數] 72\n[方向] 做多\n[價格] 85397.5 USDT\n[止損] 85011.8 USDT\n[止盈1] 85783.2 USDT\n[止盈2] 86169 USDT\n[止盈3] 86554.7 USDT")


class FakeTelegram:
    def __init__(self):
        self.calls = []

    def __call__(self, url, opts):
        method = url.rsplit("/", 1)[-1]
        p = opts.get("payload")
        body = json.loads(p) if isinstance(p, str) else dict(p or {})
        self.calls.append((method, body))
        return 200, json.dumps({"ok": True, "result": {"message_id": 500 + len(self.calls)}}), {}

    def of(self, method):
        return [b for m, b in self.calls if m == method]


@pytest.fixture()
def rig(monkeypatch):
    base_client, cfg, store, _ = make(monkeypatch, ALLOWED_TIMEFRAMES="15", MIN_GRADE="1", SIZING_MODE="fixed_margin",
                                 FIXED_MARGIN_USDT="50", TARGET_LOSS_MIN_USDT="1", TARGET_LOSS_MAX_USDT="50", PORT="8080")
    tgf = FakeTelegram()

    def loop_fetch(url, opts):
        path = urllib.parse.urlparse(url).path
        r = base_client.request(opts.get("method", "get").upper(), path, headers=opts.get("headers") or {},
                           content=(opts.get("payload") or "").encode())
        return r.status_code, r.text

    bot = BotRuntime(cfg, store, ENV, fetch=tgf, sleep=lambda ms: None, rng=lambda: 0, kv=KV(now=clock.now_ms), loop_fetch=loop_fetch)
    client = TestClient(create_app(cfg, store, {"source": "t", "missing": []}, {"ok": True}, bot=bot, get_ip=lambda: {"ip": "1"}))
    return client, bot, tgf, store


def tv(client, key="tv-secret", body=SIGNAL):
    return client.post("/?source=tradingview&key=" + key, content=body.encode())


def test_missing_props_reported():
    assert missing_props({"TG_TOKEN": "x"}) == ["ALLOWED_CHAT_ID", "TRADINGVIEW_WEBHOOK_SECRET", "TELEGRAM_WEBHOOK_SECRET"]


def test_bot_off_means_404(monkeypatch):
    client, *_ = make(monkeypatch)
    assert client.post("/?source=tradingview&key=x", content=b"hi").status_code == 404


def test_wrong_key_forbidden_and_nothing_sent(rig):
    client, bot, tgf, store = rig
    r = tv(client, key="nope")
    assert r.status_code == 200 and r.text == "forbidden" and tgf.calls == []


def test_signal_to_card_to_button(rig):
    client, bot, tgf, store = rig
    r = tv(client)
    assert r.status_code == 200 and r.text == "ok", r.text
    msgs = tgf.of("sendMessage")
    private = [m for m in msgs if m["chat_id"] == "111"]
    group = [m for m in msgs if m["chat_id"] == "-100"]
    assert len(private) == 1 and len(group) == 1
    assert "待確認" in private[0]["text"].split("\n")[0] and "reply_markup" in private[0]
    assert "reply_markup" not in group[0] and group[0]["message_thread_id"] == 9 and "[風險]" not in group[0]["text"]
    btn = private[0]["reply_markup"]["inline_keyboard"][0][0]
    assert btn["text"] == "✅ 進場" and btn["callback_data"].startswith("vg.c.")
    # 重複送同一則 → 去重，不再發卡片
    n = len(tgf.calls)
    assert tv(client).text == "duplicate" and len(tgf.calls) == n
    # 按下「進場」
    update = {"update_id": 9001, "callback_query": {"id": "cq1", "data": btn["callback_data"], "from": {"id": 111},
                                                   "message": {"message_id": 77, "chat": {"id": 111}, "text": private[0]["text"]}}}
    r = client.post("/?source=telegram&key=tg-secret", content=json.dumps(update).encode())
    assert r.text == "ok", r.text
    assert tgf.of("answerCallbackQuery")[0]["text"] == "確認中…"
    edit = tgf.of("editMessageCaption")[0]
    assert edit["caption"].startswith("👍 已確認（DRY_RUN，未真的送單）｜做多⬆") and edit["reply_markup"] == {"inline_keyboard": []}
    # 再按一次（不同 update_id）→ 已處理，不會再改寫
    update["update_id"] = 9002
    n = len(tgf.of("editMessageCaption"))
    assert client.post("/?source=telegram&key=tg-secret", content=json.dumps(update).encode()).text == "duplicate callback"
    assert len(tgf.of("editMessageCaption")) == n


def test_skip_button_and_unauthorized_user(rig):
    client, bot, tgf, store = rig
    tv(client)
    btn = [m for m in tgf.of("sendMessage") if m["chat_id"] == "111"][0]["reply_markup"]["inline_keyboard"][0]
    cb = lambda i, data, uid: {"update_id": i, "callback_query": {"id": f"q{i}", "data": data, "from": {"id": uid},
                                                                   "message": {"message_id": 5, "chat": {"id": 111}, "text": "⏳ 待確認｜做多⬆\nx"}}}
    r = client.post("/?source=telegram&key=tg-secret", content=json.dumps(cb(1, btn[1]["callback_data"], 999)).encode())
    assert r.text == "forbidden callback" and tgf.of("editMessageCaption") == []
    r = client.post("/?source=telegram&key=tg-secret", content=json.dumps(cb(2, btn[1]["callback_data"], 111)).encode())
    assert r.text == "ok" and tgf.of("editMessageCaption")[0]["caption"].startswith("⏭ 已略過")


def test_commands_go_through_loopback(rig):
    client, bot, tgf, store = rig
    msg = lambda i, t: json.dumps({"update_id": i, "message": {"message_id": 1, "chat": {"id": 111}, "from": {"id": 111}, "text": t}}).encode()
    assert client.post("/?source=telegram&key=tg-secret", content=msg(1, "/日損")).text == "daily panel sent"
    panel = tgf.of("sendMessage")[-1]
    assert panel["text"].startswith("📊 日損上限") and "reply_markup" in panel
    assert client.post("/?source=telegram&key=tg-secret", content=msg(2, "部位")).text == "limit panel sent"
    assert tgf.of("sendMessage")[-1]["text"].startswith("⚙️ 同時持倉上限")
    assert client.post("/?source=telegram&key=tg-secret", content=msg(3, "狀態")).text == "status sent"
    assert client.post("/?source=telegram&key=tg-secret", content=msg(4, "BTC 怎麼看")).text == "ok"
    assert "未啟用 AI 問答" in tgf.of("sendMessage")[-1]["text"]


def test_tick_runs_without_error(rig):
    client, bot, tgf, store = rig
    bot.tick()
