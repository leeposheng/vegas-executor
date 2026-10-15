"""狀態檔（對應 store.js）。與 Node 版讀寫同一份 state.json（SPEC §5）。"""
import copy
import json
import math
import os
import re
from datetime import datetime, timezone

from . import clock
from .jsnum import is_number, to_number, truthy

UNDEFINED = object()  # patch_position 用：表示「刪除此欄位」（JS 的 undefined）

EMPTY = {
    "halted": False, "haltedReason": "", "haltedSource": "",
    "processed": {}, "positions": {}, "pendings": {}, "daily": {},
    "decisions": [], "intents": {}, "overrides": {}, "lastResetAtMs": 0,
}
PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000
_KEY_RE = re.compile(r"(okx|bingx):([\s\S]+)")


def iso(ms) -> str:
    ms = int(ms)
    return datetime.fromtimestamp(ms // 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + f".{ms % 1000:03d}Z"


def parse_iso_ms(s):
    try:
        if not isinstance(s, str):
            return float("nan")
        t = s.replace("Z", "+00:00")
        return datetime.fromisoformat(t).timestamp() * 1000
    except Exception:
        return float("nan")


def split_key(key, fallback_exchange=None):
    m = _KEY_RE.fullmatch(key)
    if m:
        return {"exchange": m.group(1), "sigId": m.group(2)}
    return {"exchange": fallback_exchange or "okx", "sigId": key}


def _normalise(o):
    """寫檔前把整數值的 float 轉 int（5.0 → 5），與 JS 的輸出一致。"""
    if isinstance(o, float) and math.isfinite(o) and o == int(o) and abs(o) < 1e15:
        return int(o)
    if isinstance(o, dict):
        return {k: _normalise(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_normalise(v) for v in o]
    return o


def _or(v, default):
    return v if truthy(v) else default


class Store:
    def __init__(self, data_dir):
        self.file = os.path.join(data_dir, "state.json")
        self.corruptBackup = None
        os.makedirs(data_dir, exist_ok=True)
        self.state = self._load()

    # ---- 檔案 ----
    def _load(self):
        try:
            if os.path.exists(self.file):
                with open(self.file, encoding="utf-8") as f:
                    parsed = json.load(f)
                base = copy.deepcopy(EMPTY)
                base.update(parsed)
                return base
        except Exception:
            backup = f"{self.file}.corrupt-{clock.now_ms()}"
            try:
                os.replace(self.file, backup)
            except Exception:
                pass
            self.corruptBackup = backup
            print(f"[store] 狀態檔損壞，已備份至 {backup}")
        return copy.deepcopy(EMPTY)

    def save(self):
        tmp = self.file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_normalise(self.state), f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.file)

    # ---- 模式綁定 ----
    def bind_mode(self, mode, role=None):
        have = self.state.get("mode")
        have_role = self.state.get("role")
        if role and have_role and have_role != role:
            return {"ok": False, "error": f"狀態檔屬於 {have_role} 服務（{self.file}），目前這個服務是 {role}。\n"
                    "   主服務與模擬服務必須用不同的 DATA_DIR（例如 /data/live 與 /data/shadow）。"}
        if mode == "live" and not have and self.corruptBackup:
            return {"ok": False, "error": f"狀態檔損壞，已備份為 {self.corruptBackup}。損壞的檔案讀不出它屬於哪種資金模式，"
                    "實盤不接手。\n   請檢查備份後，把 DATA_DIR 指到新的目錄。"}
        if have == mode:
            if role and not have_role:
                self.state["role"] = role
                self.save()
            return {"ok": True}
        if have:
            return {"ok": False, "error": f"狀態檔屬於 {'實盤' if have == 'live' else '模擬盤'}（{self.file}），"
                    f"目前設定是 {'實盤' if mode == 'live' else '模擬盤'}。\n"
                    "   兩種模式不可共用狀態檔：部位、日損與冪等紀錄會互相污染。\n"
                    "   請把 DATA_DIR 改成另一個目錄（例如實盤用 /data/live），"
                    "或確認 DEMO_MODE 沒有設錯。"}
        if mode == "live" and self._has_data():
            return {"ok": False, "error": f"狀態檔沒有模式標記且已有資料（{self.file}），"
                    "多半是模擬盤留下的，不能拿來跑實盤。\n"
                    "   請把 DATA_DIR 改成新的目錄（例如 /data/live）。舊檔不用刪，留著可供對照。"}
        self.state["mode"] = mode
        if role:
            self.state["role"] = role
        self.save()
        return {"ok": True, "stamped": True}

    def get_mode(self):
        return self.state.get("mode") or None

    def _has_data(self):
        st = self.state
        ne = lambda o: bool(o) and len(o) > 0  # noqa: E731
        return (ne(st.get("positions")) or ne(st.get("intents")) or ne(st.get("pendings"))
                or ne(st.get("processed")) or ne(st.get("daily")) or ne(st.get("overrides"))
                or to_number(st.get("lastResetAtMs")) > 0
                or (isinstance(st.get("decisions"), list) and len(st["decisions"]) > 0))

    # ---- 冪等 ----
    def _proc_key(self, sig_id, exchange):
        with_ex = f"{exchange or 'okx'}:{sig_id}"
        p = self.state["processed"]
        if with_ex in p:
            return with_ex
        if sig_id in p:
            return sig_id
        return with_ex

    def is_processed(self, sig_id, exchange=None):
        return self._proc_key(sig_id, exchange) in self.state["processed"]

    def get_processed(self, sig_id, exchange=None):
        return self.state["processed"].get(self._proc_key(sig_id, exchange))

    def mark_processed(self, sig_id, outcome, detail=None, exchange=None):
        self.state["processed"][f"{exchange or 'okx'}:{sig_id}"] = {
            "at": iso(clock.now_ms()), "outcome": outcome,
            "detail": detail if truthy(detail) else "", "exchange": exchange or "okx"}
        self._prune_processed()
        self.save()

    def _prune_processed(self):
        cutoff = clock.now_ms() - PROCESSED_TTL_MS
        for k, rec in list(self.state["processed"].items()):
            t = parse_iso_ms(rec.get("at"))
            if t < cutoff:  # NaN 比較為 False → 保留（與 JS 相同）
                del self.state["processed"][k]

    # ---- 持倉 ----
    def open_position_count(self, exchange=None):
        return len(self.list_positions(exchange)) + len([i for i in self.list_intents(exchange) if not truthy(i.get("addOnTo"))])

    def has_position_for_symbol(self, symbol, exchange=None):
        return (any(p.get("symbol") == symbol for p in self.list_positions(exchange))
                or any(i.get("symbol") == symbol for i in self.list_intents(exchange)))

    def _pos_key(self, sig_id, exchange):
        with_ex = f"{exchange or 'okx'}:{sig_id}"
        pos = self.state["positions"]
        if with_ex in pos:
            return with_ex
        if sig_id in pos:
            return sig_id
        return with_ex

    def add_position(self, sig_id, position):
        ex = (position or {}).get("exchange") or "okx"
        rec = {"openedAt": iso(clock.now_ms())}
        rec.update(position or {})
        rec.update({"sigId": sig_id, "exchange": ex})
        self.state["positions"][f"{ex}:{sig_id}"] = rec
        self.save()

    def patch_position(self, sig_id, exchange, patch):
        key = self._pos_key(sig_id, exchange)
        cur = self.state["positions"].get(key)
        if cur is None:
            return False
        nxt = dict(cur)
        nxt.update(patch)
        for k, v in patch.items():
            if v is UNDEFINED:
                nxt.pop(k, None)
        self.state["positions"][key] = nxt
        self.save()
        return True

    def add_layer(self, base_sig_id, exchange, layer):
        key = self._pos_key(base_sig_id, exchange)
        cur = self.state["positions"].get(key)
        if cur is None:
            return False
        layers = list(cur["layers"]) if isinstance(cur.get("layers"), list) else []
        item = {"addedAt": iso(clock.now_ms())}
        item.update(layer)
        layers.append(item)
        nxt = dict(cur)
        nxt["layers"] = layers
        self.state["positions"][key] = nxt
        self.save()
        return True

    def remove_position(self, sig_id, exchange=None):
        key = self._pos_key(sig_id, exchange)
        if key not in self.state["positions"]:
            return False
        del self.state["positions"][key]
        self.save()
        return True

    def list_positions(self, exchange=None):
        out = []
        for key, p in self.state["positions"].items():
            parsed = split_key(key, p.get("exchange"))
            q = dict(p)
            q["sigId"] = p.get("sigId") or parsed["sigId"]
            q["exchange"] = p.get("exchange") or parsed["exchange"]
            if not exchange or q["exchange"] == exchange:
                out.append(q)
        return out

    # ---- 意圖 ----
    def record_intent(self, sig_id, intent):
        ex = (intent or {}).get("exchange") or "okx"
        rec = {"at": iso(clock.now_ms())}
        rec.update(intent or {})
        rec.update({"sigId": sig_id, "exchange": ex})
        self.state["intents"][f"{ex}:{sig_id}"] = rec
        self.save()

    def clear_intent(self, sig_id, exchange=None):
        with_ex = f"{exchange or 'okx'}:{sig_id}"
        it = self.state["intents"]
        key = with_ex if with_ex in it else (sig_id if sig_id in it else None)
        if not key:
            return
        del it[key]
        self.save()

    def list_intents(self, exchange=None):
        out = []
        for key, i in self.state["intents"].items():
            parsed = split_key(key, i.get("exchange"))
            q = dict(i)
            q["sigId"] = i.get("sigId") or parsed["sigId"]
            q["exchange"] = i.get("exchange") or parsed["exchange"]
            if not exchange or q["exchange"] == exchange:
                out.append(q)
        return out

    # ---- 當日損益（日界線 UTC+8）----
    def _today_key(self, now=None):
        ms = (now if truthy(now) else clock.now_ms()) + 8 * 3600 * 1000
        return iso(ms)[:10]

    def today(self, now=None):
        key = self._today_key(now)
        daily = self.state["daily"]
        if key not in daily:
            daily[key] = {"realisedPnlUsdt": 0, "orders": 0}
        d = daily[key]
        if not is_number(d.get("resetBaseline")):
            d["resetBaseline"] = 0
        if not isinstance(d.get("resets"), list):
            d["resets"] = []
        return d

    def daily_pnl_since_reset(self, now=None):
        d = self.today(now)
        return d["realisedPnlUsdt"] - (d.get("resetBaseline") or 0)

    def daily_reset_info(self, now=None):
        d = self.today(now)
        last = d["resets"][-1] if d["resets"] else None
        return {
            "count": len(d["resets"]),
            "lastAt": max(to_number(self.state.get("lastResetAtMs") or 0), last["at"] if last else 0),
            "realisedPnlUsdt": d["realisedPnlUsdt"],
            "baseline": d.get("resetBaseline") or 0,
            "effectivePnlUsdt": d["realisedPnlUsdt"] - (d.get("resetBaseline") or 0),
            "resets": list(d["resets"]),
        }

    def reset_daily_loss(self, opts=None):
        o = opts or {}
        now = o["now"] if truthy(o.get("now")) else clock.now_ms()
        d = self.today(now)
        cleared = d["realisedPnlUsdt"] - (d.get("resetBaseline") or 0)
        d["resetBaseline"] = d["realisedPnlUsdt"]
        d["resets"].append({"at": now, "by": o.get("by") or "telegram", "clearedUsdt": cleared,
                            "note": str(o.get("note") or "")})
        if now > (self.state.get("lastResetAtMs") or 0):
            self.state["lastResetAtMs"] = now
        self.save()
        return {"count": len(d["resets"]), "clearedUsdt": cleared, "at": now}

    def record_order(self, now=None):
        self.today(now)["orders"] += 1
        self.save()

    def record_pnl(self, pnl_usdt, now=None):
        n = to_number(pnl_usdt)
        self.today(now)["realisedPnlUsdt"] += (n if not math.isnan(n) and n != 0 else 0)
        self.save()

    # ---- 待確認 ----
    def _pend_key(self, sig_id, exchange):
        with_ex = f"{exchange or 'okx'}:{sig_id}"
        p = self.state["pendings"]
        if with_ex in p:
            return with_ex
        if sig_id in p:
            return sig_id
        return with_ex

    def add_pending(self, sig_id, record):
        ex = (record or {}).get("exchange") or "okx"
        key = f"{ex}:{sig_id}"
        rec = {"status": "pending", "createdAt": iso(clock.now_ms())}
        rec.update(record or {})
        rec.update({"sigId": sig_id, "exchange": ex})
        self.state["pendings"][key] = rec
        self.save()
        return rec

    def get_pending(self, sig_id, exchange=None):
        return self.state["pendings"].get(self._pend_key(sig_id, exchange))

    def claim_pending(self, sig_id, exchange=None):
        p = self.state["pendings"].get(self._pend_key(sig_id, exchange))
        if not p or p.get("status") != "pending":
            return False
        p["status"] = "confirming"
        self.save()
        return True

    def release_pending(self, sig_id, exchange=None):
        p = self.state["pendings"].get(self._pend_key(sig_id, exchange))
        if p and p.get("status") == "confirming":
            p["status"] = "pending"
            self.save()

    def pendings_for_signal(self, sig_id):
        out = []
        for key, p in self.state["pendings"].items():
            parsed = split_key(key, p.get("exchange"))
            q = dict(p)
            q["sigId"] = p.get("sigId") or parsed["sigId"]
            q["exchange"] = p.get("exchange") or parsed["exchange"]
            if q["sigId"] == sig_id:
                out.append(q)
        return out

    def resolve_pending(self, sig_id, outcome, detail=None, exchange=None):
        key = self._pend_key(sig_id, exchange)
        p = self.state["pendings"].get(key)
        if not p:
            return None
        p["status"] = outcome
        p["resolvedAt"] = iso(clock.now_ms())
        if truthy(detail):
            p["detail"] = detail

        def ref(obj_key, field):
            """JS 的 `p.x && p.x.f`：x 缺席 → 欄位省略；x 為假值 → 該假值；否則取欄位。"""
            if obj_key not in p:
                return UNDEFINED
            o = p[obj_key]
            if not truthy(o):
                return o
            return o[field] if isinstance(o, dict) and field in o else UNDEFINED

        rec = {"sigId": sig_id, "at": p["resolvedAt"], "outcome": outcome}
        for name, (ok, f) in {"symbol": ("signal", "symbol"), "side": ("signal", "side"),
                              "grade": ("signal", "grade"), "entry": ("signal", "entry"),
                              "sl": ("signal", "sl"), "orderQty": ("sizing", "orderQty"),
                              "riskUsdt": ("sizing", "actualRiskUsdt")}.items():
            v = ref(ok, f)
            if v is not UNDEFINED:
                rec[name] = v
        self.state["decisions"].append(rec)
        if len(self.state["decisions"]) > 2000:
            self.state["decisions"] = self.state["decisions"][-2000:]
        del self.state["pendings"][key]
        self.save()
        return p

    def expire_pendings(self, now_ms=None):
        now = now_ms if truthy(now_ms) else clock.now_ms()
        expired = []
        for key, p in list(self.state["pendings"].items()):
            if p.get("status") != "pending":
                continue
            if parse_iso_ms(p.get("expiresAt")) <= now if not isinstance(p.get("expiresAt"), (int, float)) else p["expiresAt"] <= now:
                parsed = split_key(key, p.get("exchange"))
                q = dict(p)
                q["sigId"] = p.get("sigId") or parsed["sigId"]
                q["exchange"] = p.get("exchange") or parsed["exchange"]
                expired.append(q)
        for p in expired:
            self.resolve_pending(p["sigId"], "expired", "超過存活時間未確認", p["exchange"])
        return expired

    def list_pendings(self, exchange=None):
        out = []
        for key, p in self.state["pendings"].items():
            parsed = split_key(key, p.get("exchange"))
            q = dict(p)
            q["sigId"] = p.get("sigId") or parsed["sigId"]
            q["exchange"] = p.get("exchange") or parsed["exchange"]
            if not exchange or q["exchange"] == exchange:
                out.append(q)
        return out

    def list_decisions(self, limit=None):
        n = limit if truthy(limit) else 50
        return list(reversed(self.state["decisions"][-n:]))

    # ---- 停止 / 覆寫 ----
    def is_halted(self):
        return bool(self.state.get("halted"))

    def set_halted(self, halted, reason=None, source=None):
        self.state["halted"] = bool(halted)
        self.state["haltedReason"] = str(reason if truthy(reason) else "手動停止") if halted else ""
        self.state["haltedSource"] = (source or "manual") if halted else ""
        self.save()

    def halted_reason(self):
        return self.state.get("haltedReason")

    def get_override(self, key):
        o = self.state.get("overrides")
        return o.get(key) if o else None

    def set_override(self, key, value):
        if not self.state.get("overrides"):
            self.state["overrides"] = {}
        if value is None:
            self.state["overrides"].pop(key, None)
        else:
            self.state["overrides"][key] = value
        self.save()

    def halted_source(self):
        return self.state.get("haltedSource") or ("manual" if self.state.get("halted") else "")

    def clear_halt_if_from(self, source):
        if not self.state.get("halted"):
            return False
        if self.halted_source() != source:
            return False
        self.set_halted(False)
        return True
