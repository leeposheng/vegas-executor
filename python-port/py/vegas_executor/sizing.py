"""倉位計算（對應 sizing.js）。浮點運算順序與 JS 完全相同，不可「化簡」。"""
import math

from .jsnum import (div, fixed_num, js_floor, js_round, num_str, round4,
                    to_fixed, to_number, truthy)


def over_cap(notional, cap) -> bool:
    return notional > cap * (1 + 1e-9)


def floor_to_step(value, step):
    if not (step > 0):
        return value
    s = num_str(step)
    decimals = len(s.split(".")[1]) if "." in s else 0
    n = js_floor(div(value + 1e-12, step)) * step
    return fixed_num(n, max(decimals, 8))


def band_numbers(o):
    stop_pct = o["stopPct"]
    fee = o["feeRateOneWay"]
    fee_pct = fee * 2
    out = {"feeShare": round4(fee_pct / (stop_pct + fee_pct))}

    tp = o.get("tp")
    entry = o.get("entry")
    tp1 = to_number(tp[0]) if isinstance(tp, list) else None
    if tp1 and entry:
        tp_pct = abs(tp1 - to_number(entry)) / to_number(entry)
        win_net = tp_pct - fee_pct
        loss_cost = stop_pct + fee_pct
        out["rr"] = round4(win_net / loss_cost)
        out["breakeven"] = round4(loss_cost / (win_net + loss_cost)) if win_net > 0 else None

    if not o.get("tooSmall"):
        out["suggestLeverage"] = max(
            1, js_floor(div(o["lossMaxUsdt"], o["marginUsdt"] * (stop_pct + fee_pct))))
    return out


def auto_size(o):
    base_lev = o["baseLeverage"]
    stop_pct = o["stopPct"]
    fee = o["feeRateOneWay"]
    margin_min = o["marginMin"]
    margin_max = o["marginMax"]
    loss_min = o["lossMinUsdt"]
    loss_max = o["lossMaxUsdt"]
    max_notional = o["maxNotionalUsdt"]
    cushion = o["minLiqCushion"]
    lot_notional = o["lotNotionalUsdt"]
    tot = stop_pct + fee * 2

    by_cushion = js_floor(div(1, stop_pct * cushion))
    lev_cap = max(1, min(base_lev, by_cushion))

    margin = margin_min
    lev = min(lev_cap,
              js_floor(div(loss_max, margin * tot)),
              js_floor(div(max_notional, margin)))
    if not (lev >= 1):
        lev = 1

    loss = margin * lev * tot

    margin_raised = False
    if loss < loss_min and lev >= lev_cap:
        ln = to_number(lot_notional)
        headroom = ln if ln > 0 else 0
        need_notional = loss_min / tot + headroom
        allowed = min(need_notional, max_notional)
        want_margin = allowed / lev
        if want_margin > margin:
            margin = min(margin_max, want_margin)
            loss = margin * lev * tot
            margin_raised = margin > margin_min

    reason = ""
    if lev < base_lev:
        by_loss = js_floor(div(loss_max, margin_min * tot))
        by_cap = js_floor(div(max_notional, margin_min))
        if by_cushion <= by_loss and by_cushion <= by_cap:
            reason = f"強平緩衝 {num_str(cushion)}x 限制"
        elif by_cap <= by_loss:
            reason = f"名目上限 {num_str(js_round(max_notional))} USDT 限制"
        else:
            reason = f"單筆虧損上限 {num_str(loss_max)} USDT 限制"
    if margin_raised:
        reason += ("；" if reason else "") + f"保證金提高到 {to_fixed(margin, 0)} USDT"

    cap_bound = loss < loss_min and abs(margin * lev - max_notional) / max_notional < 0.02
    return {"leverage": lev, "marginUsdt": margin, "reason": reason,
            "capBound": cap_bound, "levCap": lev_cap}


def compute_fixed_margin(p):
    entry = p["entry"]
    sl = p["sl"]
    spec = p["spec"]
    exchange = p["exchange"]
    tp = p.get("tp")
    fee = p["feeRateOneWay"]
    loss_min = p["lossMinUsdt"]
    loss_max = p["lossMaxUsdt"]
    max_notional = p["maxNotionalUsdt"]
    equity = p["equityUsdt"]
    base_leverage = p["leverage"]

    risk_distance = abs(entry - sl)
    if not (risk_distance > 0):
        return {"ok": False, "error": "風險距離為 0，無法計算倉位"}

    leverage = base_leverage
    margin_usdt = p["marginUsdt"]
    auto_note = ""
    cap_bound = False
    if truthy(p.get("autoLeverage")):
        if exchange == "okx":
            lot_notional = to_number(spec["lotSz"]) * to_number(spec["ctVal"]) * to_number(entry)
        else:
            lot_notional = to_number(spec["stepSize"]) * to_number(entry)
        auto = auto_size({
            "baseLeverage": base_leverage,
            "stopPct": risk_distance / entry,
            "feeRateOneWay": fee,
            "lotNotionalUsdt": lot_notional,
            "marginMin": p["marginUsdt"],
            "marginMax": p["marginMaxUsdt"] if truthy(p.get("marginMaxUsdt")) else p["marginUsdt"],
            "lossMinUsdt": loss_min,
            "lossMaxUsdt": loss_max,
            "maxNotionalUsdt": max_notional,
            "minLiqCushion": p["minLiqCushion"] if truthy(p.get("minLiqCushion")) else 3,
        })
        leverage = auto["leverage"]
        margin_usdt = auto["marginUsdt"]
        auto_note = auto["reason"]
        cap_bound = auto["capBound"]

    if margin_usdt > equity:
        return {"ok": False,
                "error": f"單筆保證金 {num_str(margin_usdt)} USDT 超過權益 {to_fixed(equity, 2)} USDT"}

    target_notional = margin_usdt * leverage
    raw_base_qty = target_notional / entry

    if exchange == "okx":
        unit = "contracts"
        step = spec["lotSz"]
        minimum = spec["minSz"]
        order_qty = floor_to_step(raw_base_qty / spec["ctVal"], step)
        base_qty = order_qty * spec["ctVal"]
    else:
        unit = "base"
        step = spec["stepSize"]
        minimum = spec["minQty"]
        order_qty = floor_to_step(raw_base_qty, step)
        base_qty = order_qty

    if not (order_qty >= minimum) or order_qty <= 0:
        return {"ok": False,
                "error": f"對齊後數量 {num_str(order_qty)} {unit} 低於最小下單量 {num_str(minimum)}。"
                         f"保證金 {num_str(margin_usdt)} × 槓桿 {num_str(leverage)} 在此價格下不足以成交一手。"}

    notional = base_qty * entry
    actual_margin = notional / leverage
    price_loss = round4(base_qty * risk_distance)
    fee_usdt = round4(notional * fee * 2)
    est_loss = round4(price_loss + fee_usdt)
    stop_pct = risk_distance / entry

    if over_cap(notional, max_notional):
        return {"ok": False,
                "error": f"名目價值 {to_fixed(notional, 2)} USDT 超過絕對上限 "
                         f"{to_fixed(to_number(max_notional), 0)} USDT，拒絕下單"}

    if est_loss < loss_min or est_loss > loss_max:
        too_small = est_loss < loss_min
        nums = band_numbers({"stopPct": stop_pct, "feeRateOneWay": fee, "tp": tp, "entry": entry,
                             "estLossUsdt": est_loss, "lossMaxUsdt": loss_max,
                             "marginUsdt": margin_usdt, "tooSmall": too_small})
        head = f"（止損 {to_fixed(stop_pct * 100, 3)}%，手續費佔 {to_fixed(nums['feeShare'] * 100, 1)}%"
        if too_small:
            err = (f"虧損 {to_fixed(est_loss, 2)} < 下限 {num_str(loss_min)}" + head
                   + (f"，名目已達上限 {num_str(js_round(max_notional))}" if cap_bound else "") + "）")
        else:
            err = f"虧損 {to_fixed(est_loss, 2)} > 上限 {num_str(loss_max)}" + head + "）"
        preview = {"notionalUsdt": round4(notional), "orderQty": order_qty,
                   "baseQty": round4(base_qty), "estLossUsdt": round4(est_loss),
                   "feeUsdt": round4(fee_usdt), "stopPct": round4(stop_pct),
                   "leverage": leverage, "marginUsdt": margin_usdt}
        preview.update(nums)
        return {"ok": False, "band": "below" if too_small else "above",
                "capBound": cap_bound, "error": err, "preview": preview}

    return {"ok": True, "sizing": {
        "mode": "fixed_margin", "exchange": exchange, "unit": unit,
        "orderQty": order_qty, "baseQty": base_qty, "step": step, "minimum": minimum,
        "riskDistance": risk_distance,
        "stopPct": fixed_num(stop_pct * 100, 4),
        "riskAmountUsdt": round4(loss_max),
        "riskBudgetIsCap": truthy(p.get("autoLeverage")),
        "actualRiskUsdt": est_loss,
        "priceLossUsdt": price_loss,
        "feeUsdt": fee_usdt,
        "riskUtilisation": fixed_num(est_loss / loss_max, 4),
        "notionalUsdt": fixed_num(notional, 4),
        "marginUsdt": fixed_num(actual_margin, 4),
        "targetMarginUsdt": margin_usdt,
        "baseMarginUsdt": p["marginUsdt"],
        "leverage": leverage,
        "baseLeverage": base_leverage,
        "leverageNote": auto_note,
    }}


def compute_size(p):
    equity = p["equityUsdt"]
    risk_pct = p["riskPct"]
    entry = p["entry"]
    sl = p["sl"]
    spec = p["spec"]
    exchange = p["exchange"]
    leverage = p["leverage"]
    max_notional = p["maxNotionalUsdt"]
    note = p.get("maxNotionalNote")

    risk_distance = abs(entry - sl)
    if not (risk_distance > 0):
        return {"ok": False, "error": "風險距離為 0，無法計算倉位"}

    risk_amount = equity * risk_pct
    raw_base = risk_amount / risk_distance

    if exchange == "okx":
        unit = "contracts"
        step = spec["lotSz"]
        minimum = spec["minSz"]
        order_qty = floor_to_step(raw_base / spec["ctVal"], step)
        base_qty = order_qty * spec["ctVal"]
    else:
        unit = "base"
        step = spec["stepSize"]
        minimum = spec["minQty"]
        order_qty = floor_to_step(raw_base, step)
        base_qty = order_qty

    if not (order_qty >= minimum) or order_qty <= 0:
        return {"ok": False,
                "error": f"對齊後數量 {num_str(order_qty)} {unit} 低於最小下單量 {num_str(minimum)}。"
                         f"在目前的風險預算（{to_fixed(risk_amount, 2)} USDT）與風險距離"
                         f"（{num_str(risk_distance)}）下無法合法下單，拒絕此訊號（不進位湊量）。"}

    notional = base_qty * entry
    margin = notional / leverage

    if over_cap(notional, max_notional):
        return {"ok": False,
                "error": f"名目價值 {to_fixed(notional, 2)} USDT 超過上限 "
                         f"{to_fixed(to_number(max_notional), 0)} USDT"
                         + (f"（{note}）" if truthy(note) else "") + "，拒絕下單"}
    if margin > equity:
        return {"ok": False,
                "error": f"所需保證金 {to_fixed(margin, 2)} USDT 超過權益 {num_str(equity)} USDT，拒絕下單"}

    actual = base_qty * risk_distance
    return {"ok": True, "sizing": {
        "exchange": exchange, "unit": unit, "orderQty": order_qty, "baseQty": base_qty,
        "step": step, "minimum": minimum, "riskDistance": risk_distance,
        "riskAmountUsdt": fixed_num(risk_amount, 4),
        "actualRiskUsdt": fixed_num(actual, 4),
        "riskUtilisation": fixed_num(actual / risk_amount, 4),
        "notionalUsdt": fixed_num(notional, 4),
        "marginUsdt": fixed_num(margin, 4),
        "leverage": leverage,
    }}
