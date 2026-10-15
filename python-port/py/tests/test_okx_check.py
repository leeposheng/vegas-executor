"""okx_check 的設定來源：讀 .env、終端機優先、被蓋過時提示（不連網）。"""
import asyncio

from vegas_executor import okx_check


def write_env(tmp_path, text):
    p = tmp_path / ".env"
    p.write_text(text, encoding="utf-8")
    return p


def test_reads_dotenv_when_terminal_empty(tmp_path):
    p = write_env(tmp_path, 'DEMO_MODE="true"\nOKX_API_KEY=k\n# 註解\nOKX_BASE_URL=https://eea.okx.com\n')
    env, file_env, shadowed = okx_check.load_env({}, p)
    assert env["DEMO_MODE"] == "true"           # 引號會去掉
    assert env["OKX_BASE_URL"] == "https://eea.okx.com"
    assert shadowed == []


def test_terminal_wins_and_is_reported(tmp_path):
    p = write_env(tmp_path, "DEMO_MODE=true\nOKX_API_KEY=new\nOKX_PASSPHRASE=same\n")
    env, _, shadowed = okx_check.load_env({"DEMO_MODE": "false", "OKX_API_KEY": "old",
                                           "OKX_PASSPHRASE": "same"}, p)
    assert env["DEMO_MODE"] == "false" and env["OKX_API_KEY"] == "old"
    assert shadowed == ["DEMO_MODE", "OKX_API_KEY"]   # 值相同的不算


def test_missing_dotenv_falls_back_to_terminal(tmp_path):
    env, file_env, shadowed = okx_check.load_env({"DEMO_MODE": "1"}, tmp_path / "nope.env")
    assert env == {"DEMO_MODE": "1"} and file_env == {} and shadowed == []


def test_parse_demo_matches_service():
    assert okx_check.parse_demo(None) is True
    assert okx_check.parse_demo(" ") is True
    assert okx_check.parse_demo("ON") is True
    assert okx_check.parse_demo("off") is False       # 舊版會把 off 當成模擬盤
    assert okx_check.parse_demo("ture") is None


def test_main_shows_shadow_and_stops_without_keys(tmp_path, capsys):
    p = write_env(tmp_path, "DEMO_MODE=true\nOKX_API_SECRET=s\n")
    rc = asyncio.run(okx_check.main({"DEMO_MODE": "false", "OKX_API_SECRET": "t"}, p))
    out = capsys.readouterr().out
    assert rc == 2
    assert f"設定來源：{p}" in out
    assert "DEMO_MODE 被終端機環境變數蓋過（終端機='false'，.env='true'）" in out
    assert "OKX_API_SECRET 被終端機環境變數蓋過（值不同）" in out
    assert "'t'" not in out and "'s'" not in out      # 金鑰值不印


def test_main_rejects_unparseable_demo(tmp_path, capsys):
    rc = asyncio.run(okx_check.main({"DEMO_MODE": "ture"}, tmp_path / "nope.env"))
    assert rc == 2
    assert "DEMO_MODE 的值「ture」無法解析" in capsys.readouterr().out


def test_repo_dotenv_points_at_executor_root():
    assert (okx_check.REPO_DOTENV.parent / "src" / "config.js").exists()
