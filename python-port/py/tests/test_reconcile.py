import asyncio
import json
import os
import tempfile

import pytest

from vegas_executor import clock, reconcile as R
from vegas_executor.store import Store
from .vec import load, same

RV = load("reconcile.json")
ONCE = [v for v in RV if v["fn"] == "reconcile_once"]


def scrub(x, d):
    return json.loads(json.dumps(x, ensure_ascii=False).replace(d.replace("\\", "\\\\"), "<DATA_DIR>").replace("<DATA_DIR>\\\\", "<DATA_DIR>/"))


@pytest.mark.parametrize("v", ONCE, ids=[v["id"] for v in ONCE])
def test_reconcile_once(v):
    inp, exp = v["input"], v["expected"]
    d = tempfile.mkdtemp(prefix="rc-")
    with open(os.path.join(d, "state.json"), "w", encoding="utf-8") as f:
        json.dump(inp["initialState"], f)
    store = Store(d)
    flags = []

    class Ex:
        async def fetch_positions(self, cfg, f):
            flags.append(dict(f))
            if inp["positionsThrow"]:
                raise RuntimeError(inp["positionsThrow"])
            return inp["live"]

        async def fetch_positions_history(self, p, cfg, f):
            flags.append(dict(f))
            if inp["historyThrow"]:
                raise RuntimeError(inp["historyThrow"])
            return inp["history"]

        async def fetch_order_by_cl_ord_id(self, p, cfg, f):
            flags.append(dict(f))
            if inp["orderThrow"]:
                raise RuntimeError(inp["orderThrow"])
            return inp["order"]

    t0 = inp["now"] - (inp["rounds"][-1] if inp["rounds"] else 0) if False else None
    # 向量的起點 T0 = 2026-09-25T00:00:00Z
    T0 = 1790294400000
    times = [T0 + dt for dt in inp["rounds"]] if inp["rounds"] else [inp["now"]]

    async def run():
        outs = []
        for t in times:
            clock.set_now(t)
            outs.append(await R.reconcile_once({"config": inp["cfg"], "store": store, "exchange": Ex(),
                                                "now": t, "exchangeName": inp["exchangeName"]}))
        return outs

    try:
        outs = asyncio.run(run())
    finally:
        clock.set_now(None)
    dd = same(scrub(outs[-1], d), exp["result"], "result")
    assert dd is None, f"{v['id']}: {dd}"
    if inp["rounds"]:
        dd = same(scrub(outs, d), exp["rounds"], "rounds")
        assert dd is None, f"{v['id']}: {dd}"
    assert same(flags, exp["flagsSeen"]) is None, f"{v['id']} flags {flags}"
    dd = same(scrub(store.state, d), exp["finalState"], "finalState")
    assert dd is None, f"{v['id']}: {dd}"


@pytest.mark.parametrize("v", [v for v in RV if v["fn"] == "match_history"], ids=lambda v: v["id"])
def test_match_history(v):
    got = R.match_history(v["input"]["history"], v["input"]["tracked"])
    assert same(got, v["expected"]) is None


@pytest.mark.parametrize("v", [v for v in RV if v["fn"] == "infer_exit"], ids=lambda v: v["id"])
def test_infer_exit(v):
    px = v["input"]["px"]
    got = R.infer_exit(float("nan") if px is None else px, v["input"]["tracked"])
    assert same(got, v["expected"]) is None


@pytest.mark.parametrize("v", [v for v in RV if v["fn"] == "describe_close_type"], ids=lambda v: v["id"])
def test_close_type(v):
    assert R.describe_close_type(v["input"]["t"]) == v["expected"]
