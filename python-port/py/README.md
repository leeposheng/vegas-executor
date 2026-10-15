# vegas_executor（Python 移植版，階段 5-2）

已完成並通過黃金向量／情境測試：signal / sizing / drift / symbols / notify / OKX・BingX 簽章與下單體 / store / risk /
config / gate / equity / executor（55 個管線情境）/ reconcile（50 筆）/ HTTP 路由與服務層（行為測試）。

階段 4 新增：OKX 簽章網路層（查帳戶設定／權益／持倉／平倉紀錄／保護單、訂單反查、槓桿、止損核對、開機自檢、下單）。
驗證方式：51 個向量由 Node 版以假 fetch 產生（請求的 URL／標頭／簽章／本文與結果、錯誤訊息逐字相同）＋ 9 個以假 OKX 跑完整非 DRY_RUN 路徑的端對端測試。
**尚未對真實 OKX 驗證**——請先跑下面的唯讀檢查，再談切換。BingX 網路層留待第二批。

階段 5-1 新增：事件日誌、告警、離線重放、Node↔Python 隨機差異測試（見下）。

## 對真實 OKX 做唯讀檢查（不下單、不改槓桿）
```
$env:OKX_API_KEY="..."; $env:OKX_API_SECRET="..."; $env:OKX_PASSPHRASE="..."; $env:DEMO_MODE="true"
py -m vegas_executor.okx_check
```
- 設定來源與服務相同：先讀 `vegas-executor\.env`，**終端機環境變數優先**；被蓋過時會用 ⚠️ 標出（金鑰只說「值不同」，不印值）。
- 會印「金鑰指紋」（頭尾各 4 碼＋長度）方便與 Zeabur 設定對照；遇 50101／50111 會自動診斷是模擬盤金鑰、站點不同或殘留舊值。
- 實盤金鑰若綁了 IP 白名單，從本機呼叫會得到 50110，這是預期的；本機請用另建、只勾「讀取」的金鑰。
金鑰只放在你自己的終端機環境變數，不要貼到聊天。

## 事件日誌與告警（階段 5-1）
- 事件寫到 `<DATA_DIR>/events.jsonl`（每行一筆；欄位：ts／level／source／event／detail／durationMs／eventId），超過
  `EVENTS_MAX_BYTES`（預設 2MB）輪轉，保留 `EVENTS_BACKUPS` 份（預設 3）。`EVENTS_FILE=off` 關閉寫檔；也可指定路徑。
- WARN／ERROR 同時印到 stdout；INFO 只進檔案。寫檔失敗不會影響下單。
- 查詢：`GET /events?limit=50&level=WARN&event=executor_rejected`（需 `X-Control-Key`）。
- 事件名：`webhook_rejected`（detail.reason：bad_executor_key／bad_control_key／invalid_json／target_mismatch／payload_too_large）、
  `executor_pending`／`executor_rejected`／`executor_placed`／`executor_dry_run`…（`executor_<decision>`）、`reconcile_closed`／`reconcile_error`／
  `reconcile_released`／`reconcile_orphan`、`preflight_ok`／`preflight_failed`、`control_halt`／`control_resume`／`limits_changed`／`daily_reset`、
  `gate_timeout`／`run_timeout`、`telegram_send_failed`、`http_error`、`uncaught_exception`、`service_started`／`service_stopping`、`alert`。
- 告警（寫 `alert` 事件，並在有 Telegram 設定時送出）：未捕捉例外、HTTP 500、gate／run 逾時、對帳連續 3 次失敗；
  Telegram 連續 3 次送不出只留事件＋stdout（不能再用 Telegram 通知）。同一類告警 15 分鐘（逾時類 10 分鐘）內不重複。
- 金鑰類欄位（secret／token／passphrase／apiKey／authorization／x-*-key）在寫入前一律遮成 `***`。

## 離線重放（階段 5-1；絕不連交易所、不發訊息、不碰 Volume 的狀態檔）
```
py -m vegas_executor.replay signals.jsonl --expected zeabur.log
```
- `signals.jsonl`：每行一筆訊號 JSON（與 POST /signal 的內容相同）。`zeabur.log`（選填）：Zeabur 日誌，取其中 `[signal] {...}` 行當 Node 的答案。
- 強制 DRY_RUN＋DEMO、清空所有金鑰與 Telegram；現價假設等於 entry；時鐘設為「訊號 ts＋2 秒」。
- 輸出分三類：一致／狀態相依（持倉數、日損、停止下單、重複代碼——重放從空狀態開始，屬預期差異）／決策差異（需要查）。
- 結果寫到 `replay_report.json`；有決策差異時結束碼為 1。

## Node↔Python 隨機差異測試（階段 5-1）
`vectors/fuzz.json`：固定種子產生的 520 個情境（隨機設定、持倉、日損、停止下單、壞資料、重送、確認／略過、漂移、加倉、超額），
答案由 Node 原版算出，`tests/test_pipeline.py` 逐欄比對。已用突變檢查確認它抓得到：把下單量改大 0.01% 就會有 6 個情境失敗。
重新產生：`../generator/generate.sh <node src 絕對路徑> ../vectors`。

## 以 Telegram 決策卡重放（階段 5-2）
```
py -m vegas_executor.replay --from-telegram result.json --since 2026-10-11 [--eras eras.json]
    [--instruments-json okx_instruments.json | --fetch-instruments --save-instruments okx_instruments.json]
```
- 卡片含完整訊號與 Node 當時的輸出，直接重建訊號並逐張比對：有單的卡比數量／風險；拒絕／可觀察的卡比整句原因。
- 每張卡獨立、空狀態重放。分類：一致／狀態相依（持倉數、日損…）／下單階段失敗（卡片有數量卻「未執行」且無決策原因）／決策差異。
- 設定：預設為 2026-10-11 起的推定值（固定保證金 50、虧損帶 10–22、槓桿 40 自動、強平緩衝 3）；週期白名單、最低等級、虧損上下限會從卡片自己的拒絕原因讀出；其他時期用 `--eras`（`{"起始日": {環境變數: 值}}`）。
- 合約規格：預設由卡片數字反推（報告標 `inferred`）；建議改用 `--fetch-instruments`（唯一會上網的步驟，只打 OKX 公開端點，不帶金鑰）一次存檔，之後離線用 `--instruments-json`。
- 2026-10-11 之前的卡片來自較早版本的 Node（原因文字與計算方式不同，例如「預估虧損…超過上限…過寬」），不能拿來驗證目前版本，請勿當成差異。

## Telegram 實發檢查（第 3 關）
```
$env:TG_TEST_TOKEN="123456:ABC..."; $env:TG_TEST_CHAT_ID="-100xxxxxxxxxx"
py -m vegas_executor.telegram_check
```
- 只用你另建的**測試 bot＋測試群組**；只認 `TG_TEST_*`，不讀 `.env`、不讀 `TG_TOKEN`。測試用的 bot／群組若與 `.env` 的正式值相同會拒絕執行。
- 送出：純文字、數張代表性卡片（Python 版渲染）、4096 字元邊界訊息；並探測 4097 字元（預期被拒，Python 與 Node 一樣不截斷）。
- Python 版只送**純文字推播**；卡片按鈕與回呼由 Apps Script 負責，不在這一關範圍。

## 測試（Windows PowerShell）
```
cd python-port\py
py -m venv .venv ; .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
$env:VEGAS_VECTORS="..\vectors"
py -m pytest -q
```

## 本機試跑（DRY_RUN，不連任何帳戶）
```
$env:EXECUTOR_WEBHOOK_SECRET="至少16字元的假字串"
$env:EXECUTOR_CONTROL_SECRET="另一個至少16字元的假字串"
$env:DRY_RUN="true"; $env:DEMO_MODE="true"; $env:DATA_DIR="$PWD\data"; $env:PORT="8080"
py -m vegas_executor
# 另一個視窗：curl http://localhost:8080/health
```
請勿把正式金鑰貼到聊天或提交到版本庫。

向量由 `../generator/generate.sh` 從 Node 原始碼產生；Python 版不得為了讓測試過而改向量。

## 取代 GAS：模組 A（訊號入口）
把 Code.gs 的入口搬成 Python（`gas_util.py`、`tg.py`、`intake.py`、`webhook.py`）：
- `webhook.Webhook.do_post`：`?source=tradingview&key=…`／`?source=telegram&key=…` 的密鑰驗證與分流（網址格式與 GAS 相同，切換時只換網域）、被拒請求每 10 分鐘彙總一筆。
- `intake.Intake.handle_tradingview`：格式檢查 → 去重（30 分鐘）→ 轉執行層 → 私訊／群組各自補送原始訊號 → 補送佇列（指數退避、最多 10 次／6 小時、佇列上限 50）→ 最近訊號 → 影子服務轉送。
- `tg.send_message`：分段（3800 字）、話題 ID、429／5xx 重試與 Retry-After。
- 驗證：`vectors/intake.json` 273 筆，由 `generator/gen_intake.js` 在假 GAS 環境（Cache／Properties／Lock／UrlFetch／時鐘）執行**原版 Code.gs** 產生；含 160 組隨機流程，並用突變檢查確認抓得到差異。
- 重新產生：`generator/generate.sh`（原版 GAS 放在 `generator/gas/`）。
- 尚未接上 HTTP 路由：轉執行層（模組 B：解析、決策、卡片）完成後才會啟用，避免現在就有人把訊號打進來而只送原始訊號。

## 取代 GAS：模組 B（解析、決策卡片、轉送）
Executor.gs 的「文字 → JSON → 執行層 → 卡片」搬成 Python：
- `cards.py`：`parse_signal_to_json`（欄位解析、週期／品質／分數／止損方向檢查）、`render_pending_card`（待確認／已下單／未執行／可觀察卡片，私訊版與群組廣播版）。
- `forward.py`：`Forwarder.forward_to_executor`（解析 → 呼叫執行層 → 送卡片＋按鈕 → 群組廣播、file_id 重用 → 日誌）、補送佇列 `EXECRETRY_`（退避 2^n 分鐘上限 15、最多 8 次／2 小時、佇列 50）、廣播對象與操作者判定。
- `bridge.py`：把「HTTP POST /signal」換成行程內直接呼叫 `handle_signal`；回傳形狀與原 `postToExecutor_` 相同。逾時只放棄等待，不取消下單中的協程。
- 驗證：`vectors/bot_b.json` 665 筆（解析 133、卡片 400 隨機、轉送流程 111、補送 11、操作者 10），由 `generator/gen_bot.js` 在假 GAS 環境執行**原版 Code.gs＋Executor.gs** 產生；突變檢查 12 種全數被抓到（含 1024 字元說明邊界、2 小時補送邊界）。
- 尚未啟用：模組 C（按鈕回呼）完成前，HTTP 路由維持關閉，避免按鈕按了沒有人接。

## 取代 GAS：模組 C（按鈕回呼）
- `callbacks.py`：`Callbacks.handle_update`（Code.gs 的 callback_query 分支：聊天室驗證 → update_id 去重〔最近 100 筆〕→ 重複投遞只記一次）、`handle_executor_callback`（雙重授權：聊天室＋操作者；sig_id 鎖 600 秒；連不上執行層時放鎖可重按；結果改寫原卡片、保留方向、移除按鈕；依現價重算差異緊貼標題）、持倉上限面板、日損面板（重置兩段式確認、上限／冷卻調整、從拒絕卡片叫出面板）。
- `loopback.py`：按鈕呼叫執行層改為對本服務自己的 127.0.0.1 端點發請求，/limits、/daily、/confirm、/skip 的驗證與錯誤訊息只有 app.py 一份實作。
- 驗證：`vectors/bot_c.json` 267 筆（流程 107＋面板／純函式／改寫 160），由 `generator/gen_cb.js` 在假 GAS 環境執行原版程式產生；含 update_id 視窗滿 100 筆、鎖忙碌（可逐次指定 tryLock 結果）等邊界；突變檢查約 30 種皆被抓到（唯一未被抓到的是等價突變）。
- 尚未啟用 HTTP 路由；模組 D（文字指令與對話）完成後，一次接上並以旗標控制。

## 取代 GAS：模組 D（文字指令與問答）
- `bot.py`：`TelegramBot.handle` 是 Telegram webhook 的完整入口（交給 `Webhook(telegram=…)`）：JSON 解析 → callback 交模組 C → 陌生聊天室（只放行 /id，快取節流：update_id 1 小時、每聊天室 60 秒）→ 機器人訊息／空訊息略過 → update_id 去重 → 指令（停止／啟用／部位／日損／id／選單／狀態）→ 暫停中不問答 → `ask_claude`。
- 指令正規化沿用原規則：去前後空白、取第一個詞、轉小寫、去 `@botname`、去開頭斜線，所以 `/日損`、`日損`、`/daily`、`daily` 都通。
- `ask_claude`：系統提示詞、模型（預設與 GAS 相同的 `claude-haiku-4-5-20251001`，可用 `model=` 覆寫）、最近 6 小時訊號附帶、失敗時固定回覆並寫 `claude_request_failed`。`make_claude_fetch` 提供 429／5xx 重試。
- 驗證：`vectors/bot_d.json` 145 筆（流程 121＋指令正規化與比對 24），由 `generator/gen_dm.js` 在假 GAS 環境執行原版程式產生；突變檢查 20 種皆被抓到。已知差異只有一處：回應不是合法 JSON 時，日誌的 message 是 Python 的錯誤字樣而非 V8 的（回覆給使用者的文字相同，另有單元測試）。

## 接線：Telegram 層（A–D 合體）
- `botrt.BotRuntime`：把入口、轉送、按鈕、指令組成 `do_post(params, body)`；`app.create_app(..., bot=…)` 在 `POST /?source=tradingview|telegram&key=…` 呼叫它（回應一律 200 純文字，與 GAS 相同）。**預設關閉**：`BOT_ENABLED=true` 才建立，沒開時該路徑回 404。
- 設定沿用 GAS 屬性名稱、改由環境變數提供：必填 `TG_TOKEN`、`ALLOWED_CHAT_ID`、`TRADINGVIEW_WEBHOOK_SECRET`、`TELEGRAM_WEBHOOK_SECRET`；選填 `SIGNAL_CHAT_ID`、`SIGNAL_THREAD_ID`、`OPERATOR_USER_IDS`、`ANTHROPIC_API_KEY`。缺必填項時啟動即失敗（不靜默）。
- 狀態（去重、補送佇列、暫停旗標）存在 `DATA_DIR/bot_kv.json`；每分鐘一次排程處理補送佇列。
- `tests/test_botrt.py`：用 TestClient 當伺服器、假 Telegram，走完 收訊號 → 私訊卡片＋群組廣播（無按鈕、無帳戶數字）→ 重複訊號去重 → 進場按鈕 → 改寫原卡片 → 重按不重複 → 他人按鈕被拒 → 指令（經 127.0.0.1 呼叫 /daily、/limits）。
- 尚未含：圖表（模組 E，卡片目前無圖）、試算表日誌（F）、setWebhook／診斷工具（G）。

## 模組 E：圖表（CHART-IMG）與 sendPhoto

- `chart.py`：`chart_options`（讀 CHART_* 屬性並夾限）、`build_chart_request`（請求內容，欄位順序與 JSON 輸出逐字相同）、`Chart.fetch_image`（取圖，永不拋例外，失敗回 None → 卡片改發純文字）、`Chart.send_photo`（multipart sendPhoto）。
- 接線：`botrt.BotRuntime` 以 `Chart` 取代原先的空實作；沒有 `CHART_IMG_API_KEY` 時等同停用（與 GAS 相同，不記錄）。
- 設定：屬性名稱與 GAS 完全相同，改由環境變數提供（`CHART_IMG_API_KEY`、`CHART_MAX_PARAMS`、`CHART_THEME`、`CHART_SHOW_LEVELS`…）。
- 驗證：`generator/gen_chart.js` 在假 GAS 環境執行原版函式，產生 `vectors/bot_e.json`（943 筆：設定組合、請求組裝、取圖成敗、sendPhoto 回應）；`tests/test_chart.py` 逐欄比對。突變檢查 70+ 項，僅 2 個等價突變存活（尺寸上限 `>` 與 `>=` 在邊界值相同）。
- 未驗證到的部分：真實 CHART-IMG 與 Telegram 的網路呼叫（multipart 本文格式以單元測試確認，實際接受度要切換後才看得到）。

## 模組 F：系統日誌

GAS 把日誌暫存進指令碼屬性、再批次寫入試算表「系統日誌」（佇列上限 200、保留 5000 列），那一整套是為了繞過 Apps Script 的限制。Python 端直接寫 `events.jsonl`（同樣七欄：時間／等級／來源／事件／說明／耗時／事件ID，自動輪轉，另可由 `GET /events` 查詢），所以佇列、批次與刪列機制不移植。
- `syslog.log_fields`：移植會影響內容的規則——來源判定（`source` 欄 → 事件名含 tradingview／telegram／claude → `service` → `system`）、`source`／`elapsedMs` 從說明中分離、`elapsedMs` 僅接受數字。`botrt.log` 已改用它。
- 驗證：`generator/gen_syslog.js` → `vectors/bot_f.json`（19 筆，含佇列上限情境但 Python 不適用）；`tests/test_syslog.py`。
- 尚未做：同步寫入 Google 試算表。需要服務帳戶金鑰（密鑰），是否要保留試算表視圖由你決定；不做也不影響交易。

## 模組 G：Webhook 管理

`python -m vegas_executor.webhook_admin <check|diagnose|tv-url|gen-secret|set|reset|reset-drop>`，對應 GAS 的 setupTelegramWebhook／resetTelegramWebhook／diagnoseTelegramWebhook／showTradingViewWebhookUrl／resetTelegramWebhookAndDropPendingUpdates／initializeWebhookSecrets。
- 需要環境變數 `TG_TOKEN`、`ALLOWED_CHAT_ID`、兩把 webhook 密鑰與 `WEBAPP_URL`（Python 服務的公開網址）。
- `diagnose`、`check`、`gen-secret`、`tv-url` 不改變任何外部狀態；`set`／`reset`／`reset-drop` 會把 Telegram 的更新改送到 `WEBAPP_URL`，屬於切換步驟（見 CUTOVER.md）。
- 驗證：`generator/gen_wh.js` → `vectors/bot_g.json`（29 筆：請求內容、診斷輸出逐行、網址組裝與編碼）；`tests/test_webhook_admin.py`。
