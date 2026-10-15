"""由 Telegram 匯出檔（result.json）的決策卡重建訊號與預期值，供 replay 使用。

卡片已包含訊號輸入（代碼／方向／週期／等級／進出場價）與 Node 當時的輸出（數量／風險／名目／槓桿，
或拒絕／可觀察原因），所以不必另外蒐集資料。時間一律視為 Asia/Taipei。

限制
  * 每張卡獨立重放（空狀態）：持倉數、當日虧損、停止下單、重複代碼屬狀態相依，標為「狀態相依」。
  * 設定會隨時期改變：以 --eras 檔（{"2026-10-11": {"FIXED_MARGIN_USDT": "50", ...}}）指定，
    取「不晚於卡片日期」的最後一個時期；週期白名單／最低等級／虧損下限另會從卡片自己的拒絕原因讀出。
  * 合約規格優先用 OKX 公開 instruments；沒給就由卡片數字反推（報告會標明 specs=inferred）。
"""
import json
import math
import re
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))
GRADE = {"弱訊": 1, "標準": 2, "高品質": 3}
TITLES = (("⏳ 待確認", "pending"), ("✅ 已自動下單", "placed"), ("⛔ 未執行", "rejected"), ("👀 可觀察", "watch"),
          ("⏭ 已略過", "skipped_card"), ("✅ 已進場", "confirmed_card"), ("⌛ 已失效", "expired_card"),
          ("👍 已確認", "confirmed_dry"), ("🧪 已下單", "dry_placed"))
ACCEPT_KINDS = ("pending", "placed", "skipped_card", "confirmed_card", "expired_card", "dry_placed", "confirmed_dry")
REJECT_KINDS = ("rejected", "watch")
STATE_GATES = ("kill_switch", "max_concurrent", "no_duplicate_symbol", "daily_loss", "idempotency")

DEFAULT_ERA = {"SIZING_MODE": "fixed_margin", "FIXED_MARGIN_USDT": "50", "TARGET_LOSS_MIN_USDT": "10",
               "TARGET_LOSS_MAX_USDT": "22", "LEVERAGE": "40", "AUTO_LEVERAGE": "true", "MIN_LIQ_CUSHION": "3"}


def _text(m):
    t = m.get("text")
    if isinstance(t, list):
        return "".join(x if isinstance(x, str) else x.get("text", "") for x in t)
    return t or ""


def _field(t, name):
    m = re.search(r"\[" + name + r"\]\s*(.+)", t)
    return m.group(1).strip() if m else None


def _num(s):
    if s is None:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", s.replace(",", ""))
    return float(m.group()) if m else None


def parse_card(m):
    t = _text(m)
    if "[價格]" not in t or "[止損]" not in t or "[幣種]" not in t:
        return None
    kind = next((v for k, v in TITLES if t.startswith(k)), None)
    if kind is None:
        return None
    mm = re.search(r"做(多|空)", t)
    side = {"多": "long", "空": "short"}.get(mm.group(1)) if mm else None
    tf_s = _field(t, "週期") or ""
    n = _num(tf_s)
    tf = None if n is None else (int(n * 60) if "小時" in tf_s else int(n))
    q = _field(t, "品質") or ""
    lm = re.match(r"[^（(]+", q)
    sm = re.search(r"[（(](\d+)", q)
    dt = _field(t, "時間")
    ts = None
    if dt:
        mt = re.match(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2})", dt)
        if mt:
            ts = int(datetime.strptime(mt.group(1), "%Y-%m-%d %H:%M").replace(tzinfo=TZ).timestamp() * 1000)
    notional = _field(t, "名目") or ""
    lev = re.search(r"槓桿\s*(\d+)x", notional)
    return {"id": m.get("id"), "date": m.get("date", ""), "kind": kind, "symbol": _field(t, "幣種"), "side": side,
            "tf": tf, "label": lm.group().strip() if lm else "", "score": float(sm.group(1)) if sm else None,
            "ts": ts, "entry": _num(_field(t, "價格")), "sl": _num(_field(t, "止損")),
            "tp": [_num(_field(t, f"止盈{i}")) for i in (1, 2, 3) if _field(t, f"止盈{i}")],
            "risk": _num(_field(t, "風險")), "notional": _num(notional), "lev": int(lev.group(1)) if lev else None,
            "qty": _num(_field(t, "數量")), "reason": _field(t, "原因")}


def load_cards(path, since=None):
    """讀 Telegram 匯出檔 → 去重後的卡片（同代碼＋時間＋方向只留第一張）。"""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    seen, out = set(), []
    for m in data.get("messages", []):
        c = parse_card(m)
        if not c or not (c["ts"] and c["entry"] and c["sl"] and c["side"] and c["label"] in GRADE):
            continue
        if since and c["date"][:10] < since:
            continue
        k = (c["symbol"], c["ts"], c["side"])
        if k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


def card_signal(c):
    return {"v": "11.9", "sig_id": f"{c['symbol']}-{c['tf']}-{c['ts']}-{c['side']}", "ts": c["ts"],
            "symbol": c["symbol"], "tf": str(c["tf"]), "grade": GRADE[c["label"]], "score": c["score"] or 50,
            "side": c["side"], "entry": c["entry"], "sl": c["sl"], "tp": c["tp"]}


def era_env(eras, date):
    """eras：{起始日: env}。取不晚於 date 的最後一個；沒有任何時期就用預設（2026-10 的推定值）。"""
    if not eras:
        return dict(DEFAULT_ERA)
    keys = sorted(k for k in eras if k <= date[:10])
    return dict(eras[keys[-1]]) if keys else None


def reason_env(c):
    """卡片自己的拒絕原因就是當時設定的證據：白名單週期、最低等級、虧損下限。"""
    r = c.get("reason") or ""
    env = {}
    m = re.search(r"週期 \d+ 不在白名單 \[([\d, ]+)\]", r)
    if m:
        env["ALLOWED_TIMEFRAMES"] = m.group(1).replace(" ", "")
    m = re.search(r"等級 \d+ 低於下限 (\d+)", r)
    if m:
        env["MIN_GRADE"] = m.group(1)
    m = re.search(r"超過上限 ([\d.]+) USDT", r)
    if m:
        env["TARGET_LOSS_MAX_USDT"] = m.group(1)
    m = re.search(r"虧損 [\d.]+ < 下限 ([\d.]+)", r)
    if m:
        env["TARGET_LOSS_MIN_USDT"] = m.group(1)
    return env


def inst_id(symbol):
    return symbol.replace("USDT.P", "") + "-USDT-SWAP"


def infer_specs(cards):
    """由卡片的 名目／(價格×數量) 反推 ctVal，由數量小數位反推 lotSz（取各卡最小）。"""
    cand = [10.0 ** e for e in range(-4, 6)]
    specs = {}
    for c in cards:
        if not (c.get("qty") and c.get("notional") and c.get("entry")):
            continue
        ct = c["notional"] / (c["entry"] * c["qty"])
        if ct <= 0:
            continue
        ctv = min(cand, key=lambda x: abs(math.log(ct / x)))
        q = float(c["qty"])
        dec = 0 if q.is_integer() else len(repr(q).split(".")[1])
        s = specs.setdefault(inst_id(c["symbol"]), {"instId": inst_id(c["symbol"]), "ctVal": ctv, "lotSz": 10.0 ** -dec,
                                                    "minSz": 10.0 ** -dec, "settleCcy": "USDT", "state": "live", "tickSz": 0.0001})
        s["lotSz"] = s["minSz"] = min(s["lotSz"], 10.0 ** -dec)
    return specs


def specs_from_okx(js):
    """OKX 回應（{"data":[...]}）、清單或 {instId: spec} 皆可。"""
    rows = js.get("data") if isinstance(js, dict) and "data" in js else js
    if isinstance(rows, dict):
        rows = [dict(v, instId=v.get("instId", k)) for k, v in rows.items()]
    out = {}
    for d in rows or []:
        iid = d.get("instId")
        if not iid or not iid.endswith("-USDT-SWAP"):
            continue
        try:   # 未上市／下架的合約欄位可能是空字串：略過，不讓整批失敗
            out[iid] = {"instId": iid, "ctVal": float(d["ctVal"]), "lotSz": float(d["lotSz"]), "minSz": float(d["minSz"]),
                        "settleCcy": d.get("settleCcy", "USDT"), "state": d.get("state", "live"),
                        "tickSz": float(d.get("tickSz") or 0.0001)}
        except (KeyError, TypeError, ValueError):
            continue
    return out


def gate_of(reason_text):
    for g in STATE_GATES:
        if g in (reason_text or ""):
            return g
    return None


def compare(c, got):
    """回傳 (status, 差異)。status：match／state／diff。"""
    sz = got.get("sizing") or {}
    py_reason = "；".join(got.get("reasons") or [])
    diffs = []
    if c["kind"] in ACCEPT_KINDS:
        if got.get("decision") not in ("pending", "placed"):
            diffs.append(f"decision: Python={got.get('decision')} 卡片={c['kind']}（{py_reason[:80]}）")
        else:
            for name, a, b, tol in (("qty", sz.get("orderQty"), c["qty"], 1e-9),
                                    ("risk", sz.get("actualRiskUsdt"), c["risk"], 0.006)):
                if b is not None and (a is None or abs(a - b) > tol):
                    diffs.append(f"{name}: Python={a} 卡片={b}")
    else:
        if got.get("decision") in ("pending", "placed"):
            diffs.append(f"decision: Python={got.get('decision')} 卡片={c['kind']}（{c['reason']}）")
        elif (c.get("reason") or "") != py_reason:
            diffs.append(f"原因: Python={py_reason!r} 卡片={c.get('reason')!r}")
    if not diffs:
        return "match", []
    if c["kind"] == "rejected" and c.get("qty") and not c.get("reason") and got.get("decision") in ("pending", "placed"):
        # 卡片已算出數量卻「未執行」且沒有決策原因：是下單階段（交易所／餘額）失敗，不是決策邏輯
        return "runtime", diffs + ["（數量與風險一致；Node 在下單階段失敗，非決策差異）"] if (
            sz.get("orderQty") == c["qty"]) else diffs
    if c["kind"] in REJECT_KINDS and (gate_of(c.get("reason")) or gate_of(py_reason)):
        return "state", diffs
    return "diff", diffs
