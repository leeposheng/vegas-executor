"""Telegram 通知文字（對應 notify.js 的 renderDecision）。送訊功能於階段 3 補。"""
from .jsnum import js_floor, num_str, to_fixed, to_string


def _fmt(n, digits=2):
    return to_fixed(float(n), digits)


def render_decision(o):
    signal = o["signal"]
    decision = o.get("decision")
    sizing = o.get("sizing")
    risk_summary = o.get("riskSummary")
    reasons = o.get("reasons")
    dry_run = o.get("dryRun")
    demo = o.get("demo")
    exchange = o.get("exchange")
    expires_at = o.get("expiresAt")
    ttl = o.get("ttlSec")
    confirmed = o.get("confirmedByUser")

    placed_head = "🧪 模擬計算（未送單）" if dry_run else ("📄 模擬盤下單" if demo else "✅ 實盤下單")
    if decision == "pending":
        head = "⏳ 待確認"
    elif decision == "skipped":
        head = "⏭ 已略過"
    elif decision == "placed":
        head = ("👍 已確認｜" + placed_head) if confirmed else placed_head
    else:
        head = "⛔ 已拒絕"

    sc = signal.get("score")
    lines = [
        f"{head}｜{signal['symbol']} {'做多⬆' if signal['side'] == 'long' else '做空⬇'}",
        "─────────────",
        f"[訊號] {signal['sigId']}",
        f"[週期] {to_string(signal['timeframe'])}｜[等級] {num_str(signal['grade'])}★"
        + ("" if sc is None else f"｜[分數] {num_str(sc)}"),
        f"[進場] {num_str(signal['entry'])}",
        f"[止損] {num_str(signal['sl'])}（距離 {_fmt(signal['riskDistance'], 4)}）",
    ]

    if sizing:
        lines.append(
            f"[數量] {num_str(sizing['orderQty'])} {'張' if sizing['unit'] == 'contracts' else '幣'}"
            f"（{_fmt(sizing['baseQty'], 6)} base）")
        lines.append(
            f"[風險] 預算 {_fmt(sizing['riskAmountUsdt'])} → 實際 {_fmt(sizing['actualRiskUsdt'])} USDT"
            f"（用量 {_fmt(sizing['riskUtilisation'] * 100, 1)}%）")
        lines.append(f"[名目] {_fmt(sizing['notionalUsdt'])} USDT｜保證金 {_fmt(sizing['marginUsdt'])} USDT")
        lines.append(f"[交易所] {exchange}")
    if risk_summary:
        lines.append(f"[閘門] {risk_summary}")
    if reasons:
        lines.append("[原因] " + "；".join(reasons))

    if decision == "pending" and expires_at:
        window = ""
        if ttl is not None and ttl >= 60:
            mins = js_floor(ttl / 60)
            rest = ttl % 60
            window = f"{mins} 分 {num_str(rest)} 秒內" if rest else f"{mins} 分鐘內"
        elif ttl is not None and ttl > 0:
            window = f"{num_str(ttl)} 秒內"
        lines.append("─────────────")
        lines.append(f"⏱ {window}有效，逾時自動失效")
        lines.append("回覆「進場」或「略過」（階段 2 會換成按鈕）")
    return "\n".join(lines)


# ---- 送訊（對應 notify.send）----
import asyncio
import json
import urllib.request

from . import alerts, events

RETRY_DELAYS_MS = [1000, 3000]
SEND_TIMEOUT_S = 10


def _post(token, payload):
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=SEND_TIMEOUT_S) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


async def send(text, cfg, opts=None):
    """永不拋例外；沒設定 token 時只印到主控台。（階段 3 以真實 Telegram 驗證）"""
    if not cfg.get("token") or not cfg.get("chatId"):
        print("[notify] 未設定 Telegram，內容僅輸出至主控台：\n" + text)
        return {"sent": False}
    delays = (opts or {}).get("delays", RETRY_DELAYS_MS)
    sleep = (opts or {}).get("sleep") or asyncio.sleep
    last_error = ""
    for attempt in range(len(delays) + 1):
        retryable, retry_after = True, 0
        try:
            label = cfg.get("label")
            status, js = await asyncio.to_thread(_post, cfg["token"], {
                "chat_id": str(cfg["chatId"]), "text": (label + "\n" + text) if label else text})
            if js.get("ok"):
                alerts.success("telegram")
                return {"sent": True, "attempts": attempt + 1}
            last_error = json.dumps(js, ensure_ascii=False)[:200]
            code = js.get("error_code") or status
            if code == 429:
                retry_after = (js.get("parameters") or {}).get("retry_after", 0) * 1000
            elif 400 <= code < 500:
                retryable = False
        except Exception as e:  # noqa: BLE001
            last_error = str(e)
        if not retryable or attempt == len(delays):
            break
        await sleep(max(delays[attempt], retry_after) / 1000)
    print("[notify] Telegram 傳送失敗：" + last_error + "\n[notify] 未送出的內容：\n" + text)
    events.emit("telegram_send_failed", level="WARN", source="notify", detail={"error": last_error})
    # Telegram 自己送不出，告警不能再走 Telegram：只留事件與 stdout
    alerts.failure("telegram", "Telegram 連續送不出訊息：" + last_error[:120], threshold=3, deliver=False)
    return {"sent": False, "error": last_error}
