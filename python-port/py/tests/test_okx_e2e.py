"""以「假 OKX」驅動完整的非 DRY_RUN 路徑：自檢 → 訊號 → 確認 → 下單 → 止損核對 → 對帳。永不連網。"""
import asyncio
import json
import tempfile
import urllib.parse

import pytest
from starlette.testclient import TestClient

from vegas_executor import clock, equity, notify, symbols
from vegas_executor.app import create_app
from vegas_executor.config import build_config, validate
from vegas_executor.exchanges import okx
from vegas_executor.main import build
from vegas_executor.service import run_reconcile
from .test_app import H, NOW, fake_okx_json, sig, WH, CT

SIGID = "BTCUSDT.P-15-1758469980000-long"


class FakeOkx:
    def __init__(self):
        self.acct = {"acctLv": "2", "posMode": "net_mode"}
        self.equity = "10000"
        self.positions, self.history, self.orders, self.algos = [], [], {}, []
        self.log = []
        self.lose_response = False       # 單已成交，但回應在半路遺失
        self.attach_protection = True
        self.ticker = "85397.5"

    def __call__(self, method, url, headers, body):
        u = urllib.parse.urlparse(url)
        path, q = u.path, urllib.parse.parse_qs(u.query)
        self.log.append((method, path, body))
        ok = lambda data: (200, {"code": "0", "msg": "", "data": data})   # noqa: E731
        if path == "/api/v5/account/config":
            return ok([self.acct])
        if path == "/api/v5/account/balance":
            return ok([{"totalEq": self.equity, "details": [{"ccy": "USDT", "eq": self.equity, "availEq": self.equity}]}])
        if path == "/api/v5/account/set-leverage":
            return ok([{"lever": json.loads(body)["lever"]}])
        if path == "/api/v5/account/positions":
            return ok([p for p in self.positions])
        if path == "/api/v5/account/positions-history":
            return ok([h for h in self.history if h["instId"] == q["instId"][0]])
        if path == "/api/v5/trade/orders-algo-pending":
            return ok([a for a in self.algos if q["ordType"][0] == "oco"])
        if path == "/api/v5/trade/order" and method == "GET":
            o = self.orders.get(q["clOrdId"][0])
            return ok([o]) if o else (200, {"code": "51603", "msg": "Order does not exist", "data": []})
        if path == "/api/v5/trade/order" and method == "POST":
            b = json.loads(body)
            assert "attachAlgoOrds" in b and b["ordType"] == "market"
            self.orders[b["clOrdId"]] = {"ordId": "1", "clOrdId": b["clOrdId"], "state": "filled", "accFillSz": b["sz"],
                                         "avgPx": "85400", "side": b["side"], "posSide": "net", "cTime": str(NOW)}
            self.positions.append({"instId": b["instId"], "posSide": "net", "pos": b["sz"], "avgPx": "85400",
                                   "upl": "1.5", "mgnMode": b["tdMode"], "lever": "40"})
            if self.attach_protection:
                a = b["attachAlgoOrds"][0]
                self.algos.append({"algoId": "a1", "instId": b["instId"], "ordType": "oco", "state": "live",
                                   "slTriggerPx": a["slTriggerPx"], "tpTriggerPx": a["tpTriggerPx"], "sz": b["sz"], "posSide": "net"})
            if self.lose_response:
                raise RuntimeError("socket hang up")
            return ok([{"ordId": "1", "clOrdId": b["clOrdId"], "sCode": "0", "sMsg": ""}])
        raise AssertionError("unexpected " + method + " " + path)


def make(monkeypatch, fake, **env):
    base = {"EXECUTOR_WEBHOOK_SECRET": WH, "EXECUTOR_CONTROL_SECRET": CT, "DRY_RUN": "false", "DEMO_MODE": "true",
            "DATA_DIR": tempfile.mkdtemp(prefix="e2e-"), "EXECUTION_MODE": "manual", "ALLOWED_SYMBOLS": "BTCUSDT.P",
            "DRIFT_CHECK": "false", "OKX_API_KEY": "KEY-SECRET-1", "OKX_API_SECRET": "SECRET-2", "OKX_PASSPHRASE": "PASS-3",
            "OKX_TD_MODE": "isolated", "LEVERAGE": "40", "MAX_NOTIONAL_USDT": "50000"}
    base.update(env)
    cfg, perr = build_config(base)
    cfg = validate(cfg, perr, warn=lambda *_: None)
    sent = []

    async def fake_send(text, c, opts=None):
        sent.append(text)
        return {"sent": False}
    monkeypatch.setattr(notify, "send", fake_send)
    okx.set_transport(fake)
    okx.reset_leverage_cache()
    equity.reset_cache()
    clock.set_now(NOW)
    cfg, store, syms, pre = asyncio.run(build(cfg, getter=lambda url: fake_okx_json()))
    return cfg, store, syms, pre, sent


@pytest.fixture(autouse=True)
def _reset():
    yield
    okx.set_transport(None)
    clock.set_now(None)
    symbols.reset()


def client_for(cfg, store, syms, pre):
    return TestClient(create_app(cfg, store, syms, pre))


def test_preflight_sets_posmode_and_confirm_places_with_protection(monkeypatch):
    fake = FakeOkx()
    fake.acct["posMode"] = "net_mode"
    cfg, store, syms, pre, sent = make(monkeypatch, fake)
    assert pre["ok"] and cfg["okx"]["posMode"] == "net_mode" and store.is_halted() is False
    c = client_for(cfg, store, syms, pre)
    p = c.post("/signal", json=sig(), headers=H).json()
    assert p["decision"] == "pending"
    assert store.get_pending(SIGID, "okx")["equity"]["source"] == "exchange"   # 權益來自（假）交易所，不是設定檔
    r = c.post("/confirm", json={"sig_id": SIGID}, headers=H).json()
    assert r["decision"] == "placed" and r["dryRun"] is False
    paths = [(m, p_) for m, p_, _ in fake.log]
    assert ("POST", "/api/v5/account/set-leverage") in paths and ("POST", "/api/v5/trade/order") in paths
    assert paths.index(("POST", "/api/v5/account/set-leverage")) < paths.index(("POST", "/api/v5/trade/order"))
    pos = store.list_positions("okx")
    assert len(pos) == 1 and pos[0]["sigId"] == SIGID and pos[0]["leverage"] > 0
    assert store.list_intents() == []                      # 意圖完成任務後清除
    assert store.get_processed(SIGID, "okx")["outcome"] == "placed"


def test_no_secrets_leak_in_result(monkeypatch):
    fake = FakeOkx()
    cfg, store, syms, pre, sent = make(monkeypatch, fake)

    async def go():
        from vegas_executor import executor as X
        await X.handle_signal(sig(), {"config": cfg, "store": store})
        return await X.confirm_signal(SIGID, {"config": cfg, "store": store})
    res = asyncio.run(go())
    blob = json.dumps(res, ensure_ascii=False, default=str)
    for secret in ("KEY-SECRET-1", "SECRET-2", "PASS-3"):
        assert secret not in blob
    assert res["request"]["headers"]["OK-ACCESS-KEY"] == "[REDACTED]"


def test_missing_protection_is_loud(monkeypatch):
    fake = FakeOkx()
    fake.attach_protection = False
    cfg, store, syms, pre, sent = make(monkeypatch, fake)
    c = client_for(cfg, store, syms, pre)
    c.post("/signal", json=sig(), headers=H)
    r = c.post("/confirm", json={"sig_id": SIGID}, headers=H).json()
    assert r["decision"] == "placed"
    assert any("止損未掛上" in x for x in r["reasons"])
    assert any("止損未掛上" in t for t in sent)          # 推播的原因欄位也要有


def test_lost_response_keeps_intent_and_reconcile_recovers(monkeypatch):
    fake = FakeOkx()
    fake.lose_response = True
    cfg, store, syms, pre, sent = make(monkeypatch, fake, EXECUTION_MODE="auto")
    c = client_for(cfg, store, syms, pre)
    r = c.post("/signal", json=sig(), headers=H).json()
    assert r["decision"] == "error"
    assert len(store.list_intents()) == 1 and store.list_positions() == []     # 未知結果：留著意圖等對帳去查
    clock.set_now(NOW + 5 * 60000)                                              # 過寬限期
    out = asyncio.run(run_reconcile(cfg, store, "測試"))
    assert [x["outcome"] for x in out["resolvedIntents"]] == ["filled"]
    assert store.list_intents() == [] and len(store.list_positions()) == 1
    assert store.list_positions()[0]["recoveredBy"] == "reconcile"
    assert any("補登部位" in t for t in sent)


def test_reconcile_settles_closed_position_and_books_pnl(monkeypatch):
    fake = FakeOkx()
    cfg, store, syms, pre, sent = make(monkeypatch, fake, EXECUTION_MODE="auto")
    c = client_for(cfg, store, syms, pre)
    assert c.post("/signal", json=sig(), headers=H).json()["decision"] == "placed"
    # 持倉還在 → stillOpen
    clock.set_now(NOW + 5 * 60000)
    r = asyncio.run(run_reconcile(cfg, store, "測試"))
    assert r["stillOpen"] == 1 and r["closed"] == []
    # 交易所平倉：持倉消失、出現平倉紀錄（realizedPnl 含費用）
    fake.positions.clear()
    fake.history.append({"instId": "BTC-USDT-SWAP", "posSide": "net", "openAvgPx": "85400", "closeAvgPx": "85011.8",
                         "realizedPnl": "-22.5", "pnl": "-20", "fee": "-2", "fundingFee": "-0.5", "type": "2",
                         "cTime": str(NOW), "uTime": str(NOW + 6 * 60000), "posId": "p1"})
    clock.set_now(NOW + 7 * 60000)
    r = asyncio.run(run_reconcile(cfg, store, "測試"))
    assert len(r["closed"]) == 1 and r["closed"][0]["pnlUsdt"] == -22.5 and "推斷止損" in r["closed"][0]["reason"]
    assert store.list_positions() == []
    assert store.today(NOW + 6 * 60000)["realisedPnlUsdt"] == -22.5   # 記在平倉當日（UTC+8），而非對帳當日
    assert any("虧損平倉" in t for t in sent)
    # 再跑一輪不會重複記帳
    r2 = asyncio.run(run_reconcile(cfg, store, "測試"))
    assert store.today(NOW + 6 * 60000)["realisedPnlUsdt"] == -22.5 and r2["closed"] == []


def test_preflight_failure_halts_but_service_starts_then_autoclears(monkeypatch):
    fake = FakeOkx()
    fake.acct["acctLv"] = "1"
    cfg, store, syms, pre, sent = make(monkeypatch, fake)
    assert pre["ok"] is False and store.is_halted() and store.halted_source() == "preflight"
    c = client_for(cfg, store, syms, pre)
    assert c.get("/health").json()["halted"] is True
    d = c.post("/signal", json=sig(), headers=H).json()
    assert d["decision"] == "rejected"
    # 修好帳戶後重啟：preflight 自動解除「自己造成」的停止
    fake.acct["acctLv"] = "2"
    from vegas_executor.service import preflight
    assert asyncio.run(preflight(cfg, store))["ok"] is True
    assert store.is_halted() is False


def test_manual_halt_survives_preflight(monkeypatch):
    fake = FakeOkx()
    cfg, store, syms, pre, sent = make(monkeypatch, fake)
    store.set_halted(True, "我自己停的", "manual")
    from vegas_executor.service import preflight
    asyncio.run(preflight(cfg, store))
    assert store.is_halted() is True            # 人手動停的，程式沒資格替你解除


def test_preflight_posmode_missing_halts(monkeypatch):
    fake = FakeOkx()
    fake.acct["posMode"] = ""
    cfg, store, syms, pre, sent = make(monkeypatch, fake)
    assert pre["ok"] is False and "無法取得持倉模式" in pre["reason"]


def test_long_short_mode_adds_posside_and_sets_both_leverages(monkeypatch):
    fake = FakeOkx()
    fake.acct["posMode"] = "long_short_mode"
    cfg, store, syms, pre, sent = make(monkeypatch, fake)
    assert cfg["okx"]["posMode"] == "long_short_mode"
    c = client_for(cfg, store, syms, pre)
    c.post("/signal", json=sig(), headers=H)
    assert c.post("/confirm", json={"sig_id": SIGID}, headers=H).json()["decision"] == "placed"
    lev_calls = [b for m, p, b in fake.log if p.endswith("set-leverage")]
    assert len(lev_calls) == 2 and {json.loads(b)["posSide"] for b in lev_calls} == {"long", "short"}
    order = [json.loads(b) for m, p, b in fake.log if p == "/api/v5/trade/order" and m == "POST"][0]
    assert order["posSide"] == "long"
