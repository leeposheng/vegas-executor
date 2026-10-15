import pytest

from vegas_executor.syslog import log_fields
from .vec import load, same

V = [v for v in load("bot_f.json") if v["expected"]["queued"]]


@pytest.mark.parametrize("v", V, ids=lambda v: v["id"])
def test_fields(v):
    i = v["input"]
    got = log_fields(i["level"], i["event"], i.get("details"))
    exp = {k: x for k, x in v["expected"].items() if k != "queued"}
    assert same(got, exp, v["id"]) is None
