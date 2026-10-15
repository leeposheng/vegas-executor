"""對帳迴圈（對應 reconcile.js）。以交易所為唯一事實來源。

reconcile_once 的 exchange 參數為注入的模組／物件，需提供
async fetch_positions(cfg, flags) / fetch_positions_history(params, cfg, flags) /
fetch_order_by_cl_ord_id(params, cfg, flags)，測試時可不連網驗證。
"""
import math

from . import clock, symbols
from .jsnum import fixed_num, is_finite_number, js_round, to_fixed, to_number, to_string, truthy
from .store import UNDEFINED, iso, parse_iso_ms

OPEN_GRACE_MS = 90 * 1000
OPEN_MATCH_MS = 5 * 60 * 1000
STALE_DEFAULT_MIN = 30


def _fin(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def stale_ms(config):
    m = to_number((config or {}).get("reconcileStaleMin"))
    return (m if (_fin(m) and m > 0) else STALE_DEFAULT_MIN) * 60 * 1000


def _eligible(r, opened_ms, want_side):
    if not truthy(r.get("closedAtMs")):
        return False
    if math.isfinite(opened_ms) and r["closedAtMs"] < opened_ms - 60000:
        return False
    ps = r.get("posSide")
    if truthy(ps) and ps != "net" and ps != want_side:
        return False
    return True


def match_history_relaxed(records, tracked):
    opened_ms = parse_iso_ms(tracked.get("openedAt"))
    want = "long" if tracked.get("side") == "long" else "short"
    cands = [r for r in records if _eligible(r, opened_ms, want)]
    if not cands:
        return None
    cands.sort(key=lambda r: r["closedAtMs"])
    return cands[0]


def match_history(records, tracked):
    opened_ms = parse_iso_ms(tracked.get("openedAt"))
    want = "long" if tracked.get("side") == "long" else "short"
    cands = []
    for r in records:
        if not _eligible(r, opened_ms, want):
            continue
        if math.isfinite(opened_ms) and _fin(r.get("openedAtMs")):
            if abs(r["openedAtMs"] - opened_ms) > OPEN_MATCH_MS:
                continue
        cands.append(r)
    if not cands:
        return None
    if math.isfinite(opened_ms):
        # JS 的 sort 為穩定排序，Python 亦然；NaN 差值在 JS 視為相等，這裡以 0 處理
        def k(r):
            d = abs(to_number(r.get("openedAtMs")) - opened_ms)
            return 0 if math.isnan(d) else d
        cands.sort(key=k)
    else:
        cands.sort(key=lambda r: r["closedAtMs"])
    return cands[0]


def describe_close_type(t):
    m = {"1": "部分平倉", "2": "平倉", "3": "強制平倉", "4": "部分強平",
         "5": "自動減倉（未全平）", "6": "自動減倉"}
    return m.get(to_string(t), "已平倉")


def infer_exit(close_avg_px, tracked):
    if not _fin(close_avg_px):
        return None
    sl = to_number(tracked["sl"]) if "sl" in tracked else float("nan")  # 缺欄位＝undefined＝NaN
    tps = tracked.get("tp")
    tp1 = to_number(tps[0]) if isinstance(tps, list) and tps else float("nan")
    if not _fin(sl) and not _fin(tp1):
        return None
    inf = float("inf")
    d_sl = abs(close_avg_px - sl) if _fin(sl) else inf
    d_tp = abs(close_avg_px - tp1) if _fin(tp1) else inf
    if d_sl == inf and d_tp == inf:
        return None
    return "推斷止盈" if d_tp <= d_sl else "推斷止損"


def _intent_inst_id(it, ex_name):
    if truthy(it.get("instId")):
        return it["instId"]
    r = symbols.resolve(it.get("symbol"), ex_name)
    return (r["spec"].get("instId") or r["spec"].get("symbol")) if r["ok"] else None


def _mins(ms):
    return int(js_round(ms / 60000))


async def reconcile_once(ctx):
    config, store, exchange = ctx["config"], ctx["store"], ctx["exchange"]
    now = ctx.get("now") or clock.now_ms()
    ex_name = ctx.get("exchangeName") or "okx"
    flags = {"demo": config.get("demo")}
    ex_cfg = config.get("bingx") if ex_name == "bingx" else config.get("okx")

    tracked = store.list_positions(ex_name)
    intents = store.list_intents(ex_name)
    out = {"exchange": ex_name, "checked": len(tracked), "stillOpen": 0, "closed": [],
           "resolvedIntents": [], "orphans": [], "errors": [], "released": []}
    if not tracked and not intents:
        return out

    try:
        live = await exchange.fetch_positions(ex_cfg, flags)
    except Exception as err:  # noqa: BLE001
        out["errors"].append("查詢持倉失敗：" + str(err))
        return out
    open_inst_ids = {p.get("instId") for p in live}

    # 一：意圖
    for it in intents:
        at_ms = parse_iso_ms(it.get("at"))
        if math.isfinite(at_ms) and now - at_ms < OPEN_GRACE_MS:
            continue
        try:
            order = await exchange.fetch_order_by_cl_ord_id(
                {"instId": _intent_inst_id(it, ex_name), "clOrdId": it.get("clOrdId")}, ex_cfg, flags)
        except Exception as err:  # noqa: BLE001
            inst_id = _intent_inst_id(it, ex_name)
            if math.isfinite(at_ms) and now - at_ms >= stale_ms(config) and inst_id and inst_id not in open_inst_ids:
                store.clear_intent(it["sigId"], it.get("exchange"))
                out["released"].append({
                    "kind": "intent", "sigId": it["sigId"], "symbol": it.get("symbol"), "side": it.get("side"),
                    "exchange": ex_name, "sinceMs": at_ms,
                    "note": f"下單結果反查失敗已超過 {_mins(stale_ms(config))} 分鐘，"
                            "且交易所目前沒有此合約的部位，已釋放持倉額度",
                    "lastError": str(err)})
                continue
            out["errors"].append(f"意圖 {it.get('clOrdId')} 反查失敗：{err}")
            continue

        if not order:
            store.clear_intent(it["sigId"], it.get("exchange"))
            out["resolvedIntents"].append({
                "sigId": it["sigId"], "symbol": it.get("symbol"), "outcome": "never_sent",
                "note": "交易所查無此單，該筆請求並未送達，未造成部位"})
            continue

        state = order.get("state")
        if state == "partially_filled":
            out["errors"].append(
                f"意圖 {it.get('clOrdId')} 部分成交（{to_string(order.get('filledSz'))} / {to_string(it.get('orderQty'))} 張），"
                "尚未結案，下一輪再查。若持續如此請到交易所確認。")
            continue
        if state == "filled":
            created = order.get("createdAtMs")
            recovered = {
                "symbol": it.get("symbol"), "exchange": ex_name, "side": it.get("side"),
                "entry": order["avgPx"] if truthy(order.get("avgPx")) else it.get("entry"),
                "sl": it.get("sl"), "tp": it.get("tp"),
                "orderQty": order["filledSz"] if truthy(order.get("filledSz")) else it.get("orderQty"),
                "baseQty": it.get("baseQty"), "clientOrderId": it.get("clOrdId"),
                "openedAt": iso(created) if truthy(created) else it.get("at"),
                "recoveredBy": "reconcile",
            }
            layered = truthy(it.get("addOnTo")) and store.add_layer(
                it["addOnTo"], it.get("exchange"), {"sigId": it["sigId"], **recovered})
            if not layered:
                store.add_position(it["sigId"], recovered)
            store.clear_intent(it["sigId"], it.get("exchange"))
            out["resolvedIntents"].append({
                "sigId": it["sigId"], "symbol": it.get("symbol"), "outcome": "filled",
                "avgPx": order.get("avgPx"), "qty": order.get("filledSz"),
                "note": "下單當時未收到回應，但實際已成交，已補登部位"})
            continue
        if state == "canceled":
            store.clear_intent(it["sigId"], it.get("exchange"))
            out["resolvedIntents"].append({
                "sigId": it["sigId"], "symbol": it.get("symbol"), "outcome": "canceled",
                "note": "訂單已被取消，未成交"})
            continue

    # 二：孤兒倉（用「現在」的清單重建）
    current = store.list_positions(ex_name)
    known = set()
    for t in current + store.list_intents(ex_name):
        r = symbols.resolve(t.get("symbol"), ex_name)
        if r["ok"]:
            known.add(r["spec"].get("instId") or r["spec"].get("symbol"))
    for p in live:
        if p.get("instId") not in known:
            out["orphans"].append({k: p.get(k) for k in ("instId", "pos", "avgPx", "upl") if k in p})

    # 三：結算
    for t in tracked:
        resolved = symbols.resolve(t.get("symbol"), ex_name)
        if not resolved["ok"]:
            out["errors"].append(f"{to_string(t.get('symbol'))}：{resolved['error']}")
            continue
        inst_id = resolved["spec"].get("instId") or resolved["spec"].get("symbol")

        if inst_id in open_inst_ids:
            if truthy(t.get("goneSinceMs")):
                store.patch_position(t["sigId"], t.get("exchange"), {"goneSinceMs": UNDEFINED})
            out["stillOpen"] += 1
            continue

        opened_ms = parse_iso_ms(t.get("openedAt"))
        if math.isfinite(opened_ms) and now - opened_ms < OPEN_GRACE_MS:
            out["stillOpen"] += 1
            continue

        try:
            history = await exchange.fetch_positions_history(
                {"instId": inst_id, "afterMs": (opened_ms - 60000) if math.isfinite(opened_ms) else None},
                ex_cfg, flags)
        except Exception as err:  # noqa: BLE001
            out["errors"].append(f"{t.get('symbol')} 查詢平倉紀錄失敗：{err}")
            continue

        rec = match_history(history, t)
        matched_by = "strict"
        if not rec:
            gs = to_number(t.get("goneSinceMs"))
            gone_since = gs if (not math.isnan(gs) and gs != 0) else None
            if not gone_since:
                store.patch_position(t["sigId"], t.get("exchange"), {"goneSinceMs": now})
                out["errors"].append(
                    f"{t.get('symbol')} 部位已不存在，但查不到對應的平倉紀錄（sig {str(t['sigId'])[-12:]}），"
                    f"{_mins(stale_ms(config))} 分鐘後仍對不上將釋放額度")
                continue
            if now - gone_since < stale_ms(config):
                out["errors"].append(
                    f"{t.get('symbol')} 部位已不存在，仍查不到平倉紀錄（sig {str(t['sigId'])[-12:]}，"
                    f"已 {_mins(now - gone_since)} 分鐘）")
                continue
            rec = match_history_relaxed(history, t)
            matched_by = "relaxed"
            if not rec:
                if not store.remove_position(t["sigId"], t.get("exchange")):
                    out["errors"].append(f"{t.get('symbol')} 殘留部位刪不掉（sig {str(t['sigId'])[-12:]}），需要人工檢查")
                    continue
                out["released"].append({
                    "kind": "position", "sigId": t["sigId"], "symbol": t.get("symbol"), "side": t.get("side"),
                    "exchange": ex_name, "sinceMs": gone_since, "openedAt": t.get("openedAt"),
                    "note": f"交易所已無此部位超過 {_mins(stale_ms(config))} 分鐘，"
                            "且查不到對應的平倉紀錄，已釋放持倉額度；這筆的損益沒有入帳"})
                continue

        pnl = rec["realizedPnl"] if is_finite_number(rec.get("realizedPnl")) else 0

        # 順序：先確認刪得掉，再記損益（避免重複累計）
        if not store.remove_position(t["sigId"], t.get("exchange")):
            out["errors"].append(
                f"{t.get('symbol')} 的部位紀錄刪不掉（sig {str(t['sigId'])[-12:]}，交易所 {t.get('exchange')}）。"
                "損益未入帳，以免重複累計。這通常代表狀態檔的鍵格式有問題，需要人工檢查。")
            continue
        store.record_pnl(pnl, rec["closedAtMs"] if truthy(rec.get("closedAtMs")) else now)

        exit_ = infer_exit(rec.get("closeAvgPx"), t) if to_string(rec.get("closeType")) == "2" else None
        out["closed"].append({
            "sigId": t["sigId"], "exchange": ex_name, "symbol": t.get("symbol"), "side": t.get("side"),
            "entry": t.get("entry"), "openAvgPx": rec.get("openAvgPx"), "closeAvgPx": rec.get("closeAvgPx"),
            "pnlUsdt": pnl, "pnlConfidence": "low" if rec.get("aggregated") else "high",
            "grossPnlUsdt": rec.get("pnl"), "feeUsdt": rec.get("fee"), "fundingUsdt": rec.get("fundingFee"),
            "reason": describe_close_type(rec.get("closeType")) + (f"（{exit_}）" if exit_ else ""),
            "closedAtMs": rec.get("closedAtMs"), "win": pnl > 0,
            "layers": len(t["layers"]) if isinstance(t.get("layers"), list) else 0,
            "matchedBy": matched_by,
        })
    return out


def _f2(x):
    return to_fixed(to_number(x), 2)


def render_closed_card(c):
    pnl = to_number(c.get("pnlUsdt"))
    sign = "+" if pnl >= 0 else ""
    head = "🟢 獲利平倉" if c.get("win") else "🔴 虧損平倉"
    gross = c.get("grossPnlUsdt")
    fee = to_number(c.get("feeUsdt"))
    fund = to_number(c.get("fundingUsdt"))
    fee = 0 if (math.isnan(fee) or fee == 0) else fee
    fund = 0 if (math.isnan(fund) or fund == 0) else fund
    lines = [
        f"{head}｜{c.get('symbol')} {'做多⬆' if c.get('side') == 'long' else '做空⬇'}"
        + (f"（{str(c['exchange']).upper()}）" if truthy(c.get("exchange")) else ""),
        "─────────────",
        f"[原因] {c.get('reason')}",
        f"[進場] {to_string(c.get('openAvgPx'))}",
        f"[出場] {to_string(c.get('closeAvgPx'))}",
        f"[價差] {'+' if to_number(gross) >= 0 else ''}{_f2(gross)} USDT",
        f"[費用] {to_fixed(fee + fund, 2)} USDT",
        f"[損益] {sign}{_f2(pnl)} USDT",
    ]
    if truthy(c.get("layers")):
        lines.append(f"[加倉] {to_string(c['layers'])} 次（損益為整個部位合計）")
    if c.get("matchedBy") == "relaxed":
        lines.append("")
        lines.append("⚠️ 此筆在逾時後以放寬條件比對（未核對開倉時間），請到交易所確認是同一筆。")
    if c.get("pnlConfidence") == "low":
        lines.append("")
        lines.append("⚠️ 此損益由資金流水聚合而得，非交易所的單筆平倉紀錄。")
        lines.append("   若同期間有其他交易或資金費，可能被一併計入。")
    return "\n".join(lines)


def render_released_card(r):
    mins = _mins(clock.now_ms() - r["sinceMs"]) if truthy(r.get("sinceMs")) else None
    parts = [
        f"🧹 釋放殘留{'下單紀錄' if r.get('kind') == 'intent' else '部位'}｜{r.get('symbol')}"
        + (" " + ("做多⬆" if r["side"] == "long" else "做空⬇") if truthy(r.get("side")) else "")
        + (f"（{str(r['exchange']).upper()}）" if truthy(r.get("exchange")) else ""),
        "─────────────",
        r.get("note"),
        f"已等待 {mins} 分鐘" if mins is not None else "",
        "",
        "⚠️ 這筆的損益沒有計入日損上限。若它實際有成交並平倉，",
        "   請到交易所查看實際損益。",
    ]
    return "\n".join(x for x in parts if x != "")


def daily_summary(store, now=None):
    today = store.today(now if truthy(now) else clock.now_ms())
    return {"realisedPnlUsdt": fixed_num(today["realisedPnlUsdt"], 4), "orders": today["orders"]}
