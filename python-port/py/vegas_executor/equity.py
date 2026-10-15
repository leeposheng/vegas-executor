"""帳戶權益來源（對應 equity.js）。永不拋例外；來源一路帶到卡片上。"""
from . import clock
from .exchanges import okx
from .jsnum import js_round, num_str, truthy

DEFAULT_TTL_MS = 60 * 1000

_cache = None  # {"equityUsdt", "fetchedAt"}


def reset_cache():
    global _cache
    _cache = None


async def get_equity(config, flags, now=None):
    global _cache
    at = clock.now_ms() if now is None else now
    risk = config["risk"]
    fallback = risk.get("equityUsdt")
    ttl = DEFAULT_TTL_MS if risk.get("equityCacheMs") is None else risk["equityCacheMs"]

    okx_cfg = config.get("okx") or {}
    can_query = (risk.get("equitySource") != "config"
                 and config.get("primaryExchange") == "okx"
                 and bool(truthy(okx_cfg.get("apiKey")) and truthy(okx_cfg.get("apiSecret"))
                          and truthy(okx_cfg.get("passphrase"))))

    if not can_query:
        return {"equityUsdt": fallback, "source": "config", "ageMs": 0,
                "note": None if risk.get("equitySource") == "config"
                else "未設定交易所憑證，倉位以設定檔的權益計算"}

    if _cache and (at - _cache["fetchedAt"]) < ttl:
        return {"equityUsdt": _cache["equityUsdt"], "source": "cache",
                "ageMs": at - _cache["fetchedAt"], "note": None}

    try:
        r = await okx.fetch_equity(okx_cfg, flags)
        _cache = {"equityUsdt": r["equityUsdt"], "fetchedAt": at}
        return {"equityUsdt": r["equityUsdt"], "source": "exchange", "ageMs": 0, "note": None}
    except Exception as err:  # noqa: BLE001 — 對應 JS 的 catch (err)
        if _cache:
            age = at - _cache["fetchedAt"]
            return {"equityUsdt": _cache["equityUsdt"], "source": "cache", "ageMs": age,
                    "note": f"權益查詢失敗（{err}），沿用 {num_str(js_round(age / 1000))} 秒前的數值"}
        return {"equityUsdt": fallback, "source": "config", "ageMs": 0,
                "note": f"權益查詢失敗（{err}），退回設定檔的 {num_str(fallback)} USDT —— "
                        "這個數字不會自己更新，請確認它仍接近實際"}
