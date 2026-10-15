import asyncio
import json
import os
import re
import tempfile

import pytest

from vegas_executor import clock, equity, executor as X, notify
from vegas_executor.exchanges import okx
from vegas_executor.store import Store
from .vec import load, same

PV = load("pipeline.json") + load("fuzz.json")   # fuzz.json：Node 產生的隨機差異測試（固定種子）


def snake(name):
    return re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), name)


def scrub(x, d):
    s = json.dumps(x, ensure_ascii=False).replace(d.replace("\\", "\\\\"), "<DATA_DIR>").replace("<DATA_DIR>\\\\", "<DATA_DIR>/")
    return json.loads(s)


@pytest.mark.parametrize("v", PV, ids=[v["id"] for v in PV])
def test_pipeline(v, monkeypatch):
    inp, exp = v["input"], v["expected"]
    sent = []

    async def fake_send(text, cfg, opts=None):
        sent.append(text)
        return {"sent": False}

    async def fake_ticker(inst, cfg):
        return {"last": inp["tick"]}

    async def fake_equity(cfg, flags):
        if inp["eq"] == "throw":
            raise RuntimeError("fetch failed")
        return {"equityUsdt": inp["eq"]}

    async def fake_positions(cfg, flags):
        return inp["positions"]

    monkeypatch.setattr(notify, "send", fake_send)
    monkeypatch.setattr(okx, "fetch_ticker", fake_ticker)
    monkeypatch.setattr(okx, "fetch_equity", fake_equity)
    monkeypatch.setattr(okx, "fetch_positions", fake_positions)
    equity.reset_cache()

    d = tempfile.mkdtemp(prefix="vg-")
    if inp["state"] is not None:
        with open(os.path.join(d, "state.json"), "w", encoding="utf-8") as f:
            json.dump(inp["state"], f)
    store = Store(d)
    cfg = inp["config"]
    start = inp["startNow"]

    async def run():
        outs = []
        for st in inp["steps"]:
            now = start + (st.get("dt") or 0)
            clock.set_now(now)
            ctx = {"config": cfg, "store": store, "now": now}
            op = st["op"]
            if op == "handle":
                r = await X.handle_signal(st["payload"], ctx)
            elif op == "confirm":
                r = await X.confirm_signal(st.get("sigId"), ctx)
            elif op == "skip":
                r = await X.skip_signal(st.get("sigId"), ctx)
            else:
                call = st["call"]
                r = getattr(store, snake(call[0]))(*call[1:])
            outs.append(r)
        return outs

    try:
        outs = asyncio.run(run())
    finally:
        clock.set_now(None)

    assert len(outs) == len(exp["results"])
    for i, (got, want) in enumerate(zip(outs, exp["results"])):
        dd = same(scrub(got, d), want["result"], f"step{i}")
        assert dd is None, f"{v['id']}: {dd}"
    dd = same(scrub(sent, d), exp["notifications"], "notifications")
    assert dd is None, f"{v['id']}: {dd}"
    dd = same(scrub(store.state, d), exp["finalState"], "finalState")
    assert dd is None, f"{v['id']}: {dd}"
