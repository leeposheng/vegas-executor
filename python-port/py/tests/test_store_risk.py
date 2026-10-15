import json
import os
import re
import tempfile

import pytest

from vegas_executor import clock, risk as R
from vegas_executor.store import Store
from .vec import load, same


def mk(state):
    d = tempfile.mkdtemp(prefix="vg-")
    if state is not None:
        with open(os.path.join(d, "state.json"), "w", encoding="utf-8") as f:
            json.dump(state, f)
    return Store(d), d


def snake(name):
    return re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), name)


def scrub(x, d):
    s = json.dumps(x, ensure_ascii=False).replace(d.replace("\\", "\\\\"), "<DATA_DIR>").replace("<DATA_DIR>\\\\", "<DATA_DIR>/")
    s = re.sub(r"corrupt-\d+", "corrupt-<TS>", s)
    return json.loads(s)


def ids(vs):
    return [v["id"] for v in vs]


RK = load("risk.json")
ST = load("store.json")


@pytest.mark.parametrize("v", RK, ids=ids(RK))
def test_risk(v):
    i = v["input"]
    clock.set_now(i["now"])
    store, _ = mk(i["state"])
    fn = v["fn"]
    if fn == "risk_evaluate":
        ev = R.evaluate(i["signal"], store, i["risk"], i["exchange"])
        ae = R.addon_eligible(ev, store, i["risk"], i["exchange"], i["signal"])
        if ae and "base" in ae:
            ae = {**ae, "base": ae["base"]["sigId"]}
        got = {**ev, "summary": R.summarise(ev),
               "overflowEligible": R.overflow_eligible(ev, store, i["risk"], i["exchange"]), "addOnEligible": ae}
    elif fn == "risk_recheck":
        o = i["opts"] or {}
        got = R.recheck(i["signal"], store, i["risk"], i["exchange"],
                        allowOverflow=bool(o.get("allowOverflow")), addOn=o.get("addOn"))
    elif fn == "risk_effective":
        rk = i["risk"]
        got = {"maxConcurrent": R.effective_max_concurrent(store, rk),
               "dailyLossLimit": R.effective_daily_loss_limit(store, rk),
               "cooldownMin": R.effective_cooldown_min(store, rk),
               "cooldown": R.reset_cooldown(store, rk), "lossGate": R.daily_loss_gate(store, rk),
               "overflow": R.overflow_allowance(store, rk, "okx")}
    else:
        raise AssertionError(fn)
    clock.set_now(None)
    d = same(got, v["expected"]["value"])
    assert d is None, f"{v['id']}: {d}"


@pytest.mark.parametrize("v", ST, ids=ids(ST))
def test_store(v):
    clock.set_now(1790294400000 - 1790294400000 + 1758470000000)
    fn = v["fn"]
    if fn == "store_sequence":
        clock.set_now(1758470000000 * 0 + __import__("datetime").datetime(2026, 9, 25, tzinfo=__import__("datetime").timezone.utc).timestamp() * 1000)
        store, d = mk(None)
        exp = v["expected"]
        k = 0
        for step in v["input"]["steps"]:
            op, args = step[0], step[1:]
            if op == "at":
                clock.set_now(args[0])
                continue
            want = exp["steps"][[s["op"] for s in exp["steps"]].index(op) if False else k]
            while want["op"] == "at":
                k += 1
                want = exp["steps"][k]
            k += 1
            got = getattr(store, snake(op))(*args)
            got = scrub(got, d)
            dd = same(got, want["out"]["value"])
            assert dd is None, f"{v['id']} {op}{args}: {dd}"
        dd = same(scrub(store.state, d), exp["finalState"])
        assert dd is None, f"{v['id']} finalState: {dd}"
    elif fn == "store_load_corrupt":
        d = tempfile.mkdtemp(prefix="vg-")
        with open(os.path.join(d, "state.json"), "w") as f:
            f.write(v["input"]["content"])
        s = Store(d)
        assert same(s.state, v["expected"]["state"]) is None
        assert bool(s.corruptBackup) == v["expected"]["backedUp"]
    elif fn == "store_legacy_load":
        clock.set_now(__import__("datetime").datetime(2026, 9, 25, tzinfo=__import__("datetime").timezone.utc).timestamp() * 1000)
        s, _ = mk(v["input"]["state"])
        e = v["expected"]
        got = {"listPositions": s.list_positions("okx"), "listIntents": s.list_intents("okx"),
               "isProcessed": s.is_processed("ABCDEFGH-1", "okx"), "count": s.open_position_count("okx")}
        assert same(got, e) is None, same(got, e)
    clock.set_now(None)
