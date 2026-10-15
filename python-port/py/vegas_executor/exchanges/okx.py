"""OKX 請求建構與簽章（對應 exchanges/okx.js 的純函式部分）。網路呼叫於階段 4。"""
import asyncio
import base64
import hashlib
import hmac
import json as _json
import math as _math
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from .. import clock
from ..jsnum import js_json, num_str, to_number, to_string, truthy


def okx_timestamp(now=None) -> str:
    ms = clock.now_ms() if now is None else int(now)
    dt = datetime.fromtimestamp(ms // 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms % 1000:03d}Z"


def sign(prehash: str, secret: str) -> str:
    return base64.b64encode(hmac.new(secret.encode(), prehash.encode(), hashlib.sha256).digest()).decode()


def build_signed_request(method, requestPath, cfg, demo=False, now=None, body=None):
    upper = to_string(method).upper()
    body_str = "" if body is None else js_json(body)
    ts = okx_timestamp(now)
    prehash = ts + upper + requestPath + body_str
    headers = {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": cfg["apiKey"],
        "OK-ACCESS-SIGN": sign(prehash, cfg["apiSecret"]),
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": cfg["passphrase"],
    }
    if demo:
        headers["x-simulated-trading"] = "1"
    return {
        "exchange": "okx", "method": upper, "url": cfg["baseUrl"] + requestPath,
        "requestPath": requestPath, "headers": headers, "body": body_str,
        "prehashShape": f"{ts}|{upper}|{requestPath}|{'body(' + str(len(body_str)) + ')' if body_str else ''}",
    }


def build_order_body(instId, side, orderQty, clOrdId, tdMode, sl, tp, posMode=None):
    body = {
        "instId": instId,
        "tdMode": tdMode,
        "side": "buy" if side == "long" else "sell",
        "ordType": "market",
        "sz": num_str(orderQty) if not isinstance(orderQty, str) else orderQty,
        "clOrdId": clOrdId,
        "attachAlgoOrds": [{
            "slTriggerPx": to_string(sl),
            "slOrdPx": "-1",
            "tpTriggerPx": to_string(tp),
            "tpOrdPx": "-1",
        }],
    }
    if posMode == "long_short_mode":
        body["posSide"] = "long" if side == "long" else "short"
    return body


# ================================================================
# 網路層
# 簽章請求經由可注入的 transport 送出（測試以假交易所取代，永不連網）；
# 預設 transport 用標準庫 urllib（在執行緒中，不阻塞事件迴圈）。
# 錯誤處理逐字對應 Node 版：HTTP 200 不代表成功，必須看 code／sCode。
# ================================================================
PATH_ORDER = "/api/v5/trade/order"
PATH_ACCOUNT_CONFIG = "/api/v5/account/config"
PATH_BALANCE = "/api/v5/account/balance"
PATH_SET_LEVERAGE = "/api/v5/account/set-leverage"
PATH_POSITIONS = "/api/v5/account/positions"
PATH_POSITIONS_HISTORY = "/api/v5/account/positions-history"
PATH_ALGO_PENDING = "/api/v5/trade/orders-algo-pending"
REQUEST_TIMEOUT_S = 15
# OKX 前面有 Cloudflare：urllib 預設的 "Python-urllib/3.x" 會被直接 403（沒有 JSON 本文）。
# Node 的 fetch 自帶瀏覽器風格的 UA 所以沒事；這裡明確帶上。簽章不涵蓋此標頭。
USER_AGENT = "Mozilla/5.0 (compatible; vegas-executor/0.1; +python)"

ACCT_LEVEL = {
    "1": {"name": "現貨模式", "canSwap": False},
    "2": {"name": "合約模式", "canSwap": True},
    "3": {"name": "跨幣種保證金模式", "canSwap": True},
    "4": {"name": "投資組合保證金模式", "canSwap": True},
}

_HINTS = {
    "50101": "API Key 與目前環境不符。常見三種：(1) 把模擬盤金鑰用在實盤（或相反）；"
             "(2) 帳戶屬於其他站點，要改 OKX_BASE_URL（歐洲 https://eea.okx.com、美國 https://us.okx.com、"
             "其他 https://www.okx.com）；(3) 環境變數還留著舊的金鑰。",
    "50102": "時間戳過期。主機時鐘與 OKX 相差超過 30 秒，請確認機器有啟用 NTP 校時。",
    "50103": "缺少 OK-ACCESS-KEY 標頭。",
    "50104": "缺少 OK-ACCESS-PASSPHRASE 標頭。",
    "50105": "Passphrase 錯誤。它是建立金鑰時你自己輸入的那一串，不是 Secret Key。",
    "50111": "API Key 無效。最常見原因是把實盤金鑰用在模擬盤（或相反）—— 兩者完全不通用。",
    "50113": "簽章驗證失敗。prehash 必須是 timestamp+METHOD+requestPath+body，"
             "且 requestPath 要與實際送出的完全一致（含 query string）。",
    "50114": "無效的授權，通常是模擬盤標頭 x-simulated-trading 漏掉或多加。",
    "51000": "參數錯誤。請看 sMsg 指出的欄位。",
    "51008": "保證金不足。模擬盤可在 OKX 介面重置模擬資金。",
    "51010": "目前帳戶模式不支援此操作 —— 永續合約需要「合約模式」以上。"
             "請到 OKX 網頁或 App 切換帳戶模式，這個設定 API 改不了。",
    "51011": "重複的 clOrdId。這代表冪等保護生效，同一筆訊號已經下過單了。",
    "51020": "下單量低於最小下單量（minSz）。",
    "51116": "委託價格超出允許範圍。",
    "51121": "下單量必須是 lotSz 的整數倍。",
    "59000": "有持倉或掛單時不能切換設定，請先平倉或撤單。",
    "50011": "觸發限流，請降低請求頻率。",
}


def explain_okx_error(code, sCode, msg=None):
    c = to_string(sCode if (truthy(sCode) and sCode != "0") else (code if truthy(code) else ""))
    return _HINTS.get(c)


def _urllib_transport(method, url, headers, body):
    import urllib.error
    import urllib.request
    data = body.encode("utf-8") if (body and method != "GET") else None
    hdr = {"User-Agent": USER_AGENT, "Accept": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
            raw, status = r.read(), r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read(), e.code
    return status, _parse_json(raw)


def _parse_json(raw):
    try:
        return _json.loads(raw or b"{}")
    except Exception:  # noqa: BLE001
        # 非 JSON（多半是 WAF／代理的 HTML 頁）：把開頭帶進錯誤訊息，否則只會看到 msg=(無)
        return {"msg": "非 JSON 回應：" + raw[:120].decode("utf-8", errors="replace").replace("\n", " ")}


_transport = None   # 測試注入：callable(method, url, headers, body) -> (status, json)；可為 sync 或 async


def set_transport(fn):
    global _transport
    _transport = fn


def read_okx_response(status, js, what):
    js = js if isinstance(js, dict) else {}
    data = js.get("data")
    detail = (data[0] if (isinstance(data, list) and data) else None) or {}
    detail = detail if isinstance(detail, dict) else {}
    failed = (not (200 <= status < 300)) or js.get("code") != "0" \
        or ("sCode" in detail and detail["sCode"] != "0")
    if failed:
        hint = explain_okx_error(js.get("code"), detail.get("sCode"), js.get("msg"))
        raise RuntimeError(
            f"OKX {what} 失敗 HTTP {status} code={js.get('code') if truthy(js.get('code')) else '?'}"
            + (f" sCode={detail['sCode']}" if truthy(detail.get("sCode")) else "")
            + f" msg={detail.get('sMsg') if truthy(detail.get('sMsg')) else (js.get('msg') if truthy(js.get('msg')) else '(無)')}"
            + (f"\n  → {hint}" if hint else ""))
    return js


async def send_signed(req, what):
    fn = _transport
    if fn is None:
        status, js = await asyncio.to_thread(_urllib_transport, req["method"], req["url"], req["headers"], req["body"])
    else:
        r = fn(req["method"], req["url"], req["headers"], req["body"])
        status, js = await r if asyncio.iscoroutine(r) else r
    return read_okx_response(status, js, what)


def _pass(o, *keys):
    """原樣帶過的欄位：缺的不出現（JS 的 undefined 在 JSON 中會消失）。"""
    return {k: o[k] for k in keys if k in o}


def _first(js):
    d = js.get("data")
    return (d[0] if (isinstance(d, list) and d) else None) or {}


def _num_or_none(v):
    n = to_number(v)
    return None if (_math.isnan(n) or n == 0) else n


def _signed_get(path, cfg, flags):
    return build_signed_request("GET", path, cfg, demo=bool((flags or {}).get("demo")))


PATH_TICKER = "/api/v5/market/ticker"
PATH_INSTRUMENTS = "/api/v5/public/instruments"


def _http_get(url, timeout=10):
    """公開端點 GET。回傳 (http_status, json)；網路層失敗才拋例外。"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, _parse_json(r.read())
    except urllib.error.HTTPError as e:
        return e.code, _parse_json(e.read())


async def fetch_ticker(instId, cfg, http_get=None):
    """現價（公開端點，不需簽章）。取 last 而非標記價：市價單成交在盤口。"""
    url = f"{cfg['baseUrl']}{PATH_TICKER}?instId={urllib.parse.quote(instId, safe='')}"
    status, js = await asyncio.to_thread(http_get or _http_get, url)
    js = read_okx_response(status, js, f"查詢 {instId} 現價")
    detail = _first(js)
    last = to_number(detail.get("last"))
    if not _math.isfinite(last) or last <= 0:
        raise RuntimeError(f"OKX 回傳的 {instId} 現價無法解析")
    ask, bid, ts = to_number(detail.get("askPx")), to_number(detail.get("bidPx")), to_number(detail.get("ts"))
    return {"instId": detail.get("instId") or instId, "last": last,
            "askPx": ask if (not _math.isnan(ask) and ask != 0) else None,
            "bidPx": bid if (not _math.isnan(bid) and bid != 0) else None,
            "ts": ts if (not _math.isnan(ts) and ts != 0) else clock.now_ms()}



async def fetch_instrument(instId, cfg, http_get=None):
    url = f"{cfg['baseUrl']}{PATH_INSTRUMENTS}?instType=SWAP&instId={urllib.parse.quote(instId, safe='')}"
    status, js = await asyncio.to_thread(http_get or _http_get, url)
    if status != 200:
        raise RuntimeError(f"OKX instruments HTTP {status}")
    if js.get("code") != "0" or not js.get("data"):
        raise RuntimeError("OKX instruments 回應異常：" + _json.dumps(js, ensure_ascii=False, separators=(",", ":"))[:200])
    d = js["data"][0]
    return {"instId": d.get("instId"), "ctVal": to_number(d.get("ctVal")), "lotSz": to_number(d.get("lotSz")),
            "minSz": to_number(d.get("minSz")), "tickSz": to_number(d.get("tickSz"))}


async def fetch_account_config(cfg, flags):
    js = await send_signed(_signed_get(PATH_ACCOUNT_CONFIG, cfg, flags), "查詢帳戶設定")
    d = _first(js)
    lv = to_string(d.get("acctLv") if truthy(d.get("acctLv")) else "")
    info = ACCT_LEVEL.get(lv) or {}
    return {
        "acctLv": lv,
        "acctLvName": info.get("name") or f"未知({to_string(d['acctLv']) if 'acctLv' in d else 'undefined'})",
        "canTradeSwap": bool(info.get("canSwap")),
        "posMode": to_string(d.get("posMode") if truthy(d.get("posMode")) else ""),
        "uid": to_string(d["uid"])[-6:] if truthy(d.get("uid")) else None,
    }


async def fetch_equity(cfg, flags):
    js = await send_signed(_signed_get(PATH_BALANCE + "?ccy=USDT", cfg, flags), "查詢權益")
    acct = _first(js)
    usdt = next((x for x in (acct.get("details") or []) if x.get("ccy") == "USDT"), None) or {}
    eq, total = to_number(usdt.get("eq")), to_number(acct.get("totalEq"))
    use_eq = _math.isfinite(eq) and eq > 0
    value = eq if use_eq else total
    if not _math.isfinite(value) or value <= 0:
        raise RuntimeError("OKX 回傳的權益無法解析，請確認帳戶內有 USDT 餘額")
    return {"equityUsdt": value, "source": "USDT.eq" if use_eq else "totalEq",
            "availEq": _num_or_none(usdt.get("availEq"))}


async def fetch_order_by_cl_ord_id(params, cfg, flags):
    path = (PATH_ORDER + "?instId=" + urllib.parse.quote(params["instId"], safe="")
            + "&clOrdId=" + urllib.parse.quote(params["clOrdId"], safe=""))
    try:
        js = await send_signed(_signed_get(path, cfg, flags), "反查訂單")
    except RuntimeError as err:
        if "51603" in str(err):
            return None        # 確定沒送達，與「查不到」不同
        raise
    d = js.get("data")
    o = d[0] if (isinstance(d, list) and d) else None
    if not o:
        return None
    fs = to_number(o.get("accFillSz"))
    return {**_pass(o, "ordId", "clOrdId", "state"),
            "filledSz": 0 if (_math.isnan(fs) or fs == 0) else fs, "avgPx": _num_or_none(o.get("avgPx")),
            **_pass(o, "side", "posSide"), "createdAtMs": _num_or_none(o.get("cTime"))}


async def fetch_positions(cfg, flags):
    js = await send_signed(_signed_get(PATH_POSITIONS + "?instType=SWAP", cfg, flags), "查詢持倉")
    return [{**_pass(p, "instId", "posSide"), "pos": to_number(p.get("pos")),
             "avgPx": to_number(p.get("avgPx")), "upl": to_number(p.get("upl")), **_pass(p, "mgnMode"),
             "lever": to_number(p.get("lever"))}
            for p in (js.get("data") or []) if to_number(p.get("pos")) != 0]


async def fetch_positions_history(params, cfg, flags):
    inst_id, after_ms = (params or {}).get("instId"), (params or {}).get("afterMs")
    path = PATH_POSITIONS_HISTORY + "?instType=SWAP&limit=20"
    if inst_id:
        path += "&instId=" + urllib.parse.quote(inst_id, safe="")
    js = await send_signed(_signed_get(path, cfg, flags), "查詢平倉紀錄")
    out = [{**_pass(p, "instId", "posSide"),
            "openAvgPx": to_number(p.get("openAvgPx")), "closeAvgPx": to_number(p.get("closeAvgPx")),
            "realizedPnl": to_number(p.get("realizedPnl")), "pnl": to_number(p.get("pnl")),
            "fee": to_number(p.get("fee")), "fundingFee": to_number(p.get("fundingFee")),
            "closeType": to_string(p.get("type") if truthy(p.get("type")) else ""),
            "openedAtMs": _num_or_none(p.get("cTime")), "closedAtMs": _num_or_none(p.get("uTime")),
            **_pass(p, "posId")} for p in (js.get("data") or [])]
    return [p for p in out if (not truthy(after_ms)) or (not p["closedAtMs"]) or p["closedAtMs"] >= after_ms]


async def set_leverage(params, cfg, flags):
    body = {"instId": params["instId"], "lever": to_string(params["lever"]), "mgnMode": params.get("mgnMode")}
    if params.get("posSide"):
        body["posSide"] = params["posSide"]
    req = build_signed_request("POST", PATH_SET_LEVERAGE, cfg, demo=bool((flags or {}).get("demo")), body=body)
    return await send_signed(req, f"設定 {params['instId']} 槓桿")


_leverage_done = set()


def reset_leverage_cache():
    _leverage_done.clear()


async def ensure_leverage(params, cfg, flags):
    inst_id, leverage = params["instId"], params.get("leverage")
    td_mode, pos_mode = params.get("tdMode"), params.get("posMode")
    if not truthy(leverage):
        return {"skipped": "未設定槓桿"}
    key = f"{inst_id}|{to_string(td_mode)}|{num_str(leverage)}"
    if key in _leverage_done:
        return {"cached": True}
    sides = ["long", "short"] if (td_mode == "isolated" and pos_mode == "long_short_mode") else [None]
    for side in sides:
        await set_leverage({"instId": inst_id, "lever": leverage, "mgnMode": td_mode, "posSide": side}, cfg, flags)
    _leverage_done.add(key)
    return {"set": True, "sides": len(sides)}


async def preflight(params, cfg, flags):
    report = {"ok": True, "warnings": [], "errors": [], "instruments": {}}
    account = await fetch_account_config(cfg, flags)
    report["account"] = account
    if not account["canTradeSwap"]:
        report["ok"] = False
        report["errors"].append(f"帳戶模式為「{account['acctLvName']}」，不能交易永續合約。"
                                "請到 OKX 網頁或 App 改成「合約模式」以上 —— 這個設定 API 改不了。")
    if account["posMode"] == "long_short_mode":
        report["warnings"].append("持倉模式為「開平倉模式（雙向）」，下單會帶 posSide。"
                                  "若非刻意設定，建議改為「買賣模式（單向）」，邏輯較單純。")
    try:
        report["equity"] = await fetch_equity(cfg, flags)
    except Exception as err:  # noqa: BLE001  每一項各自 try：一次把所有問題列出來
        report["ok"] = False
        report["errors"].append("查詢權益失敗：" + str(err))
    live_specs = params.get("liveSpecs") or {}
    static = params.get("staticSpecs") or {}
    for inst_id in params.get("instIds") or []:
        live = live_specs.get(inst_id)
        if not live:
            continue
        report["instruments"][inst_id] = live
        stat = static.get(inst_id)
        if not stat:
            continue
        for field in ("ctVal", "lotSz", "minSz"):
            if to_number(stat.get(field)) != to_number(live.get(field)):
                report["warnings"].append(
                    f"{inst_id} 的 {field} 不一致：靜態表 {stat.get(field)}，交易所 {live.get(field)}。"
                    "請更新 symbols.js，否則倉位會以錯誤的倍率計算。")
    ids = params.get("instIds") or []
    if params.get("leverage") and params.get("verifyLeverage") and ids:
        try:
            await ensure_leverage({"instId": ids[0], "leverage": params["leverage"], "tdMode": params.get("tdMode"),
                                   "posMode": account["posMode"]}, cfg, flags)
            report["leverageVerifiedOn"] = ids[0]
        except Exception as err:  # noqa: BLE001
            report["ok"] = False
            report["errors"].append(f"{ids[0]}：{err}")
    return report


async def fetch_algo_pending(params, cfg, flags):
    inst_id = (params or {}).get("instId")
    out = []
    for ord_type in ("oco", "conditional"):
        path = PATH_ALGO_PENDING + "?ordType=" + ord_type
        if inst_id:
            path += "&instId=" + urllib.parse.quote(inst_id, safe="")
        js = await send_signed(_signed_get(path, cfg, flags), "查詢保護單")
        for a in js.get("data") or []:
            out.append({**_pass(a, "algoId", "instId", "ordType", "state"),
                        "slTriggerPx": to_number(a["slTriggerPx"]) if truthy(a.get("slTriggerPx")) else None,
                        "tpTriggerPx": to_number(a["tpTriggerPx"]) if truthy(a.get("tpTriggerPx")) else None,
                        "sz": to_number(a["sz"]) if truthy(a.get("sz")) else None,
                        "posSide": a.get("posSide") if truthy(a.get("posSide")) else ""})
    return out


async def verify_protection(params, cfg, flags):
    inst_id, sl = (params or {}).get("instId"), (params or {}).get("sl")
    lst = await fetch_algo_pending({"instId": inst_id}, cfg, flags)
    mine = [a for a in lst if a["instId"] == inst_id]
    has_sl = any(a["slTriggerPx"] is not None and a["slTriggerPx"] > 0 for a in mine)
    has_tp = any(a["tpTriggerPx"] is not None and a["tpTriggerPx"] > 0 for a in mine)
    note = ""
    if has_sl and truthy(sl):
        slf = to_number(sl)
        near = any(truthy(a["slTriggerPx"]) and abs(a["slTriggerPx"] - slf) / slf < 0.005 for a in mine)
        if not near:
            note = f"交易所有止損，但觸發價與這筆訊號的 {to_string(sl)} 差超過 0.5%"
    return {"ok": has_sl, "hasSl": has_sl, "hasTp": has_tp, "found": len(mine), "orders": mine,
            "note": note or ("" if has_sl else "交易所查不到這個標的的止損單")}


async def place_order(params, cfg, flags):
    body = build_order_body(params["instId"], params["side"], params["orderQty"], params["clOrdId"],
                            params["tdMode"], params.get("sl"), params.get("tp"), params.get("posMode"))
    req = build_signed_request("POST", PATH_ORDER, cfg, demo=bool(flags.get("demo")), body=body)
    if flags.get("dryRun"):
        return {"sent": False, "request": req, "response": None}
    js = await send_signed(req, "下單")
    return {"sent": True, "request": req, "response": js}
