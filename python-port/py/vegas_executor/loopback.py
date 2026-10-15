"""按鈕回呼用的「執行層 API」：直接對本服務自己的 HTTP 端點（127.0.0.1）發請求。

好處：/limits、/daily、/daily/reset、/confirm、/skip 的驗證與錯誤訊息只有一份實作（app.py），
Telegram 層與外部呼叫走同一條路徑，行為不可能分岔。回傳形狀對應 Executor.gs 的
callExecutorApi_（永不拋例外，失敗回 {ok:false, error}）與 callExecutorAction_。
"""
import json

from .gas_util import js_json, truncate


def json_fetch(url, opts, timeout=20):
    """正式環境的 fetch：(status, text)。HTTP 錯誤碼也回傳內文，不拋例外。"""
    import urllib.error
    import urllib.request
    payload = opts.get("payload")
    req = urllib.request.Request(url, data=payload.encode("utf-8") if isinstance(payload, str) else None,
                                 method=(opts.get("method") or "get").upper(),
                                 headers={**(opts.get("headers") or {}), **({"Content-Type": "application/json"} if payload else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def make_exec_api(base_url, secret, fetch=json_fetch):
    def api(path, method, body):
        try:
            opts = {"method": method, "headers": {"X-Executor-Key": secret}}
            if body:
                opts["payload"] = js_json(body)
            status, text = fetch(base_url + path, opts)
            try:
                return json.loads(text)
            except ValueError:
                return {"ok": False, "error": "HTTP " + str(status) + "：" + truncate(text, 120)}
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": "執行層無回應：" + truncate(str(err) or err.__class__.__name__, 120)}
    return api


def make_exec_action(base_url, secret, fetch=json_fetch):
    def action(name, sig_id):
        try:
            status, text = fetch(base_url + "/" + name, {"method": "post", "headers": {"X-Executor-Key": secret},
                                                          "payload": js_json({"sig_id": sig_id, "notify": False})})
            if status != 200:
                return {"ok": False, "error": "HTTP " + str(status)}
            body = json.loads(text)
            return {"ok": True, "decision": body.get("decision"), "reasons": body.get("reasons") or [],
                    "drift": body.get("drift") or None, "dryRun": bool(body.get("dryRun"))}
        except Exception as err:  # noqa: BLE001
            return {"ok": False, "error": str(err) or err.__class__.__name__}
    return action
