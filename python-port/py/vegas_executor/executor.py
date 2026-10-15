"""主流程編排（對應 executor.js）。

buildPlan（第 1–5 步，純計算）與 placeFromPlan（第 6–7 步，動到錢）分開；
handle_signal / confirm_signal 共用同一條序列化佇列 order_gate。
ctx 為 dict：{config, store, now?, exchange?, suppressNotify?}。
"""
import re

from . import clock, notify, risk as risk_mod, symbols
from .drift import assess_drift
from .equity import get_equity
from .exchanges import bingx, okx
from .gate import Gate, GateError
from .jsnum import js_floor, num_str, to_fixed, to_number, truthy
from .signal_parse import client_order_id, parse_signal
from .sizing import compute_fixed_margin, compute_size
from .store import iso

order_gate = Gate(maxWaitMs=20000, maxRunMs=30000)


def _now(ctx):
    return (ctx or {}).get("now") or clock.now_ms()


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and abs(x) != float("inf")


# ================================================================
# 第 1–5 步
# ================================================================
async def build_plan(raw_payload, ctx):
    config, store = ctx["config"], ctx["store"]
    now = _now(ctx)
    exchange = ctx.get("exchange") or config["primaryExchange"]

    result = {"at": iso(now), "decision": "rejected", "stage": "parse", "sigId": None, "reasons": []}

    parsed = parse_signal(raw_payload, nowMs=now, maxAgeSec=config["risk"].get("maxSignalAgeSec"))
    if not parsed["ok"]:
        result["reasons"] = parsed["errors"]
        return {"ok": False, "result": result}
    signal = parsed["signal"]
    result["sigId"] = signal["sigId"]
    result["signal"] = signal

    result["stage"] = "risk"
    risk_result = risk_mod.evaluate(signal, store, config["risk"], exchange)
    result["gates"] = risk_result["gates"]
    result["riskSummary"] = risk_mod.summarise(risk_result)

    over_limit = None if risk_result["passed"] else risk_mod.overflow_eligible(
        risk_result, store, config["risk"], exchange)
    if over_limit:
        result["overLimit"] = over_limit

    addon_check = None if (risk_result["passed"] or over_limit) else risk_mod.addon_eligible(
        risk_result, store, config["risk"], exchange, signal)
    addon_candidate = addon_check if (addon_check and addon_check["ok"]) else None

    if not risk_result["passed"] and not over_limit and not addon_candidate:
        result["reasons"] = list(risk_result["reasons"]) + (
            [addon_check["why"]] if (addon_check and not addon_check["ok"]) else [])
        blocked = any(g["name"] == "idempotency" and not g["passed"] for g in risk_result["gates"])
        if not blocked:
            store.mark_processed(signal["sigId"], "rejected", "；".join(result["reasons"]), exchange)
        return {"ok": False, "result": result}

    result["stage"] = "symbol"
    mapped = symbols.resolve(signal["symbol"], exchange)
    if not mapped["ok"]:
        result["reasons"] = [mapped["error"]]
        store.mark_processed(signal["sigId"], "rejected", mapped["error"], exchange)
        return {"ok": False, "result": result}
    spec = mapped["spec"]
    result["spec"] = spec

    add_on = None
    if addon_candidate:
        live = await live_base_position(exchange, spec, signal, config)
        if not live["ok"]:
            result["reasons"] = list(risk_result["reasons"]) + [live["why"]]
            store.mark_processed(signal["sigId"], "rejected", "；".join(result["reasons"]), exchange)
            return {"ok": False, "result": result}
        base = addon_candidate["base"]
        add_on = {
            "baseSigId": base["sigId"], "layerNo": addon_candidate["layerNo"], "max": addon_candidate["max"],
            "baseSide": base.get("side"), "baseEntry": base.get("entry"),
            "lever": (live.get("lever") if truthy(live.get("lever")) else None)
            or (base.get("leverage") if truthy(base.get("leverage")) else None),
            "upl": live["upl"], "livePos": live["pos"],
        }
        result["addOn"] = add_on

    result["stage"] = "spec"
    if config.get("refreshSpec"):
        try:
            if exchange == "okx":
                live_spec = await okx.fetch_instrument(spec["instId"], config["okx"])
            else:
                live_spec = await bingx.fetch_contract(spec["symbol"], config["bingx"])
            drifted = [k for k in live_spec
                       if k in spec and to_number(spec[k]) != to_number(live_spec[k])]
            if drifted:
                result["specDrift"] = [f"{k}: 靜態={num_str(spec[k])} 實際={num_str(live_spec[k])}" for k in drifted]
            spec = {**spec, **live_spec}
            result["spec"] = spec
        except Exception as err:  # noqa: BLE001
            result["specWarning"] = f"合約規格取得失敗，沿用靜態表：{err}"

    result["stage"] = "sizing"
    equity = await get_equity(config, {"demo": config.get("demo")}, now)
    result["equity"] = equity
    cap = resolve_notional_cap(config["risk"], equity["equityUsdt"])
    result["notionalCap"] = cap
    sized = size_for(sizing_config(config, add_on), equity["equityUsdt"], signal, spec, exchange, cap)
    if not sized["ok"]:
        result["reasons"] = [sized["error"]]
        if sized.get("band"):
            result["band"] = sized["band"]
            result["preview"] = sized.get("preview") or None
        store.mark_processed(signal["sigId"], "rejected", sized["error"], exchange)
        return {"ok": False, "result": result}
    result["sizing"] = sized["sizing"]

    plan = {
        "signal": signal, "spec": spec, "sizing": sized["sizing"], "exchange": exchange,
        "clientOrderId": client_order_id(signal["sigId"], "vg"),
        "tpUsed": signal["tp"][0], "tpDeferred": signal["tp"][1:],
        "gates": result["gates"], "riskSummary": result["riskSummary"],
        "equity": result["equity"], "notionalCap": result["notionalCap"],
        "overLimit": result.get("overLimit") or None, "addOn": result.get("addOn") or None,
    }
    if "specDrift" in result:
        plan["specDrift"] = result["specDrift"]
    if "specWarning" in result:
        plan["specWarning"] = result["specWarning"]
    return {"ok": True, "plan": plan}


async def live_base_position(exchange, spec, signal, config):
    """向交易所確認加倉前提。永不拋例外；查不到一律不加倉。"""
    inst_id = spec.get("instId") or spec.get("symbol")
    mod = okx if exchange == "okx" else bingx
    cfg = config["okx"] if exchange == "okx" else config["bingx"]
    try:
        lst = await mod.fetch_positions(cfg, {"demo": config.get("demo")})
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "why": f"加倉條件未符：無法向交易所確認既有部位（{err}）"}
    p = next((x for x in (lst or []) if x.get("instId") == inst_id), None)
    if not p:
        return {"ok": False, "why": f"加倉條件未符：交易所上查無 {inst_id} 部位（系統紀錄可能是殘留）"}
    if p.get("posSide") in ("long", "short"):
        live_side = p["posSide"]
    else:
        live_side = "short" if to_number(p.get("pos")) < 0 else "long"
    if live_side != signal["side"]:
        return {"ok": False, "why": f"加倉條件未符：交易所上的 {inst_id} 部位方向為{'做多' if live_side == 'long' else '做空'}"}
    upl = to_number(p.get("upl"))
    if config["risk"].get("addOnRequireProfit") is not False and not (upl > 0):
        return {"ok": False, "why": f"加倉條件未符：既有部位未獲利（未實現 {to_fixed(upl, 2) if _finite(upl) else '?'} USDT），"
                                    "不在虧損部位上加碼（ADDON_REQUIRE_PROFIT）"}
    lever = to_number(p.get("lever"))
    return {"ok": True, "lever": lever if truthy(lever) else None,
            "upl": upl if _finite(upl) else None, "pos": to_number(p.get("pos"))}


def sizing_config(config, add_on):
    """加倉：關掉自動槓桿、槓桿固定為原部位實際槓桿。"""
    if not add_on or not add_on.get("lever"):
        return config
    return {**config, "risk": {**config["risk"], "autoLeverage": False, "leverage": add_on["lever"]}}


def size_for(config, equity_usdt, signal, spec, exchange, cap):
    r = config["risk"]
    if r.get("sizingMode") == "fixed_margin":
        return compute_fixed_margin({
            "marginUsdt": r.get("fixedMarginUsdt"), "marginMaxUsdt": r.get("fixedMarginMaxUsdt"),
            "leverage": r.get("leverage"), "autoLeverage": r.get("autoLeverage"),
            "minLiqCushion": r.get("minLiqCushion"),
            "entry": signal["entry"], "sl": signal["sl"], "tp": signal["tp"], "side": signal["side"],
            "spec": spec, "exchange": exchange, "feeRateOneWay": r.get("feeRateOneWay"),
            "lossMinUsdt": r.get("lossMinUsdt"), "lossMaxUsdt": r.get("lossMaxUsdt"),
            "maxNotionalUsdt": cap["value"], "equityUsdt": equity_usdt,
        })
    return compute_size({
        "equityUsdt": equity_usdt, "riskPct": r.get("pctPerTrade"), "entry": signal["entry"], "sl": signal["sl"],
        "spec": spec, "exchange": exchange, "leverage": r.get("leverage"),
        "maxNotionalUsdt": cap["value"], "maxNotionalNote": cap["note"],
    })


def resolve_notional_cap(risk, equity_usdt):
    absolute = risk["maxNotionalUsdt"]
    mult = 3 if risk.get("maxNotionalMult") is None else risk["maxNotionalMult"]
    relative = equity_usdt * mult
    if relative < absolute:
        return {"value": relative, "source": "mult", "note": f"權益 {to_fixed(equity_usdt, 0)} × {num_str(mult)} 倍"}
    return {"value": absolute, "source": "absolute", "note": "MAX_NOTIONAL_USDT 絕對上限"}


def notional_cap_fallback(config):
    return {"value": config["risk"]["maxNotionalUsdt"], "source": "absolute", "note": "絕對上限"}


# ================================================================
# 第 6–7 步
# ================================================================
_REDACT_RE = re.compile(r"key|sign|passphrase|apikey", re.I)
_SIG_RE = re.compile(r"signature=[^&]+", re.I)


def redact_request(req):
    if not req:
        return None
    headers = dict(req.get("headers") or {})
    for k in list(headers):
        if _REDACT_RE.search(k):
            headers[k] = "[REDACTED]"
    out = {**req, "headers": headers}
    if truthy(out.get("url")):
        out["url"] = _SIG_RE.sub("signature=[REDACTED]", str(out["url"]), count=1)
    return out


async def place_from_plan(plan, ctx):
    config, store = ctx["config"], ctx["store"]
    now = _now(ctx)
    signal, spec, sizing, exchange, cloid = (plan["signal"], plan["spec"], plan["sizing"],
                                             plan["exchange"], plan["clientOrderId"])
    result = {
        "at": iso(now), "stage": "order", "sigId": signal["sigId"], "signal": signal, "spec": spec,
        "sizing": sizing,
        "gates": plan.get("gates"), "riskSummary": plan.get("riskSummary"), "clientOrderId": cloid,
        "tpUsed": plan.get("tpUsed"), "tpDeferred": plan.get("tpDeferred"), "reasons": [],
    }
    # JS 的 undefined 欄位不會出現在結果裡（確認路徑的 plan 沒有 equity / notionalCap）
    for k in ("equity", "notionalCap"):
        if plan.get(k) is not None:
            result[k] = plan[k]
    flags = {"dryRun": config.get("dryRun"), "demo": config.get("demo")}
    dry = truthy(config.get("dryRun"))
    risk_cfg = config["risk"]

    if not dry:
        intent = {
            "clOrdId": cloid, "instId": spec.get("instId"), "symbol": signal["symbol"], "side": signal["side"],
            "exchange": exchange, "entry": signal["entry"], "sl": signal["sl"], "tp": signal["tp"],
            "orderQty": sizing["orderQty"], "baseQty": sizing["baseQty"],
        }
        if plan.get("addOn"):
            intent["addOnTo"] = plan["addOn"]["baseSigId"]
        store.record_intent(signal["sigId"], intent)

    try:
        lev = sizing.get("leverage") if (sizing and truthy(sizing.get("leverage"))) else risk_cfg.get("leverage")
        if exchange == "okx":
            try:
                if not dry:
                    await okx.ensure_leverage({
                        "instId": spec["instId"], "leverage": lev,
                        "tdMode": config["okx"].get("tdMode"), "posMode": config["okx"].get("posMode")},
                        config["okx"], flags)
            except Exception as err:  # noqa: BLE001
                result["reasons"].append(
                    f"⚠️ {spec['instId']} 槓桿設定失敗（{err}），"
                    f"本筆使用交易所目前的槓桿，實際保證金可能與 {num_str(risk_cfg.get('leverage'))}x 的預期不同。")
            placed = await okx.place_order({
                "instId": spec["instId"], "side": signal["side"], "orderQty": sizing["orderQty"],
                "clOrdId": cloid, "tdMode": config["okx"].get("tdMode"), "posMode": config["okx"].get("posMode"),
                "sl": signal["sl"], "tp": plan["tpUsed"]}, config["okx"], flags)
        else:
            try:
                if not dry:
                    await bingx.ensure_leverage({"symbol": spec["symbol"], "leverage": lev},
                                                config["bingx"], flags)
            except Exception as err:  # noqa: BLE001
                result["reasons"].append(
                    f"⚠️ {spec['symbol']} BingX 槓桿設定失敗（{err}），"
                    "本筆使用交易所目前的槓桿，實際倉位可能與預期不同。")
            placed = await bingx.place_order({
                "symbol": spec["symbol"], "side": signal["side"], "orderQty": sizing["orderQty"],
                "clientOrderId": cloid, "sl": signal["sl"], "tp": plan["tpUsed"]}, config["bingx"], flags)

        result["decision"] = "placed"
        result["sent"] = placed["sent"]
        result["request"] = redact_request(placed.get("request"))
        result["response"] = placed.get("response")

        store.mark_processed(signal["sigId"], "placed" if placed["sent"] else "dry_run", cloid, exchange)
        store.record_order(now)
        if placed["sent"]:
            record = {
                "symbol": signal["symbol"], "exchange": exchange, "side": signal["side"],
                "entry": signal["entry"], "sl": signal["sl"], "tp": signal["tp"],
                "orderQty": sizing["orderQty"], "baseQty": sizing["baseQty"], "clientOrderId": cloid,
                "leverage": lev,
            }
            if plan.get("addOn"):
                layered = store.add_layer(plan["addOn"]["baseSigId"], exchange, {"sigId": signal["sigId"], **record})
                if not layered:
                    store.add_position(signal["sigId"], record)
                    result["reasons"].append("⚠️ 原部位紀錄已不存在，這筆加倉改記為獨立部位，請到交易所確認持倉。")
                result["addOn"] = plan["addOn"]
            else:
                store.add_position(signal["sigId"], record)
        store.clear_intent(signal["sigId"], exchange)

        if placed["sent"] and exchange == "okx":
            try:
                guard = await okx.verify_protection({"instId": spec["instId"], "sl": signal["sl"]},
                                                    config["okx"], flags)
                result["protection"] = guard
                if not guard["ok"]:
                    msg = (f"🚨 止損未掛上！{spec['instId']} 目前是裸倉。"
                           f"（{guard.get('note')}）請立即到交易所手動補止損 {num_str(signal['sl'])}。")
                    result["reasons"].append(msg)
                    print("[protect] " + msg)
                elif truthy(guard.get("note")):
                    result["reasons"].append(f"⚠️ {guard['note']}")
            except Exception as err:  # noqa: BLE001
                result["reasons"].append(f"⚠️ 無法確認止損是否掛上（{err}）。請自行到交易所看一眼。")
    except Exception as err:  # noqa: BLE001
        result["decision"] = "error"
        result["reasons"] = [str(err)]
        result["unconfirmed"] = True
        store.mark_processed(signal["sigId"], "error", str(err), exchange)
    return result


# ================================================================
# 入口一：訊號
# ================================================================
async def handle_signal_inner(raw_payload, ctx):
    config, store = ctx["config"], ctx["store"]
    now = _now(ctx)
    store.expire_pendings(now)

    exchanges = config.get("exchanges") if truthy(config.get("exchanges")) else [config["primaryExchange"]]
    if len(exchanges) == 1:
        return await handle_for_exchange(raw_payload, ctx, exchanges[0])

    results = []
    for ex in exchanges:
        try:
            results.append(await handle_for_exchange(raw_payload, ctx, ex))
        except Exception as err:  # noqa: BLE001
            r = {"at": iso(now), "decision": "error", "exchange": ex,
                 "reasons": [str(err)], "unconfirmed": True}
            sid = raw_payload.get("sig_id") if isinstance(raw_payload, dict) else None
            if sid is not None:
                r["sigId"] = sid
            results.append(r)
    return aggregate_results(results, exchanges, config, ctx)


def aggregate_results(results, exchanges, config, ctx):
    rank = {"placed": 4, "pending": 3, "rejected": 2, "error": 1, "not_found": 0}
    best = results[0]
    for b in results[1:]:
        if rank.get(b.get("decision"), 0) > rank.get(best.get("decision"), 0):
            best = b
    placed = [r for r in results if r.get("decision") == "placed"]
    failed = [r for r in results if r.get("decision") != "placed"]
    out = {**best, "exchanges": exchanges,
           "perExchange": [{k: v for k, v in {
               "exchange": r.get("exchange"), "decision": r.get("decision"), "sizing": r.get("sizing"),
               "reasons": r.get("reasons"), "unconfirmed": r.get("unconfirmed")}.items() if v is not None}
               for r in results],
           "partial": bool(placed) and bool(failed)}
    if out["partial"]:
        out["reasons"] = list(out.get("reasons") or []) + [
            f"⚠️ 只有 {'、'.join(r['exchange'] for r in placed)} 成交；"
            f"{'、'.join(r['exchange'] + '（' + r['decision'] + '）' for r in failed)} 未成交。"
            "實際曝險為預期的一半。"]
    return out


async def handle_for_exchange(raw_payload, ctx, exchange):
    config, store = ctx["config"], ctx["store"]
    now = _now(ctx)
    started = clock.now_ms()
    ctx = {**ctx, "exchange": exchange}

    built = await build_plan(raw_payload, ctx)
    if not built["ok"]:
        built["result"]["elapsedMs"] = clock.now_ms() - started
        built["result"]["exchange"] = exchange
        await notify_decision(built["result"], config, exchange, ctx.get("suppressNotify"))
        return built["result"]

    plan = built["plan"]
    auto = (not plan["overLimit"] and not plan["addOn"]
            and (config.get("executionMode") == "auto"
                 or (config.get("executionMode") == "by_grade"
                     and plan["signal"]["grade"] >= config["autoGradeMin"])))

    if auto:
        result = await place_from_plan(plan, ctx)
        result["mode"] = config.get("executionMode")
        result["exchange"] = exchange
        result["elapsedMs"] = clock.now_ms() - started
        await notify_decision(result, config, plan["exchange"], ctx.get("suppressNotify"))
        return result

    expires_at = iso(now + config["pendingTtlSec"] * 1000)
    store.add_pending(plan["signal"]["sigId"], {
        "exchange": plan["exchange"], "expiresAt": expires_at, "signal": plan["signal"], "spec": plan["spec"],
        "sizing": plan["sizing"], "clientOrderId": plan["clientOrderId"], "tpUsed": plan["tpUsed"],
        "tpDeferred": plan["tpDeferred"], "gates": plan["gates"], "riskSummary": plan["riskSummary"],
        "equity": plan["equity"], "notionalCap": plan["notionalCap"],
        "overLimit": plan["overLimit"] or None, "addOn": plan["addOn"] or None,
    })
    store.mark_processed(plan["signal"]["sigId"], "pending", plan["clientOrderId"], plan["exchange"])

    add_on, over = plan["addOn"], plan["overLimit"]
    if add_on:
        upl = add_on.get("upl")
        reasons = [f"加倉機會：已持有{'做空' if add_on['baseSide'] == 'short' else '做多'}部位"
                   + (f"（未實現 {'+' if upl >= 0 else ''}{to_fixed(upl, 2)} USDT）" if _finite(upl) else "")
                   + f"，這是第 {num_str(add_on['layerNo'])} 次加倉（上限 {num_str(add_on['max'])}）"]
    elif over:
        reasons = [f"已達持倉上限 {num_str(over['maxNow'])}（目前 {num_str(over['openCount'])} 筆），"
                   f"按「超額進場」將開第 {num_str(over['openCount'] + 1)} 筆，硬上限 {num_str(over['hardCap'])}"]
    else:
        reasons = []

    result = {
        "at": iso(now), "decision": "pending", "stage": "pending", "mode": config.get("executionMode"),
        "exchange": exchange, "sigId": plan["signal"]["sigId"], "signal": plan["signal"], "spec": plan["spec"],
        "sizing": plan["sizing"], "gates": plan["gates"], "riskSummary": plan["riskSummary"],
        "clientOrderId": plan["clientOrderId"], "tpUsed": plan["tpUsed"], "tpDeferred": plan["tpDeferred"],
        "expiresAt": expires_at, "ttlSec": config["pendingTtlSec"],
        "overLimit": plan["overLimit"] or None, "addOn": plan["addOn"] or None,
        "reasons": reasons, "elapsedMs": clock.now_ms() - started,
    }
    await notify_decision(result, config, plan["exchange"], ctx.get("suppressNotify"))
    return result


# ================================================================
# 入口二：進場確認
# ================================================================
async def fetch_live_price(pending, config):
    if pending["exchange"] == "bingx":
        sym = pending["spec"].get("symbol") or pending["spec"].get("instId")
        t = await bingx.fetch_ticker(sym, config["bingx"])
        return t["last"]
    t = await okx.fetch_ticker(pending["spec"]["instId"], config["okx"])
    return t["last"]


async def confirm_signal_inner(sig_id, ctx):
    config, store = ctx["config"], ctx["store"]
    now = _now(ctx)
    started = clock.now_ms()
    exchange = ctx.get("exchange")
    sid = "" if not truthy(sig_id) else str(sig_id)

    store.expire_pendings(now)

    pending = store.get_pending(sid, exchange)
    if not pending:
        done = store.get_processed(sid, exchange)
        attempted = bool(done) and done.get("outcome") in ("placed", "dry_run", "error")
        explain = (f"這筆已經送出過了（{done.get('outcome')}），不需要再按一次" if attempted
                   else "找不到這筆待確認訊號，可能已過期、已略過，或 sig_id 有誤")
        return {"at": iso(now), "decision": "already_handling" if attempted else "not_found",
                "sigId": sig_id if truthy(sig_id) else None,
                "priorOutcome": done.get("outcome") if done else None,
                "reasons": [explain], "elapsedMs": clock.now_ms() - started}

    if not store.claim_pending(sig_id, exchange):
        return {"at": iso(now), "decision": "already_handling", "sigId": sig_id,
                "reasons": [f"這筆訊號目前狀態為 {pending.get('status')}，不再受理確認"],
                "elapsedMs": clock.now_ms() - started}

    def rejected(stage, reasons, **extra):
        r = {"at": iso(now), "decision": "rejected", "stage": stage, "sigId": sig_id,
             "signal": pending["signal"], "sizing": pending["sizing"]}
        r.update(extra)
        r["reasons"] = reasons
        r["elapsedMs"] = clock.now_ms() - started
        return r

    re_ = risk_mod.recheck(pending["signal"], store, config["risk"], pending["exchange"],
                           allowOverflow=bool(truthy(pending.get("overLimit"))),
                           addOn=pending.get("addOn") or None)
    if not re_["passed"]:
        store.resolve_pending(sig_id, "skipped", "確認時風控未通過：" + "；".join(re_["reasons"]), exchange)
        result = rejected("recheck", re_["reasons"], gates=re_["gates"], riskSummary=risk_mod.summarise(re_))
        await notify_decision(result, config, pending["exchange"], ctx.get("suppressNotify"))
        return result

    add_on = pending.get("addOn") or None
    if add_on:
        live = await live_base_position(pending["exchange"], pending["spec"], pending["signal"], config)
        if not live["ok"]:
            store.resolve_pending(sig_id, "skipped", "確認時加倉條件未符：" + live["why"], exchange)
            r = rejected("addon_recheck", [live["why"]], addOn=add_on)
            await notify_decision(r, config, pending["exchange"], ctx.get("suppressNotify"))
            return r
        add_on = {**add_on, "upl": live["upl"],
                  "lever": live["lever"] if truthy(live.get("lever")) else add_on.get("lever")}

    drift = None
    sizing_to_use = pending["sizing"]
    if config["risk"].get("driftCheck") is not False:
        try:
            live_px = await fetch_live_price(pending, config)
            drift = assess_drift(pending["signal"], live_px, {
                "maxWiden": config["risk"].get("driftMaxWiden"), "maxTighten": config["risk"].get("driftMaxTighten")})
        except Exception as err:  # noqa: BLE001
            drift = {"ok": False, "verdict": "no_price", "metrics": {},
                     "reason": f"無法取得現價（{err}），拒絕下單。以無法驗證的價格計算倉位，正是這道檢查要防的事。"}

        if not drift["ok"]:
            store.resolve_pending(sig_id, "skipped", "進場價漂移：" + drift["reason"], exchange)
            r = rejected("drift", [drift["reason"]], gates=pending.get("gates"),
                         riskSummary=pending.get("riskSummary"), drift=drift)
            await notify_decision(r, config, pending["exchange"], ctx.get("suppressNotify"))
            return r

        if drift["verdict"] == "resize":
            eq_rec = pending.get("equity")
            eq2 = eq_rec["equityUsdt"] if (eq_rec and truthy(eq_rec.get("equityUsdt"))) else config["risk"].get("equityUsdt")
            re2 = size_for(sizing_config(config, add_on), eq2,
                           {**pending["signal"], "entry": drift["metrics"]["livePrice"]},
                           pending["spec"], pending["exchange"],
                           pending.get("notionalCap") if truthy(pending.get("notionalCap")) else notional_cap_fallback(config))
            if not re2["ok"]:
                store.resolve_pending(sig_id, "skipped", "以現價重算倉位失敗：" + re2["error"], exchange)
                r = rejected("drift_resize", [re2["error"]], drift=drift)
                await notify_decision(r, config, pending["exchange"], ctx.get("suppressNotify"))
                return r
            drift["originalSizing"] = pending["sizing"]
            drift["resized"] = re2["sizing"]
            sizing_to_use = re2["sizing"]

    try:
        result = await place_from_plan({
            "signal": pending["signal"], "spec": pending["spec"], "sizing": sizing_to_use,
            "exchange": pending["exchange"], "clientOrderId": pending["clientOrderId"],
            "tpUsed": pending.get("tpUsed"), "tpDeferred": pending.get("tpDeferred"),
            "gates": pending.get("gates"), "riskSummary": pending.get("riskSummary"), "addOn": add_on}, ctx)
    except Exception as err:  # noqa: BLE001
        store.release_pending(sig_id, exchange)
        return {"at": iso(now), "decision": "error", "sigId": sig_id, "reasons": [str(err)],
                "elapsedMs": clock.now_ms() - started}

    store.resolve_pending(sig_id, "placed" if result["decision"] == "placed" else "error",
                          "；".join(result["reasons"]), exchange)
    result["confirmedByUser"] = True
    if drift:
        result["drift"] = drift
    if pending.get("equity"):
        result["equity"] = pending["equity"]
    result["elapsedMs"] = clock.now_ms() - started
    await notify_decision(result, config, pending["exchange"], ctx.get("suppressNotify"))
    return result


# ================================================================
# 入口三：略過
# ================================================================
async def skip_signal(sig_id, ctx):
    config, store = ctx["config"], ctx["store"]
    now = _now(ctx)
    store.expire_pendings(now)
    sid = "" if not truthy(sig_id) else str(sig_id)
    allp = store.pendings_for_signal(sid)
    if not allp:
        return {"at": iso(now), "decision": "not_found", "sigId": sig_id if truthy(sig_id) else None,
                "reasons": ["找不到這筆待確認訊號，可能已過期或已處理"]}
    pending = allp[0]
    if pending.get("status") != "pending":
        return {"at": iso(now), "decision": "already_handling", "sigId": sig_id,
                "reasons": [f"這筆訊號目前狀態為 {pending.get('status')}"]}
    for p in allp:
        store.resolve_pending(sig_id, "skipped", "使用者略過", p["exchange"])
    store.mark_processed(sig_id, "skipped", "使用者略過")
    result = {"at": iso(now), "decision": "skipped", "sigId": sig_id, "signal": pending["signal"],
              "sizing": pending["sizing"], "reasons": []}
    await notify_decision(result, config, pending["exchange"], ctx.get("suppressNotify"))
    return result


# ================================================================
# 共用
# ================================================================
async def notify_decision(result, config, exchange, suppress=None):
    if suppress:
        return
    if not result.get("signal"):
        return
    text = notify.render_decision({
        "signal": result["signal"], "decision": result.get("decision"), "sizing": result.get("sizing"),
        "riskSummary": result.get("riskSummary"), "reasons": result.get("reasons"),
        "dryRun": config.get("dryRun"), "demo": config.get("demo"), "exchange": exchange,
        "expiresAt": result.get("expiresAt"), "ttlSec": result.get("ttlSec"),
        "confirmedByUser": result.get("confirmedByUser"),
    })
    await notify.send(text, config["telegram"])


def gate_rejection(err, sig_id, now):
    return {"at": iso(now), "decision": "rejected", "stage": "gate",
            "sigId": sig_id if truthy(sig_id) else None, "reasons": [str(err)],
            "gateTimeout": True, "unconfirmed": getattr(err, "code", None) == "run_timeout"}


def is_gate_error(err):
    return isinstance(err, GateError)


async def handle_signal(raw_payload, ctx):
    now = _now(ctx)
    config = (ctx or {}).get("config") or {}
    try:
        return await order_gate.run(lambda: handle_signal_inner(raw_payload, ctx), "訊號處理")
    except GateError as err:
        sig_id = raw_payload.get("sig_id") if isinstance(raw_payload, dict) else None
        result = gate_rejection(err, sig_id, now)
        if not ctx.get("suppressNotify"):
            sym = raw_payload.get("symbol") if isinstance(raw_payload, dict) and truthy(raw_payload.get("symbol")) else "未知代碼"
            try:
                await notify.send(
                    "⛔ 訊號未處理｜" + str(sym) + "\n─────────────\n" + str(err)
                    + ("\n\n⚠️ 這筆可能已經送到交易所，請去確認是否已成交。" if result["unconfirmed"] else ""),
                    config.get("telegram") or {})
            except Exception:  # noqa: BLE001
                pass
        return result


async def confirm_signal(sig_id, ctx):
    now = _now(ctx)
    store = ctx.get("store")
    sid = "" if not truthy(sig_id) else str(sig_id)
    pendings = store.pendings_for_signal(sid) if store is not None else []

    if len(pendings) <= 1:
        ex = pendings[0]["exchange"] if pendings else ctx.get("exchange")
        try:
            return await order_gate.run(lambda: confirm_signal_inner(sig_id, {**ctx, "exchange": ex}), "確認下單")
        except GateError as err:
            return gate_rejection(err, sig_id, now)

    results = []
    for p in pendings:
        try:
            results.append(await order_gate.run(
                lambda p=p: confirm_signal_inner(sig_id, {**ctx, "exchange": p["exchange"]}),
                "確認下單 " + p["exchange"]))
        except GateError as err:
            results.append(gate_rejection(err, sig_id, now))
        except Exception as err:  # noqa: BLE001
            results.append({"at": iso(now), "decision": "error", "exchange": p["exchange"], "sigId": sig_id,
                            "reasons": [str(err)], "unconfirmed": True})
    return aggregate_results(results, [p["exchange"] for p in pendings], ctx["config"], ctx)
