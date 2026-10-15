import json

import pytest

from vegas_executor import clock
from vegas_executor.intake import KV
from vegas_executor.webhook import REQUIRED_GAS, Webhook
from .vec import load, same

V = [x for x in load("intake.json") if x["fn"] == "do_post"]


@pytest.mark.parametrize("v", V, ids=lambda v: v["id"])
def test_do_post(v):
    sc, exp = v["input"], v["expected"]
    t = 1758470000000
    clock.set_now(t)
    rec = {"calls": [], "logs": []}
    kv = KV(now=clock.now_ms)
    kv.seed(sc["props"])

    def send_factory(config):
        def send(chat_id, text, thread_id):
            rec["calls"].append({"fn": "send", "chatId": str(chat_id), "text": text, "threadId": thread_id})
        return send

    def forward(text, key):
        rec["calls"].append({"fn": "forward", "key": key})
        return {"cardSent": True, "broadcastSent": True}

    def telegram(body, config):
        rec["calls"].append({"fn": "telegram", "body": body, "cfg": config})
        return "tg-handled"

    log = lambda lv, ev, d: rec["logs"].append({"level": lv, "event": ev, "details": json.loads(json.dumps(d))})  # noqa: E731
    wh = Webhook(lambda: sc["props"], kv, send_factory, log, forward, None, telegram, required=REQUIRED_GAS)
    try:
        outs = []
        for st in sc["steps"]:
            t += st.get("dt") or 0
            clock.set_now(t)
            rec["calls"].clear(); rec["logs"].clear()
            e = st["e"]
            text = wh.do_post(e.get("parameter"), (e.get("postData") or {}).get("contents"))
            outs.append({"result": text, "error": None, "calls": list(rec["calls"]), "logs": list(rec["logs"])})
        got = {"steps": outs, "final": kv.export()}
    finally:
        clock.set_now(None)
    assert same(got, exp, v["id"]) is None
