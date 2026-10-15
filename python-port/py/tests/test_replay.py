"""離線重放工具：全程不連網、不發訊息、不碰真實狀態檔。"""
import json
import os
import tempfile

import pytest

from vegas_executor import clock, equity, notify, replay, symbols
from vegas_executor.exchanges import okx

NOW = 1758470000000


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    yield
    clock.set_now(None)
    symbols.reset()
    equity.reset_cache()
    okx.set_transport(None) if hasattr(okx, "set_transport") else None


def sig(i, **o):
    p = {"v": "11.8", "sig_id": f"BTCUSDT.P-15-{NOW - 5000 - i}-long", "ts": NOW - 5000 - i, "symbol": "BTCUSDT.P",
         "tf": "15", "grade": 3, "score": 85, "side": "long", "entry": 85397.5, "sl": 85011.8,
         "tp": [85783.2, 86169.0, 86554.7]}
    p.update(o)
    return p


def write(tmp, name, text):
    p = os.path.join(tmp, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p


def setup(monkeypatch, signals, env_extra=""):
    tmp = tempfile.mkdtemp(prefix="rp-")
    sp = write(tmp, "signals.jsonl", "\n".join(json.dumps(s) for s in signals) + "\n")
    envp = write(tmp, ".env", "ALLOWED_SYMBOLS=BTCUSDT.P,ETHUSDT.P\nALLOWED_TIMEFRAMES=15,60\nMIN_GRADE=2\n"
                              "EXECUTION_MODE=auto\nMAX_NOTIONAL_USDT=50000\n" + env_extra)
    return tmp, sp, envp, os.path.join(tmp, "report.json")


def boom(*a, **k):
    raise AssertionError("重放不得連網")


def run(monkeypatch, tmp, sp, envp, rep, *extra):
    monkeypatch.setattr(okx, "_urllib_transport", boom, raising=False)
    return replay.main([sp, "--env-file", envp, "--report", rep, *extra])


def test_replay_without_expected(monkeypatch, capsys):
    tmp, sp, envp, rep = setup(monkeypatch, [sig(0), sig(1, grade=1), sig(2, symbol="DOGEUSDT.P")])
    assert run(monkeypatch, tmp, sp, envp, rep) == 0
    out = json.load(open(rep, encoding="utf-8"))
    dec = [r["python"]["decision"] for r in out["rows"]]
    assert dec[0] in ("placed", "pending") and dec[1] == "rejected" and dec[2] == "rejected"
    assert out["summary"]["signals"] == 3
    assert "重放 3 筆" in capsys.readouterr().out


def test_expected_match_diff_and_state(monkeypatch, capsys):
    sigs = [sig(0), sig(1), sig(2)]
    tmp, sp, envp, rep = setup(monkeypatch, sigs)
    assert run(monkeypatch, tmp, sp, envp, rep) == 0
    rows = json.load(open(rep, encoding="utf-8"))["rows"]
    lines = []
    for r in rows:
        p = r["python"]
        lines.append("2026-10-15 [signal] " + json.dumps({"sigId": p["sigId"], "decision": p["decision"], "qty": p["qty"],
                                                         "risk": p["risk"], "reasons": p["reasons"]}))
    exp = write(tmp, "zeabur.log", "\n".join(["noise line", *lines, "[signal] {壞掉的json"]) + "\n")
    assert run(monkeypatch, tmp, sp, envp, rep, "--expected", exp) == 0
    s = json.load(open(rep, encoding="utf-8"))["summary"]
    assert s["match"] == 3 and s["diff"] == 0 and s["state"] == 0

    # 改掉 Node 的數量 → 決策差異、結束碼 1
    bad = lines[0].replace(f'"qty": {rows[0]["python"]["qty"]}', '"qty": 999')
    exp2 = write(tmp, "bad.log", "\n".join([bad, *lines[1:]]) + "\n")
    assert run(monkeypatch, tmp, sp, envp, rep, "--expected", exp2) == 1
    assert "✗" in capsys.readouterr().out

    # Node 當時因「持倉已滿」拒單，而 Python 從空狀態會放行 → 狀態相依，不算差異
    p0 = rows[0]["python"]
    st = "[signal] " + json.dumps({"sigId": p0["sigId"], "decision": "rejected", "qty": None, "risk": None,
                                   "reasons": ["max_concurrent: 目前持倉 5 筆，已達上限 5"]})
    exp3 = write(tmp, "state.log", "\n".join([st, *lines[1:]]) + "\n")
    assert run(monkeypatch, tmp, sp, envp, rep, "--expected", exp3) == 0
    s = json.load(open(rep, encoding="utf-8"))["summary"]
    assert s["state"] == 1 and s["diff"] == 0


def test_forced_safe_mode_ignores_env_and_terminal(monkeypatch):
    """即使 .env 與終端機設了實盤與金鑰，重放仍是 DRY_RUN、不發訊息。"""
    sent = []

    async def spy(text, cfg, opts=None):
        sent.append(text)
        return {"sent": True}
    monkeypatch.setenv("DRY_RUN", "false")
    monkeypatch.setenv("DEMO_MODE", "false")
    monkeypatch.setenv("TG_TOKEN", "real-token")
    monkeypatch.setenv("OKX_API_KEY", "k")
    tmp, sp, envp, rep = setup(monkeypatch, [sig(0)], "DRY_RUN=false\nTG_TOKEN=abc\nTG_CHAT_ID=1\nOKX_API_KEY=k\n")
    seen = {}
    real_load = replay.load_config

    def spy_load(env, warn):
        cfg = real_load(env=env, warn=warn)
        seen.update(dry=cfg["dryRun"], demo=cfg["demo"], tg=cfg["telegram"], key=cfg["okx"]["apiKey"])
        return cfg
    monkeypatch.setattr(replay, "load_config", spy_load)
    monkeypatch.setattr(notify, "send", spy)
    assert run(monkeypatch, tmp, sp, envp, rep) == 0
    assert seen["dry"] is True and seen["demo"] is True and not seen["tg"]["token"] and not seen["key"]
    assert sent == []
    # 狀態檔在暫存資料夾，不是 .env 指的位置
    assert not os.path.exists(os.path.join(tmp, "state.json"))


def test_bad_inputs(monkeypatch, capsys):
    tmp = tempfile.mkdtemp()
    sp = write(tmp, "s.jsonl", "{壞\n")
    with pytest.raises(SystemExit):
        replay.read_signals(sp)
