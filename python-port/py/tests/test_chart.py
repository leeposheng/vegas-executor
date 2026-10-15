import pytest

from vegas_executor import chart as C, clock
from vegas_executor.cards import UNDEF
from vegas_executor.jsnum import js_json
from .vec import load, same

V = load("bot_e.json")
T0 = 1758470000000


def by(fn):
    return [x for x in V if x["fn"] == fn]


@pytest.mark.parametrize("v", by("chart_color"), ids=lambda v: v["id"])
def test_color(v):
    assert same(C.to_rgb_color(v["input"].get("raw")), v["expected"], v["id"]) is None


@pytest.mark.parametrize("v", by("chart_split"), ids=lambda v: v["id"])
def test_split(v):
    assert same(C.split_color_pairs(v["input"].get("raw")), v["expected"], v["id"]) is None


@pytest.mark.parametrize("v", by("chart_interval"), ids=lambda v: v["id"])
def test_interval(v):
    tf = v["input"]["tf"]
    assert same(C.chart_interval(UNDEF if tf == "__undef" else tf), v["expected"], v["id"]) is None


def opts_for_compare(props):
    o = C.chart_options(props)
    o.pop("emaName")
    o["emaColors"] = {str(k): x for k, x in o["emaColors"].items()}
    return o


@pytest.mark.parametrize("v", by("chart_opts"), ids=lambda v: v["id"])
def test_opts(v):
    props = {k: x for k, x in v["input"]["props"].items() if x is not None}
    assert same(opts_for_compare(props), v["expected"], v["id"]) is None


@pytest.mark.parametrize("v", by("chart_build"), ids=lambda v: v["id"])
def test_build(v):
    inp = v["input"]
    o = C.chart_options(inp["props"])
    o.update(inp.get("override") or {})
    req = C.build_chart_request(inp["payload"], o)
    assert same(req, v["expected"]["req"], v["id"]) is None
    assert js_json(req) == v["expected"]["body"]


class Rec:
    def __init__(self, plan):
        self.plan, self.calls, self.logs = list(plan), [], []

    def next(self):
        p = self.plan.pop(0) if self.plan else {"status": 200, "body": '{"ok":true}'}
        if p.get("advance"):
            clock.set_now(clock.now_ms() + p["advance"])
        if p.get("throw"):
            raise RuntimeError(p["throw"])
        return p

    def log(self, level, event, details=None):
        self.logs.append({"level": level, "event": event, "details": dict(details or {})})


@pytest.mark.parametrize("v", by("chart_fetch"), ids=lambda v: v["id"])
def test_fetch(v):
    inp, exp = v["input"], v["expected"]
    rec = Rec(inp["plan"])

    def fetch_bin(url, opts):
        rec.calls.append({"url": url, "opts": {**opts, "muteHttpExceptions": True}})
        p = rec.next()
        return p["status"], p["body"].encode("utf-8"), {}

    clock.set_now(T0)
    try:
        ch = C.Chart(inp["props"], fetch_bin, None, rec.log, clock.now_ms)
        blob = ch.fetch_image(inp["payload"])
        t = clock.now_ms()
    finally:
        clock.set_now(None)
    got_blob = None if blob is None else {"__blob": True, "name": blob.name, "len": len(blob.data)}
    got = {"blob": got_blob, "error": None, "calls": rec.calls, "logs": rec.logs, "t": t}
    assert same(got, exp, v["id"]) is None


@pytest.mark.parametrize("v", by("chart_send"), ids=lambda v: v["id"])
def test_send(v):
    inp, exp = v["input"], v["expected"]
    rec = Rec(inp["plan"])

    def fetch_form(url, fields):
        payload = {k: ({"__blob": True, "name": x.name, "len": len(x.data)} if isinstance(x, C.Blob) else x) for k, x in fields}
        rec.calls.append({"url": url, "opts": {"method": "post", "payload": payload, "muteHttpExceptions": True}})
        p = rec.next()
        return p["status"], p["body"]

    ch = C.Chart({"TG_TOKEN": "123:TESTTOKEN"}, None, fetch_form, rec.log)
    got = {"result": ch.send_photo(inp["chatId"], C.Blob(inp["photo"].encode(), "X.png"), inp["caption"], inp.get("markup")),
           "calls": rec.calls}
    assert same(got, exp, v["id"]) is None


def test_multipart_encoding():
    from vegas_executor.botrt import encode_multipart
    b = encode_multipart([("chat_id", "1"), ("caption", "圖"), ("photo", C.Blob(b"\x89PNG", 'a"b.png'))], "BB")
    assert b == (b'--BB\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n1\r\n'
                 b'--BB\r\nContent-Disposition: form-data; name="caption"\r\n\r\n' + "圖".encode() + b'\r\n'
                 b'--BB\r\nContent-Disposition: form-data; name="photo"; filename="a_b.png"\r\nContent-Type: image/png\r\n\r\n'
                 b'\x89PNG\r\n--BB--\r\n')


def test_botrt_uses_chart_for_card(tmp_path):
    """卡片流程：有 CHART_IMG_API_KEY 時走 fetch_bin＋sendPhoto，並帶上圖片檔名。"""
    from vegas_executor.botrt import BotRuntime
    calls = {"bin": [], "form": []}

    def fetch_bin(url, opts):
        calls["bin"].append(url)
        return 200, b"PNG", {}

    def fetch_form(url, fields):
        calls["form"].append((url, [(k, (v.name if isinstance(v, C.Blob) else v)) for k, v in fields]))
        return 200, '{"ok":true,"result":{"message_id":9,"photo":[{"file_id":"f"}]}}'

    env = {"TG_TOKEN": "1:T", "ALLOWED_CHAT_ID": "111", "TRADINGVIEW_WEBHOOK_SECRET": "tv", "TELEGRAM_WEBHOOK_SECRET": "tg",
           "CHART_IMG_API_KEY": "k"}
    rt = BotRuntime({"port": 8080, "webhookSecret": "s", "dataDir": str(tmp_path)}, None, env,
                    fetch_bin=fetch_bin, fetch_form=fetch_form, fetch=lambda *a, **k: (200, "{}", {}))
    blob = rt.chart.fetch_image({"symbol": "BTCUSDT.P", "tf": "15", "side": "long"})
    assert blob.name == "BTCUSDT.P.png" and calls["bin"] == [C.CHART_ENDPOINT]
    sent = rt.fwd.tg_send_photo("111", blob, "cap", None)
    assert sent["message_id"] == 9
    assert calls["form"][0][0] == "https://api.telegram.org/bot1:T/sendPhoto"
    assert calls["form"][0][1] == [("chat_id", "111"), ("caption", "cap"), ("photo", "BTCUSDT.P.png")]
