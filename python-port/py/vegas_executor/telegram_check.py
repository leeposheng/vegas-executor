"""Telegram 實發檢查（第 3 關）：python -m vegas_executor.telegram_check

只對「你另建的測試 bot＋測試群組」送訊息；金鑰只讀終端機變數 TG_TEST_TOKEN／TG_TEST_CHAT_ID，
**不讀 .env、不讀 TG_TOKEN**，並且在送出前比對 .env 裡的正式 bot／群組，相同就拒絕（避免洗版到正式訊號群）。

做的事：getMe（確認是哪個 bot）→ getChat（確認群組）→ 用 Python 版的訊息渲染送出幾張代表性的卡片
→ 送 4096 字元的邊界訊息 → 探測 4097 字元（預期被 Telegram 拒絕，確認行為與 Node 版相同：不截斷）。
Python 版只送純文字推播；按鈕與回呼由 Apps Script 負責，不在這一關範圍內。
"""
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from . import notify
from .okx_check import REPO_DOTENV, _parse_dotenv

LIVE_TOKEN_KEYS = ("TG_TOKEN", "TELEGRAM_BOT_TOKEN")
LIVE_CHAT_KEYS = ("TG_CHAT_ID", "SIGNAL_CHAT_ID", "ALLOWED_CHAT_ID", "BROADCAST_CHAT_ID")
LABEL = "🧪 第3關測試"


def _api(token, method, payload=None):
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}",
                                 data=json.dumps(payload or {}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}")
        except Exception:  # noqa: BLE001
            return {"ok": False, "error_code": e.code}


def vectors_dir():
    here = Path(__file__).resolve()
    for d in (os.environ.get("VEGAS_VECTORS"), here.parents[2] / "vectors", here.parents[1] / "vectors"):
        if d and (Path(d) / "notify.json").exists():
            return Path(d)
    return None


def sample_cards(limit=4):
    """從 notify 向量挑「抬頭不同」的卡片，涵蓋待確認／拒絕／可觀察等樣式。"""
    d = vectors_dir()
    if not d:
        return []
    seen, out = set(), []
    for v in json.load(open(d / "notify.json", encoding="utf-8")):
        text = notify.render_decision(v["input"])
        head = text.split("\n", 1)[0].split("｜")[0]
        if head not in seen:
            seen.add(head)
            out.append(text)
        if len(out) >= limit:
            break
    return out


def live_conflicts(token, chat, dotenv_path):
    """測試用 bot／群組若與 .env 的正式值相同，回傳原因清單。"""
    env = _parse_dotenv(dotenv_path)
    out = []
    for k in LIVE_TOKEN_KEYS:
        v = env.get(k, "").strip()
        if v and (v == token or v.split(":")[0] == token.split(":")[0]):
            out.append(f"TG_TEST_TOKEN 與 .env 的 {k} 是同一個 bot")
    for k in LIVE_CHAT_KEYS:
        v = env.get(k, "").strip()
        if v and v == str(chat).strip():
            out.append(f"TG_TEST_CHAT_ID 與 .env 的 {k} 是同一個群組")
    return out


async def main(terminal=None, dotenv_path=None, api=None):
    terminal = os.environ if terminal is None else terminal
    api = api or _api
    token = (terminal.get("TG_TEST_TOKEN") or "").strip()
    chat = (terminal.get("TG_TEST_CHAT_ID") or "").strip()
    if not token or not chat:
        print("請先在終端機設定測試用的 bot 與群組（不要貼到聊天）：\n"
              '  $env:TG_TEST_TOKEN="123456:ABC..."; $env:TG_TEST_CHAT_ID="-100xxxxxxxxxx"\n'
              "這一關只認 TG_TEST_*，不會讀 .env 或 TG_TOKEN。")
        return 2
    bad = live_conflicts(token, chat, dotenv_path or REPO_DOTENV)
    if bad:
        print("⛔ 拒絕執行：" + "；".join(bad) + "。\n請另建測試 bot 與測試群組，避免洗版到正式訊號群。")
        return 2

    ok = True

    def line(good, text):
        nonlocal ok
        ok = ok and good
        print(("✓ " if good else "✗ ") + text)

    me = await asyncio.to_thread(api, token, "getMe")
    if not me.get("ok"):
        line(False, f"getMe 失敗：{str(me)[:160]}（token 錯誤或已被撤銷）")
        return 1
    r = me["result"]
    line(True, f"bot：@{r.get('username')}（id {r.get('id')}）")
    gc = await asyncio.to_thread(api, token, "getChat", {"chat_id": chat})
    if not gc.get("ok"):
        line(False, f"getChat 失敗：{str(gc)[:160]}（bot 不在該群組，或 chat id 錯誤）")
        return 1
    c = gc["result"]
    line(True, f"群組：{c.get('title') or c.get('username') or c.get('first_name')}（{c.get('type')}）")

    cfg = {"token": token, "chatId": chat, "label": LABEL}
    sent = await notify.send("這是第 3 關測試訊息，請忽略。", cfg)
    line(sent.get("sent"), "純文字訊息")
    cards = sample_cards()
    if not cards:
        print("（找不到 vectors/notify.json，略過卡片樣式測試；可設 VEGAS_VECTORS）")
    for i, text in enumerate(cards, 1):
        res = await notify.send(text, cfg)
        line(res.get("sent"), f"卡片樣式 {i}（{text.split(chr(10), 1)[0][:20]}，{len(text)} 字元）")
    longest = max((len(t) for t in cards), default=0)
    res = await notify.send("長" * (4096 - len(LABEL) - 1), cfg)
    line(res.get("sent"), "4096 字元邊界訊息")
    probe = await asyncio.to_thread(api, token, "sendMessage", {"chat_id": chat, "text": "長" * 4097})
    line(not probe.get("ok"), "4097 字元會被 Telegram 拒絕（預期；Python 版與 Node 版一樣不截斷）"
         + (f"；現有卡片最長 {longest} 字元" if longest else ""))
    print("\n請到測試群組確認：1) 各卡片排版與 Node 版一致  2) 中文、emoji、換行都正常。")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
