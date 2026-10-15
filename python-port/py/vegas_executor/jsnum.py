"""JavaScript 數字語意的忠實複製（SPEC §3.1、§7）。

Node 版的輸出（toFixed、Number→String、Number()、Math.round）有幾處與 Python
預設不同，而且會進到簽章、卡片文字與風控比較。集中在這裡處理。
"""
import math
from decimal import Decimal, ROUND_HALF_UP, localcontext

_WS = " \t\n\r\x0b\x0c                 　﻿"
NAN = float("nan")
INF = float("inf")


def is_number(v) -> bool:
    """JS typeof v === 'number'（JSON 的 bool 不算）。"""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_finite_number(v) -> bool:
    return is_number(v) and math.isfinite(v)


def trim(s: str) -> str:
    return s.strip(_WS)


def to_fixed(x, digits: int) -> str:
    """Number.prototype.toFixed：以「精確十進位展開」做 ROUND_HALF_UP。"""
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        x = 0.0  # (-0).toFixed(2) === "0.00"
    with localcontext() as ctx:
        ctx.prec = 400
        q = Decimal(1).scaleb(-digits)
        s = str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))
    return s


def fixed_num(x, digits: int) -> float:
    """Number(x.toFixed(digits))。"""
    return float(to_fixed(x, digits))


def round4(x) -> float:
    return fixed_num(x, 4)


def js_round(x) -> float:
    """Math.round：.5 往 +∞。"""
    return math.floor(x + 0.5)


def js_floor(x):
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return x
    return math.floor(x)


def div(a, b):
    """JS 的除法（除以 0 得 ±Infinity／NaN，不拋例外）。"""
    a = float(a)
    b = float(b)
    if b == 0:
        if a == 0 or math.isnan(a):
            return NAN
        neg = (a < 0) != (math.copysign(1.0, b) < 0)
        return -INF if neg else INF
    return a / b


def num_str(x) -> str:
    """JS 的 String(number)／模板字串內插。"""
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        x = float(x) if abs(x) >= 10 ** 21 else x
        if isinstance(x, int):
            return str(x)
    x = float(x)
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    r = repr(abs(x))  # 最短可往返表示，與 JS 位數相同
    # 取出數字字串 digits 與十進位指數 n（值 = 0.digits × 10^n）
    if "e" in r:
        mant, exp = r.split("e")
        exp = int(exp)
    else:
        mant, exp = r, 0
    if "." in mant:
        ip, fp = mant.split(".")
    else:
        ip, fp = mant, ""
    digits = (ip + fp).lstrip("0")
    lead_zeros = len(ip + fp) - len((ip + fp).lstrip("0"))
    n = len(ip) - lead_zeros + exp
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        es = ("+" if e >= 0 else "-") + str(abs(e))
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + es
    return sign + out


def to_string(v) -> str:
    """JS 的 String(v)（涵蓋 JSON 可能出現的型別）。"""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if is_number(v):
        return num_str(v)
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ",".join("" if x is None else to_string(x) for x in v)
    return "[object Object]"


def to_number(v) -> float:
    """JS 的 Number(v)。"""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if is_number(v):
        return float(v)
    if isinstance(v, str):
        s = trim(v)
        if s == "":
            return 0.0
        try:
            if s.lower().startswith(("0x", "0o", "0b")):
                return float(int(s, 0))
            if s in ("Infinity", "+Infinity"):
                return INF
            if s == "-Infinity":
                return -INF
            if any(c in s for c in "nN_") or s.lower() in ("inf", "+inf", "-inf", "infinity", "nan"):
                return NAN
            return float(s)
        except ValueError:
            return NAN
    if isinstance(v, list):
        if len(v) == 0:
            return 0.0
        if len(v) == 1:
            return to_number(v[0] if v[0] is not None else "")
        return NAN
    return NAN


def truthy(v) -> bool:
    """JS 真值判斷（用於 a || b）。"""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return not (v == 0 or (isinstance(v, float) and math.isnan(v)))
    if isinstance(v, str):
        return v != ""
    return True


def js_json(v) -> str:
    """JSON.stringify（無縮排）：數字走 JS 格式，非 ASCII 不跳脫。簽章用。"""
    import json as _json
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if is_number(v):
        if isinstance(v, float) and not math.isfinite(v):
            return "null"
        return num_str(v)
    if isinstance(v, str):
        return _json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join("null" if x is None else js_json(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(_json.dumps(str(k), ensure_ascii=False) + ":" + js_json(x)
                              for k, x in v.items() if x is not None) + "}"
    raise TypeError(type(v))
