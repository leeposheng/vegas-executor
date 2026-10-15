"""風控閘門（對應 risk.js）。閘門順序、名稱、訊息逐字相同（SPEC §4）。"""
import math

from . import clock
from .jsnum import js_floor, num_str, to_fixed, to_number, truthy


def _finite(v):
    return math.isfinite(to_number(v if v is not None else float("nan")))


def _ovr(store, key):
    v = store.get_override(key) if store is not None and hasattr(store, "get_override") else None
    return v


def effective_max_concurrent(store, risk):
    ceiling = risk["maxConcurrentCeiling"] if truthy(risk.get("maxConcurrentCeiling")) else risk["maxConcurrent"]
    ov = _ovr(store, "maxConcurrent")
    wanted = to_number(ov) if _finite(ov) else risk["maxConcurrent"]
    return max(1, min(wanted, ceiling))


def overflow_allowance(store, risk, exchange):
    open_count = store.open_position_count(exchange)
    max_now = effective_max_concurrent(store, risk)
    n = to_number(risk.get("overflowPositions"))
    extra = max(0, js_floor(n if (not math.isnan(n) and n != 0) else 0))
    hard_cap = max_now + extra
    return {"openCount": open_count, "maxNow": max_now, "hardCap": hard_cap,
            "canOverflow": extra > 0 and open_count < hard_cap}


def overflow_eligible(risk_result, store, risk, exchange):
    failed = [g["name"] for g in risk_result["gates"] if not g["passed"]]
    if len(failed) != 1 or failed[0] != "max_concurrent":
        return None
    a = overflow_allowance(store, risk, exchange)
    return a if a["canOverflow"] else None


def addon_eligible(risk_result, store, risk, exchange, signal):
    n = to_number(risk.get("addOnMax"))
    mx = max(0, js_floor(n if (not math.isnan(n) and n != 0) else 0))
    if not mx:
        return None
    failed = [g["name"] for g in risk_result["gates"] if not g["passed"]]
    if "no_duplicate_symbol" not in failed:
        return None
    if any(x != "no_duplicate_symbol" and x != "max_concurrent" for x in failed):
        return None
    base = next((p for p in store.list_positions(exchange) if p.get("symbol") == signal["symbol"]), None)
    if not base:
        return {"ok": False, "why": f"加倉條件未符：{signal['symbol']} 只有未結案的下單紀錄，沒有確認成交的部位"}
    if truthy(base.get("side")) and base["side"] != signal["side"]:
        bs = "做多" if base["side"] == "long" else "做空"
        ss = "做多" if signal["side"] == "long" else "做空"
        return {"ok": False, "why": f"加倉條件未符：既有部位為{bs}，訊號為{ss}（反向不加倉）"}
    used = len(base["layers"]) if isinstance(base.get("layers"), list) else 0
    if used >= mx:
        return {"ok": False, "why": f"加倉條件未符：此部位已加倉 {used} 次，達上限 {mx}（ADDON_MAX）"}
    return {"ok": True, "base": base, "layerNo": used + 1, "max": mx}


def effective_daily_loss_limit(store, risk):
    ceiling = risk["dailyLossCeilingUsdt"] if truthy(risk.get("dailyLossCeilingUsdt")) else risk["dailyLossLimitUsdt"]
    ov = _ovr(store, "dailyLossLimit")
    wanted = to_number(ov) if _finite(ov) else risk["dailyLossLimitUsdt"]
    return max(1, min(wanted, ceiling))


def effective_cooldown_min(store, risk):
    n = to_number(risk.get("dailyResetCooldownMin"))
    floor = n if (not math.isnan(n) and n != 0) else 0
    ov = _ovr(store, "resetCooldownMin")
    wanted = to_number(ov) if _finite(ov) else floor
    return max(floor, min(wanted, 720))


def reset_cooldown(store, risk, now=None):
    mins = effective_cooldown_min(store, risk)
    if not mins or store is None or not hasattr(store, "daily_reset_info"):
        return {"active": False, "remainMs": 0, "remainMin": 0}
    info = store.daily_reset_info(now)
    if not info["lastAt"]:
        return {"active": False, "remainMs": 0, "remainMin": 0}
    cur = now if truthy(now) else clock.now_ms()
    remain = info["lastAt"] + mins * 60000 - cur
    r = max(0, remain)
    return {"active": remain > 0, "remainMs": r, "remainMin": math.ceil(r / 60000)}


def daily_loss_gate(store, risk, now=None):
    effective = store.daily_pnl_since_reset(now)
    limit = effective_daily_loss_limit(store, risk)
    exceeded = -effective >= limit
    if not exceeded:
        return {"passed": True, "detail": ""}
    info = store.daily_reset_info(now)
    detail = f"當日已實現虧損 {to_fixed(-effective, 2)} USDT 達上限 {num_str(limit)} USDT"
    if info["count"] > 0:
        detail += f"（今日已重置 {info['count']} 次，真實日損 {to_fixed(-info['realisedPnlUsdt'], 2)} USDT）"
    return {"passed": False, "detail": detail}


def _result(gates):
    failed = [g for g in gates if not g["passed"]]
    return {"passed": len(failed) == 0, "gates": gates,
            "reasons": [f"{g['name']}: {g['detail']}" for g in failed]}


def evaluate(signal, store, risk, exchange):
    gates = []

    def add(name, passed, detail=""):
        gates.append({"name": name, "passed": bool(passed), "detail": detail or ""})

    halted = store.is_halted()
    add("kill_switch", not halted, f"系統已停止下單：{store.halted_reason()}" if halted else "")

    dup = store.is_processed(signal["sigId"], exchange)
    if dup:
        outcome = (store.get_processed(signal["sigId"], exchange) or {}).get("outcome")
        add("idempotency", False, f"sig_id {signal['sigId']} 已處理過（{'undefined' if outcome is None else outcome}）")
    else:
        add("idempotency", True)

    ok = signal["grade"] >= risk["minGrade"]
    add("min_grade", ok, "" if ok else f"等級 {num_str(signal['grade'])} 低於下限 {num_str(risk['minGrade'])}")

    tf_ok = str(signal["timeframe"]) in risk["allowedTimeframes"]
    add("timeframe", tf_ok, "" if tf_ok else
        f"週期 {signal['timeframe']} 不在白名單 [{', '.join(risk['allowedTimeframes'])}]")

    loss = daily_loss_gate(store, risk)
    add("daily_loss_limit", loss["passed"], loss["detail"])

    cool = reset_cooldown(store, risk)
    add("reset_cooldown", not cool["active"],
        f"日損重置後冷卻中，還有 {num_str(cool['remainMin'])} 分鐘" if cool["active"] else "")

    open_count = store.open_position_count(exchange)
    max_now = effective_max_concurrent(store, risk)
    under = open_count < max_now
    add("max_concurrent", under, "" if under else f"目前持倉 {open_count} 筆，已達上限 {num_str(max_now)}")

    dup_symbol = store.has_position_for_symbol(signal["symbol"], exchange)
    add("no_duplicate_symbol", not dup_symbol, f"{signal['symbol']} 已有未平倉部位" if dup_symbol else "")
    return _result(gates)


def recheck(signal, store, risk, exchange, allowOverflow=False, addOn=None):
    gates = []

    def add(name, passed, detail=""):
        gates.append({"name": name, "passed": bool(passed), "detail": detail or ""})

    halted = store.is_halted()
    add("kill_switch", not halted, f"系統已停止下單：{store.halted_reason()}" if halted else "")
    loss = daily_loss_gate(store, risk)
    add("daily_loss_limit", loss["passed"], loss["detail"])
    cool = reset_cooldown(store, risk)
    add("reset_cooldown", not cool["active"],
        f"日損重置後冷卻中，還有 {num_str(cool['remainMin'])} 分鐘" if cool["active"] else "")

    open_count = store.open_position_count(exchange)
    max_now = effective_max_concurrent(store, risk)
    if addOn:
        base = next((p for p in store.list_positions(exchange) if p.get("sigId") == addOn["baseSigId"]), None)
        used = len(base["layers"]) if base and isinstance(base.get("layers"), list) else 0
        n = to_number(risk.get("addOnMax"))
        mx = max(0, js_floor(n if (not math.isnan(n) and n != 0) else 0))
        ok = bool(base) and (not truthy(base.get("side")) or base["side"] == signal["side"]) and used < mx
        if ok:
            detail = ""
        elif not base:
            detail = "原部位已不存在（可能已平倉），不加倉"
        elif used >= mx:
            detail = f"已加倉 {used} 次，達上限 {mx}"
        else:
            detail = "方向與原部位不同"
        add("addon_base", ok, detail)
    elif allowOverflow:
        a = overflow_allowance(store, risk, exchange)
        ok = a["openCount"] < a["hardCap"]
        add("max_concurrent", ok, "" if ok else
            f"目前持倉 {a['openCount']} 筆，已達超額硬上限 {num_str(a['hardCap'])}"
            f"（上限 {num_str(a['maxNow'])}＋超額 {num_str(a['hardCap'] - a['maxNow'])}）")
    else:
        ok = open_count < max_now
        add("max_concurrent", ok, "" if ok else f"目前持倉 {open_count} 筆，已達上限 {num_str(max_now)}")

    if not addOn:
        dup_symbol = store.has_position_for_symbol(signal["symbol"], exchange)
        add("no_duplicate_symbol", not dup_symbol, f"{signal['symbol']} 已有未平倉部位" if dup_symbol else "")
    return _result(gates)


_ZH = {"kill_switch": "停止", "idempotency": "冪等", "min_grade": "等級", "timeframe": "週期",
       "daily_loss_limit": "日損", "reset_cooldown": "冷卻", "max_concurrent": "倉數",
       "no_duplicate_symbol": "重複", "addon_base": "加倉"}


def summarise(result):
    return " ".join(("✓" if g["passed"] else "✗") + _ZH.get(g["name"], g["name"]) for g in result["gates"])
