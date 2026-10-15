"""唯讀連線檢查：python -m vegas_executor.okx_check

只做查詢（帳戶設定、權益、持倉、保護單、現價），絕不下單、不改槓桿。
讀 OKX_API_KEY / OKX_API_SECRET / OKX_PASSPHRASE / OKX_BASE_URL / DEMO_MODE，來源與 Node 服務相同：
vegas-executor/.env，終端機已設的環境變數優先（被蓋過時會提示）。金鑰不會印出。
用來在上線前確認：金鑰通、帳戶模式、持倉模式、時鐘沒漂移、權益讀得到。
"""
import asyncio
import os
import sys
from pathlib import Path

from .exchanges import okx

INST = os.environ.get("CHECK_INST_ID", "BTC-USDT-SWAP")

# python-port/py/vegas_executor/okx_check.py → parents[3] 即 vegas-executor 根目錄（Node 服務的 .env 所在）
REPO_DOTENV = Path(__file__).resolve().parents[3] / ".env"

TRUTHY = ("true", "1", "yes", "on")
FALSY = ("false", "0", "no", "off")
SECRETS = ("OKX_API_KEY", "OKX_API_SECRET", "OKX_PASSPHRASE")
WATCHED = ("OKX_API_KEY", "OKX_API_SECRET", "OKX_PASSPHRASE", "OKX_BASE_URL", "DEMO_MODE")


def _parse_dotenv(path):
    out = {}
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return out
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        out[k] = v
    return out


def load_env(terminal, dotenv_path):
    """終端機環境變數疊在 .env 上（與服務相同，已存在的優先）。
    回傳 (env, file_env, shadowed)；shadowed 是 .env 有設、卻被終端機不同值蓋過的 key。"""
    file_env = _parse_dotenv(dotenv_path)
    env = {**file_env, **dict(terminal)}
    shadowed = [k for k in file_env
                if k in WATCHED and k in terminal and terminal[k] != file_env[k]]
    return env, file_env, shadowed


def parse_demo(v):
    """與服務的 DEMO_MODE 解析相同：空值為 true，無法解析回傳 None。"""
    s = (v or "").strip().lower()
    if s == "":
        return True
    if s in TRUTHY:
        return True
    if s in FALSY:
        return False
    return None


async def main(terminal=None, dotenv_path=None):
    terminal = os.environ if terminal is None else terminal
    p = Path(dotenv_path) if dotenv_path is not None else REPO_DOTENV
    env, file_env, shadowed = load_env(terminal, p)
    if p.exists():
        print(f"設定來源：{p}")
    else:
        print(f"設定來源：只有終端機環境變數（找不到 {p}）")
    for k in shadowed:
        if k in SECRETS:
            detail = "值不同"
        else:
            detail = f"終端機={terminal[k]!r}，.env={file_env[k]!r}"
        print(f"⚠️ {k} 被終端機環境變數蓋過（{detail}）。要用 .env 的值：Remove-Item Env:{k}")

    demo = parse_demo(env.get("DEMO_MODE"))
    if demo is None:
        print(f"DEMO_MODE 的值「{env.get('DEMO_MODE')}」無法解析，請填 true / false")
        return 2
    cfg = {"apiKey": env.get("OKX_API_KEY", ""), "apiSecret": env.get("OKX_API_SECRET", ""),
           "passphrase": env.get("OKX_PASSPHRASE", ""),
           "baseUrl": env.get("OKX_BASE_URL", "") or "https://www.okx.com"}
    if not (cfg["apiKey"] and cfg["apiSecret"] and cfg["passphrase"]):
        print("缺少 OKX_API_KEY／OKX_API_SECRET／OKX_PASSPHRASE（.env 或環境變數）")
        return 2
    flags = {"demo": demo}
    print(f"模式：{'模擬盤 (x-simulated-trading)' if demo else '⚠️ 實盤'}｜{cfg['baseUrl']}")
    k = cfg["apiKey"]
    print(f"金鑰指紋：{k[:4]}…{k[-4:]}（長度 {len(k)}）｜secret 長度 {len(cfg['apiSecret'])}"
          f"｜passphrase 長度 {len(cfg['passphrase'])}（只印頭尾各 4 碼，可與 Zeabur 設定的同一把金鑰對照）")
    failed = 0
    env_mismatch = False
    hinted = False
    steps = [
        ("現價（公開）", lambda: okx.fetch_ticker(INST, cfg)),
        ("帳戶設定", lambda: okx.fetch_account_config(cfg, flags)),
        ("權益", lambda: okx.fetch_equity(cfg, flags)),
        ("持倉", lambda: okx.fetch_positions(cfg, flags)),
        ("保護單", lambda: okx.fetch_algo_pending({"instId": INST}, cfg, flags)),
        ("平倉紀錄", lambda: okx.fetch_positions_history({"instId": INST}, cfg, flags)),
    ]
    for name, fn in steps:
        try:
            r = await fn()
            if name == "持倉":
                r = f"{len(r)} 筆：" + ", ".join(f"{q['instId']} {q['pos']}" for q in r) if r else "0 筆"
            elif name in ("保護單", "平倉紀錄"):
                r = f"{len(r)} 筆"
            print(f"✓ {name}：{r}")
        except Exception as err:  # noqa: BLE001
            failed += 1
            env_mismatch = env_mismatch or "50101" in str(err) or "50111" in str(err)
            lines = str(err).split("\n")
            print(f"✗ {name}：{lines[0] if hinted else str(err)}")   # 同樣的處置提示只印一次
            hinted = hinted or len(lines) > 1
    if env_mismatch:
        await diagnose(cfg, demo)
    return 1 if failed else 0


async def diagnose(cfg, demo):
    """金鑰環境不符時，唯讀地試另一種環境，指出實際原因（只查帳戶設定，不下單）。"""
    print("\n── 診斷（唯讀）──")
    other = not demo
    try:
        await okx.fetch_account_config(cfg, {"demo": other})
        print(f"→ 這把金鑰在「{'模擬盤' if other else '實盤'}」可以通：它是{'模擬盤' if other else '實盤'}金鑰。"
              f"請把 DEMO_MODE 改成 {'true' if other else 'false'}，或換成對應環境的金鑰。")
        return
    except Exception as err:  # noqa: BLE001
        print(f"· 另一種環境也不通：{str(err).splitlines()[0]}")
    for base in ("https://www.okx.com", "https://eea.okx.com", "https://us.okx.com"):
        if base == cfg["baseUrl"]:
            continue
        try:
            await okx.fetch_account_config({**cfg, "baseUrl": base}, {"demo": demo})
            print(f"→ 在 {base} 可以通：帳戶屬於該站點，請設 OKX_BASE_URL={base}")
            return
        except Exception as err:  # noqa: BLE001
            print(f"· {base} 不通：{str(err).splitlines()[0]}")
    print("→ 都不通：多半是金鑰舊了／打錯。請檢查 .env 的 OKX_API_KEY／SECRET／PASSPHRASE，"
          "並確認終端機沒有殘留同名環境變數（它會優先）。")


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
