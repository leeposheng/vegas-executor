"""代碼轉換與合約規格載入（對應 instruments.js）。網路載入留待階段 4。"""
import re

from .jsnum import to_string, trim, truthy

_TV_RE = re.compile(r"([A-Z0-9]+)USDT\.P")
_INST_RE = re.compile(r"([A-Z0-9]+)-USDT-SWAP")


def _norm(tv):
    return trim(to_string(tv if truthy(tv) else "")).upper()


def to_inst_id(tv):
    m = _TV_RE.fullmatch(_norm(tv))
    return f"{m.group(1)}-USDT-SWAP" if m else None


def to_bingx_symbol(tv):
    m = _TV_RE.fullmatch(_norm(tv))
    return f"{m.group(1)}-USDT" if m else None


def to_tv_symbol(inst_id):
    m = _INST_RE.fullmatch(to_string(inst_id if truthy(inst_id) else ""))
    return f"{m.group(1)}USDT.P" if m else None


# ---- 合約規格載入：交易所 → 磁碟快取 → 空（靜態表由 symbols 處理）----
import asyncio
import json
import math
import os
import urllib.request

from . import clock
from .jsnum import to_fixed, to_number
from .store import iso, parse_iso_ms

PUBLIC_INSTRUMENTS = "/api/v5/public/instruments?instType=SWAP"
CACHE_FILE = "instruments.json"


def parse_instruments(js):
    """OKX 回應 → {instId: spec}。只要 USDT 本位、live、且三個數值皆 > 0。"""
    if str(js.get("code")) != "0":
        raise RuntimeError(f"OKX code={js.get('code')} {js.get('msg') or ''}")
    out = {}
    for d in js.get("data") or []:
        if d.get("settleCcy") != "USDT" or d.get("state") != "live":
            continue
        ct, lot, mn = to_number(d.get("ctVal")), to_number(d.get("lotSz")), to_number(d.get("minSz"))
        if not (ct > 0 and lot > 0 and mn > 0):
            continue
        tick = to_number(d.get("tickSz"))
        lev = to_number(d.get("lever"))
        out[d["instId"]] = {"instId": d["instId"], "ctVal": ct, "lotSz": lot, "minSz": mn,
                            "tickSz": tick if (not math.isnan(tick) and tick != 0) else None,
                            "maxLever": lev if (not math.isnan(lev) and lev != 0) else None}
    if not out:
        raise RuntimeError("回應中沒有任何可用的 USDT 永續合約")
    return out


def _http_get_json(url, timeout=10):
    # 與 okx.USER_AGENT 相同理由：Cloudflare 會擋 urllib 預設 UA
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; vegas-executor/0.1; +python)",
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status}")
        return json.loads(r.read())


async def fetch_all(base_url=None, getter=None):
    url = (base_url or "https://www.okx.com") + PUBLIC_INSTRUMENTS
    js = await asyncio.to_thread(getter or _http_get_json, url)
    return parse_instruments(js)


def _cache_path(data_dir):
    return os.path.join(data_dir, CACHE_FILE)


def read_cache(data_dir):
    try:
        with open(_cache_path(data_dir), encoding="utf-8") as f:
            parsed = json.load(f)
        if parsed and parsed.get("specs"):
            return parsed
    except Exception:  # noqa: BLE001
        pass
    return None


def write_cache(data_dir, specs):
    try:
        tmp = _cache_path(data_dir) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"fetchedAt": iso(clock.now_ms()), "count": len(specs), "specs": specs}, f,
                      ensure_ascii=False, indent=2)
        os.replace(tmp, _cache_path(data_dir))
    except Exception as err:  # noqa: BLE001
        print("[規格] 快取寫入失敗：" + str(err))


async def load(base_url=None, data_dir=None, skip_network=False, getter=None):
    if not skip_network:
        try:
            specs = await fetch_all(base_url, getter)
            if data_dir:
                write_cache(data_dir, specs)
            return {"specs": specs, "source": "exchange",
                    "note": f"向交易所取得 {len(specs)} 個 USDT 永續合約規格"}
        except Exception as err:  # noqa: BLE001
            print("[規格] 向交易所查詢失敗：" + str(err) + "，改用快取")
    cached = read_cache(data_dir) if data_dir else None
    if cached:
        age = (clock.now_ms() - parse_iso_ms(cached.get("fetchedAt"))) / 3600000
        return {"specs": cached["specs"], "source": "cache", "ageHours": age,
                "note": f"使用 {to_fixed(age, 1)} 小時前的快取（{cached.get('count')} 個合約）"}
    return {"specs": {}, "source": "none", "note": "取不到任何合約規格"}
