import pytest

from vegas_executor import clock
from vegas_executor.drift import assess_drift
from vegas_executor.jsnum import fixed_num, to_fixed
from vegas_executor.signal_parse import client_order_id, parse_signal
from vegas_executor.sizing import compute_fixed_margin, compute_size, floor_to_step
from .vec import load, same


def check(v, got):
    exp = v["expected"]
    assert exp.get("ok", True), f"向量預期例外 {exp}"
    d = same(got, exp["value"])
    assert d is None, f"{v['id']}: {d}"


def ids(vs):
    return [v["id"] for v in vs]


V = {n: load(n) for n in ["signal.json", "floor_to_step.json", "compute_size.json", "tofixed.json", "drift.json"]}


def _sig(v):
    i = v["input"]
    return parse_signal(i["raw"], nowMs=i["nowMs"], maxAgeSec=i.get("maxAgeSec"))


@pytest.mark.parametrize("v", V["signal.json"], ids=ids(V["signal.json"]))
def test_signal(v):
    i = v["input"]
    if v["fn"] == "parse_signal":
        got = parse_signal(i["raw"], nowMs=i["nowMs"], maxAgeSec=i.get("maxAgeSec"))
    else:
        got = client_order_id(i["sigId"], i["prefix"])
    check(v, got)


@pytest.mark.parametrize("v", V["floor_to_step.json"], ids=ids(V["floor_to_step.json"]))
def test_floor(v):
    check(v, floor_to_step(v["input"]["value"], v["input"]["step"]))


@pytest.mark.parametrize("v", V["tofixed.json"], ids=ids(V["tofixed.json"]))
def test_tofixed(v):
    check(v, to_fixed(v["input"]["value"], v["input"]["digits"]))


@pytest.mark.parametrize("v", V["compute_size.json"], ids=ids(V["compute_size.json"]))
def test_size(v):
    fn = compute_size if v["fn"] == "compute_size" else compute_fixed_margin
    check(v, fn(v["input"]))


@pytest.mark.parametrize("v", V["drift.json"], ids=ids(V["drift.json"]))
def test_drift(v):
    i = v["input"]
    check(v, assess_drift(i["signal"], i["livePrice"], i["limits"]))


from vegas_executor import instruments, symbols
from vegas_executor.notify import render_decision

M = load("mapping.json")
N = load("notify.json")


@pytest.mark.parametrize("v", M, ids=ids(M))
def test_mapping(v):
    i = v["input"]
    fn = v["fn"]
    if fn == "symbol_maps":
        got = {"instId": instruments.to_inst_id(i["tv"]), "bingx": instruments.to_bingx_symbol(i["tv"])}
    elif fn == "to_tv_symbol":
        got = instruments.to_tv_symbol(i["instId"])
    elif fn == "symbols_resolve_static":
        symbols.reset()
        got = symbols.resolve(i["tv"], i["exchange"])
    elif fn == "symbols_install":
        got = symbols.install(allowed=i["allowed"], specs=i["specs"])
    elif fn == "symbols_resolve_runtime":
        got = symbols.resolve(i["tv"], i["exchange"])
    else:
        raise AssertionError(fn)
    check(v, got)


@pytest.mark.parametrize("v", N, ids=ids(N))
def test_notify(v):
    check(v, render_decision(v["input"]))


from vegas_executor.exchanges import bingx, okx

X = load("exchange_requests.json")


@pytest.mark.parametrize("v", X, ids=ids(X))
def test_exchange(v):
    i = v["input"]
    fn = v["fn"]
    if fn == "okx_build_signed_request":
        got = okx.build_signed_request(i["method"], i["requestPath"], i["cfg"], demo=i["demo"], now=i["now"], body=i.get("body"))
    elif fn == "okx_build_order_body":
        got = okx.build_order_body(i["instId"], i["side"], i["orderQty"], i["clOrdId"], i["tdMode"], i["sl"], i["tp"], i.get("posMode"))
    elif fn == "bingx_build_query_string":
        got = bingx.build_query_string(i["pairs"])
    elif fn == "bingx_sign":
        got = bingx.sign(i["qs"], i["secret"])
    elif fn == "bingx_build_signed_request":
        got = bingx.build_signed_request(i["method"], i["path"], i["pairs"], i["cfg"], now=i["now"])
    elif fn == "bingx_build_order_pairs":
        got = bingx.build_order_pairs(i["symbol"], i["side"], i["orderQty"], i["clientOrderId"], i["sl"], i["tp"])
    else:
        raise AssertionError(fn)
    check(v, got)
