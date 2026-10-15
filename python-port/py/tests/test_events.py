"""階段 5：事件日誌、告警、各接點。全程不連網。"""
import asyncio
import json
import os
import tempfile

import pytest

from vegas_executor import alerts, clock, events, notify, service, symbols
from vegas_executor.gate import Gate, GateError
from vegas_executor.config import build_config, validate
from vegas_executor.store import Store
from tests.test_app import C, CT, H, NOW, WH, make, sig


def make_live():
    """對帳測試用：不經 build()（它會對交易所做開機自檢）。金鑰皆為假值，且永不送出。"""
    base = {"EXECUTOR_WEBHOOK_SECRET": WH, "EXECUTOR_CONTROL_SECRET": CT, "DRY_RUN": "false", "DEMO_MODE": "true",
            "DATA_DIR": tempfile.mkdtemp(prefix="rc-"), "OKX_API_KEY": "fake-key", "OKX_API_SECRET": "fake-secret",
            "OKX_PASSPHRASE": "fake-pass", "ALLOWED_SYMBOLS": "BTCUSDT.P"}
    cfg, perr = build_config(base)
    cfg = validate(cfg, perr, warn=lambda *_: None)
    return cfg, Store(cfg["dataDir"])


@pytest.fixture(autouse=True)
def _clean():
    events.reset()
    alerts.reset()
    yield
    clock.set_now(None)
    symbols.reset()
    events.reset()
    alerts.reset()


def tmp(name="events.jsonl"):
    return os.path.join(tempfile.mkdtemp(prefix="ev-"), name)


def lines(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(x) for x in f if x.strip()]


# ---------- events ----------
def test_emit_writes_seven_fields_and_masks_secrets():
    p = tmp()
    events.configure(p)
    clock.set_now(NOW)
    rec = events.emit("executor_pending", source="http", duration_ms=12,
                      detail={"sigId": "a", "apiKey": "SECRET", "nested": {"X-Executor-Key": "k", "ok": 1},
                              "nan": float("nan")})
    row = lines(p)[0]
    assert set(row) == {"ts", "level", "source", "event", "detail", "durationMs", "eventId"}
    assert row["event"] == "executor_pending" and row["durationMs"] == 12 and row["level"] == "INFO"
    assert row["detail"]["apiKey"] == "***" and row["detail"]["nested"] == {"X-Executor-Key": "***", "ok": 1}
    assert row["detail"]["nan"] is None
    assert "SECRET" not in open(p, encoding="utf-8").read()
    assert rec["eventId"] == row["eventId"] and row["ts"].endswith("Z")


def test_rotation_keeps_limited_backups():
    p = tmp()
    events.configure(p, max_bytes=400, backups=2)
    for i in range(60):
        events.emit("e", detail={"i": i, "pad": "x" * 40})
    files = sorted(f for f in os.listdir(os.path.dirname(p)) if f.startswith("events.jsonl"))
    assert files == ["events.jsonl", "events.jsonl.1", "events.jsonl.2"]
    assert max(os.path.getsize(os.path.join(os.path.dirname(p), f)) for f in files) <= 400 + 200


def test_never_raises_when_unwritable():
    blocker = tmp("file")
    open(blocker, "w").close()
    events.configure(os.path.join(blocker, "sub", "events.jsonl"))   # 檔案底下不能當資料夾
    rec = events.emit("x", detail={"a": 1})
    assert rec is not None and events.stats()["writeErrors"] >= 1
    assert events.tail(5)[0]["event"] == "x"                          # 記憶體仍可查


def test_tail_filters_and_order(capsys):
    events.configure(None)
    events.emit("a", level="INFO")
    events.emit("b", level="WARN")
    events.emit("c", level="ERROR")
    assert [r["event"] for r in events.tail(10)] == ["c", "b", "a"]
    assert [r["event"] for r in events.tail(10, level="WARN")] == ["c", "b"]
    assert [r["event"] for r in events.tail(10, event="a")] == ["a"]
    assert len(events.tail(1)) == 1 and len(events.tail("zz")) == 3
    out = capsys.readouterr().out
    assert "WARN" in out and "ERROR" in out and "INFO" not in out      # 只有 WARN 以上會印到 stdout


def test_configure_from_env():
    d = tempfile.mkdtemp()
    assert events.configure_from_env({}, d) == os.path.join(d, "events.jsonl")
    assert events.configure_from_env({"EVENTS_FILE": "off"}, d) is None
    assert events.configure_from_env({"EVENTS_FILE": "/x/y.jsonl", "EVENTS_MAX_BYTES": "abc"}, d) == "/x/y.jsonl"


# ---------- alerts ----------
def test_alert_threshold_cooldown_and_reset():
    t = [0.0]
    alerts.configure(None, now=lambda: t[0])
    assert alerts.failure("k", "x", threshold=3) is False
    assert alerts.failure("k", "x", threshold=3) is False
    assert alerts.failure("k", "x", threshold=3) is True              # 第三次觸發
    assert alerts.failure("k", "x", threshold=3) is False             # 冷卻內不重複
    t[0] = 901
    assert alerts.failure("k", "x", threshold=3) is True              # 冷卻後仍失敗 → 再送
    alerts.success("k")
    assert alerts.failure("k", "x", threshold=3) is False             # 歸零重算
    assert [r["event"] for r in events.tail(10)].count("alert") == 2


def test_alert_delivers_via_sender_unless_disabled():
    got = []

    async def run():
        async def sender(text):
            got.append(text)
        alerts.configure(sender)
        alerts.failure("a", "有事")
        alerts.failure("b", "不經 TG", deliver=False)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    asyncio.run(run())
    assert got == ["🚨 有事"]


def test_alert_sender_failure_is_swallowed():
    async def run():
        async def sender(text):
            raise RuntimeError("tg down")
        alerts.configure(sender)
        assert alerts.failure("a", "x") is True
        await asyncio.sleep(0.01)
    asyncio.run(run())
    assert any(r["event"] == "alert_send_failed" for r in events.tail(10))


# ---------- 接點 ----------
def test_gate_timeouts_emit_events_and_alert():
    got = []

    async def run():
        async def sender(text):
            got.append(text)
        alerts.configure(sender)
        g = Gate(maxWaitMs=50, maxRunMs=50)

        async def slow():
            await asyncio.sleep(0.2)
        with pytest.raises(GateError) as e1:
            await g.run(slow, "A")
        assert e1.value.code == "run_timeout"
        with pytest.raises(GateError) as e2:
            await g.run(slow, "B")                                    # 排在 A 後面，等太久
        assert e2.value.code == "gate_timeout"
        await asyncio.sleep(0.3)
    asyncio.run(run())
    names = [r["event"] for r in events.tail(10)]
    assert "run_timeout" in names and "gate_timeout" in names
    assert len(got) == 2 and "確認" in got[0]


def test_telegram_consecutive_failures_alert_without_telegram(monkeypatch):
    def boom(token, payload):
        raise OSError("net down")
    monkeypatch.setattr(notify, "_post", boom)
    cfg = {"token": "t", "chatId": "1"}

    async def run():
        for _ in range(3):
            r = await notify.send("hi", cfg, {"delays": []})
            assert r["sent"] is False
    asyncio.run(run())
    ev = events.tail(20)
    assert sum(1 for r in ev if r["event"] == "telegram_send_failed") == 3
    assert any(r["event"] == "alert" and r["detail"]["key"] == "telegram" for r in ev)


def test_reconcile_three_failures_alert(monkeypatch):
    async def bad(ctx):
        return {"closed": [], "errors": ["OKX 逾時"]}
    monkeypatch.setattr(service, "reconcile_once", bad)
    cfg, store = make_live()

    async def run():
        for _ in range(3):
            await service.run_reconcile_for(cfg, store, "定時", "okx")
    asyncio.run(run())
    ev = events.tail(30)
    assert sum(1 for r in ev if r["event"] == "reconcile_error") == 3
    assert sum(1 for r in ev if r["event"] == "alert") == 1


def test_reconcile_exception_counts_and_success_resets(monkeypatch):
    calls = {"n": 0}

    async def flaky(ctx):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise RuntimeError("boom")
        return {"closed": [], "errors": []}
    monkeypatch.setattr(service, "reconcile_once", flaky)
    cfg, store = make_live()

    async def run():
        for _ in range(3):
            await service.run_reconcile_for(cfg, store, "定時", "okx")
    asyncio.run(run())
    ev = events.tail(30)
    assert sum(1 for r in ev if r["event"] == "reconcile_error") == 2
    assert not any(r["event"] == "alert" for r in ev)


def test_http_events_and_endpoint(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    # 金鑰錯誤
    assert client.post("/signal", json=sig(), headers={"X-Executor-Key": "bad"}).status_code == 403
    assert client.get("/events", headers={"X-Control-Key": "bad"}).status_code == 403
    # 壞 JSON
    assert client.post("/signal", content=b"{", headers=H).status_code == 400
    # 正常訊號 → pending；不合規 → rejected
    assert client.post("/signal", json=sig(), headers=H).json()["decision"] == "pending"
    r = client.post("/signal", json=sig(sig_id="X-1", symbol="ZZZUSDT.P"), headers=H).json()
    assert r["decision"] == "rejected"

    assert client.get("/events").status_code == 403                      # 沒帶金鑰
    body = client.get("/events?limit=50", headers=C).json()
    names = [e["event"] for e in body["events"]]
    for want in ("webhook_rejected", "executor_pending", "executor_rejected"):
        assert want in names, names
    reasons = {e["detail"].get("reason") for e in body["events"] if e["event"] == "webhook_rejected"}
    assert {"bad_executor_key", "bad_control_key", "invalid_json"} <= reasons
    pend = next(e for e in body["events"] if e["event"] == "executor_pending")
    assert pend["detail"]["sigId"] == "BTCUSDT.P-15-1758469980000-long" and pend["source"] == "http"
    assert isinstance(pend["durationMs"], (int, float))
    only = client.get("/events?event=executor_rejected", headers=C).json()["events"]
    assert only and all(e["event"] == "executor_rejected" for e in only)
    warn = client.get("/events?level=WARN", headers=C).json()["events"]
    assert warn and all(e["level"] in ("WARN", "ERROR") for e in warn)
    # 金鑰不會出現在任何事件裡
    dump = json.dumps(body, ensure_ascii=False)
    assert WH not in dump and CT not in dump
    # 事件也寫進了 Volume 檔
    assert os.path.exists(os.path.join(cfg["dataDir"], "events.jsonl"))


def test_control_events_and_confirm(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    client.post("/control/halt", json={"reason": "測試"}, headers=C)
    client.post("/control/resume", headers=C)
    client.post("/signal", json=sig(), headers=H)
    client.post("/confirm", json={"sig_id": "BTCUSDT.P-15-1758469980000-long"}, headers=H)
    ev = client.get("/events?limit=100", headers=C).json()["events"]
    names = [e["event"] for e in ev]
    assert "control_halt" in names and "control_resume" in names
    assert any(n.startswith("executor_") and n != "executor_pending" for n in names)   # confirm 的結果


def test_http_500_emits_error_and_alerts(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    monkeypatch.setattr(store, "list_decisions", lambda n: (_ for _ in ()).throw(RuntimeError("disk")))
    assert client.get("/decisions", headers=C).status_code == 500
    ev = events.tail(20)
    assert any(r["event"] == "http_error" and r["level"] == "ERROR" for r in ev)
    assert any(r["event"] == "alert" and r["detail"]["key"] == "http_error" for r in ev)
