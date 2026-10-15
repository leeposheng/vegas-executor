import json

import pytest

from vegas_executor import webhook_admin as W
from vegas_executor.webhook import get_config, REQUIRED_GAS
from .vec import load, same

V = load("bot_g.json")
BASE = {"TG_TOKEN": "123:TESTTOKEN", "ALLOWED_CHAT_ID": "111", "TRADINGVIEW_WEBHOOK_SECRET": "tvsecret",
        "TELEGRAM_WEBHOOK_SECRET": "tgsecret", "WEBAPP_URL": "https://example.test/exec"}


def cfg(props):
    return get_config({**BASE, **props}, REQUIRED_GAS)


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "wh_set"], ids=lambda v: v["id"])
def test_set(v):
    i = v["input"]
    url, body = W.set_webhook_request(cfg(i["props"]), i["drop"])
    lines = W.set_webhook_lines(i["resp"]["status"], i["resp"]["body"])
    exp = v["expected"]
    f = exp["fetches"][0]
    assert url == f["url"] and body == f["options"]["payload"]
    assert lines == exp["lines"]


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "wh_diag"], ids=lambda v: v["id"])
def test_diag(v):
    i = v["input"]
    assert W.diagnose_lines(i["resp"]["body"], cfg(i["props"])) == v["expected"]["lines"]


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "wh_tvurl"], ids=lambda v: v["id"])
def test_tvurl(v):
    assert [W.tradingview_url(cfg(v["input"]["props"]))] == v["expected"]["lines"]


def test_cli_commands(tmp_path):
    out, calls = [], []

    def fetch(url, opts):
        calls.append((url, opts))
        return 200, json.dumps({"ok": True, "result": {"url": W.telegram_url(cfg({}))}}), {}
    env = dict(BASE)
    assert W.run("diagnose", env, out.append, fetch) == 0 and "✅" in out[-1]
    assert calls[0][0].endswith("/getWebhookInfo")
    kv = tmp_path / "kv.json"
    kv.write_text(json.dumps({"props": {"TELEGRAM_CHAT_PAUSED": "true", "KEEP": "1"}, "cache": {}}))
    assert W.run("reset-drop", env, out.append, fetch, str(kv)) == 0
    assert json.loads(kv.read_text())["props"] == {"KEEP": "1"}
    assert json.loads(calls[1][1]["payload"])["drop_pending_updates"] is True
    assert W.run("set", env, out.append, fetch) == 0
    assert json.loads(calls[2][1]["payload"])["drop_pending_updates"] is False
    assert W.run("check", {}, out.append) == 2
    assert len(out and W.run("gen-secret", {}, out.append) is not None and out[-1]) == 64
