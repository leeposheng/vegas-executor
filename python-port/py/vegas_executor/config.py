"""設定載入與驗證（對應 config.js）。評估順序、錯誤字串與重複回報都與 Node 版一致。"""
import math
import os
import re

from .jsnum import to_number, to_string, trim, truthy

TRUTHY = ["true", "1", "yes", "on"]
FALSY = ["false", "0", "no", "off"]

DEFAULT_SYMBOLS = [
    "BTCUSDT.P", "ETHUSDT.P", "BNBUSDT.P", "XRPUSDT.P", "SOLUSDT.P",
    "TRXUSDT.P", "ZECUSDT.P", "DOGEUSDT.P", "LINKUSDT.P", "ADAUSDT.P",
    "XLMUSDT.P", "BCHUSDT.P", "NEARUSDT.P", "UNIUSDT.P", "LTCUSDT.P",
    "SUIUSDT.P", "AVAXUSDT.P", "HBARUSDT.P", "TAOUSDT.P", "ENAUSDT.P",
    "ONDOUSDT.P", "AAVEUSDT.P",
    "DOTUSDT.P", "TONUSDT.P", "PEPEUSDT.P", "ICPUSDT.P", "ETCUSDT.P",
    "ATOMUSDT.P", "APTUSDT.P", "POLUSDT.P", "ARBUSDT.P", "OPUSDT.P",
    "FILUSDT.P", "ALGOUSDT.P", "VETUSDT.P", "TIAUSDT.P",
    "INJUSDT.P", "SEIUSDT.P", "IMXUSDT.P", "RUNEUSDT.P", "GRTUSDT.P",
    "STXUSDT.P", "WLDUSDT.P", "LDOUSDT.P", "JUPUSDT.P", "CRVUSDT.P",
    "PYTHUSDT.P", "SANDUSDT.P", "GALAUSDT.P", "AXSUSDT.P",
]


class ConfigError(Exception):
    pass


def load_dotenv(path, env):
    """與 Node 版相同的最小 .env 讀取器；不覆蓋已存在的環境變數。"""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f.read().split("\n"):
            t = trim(line)
            if not t or t.startswith("#"):
                continue
            eq = t.find("=")
            if eq == -1:
                continue
            key = trim(t[:eq])
            value = trim(t[eq + 1:])
            if re.fullmatch(r"(\".*\"|'.*')", value, re.S):
                value = value[1:-1]
            if key not in env:
                env[key] = value


def _split(s, upper=False, lower=False):
    out = []
    for x in s.split(","):
        x = trim(x)
        if upper:
            x = x.upper()
        if lower:
            x = x.lower()
        if x:
            out.append(x)
    return out


def _or(*vals):
    for v in vals:
        if truthy(v):
            return v
    return vals[-1]


def build_config(env=None, base_dir=None):
    """回傳 (config, parse_errors)。呼叫順序與 Node 物件字面值的求值順序相同。"""
    env = dict(os.environ) if env is None else env
    perr = []

    def boolean(v, dflt, name=None):
        if v is None or trim(to_string(v)) == "":
            return dflt
        s = trim(to_string(v)).lower()
        if s in TRUTHY:
            return True
        if s in FALSY:
            return False
        perr.append(f"{name or '布林值'} 的值「{v}」無法解析，請填 true / false（也接受 1 / 0、yes / no、on / off）")
        return dflt

    def num(v, dflt, name=None):
        if v is None or trim(to_string(v)) == "":
            return dflt
        n = to_number(trim(to_string(v)))
        if not math.isfinite(n):
            perr.append(f"{name or '數值'} 的值「{v}」不是數字，只填數字不要帶單位（例如 50，不是「50 USDT」）")
            return dflt
        return n

    g = env.get
    cfg = {}
    cfg["dryRun"] = boolean(g("DRY_RUN"), True, "DRY_RUN")
    cfg["demo"] = boolean(g("DEMO_MODE"), True, "DEMO_MODE")
    cfg["instanceRole"] = trim(g("INSTANCE_ROLE") or "live").lower()
    cfg["executionMode"] = (g("EXECUTION_MODE") or "manual").lower()
    cfg["autoGradeMin"] = num(g("AUTO_GRADE_MIN"), 3, "AUTO_GRADE_MIN")
    cfg["pendingTtlSec"] = num(g("PENDING_TTL_SEC"), 300, "PENDING_TTL_SEC")
    cfg["refreshSpec"] = boolean(g("REFRESH_SPEC"), False, "REFRESH_SPEC")
    cfg["exchanges"] = _split(g("EXCHANGES") or g("PRIMARY_EXCHANGE") or "okx", lower=True)
    cfg["reconcileSec"] = num(g("RECONCILE_SEC"), 60, "RECONCILE_SEC")
    cfg["reconcileStaleMin"] = num(g("RECONCILE_STALE_MIN"), 30, "RECONCILE_STALE_MIN")
    cfg["port"] = num(g("PORT"), 8080, "PORT")
    cfg["webhookSecret"] = g("EXECUTOR_WEBHOOK_SECRET") or ""
    cfg["controlSecret"] = g("EXECUTOR_CONTROL_SECRET") or ""

    r = {}
    r["sizingMode"] = (g("SIZING_MODE") or "risk_pct").lower()
    r["fixedMarginUsdt"] = num(g("FIXED_MARGIN_USDT"), 100, "FIXED_MARGIN_USDT")
    r["fixedMarginMaxUsdt"] = num(g("FIXED_MARGIN_MAX_USDT"), 0, "FIXED_MARGIN_MAX_USDT")
    r["lossMinUsdt"] = num(g("TARGET_LOSS_MIN_USDT"), 20, "TARGET_LOSS_MIN_USDT")
    r["lossMaxUsdt"] = num(g("TARGET_LOSS_MAX_USDT"), 45, "TARGET_LOSS_MAX_USDT")
    r["feeRateOneWay"] = num(g("TAKER_FEE_RATE"), 0.0005, "TAKER_FEE_RATE")
    r["pctPerTrade"] = num(g("RISK_PCT_PER_TRADE"), 0.005, "RISK_PCT_PER_TRADE")
    r["equityUsdt"] = num(g("ACCOUNT_EQUITY_USDT"), 1000, "ACCOUNT_EQUITY_USDT")
    r["equitySource"] = (g("EQUITY_SOURCE") or "exchange").lower()
    r["equityCacheMs"] = num(g("EQUITY_CACHE_SEC"), 60, "EQUITY_CACHE_SEC") * 1000
    r["maxConcurrent"] = num(g("MAX_CONCURRENT_POSITIONS"), 3, "MAX_CONCURRENT_POSITIONS")
    r["maxConcurrentCeiling"] = num(g("MAX_CONCURRENT_CEILING"), 5, "MAX_CONCURRENT_CEILING")
    r["overflowPositions"] = num(g("OVERFLOW_POSITIONS"), 2, "OVERFLOW_POSITIONS")
    r["addOnMax"] = num(g("ADDON_MAX"), 1, "ADDON_MAX")
    r["addOnRequireProfit"] = boolean(g("ADDON_REQUIRE_PROFIT"), True, "ADDON_REQUIRE_PROFIT")
    r["dailyLossLimitUsdt"] = num(g("DAILY_LOSS_LIMIT_USDT"), 50, "DAILY_LOSS_LIMIT_USDT")
    # Node 在這裡會再解析一次 DAILY_LOSS_LIMIT_USDT（解析錯誤因而重複記錄兩次）
    ceiling_default = max(100, num(g("DAILY_LOSS_LIMIT_USDT"), 50, "DAILY_LOSS_LIMIT_USDT") * 2)
    r["dailyLossCeilingUsdt"] = num(g("DAILY_LOSS_CEILING_USDT"), ceiling_default, "DAILY_LOSS_CEILING_USDT")
    r["dailyResetLimit"] = num(g("DAILY_RESET_LIMIT"), 1, "DAILY_RESET_LIMIT")
    r["dailyResetCooldownMin"] = num(g("DAILY_RESET_COOLDOWN_MIN"), 30, "DAILY_RESET_COOLDOWN_MIN")
    r["maxNotionalUsdt"] = num(g("MAX_NOTIONAL_USDT"), 5000, "MAX_NOTIONAL_USDT")
    r["maxNotionalMult"] = num(g("MAX_NOTIONAL_MULT"), 3, "MAX_NOTIONAL_MULT")
    r["leverage"] = num(g("LEVERAGE"), 5, "LEVERAGE")
    r["autoLeverage"] = boolean(g("AUTO_LEVERAGE"), False, "AUTO_LEVERAGE")
    r["minLiqCushion"] = num(g("MIN_LIQ_CUSHION"), 3, "MIN_LIQ_CUSHION")
    r["driftCheck"] = boolean(g("DRIFT_CHECK"), True, "DRIFT_CHECK")
    r["driftMaxWiden"] = num(g("DRIFT_MAX_WIDEN"), 1.5, "DRIFT_MAX_WIDEN")
    r["driftMaxTighten"] = num(g("DRIFT_MAX_TIGHTEN"), 0.75, "DRIFT_MAX_TIGHTEN")
    r["minGrade"] = num(g("MIN_GRADE"), 2, "MIN_GRADE")
    r["allowedSymbols"] = _split(g("ALLOWED_SYMBOLS") or ",".join(DEFAULT_SYMBOLS), upper=True)
    r["allowedTimeframes"] = _split(g("ALLOWED_TIMEFRAMES") or "5,15,30,60")
    r["maxSignalAgeSec"] = num(g("MAX_SIGNAL_AGE_SEC"), 60, "MAX_SIGNAL_AGE_SEC")
    cfg["risk"] = r

    cfg["primaryExchange"] = (g("PRIMARY_EXCHANGE") or "okx").lower()
    cfg["okx"] = {
        "apiKey": g("OKX_API_KEY") or "", "apiSecret": g("OKX_API_SECRET") or "",
        "passphrase": g("OKX_PASSPHRASE") or "",
        "baseUrl": g("OKX_BASE_URL") or "https://www.okx.com",
        "tdMode": g("OKX_TD_MODE") or "cross", "posMode": None,
    }
    cfg["bingx"] = {
        "apiKey": g("BINGX_API_KEY") or "", "apiSecret": g("BINGX_API_SECRET") or "",
        "baseUrl": g("BINGX_BASE_URL") or ("https://open-api-vst.bingx.com"
                                           if boolean(g("DEMO_MODE"), True, "DEMO_MODE")
                                           else "https://open-api.bingx.com"),
    }
    cfg["telegram"] = {
        "token": g("TG_TOKEN") or "", "chatId": g("TG_CHAT_ID") or "",
        "label": "🧪 模擬服務" if trim(g("INSTANCE_ROLE") or "live").lower() == "shadow" else "",
    }
    cfg["dataDir"] = g("DATA_DIR") or os.path.join(base_dir or os.getcwd(), "data")
    return cfg, perr


def _is_int(x):
    return isinstance(x, (int, float)) and math.isfinite(x) and float(x).is_integer()


def validate(cfg, parse_errors=(), warn=print):
    errors = list(parse_errors)
    r = cfg["risk"]
    ge = lambda a, b: bool(a >= b)  # noqa: E731  NaN 比較一律為 False，與 JS 相同

    if not cfg["webhookSecret"] or len(cfg["webhookSecret"]) < 16:
        errors.append("EXECUTOR_WEBHOOK_SECRET 未設定或長度不足 16 字元")
    if cfg["instanceRole"] not in ("live", "shadow"):
        errors.append("INSTANCE_ROLE 必須是 live 或 shadow")
    if cfg["instanceRole"] == "shadow" and not cfg["demo"]:
        errors.append("INSTANCE_ROLE=shadow 必須搭配 DEMO_MODE=true。\n"
                      "   模擬服務會收到每一筆訊號，開成真錢就是全自動真錢交易。")
    if cfg["instanceRole"] == "shadow" and cfg["executionMode"] == "manual":
        warn("⚠️ INSTANCE_ROLE=shadow 但 EXECUTION_MODE=manual。\n"
             "   模擬服務的卡片沒有按鈕，待確認的訊號只會逾時失效。建議設 auto。")
    if not cfg["controlSecret"] or len(cfg["controlSecret"]) < 16:
        errors.append("EXECUTOR_CONTROL_SECRET 未設定或長度不足 16 字元")
    if cfg["controlSecret"] and cfg["webhookSecret"] == cfg["controlSecret"]:
        errors.append("EXECUTOR_CONTROL_SECRET 不可與 EXECUTOR_WEBHOOK_SECRET 相同")

    if not (r["pctPerTrade"] > 0 and r["pctPerTrade"] <= 0.05):
        errors.append("RISK_PCT_PER_TRADE 必須介於 0 與 0.05（5%）之間")
    if not (r["equityUsdt"] > 0):
        errors.append("ACCOUNT_EQUITY_USDT 必須大於 0")
    if r["equitySource"] not in ("exchange", "config"):
        errors.append("EQUITY_SOURCE 必須是 exchange 或 config")
    if not ge(r["equityCacheMs"], 0):
        errors.append("EQUITY_CACHE_SEC 不可為負")
    if not ge(cfg["reconcileStaleMin"], 5):
        errors.append("RECONCILE_STALE_MIN 必須至少 5 分鐘")
    if cfg["reconcileSec"] != 0 and cfg["reconcileSec"] < 10:
        errors.append("RECONCILE_SEC 必須是 0（停用）或至少 10 秒")
    if not ge(r["maxConcurrent"], 1):
        errors.append("MAX_CONCURRENT_POSITIONS 必須 >= 1")
    if not ge(r["maxConcurrentCeiling"], 1) or r["maxConcurrentCeiling"] > 20:
        errors.append("MAX_CONCURRENT_CEILING 必須介於 1 與 20 之間")
    if not ge(r["overflowPositions"], 0) or r["overflowPositions"] > 10 or not _is_int(r["overflowPositions"]):
        errors.append("OVERFLOW_POSITIONS 必須是 0 到 10 的整數")
    if not ge(r["addOnMax"], 0) or r["addOnMax"] > 5 or not _is_int(r["addOnMax"]):
        errors.append("ADDON_MAX 必須是 0 到 5 的整數")
    from .jsnum import num_str as n_
    if r["maxConcurrent"] > r["maxConcurrentCeiling"]:
        errors.append(f"MAX_CONCURRENT_POSITIONS({n_(r['maxConcurrent'])}) 不可超過 "
                      f"MAX_CONCURRENT_CEILING({n_(r['maxConcurrentCeiling'])})。"
                      "天花板的意義就是「誰都不能超過」，包含這個預設值。")
    if not _is_int(r["dailyResetLimit"]) or r["dailyResetLimit"] < 0 or r["dailyResetLimit"] > 5:
        errors.append("DAILY_RESET_LIMIT 必須是 0 到 5 的整數。"
                      "0 代表關閉重置；超過 5 的話日損上限已經沒有意義了。")
    if not ge(r["dailyResetCooldownMin"], 0) or r["dailyResetCooldownMin"] > 720:
        errors.append("DAILY_RESET_COOLDOWN_MIN 必須介於 0 與 720 之間")
    if not (r["dailyLossCeilingUsdt"] > 0) or r["dailyLossCeilingUsdt"] > 100000:
        errors.append("DAILY_LOSS_CEILING_USDT 必須大於 0 且不超過 100000")
    if r["dailyLossLimitUsdt"] > r["dailyLossCeilingUsdt"]:
        errors.append(f"DAILY_LOSS_LIMIT_USDT({n_(r['dailyLossLimitUsdt'])}) 不可超過 "
                      f"DAILY_LOSS_CEILING_USDT({n_(r['dailyLossCeilingUsdt'])})。"
                      "天花板的意義就是「誰都不能超過」，包含這個預設值。")
    if not ge(r["minLiqCushion"], 2) or r["minLiqCushion"] > 20:
        errors.append("MIN_LIQ_CUSHION 必須介於 2 與 20 之間。"
                      "低於 2 代表強平距離不到止損距離的兩倍，止損形同虛設。")
    if not (r["maxNotionalUsdt"] > 0):
        errors.append("MAX_NOTIONAL_USDT 必須大於 0")
    if not (r["maxNotionalMult"] > 0):
        errors.append("MAX_NOTIONAL_MULT 必須大於 0")
    if r["sizingMode"] not in ("risk_pct", "fixed_margin"):
        errors.append("SIZING_MODE 必須是 risk_pct 或 fixed_margin")
    if r["sizingMode"] == "fixed_margin":
        if not (r["fixedMarginUsdt"] > 0):
            errors.append("FIXED_MARGIN_USDT 必須大於 0")
        if truthy(r["fixedMarginMaxUsdt"]) and r["fixedMarginMaxUsdt"] < r["fixedMarginUsdt"]:
            errors.append(f"FIXED_MARGIN_MAX_USDT({n_(r['fixedMarginMaxUsdt'])}) 不可小於 "
                          f"FIXED_MARGIN_USDT({n_(r['fixedMarginUsdt'])})。"
                          "上限小於下限的區間是空的，那樣設等於把自動加保證金關掉，"
                          "但看起來像開著。")
        if not (r["lossMinUsdt"] > 0):
            errors.append("TARGET_LOSS_MIN_USDT 必須大於 0")
        if not (r["lossMaxUsdt"] > r["lossMinUsdt"]):
            errors.append("TARGET_LOSS_MAX_USDT 必須大於 TARGET_LOSS_MIN_USDT")
        if not (r["feeRateOneWay"] >= 0 and r["feeRateOneWay"] < 0.01):
            errors.append("TAKER_FEE_RATE 必須介於 0 與 0.01 之間")
        if cfg["primaryExchange"] == "okx" and cfg["okx"]["tdMode"] != "isolated":
            warn("⚠️ SIZING_MODE=fixed_margin 但 OKX_TD_MODE=" + cfg["okx"]["tdMode"] + "。\n"
                 "   固定保證金的前提是「單筆最多賠掉那筆保證金」，而那只有逐倉（isolated）成立。\n"
                 "   全倉模式下整個帳戶都在背書，跳空時虧損不受 FIXED_MARGIN_USDT 限制。\n"
                 "   建議設 OKX_TD_MODE=isolated。")
    if not ge(r["leverage"], 1):
        errors.append("LEVERAGE 必須 >= 1")
    if not (r["driftMaxWiden"] > 1):
        errors.append("DRIFT_MAX_WIDEN 必須大於 1（等於 1 代表不容許任何漂移）")
    if not (r["driftMaxTighten"] > 0 and r["driftMaxTighten"] < 1):
        errors.append("DRIFT_MAX_TIGHTEN 必須介於 0 與 1 之間")
    if r["minGrade"] not in (1, 2, 3):
        errors.append("MIN_GRADE 必須是 1、2 或 3")
    if len(r["allowedTimeframes"]) == 0:
        errors.append("ALLOWED_TIMEFRAMES 不可為空")
    for ex in cfg["exchanges"]:
        if ex not in ("okx", "bingx"):
            errors.append(f"EXCHANGES 裡的「{ex}」不認得，只能是 okx 或 bingx")
    if not cfg["exchanges"]:
        errors.append("EXCHANGES 不可為空")
    if "bingx" in cfg["exchanges"] and (not cfg["bingx"]["apiKey"] or not cfg["bingx"]["apiSecret"]):
        errors.append("EXCHANGES 含 bingx，但 BINGX_API_KEY／BINGX_API_SECRET 未設定")

    if "bingx" in cfg["exchanges"]:
        is_vst = bool(re.search(r"open-api-vst\.bingx\.com", cfg["bingx"]["baseUrl"], re.I))
        if cfg["demo"] and not is_vst:
            errors.append("DEMO_MODE=true 但 BINGX_BASE_URL 指向真實盤。\n"
                          f"   目前：{cfg['bingx']['baseUrl']}\n"
                          "   這會讓 OKX 走模擬、BingX 走真錢 —— 同一筆訊號一邊假一邊真。\n"
                          "   要模擬就刪掉 BINGX_BASE_URL（會自動用 VST），"
                          "或填 https://open-api-vst.bingx.com")
        if not cfg["demo"] and is_vst:
            errors.append("DEMO_MODE=false 但 BINGX_BASE_URL 指向 VST 模擬盤。\n"
                          "   你會以為在跑真錢，而所有損益都是假的 —— "
                          "日損上限與對帳全部建立在那些數字上。")

    if "bingx" in cfg["exchanges"] and not cfg["dryRun"] and not cfg["demo"]:
        errors.append("BingX 尚未支援真實資金交易。\n"
                      "   開機自檢與槓桿設定已完成（2026-09-29）。剩下一件：\n"
                      "   已實現損益只能從資金流水（/user/income）聚合，同期間的其他\n"
                      "   交易會被算進來 —— 日損上限建立在那個數字上，因此不可信。\n"
                      "   解法是改用成交明細（/trade/allFillOrders）逐筆歸戶，\n"
                      "   而那需要在 VST 模擬盤上先累積幾筆真實成交才驗得了。\n"
                      "   目前請用 DEMO_MODE=true，或把 EXCHANGES 設成只有 okx。")
    if len(cfg["exchanges"]) > 1 and r["sizingMode"] == "fixed_margin":
        worst = r["lossMaxUsdt"] * len(cfg["exchanges"])
        if r["dailyLossLimitUsdt"] < worst:
            warn(f"⚠️ 雙邊下單的單筆最壞虧損為 {n_(worst)} USDT（{n_(r['lossMaxUsdt'])} × {len(cfg['exchanges'])} 家），"
                 f"但 DAILY_LOSS_LIMIT_USDT 只有 {n_(r['dailyLossLimitUsdt'])}。\n"
                 "   第一筆停損就會觸發當日上限、停止所有交易。\n"
                 f"   若這不是本意，把它調到 {n_(worst)} 以上。")
    if cfg["primaryExchange"] not in ("okx", "bingx"):
        errors.append("PRIMARY_EXCHANGE 必須是 okx 或 bingx")
    if cfg["executionMode"] not in ("auto", "manual", "by_grade"):
        errors.append("EXECUTION_MODE 必須是 auto、manual 或 by_grade")
    if cfg["autoGradeMin"] not in (1, 2, 3):
        errors.append("AUTO_GRADE_MIN 必須是 1、2 或 3")
    if cfg["executionMode"] == "by_grade" and r["minGrade"] >= cfg["autoGradeMin"]:
        warn("⚠️ EXECUTION_MODE=by_grade，但 MIN_GRADE(" + n_(r["minGrade"]) + ") >= AUTO_GRADE_MIN("
             + n_(cfg["autoGradeMin"]) + ")。\n"
             "   沒有任何等級會落在「需要按鈕確認」的區間，實際行為等同 auto ——\n"
             "   每一筆通過閘門的訊號都會直接下單。\n"
             "   若要保留人工確認，請把 MIN_GRADE 調到低於 AUTO_GRADE_MIN。")
    if not (cfg["pendingTtlSec"] >= 30 and cfg["pendingTtlSec"] <= 3600):
        errors.append("PENDING_TTL_SEC 必須介於 30 與 3600 秒之間")

    if not cfg["dryRun"]:
        if cfg["primaryExchange"] == "okx":
            o = cfg["okx"]
            if not o["apiKey"] or not o["apiSecret"] or not o["passphrase"]:
                errors.append("DRY_RUN=false 時，OKX_API_KEY／SECRET／PASSPHRASE 皆為必填")
        if cfg["primaryExchange"] == "bingx":
            b = cfg["bingx"]
            if not b["apiKey"] or not b["apiSecret"]:
                errors.append("DRY_RUN=false 時，BINGX_API_KEY／SECRET 皆為必填")

    if errors:
        raise ConfigError("設定驗證失敗：\n  - " + "\n  - ".join(errors))
    return cfg


def load_config(env=None, base_dir=None, dotenv_path=None, warn=print):
    env = dict(os.environ) if env is None else env
    if dotenv_path:
        load_dotenv(dotenv_path, env)
    cfg, perr = build_config(env, base_dir)
    return validate(cfg, perr, warn=warn)
