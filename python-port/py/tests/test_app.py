import json
import os
import tempfile

import pytest
from starlette.testclient import TestClient

from vegas_executor import clock, equity, instruments, notify, symbols
from vegas_executor.app import create_app
from vegas_executor.config import build_config, validate
from vegas_executor.exchanges import okx
from vegas_executor.main import build

WH = "w" * 24          # 測試用假金鑰
CT = "c" * 24
NOW = 1758470000000


def fake_okx_json():
    def d(inst, ct, lot, mn):
        return {"instId": inst, "settleCcy": "USDT", "state": "live", "ctVal": str(ct), "lotSz": str(lot),
                "minSz": str(mn), "tickSz": "0.1", "lever": "100"}
    return {"code": "0", "data": [d("BTC-USDT-SWAP", 0.01, 0.01, 0.01), d("ETH-USDT-SWAP", 0.1, 0.01, 0.01),
                                  {**d("DEAD-USDT-SWAP", 1, 1, 1), "state": "suspend"}]}


def make(monkeypatch, **env):
    base = {"EXECUTOR_WEBHOOK_SECRET": WH, "EXECUTOR_CONTROL_SECRET": CT, "DRY_RUN": "true",
            "DEMO_MODE": "true", "DATA_DIR": tempfile.mkdtemp(prefix="app-"), "EXECUTION_MODE": "manual",
            "ALLOWED_SYMBOLS": "BTCUSDT.P,ETHUSDT.P", "DRIFT_CHECK": "false"}
    base.update(env)
    cfg, perr = build_config(base)
    cfg = validate(cfg, perr, warn=lambda *_: None)
    sent = []

    async def fake_send(text, c, opts=None):
        sent.append(text)
        return {"sent": False}
    monkeypatch.setattr(notify, "send", fake_send)
    equity.reset_cache()
    import asyncio
    cfg, store, syms, pre = asyncio.run(build(cfg, getter=lambda url: fake_okx_json()))
    clock.set_now(NOW)
    client = TestClient(create_app(cfg, store, syms, pre, get_ip=lambda: {"ip": "1.2.3.4"}))
    return client, cfg, store, sent


@pytest.fixture(autouse=True)
def _reset():
    yield
    clock.set_now(None)
    symbols.reset()


H = {"X-Executor-Key": WH}
C = {"X-Control-Key": CT}


def sig(**o):
    p = {"v": "11.8", "sig_id": "BTCUSDT.P-15-1758469980000-long", "ts": NOW - 2000, "symbol": "BTCUSDT.P",
         "tf": "15", "grade": 3, "score": 85, "side": "long", "entry": 85397.5, "sl": 85011.8,
         "tp": [85783.2, 86169.0, 86554.7]}
    p.update(o)
    return p


def test_instruments_parse_and_cache(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    h = client.get("/health").json()
    assert h["specSource"] == "exchange" and h["supportedSymbols"] == ["BTCUSDT.P", "ETHUSDT.P"]
    assert os.path.exists(os.path.join(cfg["dataDir"], "instruments.json"))
    # 網路失敗 → 退回快取
    import asyncio

    def boom(url):
        raise RuntimeError("down")
    r = asyncio.run(instruments.load(data_dir=cfg["dataDir"], getter=boom))
    assert r["source"] == "cache" and "BTC-USDT-SWAP" in r["specs"]
    assert asyncio.run(instruments.load(data_dir=tempfile.mkdtemp(), getter=boom))["source"] == "none"


def test_health(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    h = client.get("/health").json()
    assert h["ok"] and h["mode"] == "DRY_RUN" and h["role"] == "live" and h["halted"] is False
    assert h["reconcile"]["enabled"] is False and "DRY_RUN" in h["reconcile"]["note"]
    assert h["risk"]["maxConcurrent"] == cfg["risk"]["maxConcurrent"]
    assert h["dailyReset"]["count"] == 0


def test_auth_and_404(monkeypatch):
    client, *_ = make(monkeypatch)
    assert client.post("/signal", json=sig()).status_code == 403
    assert client.post("/signal", json=sig(), headers={"X-Executor-Key": "x"}).status_code == 403
    assert client.post("/signal", json=sig(), headers=C).status_code == 403          # 控制金鑰不能送訊號
    assert client.post("/control/halt", headers=H).status_code == 403                # 訊號金鑰不能停/復
    assert client.get("/positions", headers=H).status_code == 403
    assert client.get("/nope").status_code == 404
    assert client.get("/nope").json() == {"ok": False, "error": "not found"}


def test_signal_errors(monkeypatch):
    client, cfg, *_ = make(monkeypatch)
    assert client.post("/signal", content="{bad", headers=H).json() == {"ok": False, "error": "invalid json"}
    r = client.post("/signal", content=b"x" * 20000, headers=H)
    assert r.status_code == 500
    r = client.post("/signal", json=sig(target="shadow"), headers=H)
    assert r.status_code == 409 and r.json()["error"] == "target_mismatch"
    r = client.post("/signal", json=sig(side="x"), headers=H)
    assert r.status_code == 200 and r.json()["decision"] == "rejected"


def test_manual_flow_confirm(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    r = client.post("/signal", json=sig(), headers=H).json()
    assert r["ok"] and r["decision"] == "pending" and r["sizing"]["orderQty"] > 0 and r["dryRun"] is True
    assert len(sent) == 1
    p = client.get("/pending", headers=H).json()
    assert p["pendings"][0]["sigId"] == "BTCUSDT.P-15-1758469980000-long" and p["pendings"][0]["status"] == "pending"
    # 重送 → 冪等擋下
    assert client.post("/signal", json=sig(), headers=H).json()["decision"] == "rejected"
    before = len(sent)
    c = client.post("/confirm", json={"sig_id": "BTCUSDT.P-15-1758469980000-long", "notify": False}, headers=H).json()
    assert c["decision"] == "placed" and c["drift"] is None
    assert len(sent) == before     # confirm 帶 notify:false，不再多發一則
    again = client.post("/confirm", json={"sig_id": "BTCUSDT.P-15-1758469980000-long"}, headers=H).json()
    assert again["decision"] == "already_handling"
    assert client.post("/confirm", json={}, headers=H).status_code == 400
    assert client.post("/confirm", content="{", headers=H).status_code == 400


def test_notify_false_suppresses(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    client.post("/signal", json=sig(notify=False), headers=H)
    assert sent == []


def test_skip(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    client.post("/signal", json=sig(), headers=H)
    r = client.post("/skip", json={"sigId": "BTCUSDT.P-15-1758469980000-long"}, headers=H).json()
    assert r["decision"] == "skipped"
    assert client.post("/skip", json={"sig_id": "nope"}, headers=H).json()["decision"] == "not_found"


def test_confirm_with_drift_check_uses_ticker(monkeypatch):
    client, cfg, store, sent = make(monkeypatch, DRIFT_CHECK="true")

    async def tick(inst, c):
        return {"last": 85500}
    monkeypatch.setattr(okx, "fetch_ticker", tick)
    client.post("/signal", json=sig(), headers=H)
    c = client.post("/confirm", json={"sig_id": "BTCUSDT.P-15-1758469980000-long"}, headers=H).json()
    assert c["decision"] in ("placed", "rejected")
    if c["decision"] == "placed":
        assert c["drift"]["verdict"] in ("ok", "resize", "unchanged", "toward")


def test_ticker_public_parsing():
    import asyncio
    cfg = {"baseUrl": "https://x"}
    ok = lambda url: (200, {"code": "0", "data": [{"instId": "BTC-USDT-SWAP", "last": "85000.5", "askPx": "85001", "bidPx": "0", "ts": "1"}]})
    r = asyncio.run(okx.fetch_ticker("BTC-USDT-SWAP", cfg, http_get=ok))
    assert r["last"] == 85000.5 and r["bidPx"] is None and r["askPx"] == 85001
    with pytest.raises(RuntimeError):
        asyncio.run(okx.fetch_ticker("X", cfg, http_get=lambda u: (200, {"code": "0", "data": [{"last": "abc"}]})))
    with pytest.raises(RuntimeError):
        asyncio.run(okx.fetch_ticker("X", cfg, http_get=lambda u: (500, {})))


def test_halt_resume_and_blocks_signal(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    assert client.post("/control/halt", json={"reason": "測試"}, headers=C).json() == {"ok": True, "halted": True, "reason": "測試"}
    h = client.get("/health").json()
    assert h["halted"] is True and h["haltedSource"] == "manual"
    r = client.post("/signal", json=sig(), headers=H).json()
    assert r["decision"] == "rejected"
    assert client.post("/control/resume", headers=C).json() == {"ok": True, "halted": False}
    # 被 kill switch 擋下的 sig_id 已記為 rejected（與 Node 版相同），要換新的 sig_id 才會通過
    assert client.post("/signal", json=sig(), headers=H).json()["decision"] == "rejected"
    fresh = sig(sig_id="BTCUSDT.P-15-1758469990000-long")
    assert client.post("/signal", json=fresh, headers=H).json()["decision"] == "pending"


def test_limits(monkeypatch):
    client, cfg, store, sent = make(monkeypatch, MAX_CONCURRENT_CEILING="6", MAX_CONCURRENT="3")
    assert client.get("/limits").status_code == 403
    g = client.get("/limits", headers=H).json()
    assert g["ceiling"] == 6 and g["overridden"] is False
    assert client.post("/limits", json={"maxConcurrent": 7}, headers=H).status_code == 400
    assert client.post("/limits", json={"maxConcurrent": 2.5}, headers=H).status_code == 400
    ok = client.post("/limits", json={"maxConcurrent": 4}, headers=H).json()
    assert ok["maxConcurrent"] == 4 and ok["overridden"] is True
    assert client.post("/limits", json={}, headers=H).status_code == 400
    assert client.post("/limits", json={"dailyLossLimit": 5}, headers=H).status_code == 400
    assert client.post("/limits", json={"resetCooldownMin": 5000}, headers=H).status_code == 400


def test_daily_reset_rules(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    d = client.get("/daily", headers=H).json()
    assert d["ok"] and d["blocked"] is False and d["resetCount"] == 0
    assert client.post("/daily/reset", json={}, headers=H).json()["error"] == "need confirm:true"
    r = client.post("/daily/reset", json={"confirm": True}, headers=H)
    assert r.status_code == 400 and "未達日損上限" in r.json()["error"]
    store.record_pnl(-cfg["risk"]["dailyLossLimitUsdt"] - 1, NOW)
    assert client.get("/daily", headers=H).json()["blocked"] is True
    ok = client.post("/daily/reset", json={"confirm": True, "note": "t"}, headers=H).json()
    assert ok["ok"] and ok["resetCount"] == 1 and ok["clearedUsdt"] < 0 and ok["blocked"] is False


def test_positions_decisions_whoami_reconcile(monkeypatch):
    client, cfg, store, sent = make(monkeypatch)
    client.post("/signal", json=sig(), headers=H)
    client.post("/skip", json={"sig_id": "BTCUSDT.P-15-1758469980000-long"}, headers=H)
    p = client.get("/positions", headers=C).json()
    assert p["ok"] and p["counted"] == {"okx": 0, "bingx": 0}
    d = client.get("/decisions?limit=5", headers=C).json()
    assert d["ok"] and len(d["decisions"]) >= 1
    w = client.get("/control/whoami", headers=C).json()
    assert w["ok"] and w["outboundIp"] == "1.2.3.4"
    rc = client.post("/control/reconcile", headers=C).json()
    assert rc["ok"] and "dryRun" in rc["reconcile"]["skipped"]
