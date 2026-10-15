# 維加斯執行層 → Python 移植《行為規格》（階段 0）

版本基準：Node 版 `vegas-executor`（`npm test` 349 項全過，Node 22.22.0）。
來源檔的雜湊見 `SOURCE_HASHES.txt`；黃金向量 652 筆在 `vectors/`，由 `generator/generate.sh` 從 Node 原始碼重現（兩次產生逐位元相同）。

**一句話原則：Python 版的輸出必須與黃金向量逐欄一致；差異只允許出現在本文「刻意差異」一節。**

---

## 0. v1 範圍

| 範圍 | 內容 |
|---|---|
| v1 要做 | 訊號解析、風控閘門、倉位計算（risk_pct／fixed_margin／自動槓桿）、漂移檢查、待確認狀態機、OKX 實盤（DRY_RUN 預設開）、對帳、Telegram 通知／卡片／面板／按鈕、HTTP 路由、狀態檔、設定驗證、可觀測性 |
| 第二批 | CHART-IMG 圖表、`askClaude_` 問答、Google Sheets 日誌寫入、BingX／shadow 服務 |
| 不做 | 任何改動交易規則的「優化」。移植期間規則凍結，優化另開階段 |

BingX 的純函式（簽章、下單參數、數量單位）仍納入向量與單元測試，因為對帳與設定層共用；但不接真實流程。

---

## 1. 模組對照

| Node | Python 模組 | 純函式？ | 向量檔 |
|---|---|---|---|
| signal.js | `signal.py` | 是（時間由參數注入） | signal.json |
| sizing.js | `sizing.py` | 是 | floor_to_step.json、compute_size.json、tofixed.json |
| drift.js | `drift.py` | 是 | drift.json |
| risk.js | `risk.py` | 讀 store、時間注入 | risk.json |
| store.js | `store.py` | 否（檔案） | store.json |
| symbols.js／instruments.js | `symbols.py`／`instruments.py` | 部分 | mapping.json |
| notify.js | `notify.py`（`render_decision` 為純函式） | 部分 | notify.json |
| exchanges/okx.js、bingx.js | `exchanges/okx.py`、`bingx.py` | 建構函式為純 | exchange_requests.json |
| executor.js | `executor.py` | 否 | pipeline.json |
| reconcile.js | `reconcile.py` | 否 | reconcile.json |
| config.js | `config.py` | 讀環境變數 | config.json |
| serialize.js | `gate.py` | 否 | （語意見 §6） |
| index.js | `app.py`（FastAPI） | 否 | （路由見 §8） |
| equity.js | `equity.py` | 否 | 以注入假交易所測 |

向量格式：每筆 `{id, fn, input, expected}`。`fn` 是邏輯函式名（`parse_signal`、`compute_size`…），測試端自行對映到 Python 函式。`expected` 為 `{ok:true,value}` 或 `{ok:false,throws}`，數值以 JSON number 表示。NaN／Infinity 以 `{"__num":"NaN"}` 表示。pipeline／reconcile／store 向量含初始狀態、步驟序列、最終 `state.json` 內容。

---

## 2. 凍結時鐘（必做）

Node 的 `evaluate`、`dailyLossGate`、`resetCooldown`、`store.today()` 在沒傳 `now` 時用牆上時鐘。向量產生時用 FakeDate 凍結，因此 Python 必須：

1. 所有時間讀取走單一注入點 `clock.now_ms()`；測試時覆寫為向量的 `now`。
2. `risk.evaluate/recheck` 不接受 `now` 參數也要能用注入時鐘（與 Node 相同簽章，行為由時鐘決定）。
3. 向量中的 `now`、`startNow` 一律為毫秒整數。pipeline 向量每步有 `dt`（相對 `startNow` 的毫秒位移）。

**日界線為 UTC+8**：`today_key = (now_ms + 8h).isoformat()[:10]`。向量 `tzday_boundary_*`（16:00:00Z 前後一秒）涵蓋邊界。

---

## 3. 數值規格

### 3.1 四捨五入（與 Python 預設不同，最容易出事）
JS `Number.prototype.toFixed` 對精確平局做「遠離零」進位：`0.03125.toFixed(4) = "0.0313"`、`2.5.toFixed(0) = "3"`、`0.125.toFixed(2)="0.13"`。Python `round()`／`f"{x:.4f}"` 是銀行家／二進位誤差行為（`0.0312`）。
**規定**：所有 `toFixed(n)` 與 `Number(x.toFixed(n))` 一律改用 `Decimal(repr(x))` + `ROUND_HALF_UP`，向量 `tofixed.json` 為驗收。注意 `1.005.toFixed(2)="1.00"`（二進位表示 1.00499…），因此**輸入要用 float 的精確十進位展開**，不是 `repr`：`Decimal(x)`（精確）+ `quantize(ROUND_HALF_UP)`。向量中 `tf_1.005_2→"1.00"`、`tf_8.345_2→"8.35"`、`tf_1.45_1→"1.4"` 是區分「精確展開」與「repr 字串」兩種做法的試金石。
`round4`（餵給虧損帶閘門）同此規則。

### 3.2 floor_to_step
`floor((value + 1e-12) / step) * step`，再 `Number(n.toFixed(max(decimals(step), 8)))`。`decimals(step)` 為 step 小數位數。以 float 運算，**不要改 Decimal**（會改變 1e-12 容差行為）。向量 `floor_to_step.json`。

### 3.3 倉位
- `risk_pct`：`riskAmount = equity × pct`，`rawBase = riskAmount / |entry−sl|`；OKX 換成張（`/ctVal`）→ `floor_to_step(lotSz)`；低於 `minSz` 拒絕；名目 > cap 拒絕（容差 1e-9）。
- `fixed_margin`：`notional = margin × leverage`；`loss = notional × stop% + notional × fee × 2`；損失帶 `[lossMin, lossMax]` 為閘門；自動槓桿解四個約束（槓桿峰值、強平緩衝 `1/lev ≥ stop × MIN_LIQ_CUSHION`、名目上限、虧損上限），加保證金時留一個 lot 的餘裕。
- OKX 數量單位＝張（ctVal），BingX＝base 幣。
- 結果物件的**欄位名與順序**以向量為準（含 `riskBudgetIsCap`、`capBound`、`band`、`preview`）。

### 3.4 漂移
`assessDrift` 的 verdict 與判定順序以向量 `drift.json` 為準：`no_price → invalid → sl_crossed → tp1_passed → drifted_against/drifted_toward（超過 maxWiden/maxTighten）→ resize/unchanged`。比較是「等於也算穿過」（`live == sl` → `sl_crossed`）。`driftR`、`distanceRatio` 皆 round 到 4 位（§3.1 規則）。resize 時以**現價**與**原始權益基準**重算倉位。

---

## 4. 風控閘門（順序固定，名稱與訊息字串逐字相同）

`evaluate`：`kill_switch → idempotency → min_grade → timeframe → daily_loss_limit → reset_cooldown → max_concurrent → no_duplicate_symbol`。全部都跑（不短路），`reasons` 為 `"<name>: <detail>"` 的失敗項。
`recheck`（確認當下）：`kill_switch、daily_loss_limit、reset_cooldown、max_concurrent、no_duplicate_symbol`（或 `addon_base`）；**不重查** idempotency、min_grade、timeframe。`allowOverflow` 改以硬上限判 `max_concurrent`；`addOn` 以 `addon_base` 取代 `max_concurrent`／`no_duplicate_symbol` 的角色。
`summarise` 產生 `✓停止 ✗等級 …` 摘要（中文標籤表見向量）。
`overflowEligible`：失敗閘門恰為 `[max_concurrent]` 且 `openCount < hardCap`。`addOnEligible`：失敗含 `no_duplicate_symbol`、其餘只可有 `max_concurrent`；同向、層數 < `ADDON_MAX`。

覆寫（override）生效值：`effective_max_concurrent = max(1, min(override ?? cfg, ceiling ?? cfg))`；`effective_daily_loss_limit` 同理（下限 1）；`effective_cooldown_min = max(floor, min(override ?? floor, 720))`。
日損：`effective = realised − resetBaseline`；`-effective >= limit` 即超限（**等於也擋**）。重置只移動 baseline，`realisedPnlUsdt` 只增不改；`lastResetAtMs` 為全域，冷卻可跨午夜。

---

## 5. 狀態檔（store）

- 檔案 `DATA_DIR/state.json`，寫入 **tmp + rename**，缺省欄位以 `EMPTY` 補齊（`halted, haltedReason, haltedSource, processed, positions, pendings, daily, decisions, intents, overrides, lastResetAtMs`，`mode`/`role` 由 `bindMode` 寫入）。Python 版**必須能讀寫同一份檔案**——切換時直接沿用 Zeabur Volume 上的 state.json。
- 鍵格式 `exchange:sigId`；讀取時舊格式（無前綴）退回 `okx`。`splitKey` 以 `^(okx|bingx):` 判斷。
- `processed` 保留 7 天；`markProcessed` 時清理。
- `bindMode(mode, role)`：**回傳** `{ok:false,error}`（不拋例外）。角色不符→「狀態檔屬於 X 服務」；模式（demo/live）不符→拒絕；`mode=live` 且狀態檔曾損壞備份、或已有資料卻未綁定模式→拒絕。首次綁定寫入 `mode`／`role`。逐字訊息見向量 `seq_bind_mode`。
- 狀態檔損壞：改名 `state.json.corrupt-<ms>`、以空狀態啟動並告警。
- 待確認狀態機：`pending → confirming → placed | skipped | expired`。`claimPending` 必須在任何 await 之前同步完成（防重複確認）。`expirePendings` 把逾時者標 expired 並寫入 decisions。
- `halted` 來源：`manual / preflight / daily_loss`；舊檔無 `haltedSource` 視為 `manual`；`clearHaltIfFrom(x)` 只解除同來源的停止。
- JSON 序列化：`JSON.stringify(state, null, 2)`。Python 用 `json.dumps(indent=2, ensure_ascii=False)`；**數字格式**：整數值的 float（`5.0`）要輸出 `5`，以免與 Node 寫的檔案互相造成 diff（非功能性，但利於 shadow 比對）。

---

## 6. 序列化閘（Gate）——語意與 Node 一致，實作方式不同

Node：整條「檢查→下單→記帳」路徑經單一佇列；佇列鏈接的是 `fn` 本身，**逾時只放行呼叫者、不取消工作**。`maxWaitMs=20000`（排隊太久→`gate_timeout`）、`maxRunMs=30000`（執行太久→`run_timeout`，訊息要求使用者去交易所確認）。
Python 規定：
1. 用 `asyncio.Lock`／單一 worker 佇列；**不得用 `asyncio.wait_for` 取消下單任務**（取消可能發生在「已送出、未記帳」之間，等於憑空製造孤兒倉）。用 `asyncio.shield` 或把工作交給獨立 Task，逾時只讓呼叫端返回。
2. **單一 worker 程序**（uvicorn `--workers 1`）。模組單例：`order_gate`、權益快取、`leverage_done` 都在記憶體內，多 worker 會破壞所有保證。
3. 錯誤碼 `gate_timeout`、`run_timeout` 與其中文訊息逐字沿用；`gateRejection` 回傳 `unconfirmed:true`（run_timeout 時）。
4. 確認雙邊（okx+bingx）時依序逐家執行，每家各自進閘。

---

## 7. 交易所介面

### OKX
簽章 `base64(HMAC_SHA256(secret, ts + METHOD + requestPath(含 query) + body))`，`ts` 為 ISO 毫秒 UTC（`toISOString`，`…Z`）。Demo 加 `x-simulated-trading: 1`。`buildOrderBody`：`sz` 為字串；`attachAlgoOrds[0]` = `{slTriggerPx, slOrdPx:'-1', tpTriggerPx, tpOrdPx:'-1'}`；僅 `posMode=long_short_mode` 時帶 `posSide`。**body 的 JSON 序列化必須與 Node 逐字相同**（簽章吃它）：`json.dumps(body, separators=(',',':'), ensure_ascii=False)`；數字轉字串用 JS 的數字格式（如 `1e-7` → `"1e-7"`、`0.1`→`"0.1"`、`85011.8`→`"85011.8"`；Python `str(float)` 在 `1e-05` 與 `1e-5` 上不同，需自寫 `js_num_to_str`）。向量 `okx_sign_*`、`okx_body_*` 含 `float_qty` 專測此點。
### BingX
簽章在 query string（hex），`pairs` 保持傳入順序、略過空值（`undefined/null/''`）；`timestamp`、`recvWindow=5000` 附加在最後再簽。`stopLoss/takeProfit` 為 JSON **字串**。
### client order id
`('vg' + sha256(sigId).hexdigest())[:32]`（prefix 可傳；超長 prefix 照切 32）。
### 錯誤解讀
`explainOkxError`、`readOkxResponse` 的中文提示字串需逐字沿用（日誌與 Telegram 會顯示）。

---

## 8. HTTP 路由（行為以 index.js 為準）

| 路由 | 驗證 | 說明 |
|---|---|---|
| GET /health | 無 | 狀態、模式、持倉數、日損、冷卻等 |
| POST /signal | `X-Executor-Key` | 400 invalid json；403 forbidden；`target:'shadow'` 但本服務非 shadow+demo → **409** |
| POST /confirm、/skip | `X-Executor-Key` | 雙邊時一次確認兩家 |
| GET/POST /limits | `X-Executor-Key` | 執行期調整持倉／日損／冷卻（受 ceiling 限制） |
| GET /daily、POST /daily/reset | `X-Executor-Key` | 重置受 `DAILY_RESET_LIMIT`、冷卻限制 |
| GET /pending | `X-Executor-Key` | |
| POST /control/halt、resume；GET /positions、/decisions、/control/whoami；GET/POST /control/reconcile | `X-Control-Key` | |

金鑰比較用常數時間（`hmac.compare_digest`）。兩把密鑰必須不同（設定層驗證）。

---

## 9. 設定（config）

- `bool()`：接受 `true/false/1/0/yes/no/on/off`（大小寫不拘）；**空字串＝用預設**；其他值收集到 `parseErrors`。`num()`：無法解析（如 `1e`、`abc`、`50 USDT`）收集錯誤。`validate()` **一次回報全部錯誤**，以 `設定驗證失敗：\n  - …` 開頭拋出。
- 規則：webhook／control 密鑰各 ≥16 字元且不同；`INSTANCE_ROLE ∈ {live, shadow}`；shadow 必須 `DEMO_MODE=true`；`DRY_RUN=false` 需 OKX 三件金鑰；**BingX 真錢一律拒絕**。
- 逐項預設值與環境變數名稱以 `vectors/config.json`（15 組輸入）與 `deploy/live.env.example` 為準。
- 注意 `live.env.example` 是「第一階段」保守值（保證金 25、虧損 5–11、單倉、BTCUSDT.P、週期 15），與你 10/07 的實盤規則（保證金 40、峰值虧損 20、週期 15/30）不同；**向量以設定參數化，不綁定範例值**；實際上線值以 Zeabur 環境變數為準。

---

## 10. 對帳（reconcile）

- 寬限 `OPEN_GRACE_MS=90s`；開倉時間比對容差 `OPEN_MATCH_MS=5min`；`RECONCILE_STALE_MIN` 預設 30。
- 流程：先抓全部持倉（失敗→整輪不動作）→ 處理意圖（用 `clOrdId` 反查：`filled` 補登部位並標 `recoveredBy:'reconcile'`；`canceled`／查無（null）清除意圖；`live`、`partially_filled` 留著；反查丟例外→留著並報錯，若已超過 stale 且交易所現無該合約持倉→釋放並記入 `released`）→ 偵測孤兒倉（只告警、不處置）→ 逐筆部位結算。
- 部位結算：仍在持倉→`stillOpen`，並清 `goneSinceMs`；在寬限內→算 stillOpen；否則查平倉紀錄 `matchHistory`（嚴格：closedAt 不得早於開倉 −60s、方向相符或 net、開倉時間差 ≤5 分、取開倉時間最接近者）。查無：第一輪寫 `goneSinceMs` 並報錯；未滿 stale 繼續報錯；滿 stale 改用寬鬆比對（取最早平倉者），仍無則 `removePosition` 並 `released`（**損益未入帳**，需推播）。
- 記帳：**`removePosition` 成功後才 `recordPnl`**；`realizedPnl`（含手續費）入帳，不是 `pnl`；入帳日期以**平倉時間**（UTC+8）而非對帳時間。
- `inferExit`：只在平倉均價靠近 tp1／sl 時推斷，且標明「推斷」。`describeCloseType`：1 部分平倉、2 平倉、3 強制平倉、4 部分強平、5 自動減倉（未全平）、6 自動減倉、其他「已平倉」。
- `demo` 旗標必須傳到每一次交易所呼叫（向量 `flagsSeen` 驗證；實盤為 `false` 而非缺省）。
- BingX 損益為資金流水聚合，`pnlConfidence:'low'`。

---

## 11. 刻意差異與不可退讓點

| 項目 | Node | Python 規定 |
|---|---|---|
| toFixed 平局 | 遠離零 | Decimal ROUND_HALF_UP（精確展開輸入） |
| 取消語意 | 逾時不取消工作 | shield／獨立 Task |
| 並行 | 單程序 | 單 worker |
| 數字轉字串 | JS 格式 | 自寫 `js_num_to_str`（簽章與卡片都用） |
| 日誌 | console.log | 結構化事件（§12），同時保留 stdout |
| 時鐘 | `Date.now()` | 注入 `clock` |
| 預設 | DRY_RUN 由環境變數決定 | **Python 版首次部署強制 DRY_RUN=true**，且與 Node 同時間只能有一個寫入者 |

---

## 12. 可觀測性（延續 GAS「TG 訊號」日誌）

事件格式沿用：`時間 / 等級 / 來源 / 事件 / 說明(JSON) / 耗時(ms) / 事件ID`。已知事件名：`webhook_rejected`、`executor_pending`、`executor_rejected`、`tradingview_signal_sent`、`broadcast_sent`、`chart_image_ok`、`chart_image_failed`、`duplicate_telegram_update_ignored`；Python 新增事件需沿用 `snake_case`。
v1：寫入 Volume 上的 `events.jsonl`（輪轉）＋ stdout；提供 `GET /events?limit=`（需 control key）。第二批：批次寫 Google Sheets（失敗不影響主流程）。
告警：未捕捉例外、對帳連續失敗、Telegram 連續送不出、`run_timeout`／`gate_timeout`，皆送 Telegram。外部以 `/health` 做存活監控。
`notify.send`：3 次嘗試，間隔 1s、3s；4xx（非 429）不重試；429 依 `retry_after`；逾時 10s；失敗只記錄、不中斷主流程。

---

## 13. 驗收與切換

1. 階段 1–4：每支純函式模組通過對應向量檔，**0 失敗**。
2. 階段 5：Python 以 `DRY_RUN=true` 影子運行，與 Node 並行收同一批訊號，比對決策與倉位數字。
3. 切換順序：Node 改 `DRY_RUN=true`（單一寫入者）→ Python 取得相同 Volume 狀態 → 先 DEMO 再實盤 → 觀察一個交易日 → 再退役 Node。
4. 切換期間**不得 git push 觸發 Zeabur 自動重新部署**未經確認的版本。
