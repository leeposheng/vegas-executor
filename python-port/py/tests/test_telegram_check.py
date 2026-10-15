import asyncio

from vegas_executor import notify, telegram_check as T

TOKEN, CHAT = "111:TEST", "-100999"


def run(terminal, tmp_path, env_text="", api=None, monkeypatch=None):
    p = tmp_path / ".env"
    p.write_text(env_text, encoding="utf-8")
    return asyncio.run(T.main(terminal, str(p), api=api))


def test_requires_test_vars(tmp_path, capsys):
    assert run({}, tmp_path) == 2
    assert "TG_TEST_TOKEN" in capsys.readouterr().out


def test_refuses_live_token_or_chat(tmp_path, capsys):
    t = {"TG_TEST_TOKEN": TOKEN, "TG_TEST_CHAT_ID": CHAT}
    assert run(t, tmp_path, "TG_TOKEN=111:LIVE\n") == 2          # 同一個 bot（冒號前 id 相同）
    assert "同一個 bot" in capsys.readouterr().out
    assert run(t, tmp_path, "SIGNAL_CHAT_ID=-100999\n") == 2     # 同一個群組
    assert "同一個群組" in capsys.readouterr().out


def test_happy_path(tmp_path, monkeypatch, capsys):
    posted = []

    def fake_post(token, payload):
        posted.append(payload["text"])
        return 200, {"ok": True}

    def fake_api(token, method, payload=None):
        if method == "getMe":
            return {"ok": True, "result": {"username": "t_bot", "id": 1}}
        if method == "getChat":
            return {"ok": True, "result": {"title": "測試群", "type": "supergroup"}}
        return {"ok": False, "error_code": 400}                  # 4097 探測：被拒絕才算通過

    monkeypatch.setattr(notify, "_post", fake_post)
    code = run({"TG_TEST_TOKEN": TOKEN, "TG_TEST_CHAT_ID": CHAT}, tmp_path, api=fake_api)
    out = capsys.readouterr().out
    assert code == 0 and "✗" not in out
    assert all(t.startswith(T.LABEL) for t in posted) and len(posted) >= 3
    assert TOKEN not in out


def test_bad_token(tmp_path, capsys):
    api = lambda *a, **k: {"ok": False, "error_code": 401}   # noqa: E731
    assert run({"TG_TEST_TOKEN": TOKEN, "TG_TEST_CHAT_ID": CHAT}, tmp_path, api=api) == 1
