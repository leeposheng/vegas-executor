"""進入點：python -m vegas_executor.main

流程同 Node 版 start()：驗證設定 → 狀態檔綁定資金模式 → 載入規格 → 開機自檢（失敗只開 kill switch、
不退出）→ 啟動 HTTP 與對帳排程。單一 uvicorn worker（模組層級的 Gate／權益快取依賴單一行程）。
"""
import asyncio
import contextlib
import os
import sys

from . import alerts, events, notify, symbols
from .app import create_app
from .botrt import BotRuntime
from .config import ConfigError, load_config
from .service import install_symbols, log, preflight, reconcile_loop
from .store import Store


def banner(config, store, syms, pre):
    bar = "─" * 56
    mode = ("DRY_RUN（不會送出真實委託）" if config["dryRun"]
            else "DEMO（交易所模擬盤）" if config["demo"] else "⚠️ LIVE（真實資金）")
    em = config["executionMode"]
    decide = ("manual（一律等你確認）" if em == "manual" else "auto（通過閘門就下單）" if em == "auto"
              else f"by_grade（等級 {config['autoGradeMin']} 以上自動，其餘等確認）")
    r = config["risk"]
    lines = [bar, "維加斯執行服務（Python）已啟動",
             "  服務角色    : " + ("shadow（模擬服務）" if config["instanceRole"] == "shadow" else "live（主服務）"),
             f"  狀態檔      : {config['dataDir']}（{'實盤' if store.get_mode() == 'live' else '模擬盤'}）",
             f"  連接埠      : {int(config['port'])}", f"  執行模式    : {mode}", f"  下單決策    : {decide}",
             f"  確認時效    : {config['pendingTtlSec']} 秒", "  下單交易所  : " + "、".join(config["exchanges"]),
             f"  倉位模式    : {r.get('sizingMode')}", f"  最低等級    : {r.get('minGrade')}",
             "  允許週期    : " + ", ".join(r.get("allowedTimeframes") or []),
             f"  支援代碼    : {len(symbols.list_supported())} 個（規格來源：{syms['source']}）",
             "  對帳迴圈    : " + ("停用（DRY_RUN 下無真實部位）" if config["dryRun"] else f"每 {config['reconcileSec']} 秒")]
    if not pre["ok"]:
        lines += [bar, "⛔ 自檢未通過，目前不會下任何單", "   " + str(pre.get("reason")),
                  "   對帳仍在運作，已開的部位會繼續結算。", "   修好之後：POST /control/resume"]
    lines.append(bar)
    for ln in lines:
        log(ln)


async def build(config=None, env=None, getter=None):
    """組裝服務（不啟動 server）。回傳 (config, store, syms, pre)。"""
    if config is None:
        config = load_config(env=env or os.environ, warn=log)
    store = Store(config["dataDir"])
    events.configure_from_env(env or os.environ, config["dataDir"])
    bound = store.bind_mode("demo" if config["demo"] else "live", config.get("instanceRole"))
    if not bound["ok"]:
        raise RuntimeError("狀態檔模式不符：" + str(bound.get("error")))
    syms = await install_symbols(config, getter=getter)
    pre = await preflight(config, store)
    return config, store, syms, pre


def report_startup_failure(err):
    # 逐行輸出：雲端日誌收集器常把多行當成一筆、只保留第一行
    for line in str(err).split("\n"):
        line = line.strip()
        if line:
            log("[啟動失敗] " + line)


def install_crash_hooks(config):
    """未捕捉例外：寫事件＋告警，再交還預設處理（行程照舊結束／繼續）。"""
    async def sender(text):
        await notify.send(text, config["telegram"])
    alerts.configure(sender)

    def report(where, exc):
        events.emit("uncaught_exception", level="ERROR", source=where,
                    detail={"type": type(exc).__name__, "error": str(exc)[:300]})
        alerts.failure("uncaught", f"未捕捉的例外（{where}）：{type(exc).__name__}: {str(exc)[:150]}", cooldown_s=300)

    prev = sys.excepthook

    def hook(tp, val, tb):
        report("main", val)
        prev(tp, val, tb)
    sys.excepthook = hook
    return report


def main():
    import uvicorn
    try:
        config, store, syms, pre = asyncio.run(build())
    except (ConfigError, RuntimeError, Exception) as err:  # noqa: BLE001
        report_startup_failure(err)
        sys.exit(1)

    report = install_crash_hooks(config)

    bot = None
    if os.environ.get("BOT_ENABLED", "").strip().lower() == "true":
        try:
            bot = BotRuntime(config, store, os.environ)
        except Exception as err:  # noqa: BLE001
            report_startup_failure(err)
            sys.exit(1)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        loop = asyncio.get_running_loop()
        default_handler = loop.get_exception_handler()

        def on_loop_error(lp, ctx):
            exc = ctx.get("exception")
            if exc is not None:
                report("asyncio", exc)
            else:
                events.emit("uncaught_exception", level="ERROR", source="asyncio",
                            detail={"message": str(ctx.get("message"))[:300]})
            if default_handler:
                default_handler(lp, ctx)
            else:
                lp.default_exception_handler(ctx)
        loop.set_exception_handler(on_loop_error)
        events.emit("service_started", source="service",
                    detail={"mode": "DRY_RUN" if config["dryRun"] else ("DEMO" if config["demo"] else "LIVE"),
                            "role": config["instanceRole"], "exchange": config["primaryExchange"],
                            "port": int(config["port"]), "eventsFile": events.stats()["file"]})
        task = None
        if not config["dryRun"] and config["reconcileSec"] > 0:
            task = asyncio.create_task(reconcile_loop(config, store))
        banner(config, store, syms, pre)
        log("  Telegram 層  : " + ("啟用（POST /?source=tradingview|telegram）" if bot else "關閉（BOT_ENABLED 未設為 true）"))
        bot_task = None
        if bot:
            bot.loop = loop
            bot_task = asyncio.create_task(bot.tick_loop())
        try:
            yield
        finally:
            if task:
                task.cancel()
            if bot_task:
                bot_task.cancel()
            events.emit("service_stopping", source="service", detail={})
            log("\n收到關閉訊號，儲存狀態後結束。")
            store.save()

    app = create_app(config, store, syms, pre, bot=bot)
    app.router.lifespan_context = lifespan
    uvicorn.run(app, host="0.0.0.0", port=int(config["port"]), workers=1, log_level="warning")


if __name__ == "__main__":
    main()
