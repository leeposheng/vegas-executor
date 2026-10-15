import json
import math
import os

VEC_DIR = os.environ.get("VEGAS_VECTORS") or os.path.join(os.path.dirname(__file__), "..", "vectors")


def decode(x):
    if isinstance(x, dict):
        if set(x.keys()) == {"__num"}:
            return float(x["__num"].replace("Infinity", "inf"))
        return {k: decode(v) for k, v in x.items()}
    if isinstance(x, list):
        return [decode(v) for v in x]
    return x


def load(name):
    with open(os.path.join(VEC_DIR, name), encoding="utf-8") as f:
        return [decode(v) for v in json.load(f)]


def same(a, b, path=""):
    """逐欄比對；NaN 相等，int/float 視為同值，其餘嚴格。回傳差異字串或 None。"""
    if isinstance(a, bool) or isinstance(b, bool):
        return None if a is b else f"{path}: {a!r} != {b!r}"
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
            return None
        return None if a == b else f"{path}: {a!r} != {b!r}"
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            return f"{path}: keys {sorted(set(a) ^ set(b))} differ (got {sorted(a)} want {sorted(b)})"
        for k in a:
            d = same(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return f"{path}: len {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = same(x, y, f"{path}[{i}]")
            if d:
                return d
        return None
    return None if a == b else f"{path}: {a!r} != {b!r}"
