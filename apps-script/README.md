# Apps Script 這一半

這兩個檔不是 Node 專案的一部分，是貼進 Google Apps Script 編輯器的。
放進這個 repo 只是為了「整套系統在同一個地方」—— 交接時不會漏掉一半。

```
Code.gs      TradingView webhook 接收、Telegram 指令路由、系統日誌（第 3.6 批）
Executor.gs  圖卡繪製、執行層橋接、各種 Telegram 面板（3.7）
```

**兩個檔要一起換。** Code.gs 3.6 呼叫 Executor.gs 3.7 的 `forwardToShadow_`，
並靠它回傳的 `broadcastSent` 判斷群組要不要補送；只換其中一個，
模擬服務收不到訊號，或群組重複收到、漏掉訊號。

這兩份曾在不同的對話裡各自演進成兩個分支（一邊有話題群組、一邊有
斜線指令修正），3.5／3.4 是合併後的版本。**以 repo 這一份為唯一來源**，
改動先改這裡，再貼進 Apps Script，不要反過來從編輯器複製出來覆蓋。

## 部署的陷阱

**貼上程式碼不等於生效。** Apps Script 的 `/exec` 永遠跑「已部署的版本」，
不是編輯器裡存檔的那份。必須：

```
部署 → 管理部署作業 → 編輯（鉛筆）→ 版本：新版本 → 部署
```

網址不會變。少了這一步，症狀是「程式明明改了卻沒生效」，
而且很難聯想到部署 —— 這個坑踩過不只一次。

確認方法：執行 `diagnoseTelegramWebhook()`，看 `urlMatchesCurrentDeployment`。

## 怎麼判斷線上跑的是不是最新版

看 Telegram 卡片：

| 特徵 | 舊版 | 新版 |
|---|---|---|
| 被風控擋下的抬頭 | `⛔ 未執行` | `👀 可觀察` |
| 區間外的卡片 | 只有 `[原因]` | 多一行 `[效益]` |

## 指令碼屬性

必填五項，少一個 `getConfig_()` 會直接拋錯：

```
TG_TOKEN
ALLOWED_CHAT_ID
TRADINGVIEW_WEBHOOK_SECRET
TELEGRAM_WEBHOOK_SECRET
WEBAPP_URL
```

其餘（執行層、圖表）見 `Executor.gs` 開頭的常數宣告，
每一個都有註解說明預設值與取捨。

### 訊號群組

| 屬性 | 是什麼 |
|---|---|
| `SIGNAL_CHAT_ID` | 訊號群組（負數）。Code.gs 的原始訊號與 Executor.gs 的廣播**都讀這一個** |
| `SIGNAL_THREAD_ID` | 群組裡的話題 ID（選填，話題群組才需要） |
| `OPERATOR_USER_IDS` | 能按按鈕的人，逗號分隔；留空則退回 `ALLOWED_CHAT_ID` |

`ALLOWED_CHAT_ID` 必須維持你自己的私訊，不能填群組 ——
按鈕卡片、日損與持倉面板都只發到那裡。

`BROADCAST_CHAT_ID` 已停用（Executor.gs 3.4 起不再讀取）。它曾指向一個
同名的舊普通群組，造成執行層正常時訊號進錯群組。若屬性還在，執行
`checkChatIds()` 確認後刪除。

### 訊號送到哪裡

| 情況 | 私訊 | 群組 |
|---|---|---|
| 執行層正常 | 帶按鈕的卡片 | 廣播版卡片 |
| 卡片送失敗（執行層離線、解析失敗） | 原始訊號 | — |
| 廣播送失敗 | — | 原始訊號 |

原始訊號送不出去時進補送佇列，只補送失敗的那一邊。
驗證：`testSignalThread()`（Code.gs）與 `testBroadcastTarget()`（Executor.gs）
的測試訊息必須出現在同一個話題。

### 模擬服務（選填，Code.gs 3.6／Executor.gs 3.7 起）

實盤主服務之外，可以再跑一個只做模擬盤的執行層服務，同一筆訊號轉兩份。

| 屬性 | 是什麼 |
|---|---|
| `EXECUTOR_SHADOW_URL` | 模擬服務的網址（只到網域），必須與 `EXECUTOR_URL` 不同 |
| `EXECUTOR_SHADOW_SECRET` | 模擬服務的 `EXECUTOR_WEBHOOK_SECRET`，不可與主服務共用 |

兩個都設才啟用；沒設時行為與 3.5／3.6 之前完全相同。

| | 主服務 | 模擬服務 |
|---|---|---|
| 收到訊號的時機 | 先 | 主流程全部處理完之後 |
| 卡片與按鈕 | 由 Apps Script 發到私訊 | 沒有。模擬服務自己推播到它的聊天室，抬頭「🧪 模擬服務」 |
| 送不到時 | 進補送佇列 | 只記日誌（`shadow_forward_failed`），不補送 |
| 接錯服務時 | — | 對方回 409 拒收，日誌記 `shadow_target_mismatch`（error） |

驗證：

```
testShadowConnection()    模擬服務必須回報 role=shadow 且是模擬盤，否則拋錯
testExecutorConnection()  主網址若指到模擬服務會拋錯；主服務是實盤時只檢查 /health，
                          不送測試訊號（避免出現可按的真錢卡片與群組廣播）
diagnoseExecutorBridge()  會列出 shadowUrl
```
