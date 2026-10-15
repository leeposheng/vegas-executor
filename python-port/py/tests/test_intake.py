import json

import pytest

from vegas_executor import clock, gas_util as G, tg
from vegas_executor.intake import Intake, KV
from .vec import load, same

V = load("intake.json")
PURE = {"truncate": G.truncate, "redact": G.redact, "safeEquals": G.safe_equals, "sha256Hex": G.sha256_hex,
        "splitTelegramText": G.split_text, "isExpected": G.is_expected_signal}


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "pure"], ids=lambda v: v["id"])
def test_pure(v):
    inp = v["input"]
    got = PURE[inp["f"]](*inp["args"])
    assert same(got, v["expected"], v["id"]) is None


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "send_telegram"], ids=lambda v: v["id"])
def test_send_telegram(v):
    inp, exp = v["input"], v["expected"]
    plan, calls, sleeps, logs = list(inp["plan"]), [], [], []

    def fetch(url, opts):
        calls.append({"url": url, "opts": json.loads(json.dumps(opts))})
        p = plan.pop(0) if plan else {"status": 200, "body": '{"ok":true}'}
        if p.get("throw"):
            raise RuntimeError(p["throw"])
        return p["status"], p["body"], p.get("headers") or {}

    err = None
    try:
        tg.send_message("123:TESTTOKEN", inp["chatId"], inp["text"], fetch, inp["threadId"], sleeps.append, lambda: 0,
                        lambda lv, ev, d: logs.append({"level": lv, "event": ev, "details": d}))
    except Exception as e:  # noqa: BLE001
        err = str(e)
    got = {"error": err, "fetchCalls": calls, "sleeps": sleeps, "logs": logs}
    assert same(got, exp, v["id"]) is None


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "intake_flow"], ids=lambda v: v["id"])
def test_intake_flow(v):
    sc, exp = v["input"], v["expected"]
    t = {"now": 1758470000000}
    clock.set_now(t["now"])
    rec = {"calls": [], "logs": []}
    kv = KV(now=clock.now_ms)
    kv.seed((sc.get("seed") or {}).get("props"), (sc.get("seed") or {}).get("cache"))
    plan = {"fail": []}

    def send(chat_id, text, thread_id):
        rec["calls"].append({"fn": "send", "chatId": str(chat_id), "text": text, "threadId": thread_id})
        if str(chat_id) in plan["fail"]:
            raise RuntimeError(f"Telegram HTTP 500: boom {chat_id}")

    def log(level, event, details):
        rec["logs"].append({"level": level, "event": event, "details": json.loads(json.dumps(details))})

    def shadow(text, key):
        rec["calls"].append({"fn": "shadow", "text": text, "key": key})

    cur = {"fwd": None}

    def forward(text, key):
        rec["calls"].append({"fn": "forward", "text": text, "key": key})
        f = cur["fwd"]
        if f.get("advance"):
            t["now"] += f["advance"]
            clock.set_now(t["now"])
        if f.get("throw"):
            raise RuntimeError(f["throw"])
        return f.get("result")

    try:
        outs = []
        for st in sc["steps"]:
            t["now"] += st.get("dt") or 0
            clock.set_now(t["now"])
            rec["calls"].clear(); rec["logs"].clear()
            plan["fail"] = (st.get("plan") or {}).get("failChats", [])
            if "lockOk" in st:
                kv.lock_available = st["lockOk"]
            f = st.get("forward") or {"absent": True}
            cur["fwd"] = f
            it = Intake(sc["config"], kv, send, log, None if f.get("absent") else forward,
                        None if st.get("shadow") is False else shadow)
            result, error = None, None
            try:
                op = st["op"]
                if op == "handle":
                    result = it.handle_tradingview(st["body"], st.get("origin"))
                elif op == "retry":
                    result = it.process_retries()
                elif op == "reject":
                    it.note_rejected(st["reason"])
                elif op == "reserve":
                    result = it.reserve(st["body"])
                elif op == "recent":
                    it.remember_recent(st["body"])
                    result = it.get_recent()
                elif op == "deliver":
                    result = it.deliver_raw(st["body"], st["targets"])
            except Exception as e:  # noqa: BLE001
                error = str(e)
            outs.append({**({} if error else {"result": result}), "error": error, "calls": list(rec["calls"]), "logs": list(rec["logs"]),
                         "t": clock.now_ms()})
        got = {"steps": outs, "final": kv.export()}
    finally:
        clock.set_now(None)
    assert same(got, exp, v["id"]) is None
