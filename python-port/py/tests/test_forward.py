import json

import pytest

from vegas_executor import clock
from vegas_executor.forward import Forwarder
from vegas_executor.intake import KV
from .vec import load, same

V = load("bot_b.json")
FULL = {"TG_TOKEN": "123:TESTTOKEN", "ALLOWED_CHAT_ID": "111", "TRADINGVIEW_WEBHOOK_SECRET": "tv", "TELEGRAM_WEBHOOK_SECRET": "tg",
        "WEBAPP_URL": "https://x", "EXECUTOR_URL": "https://exec.example.com/health", "EXECUTOR_WEBHOOK_SECRET": "sec"}
T0 = 1758470000000


def mkprops(extra, seed=None):
    p = {**FULL, **(extra or {})}
    for k, v in (seed or {}).items():
        p[k] = v if isinstance(v, str) else json.dumps(v, separators=(",", ":"), ensure_ascii=False)
    return p


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "bops"], ids=lambda v: v["id"])
def test_ops(v):
    kv = KV()
    kv.seed(v["input"]["props"])
    f = Forwarder(kv, None, None, None, None, None)
    got = {"chat": f.broadcast_chat_id(), "thread": f.broadcast_thread_id(), "ids": f.operator_ids(),
           "ops": [f.is_operator(u) for u in v["input"]["users"]]}
    assert same(got, v["expected"], v["id"]) is None


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "bflow"], ids=lambda v: v["id"])
def test_flow(v):
    sc, exp = v["input"], v["expected"]
    clock.set_now(T0)
    rec = {"calls": [], "logs": []}
    kv = KV(now=clock.now_ms)
    kv.seed(mkprops(sc.get("props")))
    seq = list(sc.get("tgSeq") or [])

    def post(payload, cfg):
        rec["calls"].append({"fn": "post", "payload": json.loads(json.dumps(payload))})
        return json.loads(json.dumps(sc["post"]))

    def chart(payload):
        rec["calls"].append({"fn": "chart", "symbol": payload["symbol"]})
        return {"blob": True} if sc.get("chart") else None

    def send_photo(chat_id, blob, caption, markup):
        rec["calls"].append({"fn": "sendPhoto", "chatId": str(chat_id), "caption": caption, "markup": markup or None})
        return {"photo": [{"file_id": "small"}, {"file_id": "FILE1"}]} if "photo" not in sc else sc["photo"]

    def tg_api(method, body):
        rec["calls"].append({"fn": "tgApi", "method": method, "body": json.loads(json.dumps(body))})
        return seq.pop(0) if seq else {"message_id": 1}

    def log(level, event, details):
        rec["logs"].append({"level": level, "event": event, "details": json.loads(json.dumps(details))})

    f = Forwarder(kv, post, tg_api, send_photo, chart, log)
    try:
        outs = []
        for st in sc["steps"]:
            rec["calls"].clear(); rec["logs"].clear()
            result, error = None, None
            try:
                result = f.forward_to_executor(st["text"], st["key"])
            except Exception as e:  # noqa: BLE001
                error = str(e)
            outs.append({**({} if error else {"result": result}), "error": error, "calls": list(rec["calls"]), "logs": list(rec["logs"])})
        got = {"steps": outs, "final": kv.export()}
    finally:
        clock.set_now(None)
    assert same(got, exp, v["id"]) is None


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "bretry"], ids=lambda v: v["id"])
def test_retry(v):
    sc, exp = v["input"], v["expected"]
    t = {"now": T0}
    clock.set_now(T0)
    rec = {"calls": [], "logs": []}
    kv = KV(now=clock.now_ms)
    kv.seed(mkprops(sc.get("props"), sc.get("seedProps")))
    seq = list(sc.get("postSeq") or [])

    def post(payload, cfg):
        rec["calls"].append({"fn": "post", "sigId": payload["sig_id"]})
        return json.loads(json.dumps(seq.pop(0) if seq else {"ok": True, "decision": "placed", "reasons": []}))

    def log(level, event, details):
        rec["logs"].append({"level": level, "event": event, "details": json.loads(json.dumps(details))})

    f = Forwarder(kv, post, None, None, None, log)
    try:
        outs = []
        for st in sc["steps"]:
            t["now"] += st.get("dt") or 0
            clock.set_now(t["now"])
            rec["calls"].clear(); rec["logs"].clear()
            if "lockOk" in st:
                f.lock_available = st["lockOk"]
            result, error = None, None
            try:
                if st["op"] == "enqueue":
                    result = f.enqueue_retry(st["payload"], st["reason"])
                else:
                    f.flush_queue()
            except Exception as e:  # noqa: BLE001
                error = str(e)
            outs.append({"result": result, "error": error, "calls": list(rec["calls"]), "logs": list(rec["logs"]), "t": t["now"]})
        got = {"steps": outs, "final": kv.export()}
    finally:
        clock.set_now(None)
    assert same(got, exp, v["id"]) is None
