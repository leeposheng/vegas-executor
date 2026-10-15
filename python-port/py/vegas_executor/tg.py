"""sendTelegramMessage_／fetchWithRetry_ 的忠實移植（Code.gs）。

fetch(url, opts) -> (status, text, headers)；網路層失敗時拋例外。sleep(ms)、rng() 皆可注入，測試才不會真的睡。
"""
import json
import random
import time

from .gas_util import js_String, js_truthy, parse_float, split_text, truncate

HTTP_MAX_ATTEMPTS = 3
RETRY_DELAYS_MS = [500, 1500]
MAX_CHUNK = 3800


class GasError(Exception):
    pass


def _retryable(status):
    return status in (408, 429) or status >= 500


def _delay_ms(attempt, headers, rng):
    if headers is not None:
        key = next((k for k in headers if k.lower() == "retry-after"), None)
        secs = parse_float(headers[key]) if key is not None else float("nan")
        if secs == secs and secs not in (float("inf"), float("-inf")) and secs >= 0:
            v = min(secs * 1000, 5000)
            return int(v) if v == int(v) else v
    return RETRY_DELAYS_MS[min(attempt, len(RETRY_DELAYS_MS) - 1)] + int(rng() * 250)


def fetch_with_retry(url, options, service, fetch, sleep=None, rng=None, log=None):
    sleep = sleep or (lambda ms: time.sleep(ms / 1000))
    rng = rng or random.random
    log = log or (lambda *a, **k: None)
    opts = dict(options or {}, muteHttpExceptions=True)
    last = None
    for attempt in range(HTTP_MAX_ATTEMPTS):
        try:
            status, text, headers = fetch(url, opts)
        except Exception as err:  # noqa: BLE001
            last = err
            if attempt >= HTTP_MAX_ATTEMPTS - 1:
                break
            d = _delay_ms(attempt, None, rng)
            log("warn", "http_network_retry", {"service": service, "attempt": attempt + 1, "delayMs": d})
            sleep(d)
            continue
        if 200 <= status < 300:
            return text
        last = GasError(f"{service} HTTP {status}: {truncate(text, 300)}")
        if not _retryable(status) or attempt >= HTTP_MAX_ATTEMPTS - 1:
            break
        d = _delay_ms(attempt, headers or {}, rng)
        log("warn", "http_status_retry", {"service": service, "status": status, "attempt": attempt + 1, "delayMs": d})
        sleep(d)
    raise last or GasError(f"{service} 請求失敗")


def send_message(token, chat_id, text, fetch, thread_id=None, sleep=None, rng=None, log=None):
    """分段（每段 3800 字元）送出；任何一段失敗就拋例外。"""
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    chunks = split_text(js_String(text), MAX_CHUNK)
    for i, chunk in enumerate(chunks):
        prefix = f"[{i + 1}/{len(chunks)}]\n" if len(chunks) > 1 else ""
        payload = {"chat_id": js_String(chat_id), "text": prefix + chunk}
        if js_truthy(thread_id):
            payload["message_thread_id"] = js_String(thread_id)
        body = fetch_with_retry(url, {"method": "post", "contentType": "application/x-www-form-urlencoded",
                                      "payload": payload}, "Telegram", fetch, sleep, rng, log)
        try:
            data = json.loads(body)
        except ValueError as err:
            raise GasError("Telegram 回應不是合法 JSON：" + str(err)[:80])
        if not (isinstance(data, dict) and js_truthy(data.get("ok"))):
            raise GasError("Telegram API 未回傳成功狀態")


def urllib_fetch(url, opts, timeout=15):
    """正式環境用的 fetch：GAS 的 form payload → application/x-www-form-urlencoded。回傳 (status, text, headers)。"""
    import urllib.error
    import urllib.parse
    import urllib.request
    payload = opts.get("payload")
    data = urllib.parse.urlencode(payload).encode() if isinstance(payload, dict) else None
    req = urllib.request.Request(url, data=data, method=(opts.get("method") or "get").upper(),
                                 headers={"Content-Type": opts.get("contentType") or "application/x-www-form-urlencoded",
                                          "User-Agent": "vegas-executor/py"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)
