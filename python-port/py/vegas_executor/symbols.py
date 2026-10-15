"""標的白名單與規格解析（對應 symbols.js）。"""
from . import instruments
from .jsnum import to_string, trim

MAP = {
    "BTCUSDT.P": {"okx": {"instId": "BTC-USDT-SWAP", "ctVal": 0.01, "lotSz": 0.01, "minSz": 0.01},
                  "bingx": {"symbol": "BTC-USDT", "stepSize": 0.0001, "minQty": 0.0001}},
    "ETHUSDT.P": {"okx": {"instId": "ETH-USDT-SWAP", "ctVal": 0.1, "lotSz": 0.01, "minSz": 0.01},
                  "bingx": {"symbol": "ETH-USDT", "stepSize": 0.01, "minQty": 0.01}},
    "SOLUSDT.P": {"okx": {"instId": "SOL-USDT-SWAP", "ctVal": 1, "lotSz": 0.01, "minSz": 0.01},
                  "bingx": {"symbol": "SOL-USDT", "stepSize": 0.01, "minQty": 0.01}},
    "LINKUSDT.P": {"okx": {"instId": "LINK-USDT-SWAP", "ctVal": 1, "lotSz": 0.1, "minSz": 0.1},
                   "bingx": {"symbol": "LINK-USDT", "stepSize": 0.01, "minQty": 0.01}},
    "ZECUSDT.P": {"okx": {"instId": "ZEC-USDT-SWAP", "ctVal": 0.01, "lotSz": 1, "minSz": 1}},
}

_runtime = None


def reset():
    global _runtime
    _runtime = None


def install(allowed=None, specs=None, bingxSpecs=None):
    global _runtime
    out_map, missing, missing_bx = {}, [], []
    for raw in allowed or []:
        tv = trim(to_string(raw)).upper()
        if not tv:
            continue
        inst_id = instruments.to_inst_id(tv)
        if not inst_id:
            missing.append(tv + "（代碼格式不是 XXXUSDT.P）")
            continue
        live = specs.get(inst_id) if specs else None
        fallback = (MAP.get(tv) or {}).get("okx")
        entry = None
        if live:
            entry = {"okx": dict(live), "source": "exchange"}
        elif fallback:
            entry = {"okx": dict(fallback), "source": "static"}
        if not entry:
            missing.append(tv)
            continue
        bx = instruments.to_bingx_symbol(tv)
        bx_live = bingxSpecs.get(bx) if (bx and bingxSpecs) else None
        bx_fb = (MAP.get(tv) or {}).get("bingx")
        if bx_live:
            entry["bingx"] = dict(bx_live)
        elif bx_fb:
            entry["bingx"] = dict(bx_fb)
        else:
            missing_bx.append(tv)
        out_map[tv] = entry
    _runtime = out_map
    return {"installed": list(out_map.keys()), "missing": missing, "missingBingx": missing_bx}


def resolve(tv_symbol, exchange):
    tv = trim(to_string(tv_symbol)).upper()
    entry = _runtime.get(tv) if _runtime is not None else MAP.get(tv)
    if not entry:
        return {"ok": False, "error": f"代碼 {to_string(tv_symbol)} 不在白名單內，拒絕下單"}
    spec = entry.get(exchange)
    if not spec:
        return {"ok": False, "error": f"代碼 {to_string(tv_symbol)} 未設定 {exchange} 的對應"}
    return {"ok": True, "spec": {"tvSymbol": tv_symbol, **spec}}


def list_supported():
    return list((_runtime if _runtime is not None else MAP).keys())


def spec_source(tv_symbol):
    e = _runtime.get(trim(to_string(tv_symbol)).upper()) if _runtime is not None else None
    return e["source"] if e else "static"
