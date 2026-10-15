# 切換手冊（Node → Python）：現況為真實資金，所有「開關」由你決定

## 原則
1. 線上 Node 版（TV → GAS → Zeabur → TG）在 Python 版通過全部關卡前**不動**。
2. 同一時間只有一個程式有權下單（一個寫入者）。Python 版預設 `DRY_RUN=true`，不設交易所金鑰。
3. 任何一關失敗：不前進，不需要退回（因為前面的關卡都沒有碰線上）。

## 關卡
| # | 關卡 | 做法 | 通過條件 | 誰動手 |
|---|------|------|----------|--------|
| 0 | 決策一致 | `replay --from-telegram … --since 2026-10-11` | 決策差異 0（已達成：148 張） | 已完成 |
| 1 | 合約規格 | `replay … --fetch-instruments --save-instruments okx_instruments.json`，再重放 | 結果仍為差異 0（規格改用 OKX 公開值） | 你在本機執行 |
| 2 | OKX 簽章端點 | 另建**只勾「讀取」**的金鑰，白名單填你電腦的對外 IP；`py -m vegas_executor.okx_check` | 帳戶設定／權益／持倉／保護單／平倉紀錄全部 ✅ | 你建金鑰、本機執行 |
| 3 | Telegram 層對等 | Python 版取代 GAS（同一個 bot，不另建）：本機端到端測試 `tests/test_botrt.py`（收訊號→卡片→群組廣播→按鈕→改寫→指令）已通過；真實 Telegram 只在第 5 關切換時驗證 | 測試全過；`BOT_ENABLED` 預設關閉 | 已完成（程式面） |
| 4 | 影子運行 | Python 版另起一個 Zeabur 服務（DRY_RUN、無金鑰、無 Telegram），由你決定是否讓 GAS 多轉一份 | 連續數日，每筆訊號與 Node 的決策一致（`events.jsonl` + 重放） | 你設定 GAS／Zeabur |
| 5 | 切換 | 先停 Node 下單，再讓 Python 接手；先用最小保證金與 `EXECUTION_MODE=manual` | 第一筆人工確認單與保護單、對帳都正常 | **只有你** |
| 6 | 退回 | 停 Python、恢復 Node 的 Zeabur 設定 | 持倉由對帳（reconcile）認領，不重複下單 | 你 |

## 目前未驗證（必須在第 5 關前補齊）
- 簽章後的 OKX 端點對真實 OKX 的行為（第 2 關）。
- 真實下單路徑（含保護單、槓桿設定）：影子階段只驗到 DRY_RUN；第 5 關用最小保證金逐步驗證。
- Telegram 實發與按鈕回呼（只能在第 5 關切換時驗證：一個 bot 同時只有一個 webhook，且不另建測試 bot）。
- 已移植但尚未對真實服務驗證：圖表與 sendPhoto（模組 E，multipart 上傳要切換後才看得到結果）、webhook 管理指令（模組 G）。
- 刻意不移植／待你決定：Google 試算表系統日誌（模組 F，Python 改寫 events.jsonl，另可選配服務帳戶同步）、GAS 的影子轉送（目前未使用則無影響）。

## 風險提醒（真實資金）
- 實盤金鑰綁了 Zeabur 固定 IP；本機呼叫實盤金鑰會得到 50110，屬預期，請勿為了測試把你電腦的 IP 加進實盤金鑰。
- 金鑰只放在終端機環境變數或 Zeabur 設定，不貼到聊天、不提交到版本庫。
- 影子服務不得設任何交易所金鑰，避免兩個服務同時下單。

## Telegram 層切換步驟（第 5 關的一部分，全部由你決定）
前置：Python 服務設 `BOT_ENABLED=true`（圖表另需 `CHART_IMG_API_KEY` 與沿用 GAS 的 `CHART_*` 設定；沒有金鑰就只發純文字卡片）、`TG_TOKEN`、`ALLOWED_CHAT_ID`、`TRADINGVIEW_WEBHOOK_SECRET`、`TELEGRAM_WEBHOOK_SECRET`（選填 `SIGNAL_CHAT_ID`、`SIGNAL_THREAD_ID`、`OPERATOR_USER_IDS`、`ANTHROPIC_API_KEY`），先維持 `DRY_RUN=true`。
1. 網址形式與 GAS 相同：`https://<新網域>/?source=tradingview&key=<密鑰>`、`…?source=telegram&key=<密鑰>`。
2. 先把 TradingView 警報網址改成新網域（或先在 GAS 保留，擇一，不要兩邊同時指向）。
3. 在終端機設好 `TG_TOKEN`、`ALLOWED_CHAT_ID`、兩把密鑰、`WEBAPP_URL=https://<新網域>/`，先執行 `python -m vegas_executor.webhook_admin diagnose` 看現況，再執行 `… set`（會讓 GAS 停止收到按鈕與指令）；`tv-url` 可印出要貼進 TradingView 的網址。
4. 在私訊與群組各驗一次：訊號卡片、群組廣播、進場／略過、`日損`、`部位`、`狀態`。
5. 確認無誤後才把 `DRY_RUN` 改為 false（仍用 `EXECUTION_MODE=manual` 與最小保證金）。
6. 退回：把 `WEBAPP_URL` 改成 GAS 網址後再執行 `… set`、TradingView 網址改回 GAS；Python 服務可保留（`BOT_ENABLED=false`）。
