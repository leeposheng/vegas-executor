"""模組 E：CHART-IMG 圖表與 Telegram sendPhoto（Executor.gs 的 chartOptions_／buildChartRequest_／fetchChartImage_／tgSendPhoto_）。

忠實移植重點：
- 請求內容的欄位順序與 JSON.stringify 的輸出逐字相同（圖畫錯不會有錯誤訊息，所以逐欄比對）。
- 設定值的夾限（額度 1–10、尺寸、浮水印 0–100）與「填錯當沒填」的行為不變。
- 取圖永不拋例外，失敗回 None，卡片改用純文字。
"""
import json
import re

from . import clock
from .cards import UNDEF, _cat
from .gas_util import JS_WS, js_str, js_trim, js_truthy, truncate
from .jsnum import js_json, js_round, num_str, to_number, to_string

CHART_ENDPOINT = "https://api.chart-img.com/v2/tradingview/advanced-chart"
CHART_KEY_PROPERTY = "CHART_IMG_API_KEY"
CHART_UP_DEFAULT = "rgb(8,153,129)"
CHART_DOWN_DEFAULT = "rgb(242,54,69)"
CHART_TZ_DEFAULT = "Asia/Taipei"
LEVEL_COLOR_ENTRY = "rgb(120,120,130)"
LEVEL_COLOR_SL = "rgb(163,46,62)"
LEVEL_COLOR_TP = "rgb(31,122,94)"
LEVEL_TEXT_FIELD_DEFAULT = "textColor"
EMA_NAME_DEFAULT = "Moving Average Exponential"
EMA_ORDER_DEFAULT = [144, 169, 576, 676, 250, 288, 12]
MAX_PARAMS_DEFAULT = 3
HIDE_LEGEND_DEFAULT = "showSeriesOHLC,showBarChange"
WIDTH_DEFAULT, HEIGHT_DEFAULT, WIDTH_MAX, HEIGHT_MAX = 800, 600, 1920, 1600
LEVEL_NAMES = ["entry", "sl", "tp1", "tp2", "tp3"]

EMA_SET = [
    {"len": 144, "color": "rgb(43,76,126)", "width": 1, "label": "小通道"},
    {"len": 169, "color": "rgb(43,76,126)", "width": 1, "label": "小通道"},
    {"len": 576, "color": "rgb(125,46,58)", "width": 1, "label": "大通道"},
    {"len": 676, "color": "rgb(125,46,58)", "width": 1, "label": "大通道"},
    {"len": 250, "color": "rgb(79,99,73)", "width": 1, "label": "過濾通道"},
    {"len": 288, "color": "rgb(79,99,73)", "width": 1, "label": "過濾通道"},
    {"len": 12, "color": "rgb(192,138,46)", "width": 1, "label": "過濾線"},
]


class Blob:
    """GAS Blob 的最小替身：圖片位元組＋檔名。物件本身永遠為真值（與 GAS 相同）。"""

    def __init__(self, data, name=None):
        self.data, self.name = data, name

    def __repr__(self):
        return "Blob(%r, %d bytes)" % (self.name, len(self.data))


def parse_int(s):
    """JS parseInt(s, 10)；NaN 回 None。"""
    m = re.match("[" + JS_WS + r"]*([+-]?\d+)", js_str(s), re.A)
    return int(m.group(1)) if m else None


def _pick(props, name, dflt):
    v = js_trim(js_str(props.get(name)))
    return v if v else dflt


# ---------------- 顏色 ----------------
def to_rgb_color(raw):
    v = js_trim(js_str(raw))
    if not v:
        return None
    if re.match(r"rgba?[" + JS_WS + r"]*\(", v, re.I):
        return v
    m = v[1:] if v.startswith("#") else v
    if len(m) == 3:
        m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2]
    if not re.fullmatch(r"[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", m):
        return None
    r, g, b = int(m[0:2], 16), int(m[2:4], 16), int(m[4:6], 16)
    if len(m) == 8:
        a = int(m[6:8], 16) / 255
        return "rgba(%d,%d,%d,%s)" % (r, g, b, num_str(js_round(a * 100) / 100))
    return "rgb(%d,%d,%d)" % (r, g, b)


def split_color_pairs(raw):
    out, depth, cur = [], 0, ""
    for ch in js_str(raw):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur)
            cur = ""
            continue
        cur += ch
    if js_trim(cur):
        out.append(cur)
    return out


# ---------------- 設定 ----------------
def chart_options(props):
    """從屬性（dict）讀出圖表設定；沒設的項目用預設值。"""
    budget = parse_int(_pick(props, "CHART_MAX_PARAMS", ""))
    if budget is None or budget < 1:
        budget = MAX_PARAMS_DEFAULT
    if budget > 10:
        budget = 10

    order_raw = _pick(props, "CHART_EMA_ORDER", "")
    if order_raw:
        order = []
        for s in order_raw.split(","):
            n = parse_int(js_trim(s))
            if n is not None and n > 0:
                order.append(n)
    else:
        order = list(EMA_ORDER_DEFAULT)
    if not order:
        order = list(EMA_ORDER_DEFAULT)

    levels_raw = _pick(props, "CHART_SHOW_LEVELS", "").lower()
    show_levels = (levels_raw in ("true", "1", "on")) if levels_raw else False

    hide_raw = _pick(props, "CHART_HIDE_LEGEND_KEYS", HIDE_LEGEND_DEFAULT)
    hide_keys = [k for k in (js_trim(s) for s in hide_raw.split(",")) if k] \
        if (hide_raw and hide_raw.lower() != "none") else []

    wm = parse_int(_pick(props, "CHART_WATERMARK", ""))
    watermark = wm if (wm is not None and 0 <= wm <= 100) else None

    w = parse_int(_pick(props, "CHART_WIDTH", ""))
    if w is None or w < 320:
        w = WIDTH_DEFAULT
    if w > WIDTH_MAX:
        w = WIDTH_MAX
    h = parse_int(_pick(props, "CHART_HEIGHT", ""))
    if h is None or h < 240:
        h = HEIGHT_DEFAULT
    if h > HEIGHT_MAX:
        h = HEIGHT_MAX

    theme = "dark" if _pick(props, "CHART_THEME", "dark").lower() == "dark" else "light"

    set_raw = _pick(props, "CHART_LEVEL_SET", "entry,sl,tp1").lower()
    if not show_levels or set_raw == "none":
        level_set = []
    elif set_raw == "all":
        level_set = list(LEVEL_NAMES)
    else:
        level_set = [x for x in (js_trim(s) for s in set_raw.split(",")) if x in LEVEL_NAMES]

    ema_colors = {}
    col_raw = _pick(props, "CHART_EMA_COLORS", "")
    if col_raw:
        for pair in split_color_pairs(col_raw):
            at = pair.find(":")
            if at < 0:
                continue
            ln = parse_int(js_trim(pair[:at]))
            col = to_rgb_color(pair[at + 1:])
            if ln is None or not col:
                continue
            ema_colors[ln] = col

    def parse_level_colors(raw):
        out = {}
        if not raw:
            return out
        for pair in split_color_pairs(raw):
            at = pair.find(":")
            if at < 0:
                continue
            k = js_trim(pair[:at]).lower()
            v = to_rgb_color(pair[at + 1:])
            if not k or not v:
                continue
            if k == "tp":
                out["tp1"] = out["tp2"] = out["tp3"] = v
            else:
                out[k] = v
        return out

    return {
        "levelColors": parse_level_colors(_pick(props, "CHART_LEVEL_COLORS", "")),
        "levelTextColors": parse_level_colors(_pick(props, "CHART_LEVEL_TEXT_COLORS", "")),
        "levelTextField": _pick(props, "CHART_LEVEL_TEXT_FIELD", LEVEL_TEXT_FIELD_DEFAULT),
        "exchange": _pick(props, "CHART_TV_EXCHANGE", "OKX"),
        "upColor": _pick(props, "CHART_CANDLE_UP", CHART_UP_DEFAULT),
        "downColor": _pick(props, "CHART_CANDLE_DOWN", CHART_DOWN_DEFAULT),
        "theme": theme,
        "levelSet": level_set,
        "emaColors": ema_colors,
        "width": w,
        "height": h,
        "maxParams": budget,
        "emaOrder": order,
        "noDrawings": not show_levels,
        "hideLegendKeys": hide_keys,
        "watermark": watermark,
        # GAS 的 emaStudyName_() 另外讀同一份屬性；這裡併入 opts 讓請求組裝不必碰全域狀態。
        "emaName": _pick(props, "CHART_EMA_STUDY_NAME", EMA_NAME_DEFAULT),
    }


def chart_interval(tf):
    m = to_number(tf if tf is not UNDEF else float("nan"))
    if m != m or m in (float("inf"), float("-inf")) or m <= 0:
        return "1h"
    if m < 60:
        return num_str(m) + "m"
    if m < 1440:
        return num_str(m / 60) + "h"
    return num_str(m / 1440) + "D"


def ema_study(spec, name=EMA_NAME_DEFAULT):
    return {
        "name": name,
        "input": {"length": spec["len"], "source": "close"},
        "override": {
            "Plot.plottype": "line",
            "Plot.linewidth": spec.get("width") or 1,
            "Plot.color": spec["color"],
        },
    }


def _index(seq, i):
    """JS 的 seq[i]（陣列／字串；其餘為 undefined）。"""
    if isinstance(seq, list):
        return seq[i] if i < len(seq) else UNDEF
    if isinstance(seq, str):
        return seq[i] if i < len(seq) else UNDEF
    return UNDEF


def build_chart_request(payload, opts=None):
    o = opts or {}
    exchange = o.get("exchange") or "OKX"
    ema_name = o.get("emaName") or EMA_NAME_DEFAULT

    def line(price, label, color, key):
        ov = {"lineWidth": 2, "lineColor": color, "showLabel": True}
        lc = o.get("levelColors") or {}
        if lc.get(key):
            ov["lineColor"] = lc[key]
        tc = o.get("levelTextColors") or {}
        if tc.get(key):
            ov[o.get("levelTextField") or LEVEL_TEXT_FIELD_DEFAULT] = tc[key]
        return {"name": "Horizontal Line",
                "input": {"price": price, "text": label + " " + _cat(price)},
                "override": ov}

    def ema(ln):
        for spec in EMA_SET:
            if spec["len"] == ln:
                ec = o.get("emaColors") or {}
                if ec.get(ln):
                    spec = {"len": spec["len"], "width": spec["width"], "label": spec["label"], "color": ec[ln]}
                return ema_study(spec, ema_name)
        ec = o.get("emaColors") or {}
        return ema_study({"len": ln, "color": ec.get(ln) or "rgb(160,160,160)", "width": 1}, ema_name)

    tp = payload.get("tp")
    tp = tp if tp else []
    level_defs = {
        "entry": (payload.get("entry", UNDEF), "▸ ENTRY", LEVEL_COLOR_ENTRY),
        "sl": (payload.get("sl", UNDEF), "✕ SL", LEVEL_COLOR_SL),
        "tp1": (_index(tp, 0), "◆ TP1", LEVEL_COLOR_TP),
        "tp2": (_index(tp, 1), "◆ TP2", LEVEL_COLOR_TP),
        "tp3": (_index(tp, 2), "◆ TP3", LEVEL_COLOR_TP),
    }

    queue = []
    wanted = [] if o.get("noDrawings") else (o.get("levelSet") or [])
    for key in wanted:
        d = level_defs.get(key)
        if d is None or d[0] is UNDEF or d[0] is None:
            continue
        queue.append(("d", line(d[0], d[1], d[2], key)))

    order = o.get("emaOrder")
    for ln in (EMA_ORDER_DEFAULT if order is None else order):
        queue.append(("s", ema(ln)))

    if o.get("noDrawings") and o.get("emaSet"):
        queue = [("s", ema_study(s, ema_name)) for s in o["emaSet"]]

    budget = o.get("maxParams") or 3
    drawings, studies = [], []
    for kind, item in queue:
        if len(drawings) + len(studies) >= budget:
            break
        if not item:
            continue
        (drawings if kind == "d" else studies).append(item)

    up = o.get("upColor") or CHART_UP_DEFAULT
    down = o.get("downColor") or CHART_DOWN_DEFAULT
    tz = o.get("timezone") or payload.get("tz") or CHART_TZ_DEFAULT

    req = {
        "symbol": exchange + ":" + _cat(payload.get("symbol", UNDEF)),
        "interval": chart_interval(payload.get("tf", UNDEF)),
        "timezone": tz,
        "theme": o.get("theme") or "dark",
        "style": "candle",
        "format": "png",
        "width": o.get("width") or 800,
        "height": o.get("height") or 600,
        "override": {"style": {
            "candleStyle.upColor": up,
            "candleStyle.downColor": down,
            "candleStyle.borderUpColor": up,
            "candleStyle.borderDownColor": down,
            "candleStyle.wickUpColor": up,
            "candleStyle.wickDownColor": down,
        }},
        "drawings": drawings,
    }
    for k in (o.get("hideLegendKeys") or []):
        req["override"][k] = False
    wm = o.get("watermark")
    if wm is not None:
        req["override"]["style"]["symbolWatermarkProperties.visibility"] = True
        req["override"]["style"]["symbolWatermarkProperties.transparency"] = wm
    if studies:
        req["studies"] = studies
    return req


class Chart:
    """取圖＋送圖。fetch_bin(url, opts) → (status, bytes, headers)；
    fetch_form(url, fields) → (status, text)，fields 為 [(名稱, 字串 | Blob)]（multipart）。"""

    def __init__(self, props, fetch_bin, fetch_form, log, now=clock.now_ms):
        self.props, self.fetch_bin, self.fetch_form, self.log, self.now = props, fetch_bin, fetch_form, log, now

    def fetch_image(self, payload):
        key = js_trim(js_str(self.props.get(CHART_KEY_PROPERTY)))
        if not key:
            return None
        started = self.now()
        try:
            body = build_chart_request(payload, chart_options(self.props))
            status, data, _ = self.fetch_bin(CHART_ENDPOINT, {
                "method": "post", "contentType": "application/json", "headers": {"x-api-key": key},
                "payload": js_json(body)})
            if status != 200:
                self.log("warn", "chart_image_failed", {
                    "source": "executor", "status": status,
                    "message": truncate(data.decode("utf-8", "replace"), 150), "elapsedMs": self.now() - started})
                return None
            blob = Blob(data, _cat(payload.get("symbol", UNDEF)) + ".png")
            self.log("info", "chart_image_ok", {"source": "executor", "bytes": len(data), "elapsedMs": self.now() - started})
            return blob
        except Exception as err:  # noqa: BLE001
            self.log("warn", "chart_image_error", {
                "source": "executor", "message": truncate(str(err), 150), "elapsedMs": self.now() - started})
            return None

    def send_photo(self, chat_id, blob, caption, reply_markup=None):
        try:
            token = self.props.get("TG_TOKEN")
            fields = [("chat_id", to_string(chat_id)), ("caption", caption), ("photo", blob)]
            if js_truthy(reply_markup):
                fields.append(("reply_markup", js_json(reply_markup)))
            _, text = self.fetch_form("https://api.telegram.org/bot" + js_str(token) + "/sendPhoto", fields)
            data = json.loads(text)
            if not data["ok"]:
                self.log("warn", "telegram_sendphoto_failed", {"source": "executor", "message": truncate(text, 200)})
                return None
            return data.get("result")
        except Exception as err:  # noqa: BLE001
            self.log("warn", "telegram_sendphoto_error", {"source": "executor", "message": truncate(str(err), 200)})
            return None
