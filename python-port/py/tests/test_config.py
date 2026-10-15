import pytest

from vegas_executor.config import ConfigError, build_config, validate
from .vec import load, same

C = load("config.json")


@pytest.mark.parametrize("v", C, ids=[v["id"] for v in C])
def test_config(v):
    env = dict(v["input"]["env"])
    cfg, perr = build_config(env, base_dir="/x")
    exp = v["expected"]
    try:
        got = validate(cfg, perr, warn=lambda m: None)
        got_v = {"ok": True, "cfg": got}
    except ConfigError as e:
        got_v = {"ok": False, "msg": str(e)}
    ev = exp["validate"]
    if "threw" in ev:
        assert not got_v["ok"], f"{v['id']}: 預期拋出 {ev['threw']!r}，實際通過"
        assert got_v["msg"] == ev["threw"], f"{v['id']}:\n{got_v['msg']!r}\n!=\n{ev['threw']!r}"
    else:
        assert got_v["ok"], f"{v['id']}: 意外拋出 {got_v.get('msg')!r}"
        want = dict(exp["config"])
        have = dict(got_v["cfg"])
        if "DATA_DIR" not in env:
            want.pop("dataDir", None)
            have.pop("dataDir", None)
        d = same(have, want)
        assert d is None, f"{v['id']}: {d}"
