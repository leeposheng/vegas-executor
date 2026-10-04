'use strict';
/**
 * HTTP 入口（零依賴，使用 node:http）。
 *
 * 端點：
 *   GET  /health              健康檢查與目前狀態
 *   POST /signal              接收訊號（需 X-Executor-Key）
 *   POST /control/halt        停止下單（需 X-Control-Key）
 *   POST /control/resume      恢復下單（需 X-Control-Key）
 *   GET  /positions           目前登記的部位（需 X-Control-Key）
 *   GET  /control/whoami      本機對外 IP（填交易所白名單用，需 X-Control-Key）
 *
 * 安全設計：
 * 1. 訊號金鑰與控制金鑰分開。訊號金鑰會存在 Apps Script 裡，
 *    萬一外流，攻擊者也不能用它解除 kill switch。
 * 2. 金鑰放 HTTP 標頭而非 query string，不會進入反向代理的存取日誌。
 * 3. 常數時間比對，避免計時攻擊。
 * 4. body 有大小上限，避免記憶體被撐爆。
 */

const http = require('http');
const crypto = require('crypto');
const { config, validate } = require('./config');
const { Store } = require('./store');
const { handleSignal, confirmSignal, skipSignal, orderGate } = require('./executor');
const symbols = require('./symbols');
const risk = require('./risk');
const okx = require('./exchanges/okx');
const bingx = require('./exchanges/bingx');
const notify = require('./notify');
const { reconcileOnce, renderClosedCard, renderReleasedCard, dailySummary } = require('./reconcile');
const instruments = require('./instruments');

const MAX_BODY_BYTES = 16 * 1024;

function safeEquals(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) {
    // 長度不同時仍走一次比對，避免以長度洩漏資訊
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload 過大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 跑一輪對帳，並把結果推播出去。
 *
 * 三個設計決定：
 *
 * 1. 永不拋例外。對帳跑在定時器上，沒有人接住錯誤 ——
 *    一次未捕捉的例外會讓整個行程掛掉，而下單服務也就跟著沒了。
 *    附加功能不能拖垮核心功能，跟取圖失敗那裡是同一條原則。
 *
 * 2. dryRun 下不跑。那時候根本沒有真實部位，去查交易所只會得到
 *    「查不到平倉紀錄」的告警，把日誌灌滿沒有意義的噪音。
 *
 * 3. 每一筆平倉都推播。自動模式下你不在迴圈裡，
 *    這則訊息是你唯一會知道「那筆交易結束了、結果如何」的管道。
 */
const EXCHANGE_MODULES = { okx, bingx };

async function runReconcile(store, trigger) {
  if (config.dryRun) {
    return { skipped: 'dryRun 下沒有真實部位，不對帳' };
  }
  const exchanges = (config.exchanges && config.exchanges.length)
    ? config.exchanges : [config.primaryExchange];

  // 每家各跑一輪，結果合併。
  //
  // 一家失敗不影響另一家 —— 這與下單那邊是同一條原則：
  // BingX 限流不該讓 OKX 的部位無人結算。
  const rounds = [];
  for (const ex of exchanges) {
    rounds.push(await runReconcileFor(store, trigger, ex));
  }
  if (rounds.length === 1) return rounds[0];
  return {
    perExchange: rounds,
    closed: rounds.flatMap((r) => r.closed || []),
    resolvedIntents: rounds.flatMap((r) => r.resolvedIntents || []),
    orphans: rounds.flatMap((r) => r.orphans || []),
    errors: rounds.flatMap((r) => (r.errors || []).map((e) => `[${r.exchange}] ${e}`)),
  };
}

async function runReconcileFor(store, trigger, exName) {
  const mod = EXCHANGE_MODULES[exName];
  if (!mod || typeof mod.fetchPositions !== 'function') {
    return { exchange: exName, closed: [], errors: [`${exName} 沒有可用的對帳實作`] };
  }
  try {
    // 對帳也要進同一條佇列。
    //
    // 它會呼叫 addPosition / removePosition / recordPnl —— 與下單路徑
    // 讀寫同一份狀態。跑在獨立的定時器上而不互斥的話，
    // 「補登部位」與「風控檢查」就可能交錯，等於替剛修好的 TOCTOU
    // 另外開了一個門。
    const r = await orderGate.run(
      () => reconcileOnce({ config, store, exchange: mod, exchangeName: exName }),
      '對帳 ' + exName
    );

    for (const c of r.closed) {
      const today = dailySummary(store);
      const text = renderClosedCard(c)
        + `\n[當日] ${today.realisedPnlUsdt >= 0 ? '+' : ''}`
        + `${today.realisedPnlUsdt.toFixed(2)} USDT（${today.orders} 筆）`;
      console.log('[對帳] ' + exName + ' ' + c.symbol + ' ' + c.reason
        + ' 損益 ' + c.pnlUsdt.toFixed(2) + ' USDT');
      await notify.send(text, config.telegram).catch((err) => {
        // 推播失敗不能讓損益漏記 —— 帳已經記進去了，這裡只是通知。
        console.warn('[對帳] 推播失敗：' + err.message);
      });
    }

    // 靠反查撿回來的單，一定要推播。
    //
    // 「下單當時以為失敗、其實成交了」是使用者最需要知道的一種狀態：
    // 他可能已經手動補了一單，那就變成雙倍部位。
    for (const it of (r.resolvedIntents || [])) {
      const head = it.outcome === 'filled' ? '⚠️ 補登部位' : 'ℹ️ 訂單結案';
      console.warn('[對帳] ' + exName + ' ' + head + ' ' + it.symbol + '：' + it.note);
      if (it.outcome === 'filled') {
        await notify.send(
          `${head}｜${it.symbol}\n─────────────\n`
          + `${it.note}\n成交均價 ${it.avgPx}　數量 ${it.qty} 張\n\n`
          + '⚠️ 若你當時以為沒成交而手動補過單，現在可能是雙倍部位，請去交易所確認。',
          config.telegram
        ).catch(() => {});
      }
    }

    // 逾時釋放的殘留紀錄。一定要推播：額度被放掉了、損益沒入帳，
    // 只寫日誌的話就會重演「系統說滿倉、交易所只有一個部位」卻沒人知道的情況。
    for (const rel of (r.released || [])) {
      console.warn('[對帳] ' + exName + ' 🧹 釋放殘留 ' + rel.kind + ' ' + rel.symbol + '：' + rel.note);
      await notify.send(renderReleasedCard(rel), config.telegram).catch(() => {});
    }

    // 孤兒倉：交易所有、系統沒有。只告警，不自動處理 ——
    // 那可能是你自己手動開的單，系統無權替它做決定。
    for (const o of (r.orphans || [])) {
      console.warn(`[對帳] ${exName} 孤兒倉 ${o.instId} ${o.pos} 張（未實現 ${o.upl}），系統無此紀錄`);
    }

    // 錯誤只在有內容時輸出。每分鐘印一次「沒事」會把日誌淹掉，
    // 真正需要注意的那一行反而看不見。
    for (const e of r.errors) console.warn('[對帳] ' + exName + ' ' + e);

    if (r.closed.length && store.isHalted() === false) {
      const today = dailySummary(store);
      if (-today.realisedPnlUsdt >= config.risk.dailyLossLimitUsdt) {
        // 風控閘門本來就會在下一筆訊號時擋下來，但那是「安靜地擋」。
        // 觸及上限是你會想立刻知道的事，不該等到下一筆訊號被拒才發現。
        await notify.send(
          `⛔ 當日已實現虧損 ${(-today.realisedPnlUsdt).toFixed(2)} USDT，`
          + `已達上限 ${config.risk.dailyLossLimitUsdt} USDT。\n`
          + '今日剩餘訊號都會被拒絕。', config.telegram
        ).catch(() => {});
      }
    }
    return r;
  } catch (err) {
    console.error('[對帳] ' + exName + ' ' + (trigger || '定時')
      + '執行失敗：' + err.message);
    return { exchange: exName, closed: [], errors: [err.message] };
  }
}

/**
 * 開機自檢。把「會讓下單失敗的帳戶設定」在啟動時就查清楚。
 *
 * 【為什麼非做不可】
 * 有兩個值不由設定檔決定，而是帳戶上的事實：
 *
 *   posMode  持倉模式。雙向持倉的帳戶下單必須帶 posSide，不帶就被退件。
 *            設定檔猜不到，只能問交易所。
 *   槓桿     .env 寫 LEVERAGE=40 不代表交易所那邊就是 40。
 *            不一致的話「固定保證金 100」這個前提整個是假的 ——
 *            算出來的名目與實際鎖的保證金差幾倍，而逐倉的爆倉距離跟著差。
 *
 * 兩者的共同點是：不自檢的話，要到真的下單那天才會發現，
 * 而那天你正在看盤、有一筆訊號剛進來。
 *
 * 【失敗時停止下單，但服務照常啟動】
 *
 * 直覺上「自檢失敗就 exit(1)」比較乾脆，但那在雲端平台上會出事：
 *
 *   1. 平台看到行程退出就重啟 → 又打一輪自檢 → 若失敗原因是限流，
 *      重啟只會讓限流更嚴重，迴圈自我維持。
 *   2. 更糟的是：服務起不來，對帳定時器就永遠不會建立。
 *      已經在場上的部位止損觸發後沒人結算、損益不入帳、
 *      未結案的意圖沒人反查 —— 偏偏這些正是最需要它的時候。
 *
 * 所以改成：自檢失敗 → 開啟 kill switch（一律拒絕下單）、照常啟動。
 * 連接埠開著、健康檢查看得到原因、對帳繼續跑。
 * 這比「乾脆地死掉」安全得多。
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function preflight(store) {
  if (config.dryRun) {
    console.log('[自檢] DRY_RUN 模式，略過交易所自檢');
    return { ok: true };
  }

  // BingX 的自檢獨立做。理由：兩家的失敗模式完全不同 ——
  // OKX 要確認持倉模式（決定帶不帶 posSide），BingX 要確認
  // 網域對不對、金鑰通不通。混在一起的話，一家掛了會拖垮另一家的判斷。
  let bingxReport = null;
  if (config.exchanges.includes('bingx')) {
    console.log('[自檢] BingX…');
    bingxReport = await bingx.preflight(config.bingx, { demo: config.demo });
    for (const c of bingxReport.checks) {
      console.log('[自檢]   ' + (c.ok ? '✓' : '✗') + ' ' + c.name + '：' + c.detail);
    }
    if (bingxReport.note) console.warn('[自檢]   ⚠️ ' + bingxReport.note);
    if (!bingxReport.ok) {
      const reason = 'BingX 自檢失敗：' + bingxReport.error;
      console.error('[自檢] ✗ ' + reason);
      store.setHalted(true, reason, 'preflight');
      return { ok: false, reason };
    }
  }

  if (!config.exchanges.includes('okx')) {
    console.log('[自檢] 未啟用 OKX，略過其帳戶自檢');
    return { ok: true, bingx: bingxReport };
  }

  console.log('[自檢] 正在向交易所查詢帳戶設定…');
  // 開機自檢只做兩件事：查帳戶設定、查權益。兩個請求。
  //
  // 不再逐一核對合約規格 —— 規格本來就是 instruments.js 用一次公開端點
  // 拿回來的，拿它跟自己比沒有意義。也不再逐一設槓桿（見 ensureLeverage），
  // 那是撞上 50011 限流的原因。
  //
  // 完整核對改由 npm run preflight 做，那是刻意執行的動作，
  // 慢一點、打多一點請求都沒關係。
  const report = await okx.preflight({
    leverage: config.risk.leverage,
    tdMode: config.okx.tdMode,
  }, config.okx, { demo: config.demo });

  // 把查到的持倉模式寫回設定。下單時會用到它決定要不要帶 posSide。
  //
  // 必須驗證它真的是那兩個值之一。fetchAccountConfig 取不到時回空字串，
  // 而空字串是 falsy —— 若只寫 `if (posMode)`，posMode 會靜靜留在 null，
  // 自檢還報成功，然後雙向持倉帳戶的每一筆單都被 51000 退件。
  // 那正是這支自檢存在的理由，不能讓它從自己的指縫溜走。
  const posMode = report.account && report.account.posMode;
  if (posMode === 'net_mode' || posMode === 'long_short_mode') {
    config.okx.posMode = posMode;
  } else {
    report.ok = false;
    report.errors.push(
      `無法取得持倉模式（收到「${posMode || '空值'}」）。`
      + '不知道是單向還是雙向持倉就不能安全下單 —— 雙向持倉必須帶 posSide。'
    );
  }

  for (const w of report.warnings) console.warn('[自檢] ⚠️ ' + w);

  if (!report.ok) {
    const reason = '開機自檢失敗：' + report.errors.join('；');
    report.errors.forEach((e) => console.error('[自檢] ✗ ' + e));
    console.error('[自檢] 服務照常啟動，但已開啟停止下單（kill switch）。'
      + '修好之後打 POST /control/resume 恢復。');
    store.setHalted(true, reason, 'preflight');
    return { ok: false, reason };
  }

  // 自檢通過了，就把「上一次自檢失敗」留下的停止解開。
  //
  // 人手動停的不碰 —— 那是你的決定，程式沒資格替你改。
  if (store.clearHaltIfFrom('preflight')) {
    console.log('[自檢] 先前因自檢失敗而停止下單，現在已自動解除');
  }
  console.log('[自檢] ✓ 帳戶模式 ' + (report.account.acctLvName || '?')
    + '｜持倉模式 ' + config.okx.posMode
    + '｜槓桿 ' + config.risk.leverage + 'x（於各合約首次下單前設定）');
  return { ok: true };
}

/**
 * 載入合約規格並安裝白名單。
 *
 * 必須在開機自檢之前做 —— 自檢會對白名單上的每個合約設定槓桿，
 * 而白名單還沒裝好的話它只會看到那幾個靜態項目。
 */
async function installSymbols() {
  const loaded = await instruments.load({
    baseUrl: config.okx.baseUrl,
    dataDir: config.dataDir,
  });
  console.log('[規格] ' + loaded.note);

  // BingX 的規格只有真的要用到時才去拿 —— 多一次外部呼叫，
  // 而只跑 OKX 的人不需要它。拿不到也不影響啟動。
  let bingxSpecs = null;
  if (config.exchanges.includes('bingx')) {
    try {
      bingxSpecs = await bingx.fetchAllContracts(config.bingx);
      console.log('[規格] 向 BingX 取得 ' + Object.keys(bingxSpecs).length + ' 個合約規格');
    } catch (err) {
      console.warn('[規格] BingX 合約查詢失敗：' + err.message + '，改用靜態值');
    }
  }

  const { installed, missing, missingBingx } = symbols.install({
    allowed: config.risk.allowedSymbols,
    specs: loaded.specs,
    bingxSpecs,
  });

  if (missing.length) {
    // 剔除不是錯誤，但一定要說出來 —— 否則你會以為某個標的在跑，
    // 而它的訊號其實一直被「不在白名單內」擋下。
    console.warn('[規格] 以下代碼在交易所找不到，已從白名單剔除（' + missing.length + ' 個）：');
    console.warn('        ' + missing.join('、'));
  }
  if (!installed.length) {
    throw new Error(
      '白名單是空的：ALLOWED_SYMBOLS 裡沒有任何代碼對得上交易所的合約。\n'
      + '這樣每一筆訊號都會被拒絕。請檢查代碼格式（要像 BTCUSDT.P）。'
    );
  }

  const fromStatic = installed.filter((s) => symbols.specSource(s) === 'static');
  if (fromStatic.length) {
    console.warn('[規格] 以下代碼用的是程式內建的靜態值，非交易所即時資料：'
      + fromStatic.join('、'));
  }
  // BingX 缺規格的代碼要單獨列出。
  // 它們在 OKX 仍可交易，但 BingX 那一側會拒單 —— 混在一起講
  // 會讓人以為整個代碼都不能用，然後去查錯的地方。
  if (config.exchanges.includes('bingx') && missingBingx.length) {
    console.warn('[規格] 以下代碼缺 BingX 規格，BingX 那一側會拒單（'
      + missingBingx.length + ' 個）：');
    console.warn('        ' + missingBingx.slice(0, 20).join('、')
      + (missingBingx.length > 20 ? ' …' : ''));
  }
  console.log('[規格] 白名單共 ' + installed.length + ' 個代碼可交易');
  return { installed, missing, missingBingx, source: loaded.source };
}

async function start() {
  validate();
  const store = new Store(config.dataDir);
  // 狀態檔與資金模式綁定，對不上就不啟動（見 store.bindMode）
  const bound = store.bindMode(config.demo ? 'demo' : 'live', config.instanceRole);
  if (!bound.ok) {
    throw new Error('狀態檔模式不符：' + bound.error);
  }
  const syms = await installSymbols();
  const pre = await preflight(store);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;

    try {
      // ---- 健康檢查 ----
      if (route === 'GET /health') {
        store.expirePendings();
        const today = store.today();
        return json(res, 200, {
          ok: true,
          mode: config.dryRun ? 'DRY_RUN' : (config.demo ? 'DEMO' : 'LIVE'),
          // Apps Script 的 testShadowConnection() 用這兩欄確認模擬服務真的是模擬盤
          role: config.instanceRole,
          demo: config.demo,
          stateMode: store.getMode(),
          executionMode: config.executionMode,
          exchange: config.primaryExchange,
          halted: store.isHalted(),
          haltedReason: store.haltedReason(),
          // 誰停的。preflight 的會在下次自檢通過時自動解除；
          // manual 的只能由人解除。
          haltedSource: store.haltedSource(),
          openPositions: store.openPositionCount(),
          // 未結案的下單意圖。正常情況恆為 0；不是 0 就代表有一筆
          // 「送出了但不知道結果」的單還在等對帳去查清楚。
          unconfirmedOrders: store.listIntents().length,
          pendingSignals: store.listPendings().length,
          today,
          supportedSymbols: symbols.listSupported(),
          // 規格是從交易所來的還是退路來的 —— 這會影響你該多相信倉位計算。
          // 'static' 代表那幾個用的是程式內建值，可能已與交易所不符。
          specSource: syms.source,
          droppedSymbols: syms.missing,
          // 對帳是否真的在跑，是「日損上限有沒有效」的前提。
          // 放進 /health，是為了不必翻日誌就能確認。
          reconcile: {
            enabled: !config.dryRun && config.reconcileSec > 0,
            everySec: config.reconcileSec,
            note: config.dryRun
              ? 'DRY_RUN 下停用 —— 沒有真實部位可對，日損上限也因此不會累積'
              : undefined,
          },
          risk: {
            pctPerTrade: config.risk.pctPerTrade,
            minGrade: config.risk.minGrade,
            allowedTimeframes: config.risk.allowedTimeframes,
            // 生效值（可能被 Telegram 調過），以及環境變數設的天花板
            maxConcurrent: risk.effectiveMaxConcurrent(store, config.risk),
            maxConcurrentCeiling: config.risk.maxConcurrentCeiling,
            dailyLossLimitUsdt: risk.effectiveDailyLossLimit(store, config.risk),
            dailyLossCeilingUsdt: config.risk.dailyLossCeilingUsdt,
          },
          // 日損重置的狀態。放進 /health 的理由與 reconcile 一樣：
          // 「今天已經重置過幾次」是判讀當日損益時必要的前提，
          // 少了它，-40 USDT 可能是真的 -40，也可能是 -140 重置兩次後的殘值。
          dailyReset: (() => {
            const info = store.dailyResetInfo();
            const cool = risk.resetCooldown(store, config.risk);
            return {
              count: info.count,
              limit: config.risk.dailyResetLimit,
              realisedPnlUsdt: Number(info.realisedPnlUsdt.toFixed(4)),
              effectivePnlUsdt: Number(info.effectivePnlUsdt.toFixed(4)),
              cooldownActive: cool.active,
              cooldownRemainMin: cool.remainMin,
            };
          })(),
        });
      }

      // ---- 訊號 ----
      if (route === 'POST /signal') {
        if (!safeEquals(req.headers['x-executor-key'], config.webhookSecret)) {
          console.warn('[http] /signal 金鑰驗證失敗');
          return json(res, 403, { ok: false, error: 'forbidden' });
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch (_) {
          return json(res, 400, { ok: false, error: 'invalid json' });
        }
        // Apps Script 轉給模擬服務的那一份帶 target:'shadow'。
        // 收到的服務若不是「模擬服務＋模擬盤」就拒收 —— 防的是模擬服務的網址
        // 日後被換成一個實盤、auto 的服務，於是每一筆訊號都變成真錢自動單。
        // 用 409 而不是 200：這不是風控決策，是接線錯誤，Apps Script 會記成 error。
        if (payload && payload.target === 'shadow'
            && !(config.instanceRole === 'shadow' && config.demo)) {
          console.error('[http] 拒收：這筆是轉給模擬服務的訊號，但本服務是 '
            + config.instanceRole + '／' + (config.demo ? '模擬盤' : '實盤'));
          return json(res, 409, {
            ok: false,
            error: 'target_mismatch',
            role: config.instanceRole,
            demo: config.demo,
          });
        }

        // notify:false 代表呼叫端（Apps Script）會自己發帶按鈕的 Telegram 卡片，
        // 執行層就不要再發一則，否則同一筆訊號會出現兩則推播。
        const suppressNotify = payload.notify === false;
        const result = await handleSignal(payload, { config, store, suppressNotify });
        console.log('[signal] ' + JSON.stringify({
          sigId: result.sigId,
          decision: result.decision,
          stage: result.stage,
          sent: result.sent,
          qty: result.sizing && result.sizing.orderQty,
          risk: result.sizing && result.sizing.actualRiskUsdt,
          reasons: result.reasons,
          elapsedMs: result.elapsedMs,
        }));

        // 一律回 200：這是「已收到並做出決策」，拒絕不是 HTTP 錯誤。
        // 回 4xx/5xx 會讓上游誤以為需要重送，反而製造重複訊號。
        return json(res, 200, {
          ok: true,
          decision: result.decision,
          sigId: result.sigId,
          reasons: result.reasons,
          sizing: result.sizing || null,
          // 區間拒絕時，卡片要畫得出「本來會是什麼樣子」與「為什麼不值得」。
          // 少了這三個欄位，拒絕卡片就只剩一句沒有數字的結論。
          band: result.band || null,
          preview: result.preview || null,
          // 超額進場的資訊。有值時卡片改成「🟡 已達持倉上限」並換按鈕文字。
          overLimit: result.overLimit || null,
          // 加倉資訊。有值時卡片改成「➕ 加倉機會」並換按鈕文字。
          addOn: result.addOn || null,
          // 權益來源要傳出去：卡片上的每個數字都是從它推出來的，
          // 它是查來的還是設定檔裡放著的，使用者有權知道。
          equity: result.equity || null,
          dryRun: config.dryRun,
        });
      }

      // ---- 確認與略過 ----
      //
      // 這兩個端點用訊號金鑰而非控制金鑰，因為呼叫者是 Apps Script，
      // 而它只持有訊號金鑰。值得注意的是：這代表訊號金鑰一旦外洩，
      // 對方不只能送假訊號，還能確認下單。實際損害受限於
      // 風險比例、名目上限與代碼白名單（最多一筆小倉位），
      // 但仍是實質的權限提升，所以每次確認都留下明確日誌。
      // 控制金鑰（緊急停止）維持獨立，外洩的那一把解除不了它。
      if (route === 'POST /confirm' || route === 'POST /skip') {
        if (!safeEquals(req.headers['x-executor-key'], config.webhookSecret)) {
          console.warn(`[http] ${route} 金鑰驗證失敗`);
          return json(res, 403, { ok: false, error: 'forbidden' });
        }
        const raw = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch (_) {
          return json(res, 400, { ok: false, error: 'invalid json' });
        }
        const sigId = String(payload.sig_id || payload.sigId || '').trim();
        if (!sigId) {
          return json(res, 400, { ok: false, error: 'sig_id required' });
        }

        const action = route === 'POST /confirm' ? 'confirm' : 'skip';
        const suppressNotify = payload.notify === false;
        const result = action === 'confirm'
          ? await confirmSignal(sigId, { config, store, suppressNotify })
          : await skipSignal(sigId, { config, store, suppressNotify });

        console.log(`[${action}] ` + JSON.stringify({
          sigId: result.sigId,
          decision: result.decision,
          sent: result.sent,
          qty: result.sizing && result.sizing.orderQty,
          reasons: result.reasons,
          elapsedMs: result.elapsedMs,
        }));

        return json(res, 200, {
          ok: true,
          decision: result.decision,
          sigId: result.sigId,
          reasons: result.reasons || [],
          sizing: result.sizing || null,
          // 漂移重算的結果必須回傳：使用者按下去時核准的是一組數字，
          // 實際送出的可能是另一組。不講，就是默默換掉了他核准的交易。
          drift: result.drift ? {
            verdict: result.drift.verdict,
            livePrice: result.drift.metrics && result.drift.metrics.livePrice,
            driftR: result.drift.metrics && result.drift.metrics.driftR,
            fromQty: result.drift.originalSizing && result.drift.originalSizing.orderQty,
            toQty: result.drift.resized && result.drift.resized.orderQty,
          } : null,
          dryRun: config.dryRun,
        });
      }

      // ---- 持倉上限 ----
      //
      // 【為什麼用訊號金鑰而不是控制金鑰】
      // 控制金鑰能解除 kill switch —— 那是「讓系統重新開始下單」的權力，
      // 刻意只放在你手上，不進 Apps Script。
      //
      // 調整持倉上限的破壞範圍已經被 MAX_CONCURRENT_CEILING 夾死了：
      // 就算訊號金鑰外流，對方最多把上限推到你在 Zeabur 設的那個數字，
      // 而那個數字只有能登入 Zeabur 的人改得到。
      //
      // 兩把金鑰分開的意義因此保住了：一把能在範圍內調整，一把能解除封鎖。
      if (route === 'GET /limits' || route === 'POST /limits') {
        if (!safeEquals(req.headers['x-executor-key'], config.webhookSecret)) {
          return json(res, 403, { ok: false, error: 'forbidden' });
        }
        const ceiling = config.risk.maxConcurrentCeiling;

        const lossCeiling = config.risk.dailyLossCeilingUsdt;
        const coolFloor = config.risk.dailyResetCooldownMin;

        if (route === 'POST /limits') {
          const raw = await readBody(req).catch(() => '');
          let body = {};
          try { body = JSON.parse(raw || '{}'); } catch (_) { /* ignore */ }

          // 一次呼叫只改一項。混在一起改會讓「哪一項被拒絕了」
          // 變成要靠回傳值推敲的事 —— 風控參數不該有這種模糊地帶。
          if (body.maxConcurrent !== undefined) {
            const wanted = Number(body.maxConcurrent);
            // 超出範圍就明確拒絕並說出可用範圍 —— 靜默夾成邊界值
            // 會讓人以為設成功了，而實際生效的是另一個數字。
            if (!Number.isInteger(wanted) || wanted < 1 || wanted > ceiling) {
              return json(res, 400, {
                ok: false,
                error: `maxConcurrent 必須是 1 到 ${ceiling} 之間的整數`,
                ceiling,
                note: '要超過這個範圍，請改 Zeabur 的 MAX_CONCURRENT_CEILING 環境變數。',
              });
            }
            store.setOverride('maxConcurrent', wanted);
            console.warn('[control] 持倉上限改為 ' + wanted);

          } else if (body.dailyLossLimit !== undefined) {
            const wanted = Number(body.dailyLossLimit);
            if (!Number.isFinite(wanted) || wanted < 10 || wanted > lossCeiling) {
              return json(res, 400, {
                ok: false,
                error: `dailyLossLimit 必須介於 10 與 ${lossCeiling} USDT 之間`,
                note: '要超過這個範圍，請改 Zeabur 的 DAILY_LOSS_CEILING_USDT 環境變數。',
              });
            }
            store.setOverride('dailyLossLimit', wanted);
            console.warn('[control] 日損上限改為 ' + wanted + ' USDT');

          } else if (body.resetCooldownMin !== undefined) {
            const wanted = Number(body.resetCooldownMin);
            // 下限而非上限：冷卻只能調長，不能調短。
            if (!Number.isInteger(wanted) || wanted < coolFloor || wanted > 720) {
              return json(res, 400, {
                ok: false,
                error: `resetCooldownMin 必須介於 ${coolFloor} 與 720 分鐘之間`,
                note: '冷卻只能調長不能調短。要調更短，請改 Zeabur 的 '
                  + 'DAILY_RESET_COOLDOWN_MIN —— 那是下限，不是預設值。',
              });
            }
            store.setOverride('resetCooldownMin', wanted);
            console.warn('[control] 重置冷卻改為 ' + wanted + ' 分鐘');

          } else {
            return json(res, 400, {
              ok: false,
              error: '沒有可辨識的參數（maxConcurrent／dailyLossLimit／resetCooldownMin）',
            });
          }
        }

        return json(res, 200, {
          ok: true,
          maxConcurrent: risk.effectiveMaxConcurrent(store, config.risk),
          ceiling,
          configured: config.risk.maxConcurrent,
          overridden: store.getOverride('maxConcurrent') !== undefined,
          openPositions: store.openPositionCount(),

          // 日損相關的三個數字。面板要一次畫完，就得一次拿到。
          dailyLossLimit: risk.effectiveDailyLossLimit(store, config.risk),
          dailyLossCeiling: lossCeiling,
          dailyLossConfigured: config.risk.dailyLossLimitUsdt,
          resetCooldownMin: risk.effectiveCooldownMin(store, config.risk),
          resetCooldownFloor: coolFloor,
          resetLimit: config.risk.dailyResetLimit,
        });
      }

      // ---- 日損上限：查詢與重置 ----
      //
      // 【為什麼用訊號金鑰而不是控制金鑰】
      // 呼叫端是 Apps Script，它只有訊號金鑰；控制金鑰能解除 kill switch，
      // 那個權力刻意不放進 Apps Script（金鑰外洩時它是最後一道防線）。
      //
      // 這樣做的代價要講清楚：訊號金鑰外洩的人可以把日損上限重置掉。
      // 但他最多只能重置 DAILY_RESET_LIMIT 次 —— 損害上限從
      // 「上限 × 1」變成「上限 ×（1＋次數）」，是有界的。
      // 而次數天花板只有 Zeabur 環境變數改得到。
      if (route === 'GET /daily' || route === 'POST /daily/reset') {
        if (!safeEquals(req.headers['x-executor-key'], config.webhookSecret)) {
          return json(res, 403, { ok: false, error: 'forbidden' });
        }
        const limit = config.risk.dailyResetLimit;
        const snapshot = () => {
          const info = store.dailyResetInfo();
          const cool = risk.resetCooldown(store, config.risk);
          return {
            ok: true,
            // 今天真正虧了多少。這個數字永遠不會被重置動到。
            realisedPnlUsdt: Number(info.realisedPnlUsdt.toFixed(4)),
            // 風控實際採計的數字（＝真實損益 − 重置基準）
            effectivePnlUsdt: Number(info.effectivePnlUsdt.toFixed(4)),
            dailyLossLimitUsdt: risk.effectiveDailyLossLimit(store, config.risk),
            blocked: -info.effectivePnlUsdt >= risk.effectiveDailyLossLimit(store, config.risk),
            resetCount: info.count,
            resetLimit: limit,
            resetsLeft: Math.max(0, limit - info.count),
            cooldownMin: risk.effectiveCooldownMin(store, config.risk),
            cooldownActive: cool.active,
            cooldownRemainMin: cool.remainMin,
            // 面板要畫出「可調範圍」，就得知道兩端的界線。
            // 上限管上界、冷卻管下界 —— 方向相反，因為風險的方向相反。
            dailyLossCeiling: config.risk.dailyLossCeilingUsdt,
            cooldownFloor: config.risk.dailyResetCooldownMin,
            orders: store.today().orders,
          };
        };

        if (route === 'GET /daily') return json(res, 200, snapshot());

        const raw = await readBody(req).catch(() => '');
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) { /* ignore */ }

        // 必須明確帶 confirm:true。重置是「把風控擋掉」，
        // 不該有任何一條路徑能靠一個空的 POST 就做到。
        if (body.confirm !== true) {
          return json(res, 400, { ok: false, error: 'need confirm:true', ...snapshot() });
        }
        if (limit <= 0) {
          return json(res, 400, {
            ok: false,
            error: '重置功能已關閉（DAILY_RESET_LIMIT=0）',
            ...snapshot(),
          });
        }

        const before = store.dailyResetInfo();
        if (before.count >= limit) {
          return json(res, 400, {
            ok: false,
            error: `今日已重置 ${before.count} 次，達上限 ${limit} 次。`
              + '要再放寬得改 Zeabur 的 DAILY_RESET_LIMIT —— 但今天的結論多半是收工。',
            ...snapshot(),
          });
        }
        // 沒超標就拒絕。否則一次誤觸會白白燒掉當天唯一的額度，
        // 而使用者要到真的需要時才會發現。
        if (-before.effectivePnlUsdt < risk.effectiveDailyLossLimit(store, config.risk)) {
          return json(res, 400, {
            ok: false,
            error: '目前未達日損上限，無須重置（額度留著）',
            ...snapshot(),
          });
        }

        const done = store.resetDailyLoss({ by: 'telegram', note: String(body.note || '') });
        // 這一行刻意用 warn：日損重置是整個系統裡最該被翻出來看的事件。
        console.warn('[control] 日損上限已重置 ' + JSON.stringify({
          第幾次: done.count,
          抹掉虧損: Number((-done.clearedUsdt).toFixed(2)),
          真實日損: Number((-before.realisedPnlUsdt).toFixed(2)),
          冷卻分鐘: risk.effectiveCooldownMin(store, config.risk),
        }));
        return json(res, 200, { ...snapshot(), clearedUsdt: done.clearedUsdt });
      }

      // ---- 待確認清單 ----
      if (route === 'GET /pending') {
        if (!safeEquals(req.headers['x-executor-key'], config.webhookSecret)) {
          return json(res, 403, { ok: false, error: 'forbidden' });
        }
        store.expirePendings();
        return json(res, 200, {
          ok: true,
          mode: config.executionMode,
          ttlSec: config.pendingTtlSec,
          pendings: store.listPendings().map((p) => ({
            sigId: p.sigId,
            status: p.status,
            expiresAt: p.expiresAt,
            symbol: p.signal && p.signal.symbol,
            side: p.signal && p.signal.side,
            grade: p.signal && p.signal.grade,
            entry: p.signal && p.signal.entry,
            sl: p.signal && p.signal.sl,
            orderQty: p.sizing && p.sizing.orderQty,
            riskUsdt: p.sizing && p.sizing.actualRiskUsdt,
          })),
        });
      }

      // ---- 控制 ----
      if (route.startsWith('POST /control/') || route === 'GET /positions'
          || route === 'GET /decisions' || route === 'GET /control/whoami') {
        if (!safeEquals(req.headers['x-control-key'], config.controlSecret)) {
          console.warn('[http] 控制端點金鑰驗證失敗');
          return json(res, 403, { ok: false, error: 'forbidden' });
        }
        if (route === 'POST /control/halt') {
          const raw = await readBody(req).catch(() => '');
          let reason = '手動停止';
          try { reason = (JSON.parse(raw || '{}').reason) || reason; } catch (_) { /* ignore */ }
          store.setHalted(true, reason, 'manual');
          console.warn('[control] 已停止下單：' + reason);
          return json(res, 200, { ok: true, halted: true, reason });
        }
        if (route === 'POST /control/resume') {
          store.setHalted(false);
          console.warn('[control] 已恢復下單');
          return json(res, 200, { ok: true, halted: false });
        }
        if (route === 'GET /control/whoami') {
          // 這台機器對外的 IP。交易所 API 金鑰的 IP 白名單要填的就是它 ——
          // 不是你家的 IP，也不是你瀏覽器看到的 IP，而是「執行層送出請求時」
          // 對方看到的來源位址。跑在雲端時兩者完全不同。
          //
          // 另一個用途是「量它穩不穩」：共享叢集的出口 IP 不保證固定，
          // 隔幾小時打一次，看數字會不會變，就知道能不能拿去填白名單。
          try {
            const r = await fetch('https://api.ipify.org?format=json');
            const body = await r.json();
            return json(res, 200, {
              ok: true,
              outboundIp: body.ip,
              checkedAt: new Date().toISOString(),
              note: '這是執行層對外的 IP。要拿它填交易所白名單之前，'
                + '請隔數小時重查幾次，確認它不會變。',
            });
          } catch (err) {
            return json(res, 200, {
              ok: false,
              error: '查詢失敗：' + err.message,
              note: '查不到不影響下單，這只是個診斷端點。',
            });
          }
        }
        if (route === 'GET /positions') {
          // intents 一起列出：它們也算進同時持倉數。只列 positions 的話，
          // 「上限顯示 5、清單只有 3 筆」會讓人以為計數壞了。
          return json(res, 200, {
            ok: true,
            positions: store.listPositions(),
            intents: store.listIntents(),
            counted: { okx: store.openPositionCount('okx'), bingx: store.openPositionCount('bingx') },
          });
        }
        if (route === 'POST /control/reconcile' || route === 'GET /control/reconcile') {
          // 手動觸發一輪對帳。定時器每分鐘也會跑，但要驗證設定、
          // 或剛手動平了倉想立刻結算時，等一分鐘很難受。
          const r = await runReconcile(store, '手動');
          return json(res, 200, { ok: true, reconcile: r, daily: dailySummary(store) });
        }
        if (route === 'GET /decisions') {
          // 按了什麼、略過什麼、什麼過期了 —— 檢討自主篩選價值的原始資料
          const limit = Number(url.searchParams.get('limit')) || 50;
          return json(res, 200, { ok: true, decisions: store.listDecisions(limit) });
        }
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      console.error('[http] ' + route + ' 失敗：' + err.message);
      return json(res, 500, { ok: false, error: 'internal error' });
    }
  });

  server.listen(config.port, () => {
    const mode = config.dryRun ? 'DRY_RUN（不會送出真實委託）'
      : config.demo ? 'DEMO（交易所模擬盤）' : '⚠️ LIVE（真實資金）';
    const decide = config.executionMode === 'manual' ? 'manual（一律等你確認）'
      : config.executionMode === 'auto' ? 'auto（通過閘門就下單）'
        : `by_grade（等級 ${config.autoGradeMin} 以上自動，其餘等確認）`;
    console.log('─'.repeat(56));
    console.log('維加斯執行服務已啟動');
    console.log('  服務角色    : ' + (config.instanceRole === 'shadow'
      ? 'shadow（模擬服務：只跑模擬盤，推播加「🧪 模擬服務」抬頭）'
      : 'live（主服務：Apps Script 的按鈕與面板連到這裡）'));
    console.log('  狀態檔      : ' + config.dataDir + '（' + (store.getMode() === 'live' ? '實盤' : '模擬盤') + '）');
    console.log('  連接埠      : ' + config.port);
    console.log('  執行模式    : ' + mode);
    console.log('  下單決策    : ' + decide);
    console.log('  確認時效    : ' + config.pendingTtlSec + ' 秒');
    console.log('  下單交易所  : ' + config.exchanges.join('、')
      + (config.exchanges.length > 1
        ? '（雙邊下單，曝險為單邊的 ' + config.exchanges.length + ' 倍）' : ''));
    console.log('  主要交易所  : ' + config.primaryExchange
      + (config.primaryExchange === 'okx' ? '（' + config.okx.tdMode + '）' : ''));

    // 橫幅只印「這個模式下真正生效」的參數。
    // 印出另一個模式的數字會讓人以為它有作用 —— 那比不印更糟。
    if (config.risk.sizingMode === 'fixed_margin') {
      const n = config.risk.fixedMarginUsdt * config.risk.leverage;
      console.log('  倉位模式    : fixed_margin（固定保證金）');
      console.log('  單筆保證金  : ' + config.risk.fixedMarginUsdt + ' USDT × '
        + config.risk.leverage + 'x = 名目 ' + n + ' USDT');
      console.log('  預估虧損    : ' + config.risk.lossMinUsdt + ' ～ '
        + config.risk.lossMaxUsdt + ' USDT（含來回手續費）');
      // 把「哪些止損距離會被接受」算出來 —— 那是這個模式實際的訊號篩選條件，
      // 比虧損區間本身更能預期今天會不會有單。
      const fee = config.risk.feeRateOneWay * 2;
      const lo = (config.risk.lossMinUsdt / n) - fee;
      const hi = (config.risk.lossMaxUsdt / n) - fee;
      console.log('  可接受止損  : ' + (lo * 100).toFixed(3) + '% ～ '
        + (hi * 100).toFixed(3) + '%');
    } else {
      console.log('  倉位模式    : risk_pct（風險反推）');
      console.log('  單筆風險    : ' + (config.risk.pctPerTrade * 100).toFixed(2) + '%');
    }
    console.log('  最低等級    : ' + config.risk.minGrade);
    console.log('  允許週期    : ' + config.risk.allowedTimeframes.join(', '));
    // 五十個代碼全印出來會把橫幅淹掉，而橫幅的價值在於一眼掃過。
    // 完整清單放在 /health，需要時再查。
    const all = symbols.listSupported();
    console.log('  支援代碼    : ' + all.length + ' 個（規格來源：'
      + (syms.source === 'exchange' ? '交易所即時'
        : syms.source === 'cache' ? '磁碟快取' : '靜態表') + '）');
    console.log('                ' + all.slice(0, 8).join(', ')
      + (all.length > 8 ? ' …完整清單見 /health' : ''));
    console.log('  對帳迴圈    : ' + (config.dryRun
      ? '停用（DRY_RUN 下無真實部位）'
      : '每 ' + config.reconcileSec + ' 秒'));
    if (!pre.ok) {
      console.log('─'.repeat(56));
      console.log('⛔ 自檢未通過，目前不會下任何單');
      console.log('   ' + pre.reason);
      console.log('   對帳仍在運作，已開的部位會繼續結算。');
      console.log('   修好之後：POST /control/resume');
    }
    console.log('─'.repeat(56));

    // ── 對外 IP ────────────────────────────────────────────
    //
    // 【為什麼要在開機時印】
    // 交易所的 API 金鑰 IP 白名單要填的就是這個數字，而它是
    // 「這台機器送出請求時對方看到的來源位址」—— 不是你家的 IP，
    // 也不是瀏覽器上查到的。跑在雲端時兩者完全不同。
    //
    // 原本只有 GET /control/whoami 查得到，而那支端點需要控制金鑰，
    // 也就是說要拿到這個數字，得先把最高權限的金鑰帶在手上敲一次 API。
    // 為了一個「公開查得到、也不敏感」的數字付這種代價並不合理。
    //
    // 印在開機日誌裡，翻一下 Zeabur 就有，不必帶任何金鑰。
    // 查失敗不影響任何功能 —— 這純粹是診斷資訊。
    fetch('https://api.ipify.org?format=json')
      .then((r) => r.json())
      .then((b) => {
        console.log('對外 IP：' + b.ip);
        console.log('  交易所 API 金鑰的 IP 白名單要填的就是這個。');
        console.log('  ⚠️ 填之前請隔幾小時重開一次服務、比對數字有沒有變 ——');
        console.log('     共享叢集的出口 IP 不保證固定，會變的話就不能拿來綁。');
        console.log('─'.repeat(56));
      })
      .catch((err) => {
        console.warn('對外 IP 查詢失敗：' + err.message
          + '（不影響下單，這只是診斷資訊）');
      });
  });

  // 對帳定時器。
  //
  // 用 setInterval 而非「每筆下單後排一次」：部位可能在任何時刻被平掉
  // （止損觸發、手動平倉、強平），那些時刻與我們的下單時間無關。
  // 唯一可靠的做法是固定節奏地去問交易所。
  //
  // unref() 讓這個計時器不會阻止行程正常結束 ——
  // 否則 SIGTERM 之後要等到下一次觸發才真的退出。
  let reconcileTimer = null;
  if (!config.dryRun && config.reconcileSec > 0) {
    let running = false;
    reconcileTimer = setInterval(() => {
      // 防重入：上一輪還沒跑完就不要再開一輪。
      // 交易所變慢時（限流、網路），重疊的查詢只會讓情況更糟。
      if (running) return;
      running = true;
      runReconcile(store, '定時').finally(() => { running = false; });
    }, config.reconcileSec * 1000);
    reconcileTimer.unref();
  }

  const shutdown = () => {
    console.log('\n收到關閉訊號，儲存狀態後結束。');
    if (reconcileTimer) clearInterval(reconcileTimer);
    store.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { server, store };
}

if (require.main === module) {
  // start() 現在是非同步的（開機自檢要連交易所），所以錯誤處理
  // 必須同時接住同步拋出與 Promise rejection 兩種 —— 只接一種的話，
  // 另一種會變成未捕捉的例外，印出一串堆疊而不是那幾行可讀的原因。
  try {
    const started = start();
    if (started && typeof started.catch === 'function') {
      started.catch(reportStartupFailure);
    }
  } catch (err) {
    reportStartupFailure(err);
  }
}

function reportStartupFailure(err) {
  {
    // 逐行輸出，不要依賴多行訊息。
    //
    // 雲端平台的日誌收集器常把一次多行寫入當成「一筆」，只保留第一行。
    // 而這裡的第一行是「設定驗證失敗：」—— 被吃掉的後面幾行才是
    // 「哪一項設定錯了」。少了細項，這則錯誤等於什麼都沒說。
    // 每行各發一次 console.error，任何收集器都吃得下。
    String(err && err.message ? err.message : err)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => console.error('[啟動失敗] ' + line));
    process.exit(1);
  }
}

module.exports = { start, safeEquals };
