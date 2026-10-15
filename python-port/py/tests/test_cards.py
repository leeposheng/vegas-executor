import pytest

from vegas_executor import cards as C, clock
from vegas_executor.cards import UNDEF
from .vec import load, same

V = load("bot_b.json")
CLOCK = 1758470000000
FN = {"extractField_": C.extract_field, "parsePrice_": C.parse_price, "tfTextToMinutes_": C.tf_text_to_minutes,
      "gradeTextToNumber_": C.grade_text_to_number, "parsePriceUnit_": C.parse_price_unit,
      "parseScoreField_": C.parse_score_field}


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "bparse"], ids=lambda v: v["id"])
def test_parse(v):
    fn, args = v["input"]["fn"], v["input"]["args"]
    clock.set_now(CLOCK)
    try:
        if fn == "parseSignalToJson_":
            text, sid, now = (args + [None, None, None])[:3]
            got = C.parse_signal_to_json(text, sid, now)
        else:
            got = FN[fn](*args)
    finally:
        clock.set_now(None)
    assert same(got, v["expected"], v["id"]) is None


def undef_walk(x):
    return x


@pytest.mark.parametrize("v", [x for x in V if x["fn"] == "bcard"], ids=lambda v: v["id"])
def test_card(v):
    inp, exp = v["input"], v["expected"]
    got = {"text": C.render_pending_card(inp["payload"], inp["result"], inp["original"], inp["forBroadcast"]),
           "head": C.card_head(inp["result"]), "observable": C.is_observable(inp["result"])}
    assert same(got, exp, v["id"]) is None
