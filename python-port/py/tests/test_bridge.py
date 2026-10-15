import asyncio
import threading

import pytest

from vegas_executor import bridge


@pytest.fixture()
def loop():
    lp = asyncio.new_event_loop()
    th = threading.Thread(target=lp.run_forever, daemon=True)
    th.start()
    yield lp

    def stop():
        for t in asyncio.all_tasks(lp):
            t.cancel()
        lp.stop()
    lp.call_soon_threadsafe(stop)
    th.join(2)


def test_shape_matches_post_to_executor():
    r = bridge.shape_result({"decision": "pending", "reasons": ["a"], "sizing": {"orderQty": 1}, "x": 1}, 12, True)
    assert r == {"ok": True, "elapsedMs": 12, "decision": "pending", "reasons": ["a"], "sizing": {"orderQty": 1}, "band": None,
                 "preview": None, "equity": None, "overLimit": None, "addOn": None, "dryRun": True}


def test_empty_body_defaults():
    r = bridge.shape_result({}, 0, None)
    assert r["decision"] == "unknown" and r["reasons"] == [] and r["sizing"] is None and r["dryRun"] is False


def test_post_runs_in_loop_and_suppresses_notify(loop):
    seen = {}

    async def fake(payload, ctx):
        seen["thread_is_loop"] = asyncio.get_running_loop() is loop
        seen["ctx"] = ctx
        seen["payload"] = payload
        return {"decision": "placed", "reasons": [], "sizing": {"orderQty": 2}, "band": {}}

    post = bridge.make_post(fake, loop, {"config": {"dryRun": True}, "store": "S"})
    r = post({"sig_id": "x"}, {})
    assert r["ok"] and r["decision"] == "placed" and r["dryRun"] is True and r["band"] is None
    assert seen["thread_is_loop"] and seen["ctx"]["suppressNotify"] is True and seen["ctx"]["store"] == "S"


def test_exception_becomes_failure(loop):
    async def boom(payload, ctx):
        raise RuntimeError("交易所壞了")

    r = bridge.make_post(boom, loop, {"config": {}})({"sig_id": "x"}, {})
    assert r["ok"] is False and "交易所壞了" in r["error"] and r["error"].startswith("執行層處理失敗")


def test_timeout_becomes_failure(loop):
    async def slow(payload, ctx):
        await asyncio.sleep(5)

    r = bridge.make_post(slow, loop, {"config": {}}, timeout_s=0.05)({"sig_id": "x"}, {})
    assert r["ok"] is False and r["error"].startswith("執行層處理失敗")


def test_real_handle_signal_dry_run(loop, tmp_path, monkeypatch):
    """真的 handle_signal（DRY_RUN、manual）：待確認卡片所需的欄位都要出得來。"""
    from vegas_executor import clock, notify, symbols
    from vegas_executor.config import build_config, validate
    from vegas_executor.executor import handle_signal
    from vegas_executor.store import Store

    env = {"EXECUTOR_WEBHOOK_SECRET": "w" * 24, "EXECUTOR_CONTROL_SECRET": "c" * 24, "DRY_RUN": "true", "DEMO_MODE": "true",
           "DATA_DIR": str(tmp_path), "SIZING_MODE": "fixed_margin", "FIXED_MARGIN_USDT": "50", "TARGET_LOSS_MIN_USDT": "10",
           "TARGET_LOSS_MAX_USDT": "22", "LEVERAGE": "40", "AUTO_LEVERAGE": "true", "MIN_LIQ_CUSHION": "3",
           "MAX_NOTIONAL_USDT": "1000000", "MAX_NOTIONAL_MULT": "1000", "EXECUTION_MODE": "manual", "MIN_GRADE": "1",
           "ALLOWED_TIMEFRAMES": "15", "MAX_CONCURRENT_POSITIONS": "5", "MAX_CONCURRENT_CEILING": "5", "DRIFT_CHECK": "false",
           "ALLOWED_SYMBOLS": "BTCUSDT.P", "EQUITY_SOURCE": "config", "ACCOUNT_EQUITY_USDT": "10000",
           "DAILY_LOSS_LIMIT_USDT": "50000", "DAILY_LOSS_CEILING_USDT": "100000"}
    cfg, perr = build_config(env)
    cfg = validate(cfg, perr, warn=lambda *_: None)
    monkeypatch.setattr(symbols, "_runtime", symbols._runtime)   # 結束時還原，避免弄髒其他測試
    symbols.install(allowed=["BTCUSDT.P"], specs={"BTC-USDT-SWAP": {"instId": "BTC-USDT-SWAP", "ctVal": 0.01, "lotSz": 0.01, "minSz": 0.01,
                    "settleCcy": "USDT", "state": "live", "tickSz": 0.1}})

    async def quiet(t, c, o=None):
        return {"sent": False}
    monkeypatch.setattr(notify, "send", quiet)
    ts = 1760000000000
    clock.set_now(ts + 2000)
    try:
        post = bridge.make_post(handle_signal, loop, {"config": cfg, "store": Store(str(tmp_path / "s"))})
        r = post({"v": "11.9", "sig_id": "a" * 48, "ts": ts, "symbol": "BTCUSDT.P", "tf": "15", "grade": 2, "score": 70,
                  "side": "long", "entry": 85397.5, "sl": 85011.8, "tp": [85783.2]}, {})
    finally:
        clock.set_now(None)
    assert r["ok"] and r["decision"] == "pending" and r["dryRun"] is True
    assert r["sizing"]["orderQty"] > 0 and r["sizing"]["unit"] == "contracts"
