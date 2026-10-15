import json

from vegas_executor import loopback


def fake(status, body, seen):
    def f(url, opts):
        seen.append((url, opts))
        if isinstance(body, Exception):
            raise body
        return status, body
    return f


def test_api_get_passes_key_and_parses():
    seen = []
    r = loopback.make_exec_api("http://127.0.0.1:8080", "k", fake(200, '{"ok":true,"maxConcurrent":2}', seen))("/limits", "get", None)
    assert r == {"ok": True, "maxConcurrent": 2}
    assert seen[0][0] == "http://127.0.0.1:8080/limits" and seen[0][1]["headers"] == {"X-Executor-Key": "k"} and "payload" not in seen[0][1]


def test_api_post_body_is_compact_json():
    seen = []
    loopback.make_exec_api("http://h", "k", fake(200, "{}", seen))("/limits", "post", {"maxConcurrent": 3})
    assert seen[0][1]["payload"] == '{"maxConcurrent":3}'


def test_api_non_json_and_exception_never_raise():
    r = loopback.make_exec_api("http://h", "k", fake(502, "<html>bad gateway</html>", []))("/daily", "get", None)
    assert r["ok"] is False and r["error"].startswith("HTTP 502：")
    r = loopback.make_exec_api("http://h", "k", fake(0, ConnectionError("refused"), []))("/daily", "get", None)
    assert r["ok"] is False and "refused" in r["error"]


def test_action_shape_and_errors():
    seen = []
    ok = loopback.make_exec_action("http://h", "k", fake(200, json.dumps({"decision": "placed", "dryRun": True, "drift": {"verdict": "resize"}}), seen))("confirm", "S1")
    assert ok == {"ok": True, "decision": "placed", "reasons": [], "drift": {"verdict": "resize"}, "dryRun": True}
    assert seen[0][0] == "http://h/confirm" and json.loads(seen[0][1]["payload"]) == {"sig_id": "S1", "notify": False}
    assert loopback.make_exec_action("http://h", "k", fake(403, "no", []))("skip", "S")["error"] == "HTTP 403"
    assert loopback.make_exec_action("http://h", "k", fake(200, "not json", []))("skip", "S")["ok"] is False
    assert loopback.make_exec_action("http://h", "k", fake(0, TimeoutError("t"), []))("skip", "S")["ok"] is False
