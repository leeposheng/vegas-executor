"""BingX 請求建構與簽章（對應 exchanges/bingx.js 的純函式部分）。"""
import hashlib
import hmac

from .. import clock
from ..jsnum import js_json, num_str, to_number, to_string, to_string as _s


def build_query_string(pairs):
    return "&".join(f"{k}={_s(v)}" for k, v in pairs if v is not None and v != "")


def sign(query_string, secret):
    return hmac.new(secret.encode(), query_string.encode(), hashlib.sha256).hexdigest()


def build_signed_request(method, path, pairs, cfg, now=None):
    ts = clock.now_ms() if now is None else now
    qs = build_query_string(list(pairs) + [["timestamp", num_str(ts)], ["recvWindow", "5000"]])
    signature = sign(qs, cfg["apiSecret"])
    return {
        "exchange": "bingx", "method": to_string(method).upper(),
        "url": f"{cfg['baseUrl']}{path}?{qs}&signature={signature}",
        "requestPath": path, "headers": {"X-BX-APIKEY": cfg["apiKey"]},
        "body": "", "signedString": qs,
    }


def build_order_pairs(symbol, side, orderQty, clientOrderId, sl, tp):
    stop_loss = js_json({"type": "STOP_MARKET", "stopPrice": to_number(sl), "price": to_number(sl),
                         "workingType": "MARK_PRICE"})
    take_profit = js_json({"type": "TAKE_PROFIT_MARKET", "stopPrice": to_number(tp), "price": to_number(tp),
                           "workingType": "MARK_PRICE"})
    return [
        ["symbol", symbol],
        ["side", "BUY" if side == "long" else "SELL"],
        ["positionSide", "LONG" if side == "long" else "SHORT"],
        ["type", "MARKET"],
        ["quantity", to_string(orderQty)],
        ["clientOrderID", clientOrderId],
        ["stopLoss", stop_loss],
        ["takeProfit", take_profit],
    ]


# 網路層留待第二批（BingX 實盤本來就被設定層擋下）。
PATH_ORDER = "/openApi/swap/v2/trade/order"


class NotImplementedYet(RuntimeError):
    pass


async def place_order(params, cfg, flags):
    pairs = build_order_pairs(params["symbol"], params["side"], params["orderQty"],
                              params["clientOrderId"], params.get("sl"), params.get("tp"))
    req = build_signed_request("POST", PATH_ORDER, pairs, cfg)
    if flags.get("dryRun"):
        return {"sent": False, "request": req, "response": None}
    raise NotImplementedYet("bingx.place_order 尚未實作（第二批）")


async def fetch_ticker(symbol, cfg):
    raise NotImplementedYet("bingx.fetch_ticker 尚未實作（第二批）")


async def fetch_positions(cfg, flags):
    raise NotImplementedYet("bingx.fetch_positions 尚未實作（第二批）")


async def fetch_contract(symbol, cfg):
    raise NotImplementedYet("bingx.fetch_contract 尚未實作（第二批）")


async def ensure_leverage(params, cfg, flags):
    raise NotImplementedYet("bingx.ensure_leverage 尚未實作（第二批）")


async def fetch_positions_history(params, cfg, flags):
    raise NotImplementedYet("bingx.fetch_positions_history 尚未實作（第二批）")


async def fetch_order_by_cl_ord_id(params, cfg, flags):
    raise NotImplementedYet("bingx.fetch_order_by_cl_ord_id 尚未實作（第二批）")


async def preflight(cfg, flags):
    raise NotImplementedYet("bingx.preflight 尚未實作（第二批）")


async def fetch_all_contracts(cfg):
    raise NotImplementedYet("bingx.fetch_all_contracts 尚未實作（第二批）")
