import copy
import json

import pytest

from vegas_executor import clock
from vegas_executor.callbacks import Callbacks, daily_markup, pick_steps, render_daily_panel
from vegas_executor.forward import Forwarder
from vegas_executor.gas_util import js_json
from vegas_executor.intake import Intake, KV
from vegas_executor.webhook import get_config
from .vec import load, same

V = load("bot_c.json")
FULL = {"TG_TOKEN": "123:TESTTOKEN", "ALLOWED_CHAT_ID": "111", "TRADINGVIEW_WEBHOOK_SECRET": "tv", "TELEGRAM_WEBHOOK_SECRET": "tg",
        "WEBAPP_URL": "https://x", "EXECUTOR_URL": "https://exec.example.com/health", "EXECUTOR_WEBHOOK_SECRET": "sec"}
T0 = 1758470000000


def build(sc):
    """依向量場景組出 Callbacks（外部呼叫全是腳本化的替身）。"""
    clock.set_now(T0)
    rec = {"calls": [], "logs": []}
    kv = KV(now=clock.now_ms)
    kv.seed({**FULL, **(sc.get("props") or {})})
    seq = {k: list(v) for k, v in (sc.get("tgSeq") or {}).items()}
    api = {k: list(v) for k, v in (sc.get("api") or {}).items()}
    action = list(sc.get("action") or [{"ok": True, "decision": "placed", "reasons": [], "drift": None, "dryRun": False}])

    def log(level, event, details):
        rec["logs"].append({"level": level, "event": event, "details": json.loads(json.dumps(details))})

    def tg_api(method, body):
        rec["calls"].append({"fn": "tgApi", "method": method, "body": json.loads(json.dumps(body))})
        if seq.get(method):
            return seq[method].pop(0)
        if method in (sc.get("tgNull") or []):
            return None
        return {"message_id": 1}

    def exec_api(path, method, body):
        rec["calls"].append({"fn": "api", "method": method, "path": path, "body": json.loads(json.dumps(body)) if body else None})
        q = api.get(method.upper() + " " + path)
        if not q:
            return {"ok": False, "error": "no_plan"}
        return copy.deepcopy(q.pop(0) if len(q) > 1 else q[0])

    def exec_action(act, sig_id):
        rec["calls"].append({"fn": "action", "action": act, "sigId": sig_id})
        return copy.deepcopy(action.pop(0) if len(action) > 1 else action[0])

    fwd = Forwarder(kv, None, tg_api, None, None, log)
    config = get_config(kv.props)
    intake = Intake(config, kv, lambda *a: None, log)
    cbs = Callbacks(kv, fwd, tg_api, exec_api, exec_action, intake.note_rejected, log)
    return cbs, kv, rec, config


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "cflow"], ids=lambda v: v["id"])
def test_flow(v):
    sc, exp = v["input"], v["expected"]
    try:
        cbs, kv, rec, config = build(sc)
        t = T0
        outs = []
        for st in sc["steps"]:
            t += st.get("dt") or 0
            clock.set_now(t)
            rec["calls"].clear(); rec["logs"].clear()
            if "lockOk" in st:
                kv.lock_available = st["lockOk"]
            kv.lock_seq = list(st["lockSeq"]) if st.get("lockSeq") else None
            result, error = None, None
            try:
                result = cbs.handle_update(json.loads(json.dumps(st["update"])), config)
            except Exception as e:  # noqa: BLE001
                error = str(e)
            outs.append({"result": result, "error": error, "calls": list(rec["calls"]), "logs": list(rec["logs"]), "t": t})
        got = {"steps": outs, "final": kv.export()}
    finally:
        clock.set_now(None)
    assert same(got, exp, v["id"]) is None


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "cdirect"], ids=lambda v: v["id"])
def test_direct(v):
    sc, exp = v["input"], v["expected"]
    name = sc["id"]
    try:
        cbs, kv, rec, config = build(sc)
        result, error = None, None
        try:
            if name.startswith("limit_panel"):
                cbs.send_limit_panel(config)
            elif name.startswith("daily_panel"):
                cbs.send_daily_panel(config)
            elif name.startswith("render_"):
                result = js_json([render_daily_panel(sc["d"]), daily_markup(sc["d"])])
            elif name.startswith("steps_"):
                result = pick_steps(sc["cand"], sc["lo"], sc["hi"], sc["cap"])
            elif name.startswith("edit_fallback_"):
                cbs.edit_card_result("111", 9, "H", "X｜Y\nZ")
            elif name.startswith("edit_"):
                cbs.edit_card_result(5, 9, sc["h"], sc["t"])
            else:
                raise AssertionError("未知案例 " + name)
        except AssertionError:
            raise
        except Exception as e:  # noqa: BLE001
            error = str(e)
        got = {"result": result, "error": error, "calls": list(rec["calls"]), "logs": list(rec["logs"]), "final": kv.export()}
    finally:
        clock.set_now(None)
    assert same(got, exp, v["id"]) is None
