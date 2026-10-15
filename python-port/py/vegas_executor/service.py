"""服務層：開機流程（規格、自檢）與對帳執行／排程（對應 index.js 的非 HTTP 部分）。"""
import asyncio
import math

from . import alerts, clock, events, instruments, notify, symbols
from .exchanges import bingx, okx
from .executor import order_gate
from .jsnum import to_fixed, to_number, truthy
from .reconcile import (daily_summary, reconcile_once, render_closed_card, render_released_card)
from .store import Store

EXCHANGE_MODULES = {"okx": okx, "bingx": bingx}


def log(msg):
    print(msg, flush=True)


async def install_symbols(config, getter=None):
    loaded = await instruments.load(base_url=config["okx"].get("baseUrl"), data_dir=config["dataDir"], getter=getter)
    log("[規格] " + loaded["note"])
    bingx_specs = None
    if "bingx" in config["exchanges"]:
        try:
            bingx_specs = await bingx.fetch_all_contracts(config["bingx"])
        except Exception as err:  # noqa: BLE001
            log(f"[規格] BingX 合約查詢失敗：{err}，改用靜態值")
    r = symbols.install(allowed=config["risk"].get("allowedSymbols"), specs=loaded["specs"], bingxSpecs=bingx_specs)
    installed, missing, missing_bx = r["installed"], r["missing"], r["missingBingx"]
    if missing:
        log(f"[規格] 以下代碼在交易所找不到，已從白名單剔除（{len(missing)} 個）：")
        log("        " + "、".join(missing))
    if not installed:
        raise RuntimeError("白名單是空的：ALLOWED_SYMBOLS 裡沒有任何代碼對得上交易所的合約。\n"
                           "這樣每一筆訊號都會被拒絕。請檢查代碼格式（要像 BTCUSDT.P）。")
    from_static = [s for s in installed if symbols.spec_source(s) == "static"]
    if from_static:
        log("[規格] 以下代碼用的是程式內建的靜態值，非交易所即時資料：" + "、".join(from_static))
    if "bingx" in config["exchanges"] and missing_bx:
        log(f"[規格] 以下代碼缺 BingX 規格，BingX 那一側會拒單（{len(missing_bx)} 個）：")
    log(f"[規格] 白名單共 {len(installed)} 個代碼可交易")
    return {"installed": installed, "missing": missing, "missingBingx": missing_bx, "source": loaded["source"]}


async def preflight(config, store):
    """開機自檢（含事件紀錄）。"""
    res = await _preflight(config, store)
    if res.get("ok"):
        events.emit("preflight_ok", source="service", detail={"dryRun": bool(config["dryRun"])})
    else:
        events.emit("preflight_failed", level="ERROR", source="service", detail={"reason": res.get("reason")})
    return res


async def _preflight(config, store):
    """開機自檢。失敗 → 開 kill switch、服務照常啟動（理由見 Node 版註解）。"""
    if config["dryRun"]:
        log("[自檢] DRY_RUN 模式，略過交易所自檢")
        return {"ok": True}
    try:
        if "bingx" in config["exchanges"]:
            rep = await bingx.preflight(config["bingx"], {"demo": config["demo"]})
            if not rep["ok"]:
                reason = "BingX 自檢失敗：" + str(rep.get("error"))
                store.set_halted(True, reason, "preflight")
                return {"ok": False, "reason": reason}
        if "okx" not in config["exchanges"]:
            return {"ok": True}
        log("[自檢] 正在向交易所查詢帳戶設定…")
        report = await okx.preflight({"leverage": config["risk"]["leverage"], "tdMode": config["okx"].get("tdMode")},
                                     config["okx"], {"demo": config["demo"]})
        for w in report.get("warnings") or []:
            log("[自檢] ⚠️ " + w)
        pos_mode = (report.get("account") or {}).get("posMode")
        if pos_mode in ("net_mode", "long_short_mode"):
            config["okx"]["posMode"] = pos_mode
        else:
            report["ok"] = False
            report.setdefault("errors", []).append(
                f"無法取得持倉模式（收到「{pos_mode or '空值'}」）。"
                "不知道是單向還是雙向持倉就不能安全下單 —— 雙向持倉必須帶 posSide。")
        if not report["ok"]:
            reason = "開機自檢失敗：" + "；".join(report["errors"])
            log("[自檢] 服務照常啟動，但已開啟停止下單（kill switch）。修好之後打 POST /control/resume 恢復。")
            store.set_halted(True, reason, "preflight")
            return {"ok": False, "reason": reason}
    except Exception as err:  # noqa: BLE001
        # 自檢本身出錯（含尚未實作的網路層）一律視為未通過：寧可停止下單
        reason = f"開機自檢失敗：{err}"
        log("[自檢] ✗ " + reason)
        store.set_halted(True, reason, "preflight")
        return {"ok": False, "reason": reason}
    if store.clear_halt_if_from("preflight"):
        log("[自檢] 先前因自檢失敗而停止下單，現在已自動解除")
    return {"ok": True}


async def _safe_send(text, config):
    try:
        await notify.send(text, config["telegram"])
    except Exception as err:  # noqa: BLE001
        log("[對帳] 推播失敗：" + str(err))


async def run_reconcile_for(config, store, trigger, ex_name):
    mod = EXCHANGE_MODULES.get(ex_name)
    if mod is None or not hasattr(mod, "fetch_positions"):
        return {"exchange": ex_name, "closed": [], "errors": [f"{ex_name} 沒有可用的對帳實作"]}
    try:
        # 對帳與下單共用同一條佇列：兩者讀寫同一份狀態
        r = await order_gate.run(
            lambda: reconcile_once({"config": config, "store": store, "exchange": mod, "exchangeName": ex_name}),
            "對帳 " + ex_name)

        for c in r["closed"]:
            events.emit("reconcile_closed", source="reconcile",
                        detail={"exchange": ex_name, "symbol": c.get("symbol"), "reason": c.get("reason"),
                                "pnlUsdt": c.get("pnlUsdt")})
            today = daily_summary(store)
            text = (render_closed_card(c)
                    + f"\n[當日] {'+' if today['realisedPnlUsdt'] >= 0 else ''}"
                    f"{to_fixed(today['realisedPnlUsdt'], 2)} USDT（{today['orders']} 筆）")
            log(f"[對帳] {ex_name} {c['symbol']} {c['reason']} 損益 {to_fixed(c['pnlUsdt'], 2)} USDT")
            await _safe_send(text, config)

        for it in r.get("resolvedIntents") or []:
            head = "⚠️ 補登部位" if it["outcome"] == "filled" else "ℹ️ 訂單結案"
            log(f"[對帳] {ex_name} {head} {it['symbol']}：{it['note']}")
            if it["outcome"] == "filled":
                await _safe_send(
                    f"{head}｜{it['symbol']}\n─────────────\n{it['note']}\n成交均價 {it.get('avgPx')}　數量 {it.get('qty')} 張\n\n"
                    "⚠️ 若你當時以為沒成交而手動補過單，現在可能是雙倍部位，請去交易所確認。", config)

        for rel in r.get("released") or []:
            events.emit("reconcile_released", level="WARN", source="reconcile",
                        detail={"exchange": ex_name, "kind": rel.get("kind"), "symbol": rel.get("symbol")})
            log(f"[對帳] {ex_name} 🧹 釋放殘留 {rel['kind']} {rel['symbol']}：{rel['note']}")
            await _safe_send(render_released_card(rel), config)

        for o in r.get("orphans") or []:
            events.emit("reconcile_orphan", level="WARN", source="reconcile",
                        detail={"exchange": ex_name, "instId": o.get("instId"), "pos": o.get("pos")})
            log(f"[對帳] {ex_name} 孤兒倉 {o.get('instId')} {o.get('pos')} 張（未實現 {o.get('upl')}），系統無此紀錄")
        for e in r["errors"]:
            log(f"[對帳] {ex_name} {e}")
        if r["errors"]:
            events.emit("reconcile_error", level="WARN", source="reconcile",
                        detail={"exchange": ex_name, "errors": [str(e)[:200] for e in r["errors"]][:5]})
            alerts.failure(f"reconcile:{ex_name}", f"對帳連續失敗（{ex_name}）：{str(r['errors'][0])[:150]}", threshold=3)
        else:
            alerts.success(f"reconcile:{ex_name}")

        if r["closed"] and store.is_halted() is False:
            today = daily_summary(store)
            lim = config["risk"]["dailyLossLimitUsdt"]
            if -today["realisedPnlUsdt"] >= lim:
                await _safe_send(
                    f"⛔ 當日已實現虧損 {to_fixed(-today['realisedPnlUsdt'], 2)} USDT，已達上限 {lim} USDT。\n"
                    "今日剩餘訊號都會被拒絕。", config)
        return r
    except Exception as err:  # noqa: BLE001 — 對帳不可拖垮服務
        log(f"[對帳] {ex_name} {trigger or '定時'}執行失敗：{err}")
        events.emit("reconcile_error", level="ERROR", source="reconcile",
                    detail={"exchange": ex_name, "trigger": trigger or "定時", "error": str(err)[:200]})
        alerts.failure(f"reconcile:{ex_name}", f"對帳連續失敗（{ex_name}）：{str(err)[:150]}", threshold=3)
        return {"exchange": ex_name, "closed": [], "errors": [str(err)]}


async def run_reconcile(config, store, trigger=None):
    if config["dryRun"]:
        return {"skipped": "dryRun 下沒有真實部位，不對帳"}
    exchanges = config["exchanges"] if truthy(config.get("exchanges")) else [config["primaryExchange"]]
    rounds = [await run_reconcile_for(config, store, trigger, ex) for ex in exchanges]
    if len(rounds) == 1:
        return rounds[0]
    return {
        "perExchange": rounds,
        "closed": [c for r in rounds for c in (r.get("closed") or [])],
        "resolvedIntents": [c for r in rounds for c in (r.get("resolvedIntents") or [])],
        "orphans": [c for r in rounds for c in (r.get("orphans") or [])],
        "errors": [f"[{r.get('exchange')}] {e}" for r in rounds for e in (r.get("errors") or [])],
    }


async def reconcile_loop(config, store):
    """固定節奏問交易所；防重入（上一輪沒跑完就略過這一拍）。"""
    every = config["reconcileSec"]
    running = False
    while True:
        await asyncio.sleep(every)
        if running:
            continue
        running = True
        try:
            await run_reconcile(config, store, "定時")
        except Exception as err:  # noqa: BLE001
            log("[對帳] 迴圈例外：" + str(err))
            events.emit("reconcile_loop_exception", level="ERROR", source="reconcile", detail={"error": str(err)[:200]})
        finally:
            running = False
