"""離線重放：把一批已發生的訊號餵給 Python 決策管線，與 Node 當時的結果逐筆比對。

用法：
  python -m vegas_executor.replay --from-telegram result.json [--since 2026-10-11] [--eras eras.json]
                                  [--instruments-json f | --fetch-instruments [--save-instruments f]]
  python -m vegas_executor.replay signals.jsonl [--expected zeabur.log] [--env-file .env] [--latency-ms 2000]
                                  [--report replay_report.json]

輸入
  signals.jsonl   每行一筆訊號（與 POST /signal 的 JSON 內容相同）。
  --expected      （選填）Zeabur 日誌檔；取其中的 `[signal] {...}` 行當作 Node 的標準答案，
                  依 sigId 對應，比對 decision／qty／risk（reasons 只列出差異，不算失敗）。

安全（全部寫死，不受 .env 影響）
  * 強制 DRY_RUN=true、DEMO_MODE=true；清空所有交易所金鑰與 Telegram 設定 → 絕不連交易所、絕不發訊息。
  * 狀態檔放在全新的暫存資料夾，不會碰 Volume 上的 state.json。
  * 現價一律假設等於訊號的 entry（漂移檢查視為「沒漂」）；權益取設定檔的 ACCOUNT_EQUITY_USDT。

限制（結果解讀時要知道）
  * 風控閘門有依賴狀態的項目（持倉數、當日虧損、停止下單、重複代碼）：重放是從空狀態開始，
    Node 當時的狀態不在輸入裡，所以這幾類差異屬預期，報告會單獨標成「狀態相依」，不算決策邏輯差異。
  * 時鐘設為「訊號 ts ＋ latency」，用來避開 maxSignalAgeSec 的過期判斷。
"""
import argparse
import asyncio
import json
import os
import re
import sys
import tempfile

from . import alerts, clock, equity, events, notify, replay_cards as RC, symbols
from .config import ConfigError, load_config
from .exchanges import okx
from .executor import handle_signal
from .okx_check import REPO_DOTENV, _parse_dotenv
from .store import Store

STATE_DEPENDENT = ("kill_switch", "max_concurrent", "no_duplicate_symbol", "daily_loss", "idempotency")
FORCED = {"DRY_RUN": "true", "DEMO_MODE": "true", "TG_TOKEN": "", "TG_CHAT_ID": "",
          "OKX_API_KEY": "", "OKX_API_SECRET": "", "OKX_PASSPHRASE": "",
          "BINGX_API_KEY": "", "BINGX_API_SECRET": "", "EQUITY_SOURCE": "config", "INSTANCE_ROLE": "live"}


def read_signals(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                out.append(json.loads(line))
            except ValueError as err:
                raise SystemExit(f"{path} 第 {n} 行不是合法 JSON：{err}")
    return out


def read_expected(path):
    """從 Zeabur 日誌取 `[signal] {...}` 行；同一個 sigId 取最後一筆。"""
    exp = {}
    rx = re.compile(r"\[signal\]\s*(\{.*\})\s*$")
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = rx.search(line)
            if not m:
                continue
            try:
                d = json.loads(m.group(1))
            except ValueError:
                continue
            if d.get("sigId"):
                exp[d["sigId"]] = d
    return exp


def build_env(env_file, base_env):
    env = dict(_parse_dotenv(env_file)) if env_file and os.path.exists(env_file) else {}
    env.update({k: v for k, v in base_env.items() if k in env or k.startswith(("RISK_", "SIZING_", "FIXED_"))})
    env.update(FORCED)
    env["DATA_DIR"] = tempfile.mkdtemp(prefix="replay-")
    env.setdefault("EXECUTOR_WEBHOOK_SECRET", "r" * 24)
    env.setdefault("EXECUTOR_CONTROL_SECRET", "q" * 24)
    return env


def classify(got, want):
    """回傳 (status, 差異說明)。status：match／state／diff。"""
    diffs = []
    for k_got, k_want in (("decision", "decision"), ("qty", "qty"), ("risk", "risk")):
        a, b = got.get(k_got), want.get(k_want)
        if a is None and b is None:
            continue
        same = (a == b) or (isinstance(a, (int, float)) and isinstance(b, (int, float)) and abs(a - b) < 1e-9)
        if not same:
            diffs.append(f"{k_got}: Python={a!r} Node={b!r}")
    if not diffs:
        return "match", []
    texts = " ".join(map(str, (got.get("reasons") or []) + (want.get("reasons") or [])))
    if any(g in texts for g in STATE_DEPENDENT) and not (got.get("decision") == want.get("decision") == "rejected"):
        return "state", diffs
    return "diff", diffs


async def run(signals, config, latency_ms, expected):
    store = Store(config["dataDir"])
    rows = []
    cell = {"price": float("nan")}

    async def fake_ticker(inst, cfg):
        return {"last": cell["price"]}
    orig_ticker = okx.fetch_ticker
    okx.fetch_ticker = fake_ticker
    try:
        for s in signals:
            ts = s.get("ts") if isinstance(s, dict) else None
            clock.set_now((int(ts) if isinstance(ts, (int, float)) else clock.now_ms()) + latency_ms)
            entry = s.get("entry") if isinstance(s, dict) else None
            cell["price"] = float(entry) if isinstance(entry, (int, float)) else float("nan")
            r = await handle_signal(s, {"config": config, "store": store, "suppressNotify": True})
            sz = r.get("sizing") or {}
            got = {"sigId": r.get("sigId"), "decision": r.get("decision"), "stage": r.get("stage"),
                   "qty": sz.get("orderQty"), "risk": sz.get("actualRiskUsdt"), "reasons": r.get("reasons") or []}
            row = {"sigId": got["sigId"], "python": got}
            want = expected.get(got["sigId"]) if expected else None
            if want is not None:
                status, diffs = classify(got, want)
                row.update(node={k: want.get(k) for k in ("decision", "stage", "qty", "risk", "reasons")},
                           status=status, diffs=diffs)
            rows.append(row)
    finally:
        okx.fetch_ticker = orig_ticker
    return rows


def summarize(rows, expected):
    tally = {}
    for r in rows:
        k = r["python"]["decision"]
        tally[k] = tally.get(k, 0) + 1
    out = {"signals": len(rows), "pythonDecisions": tally}
    if expected:
        cmp_ = [r for r in rows if "status" in r]
        out["compared"] = len(cmp_)
        out["notInNodeLog"] = len(rows) - len(cmp_)
        for k in ("match", "state", "diff"):
            out[k] = sum(1 for r in cmp_ if r["status"] == k)
    return out


CARD_BASE = {"EXECUTION_MODE": "manual", "MAX_NOTIONAL_USDT": "1000000", "MAX_NOTIONAL_MULT": "1000", "MIN_GRADE": "1",
             "ALLOWED_TIMEFRAMES": "1,5,15,30,60,240", "MAX_CONCURRENT_POSITIONS": "20", "MAX_CONCURRENT_CEILING": "20",
             "DRIFT_CHECK": "false", "ACCOUNT_EQUITY_USDT": "10000", "DAILY_LOSS_LIMIT_USDT": "50000",
             "DAILY_LOSS_CEILING_USDT": "100000"}


def fetch_instruments(base="https://www.okx.com"):
    """唯一會上網的步驟：只打 OKX 公開 instruments 端點（不帶金鑰、不簽章）。"""
    status, js = okx._http_get(f"{base}/api/v5/public/instruments?instType=SWAP", timeout=20)
    if status != 200 or js.get("code") != "0":
        raise SystemExit(f"取得 OKX instruments 失敗：HTTP {status} {str(js)[:120]}")
    return js


async def run_cards(cards, eras, specs, latency_ms):
    """每張卡用獨立空狀態重放；設定＝時期設定＋卡片自己的拒絕原因所透露的設定。"""
    rows = []
    cell = {"price": float("nan")}

    async def fake_ticker(inst, cfg):
        return {"last": cell["price"]}
    orig_ticker = okx.fetch_ticker
    okx.fetch_ticker = fake_ticker
    all_syms = sorted({c["symbol"] for c in cards})
    try:
        for c in cards:
            era = RC.era_env(eras, c["date"])
            if era is None:
                rows.append({"sigId": RC.card_signal(c)["sig_id"], "date": c["date"], "status": "skipped",
                             "diffs": ["早於第一個時期設定"]})
                continue
            env = dict(CARD_BASE)
            env.update(era)
            env.update(RC.reason_env(c))
            allowed = [x for x in all_syms if not ((c.get("reason") or "").startswith(f"代碼 {c['symbol']} 不在白名單") and x == c["symbol"])]
            env["ALLOWED_SYMBOLS"] = ",".join(allowed)
            env.update(FORCED)
            env["DATA_DIR"] = tempfile.mkdtemp(prefix="replay-")
            env["EXECUTOR_WEBHOOK_SECRET"] = "r" * 24
            env["EXECUTOR_CONTROL_SECRET"] = "q" * 24
            try:
                cfg = load_config(env=env, warn=lambda *_: None)
            except ConfigError as err:
                rows.append({"sigId": RC.card_signal(c)["sig_id"], "date": c["date"], "status": "skipped",
                             "diffs": ["設定載入失敗：" + str(err)[:120]]})
                continue
            symbols.install(allowed=list(cfg["risk"]["allowedSymbols"]), specs=specs)
            sig = RC.card_signal(c)
            clock.set_now(sig["ts"] + latency_ms)
            cell["price"] = float(c["entry"])
            r = await handle_signal(sig, {"config": cfg, "store": Store(env["DATA_DIR"]), "suppressNotify": True})
            sz = r.get("sizing") or {}
            status, diffs = RC.compare(c, r)
            rows.append({"sigId": sig["sig_id"], "date": c["date"], "kind": c["kind"], "status": status, "diffs": diffs,
                         "python": {"decision": r.get("decision"), "qty": sz.get("orderQty"),
                                    "risk": sz.get("actualRiskUsdt"), "reasons": r.get("reasons") or []},
                         "card": {k: c.get(k) for k in ("qty", "risk", "notional", "lev", "reason")}})
    finally:
        okx.fetch_ticker = orig_ticker
        symbols.reset()
    return rows


def main_cards(a):
    for flag, path in (("--from-telegram", a.from_telegram), ("--instruments-json", a.instruments_json), ("--eras", a.eras)):
        if path and not os.path.isfile(path):
            print(f"找不到 {flag} 指定的檔案：{path}\n目前所在資料夾：{os.getcwd()}\n"
                  "請改用完整路徑，例如：--from-telegram \"C:\\Users\\你\\Downloads\\result.json\"")
            return 2
    events.reset()
    alerts.reset()
    cards = RC.load_cards(a.from_telegram, a.since)
    eras = json.load(open(a.eras, encoding="utf-8")) if a.eras else None
    if a.instruments_json:
        specs, src = RC.specs_from_okx(json.load(open(a.instruments_json, encoding="utf-8"))), "okx-file"
    elif a.fetch_instruments:
        js = fetch_instruments()
        if a.save_instruments:
            with open(a.save_instruments, "w", encoding="utf-8") as f:
                json.dump(js, f, ensure_ascii=False)
        specs, src = RC.specs_from_okx(js), "okx-public"
    else:
        specs, src = RC.infer_specs(cards), "inferred"
    miss = sorted({RC.inst_id(c["symbol"]) for c in cards} - set(specs))
    if miss:
        extra = RC.infer_specs(cards)
        for m in miss:
            if m in extra:
                specs[m] = extra[m]
    async def quiet(text, cfg, opts=None):
        return {"sent": False}
    orig_send = notify.send
    notify.send = quiet
    equity.reset_cache()
    try:
        rows = asyncio.run(run_cards(cards, eras, specs, a.latency_ms))
    finally:
        clock.set_now(None)
        notify.send = orig_send
        equity.reset_cache()
    tally = {k: sum(1 for r in rows if r["status"] == k) for k in ("match", "state", "runtime", "diff", "skipped")}
    summary = {"cards": len(rows), "specs": src, **tally}
    with open(a.report, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "rows": rows}, f, ensure_ascii=False, indent=1)
    print(f"以 Telegram 決策卡重放 {len(rows)} 張（DRY_RUN、不連交易所）｜合約規格：{src}")
    print(f"一致 {tally['match']}｜狀態相依 {tally['state']}｜下單階段失敗 {tally['runtime']}｜決策差異 {tally['diff']}｜略過 {tally['skipped']}")
    for r in rows:
        if r["status"] == "diff":
            print(f"  ✗ {r['sigId']}（{r['date'][:16]}）：" + "；".join(r["diffs"]))
    print(f"完整結果：{a.report}")
    return 1 if tally["diff"] else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="離線重放訊號並與 Node 結果比對（絕不連交易所）")
    ap.add_argument("signals", nargs="?")
    ap.add_argument("--from-telegram", help="Telegram 匯出檔 result.json：由決策卡重建訊號與預期值")
    ap.add_argument("--since", help="只取此日期（YYYY-MM-DD）之後的卡片")
    ap.add_argument("--eras", help="時期設定檔 JSON：{起始日: {環境變數: 值}}")
    ap.add_argument("--instruments-json", help="OKX instruments 回應檔（取代由卡片反推的規格）")
    ap.add_argument("--fetch-instruments", action="store_true", help="從 OKX 公開端點取規格（唯一會上網的步驟，不帶金鑰）")
    ap.add_argument("--save-instruments", help="把取得的 instruments 存檔，之後可離線用 --instruments-json")
    ap.add_argument("--expected")
    ap.add_argument("--env-file", default=str(REPO_DOTENV))
    ap.add_argument("--latency-ms", type=int, default=2000)
    ap.add_argument("--report", default="replay_report.json")
    a = ap.parse_args(argv)
    if a.from_telegram:
        return main_cards(a)
    if not a.signals:
        ap.error("需要 signals.jsonl 或 --from-telegram")

    events.reset()
    alerts.reset()
    try:
        config = load_config(env=build_env(a.env_file, os.environ), warn=lambda *_: None)
    except ConfigError as err:
        print("設定載入失敗：\n" + str(err))
        return 2

    async def quiet(text, cfg, opts=None):
        return {"sent": False}
    orig_send = notify.send
    notify.send = quiet
    equity.reset_cache()
    signals = read_signals(a.signals)
    expected = read_expected(a.expected) if a.expected else {}
    try:
        rows = asyncio.run(run(signals, config, a.latency_ms, expected))
    finally:
        clock.set_now(None)
        notify.send = orig_send
        equity.reset_cache()
    summary = summarize(rows, expected)
    with open(a.report, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "rows": rows}, f, ensure_ascii=False, indent=1)

    print(f"重放 {summary['signals']} 筆（DRY_RUN、不連交易所）｜Python 決策：{summary['pythonDecisions']}")
    if expected:
        print(f"與 Node 日誌比對：{summary['compared']} 筆（日誌裡找不到的 {summary['notInNodeLog']} 筆）｜"
              f"一致 {summary['match']}｜狀態相依 {summary['state']}｜決策差異 {summary['diff']}")
        for r in rows:
            if r.get("status") == "diff":
                print(f"  ✗ {r['sigId']}：" + "；".join(r["diffs"]))
        for r in rows:
            if r.get("status") == "state":
                print(f"  ~ {r['sigId']}（狀態相依，預期內）：" + "；".join(r["diffs"]))
    print(f"完整結果：{a.report}")
    return 1 if expected and summary.get("diff") else 0


if __name__ == "__main__":
    sys.exit(main())
