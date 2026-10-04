# vegas-executor 交接文件

> 最後更新：2026-10-01
> 測試：287 項全過（14 個測試檔）
> 狀態：OKX 可上真錢；BingX 僅限 VST 模擬盤（程式會擋，見 6.2）

**接手時先讀這份，再讀 `src/config.js` 的註解。**
程式碼裡的註解寫的是「為什麼這樣做」，不是「做了什麼」——
那些取捨多半是踩過坑換來的，改之前先看懂它在防什麼。

這份文件是給「接手改這份程式的人」看的，不是使用手冊。
它回答三個問題：這東西怎麼運作、為什麼這樣寫、哪裡還沒做完。

---

## 1. 系統全貌

```
TradingView 指標 (Pine v11.9)
        │  警報訊息＝人類可讀的文字
        ▼
Google Apps Script（Code.gs + Executor.gs）
        │  解析成 JSON、去重、加上 sig_id
        ▼
vegas-executor（Node.js，跑在 Zeabur）
        │  風控 → 倉位計算 → 下單
        ▼
    OKX  ／  BingX
        │
        ▼  每 60 秒
    對帳迴圈 → 損益入帳 → Telegram 平倉卡片
```

**關鍵設計**：訊號文字裡的 `[幣種]` **沒有交易所前綴**（是 `BTCUSDT.P`，
不是 `OKX:BTCUSDT.P`）。所以圖表掛在哪一家交易所都不影響執行層，
可以用單一來源（例如 Binance）的圖表，同時在 OKX 與 BingX 下單。

---

## 1b. 這個 zip 裡有什麼

```
src/           執行層（Node.js）
test/          14 個測試檔，287 項
tools/         檢查腳本、本機測試工具
apps-script/   Code.gs 與 Executor.gs ← 系統的另一半
HANDOFF.md     這份
.env.example   所有環境變數，每一項都有取捨說明
```

`apps-script/` 那兩個檔不是 Node 專案的一部分，是貼進 Google Apps Script
編輯器的。放進來只是為了「整套系統在同一個地方」—— 交接時不會漏掉一半。

**整套系統有兩個部署目標，兩邊都要更新：**

| 部署在哪 | 怎麼更新 | 漏掉的症狀 |
|---|---|---|
| Zeabur（`src/`） | 上傳 zip 或接 GitHub | 新的風控邏輯沒生效 |
| Apps Script（`apps-script/`） | 貼程式碼 **+ 部署新版本** | 卡片還是舊樣子 |

兩邊版本不一致是最常見的「明明改了卻沒效」來源，而且症狀會指向錯的地方。

---

## 2. 原始碼結構

| 檔案 | 職責 | 動它之前要知道的事 |
|---|---|---|
| `index.js` | HTTP 伺服器、開機自檢、對帳定時器 | 啟動順序：載入規格 → 自檢 → 開 port。自檢失敗不退出，改開 kill switch |
| `config.js` | 環境變數解析與驗證 | `bool`/`num` 看不懂的值一律拒絕啟動，不做寬容解析 |
| `signal.js` | 訊號解析與三層驗證 | `sig_id` 允許含冒號 —— 這影響 store 的鍵解析 |
| `risk.js` | 七道風控閘門 | 所有閘門都吃 `ctx.exchange`，雙邊下單時按交易所分開算 |
| `sizing.js` | 兩種倉位模式 | `risk_pct`＝固定風險；`fixed_margin`＝固定保證金（槓桿是風險旋鈕）|
| `symbols.js` | 白名單 | 白名單是「你的決定」，合約規格是「交易所的事實」，兩者分開 |
| `instruments.js` | 合約規格動態載入 | 三層退路：交易所 → 磁碟快取 → 靜態表 |
| `store.js` | 狀態（JSON 檔） | 所有集合的鍵都是 `交易所:訊號編號` |
| `serialize.js` | 下單路徑序列化 | 逾時**不會**中止工作，只是提早回覆呼叫端 |
| `executor.js` | 主流程 | `handleSignal` → 每家各跑一次 `handleForExchange` |
| `reconcile.js` | 對帳 | 輸入是交易所狀態，與 TradingView 無關 |
| `exchanges/okx.js` | OKX 串接 | 簽章在標頭；數量單位是「張」 |
| `exchanges/bingx.js` | BingX 串接 | 簽章在 query string；數量單位是「base 幣」 |

---

## 3. 六條必須理解的規則

改任何東西之前先讀完這一節。每一條都是踩過的坑，不是理論。

### 3.1 HTTP 200 不代表成功

OKX 與 BingX 都會用 200 回傳業務錯誤。
- OKX：`code` 為 `'0'` 但 `data[0].sCode` 非 `'0'` → 訂單被拒
- BingX：`code` 非 `0` → 失敗

`readOkxResponse` 與 `sendSigned` 各自檢查這件事。**不要**只看 `res.ok`。

### 3.2 「查不到」與「確定沒有」是兩件事

反查訂單時：
- 交易所明確說「訂單不存在」（OKX `51603`）→ 回 `null`，可以安心當作沒送達
- 網路失敗、限流、回應空白 → **往外拋**，留給下一輪

把後者當成前者的後果是：一筆已成交的單被判定為沒送出，意圖被清掉，
之後再也沒有人追它。

### 3.3 設定錯誤要往安全的方向倒

`bool()` 只認 `true/1/yes/on` 與 `false/0/no/off`，其餘**拒絕啟動**。
`num()` 對非數字**拒絕啟動**。

理由：`DEMO_MODE=1` 若被當成 `false`，第一筆訊號就打在真錢帳戶上。
而 `DAILY_LOSS_LIMIT_USDT=50 USDT` 會變成 `NaN`，`NaN` 參與比較恆為 false，
於是日損閘門永遠放行 —— 而且開機完全不報錯。

### 3.4 錢動了就一定要留下痕跡

`placeFromPlan` 在呼叫交易所**之前**先 `store.recordIntent()` 並同步寫檔。
成功後 `clearIntent`，例外時**刻意不清除**。

對帳迴圈用 `clOrdId` 反查那些意圖。沒有它，「請求已送達並成交但回應遺失」
會讓真實倉位存在而系統完全不知道：額度沒扣、止損觸發時損益不入帳、
冪等紀錄還擋住重送補救的路。

### 3.5 檢查與寫回之間不能有窗口

風控閘門讀 `store`，而寫回（`addPosition`）發生在交易所回應之後。
中間隔著三個 `await`。

`serialize.js` 的 `Gate` 把整條路徑序列化。**佇列必須鏈在 `fn` 本身上，
不能鏈在 `Promise.race` 的結果上** —— race 只是讓外層提早 settle，
被包住的工作還在跑，佇列一放行就交錯了，而失效時機正是「交易所沒回應」。

`test/concurrency.js` 守著這件事。把序列化拿掉，四筆訊號會全部成交。

### 3.6 鍵的解析只認已知前綴

`sig_id` 允許含冒號。用 `key.indexOf(':')` 切鍵會切在 `sig_id` 裡面，
於是 `removePosition` 找不到鍵、**靜默失敗**，部位永遠刪不掉，
而對帳每一輪重記一次同一筆損益 —— 一筆 −30 的停損三輪後帳上是 −90。

現在的做法：`splitKey()` 用 `^(okx|bingx):` 正規式，認不出就視為舊格式。
而且 `sigId` 同時存在 value 裡，鍵只當索引用。

`removePosition` 回傳布林值，對帳會先確認刪得掉才記損益。

---

## 4. 環境變數

完整清單在 `.env.example`（每一項都有註解說明取捨）。這裡只列最容易出事的。

| 變數 | 預設 | 錯了會怎樣 |
|---|---|---|
| `DRY_RUN` | `true` | `true` 時一張單都不會真的送出 |
| `DEMO_MODE` | `true` | `false` ＝ 真錢 |
| `EXCHANGES` | `okx` | 填兩家＝曝險加倍 |
| `EXECUTION_MODE` | `manual` | `by_grade` 要搭配 `MIN_GRADE < AUTO_GRADE_MIN` |
| `SIZING_MODE` | `risk_pct` | `fixed_margin` 必須搭 `OKX_TD_MODE=isolated` |
| `DAILY_LOSS_LIMIT_USDT` | `50` | 完全依賴對帳迴圈，`RECONCILE_SEC=0` 等於關掉它 |
| `ALLOWED_SYMBOLS` | 內建 50 個 | 開機與交易所取交集，對不上的剔除並列出 |
| `DAILY_RESET_LIMIT` | `1` | 真正的當日最大虧損 ＝ 日損上限 ×（1＋這個值） |
| `DAILY_RESET_COOLDOWN_MIN` | `30` | 冷卻的**下限**，Telegram 只能調更長 |
| `DAILY_LOSS_CEILING_USDT` | `max(100, 上限×2)` | 日損上限的天花板，Telegram 調不過它 |

### by_grade 的三段

```
等級 >= AUTO_GRADE_MIN            → 自動下單
MIN_GRADE <= 等級 < AUTO_GRADE_MIN → 發卡片，等按鈕
等級 <  MIN_GRADE                 → 直接拒絕
```

「弱訊按鈕、標準與高品質自動」＝ `AUTO_GRADE_MIN=2` 配 `MIN_GRADE=1`。
`MIN_GRADE` 留在預設的 2，弱訊會被直接拒絕，`by_grade` 安靜退化成 `auto`。

---

## 5. 固定保證金模式

```
名目   = FIXED_MARGIN_USDT × LEVERAGE
虧損   = 名目 × 止損距離% + 名目 × 費率 × 2
```

**槓桿是風險旋鈕**，不是放大器 —— 保證金固定，槓桿決定名目，
名目決定同樣的止損距離會虧多少。

100 × 40 = 名目 4000、來回手續費 4 USDT：

| 止損距離 | 預估虧損 | 20–45 區間 |
|---|---|---|
| 0.30% | 16.00 | ✗ 過緊 |
| 0.40% | 20.00 | ✓ |
| 0.63% | 29.20 | ✓ |
| 1.02% | 44.80 | ✓ |
| 1.20% | 52.00 | ✗ 過寬 |

區間外的訊號會被拒，這是設計而非故障。

---

## 5b. 日損上限的重置

Telegram 打「日損」叫出面板。超標時才會出現 `♻️ 重置日損上限`，
按下去是兩段式：第一下把後果攤開（會抹掉多少、真實日損多少、
最壞會變多少、還剩幾次），第二下才執行。

**重置不是歸零，是移動基準線。**

```
採計日損 = realisedPnlUsdt − resetBaseline
```

`realisedPnlUsdt` 永遠只增不改。這樣做的理由：今天真正虧了多少，
是事後檢討唯一的依據；為了讓風控放行而把它改掉，
等於為了關掉警報而拆掉溫度計。面板因此永遠同時顯示兩個數字。

三道防線，缺一道這顆鍵就變成裝飾品：

| 防線 | 在哪 | 擋什麼 |
|---|---|---|
| 次數上限 `DAILY_RESET_LIMIT` | 環境變數（只此一處） | 無限重置＝沒有日損上限 |
| 冷卻 `DAILY_RESET_COOLDOWN_MIN` | 獨立閘門 `reset_cooldown` | 剛按完重置鍵的那個人 |
| 留痕 `daily[].resets[]` | 狀態檔 | 一個月後回頭看「我那天按了三次」 |

冷卻刻意做成獨立閘門而不是併進日損那一道：合併的話，
重置成功的當下冷卻就被一起解掉了 —— 而那正是最該擋住的一刻。

`/daily` 與 `/daily/reset` 用**訊號金鑰**而非控制金鑰，理由與 `/limits` 相同：
呼叫端是 Apps Script，而控制金鑰（能解除 kill switch）刻意不放進去。
代價是訊號金鑰外洩的人可以重置日損 —— 但損害有界，
上限是 `DAILY_LOSS_LIMIT_USDT ×（1＋DAILY_RESET_LIMIT）`，
而那個次數只有 Zeabur 環境變數改得到。

---

### Telegram 可調的兩個參數

打「日損」的面板上，除了重置鍵，還有兩排按鈕：

| 參數 | 環境變數的角色 | Telegram 的範圍 |
|---|---|---|
| 日損上限 | `DAILY_LOSS_CEILING_USDT` 是**上界** | 10 ～ 天花板 |
| 重置冷卻 | `DAILY_RESET_COOLDOWN_MIN` 是**下界** | 下限 ～ 240 分 |
| 重置次數 | `DAILY_RESET_LIMIT` | 不開放，它本身就是天花板 |

**兩個方向相反，這是刻意的。** 日損上限往大調才危險，所以環境變數管上界；
冷卻往短調才危險，所以環境變數管下界。一律只給天花板的話，
冷卻就變成一顆可以在手機上歸零的擺設 —— 而那正是它要防的情境。

實作在 `risk.effectiveDailyLossLimit()` 與 `risk.effectiveCooldownMin()`，
兩者都從 `store.getOverride()` 取值再夾。閘門一律走這兩個函式，
不直接讀 `config.risk.*` —— 少了這層，面板上改的數字不會真的生效。

---

## 5c. 廣播群組

兩個聊天室，兩種權限：

| 指令碼屬性 | 是什麼 | 收到什麼 |
|---|---|---|
| `ALLOWED_CHAT_ID` | 你的私訊 | 完整卡片＋按鈕、所有面板、平倉結果 |
| `BROADCAST_CHAT_ID` | 群組（負數） | 只有訊號，無按鈕，無帳戶數字 |
| `OPERATOR_USER_IDS` | 能按按鈕的人 | 逗號分隔；留空則退回 `ALLOWED_CHAT_ID` |

廣播版**不是把按鈕拿掉的同一張卡**，是另外組的。
卡片下半段（風險、名目、數量、權益、拒絕原因）會反推出帳戶規模，
所以 `renderPendingCard_(..., forBroadcast=true)` 在分隔線處就停住。
`testRenderPendingCard` 有一組黑名單斷言守著這件事。

**授權從「聊天室」改成「人」。** 私訊裡兩者同義；群組裡不是 ——
一個 chat id，N 個人，而 inline 按鈕每個成員都按得到。
按鈕目前只發私訊，所以聊天室那道就已經擋住了；
認人那道是為了「第一道哪天被改壞」而存在。

平倉結果與對帳通知由執行層直接發（`notify.js`），
沒有廣播路徑 —— 那些含損益與倉位，本來就不該進群組。

---

## 5d. 自動槓桿（AUTO_LEVERAGE）

開啟後，每筆訊號的槓桿與保證金由止損距離反推。
**起點永遠是 `LEVERAGE`，只往下夾不往上** —— 這條單向性質是它敢在
真錢上開的唯一理由：開啟它只可能讓部位變小。

四道約束一起解（`sizing.js` 的 `autoSize`）：

| # | 約束 | 擋什麼 |
|---|---|---|
| 1 | 峰值槓桿 `LEVERAGE` | 上界，不往上突破 |
| 2 | 強平緩衝 `1/槓桿 ≥ 止損 × MIN_LIQ_CUSHION` | 「先強平、止損輪不到」的單 |
| 3 | 名目上限 `保證金 × 槓桿 ≤ 權益 × MAX_NOTIONAL_MULT` | 倉位相對帳戶過大 |
| 4 | 單筆虧損上限 `TARGET_LOSS_MAX_USDT` | 單筆代價超出預算 |

解法順序：**先用最小保證金配最高安全槓桿，湊不到最低虧損時才動保證金。**
這個順序讓佔用的本金永遠是最小的 —— 同樣一筆交易，鎖 100 還是 300
對損益沒有影響，對「還能再開幾筆」影響很大。

### 兩個踩過的坑

**名目上限原本不在求解裡**（2026-09-29 修）。舊版只夾 1、2、4，
算完才在外面檢查名目上限 —— 止損 0.8% 的訊號會算出 40x／名目 4000，
撞上 3000 的上限被拒，而 30x（名目 3000）明明合法。
拒絕訊息還會寫「名目超過上限」，看起來像參數設錯。

**加保證金時瞄準了邊界**（2026-09-30 修）。目標設成剛好 `lossMin`，
而數量還要對齊交易所的最小跳動單位，對齊一律往下捨 ——
於是結果必然落在線外。BTC 的實例：需要名目 4292.71，捨成 5.15 張
變 4289.95，虧損 19.99，差 0.01 被自己的閘門擋掉。
修法是多留一個跳動單位的量（`lotNotionalUsdt`）。
**瞄準邊界這件事本身就是錯的**，不是精度問題。

---

## 5e. BingX 模擬盤（VST）

BingX 的模擬盤是**換網域**，不是像 OKX 那樣加標頭：

```
真實盤  https://open-api.bingx.com
模擬盤  https://open-api-vst.bingx.com
```

`DEMO_MODE` 會自動選對網域，`BINGX_BASE_URL` 留空即可。

### 為什麼這道檢查在 BingX 上比 OKX 重要得多

OKX 的模擬金鑰是獨立環境的，物理上碰不到真實資金。
**BingX 的 VST 是同一個帳戶底下的虛擬餘額，決定真假的是網域而不是金鑰。**
所以 `BINGX_BASE_URL` 填錯就是真錢，金鑰本身給不了任何保護。

`validate()` 會擋下兩種不一致，兩個方向都擋：
- `DEMO_MODE=true` 配真實盤網域 → OKX 走模擬、BingX 走真錢，一邊假一邊真
- `DEMO_MODE=false` 配 VST → 你以為在跑真錢，而日損上限建立在假數字上

---

## 5f. 止損掛單驗證

每筆成交後查 `orders-algo-pending`，確認止損真的掛著（`okx.verifyProtection`）。

存在的理由：`attachAlgoOrds` 是隨主單附掛的，而下單回應的 `sCode=0`
**只代表主單被接受**，附掛的保護單有沒有真的建立，回應裡看不出來。

40x 逐倉下這個差別是致命的：止損距離 0.4%～1.0%，強平距離約 2.3%。
止損在的時候永遠先觸發；不在的時候你賠掉全部保證金 ——
而且要到強平那一刻才會知道。

判定刻意分三種：
- 查得到止損 → 通過
- 查得到、裡面沒有止損 → 🚨 裸倉警告（進 Telegram 卡片）
- **查詢失敗 → 只說「無法確認」，不宣稱裸倉**（假警報會訓練人忽略真警報）

---

## 6. 還沒做完的

依重要性排序。前三項是上真錢前該處理的。

### ~~6.1 BingX 沒有開機自檢與槓桿設定~~ ✅ 2026-09-29
已完成。`bingx.js` 有 `setLeverage`／`ensureLeverage`（LONG/SHORT 各設一次，
只設一邊的話做空那側會沿用舊值）與 `preflight`；`index.js` 每家各跑一輪自檢。
`executor.js` 下單前會用「這一筆實際算出來的」槓桿，不是設定值。

### 6.2 BingX 的已實現損益是聚合出來的 ← 真錢封鎖的唯一理由
BingX 沒有單筆平倉紀錄端點，`fetchPositionsHistory` 是把
`/user/income` 的 `REALIZED_PNL`／`COMMISSION`／`FUNDING_FEE` 流水加總。
同期間的其他交易會被一併計入。

目前的處置：標記 `pnlConfidence: 'low'`，平倉卡片會寫明。
正解是改用 `/trade/allFillOrders`，以 `clientOrderID` 歸戶。
**需要先在 VST 模擬盤累積幾筆真實成交才驗得了** —— 沒有成交資料的話，
改完也只是換一種沒驗證過的寫法。

### 6.3 權益查詢寫死 OKX
`equity.js` 的 `canQuery` 檢查 `config.primaryExchange === 'okx'`，
快取也只有一份。`risk_pct` 模式下 BingX 會用 OKX 的權益算倉位。
要改成 `getEquity(config, flags, now, exchange)`，快取分家。
`bingx.fetchEquity` 已經寫好但從未被呼叫。

### 6.4 TP2／TP3 從來沒被掛上去
止損止盈用 `attachAlgoOrds` 隨單附掛，但只掛 TP1，觸發即全平。
`plan.tpDeferred` 記著 TP2／TP3，但沒有人處理。
要做分批出場，需要在對帳偵測到 TP1 成交後補掛剩餘部位的單。

### 6.5 `confirming` 卡住無法回收
`expirePendings` 刻意跳過非 `pending` 的項目。若在 `confirming` 狀態時
重新部署，那筆會永久卡在 state 裡，只能手動改 JSON。
要加 `claimedAt`，超過 60–120 秒標成 `unknown` 並推播（**不要**自動放回
`pending`，那會變成重複下單）。

### 6.6 `state.json` 沒有 fsync
`save()` 用 `writeFileSync` + `renameSync`（rename 是原子的，所以不會半截），
但沒有 `fsync`。容器突然斷電時最後幾筆寫入可能遺失。

### 6.7 `/health` 沒有驗證
會吐出持倉數、當日損益與全部風控參數，而 Zeabur 的網址是公開的。

### 6.8 聚合結果會吃掉另一家的資訊
`aggregateResults` 用 `Object.assign({}, best, ...)`，
頂層的 `reasons`／`sizing`／`unconfirmed` 只剩最樂觀那一家的。
兩家因不同原因被拒時，HTTP 回應只看得到其中一個。
`perExchange` 裡有完整資料，但 `index.js` 的 `/signal` 回應沒有傳出去。

---

## 6b. 線上待確認（程式之外）

這一段是「程式沒問題，但部署／設定可能沒到位」的清單。
**接手時先問這幾個，不要假設線上跑的就是最新版。**

| 項目 | 怎麼確認 |
|---|---|
| Zeabur 跑的版本 | 開機日誌的橫幅，或看 Deployments 的時間 |
| Apps Script 有沒有部署 | 卡片抬頭是 `👀 可觀察` 還是舊的 `⛔ 未執行`；有沒有 `[效益]` 那行 |
| 環境變數到齊 | `AUTO_LEVERAGE` / `MIN_LIQ_CUSHION` / `FIXED_MARGIN_MAX_USDT` / `ALLOWED_TIMEFRAMES` |
| 交易所 IP 白名單 | **有交易權限又沒綁 IP 的 OKX 金鑰，閒置 14 天會被自動刪除且不通知** |
| 金鑰輪替 | bot token 與兩把 executor 金鑰曾在截圖中外洩，尚未輪替 |

**Apps Script 的陷阱**：貼上新程式碼不等於生效。
`/exec` 永遠跑「已部署的版本」，必須
`部署 → 管理部署作業 → 編輯 → 版本：新版本`。
症狀是「程式明明改了卻沒生效」，而 `diagnoseTelegramWebhook()` 的
`urlMatchesCurrentDeployment` 會告訴你。

---

## 7. 測試

```bash
npm test          # 287 項，全部不連網
npm run preflight # 連 OKX，驗證金鑰與合約規格（需要真金鑰）
```

| 檔案 | 守什麼 |
|---|---|
| `smoke.js` | 端到端：解析、閘門、倉位、決策 |
| `okx.js` | 簽章、prehash、錯誤碼、下單內容 |
| `concurrency.js` | 序列化。拿掉 Gate 會紅 |
| `dual-exchange.js` | 雙邊下單、鍵的解析、pendings 不互相覆寫 |
| `reconcile.js` | 平倉偵測、損益歸戶、意圖反查、孤兒倉 |
| `config-parse.js` | 打錯字必須拒絕啟動 |
| `fixed-margin.js` | 固定保證金的手算對照 |
| `daily-reset.js` | 重置只移動基準線、真實損益不變、冷卻生效 |

**寫新測試的標準**：它必須「在修正之前會紅」。
驗證方法是把修正暫時拿掉、跑測試、確認變紅、再還原。
沒通過這個驗證的測試只是裝飾。

`okx.js` 有一項需要 `openssl` 指令，Windows 上會自動略過並補三項替代驗證。

---

## 8. 部署

```powershell
powershell -ExecutionPolicy Bypass -File tools\make-deploy.ps1
```

產生不含 `.env` 的乾淨資料夾，拖到 Zeabur 的 Local Project 上傳區。

**`.env` 絕不能上傳。** 不只是外洩風險：`config.js` 的讀取順序是
「平台環境變數優先，`.env` 只填補空缺」。若 `.env` 跟著上去，
某個環境變數漏填時會**安靜地**用舊值補上。

`DATA_DIR` 必須指向掛載的硬碟（例如 `/data`），否則每次重新部署
`state.json` 歸零：冪等失效、所有在場部位變成系統不知道、日損重新計數。

Render 的設定在 `render.yaml`，每一項都有註解說明為什麼。
重點：不能用 free 方案（15 分鐘休眠、掛不了硬碟）。

---

## 9. 開機日誌怎麼讀

正常的樣子：

```
[規格] 向交易所取得 2xx 個 USDT 永續合約規格
[規格] 白名單共 50 個代碼可交易
[自檢] ✓ 帳戶模式 合約模式｜持倉模式 net_mode｜槓桿已設為 40x
  執行模式    : DEMO（交易所模擬盤）
  倉位模式    : fixed_margin（固定保證金）
  可接受止損  : 0.400% ～ 1.025%
  對帳迴圈    : 每 60 秒
```

要注意的：

| 看到什麼 | 代表什麼 |
|---|---|
| `[規格] 改用快取` / `靜態表` | 連不到交易所，規格可能過時 |
| `[自檢] DRY_RUN 模式，略過` | 不會送出任何真單 |
| `⛔ 自檢未通過` | 服務有起來但 kill switch 開著，修好後 `POST /control/resume` |
| `對帳迴圈 : 停用` | 日損上限不會累積 |
| `[對帳] 孤兒倉` | 交易所上有系統不知道的部位，需要人看 |
| `[對帳] ⚠️ 補登部位` | 某筆單其實成交了，注意有沒有重複下單 |
