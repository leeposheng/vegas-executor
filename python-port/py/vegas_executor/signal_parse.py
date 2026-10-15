"""訊號解析與驗證（對應 signal.js）。錯誤字串逐字相同。"""
import hashlib
import math
import re

from . import clock
from .jsnum import (is_finite_number, is_number, num_str, to_fixed, to_number,
                    to_string, trim, truthy)

VALID_SIDES = ["long", "short"]
_SIGID_RE = re.compile(r"[A-Za-z0-9._:-]{8,64}")


def parse_signal(raw, nowMs=None, maxAgeSec=None):
    errors = []
    now_ms = clock.now_ms() if nowMs is None else nowMs
    max_age = 60 if maxAgeSec is None else maxAgeSec

    if not isinstance(raw, dict):
        return {"ok": False, "errors": ["payload 不是 JSON 物件"]}

    g = raw.get
    sig_id = trim(g("sig_id")) if isinstance(g("sig_id"), str) else ""
    if not sig_id:
        errors.append("sig_id 缺少或非字串")
    elif not _SIGID_RE.fullmatch(sig_id):
        errors.append("sig_id 格式不合法（僅允許英數與 . _ : -，長度 8-64）")

    symbol = trim(g("symbol")) if isinstance(g("symbol"), str) else ""
    if not symbol:
        errors.append("symbol 缺少或非字串")

    tf = "" if "tf" not in raw else trim(to_string(raw["tf"]))
    if not tf:
        errors.append("tf 缺少")

    side = trim(g("side")).lower() if isinstance(g("side"), str) else ""
    if side not in VALID_SIDES:
        errors.append("side 必須是 long 或 short")

    if not is_finite_number(g("ts")):
        errors.append("ts 缺少或非數字（需為毫秒時間戳）")
    if not is_finite_number(g("entry")):
        errors.append("entry 缺少或非數字")
    if not is_finite_number(g("sl")):
        errors.append("sl 缺少或非數字")

    grade = to_number(g("grade"))
    if grade not in (1, 2, 3):
        errors.append("grade 必須是 1、2 或 3")

    score = None
    if g("score") is not None:
        score = to_number(g("score"))
        if not math.isfinite(score) or score < 0 or score > 100:
            errors.append("score 若提供，必須是 0-100 的數字")

    tp = g("tp") if isinstance(g("tp"), list) else None
    if not tp:
        errors.append("tp 必須是非空陣列")
    elif not all(is_finite_number(t) for t in tp):
        errors.append("tp 內含非數字")

    if errors:
        return {"ok": False, "errors": errors}

    entry = raw["entry"]
    sl = raw["sl"]
    if entry <= 0:
        errors.append("entry 必須大於 0")
    if sl <= 0:
        errors.append("sl 必須大於 0")
    if side == "long" and sl >= entry:
        errors.append(f"做多訊號的 sl({num_str(sl)}) 必須低於 entry({num_str(entry)})")
    if side == "short" and sl <= entry:
        errors.append(f"做空訊號的 sl({num_str(sl)}) 必須高於 entry({num_str(entry)})")

    risk_distance = abs(entry - sl)
    if risk_distance < entry * 0.0002:
        errors.append(f"風險距離過小（{num_str(risk_distance)}），可能是資料錯誤")

    for i, t in enumerate(tp):
        if side == "long" and t <= entry:
            errors.append(f"tp[{i}]={num_str(t)} 未在做多的獲利方向")
        if side == "short" and t >= entry:
            errors.append(f"tp[{i}]={num_str(t)} 未在做空的獲利方向")
        if i > 0:
            ordered = t > tp[i - 1] if side == "long" else t < tp[i - 1]
            if not ordered:
                errors.append(f"tp[{i}] 未依由近而遠排序")

    age_sec = (now_ms - raw["ts"]) / 1000
    if age_sec > max_age:
        errors.append(f"訊號已過期 {to_fixed(age_sec, 1)} 秒（上限 {num_str(max_age)} 秒）")
    if age_sec < -30:
        errors.append(f"訊號時間戳位於未來 {to_fixed(-age_sec, 1)} 秒，請檢查送訊端時鐘")

    if errors:
        return {"ok": False, "errors": errors}

    return {
        "ok": True,
        "signal": {
            "version": to_string(raw["v"] if truthy(g("v")) else "unknown"),
            "sigId": sig_id,
            "tsMs": raw["ts"],
            "ageSec": age_sec,
            "symbol": symbol,
            "timeframe": tf,
            "grade": grade,
            "score": score,
            "side": side,
            "entry": entry,
            "sl": sl,
            "tp": list(tp),
            "riskDistance": risk_distance,
        },
    }


def client_order_id(sigId, prefix=None) -> str:
    h = hashlib.sha256(to_string(sigId).encode("utf-8")).hexdigest()
    return ((to_string(prefix) if truthy(prefix) else "vg") + h)[:32]
