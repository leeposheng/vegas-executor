"""進場價漂移檢查（對應 drift.js）。"""
import math

from .jsnum import fixed_num, num_str, to_fixed, to_number


def assess_drift(signal, livePrice, limits):
    is_long = signal.get("side") == "long"
    entry = to_number(signal.get("entry"))
    sl = to_number(signal.get("sl"))
    live = to_number(livePrice)
    metrics = {"entry": entry, "sl": sl, "livePrice": live}

    if not math.isfinite(live) or live <= 0:
        return {"ok": False, "verdict": "no_price", "metrics": metrics,
                "reason": "無法取得現價，拒絕下單。以無法驗證的價格計算倉位，正是這道檢查要防的事。"}

    original = abs(entry - sl)
    if not (original > 0):
        return {"ok": False, "verdict": "invalid", "metrics": metrics, "reason": "原始風險距離為 0"}

    drift_r = ((live - entry) if is_long else (entry - live)) / original
    metrics["originalDistance"] = fixed_num(original, 8)
    metrics["driftR"] = fixed_num(drift_r, 4)
    metrics["driftPct"] = fixed_num(((live - entry) / entry) * 100, 4)

    crossed = live <= sl if is_long else live >= sl
    if crossed:
        return {"ok": False, "verdict": "sl_crossed", "metrics": metrics,
                "reason": f"現價 {num_str(live)} 已穿過止損 {num_str(sl)}，這筆訊號的前提已不成立"}

    tps = signal.get("tp")
    tp1 = to_number(tps[0]) if isinstance(tps, list) and len(tps) else None
    if tp1 is not None and math.isfinite(tp1):
        passed = live >= tp1 if is_long else live <= tp1
        if passed:
            return {"ok": False, "verdict": "tp1_passed", "metrics": metrics,
                    "reason": f"現價 {num_str(live)} 已達第一目標 {num_str(tp1)}，此時進場等同追價"}

    new_distance = abs(live - sl)
    ratio = new_distance / original
    metrics["newDistance"] = fixed_num(new_distance, 8)
    metrics["distanceRatio"] = fixed_num(ratio, 4)
    metrics["qtyRatio"] = fixed_num(1 / ratio, 4) if ratio != 0 else float("inf")

    max_widen = limits["maxWiden"]
    max_tighten = limits["maxTighten"]
    if ratio > max_widen:
        return {"ok": False, "verdict": "drifted_against", "metrics": metrics,
                "reason": f"進場價已偏離 {to_fixed(drift_r, 2)}R，風險距離放大為原本的 "
                          f"{to_fixed(ratio, 2)} 倍（上限 {num_str(max_widen)}）。若照原數量下單，"
                          f"實際風險會是預算的 {to_fixed(ratio, 2)} 倍"}
    if ratio < max_tighten:
        return {"ok": False, "verdict": "drifted_toward", "metrics": metrics,
                "reason": f"現價已接近止損，風險距離縮為原本的 {to_fixed(ratio, 2)} 倍"
                          f"（下限 {num_str(max_tighten)}）。重算會把數量放大到 {to_fixed(1 / ratio, 2)} 倍，"
                          f"更大的倉位配更近的止損，不是原本核准的那筆交易"}

    return {"ok": True, "verdict": "unchanged" if ratio == 1 else "resize", "metrics": metrics}
