"""HTTP 入口（對應 index.js 的路由部分）。Starlette，單一 catch-all，行為逐路由對照 Node 版。

安全設計（同 Node 版）：訊號金鑰與控制金鑰分開；金鑰放標頭；常數時間比對；body 上限 16KB。
一律回 200 表示「已收到並決策」，拒絕不是 HTTP 錯誤。
"""
import asyncio
import hmac
import json
import math
import urllib.request

from starlette.applications import Starlette
from starlette.responses import Response
from starlette.routing import Route

from . import alerts, clock, events, risk as risk_mod, symbols
from .executor import confirm_signal, handle_signal, skip_signal
from .jsnum import fixed_num, to_number, to_string, truthy
from .service import log, run_reconcile
from .reconcile import daily_summary
from .store import iso

MAX_BODY_BYTES = 16 * 1024


class PayloadTooLarge(Exception):
    pass


def _clean(x):
    if isinstance(x, float):
        return None if not math.isfinite(x) else x
    if isinstance(x, dict):
        return {str(k): _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    return x


def jresp(status, obj):
    body = json.dumps(_clean(obj), ensure_ascii=False, separators=(",", ":"))
    return Response(body.encode("utf-8"), status_code=status, media_type=None,
                    headers={"Content-Type": "application/json; charset=utf-8"})


def safe_equals(a, b):
    ba = to_string(a if a is not None else "").encode("utf-8")
    bb = to_string(b if b is not None else "").encode("utf-8")
    return hmac.compare_digest(ba, bb)


def _is_int(x):
    return isinstance(x, float) and math.isfinite(x) and x == math.floor(x)


def _has(body, key):
    return isinstance(body, dict) and key in body


def _get(body, key):
    if body is None:
        raise TypeError("Cannot read properties of null")   # JS：null.xxx 會拋 → 500
    return body.get(key) if isinstance(body, dict) else None


def _http_get_json(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())


def create_app(config, store, syms, pre, *, start_reconcile=True, get_ip=None, on_started=None, bot=None):
    """get_ip：可注入的外網 IP 查詢（測試用）。bot：Telegram 層（botrt.BotRuntime），None 代表關閉。"""
    riskcfg = config["risk"]

    async def read_body(request):
        raw = bytearray()
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > MAX_BODY_BYTES:
                raise PayloadTooLarge("payload 過大")
        return raw.decode("utf-8", errors="replace")

    async def read_body_quiet(request):
        try:
            return await read_body(request)
        except Exception:  # noqa: BLE001  對應 JS 的 .catch(() => '')
            return ""

    def parse_quiet(raw):
        try:
            return json.loads(raw or "{}")
        except Exception:  # noqa: BLE001
            return {}

    def health():
        store.expire_pendings()
        today = store.today()
        info = store.daily_reset_info()
        cool = risk_mod.reset_cooldown(store, riskcfg)
        mode = "DRY_RUN" if config["dryRun"] else ("DEMO" if config["demo"] else "LIVE")
        rec = {"enabled": (not config["dryRun"]) and config["reconcileSec"] > 0, "everySec": config["reconcileSec"]}
        if config["dryRun"]:
            rec["note"] = "DRY_RUN 下停用 —— 沒有真實部位可對，日損上限也因此不會累積"
        return {
            "ok": True, "mode": mode, "role": config["instanceRole"], "demo": config["demo"],
            "stateMode": store.get_mode(), "executionMode": config["executionMode"],
            "exchange": config["primaryExchange"], "halted": store.is_halted(),
            "haltedReason": store.halted_reason(), "haltedSource": store.halted_source(),
            "openPositions": store.open_position_count(),
            "unconfirmedOrders": len(store.list_intents()), "pendingSignals": len(store.list_pendings()),
            "today": today, "supportedSymbols": symbols.list_supported(),
            "specSource": syms["source"], "droppedSymbols": syms["missing"], "reconcile": rec,
            "risk": {
                "pctPerTrade": riskcfg.get("pctPerTrade"), "minGrade": riskcfg.get("minGrade"),
                "allowedTimeframes": riskcfg.get("allowedTimeframes"),
                "maxConcurrent": risk_mod.effective_max_concurrent(store, riskcfg),
                "maxConcurrentCeiling": riskcfg.get("maxConcurrentCeiling"),
                "dailyLossLimitUsdt": risk_mod.effective_daily_loss_limit(store, riskcfg),
                "dailyLossCeilingUsdt": riskcfg.get("dailyLossCeilingUsdt"),
            },
            "dailyReset": {
                "count": info["count"], "limit": riskcfg.get("dailyResetLimit"),
                "realisedPnlUsdt": fixed_num(info["realisedPnlUsdt"], 4),
                "effectivePnlUsdt": fixed_num(info["effectivePnlUsdt"], 4),
                "cooldownActive": cool["active"], "cooldownRemainMin": cool["remainMin"],
            },
        }

    def daily_snapshot():
        info = store.daily_reset_info()
        cool = risk_mod.reset_cooldown(store, riskcfg)
        limit = riskcfg.get("dailyResetLimit")
        eff_limit = risk_mod.effective_daily_loss_limit(store, riskcfg)
        return {
            "ok": True,
            "realisedPnlUsdt": fixed_num(info["realisedPnlUsdt"], 4),
            "effectivePnlUsdt": fixed_num(info["effectivePnlUsdt"], 4),
            "dailyLossLimitUsdt": eff_limit,
            "blocked": -info["effectivePnlUsdt"] >= eff_limit,
            "resetCount": info["count"], "resetLimit": limit, "resetsLeft": max(0, limit - info["count"]),
            "cooldownMin": risk_mod.effective_cooldown_min(store, riskcfg),
            "cooldownActive": cool["active"], "cooldownRemainMin": cool["remainMin"],
            "dailyLossCeiling": riskcfg.get("dailyLossCeilingUsdt"),
            "cooldownFloor": riskcfg.get("dailyResetCooldownMin"),
            "orders": store.today()["orders"],
        }

    def limits_snapshot():
        return {
            "ok": True, "maxConcurrent": risk_mod.effective_max_concurrent(store, riskcfg),
            "ceiling": riskcfg.get("maxConcurrentCeiling"), "configured": riskcfg.get("maxConcurrent"),
            "overridden": store.get_override("maxConcurrent") is not None,
            "openPositions": store.open_position_count(),
            "dailyLossLimit": risk_mod.effective_daily_loss_limit(store, riskcfg),
            "dailyLossCeiling": riskcfg.get("dailyLossCeilingUsdt"),
            "dailyLossConfigured": riskcfg.get("dailyLossLimitUsdt"),
            "resetCooldownMin": risk_mod.effective_cooldown_min(store, riskcfg),
            "resetCooldownFloor": riskcfg.get("dailyResetCooldownMin"),
            "resetLimit": riskcfg.get("dailyResetLimit"),
        }

    def forbidden(request, route, why):
        events.emit("webhook_rejected", level="WARN", source="http",
                    detail={"route": route, "reason": why, "client": getattr(request.client, "host", None)})
        return jresp(403, {"ok": False, "error": "forbidden"})

    def need_signal_key(request, route):
        if not safe_equals(request.headers.get("x-executor-key"), config["webhookSecret"]):
            log(f"[http] {route} 金鑰驗證失敗")
            return forbidden(request, route, "bad_executor_key")
        return None

    def decided(source, action, result):
        sz = result.get("sizing")
        sig = result.get("signal") or {}
        events.emit(f"executor_{result.get('decision')}", level="ERROR" if result.get("decision") == "error" else "INFO",
                    source=source, duration_ms=result.get("elapsedMs"),
                    detail={"action": action, "sigId": result.get("sigId"), "stage": result.get("stage"),
                            "sent": result.get("sent"), "qty": sz and sz.get("orderQty"),
                            "riskUsdt": sz and sz.get("actualRiskUsdt"), "reasons": result.get("reasons"),
                            "dryRun": config["dryRun"], **({"symbol": sig.get("symbol")} if sig else {})})

    async def dispatch(request):
        route = f"{request.method} {request.url.path}"
        try:
            return await _dispatch(request, route)
        except PayloadTooLarge as err:
            log(f"[http] {route} 失敗：{err}")
            events.emit("webhook_rejected", level="WARN", source="http", detail={"route": route, "reason": "payload_too_large"})
            return jresp(500, {"ok": False, "error": "internal error"})
        except Exception as err:  # noqa: BLE001
            log(f"[http] {route} 失敗：{err}")
            events.emit("http_error", level="ERROR", source="http", detail={"route": route, "error": str(err)[:200]})
            alerts.failure("http_error", f"HTTP 路由發生未處理的例外：{route}：{str(err)[:150]}", cooldown_s=900)
            return jresp(500, {"ok": False, "error": "internal error"})

    async def _dispatch(request, route):
        if route == "GET /health":
            return jresp(200, health())

        # Telegram 層（取代 GAS 的 doPost）：網址形式與 GAS 相同，POST /?source=tradingview|telegram&key=…
        # 回應一律 200 純文字（與 GAS 相同）。bot 為 None 時整段關閉，落到 404。
        if bot is not None and route == "POST /" and request.query_params.get("source"):
            raw = await read_body(request)
            bot.loop = asyncio.get_running_loop()
            text = await asyncio.to_thread(bot.do_post, dict(request.query_params), raw)
            return Response(str(text).encode("utf-8"), status_code=200, media_type=None,
                            headers={"Content-Type": "text/plain; charset=utf-8"})

        if route == "POST /signal":
            if (r := need_signal_key(request, route)):
                return r
            raw = await read_body(request)
            try:
                payload = json.loads(raw)
            except Exception:  # noqa: BLE001
                events.emit("webhook_rejected", level="WARN", source="http", detail={"route": route, "reason": "invalid_json"})
                return jresp(400, {"ok": False, "error": "invalid json"})
            if isinstance(payload, dict) and payload.get("target") == "shadow" \
                    and not (config["instanceRole"] == "shadow" and config["demo"]):
                log(f"[http] 拒收：這筆是轉給模擬服務的訊號，但本服務是 {config['instanceRole']}／"
                    f"{'模擬盤' if config['demo'] else '實盤'}")
                events.emit("webhook_rejected", level="WARN", source="http",
                            detail={"route": route, "reason": "target_mismatch", "role": config["instanceRole"], "demo": config["demo"]})
                return jresp(409, {"ok": False, "error": "target_mismatch",
                                   "role": config["instanceRole"], "demo": config["demo"]})
            suppress = _get(payload, "notify") is False
            result = await handle_signal(payload, {"config": config, "store": store, "suppressNotify": suppress})
            sz = result.get("sizing")
            log("[signal] " + json.dumps(_clean({
                "sigId": result.get("sigId"), "decision": result.get("decision"), "stage": result.get("stage"),
                "sent": result.get("sent"), "qty": sz and sz.get("orderQty"),
                "risk": sz and sz.get("actualRiskUsdt"), "reasons": result.get("reasons"),
                "elapsedMs": result.get("elapsedMs")}), ensure_ascii=False))
            decided("http", "signal", result)
            return jresp(200, {
                "ok": True, "decision": result.get("decision"), "sigId": result.get("sigId"),
                "reasons": result.get("reasons"), "sizing": result.get("sizing") or None,
                "band": result.get("band") or None, "preview": result.get("preview") or None,
                "overLimit": result.get("overLimit") or None, "addOn": result.get("addOn") or None,
                "equity": result.get("equity") or None, "dryRun": config["dryRun"],
            })

        if route in ("POST /confirm", "POST /skip"):
            if (r := need_signal_key(request, route)):
                return r
            raw = await read_body(request)
            try:
                payload = json.loads(raw or "{}")
            except Exception:  # noqa: BLE001
                return jresp(400, {"ok": False, "error": "invalid json"})
            sid_v = _get(payload, "sig_id")
            if not truthy(sid_v):
                sid_v = _get(payload, "sigId")
            sig_id = to_string(sid_v if truthy(sid_v) else "").strip()
            if not sig_id:
                return jresp(400, {"ok": False, "error": "sig_id required"})
            action = "confirm" if route == "POST /confirm" else "skip"
            suppress = _get(payload, "notify") is False
            ctx = {"config": config, "store": store, "suppressNotify": suppress}
            result = await (confirm_signal(sig_id, ctx) if action == "confirm" else skip_signal(sig_id, ctx))
            sz = result.get("sizing")
            log(f"[{action}] " + json.dumps(_clean({
                "sigId": result.get("sigId"), "decision": result.get("decision"), "sent": result.get("sent"),
                "qty": sz and sz.get("orderQty"), "reasons": result.get("reasons"),
                "elapsedMs": result.get("elapsedMs")}), ensure_ascii=False))
            decided("http", action, result)
            d = result.get("drift")
            return jresp(200, {
                "ok": True, "decision": result.get("decision"), "sigId": result.get("sigId"),
                "reasons": result.get("reasons") or [], "sizing": result.get("sizing") or None,
                "drift": {
                    "verdict": d.get("verdict"),
                    "livePrice": (d.get("metrics") or {}).get("livePrice"),
                    "driftR": (d.get("metrics") or {}).get("driftR"),
                    "fromQty": (d.get("originalSizing") or {}).get("orderQty"),
                    "toQty": (d.get("resized") or {}).get("orderQty"),
                } if d else None,
                "dryRun": config["dryRun"],
            })

        if route in ("GET /limits", "POST /limits"):
            if safe_equals(request.headers.get("x-executor-key"), config["webhookSecret"]) is False:
                return forbidden(request, route, "bad_executor_key")
            ceiling = riskcfg.get("maxConcurrentCeiling")
            loss_ceiling = riskcfg.get("dailyLossCeilingUsdt")
            cool_floor = riskcfg.get("dailyResetCooldownMin")
            if route == "POST /limits":
                body = parse_quiet(await read_body_quiet(request))
                if body is None:
                    raise TypeError("null body")
                if _has(body, "maxConcurrent"):
                    wanted = to_number(body["maxConcurrent"])
                    if not _is_int(wanted) or wanted < 1 or wanted > ceiling:
                        return jresp(400, {"ok": False, "error": f"maxConcurrent 必須是 1 到 {ceiling} 之間的整數",
                                           "ceiling": ceiling,
                                           "note": "要超過這個範圍，請改 Zeabur 的 MAX_CONCURRENT_CEILING 環境變數。"})
                    store.set_override("maxConcurrent", int(wanted))
                    log(f"[control] 持倉上限改為 {int(wanted)}")
                elif _has(body, "dailyLossLimit"):
                    wanted = to_number(body["dailyLossLimit"])
                    if not math.isfinite(wanted) or wanted < 10 or wanted > loss_ceiling:
                        return jresp(400, {"ok": False, "error": f"dailyLossLimit 必須介於 10 與 {loss_ceiling} USDT 之間",
                                           "note": "要超過這個範圍，請改 Zeabur 的 DAILY_LOSS_CEILING_USDT 環境變數。"})
                    store.set_override("dailyLossLimit", wanted)
                    log(f"[control] 日損上限改為 {wanted} USDT")
                elif _has(body, "resetCooldownMin"):
                    wanted = to_number(body["resetCooldownMin"])
                    if not _is_int(wanted) or wanted < cool_floor or wanted > 720:
                        return jresp(400, {"ok": False, "error": f"resetCooldownMin 必須介於 {cool_floor} 與 720 分鐘之間",
                                           "note": "冷卻只能調長不能調短。要調更短，請改 Zeabur 的 "
                                                   "DAILY_RESET_COOLDOWN_MIN —— 那是下限，不是預設值。"})
                    store.set_override("resetCooldownMin", int(wanted))
                    log(f"[control] 重置冷卻改為 {int(wanted)} 分鐘")
                else:
                    return jresp(400, {"ok": False, "error": "沒有可辨識的參數（maxConcurrent／dailyLossLimit／resetCooldownMin）"})
            if route == "POST /limits":
                events.emit("limits_changed", level="WARN", source="control",
                            detail={k: body[k] for k in ("maxConcurrent", "dailyLossLimit", "resetCooldownMin") if _has(body, k)})
            return jresp(200, limits_snapshot())

        if route in ("GET /daily", "POST /daily/reset"):
            if safe_equals(request.headers.get("x-executor-key"), config["webhookSecret"]) is False:
                return forbidden(request, route, "bad_executor_key")
            limit = riskcfg.get("dailyResetLimit")
            if route == "GET /daily":
                return jresp(200, daily_snapshot())
            body = parse_quiet(await read_body_quiet(request))
            if body is None:
                raise TypeError("null body")
            if _get(body, "confirm") is not True:
                return jresp(400, {"ok": False, "error": "need confirm:true", **daily_snapshot()})
            if limit <= 0:
                return jresp(400, {"ok": False, "error": "重置功能已關閉（DAILY_RESET_LIMIT=0）", **daily_snapshot()})
            before = store.daily_reset_info()
            if before["count"] >= limit:
                return jresp(400, {"ok": False,
                                   "error": f"今日已重置 {before['count']} 次，達上限 {limit} 次。"
                                            "要再放寬得改 Zeabur 的 DAILY_RESET_LIMIT —— 但今天的結論多半是收工。",
                                   **daily_snapshot()})
            if -before["effectivePnlUsdt"] < risk_mod.effective_daily_loss_limit(store, riskcfg):
                return jresp(400, {"ok": False, "error": "目前未達日損上限，無須重置（額度留著）", **daily_snapshot()})
            note = _get(body, "note")
            done = store.reset_daily_loss({"by": "telegram", "note": to_string(note) if truthy(note) else ""})
            events.emit("daily_reset", level="WARN", source="control",
                        detail={"count": done["count"], "clearedUsdt": done["clearedUsdt"]})
            log("[control] 日損上限已重置 " + json.dumps({
                "第幾次": done["count"], "抹掉虧損": fixed_num(-done["clearedUsdt"], 2),
                "真實日損": fixed_num(-before["realisedPnlUsdt"], 2),
                "冷卻分鐘": risk_mod.effective_cooldown_min(store, riskcfg)}, ensure_ascii=False))
            return jresp(200, {**daily_snapshot(), "clearedUsdt": done["clearedUsdt"]})

        if route == "GET /pending":
            if safe_equals(request.headers.get("x-executor-key"), config["webhookSecret"]) is False:
                return forbidden(request, route, "bad_executor_key")
            store.expire_pendings()

            def row(p):
                s, z = p.get("signal"), p.get("sizing")
                return {"sigId": p.get("sigId"), "status": p.get("status"), "expiresAt": p.get("expiresAt"),
                        "symbol": s and s.get("symbol"), "side": s and s.get("side"), "grade": s and s.get("grade"),
                        "entry": s and s.get("entry"), "sl": s and s.get("sl"),
                        "orderQty": z and z.get("orderQty"), "riskUsdt": z and z.get("actualRiskUsdt")}
            return jresp(200, {"ok": True, "mode": config["executionMode"], "ttlSec": config["pendingTtlSec"],
                               "pendings": [row(p) for p in store.list_pendings()]})

        if route.startswith("POST /control/") or route in ("GET /positions", "GET /decisions", "GET /control/whoami",
                                                           "GET /events"):
            if not safe_equals(request.headers.get("x-control-key"), config["controlSecret"]):
                log("[http] 控制端點金鑰驗證失敗")
                return forbidden(request, route, "bad_control_key")
            if route == "GET /events":
                q = request.query_params
                return jresp(200, {"ok": True, "events": events.tail(q.get("limit") or 50, level=q.get("level"),
                                                                       event=q.get("event")),
                                   **events.stats()})
            if route == "POST /control/halt":
                raw = await read_body_quiet(request)
                reason = "手動停止"
                try:
                    v = json.loads(raw or "{}").get("reason")
                    reason = v if truthy(v) else reason
                except Exception:  # noqa: BLE001
                    pass
                store.set_halted(True, reason, "manual")
                log("[control] 已停止下單：" + to_string(reason))
                events.emit("control_halt", level="WARN", source="control", detail={"reason": to_string(reason)})
                return jresp(200, {"ok": True, "halted": True, "reason": reason})
            if route == "POST /control/resume":
                store.set_halted(False)
                log("[control] 已恢復下單")
                events.emit("control_resume", source="control", detail={})
                return jresp(200, {"ok": True, "halted": False})
            if route == "GET /control/whoami":
                try:
                    body = await asyncio.to_thread(get_ip or (lambda: _http_get_json("https://api.ipify.org?format=json")))
                    return jresp(200, {
                        "ok": True, "outboundIp": body["ip"], "checkedAt": iso(clock.now_ms()),
                        "note": "這是執行層對外的 IP。要拿它填交易所白名單之前，請隔數小時重查幾次，確認它不會變。"})
                except Exception as err:  # noqa: BLE001
                    return jresp(200, {"ok": False, "error": f"查詢失敗：{err}",
                                       "note": "查不到不影響下單，這只是個診斷端點。"})
            if route == "GET /positions":
                return jresp(200, {"ok": True, "positions": store.list_positions(), "intents": store.list_intents(),
                                   "counted": {"okx": store.open_position_count("okx"),
                                               "bingx": store.open_position_count("bingx")}})
            if route in ("POST /control/reconcile", "GET /control/reconcile"):
                r = await run_reconcile(config, store, "手動")
                return jresp(200, {"ok": True, "reconcile": r, "daily": daily_summary(store)})
            if route == "GET /decisions":
                n = to_number(request.query_params.get("limit"))
                limit = n if (not math.isnan(n) and n != 0) else 50
                return jresp(200, {"ok": True, "decisions": store.list_decisions(int(limit))})

        return jresp(404, {"ok": False, "error": "not found"})

    methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]
    app = Starlette(routes=[Route("/{path:path}", dispatch, methods=methods)])
    app.state.config, app.state.store = config, store
    return app
