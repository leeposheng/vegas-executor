import json

from vegas_executor import replay, replay_cards as RC

PENDING = ("⏳ 待確認｜做多⬆\n─────────────\n[時間] 2026-10-14 03:15\n[幣種] TIAUSDT.P\n[週期] 15分鐘\n"
           "[品質] 弱訊（40｜降級：弱收盤過多＋觸碰過多）\n[價格] 0.5824 USDT\n[止損] 0.5668 USDT\n[止盈1] 0.598 USDT\n"
           "[止盈2] 0.6136 USDT\n[止盈3] 0.6292 USDT\n─────────────\n[風險] 16.67 USDT（上限 22.00）\n"
           "[名目] 599.87 USDT｜槓桿 12x（自動，原 40x：強平緩衝 3x 限制）\n[數量] 1030 張")
REJECT = ("⛔ 未執行｜做空⬇\n─────────────\n[時間] 2026-10-14 09:45\n[幣種] RUNEUSDT.P\n[週期] 15分鐘\n"
          "[品質] 高品質（85）\n[價格] 0.658 USDT\n[止損] 0.6653 USDT\n[止盈1] 0.6507 USDT\n[止盈2] 0.6433 USDT\n"
          "[止盈3] 0.636 USDT\n─────────────\n[原因] 代碼 RUNEUSDT.P 不在白名單內，拒絕下單")


def export(tmp_path, *texts):
    msgs = [{"id": i + 1, "date": f"2026-10-14T0{i}:00:00", "text": t} for i, t in enumerate(texts)]
    p = tmp_path / "result.json"
    p.write_text(json.dumps({"messages": msgs + [msgs[0]]}), encoding="utf-8")   # 重複一張，驗證去重
    return str(p)


def test_parse_and_dedupe(tmp_path):
    cards = RC.load_cards(export(tmp_path, PENDING, REJECT))
    assert [c["kind"] for c in cards] == ["pending", "rejected"]
    c = cards[0]
    assert (c["symbol"], c["side"], c["tf"], c["label"], c["qty"], c["lev"]) == ("TIAUSDT.P", "long", 15, "弱訊", 1030.0, 12)
    assert RC.card_signal(c)["grade"] == 1 and RC.card_signal(c)["tp"] == [0.598, 0.6136, 0.6292]


def test_replay_matches_cards(tmp_path):
    out = tmp_path / "rep.json"
    code = replay.main(["--from-telegram", export(tmp_path, PENDING, REJECT), "--report", str(out)])
    rows = json.loads(out.read_text(encoding="utf-8"))["rows"]
    assert code == 0 and [r["status"] for r in rows] == ["match", "match"]


def test_specs_from_okx_and_reason_env():
    s = RC.specs_from_okx({"data": [{"instId": "TIA-USDT-SWAP", "ctVal": "1", "lotSz": "1", "minSz": "1", "tickSz": "0.0001"}]})
    assert s["TIA-USDT-SWAP"]["lotSz"] == 1.0
    assert RC.reason_env({"reason": "timeframe: 週期 5 不在白名單 [15, 30]"}) == {"ALLOWED_TIMEFRAMES": "15,30"}
    assert RC.reason_env({"reason": "虧損 14.06 < 下限 20（止損 0.252%）"}) == {"TARGET_LOSS_MIN_USDT": "20"}


def test_diff_detected(tmp_path):
    bad = PENDING.replace("[數量] 1030 張", "[數量] 1100 張")
    code = replay.main(["--from-telegram", export(tmp_path, bad), "--report", str(tmp_path / "r.json")])
    assert code == 1


def test_specs_skip_unlisted_rows():
    rows = [{"instId": "NEW-USDT-SWAP", "ctVal": "", "lotSz": "", "minSz": "", "state": "preopen"},
            {"instId": "TIA-USDT-SWAP", "ctVal": "1", "lotSz": "1", "minSz": "1", "tickSz": "0.0001"}]
    assert list(RC.specs_from_okx({"data": rows})) == ["TIA-USDT-SWAP"]
