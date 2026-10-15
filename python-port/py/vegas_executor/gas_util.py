"""Code.gs 共用小工具的忠實移植（UTF-16 長度、JS 的 String()／truthy／trim／JSON.stringify 語意）。

GAS 字串長度以 UTF-16 code unit 計（emoji 算 2），截斷、前 80 字等判斷都依此；Python 預設以 code point 計，
所以截斷類函式一律經 UTF-16 轉換。
"""
import hashlib
import hmac
import json
import math
import re

from .jsnum import _WS

JS_WS = re.escape(_WS)


def u16(s):
    return s.encode("utf-16-le", "surrogatepass")


def from_u16(b):
    return b.decode("utf-16-le", "surrogatepass")


def js_len(s):
    return len(u16(s)) // 2


def js_slice(s, a, b=None):
    n = js_len(s)
    b = n if b is None else b
    a = max(0, n + a) if a < 0 else min(a, n)
    b = max(0, n + b) if b < 0 else min(b, n)
    return from_u16(u16(s)[2 * a:2 * max(a, b)])


def js_String(v):
    """JS String(v)。"""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        if v == int(v) and abs(v) < 1e21:
            return str(int(v))
    return v if isinstance(v, str) else str(v)


def js_truthy(v):
    if v is None or v is False or v == 0 and not isinstance(v, (list, dict, str)) or v == "":
        return False
    if isinstance(v, float) and math.isnan(v):
        return False
    return True


def js_str(v):
    """String(v || "")。"""
    return js_String(v) if js_truthy(v) else ""


def js_trim(s):
    return s.strip(_WS)


def js_json(obj):
    """JSON.stringify：緊湊、不轉義非 ASCII；孤立代理字元轉成 \\udXXX。"""
    out = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return re.sub("[\ud800-\udfff]", lambda m: "\\u%04x" % ord(m.group()), out)


def truncate(value, max_length):
    text = js_str(value)
    return text if js_len(text) <= max_length else js_slice(text, 0, max_length) + "…"


def redact(value):
    s = js_str(value)
    s = re.sub(r"bot[0-9]+:[A-Za-z0-9_-]+", "bot[REDACTED]", s, flags=re.A)
    s = re.sub(r"sk-ant-[A-Za-z0-9_-]+", "sk-ant-[REDACTED]", s, flags=re.A)
    s = re.sub(r"([?&](?:key|token|secret)=)[^&" + JS_WS + r'"]+', r"\1[REDACTED]", s, flags=re.A | re.I)
    return js_slice(s, 0, 700)


def safe_equals(left, right):
    a, b = js_str(left), js_str(right)
    return hmac.compare_digest(a.encode("utf-8", "surrogatepass"), b.encode("utf-8", "surrogatepass"))


def sha256_hex(text):
    return hashlib.sha256(js_String(text).encode("utf-8", "replace")).hexdigest()


def split_text(text, max_length):
    chars = js_String(text)
    n = len(chars)
    chunks, offset = [], 0
    while offset < n:
        end = min(offset + max_length, n)
        if end < n:
            newline = end
            while newline > offset + int(max_length * 0.6):
                if chars[newline - 1] == "\n":
                    end = newline
                    break
                newline -= 1
        chunks.append(chars[offset:end])
        offset = end
    return chunks if chunks else [""]


def is_expected_signal(signal_text):
    text = js_str(signal_text)
    ws = JS_WS
    return (("《維加斯訊號》交易訊號" in js_slice(text, 0, 80))
            and re.search(r"\[幣種\][" + ws + r"]*[^\r\n]+", text) is not None
            and re.search(r"\[週期\][" + ws + r"]*[^\r\n]+", text) is not None
            and re.search(r"\[方向\][" + ws + r"]*(做多|做空)", text) is not None)


def parse_float(s):
    """JS parseFloat：取最長合法數字前綴；沒有則 NaN。"""
    m = re.match(r"[" + JS_WS + r"]*([+-]?(?:Infinity|[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?))", js_String(s))
    if not m:
        return float("nan")
    t = m.group(1)
    return float(t.replace("Infinity", "inf"))
