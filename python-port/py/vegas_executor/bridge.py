"""行程內橋接：把 Executor.gs 的 postToExecutor_（HTTP POST /signal）換成直接呼叫 handle_signal。

GAS 版要經網路轉一圈（含 60 秒重放保護、HTTP 逾時、補送佇列）；合併成同一個服務後，轉送是函式呼叫，
但回傳形狀維持與 postToExecutor_ 完全一致，所以卡片／日誌／補送邏輯（forward.py）不必知道差別。
轉送函式在執行緒裡跑（同步），handle_signal 是協程，所以用 run_coroutine_threadsafe 丟回事件迴圈。
逾時只放棄等待、不取消 handle_signal（取消可能卡在下單中途）；補送時由執行層的 sig_id 冪等保護擋掉重複。
notify:false 的語意在這裡就是 suppressNotify=True：Telegram 那一則由卡片流程發，執行層不重複推播。
"""
import asyncio
import time

from .gas_util import js_str, truncate


def shape_result(body, elapsed_ms, dry_run):
    """handle_signal 的結果 → postToExecutor_ 的成功形狀。"""
    return {"ok": True, "elapsedMs": elapsed_ms, "decision": body.get("decision") or "unknown",
            "reasons": body.get("reasons") or [], "sizing": body.get("sizing") or None,
            "band": body.get("band") or None, "preview": body.get("preview") or None,
            "equity": body.get("equity") or None, "overLimit": body.get("overLimit") or None,
            "addOn": body.get("addOn") or None, "dryRun": bool(dry_run)}


def make_post(handle_signal, loop, ctx, timeout_s=60, clock=time.monotonic):
    """回傳同步函式 post(payload, cfg)。ctx 需含 config／store；永不拋例外。"""
    def post(payload, cfg=None):
        started = clock()

        def ms():
            return int((clock() - started) * 1000)
        try:
            run_ctx = {**ctx, "suppressNotify": True}
            fut = asyncio.run_coroutine_threadsafe(handle_signal(dict(payload), run_ctx), loop)
            body = fut.result(timeout_s)
            return shape_result(body, ms(), (ctx.get("config") or {}).get("dryRun"))
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "elapsedMs": ms(),
                    "error": "執行層處理失敗：" + truncate(js_str(str(err) or err.__class__.__name__), 120)}
    return post
