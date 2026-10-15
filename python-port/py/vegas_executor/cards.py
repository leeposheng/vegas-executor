"""Executor.gs 的「文字 → JSON」與「卡片文字」的忠實移植（模組 B-1）。

JS 語意要點：欄位缺漏（undefined）與 null 在字串串接時分別是 "undefined"／"null"（例如自動槓桿的「原 undefinedx」），
所以這裡用 UNDEF 哨兵區分；數字一律走 jsnum.num_str／to_fixed，與 Node 的輸出逐字相同。
"""
import math
import re

from . import clock
from .gas_util import JS_WS, js_str, js_trim, js_truthy, parse_float
from .jsnum import js_round, num_str, to_fixed, to_string

SIG_ID_LENGTH = 48
SEP = "─" * 13
UNDEF = object()


def _cat(v):
    """JS 字串串接時的值：undefined→"undefined"、null→"null"。"""
    if v is UNDEF:
        return "undefined"
    return to_string(v)


def _num(v):
    """JS Number(v)（涵蓋 JSON 值與 undefined）。"""
    if v is UNDEF:
        return float("nan")
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = js_trim(str(v))
    if s == "":
        return 0.0
    f = parse_float(s)
    return f if re.fullmatch(r"[+-]?(Infinity|[0-9]+\.?[0-9]*([eE][+-]?[0-9]+)?|\.[0-9]+([eE][+-]?[0-9]+)?)", s) else float("nan")


def _join(lst, sep):
    return sep.join("" if x is None else to_string(x) for x in (lst or []))


# ---------------- 文字 → JSON ----------------
def extract_field(text, label):
    m = re.search(r"\[" + label + r"\][" + JS_WS + r"]*([^\r\n]+)", js_str(text))
    return js_trim(m.group(1)) if m else None


def parse_price(raw):
    if raw is None:
        return None
    n = parse_float(to_string(raw).replace(",", ""))
    return n if math.isfinite(n) else None


def tf_text_to_minutes(text):
    t = js_trim(js_str(text))
    m = re.match(r"([0-9]+(?:\.[0-9]+)?)分鐘\Z", t)
    if m:
        return num_str(js_round(float(m.group(1))))
    m = re.match(r"([0-9]+(?:\.[0-9]+)?)小時\Z", t)
    if m:
        return num_str(js_round(float(m.group(1)) * 60))
    if t == "日線":
        return "1440"
    m = re.match(r"([0-9]+)日\Z", t)
    if m:
        return num_str(float(m.group(1)) * 1440)
    if t == "週線":
        return "10080"
    m = re.match(r"([0-9]+)週\Z", t)
    if m:
        return num_str(float(m.group(1)) * 10080)
    if re.fullmatch(r"[0-9]+", t):
        return t
    m = re.match(r"([0-9]*)[Dd]\Z", t)
    if m:
        return num_str((float(m.group(1) or 0) or 1) * 1440)
    m = re.match(r"([0-9]*)[Ww]\Z", t)
    if m:
        return num_str((float(m.group(1) or 0) or 1) * 10080)
    return None


def grade_text_to_number(text):
    return {"高品質": 3, "標準": 2, "弱訊": 1}.get(js_trim(js_str(text)))


def parse_price_unit(raw):
    if raw is None:
        return ""
    m = re.search(r"[0-9.,]+[" + JS_WS + r"]*([A-Za-z][A-Za-z0-9]*)", to_string(raw))
    return m.group(1) if m else ""


def parse_score_field(text):
    raw = extract_field(text, "分數")
    if raw is None:
        return {"score": None, "demote": None}
    n = parse_float(raw.replace(",", ""))
    m = re.search(r"降級[：:][" + JS_WS + r"]*([^）)]+)", raw)
    return {"score": n if (math.isfinite(n) and 0 <= n <= 100) else None,
            "demote": js_trim(m.group(1)) if m else None}


def parse_signal_to_json(signal_text, sig_id, now_ms=None):
    text = js_str(signal_text)
    errors = []
    symbol = extract_field(text, "幣種")
    if not symbol:
        errors.append("找不到 [幣種]")
    tf_raw = extract_field(text, "週期")
    tf = tf_text_to_minutes(tf_raw)
    if not tf_raw:
        errors.append("找不到 [週期]")
    elif not tf:
        errors.append("無法解析週期「" + tf_raw + "」（不支援秒級與月線）")
    grade_raw = extract_field(text, "品質")
    grade = grade_text_to_number(grade_raw)
    if not grade_raw:
        errors.append("找不到 [品質]")
    elif not grade:
        errors.append("無法解析品質「" + grade_raw + "」")
    score_info = parse_score_field(text)
    dir_raw = extract_field(text, "方向")
    side = None
    if not dir_raw:
        errors.append("找不到 [方向]")
    elif "做多" in dir_raw:
        side = "long"
    elif "做空" in dir_raw:
        side = "short"
    else:
        errors.append("無法解析方向「" + dir_raw + "」")
    entry_raw = extract_field(text, "價格")
    entry = parse_price(entry_raw)
    if entry is None:
        errors.append("找不到或無法解析 [價格]")
    quote = parse_price_unit(entry_raw)
    sl = parse_price(extract_field(text, "止損"))
    if sl is None:
        errors.append("找不到或無法解析 [止損]")
    tp = []
    for i in (1, 2, 3):
        v = parse_price(extract_field(text, "止盈" + str(i)))
        if v is not None:
            tp.append(v)
    if not tp:
        errors.append("找不到任何 [止盈N]")
    if errors:
        return {"ok": False, "errors": errors}
    if side == "long" and sl >= entry:
        errors.append("做多訊號的止損 " + num_str(sl) + " 未低於進場價 " + num_str(entry))
    if side == "short" and sl <= entry:
        errors.append("做空訊號的止損 " + num_str(sl) + " 未高於進場價 " + num_str(entry))
    if errors:
        return {"ok": False, "errors": errors}
    sid = re.sub(r"^tv:", "", js_str(sig_id))[:SIG_ID_LENGTH]
    return {"ok": True, "payload": {
        "v": "11.9", "sig_id": sid, "ts": clock.now_ms() if now_ms is None else now_ms, "symbol": symbol, "tf": tf,
        "grade": grade, "tf_text": tf_raw, "grade_text": grade_raw, "quote": quote, "tz": extract_field(text, "時區"),
        "score": score_info["score"], "demote": score_info["demote"], "side": side, "entry": entry, "sl": sl, "tp": tp}}


# ---------------- 卡片 ----------------
def is_observable(result):
    if result.get("decision") != "rejected":
        return False
    if js_truthy(result.get("band")) or result.get("band") == {}:
        return True
    why = _join(result.get("reasons"), " ") if js_truthy(result.get("reasons")) or result.get("reasons") == [] else ""
    return "min_grade" in why or "等級" in why or "timeframe" in why


def card_head(result):
    d = result.get("decision")
    dry = js_truthy(result.get("dryRun"))
    if d == "placed":
        return "🧪 已下單（DRY_RUN，未真的送出）" if dry else "✅ 已自動下單"
    if d == "rejected":
        return "👀 可觀察" if is_observable(result) else "⛔ 未執行"
    if d == "skipped":
        return "⏭ 已略過"
    if d == "error":
        return "⚠️ 結果未知，請到交易所確認"
    if d == "pending" and _truthy_obj(result.get("addOn")):
        return "➕ 加倉機會" + ("（DRY_RUN）" if dry else "")
    if d == "pending" and _truthy_obj(result.get("overLimit")):
        return "🟡 已達持倉上限" + ("（DRY_RUN）" if dry else "")
    return "🧪 待確認（DRY_RUN，不會真的下單）" if dry else "⏳ 待確認"


def _truthy_obj(v):
    return v is not None and v is not False and (v == {} or js_truthy(v))


def render_pending_card(payload, result, original_text, for_broadcast=False):
    sz = {} if for_broadcast else (result.get("sizing") if _truthy_obj(result.get("sizing")) else {})
    dir_text = "做多⬆" if payload.get("side") == "long" else "做空⬇"
    qty_unit = "張" if sz.get("unit") == "contracts" else "幣"
    u = " " + payload["quote"] if js_truthy(payload.get("quote")) else ""
    when = extract_field(original_text, "時間") if js_truthy(original_text) else None

    quality = payload.get("grade_text") if js_truthy(payload.get("grade_text")) else (_cat(payload.get("grade", UNDEF)) + "★")
    note = []
    score = payload.get("score", UNDEF)
    if score is not None and score is not UNDEF:
        note.append(to_string(score))
    if js_truthy(payload.get("demote")):
        note.append("降級：" + payload["demote"])
    if note:
        quality += "（" + "｜".join(note) + "）"

    lines = [("📡 維加斯訊號" if for_broadcast else card_head(result)) + "｜" + dir_text, SEP]
    if when:
        lines.append("[時間] " + when)
    lines.append("[幣種] " + _cat(payload.get("symbol", UNDEF)))
    lines.append("[週期] " + (payload["tf_text"] if js_truthy(payload.get("tf_text")) else _cat(payload.get("tf", UNDEF)) + " 分鐘"))
    lines.append("[品質] " + quality)
    lines.append("[價格] " + _cat(payload.get("entry", UNDEF)) + u)
    lines.append("[止損] " + _cat(payload.get("sl", UNDEF)) + u)
    for i, v in enumerate(payload.get("tp") or []):
        lines.append("[止盈" + str(i + 1) + "] " + _cat(v) + u)

    if "orderQty" in sz:
        lines.append(SEP)
        lines.append("[風險] " + to_fixed(_num(sz.get("actualRiskUsdt", UNDEF)), 2) + " USDT"
                     + "（" + ("上限 " if js_truthy(sz.get("riskBudgetIsCap")) else "預算 ")
                     + to_fixed(_num(sz.get("riskAmountUsdt", UNDEF)), 2) + "）")
        lev, base_lev = sz.get("leverage"), sz.get("baseLeverage")
        lev_text = "｜槓桿 " + _cat(sz.get("leverage")) + "x" if js_truthy(lev) else ""
        base_m, target_m = sz.get("baseMarginUsdt"), sz.get("targetMarginUsdt")
        changed = ((js_truthy(base_lev) and js_truthy(lev) and lev != base_lev)
                   or (js_truthy(base_m) and js_truthy(target_m) and to_fixed(_num(target_m), 0) != to_fixed(_num(base_m), 0)))
        if changed:
            lev_text += ("（自動，原 " + _cat(sz.get("baseLeverage", UNDEF)) + "x"
                         + ("：" + _cat(sz.get("leverageNote")) if js_truthy(sz.get("leverageNote")) else "") + "）")
        lines.append("[名目] " + to_fixed(_num(sz.get("notionalUsdt", UNDEF)), 2) + " USDT" + lev_text)
        if js_truthy(target_m) and js_truthy(base_m) and _num(target_m) > _num(base_m):
            lines.append("[保證金] " + to_fixed(_num(target_m), 0) + " USDT（預設 " + to_fixed(_num(base_m), 0) + "）")
        lines.append("[數量] " + _cat(sz.get("orderQty")) + " " + qty_unit)

    eq = result.get("equity")
    if not for_broadcast and _truthy_obj(eq) and js_truthy(eq.get("note")):
        lines.append("⚠️ " + eq["note"])

    add_on = result.get("addOn")
    if not for_broadcast and result.get("decision") == "pending" and _truthy_obj(add_on):
        upl_raw = add_on.get("upl", UNDEF)
        upl = None if (upl_raw is None or upl_raw is UNDEF) else _num(upl_raw)
        lines.append(SEP)
        lines.append("[加倉] 已持有" + ("做空" if add_on.get("baseSide") == "short" else "做多") + "部位"
                     + ("（進場 " + _cat(add_on.get("baseEntry")) + "）" if js_truthy(add_on.get("baseEntry")) else "")
                     + ("，未實現 " + ("+" if upl >= 0 else "") + to_fixed(upl, 2) + " USDT" if upl is not None else ""))
        lines.append("[次數] 第 " + _cat(add_on.get("layerNo", UNDEF)) + " 次加倉（上限 " + _cat(add_on.get("max", UNDEF)) + "）"
                     + ("｜沿用原部位槓桿 " + _cat(add_on.get("lever")) + "x" if js_truthy(add_on.get("lever")) else ""))
        lines.append("這筆有自己的止損止盈，只作用在加倉的數量上。")

    over = result.get("overLimit")
    if not for_broadcast and result.get("decision") == "pending" and _truthy_obj(over):
        oc = over.get("openCount", UNDEF)
        lines.append(SEP)
        lines.append("[持倉] 目前 " + _cat(oc) + " 筆／上限 " + _cat(over.get("maxNow", UNDEF))
                     + "，超額進場將開第 " + num_str(_num(oc) + 1) + " 筆（硬上限 " + _cat(over.get("hardCap", UNDEF)) + "）")

    reasons = result.get("reasons")
    if not for_broadcast and result.get("decision") == "rejected" and isinstance(reasons, list) and len(reasons) > 0:
        lines.append(SEP)
        lines.append("[原因] " + _join(reasons, "；"))
        pv = result.get("preview")
        if _truthy_obj(pv):
            rr = pv.get("rr", UNDEF)
            if rr is not UNDEF and rr is not None:
                eff = "[效益] TP1 損益比 " + to_fixed(_num(rr), 2) + ":1"
                be = pv.get("breakeven", UNDEF)
                if be is not None and be is not UNDEF:
                    eff += "，打平勝率 " + to_fixed(_num(be) * 100, 1) + "%"
                else:
                    eff += "（扣費後為負，照劇本走也不賺）"
                lines.append(eff)
            if js_truthy(pv.get("suggestLeverage")):
                lines.append("[建議] 槓桿降到 " + _cat(pv.get("suggestLeverage")) + "x 可回到上限內")

    if for_broadcast:
        lines.append(SEP)
        lines.append("⚠️ 僅供參考，非投資建議")
    return "\n".join(lines)
