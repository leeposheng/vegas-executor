# 維加斯執行服務（階段 0 骨架）

對應 TradingView 指標 v11.8 與 Apps Script 第 3 批。

**目前狀態：`DRY_RUN=true`，完整執行所有計算與簽章，但不送出任何委託。**

---

## 一、為什麼分成兩層

```
TradingView ──► Apps Script ──► Telegram        （警訊／日誌，已上線）
                     │
                     └────────► 執行服務 ──────► OKX / BingX
                                （本專案）
```

Apps Script 不適合承擔下單層，主因有四：

| 限制 | 影響 |
|---|---|
| 無固定對外 IP | 無法使用交易所的 API Key IP 白名單，等於放棄最有效的單一保護 |
| 單次 6 分鐘、每日 90 分鐘 | 無法跑持續的持倉監控與對帳 |
| Web App 併發無法嚴格序列化 | `LockService` 有 timeout，高併發下可能重複下單 |
| 冷啟動延遲不可控 | 市價單滑價風險 |

因此金鑰、風控、對帳全部集中在這一層。**即使 Apps Script 的 webhook 網址外流，也動不到資金。**

---

## 二、處理流程

每一筆訊號依序通過七個階段，任一階段失敗就停止並記錄原因。第 1 到 5 步是「算」，第 6 到 7 步才「動到錢」，兩者刻意分開，好讓中間能插入一個人：

```
1. parse    解析與驗證      型別、SL 方向、TP 排序、重放窗口
2. risk     風控閘門        kill switch → 冪等 → 等級 → 週期 → 日損 → 倉數 → 重複標的
3. symbol   代碼對應        白名單查表，查不到即拒絕
4. spec     合約規格        ctVal / lotSz / minSz
5. sizing   倉位計算        由風險金額反推數量，無條件捨去
6. order    組單並簽章      DRY_RUN 下只組出請求，不送出
7. record   記錄與通知      持久化 + Telegram
```

### 待確認狀態機

`EXECUTION_MODE=manual` 時，第 5 步算完就停下來存成待確認，等 `/confirm` 才走第 6 步。

```
[訊號] ──閘門擋下──> rejected
       └─通過──> pending ──確認──> confirming ──> placed
                        ├─略過──> skipped
                        └─逾時──> expired
```

`confirming` 是一個短暫但必要的中間狀態。下單要等交易所回應，而那段等待期間第二個確認請求可能進來（重複點擊、Telegram 重送 callback）。在任何 `await` 之前就同步把狀態改成 `confirming`，第二個請求才擋得住——只靠 `sig_id` 冪等不夠，那是在交易所端生效，這裡要在送出前就攔下。

按下確認的當下會**重新檢查會隨時間改變的閘門**：kill switch、當日虧損、同時持倉、同標的重複。訊號屬性類的（等級、週期）不重查，因為它們不會變。

「略過」也會寫進 `/decisions`。這筆資料的價值三個月後才顯現：沒有它，就無法回答「那些沒按的訊號，按了會賺還是賠」，也就無從判斷自主篩選是加分還是扣分。

**設計重點：決策過程完全與 I/O 分離。** `executor.js` 不碰 HTTP、不呼叫 `process.exit`，所有相依都由 `ctx` 傳入，因此整條管線可以在不連網、不開伺服器的狀態下完整測試。

### 倉位計算

```
風險金額  = 權益 × 單筆風險比例
風險距離  = |entry − sl|
base 數量 = 風險金額 ÷ 風險距離
```

不論標的波動大小，單筆止損的虧損金額都會接近同一個數字。這與「每次固定下 0.01 BTC」有本質差異——後者在 SL 較遠時風險會放大數倍。

**三個必須注意的細節：**

1. **OKX 的 `sz` 是合約張數，不是幣數。** `BTC-USDT-SWAP` 的 `ctVal` 為 0.01，所以 0.129 BTC = 12.9 張。把 0.129 直接填進 `sz` 會變成 0.129 張，差了兩個數量級。BingX 的 `quantity` 則是 base 幣。兩者不能共用同一套換算。

2. **無條件捨去，不四捨五入。** 向上進位會讓實際風險超過預算。捨去後若低於最小下單量，做法是**拒單**而非湊到最小量——湊上去等於默默放大風險。

3. **張數少時量化誤差會變大。** SL 越遠、算出的張數越少，被捨去的那一格佔比就越高。實測：SL 近時用掉預算的 99.9%，SL 遠時只用 95.9%。這不會造成超額風險（永遠低於預算），但代表實際下注比預期保守。若要改善，選項是提高權益或改用 `lotSz` 更小的合約。

### 止損止盈採「隨單附掛」

OKX 用 `attachAlgoOrds`、BingX 用 `stopLoss` / `takeProfit` 參數，都在下單的同一個請求內送出。

理由：分兩步送會出現「已進場但尚無保護單」的裸倉窗口。若第二步因網路或限流失敗，就會留下一個沒有止損的部位。

階段 0 只掛 TP1，其餘兩段記錄在 `tpDeferred`。多段停利需要分批平倉，會讓對帳與部分成交的處理複雜度大幅上升，留到階段 2。

---

## 三、兩家交易所的差異

這是最容易寫錯的地方，所以刻意寫成兩個獨立檔案，不做共用抽象。

| | OKX | BingX |
|---|---|---|
| 簽章位置 | HTTP 標頭 `OK-ACCESS-SIGN` | query string 的 `&signature=` |
| 簽章內容 | `timestamp + METHOD + path + body` | query string 本身 |
| 編碼 | Base64 | hex |
| 時間戳 | ISO 8601 含毫秒 | 毫秒整數 |
| 數量單位 | **合約張數** | **base 幣** |
| 模擬盤 | 標頭 `x-simulated-trading: 1` | VST 帳戶 |
| 額外憑證 | passphrase | 無 |
| 成功判定 | `code === '0'`（字串） | `code === 0`（數字） |

兩家都是 **HTTP 200 不代表下單成功**，必須檢查回應的 `code`。

BingX 有一個容易踩的陷阱：用來簽章的字串必須與實際送出的 query string **逐字元相同**。若先簽章再做 encode、或簽完又調整參數順序，簽章一定失敗。因此 `buildSignedRequest` 只組一次字串，簽章與送出共用同一份。

---

## 四、風控閘門

寫成一組獨立的布林檢查，全部通過才放行，而非散落在流程中的 `if`。好處是每道閘門都能單獨測試，拒絕原因也能完整記錄——事後檢討「為什麼這筆沒進場」時，這份紀錄就是答案。

| 閘門 | 作用 |
|---|---|
| `kill_switch` | 人為緊急停止，最高優先 |
| `idempotency` | 同一 `sig_id` 只處理一次，持久化於磁碟 |
| `min_grade` | 預設只接受標準以上（grade ≥ 2） |
| `timeframe` | 週期白名單，預設 15 與 60 分 |
| `daily_loss_limit` | 當日累計虧損達上限即停止 |
| `max_concurrent` | 同時持倉上限 |
| `no_duplicate_symbol` | 同標的不重複開倉 |

Telegram 會收到緊湊摘要：`✓停止 ✓冪等 ✗等級 ✓週期 ✓日損 ✓倉數 ✓重複`

**被拒絕也會通知。** 若只在成功下單時通知，系統整晚一單沒下時，無法分辨是沒有訊號還是程式壞了。

---

## 五、安全設計

| 項目 | 做法 |
|---|---|
| 金鑰儲存 | 只從環境變數讀，`.env` 已列入 `.gitignore` |
| 雙金鑰 | 訊號金鑰與控制金鑰分開。前者存在 Apps Script，外流也無法解除 kill switch |
| 金鑰傳遞 | HTTP 標頭而非 query string，不會進入反向代理的存取日誌 |
| 比對方式 | `crypto.timingSafeEqual`，避免計時攻擊 |
| 日誌遮蔽 | 決策物件中的 API key、簽章、passphrase 一律替換為 `[REDACTED]` |
| 預設保守 | `DRY_RUN` 預設 true，必須明確設為 false 才會下單 |
| body 上限 | 16 KB，避免記憶體被撐爆 |

**API Key 建立時務必：只勾「交易」權限，「提現」一律不勾，並綁定 IP 白名單。**

---

## 六、快速開始

```bash
cd vegas-executor
cp .env.example .env

# 產生兩組不同的密鑰
openssl rand -hex 32   # → EXECUTOR_WEBHOOK_SECRET
openssl rand -hex 32   # → EXECUTOR_CONTROL_SECRET

npm test               # 51 項冒煙測試，不連網
npm start              # 啟動服務（DRY_RUN）
```

另開一個終端機：

```bash
curl localhost:8080/health

node tools/send-sample.js          # 高品質做多 → placed（未送出）
node tools/send-sample.js short    # 做空
node tools/send-sample.js weak     # 弱訊號 → 被 MIN_GRADE 擋下
node tools/send-sample.js bad      # 方向寫反 → 在 parse 階段停住
node tools/send-sample.js stale    # 過期 → 被重放保護擋下
node tools/send-sample.js dup      # 連送兩次 → 第二次被冪等擋下
```

kill switch：

```bash
curl -X POST localhost:8080/control/halt \
  -H "X-Control-Key: $EXECUTOR_CONTROL_SECRET" \
  -H 'Content-Type: application/json' -d '{"reason":"手動停止"}'

curl -X POST localhost:8080/control/resume -H "X-Control-Key: $EXECUTOR_CONTROL_SECRET"
```

---

## 七、訊號格式

Apps Script 或 TradingView 應送出這個 JSON：

```json
{
  "v": "11.8",
  "sig_id": "BTCUSDT.P-60-1758461820000-long",
  "ts": 1758461820000,
  "symbol": "BTCUSDT.P",
  "tf": "60",
  "grade": 3,
  "score": 85,
  "side": "long",
  "entry": 85397.5,
  "sl": 85011.8,
  "tp": [85783.2, 86169.0, 86554.7]
}
```

- `sig_id`：全系統唯一，同時作為冪等鍵。建議用 `代碼-週期-K棒時間-方向`。
- `ts`：K 棒時間戳（毫秒），用於重放保護。
- 送往 `POST /signal`，標頭帶 `X-Executor-Key`。

指標端需要啟用 v11.3 註解中備妥的 `alertMsgJson`，並補上 `sig_id` 與 `ts` 兩個欄位。

---

## 八、端點

| 端點 | 驗證 | 說明 |
|---|---|---|
| `GET /health` | 無 | 執行模式、決策模式、持倉數、待確認數、當日損益 |
| `POST /signal` | `X-Executor-Key` | 接收訊號 |
| `POST /confirm` | `X-Executor-Key` | 確認下單，body 帶 `{"sig_id": "..."}` |
| `POST /skip` | `X-Executor-Key` | 略過，仍留下決策紀錄 |
| `GET /pending` | `X-Executor-Key` | 待確認清單 |
| `POST /control/halt` | `X-Control-Key` | 停止下單 |
| `POST /control/resume` | `X-Control-Key` | 恢復下單 |
| `GET /positions` | `X-Control-Key` | 目前登記的部位 |
| `GET /decisions` | `X-Control-Key` | 歷次決策（確認／略過／過期），供檢討自主篩選 |
| `GET /control/whoami` | `X-Control-Key` | 本機對外 IP，供填交易所白名單；請隔數小時重查確認穩定 |

`/confirm` 與 `/skip` 用訊號金鑰而非控制金鑰，因為呼叫者是 Apps Script，而它只持有訊號金鑰。這代表訊號金鑰外洩時對方不只能送假訊號，還能確認下單——實際損害受限於風險比例、名目上限與代碼白名單，但仍是實質的權限提升。控制金鑰（緊急停止）維持獨立。

`/signal` **一律回 200**，拒絕不是 HTTP 錯誤。回 4xx/5xx 會讓上游誤以為需要重送，反而製造重複訊號。

---

## 九、尚未實作（依序）

| 階段 | 項目 |
|---|---|
| 2 | **對帳迴圈**：每分鐘比對交易所實際持倉與 `state.json`，不一致即告警 |
| 2 | 多段停利：分批平倉掛 TP2、TP3 |
| 2 | 移動止損：TP1 觸及後將 SL 移至成本 |
| 2 | 已實現損益回填，讓每日虧損上限真正生效 |
| 3 | 狀態層改用 SQLite，支援多實例 |

**對帳迴圈是階段 2 最重要的一項。** API 逾時、部分成交、手動平倉都會造成 `state.json` 與交易所實際狀態漂移，沒有對帳就無從察覺。

另外，目前 `daily_loss_limit` 閘門已經寫好，但 `recordPnl()` 還沒有被任何地方呼叫——必須等對帳迴圈完成才會有真實損益進來。在那之前這道閘門形同虛設，**這是上線前必須補上的缺口**。

---

## 十、上線檢查清單

`DRY_RUN=false` 之前，逐項確認：

- [ ] `npm test` 全數通過
- [ ] 模擬盤（`DEMO_MODE=true`）連續運行 2 週以上，無非預期拒絕
- [ ] 對帳迴圈已實作並驗證
- [ ] `recordPnl()` 已串接，每日虧損上限確實生效
- [ ] API Key 未開啟提現權限
- [ ] API Key 已綁定出口 IP（雲端請用 `/control/whoami` 查，並確認它不會變）
- [ ] 主機已啟用 NTP（OKX 容許誤差僅 30 秒）
- [ ] kill switch 實測可用，且控制金鑰與訊號金鑰不同
- [ ] `npm run preflight` 通過（憑證、帳戶模式、權益、合約規格）
- [ ] 權益來源顯示為 `exchange`，而非退回設定檔
- [ ] `DRIFT_CHECK=true`，且已實測漂移過大時確實拒單
- [ ] `MAX_NOTIONAL_USDT` 設為正常單筆名目的 2 至 3 倍
- [ ] 已比對模擬盤與實盤的滑價差距
- [ ] 首週僅用最小可下單量，單一幣種、單一週期

---

## 檔案結構

```
src/
  config.js            設定載入與啟動驗證
  signal.js            訊號解析與三層驗證
  symbols.js           代碼白名單與合約規格靜態表
  sizing.js            風險反推倉位
  equity.js            權益來源（交易所 → 快取 → 設定檔，來源會標明）
  drift.js             進場價漂移檢查（確認時才生效）
  risk.js              七道風控閘門
  store.js             狀態持久化（原子寫入）
  executor.js          主流程編排（純邏輯，可完整測試）
  notify.js            Telegram 通知
  exchanges/okx.js     OKX V5 簽章與下單
  exchanges/bingx.js   BingX 簽章與下單
  index.js             HTTP 入口
test/
  smoke.js             66 項冒煙測試（核心流程）
  okx.js               25 項 OKX 模組測試（簽章以 openssl 獨立驗算）
  drift.js             20 項漂移檢查（13 單元 + 7 整合）
  equity.js             9 項權益來源
tools/
  okx-preflight.js     OKX 開機自檢（npm run preflight）
  send-sample.js       範例訊號產生器
  make-deploy.ps1      產生可直接上傳雲端的乾淨資料夾（不含 .env）
```

共 120 項測試，全部不連網。

零外部依賴，只用 Node 18+ 內建模組。
