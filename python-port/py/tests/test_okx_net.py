import asyncio

import pytest

from vegas_executor import clock
from vegas_executor.exchanges import okx
from .vec import load, same

OV = load("okx_net.json")
CFG = {"apiKey": "K", "apiSecret": "S", "passphrase": "P", "baseUrl": "https://www.okx.com"}
SNAKE = {"fetchAccountConfig": "fetch_account_config", "fetchEquity": "fetch_equity",
         "fetchOrderByClOrdId": "fetch_order_by_cl_ord_id", "fetchPositions": "fetch_positions",
         "fetchPositionsHistory": "fetch_positions_history", "ensureLeverage": "ensure_leverage",
         "preflight": "preflight", "fetchAlgoPending": "fetch_algo_pending",
         "verifyProtection": "verify_protection", "placeOrder": "place_order",
         "fetchTicker": "fetch_ticker", "fetchInstrument": "fetch_instrument"}
PUBLIC = ("fetchTicker", "fetchInstrument")


@pytest.mark.parametrize("v", OV, ids=[v["id"] for v in OV])
def test_okx_net(v):
    inp, exp = v["input"], v["expected"]
    queue = list(inp["responses"])
    seen = []

    def pop():
        if not queue:
            raise RuntimeError("no scripted response")
        r = queue.pop(0)
        if r.get("throw"):
            raise RuntimeError(r["throw"])
        return r["status"], ({} if r.get("badJson") else r["json"])

    def transport(method, url, headers, body):
        seen.append({"method": method, "url": url, "headers": headers,
                     "body": None if method == "GET" else body})
        return pop()

    def http_get(url):
        seen.append({"method": "GET", "url": url, "headers": None, "body": None})
        return pop()

    okx.set_transport(transport)
    okx.reset_leverage_cache()
    clock.set_now(inp["now"])
    fn, args, flags = v["fn"], inp["args"], inp["flags"]

    async def call(name, *a):
        f = getattr(okx, SNAKE[name])
        if name in PUBLIC:
            return await f(a[0], CFG, http_get=http_get)
        if name in ("fetchAccountConfig", "fetchEquity", "fetchPositions"):
            return await f(CFG, flags)
        return await f(a[0], CFG, flags)

    async def run():
        res = res2 = threw = None
        try:
            if fn == "ensureLeverage2":
                res = await call("ensureLeverage", args[0])
                res2 = await call("ensureLeverage", args[0])
            elif fn == "ensureLeverageFailThenOk":
                try:
                    await call("ensureLeverage", args[0])
                    res = "unexpected-ok"
                except Exception as e:  # noqa: BLE001
                    res = {"firstThrew": str(e)}
                res2 = await call("ensureLeverage", args[0])
            else:
                res = await call(fn, *args)
        except Exception as e:  # noqa: BLE001
            threw = str(e)
        return res, res2, threw

    try:
        res, res2, threw = asyncio.run(run())
    finally:
        okx.set_transport(None)
        clock.set_now(None)

    assert threw == exp["threw"], f"{v['id']}: threw {threw!r} != {exp['threw']!r}"
    if exp["threw"] is None:
        dd = same(res, exp["result"], "result")
        assert dd is None, f"{v['id']}: {dd}"
        if "result2" in exp and exp["result2"] is not None:
            assert same(res2, exp["result2"]) is None
    if fn in PUBLIC:
        assert [r["url"] for r in seen] == [r["url"] for r in exp["requests"]]
    else:
        dd = same(seen, exp["requests"], "requests")
        assert dd is None, f"{v['id']}: {dd}"
