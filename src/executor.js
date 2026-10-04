'use strict';
/**
 * 主流程編排。
 *
 * 這是整個系統的核心邏輯，刻意寫成一個「純粹的管線」：
 * 輸入是原始 payload，輸出是一個決策物件。它不碰 HTTP、不碰 process.exit，
 * 所有外部相依都從 ctx 傳入 —— 因此可以完整地單元測試，不必開伺服器、
 * 不必連交易所。自動交易系統最該被測試的就是這一段。
 *
 * ┌ 流程 ─────────────────────────────────────────────┐
 * │ 1. 解析與驗證訊號      signal.parseSignal          │
 * │ 2. 風控閘門            risk.evaluate               │
 * │ 3. 代碼對應            symbols.resolve             │
 * │ 4. 合約規格            靜態表或交易所公開端點       │
 * │ 5. 倉位計算            sizing.computeSize          │
 * │ ── 到這裡是「計畫」，以下才動到錢 ──                │
 * │ 6. 組單並簽章          exchanges/*.placeOrder      │
 * │ 7. 記錄、持久化、通知                               │
 * └───────────────────────────────────────────────────┘
 *
 * 第 1 到 5 步合稱 buildPlan：純計算，不改變任何狀態，也不下單。
 * 第 6 到 7 步是 placeFromPlan：真正送出委託。
 *
 * 兩者分開的用意是讓「算」與「下」可以錯開時間：
 *   auto 模式   —— 算完立刻下（原本的行為）
 *   manual 模式 —— 算完存成待確認，等你按下按鈕才呼叫 placeFromPlan
 * 同一份計算、同一套風控，差別只在中間有沒有插入一個人。
 */

const { parseSignal, clientOrderId } = require('./signal');
const risk = require('./risk');
const symbols = require('./symbols');
const { computeSize, computeFixedMargin } = require('./sizing');
const okx = require('./exchanges/okx');
const bingx = require('./exchanges/bingx');
const notify = require('./notify');
const { assessDrift } = require('./drift');
const { getEquity } = require('./equity');
const { Gate } = require('./serialize');

// 下單路徑的序列化閘。模組層級的單例 —— 整個行程共用一條佇列，
// 因為要保護的是「同一個交易所帳戶」這個唯一的共享資源。
//
// 涵蓋範圍是「風控檢查 → 下單 → 寫回 store」這整段。
// 只鎖下單那一步是不夠的：競態發生在檢查與寫回之間，不在下單本身。
const orderGate = new Gate({ maxWaitMs: 20000, maxRunMs: 30000 });

// ================================================================
// 第 1 到 5 步：把原始 payload 變成一份可執行的計畫
// ================================================================

/**
 * @returns {{ok:true, plan:object} | {ok:false, result:object}}
 */
async function buildPlan(rawPayload, ctx) {
  const { config, store } = ctx;
  const now = ctx.now || Date.now();
  // 雙邊下單時由呼叫端指定；沒指定就用主要交易所。
  const exchange = ctx.exchange || config.primaryExchange;

  const result = {
    at: new Date(now).toISOString(),
    decision: 'rejected',
    stage: 'parse',
    sigId: null,
    reasons: [],
  };

  // ---- 1. 解析與驗證 ----
  const parsed = parseSignal(rawPayload, {
    nowMs: now,
    maxAgeSec: config.risk.maxSignalAgeSec,
  });
  if (!parsed.ok) {
    result.reasons = parsed.errors;
    // 解析失敗「不」寫入 processed：payload 可能根本沒有可用的 sig_id，
    // 而且格式錯誤應該由送訊端修正後重送，不該被冪等擋住。
    return { ok: false, result };
  }
  const signal = parsed.signal;
  result.sigId = signal.sigId;
  result.signal = signal;

  // ---- 2. 風控閘門 ----
  result.stage = 'risk';
  const riskResult = risk.evaluate(signal, { store, risk: config.risk, exchange });
  result.gates = riskResult.gates;
  result.riskSummary = risk.summarise(riskResult);

  // 達持倉上限、而且只有這一道沒過：不直接拒絕，改走「超額進場」的待確認。
  // 後面的倉位計算照常進行 —— 卡片上要看得到這筆超額單的實際大小。
  const overLimit = riskResult.passed ? null
    : risk.overflowEligible(riskResult, store, config.risk, exchange);
  if (overLimit) result.overLimit = overLimit;

  if (!riskResult.passed && !overLimit) {
    result.reasons = riskResult.reasons;
    // 只有「非冪等」造成的拒絕才記為已處理。若是冪等本身擋下的，
    // 再寫一次只會覆蓋掉原本更有用的處理結果。
    const blockedByIdempotency = riskResult.gates
      .some((g) => g.name === 'idempotency' && !g.passed);
    if (!blockedByIdempotency) {
      store.markProcessed(signal.sigId, 'rejected', result.reasons.join('；'), exchange);
    }
    return { ok: false, result };
  }

  // ---- 3. 代碼對應 ----
  result.stage = 'symbol';
  const mapped = symbols.resolve(signal.symbol, exchange);
  if (!mapped.ok) {
    result.reasons = [mapped.error];
    store.markProcessed(signal.sigId, 'rejected', mapped.error, exchange);
    return { ok: false, result };
  }
  let spec = mapped.spec;
  result.spec = spec;

  // ---- 4. 合約規格 ----
  // 階段 0 用靜態表；階段 1 起把 refreshSpec 設為 true，改由交易所取得，
  // 並在數值與靜態表不一致時告警（代表交易所調整了合約規格）。
  result.stage = 'spec';
  if (config.refreshSpec) {
    try {
      const live = exchange === 'okx'
        ? await okx.fetchInstrument(spec.instId, config.okx)
        : await bingx.fetchContract(spec.symbol, config.bingx);
      const drift = Object.keys(live).filter(
        (k) => spec[k] !== undefined && Number(spec[k]) !== Number(live[k])
      );
      if (drift.length) {
        result.specDrift = drift.map((k) => `${k}: 靜態=${spec[k]} 實際=${live[k]}`);
      }
      spec = Object.assign({}, spec, live);
      result.spec = spec;
    } catch (err) {
      result.specWarning = `合約規格取得失敗，沿用靜態表：${err.message}`;
    }
  }

  // ---- 5. 倉位計算 ----
  result.stage = 'sizing';
  // 權益優先向交易所查，查不到才退回設定檔。來源一路帶到卡片上 ——
  // 使用者必須看得出「這個數字是查來的，還是設定檔裡放著的」。
  const equity = await getEquity(config, { demo: config.demo }, now);
  result.equity = equity;
  // 兩道名目上限取較嚴格者。把「是哪一道擋的」一起算出來，
  // 因為兩者的處置完全不同：撞到相對上限通常是止損太緊（該換週期），
  // 撞到絕對上限則是帳戶成長超過當初設定（該把天花板調高）。
  const notionalCap = resolveNotionalCap(config.risk, equity.equityUsdt);
  result.notionalCap = notionalCap;
  const sized = sizeFor(config, equity.equityUsdt, signal, spec, exchange, notionalCap);
  if (!sized.ok) {
    result.reasons = [sized.error];
    // 區間問題與其他錯誤要分開。前者是「這筆算得出來，但不值得做」，
    // 後者是「根本算不出來」。卡片上長得一樣的話，使用者會把兩件事
    // 當成同一種故障，然後對兩者都失去反應。
    if (sized.band) {
      result.band = sized.band;
      result.preview = sized.preview || null;
    }
    store.markProcessed(signal.sigId, 'rejected', sized.error, exchange);
    return { ok: false, result };
  }
  result.sizing = sized.sizing;

  // 階段 0 只掛 TP1。多段停利需要分批平倉的邏輯（把部位拆成三份，
  // 各自掛不同的 TP），留到階段 2 再處理 —— 一開始就做會讓
  // 對帳與部分成交的處理複雜度大幅上升。
  return {
    ok: true,
    plan: {
      signal,
      spec,
      sizing: sized.sizing,
      exchange,
      clientOrderId: clientOrderId(signal.sigId, 'vg'),
      tpUsed: signal.tp[0],
      tpDeferred: signal.tp.slice(1),
      gates: result.gates,
      riskSummary: result.riskSummary,
      specDrift: result.specDrift,
      specWarning: result.specWarning,
      equity: result.equity,
      notionalCap: result.notionalCap,
      overLimit: result.overLimit || null,
    },
  };
}

// ================================================================
// 第 6 到 7 步：真正送出委託
// ================================================================

/**
 * 依計畫下單。呼叫這個函式之前，狀態必須已經鎖定（auto 是同一次請求內，
 * manual 是先 claimPending），否則併發會造成重複下單。
 */
async function placeFromPlan(plan, ctx) {
  const { config, store } = ctx;
  const now = ctx.now || Date.now();
  const { signal, spec, sizing, exchange, clientOrderId: cloid } = plan;

  const result = {
    at: new Date(now).toISOString(),
    stage: 'order',
    sigId: signal.sigId,
    signal,
    spec,
    sizing,
    // 這兩個是「倉位是怎麼算出來的」的依據。下單成功的結果同樣需要它們，
    // 否則事後只看得到數量，看不出當時的本金與上限是什麼。
    equity: plan.equity,
    notionalCap: plan.notionalCap,
    gates: plan.gates,
    riskSummary: plan.riskSummary,
    clientOrderId: cloid,
    tpUsed: plan.tpUsed,
    tpDeferred: plan.tpDeferred,
    reasons: [],
  };

  const flags = { dryRun: config.dryRun, demo: config.demo };

  // 送出之前先把意圖寫到磁碟上。
  //
  // 順序是重點：如果寫在下單之後，那正是要防的那個窗口本身。
  // 這一筆讓對帳有東西可查 —— 沒有它，一筆「已成交但回應遺失」的單
  // 會完全不存在於系統中：額度沒扣、止損觸發時損益不入帳、
  // 而冪等紀錄還會擋住重送，連手動補救的路都封了。
  //
  // dryRun 下不寫：沒有真的送出請求，就沒有需要追查的東西。
  if (!config.dryRun) {
    store.recordIntent(signal.sigId, {
      clOrdId: cloid,
      instId: spec.instId,
      symbol: signal.symbol,
      side: signal.side,
      exchange,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      orderQty: sizing.orderQty,
      baseQty: sizing.baseQty,
    });
  }

  try {
    let placed;
    if (exchange === 'okx') {
      // 下單前確保這個合約的槓桿是設定值。同一個合約只會設一次。
      //
      // 失敗不擋下單：槓桿沒設成功，最壞的情況是用交易所的預設值，
      // 倉位大小與預期不符；而擋下來則是一筆合格的訊號完全錯過。
      // 兩害相權，但要說出來 —— 沉默地用錯的槓桿是最糟的那種。
      // dryRun 下不設：沒有真的要下單，卻會對交易所發出寫入請求。
      try {
        // 用「這一筆實際算出來的」槓桿，不是設定值 ——
        // 自動槓桿下兩者會不同，設錯的話交易所鎖的保證金與
        // 卡片上的名目對不起來，而且只有寬止損的訊號會出錯。
        if (!config.dryRun) await okx.ensureLeverage({
          instId: spec.instId,
          leverage: (sizing && sizing.leverage) || config.risk.leverage,
          tdMode: config.okx.tdMode,
          posMode: config.okx.posMode,
        }, config.okx, flags);
      } catch (err) {
        result.reasons.push(
          `⚠️ ${spec.instId} 槓桿設定失敗（${err.message}），`
          + `本筆使用交易所目前的槓桿，實際保證金可能與 ${config.risk.leverage}x 的預期不同。`
        );
      }
      placed = await okx.placeOrder({
        instId: spec.instId,
        side: signal.side,
        orderQty: sizing.orderQty,
        clOrdId: cloid,
        tdMode: config.okx.tdMode,
        // 持倉模式決定要不要帶 posSide。值由開機自檢向交易所查得並寫回設定 ——
        // 沒帶的話，雙向持倉的帳戶會讓每一筆下單都被 OKX 以 51000 退件，
        // 而且要到真的下單那天才會發現。
        posMode: config.okx.posMode,
        sl: signal.sl,
        tp: plan.tpUsed,
      }, config.okx, flags);
    } else {
      // BingX 也要先設槓桿。沒設的話會沿用帳戶上次留下的值，
      // 而固定保證金的名目是「保證金 × 槓桿」算出來的 ——
      // 兩邊對不上時，只有 BingX 那一側的倉位大小是錯的。
      //
      // 與 OKX 同樣的處置：失敗只警告不擋單。擋下來是讓一筆合格的
      // 訊號完全錯過，用錯槓桿是倉位大小不如預期 —— 後者可以事後修正。
      try {
        if (!config.dryRun) await bingx.ensureLeverage({
          symbol: spec.symbol,
          leverage: (sizing && sizing.leverage) || config.risk.leverage,
        }, config.bingx, flags);
      } catch (err) {
        result.reasons.push(
          `⚠️ ${spec.symbol} BingX 槓桿設定失敗（${err.message}），`
          + '本筆使用交易所目前的槓桿，實際倉位可能與預期不同。'
        );
      }
      placed = await bingx.placeOrder({
        symbol: spec.symbol,
        side: signal.side,
        orderQty: sizing.orderQty,
        clientOrderId: cloid,
        sl: signal.sl,
        tp: plan.tpUsed,
      }, config.bingx, flags);
    }

    result.decision = 'placed';
    result.sent = placed.sent;
    // 只保留不含密鑰的部分，避免把 API key 寫進日誌
    result.request = redactRequest(placed.request);
    result.response = placed.response;

    store.markProcessed(signal.sigId, placed.sent ? 'placed' : 'dry_run', cloid, exchange);
    store.recordOrder(now);
    // dryRun 下不登記部位：沒有真實部位，卻佔用「同時持倉上限」的額度，
    // 會讓階段 0 的測試在第 4 筆訊號後全部被擋下。
    if (placed.sent) {
      store.addPosition(signal.sigId, {
        symbol: signal.symbol,
        exchange,
        side: signal.side,
        entry: signal.entry,
        sl: signal.sl,
        tp: signal.tp,
        orderQty: sizing.orderQty,
        baseQty: sizing.baseQty,
        clientOrderId: cloid,
      });
    }
    // 有了部位紀錄，意圖就完成了它的任務
    store.clearIntent(signal.sigId, exchange);

    // ── 確認止損真的掛上去了 ─────────────────────────────
    //
    // 【為什麼不能相信下單回應】
    // attachAlgoOrds 是隨主單附掛的，而下單回應的 sCode=0 只代表
    // 「主單被接受」。附掛的那張保護單有沒有真的建立，回應裡看不出來。
    //
    // 差別有多大：40x 逐倉下止損距離 0.4%～1.0%，強平距離約 2.3%。
    // 止損在的時候永遠先觸發，你賠 20～45 USDT；止損不在的時候，
    // 你賠掉全部保證金 —— 而且要到強平那一刻才會知道它不在。
    //
    // 這一步刻意排在部位登記「之後」：查詢失敗不能讓一筆已經成交的
    // 單子變成沒有紀錄的孤兒。查不到只加警告，不改變決策。
    if (placed.sent && exchange === 'okx') {
      try {
        const guard = await okx.verifyProtection(
          { instId: spec.instId, sl: signal.sl }, config.okx, flags);
        result.protection = guard;
        if (!guard.ok) {
          // 這是整個流程裡最該吵的一則訊息。措辭刻意直白：
          // 使用者需要立刻知道「現在去交易所補一張止損」。
          const msg = `🚨 止損未掛上！${spec.instId} 目前是裸倉。`
            + `（${guard.note}）請立即到交易所手動補止損 ${signal.sl}。`;
          result.reasons.push(msg);
          console.error('[protect] ' + msg);
        } else if (guard.note) {
          result.reasons.push(`⚠️ ${guard.note}`);
        }
      } catch (err) {
        // 查不到 ≠ 沒有。網路錯誤時只能說「不確定」，
        // 不能宣稱裸倉 —— 假警報會訓練人忽略真警報。
        result.reasons.push(
          `⚠️ 無法確認止損是否掛上（${err.message}）。`
          + '請自行到交易所看一眼。'
        );
      }
    }
  } catch (err) {
    result.decision = 'error';
    result.reasons = [err.message];
    result.unconfirmed = true;
    // 下單「例外」最需要小心：請求可能已經送達交易所但回應遺失。
    //
    // 意圖刻意「不」清除 —— 它留在那裡，讓對帳迴圈用 clOrdId 去交易所
    // 反查這筆到底成交了沒。這是唯一能把「錢已經動了但系統不知道」
    // 這種狀態收回來的路徑。
    store.markProcessed(signal.sigId, 'error', err.message, exchange);
  }

  return result;
}

// ================================================================
// 入口一：收到訊號
// ================================================================

/**
 * @param {object} rawPayload  webhook 收到的 JSON
 * @param {object} ctx { config, store, now? }
 */
async function handleSignalInner(rawPayload, ctx) {
  const { config, store } = ctx;
  const now = ctx.now || Date.now();

  // 每次有請求進來就順手清掉過期的待確認訊號，
  // 不必額外跑一個排程，而且有人在看的時候狀態一定是準的。
  store.expirePendings(now);

  const exchanges = (config.exchanges && config.exchanges.length)
    ? config.exchanges : [config.primaryExchange];

  // 單一交易所時完全照舊，回傳值的形狀也不變 ——
  // 只有真的設了兩家才走聚合那條路。
  if (exchanges.length === 1) {
    return handleForExchange(rawPayload, ctx, exchanges[0]);
  }

  // ---- 雙邊下單 ----
  //
  // 刻意用循序而非 Promise.all：兩者共用同一份 store，
  // 而且都在同一條序列化佇列裡 —— 並行只會讓狀態寫入互相交錯，
  // 換不到任何速度（兩家的網路延遲本來就是各自獨立的）。
  //
  // 單邊失敗時另一邊照下（這是你選的處置）。所以每一家各自 try，
  // 一家的例外不會讓另一家連試都沒試。
  const results = [];
  for (const ex of exchanges) {
    try {
      results.push(await handleForExchange(rawPayload, ctx, ex));
    } catch (err) {
      results.push({
        at: new Date(now).toISOString(),
        decision: 'error', exchange: ex, sigId: rawPayload && rawPayload.sig_id,
        reasons: [err.message], unconfirmed: true,
      });
    }
  }
  return aggregateResults(results, exchanges, config, ctx);
}

/**
 * 把多家的結果聚成一個。
 *
 * 回傳值要同時服務兩個對象：Apps Script 畫卡片，以及日誌。
 * 所以主決策取「最樂觀的那個」（有一家下單成功就算 placed），
 * 而每一家的細節完整保留在 perExchange 裡 ——
 * 卡片必須講得出「哪一家成了、哪一家沒成」，那是雙邊下單最重要的資訊。
 */
function aggregateResults(results, exchanges, config, ctx) {
  const rank = { placed: 4, pending: 3, rejected: 2, error: 1, not_found: 0 };
  const best = results.reduce((a, b) =>
    (rank[b.decision] || 0) > (rank[a.decision] || 0) ? b : a);

  const placed = results.filter((r) => r.decision === 'placed');
  const failed = results.filter((r) => r.decision !== 'placed');

  const out = Object.assign({}, best, {
    exchanges,
    perExchange: results.map((r) => ({
      exchange: r.exchange,
      decision: r.decision,
      sizing: r.sizing,
      reasons: r.reasons,
      unconfirmed: r.unconfirmed,
    })),
    // 部分成功是雙邊下單特有的狀態，要能一眼看出來。
    // 沒有這個旗標的話，「兩家都成了」與「只成了一家」在卡片上長得一樣，
    // 而你的實際曝險差一倍。
    partial: placed.length > 0 && failed.length > 0,
  });

  if (out.partial) {
    out.reasons = (out.reasons || []).concat([
      `⚠️ 只有 ${placed.map((r) => r.exchange).join('、')} 成交；`
      + `${failed.map((r) => r.exchange + '（' + r.decision + '）').join('、')} 未成交。`
      + '實際曝險為預期的一半。',
    ]);
  }
  return out;
}

/** 針對單一交易所走完整條路徑。 */
async function handleForExchange(rawPayload, ctx, exchange) {
  const { config, store } = ctx;
  const now = ctx.now || Date.now();
  const started = Date.now();
  ctx = Object.assign({}, ctx, { exchange });

  const built = await buildPlan(rawPayload, ctx);
  if (!built.ok) {
    built.result.elapsedMs = Date.now() - started;
    built.result.exchange = exchange;
    await notifyDecision(built.result, config, exchange, ctx.suppressNotify);
    return built.result;
  }

  const plan = built.plan;

  // ---- 決定要直接下單還是等人確認 ----
  // 超額單一律等人確認，即使是 auto 模式 —— 超出上限是一個需要你
  // 逐筆同意的例外，不該由系統自己決定。
  const auto = !plan.overLimit && (config.executionMode === 'auto' ||
    (config.executionMode === 'by_grade' && plan.signal.grade >= config.autoGradeMin));

  if (auto) {
    const result = await placeFromPlan(plan, ctx);
    result.mode = config.executionMode;
    result.exchange = exchange;
    result.elapsedMs = Date.now() - started;
    await notifyDecision(result, config, plan.exchange, ctx.suppressNotify);
    return result;
  }

  // ---- manual：存成待確認，不下單 ----
  const expiresAt = new Date(now + config.pendingTtlSec * 1000).toISOString();
  store.addPending(plan.signal.sigId, {
    exchange,
    expiresAt,
    signal: plan.signal,
    spec: plan.spec,
    sizing: plan.sizing,
    exchange: plan.exchange,
    clientOrderId: plan.clientOrderId,
    tpUsed: plan.tpUsed,
    tpDeferred: plan.tpDeferred,
    gates: plan.gates,
    riskSummary: plan.riskSummary,
    // 權益一起存下來。確認時的重算必須用同一個基準，
    // 否則同一筆交易的兩次計算會出現無法解釋的差異。
    equity: plan.equity,
    notionalCap: plan.notionalCap,
    // 確認時要知道這筆是超額單，才會以硬上限重查持倉數
    overLimit: plan.overLimit || null,
  });
  // 標記為已處理，避免同一筆訊號重送時產生第二個待確認紀錄
  store.markProcessed(plan.signal.sigId, 'pending', plan.clientOrderId, plan.exchange);

  const result = {
    at: new Date(now).toISOString(),
    decision: 'pending',
    stage: 'pending',
    mode: config.executionMode,
    exchange,
    sigId: plan.signal.sigId,
    signal: plan.signal,
    spec: plan.spec,
    sizing: plan.sizing,
    gates: plan.gates,
    riskSummary: plan.riskSummary,
    clientOrderId: plan.clientOrderId,
    tpUsed: plan.tpUsed,
    tpDeferred: plan.tpDeferred,
    expiresAt,
    ttlSec: config.pendingTtlSec,
    overLimit: plan.overLimit || null,
    reasons: plan.overLimit
      ? [`已達持倉上限 ${plan.overLimit.maxNow}（目前 ${plan.overLimit.openCount} 筆），`
        + `按「超額進場」將開第 ${plan.overLimit.openCount + 1} 筆，硬上限 ${plan.overLimit.hardCap}`]
      : [],
    elapsedMs: Date.now() - started,
  };
  await notifyDecision(result, config, plan.exchange, ctx.suppressNotify);
  return result;
}

// ================================================================
// 入口二：按下「進場」
// ================================================================

/**
 * 取得現價。目前只有 OKX 有公開行情端點的實作；
 * BingX 尚未接上，因此回傳 null 由呼叫端判定為「無法驗證」。
 */
/** notionalCap 遺失時的保底（舊的待確認紀錄可能沒有這個欄位）。 */
function notionalCapFallback(config) {
  return { value: config.risk.maxNotionalUsdt, source: 'absolute', note: '絕對上限' };
}

/**
 * 依 SIZING_MODE 分派倉位計算。
 * 兩種模式的輸出欄位刻意對齊，下游（卡片、日誌、對帳）不必分兩套處理。
 */
function sizeFor(config, equityUsdt, signal, spec, exchange, notionalCap) {
  const r = config.risk;
  if (r.sizingMode === 'fixed_margin') {
    return computeFixedMargin({
      marginUsdt: r.fixedMarginUsdt,
      marginMaxUsdt: r.fixedMarginMaxUsdt,
      leverage: r.leverage,
      autoLeverage: r.autoLeverage,
      minLiqCushion: r.minLiqCushion,
      entry: signal.entry,
      sl: signal.sl,
      // 止盈傳進去只為了算「扣費後的損益比」—— 它不參與倉位計算，
      // 但沒有它，拒絕理由就只能說「虧損太小」，說不出「這筆划不划算」。
      tp: signal.tp,
      side: signal.side,
      spec,
      exchange,
      feeRateOneWay: r.feeRateOneWay,
      lossMinUsdt: r.lossMinUsdt,
      lossMaxUsdt: r.lossMaxUsdt,
      // 【這裡以前用絕對值，是錯的】
      // 自動模式下名目上限會直接參與槓桿求解，所以必須是「生效值」——
      // 權益倍數與絕對值取嚴格者。用絕對值的話，小帳戶會算出一個
      // 遠超過權益倍數的名目，然後在外層被另一道檢查擋掉，
      // 而錯誤訊息會說「名目超過上限」，看起來像參數設錯。
      maxNotionalUsdt: notionalCap.value,
      equityUsdt,
    });
  }
  return computeSize({
    equityUsdt,
    riskPct: r.pctPerTrade,
    entry: signal.entry,
    sl: signal.sl,
    spec,
    exchange,
    leverage: r.leverage,
    maxNotionalUsdt: notionalCap.value,
    maxNotionalNote: notionalCap.note,
  });
}

/**
 * 生效的名目上限：絕對值與「權益倍數」取較嚴格者。
 * 回傳 note 是為了讓拒單訊息能講出「是哪一道擋的」——
 * 兩者的處置不同，混在一起等於沒說。
 */
function resolveNotionalCap(risk, equityUsdt) {
  const absolute = risk.maxNotionalUsdt;
  const mult = risk.maxNotionalMult === undefined ? 3 : risk.maxNotionalMult;
  const relative = equityUsdt * mult;
  if (relative < absolute) {
    return {
      value: relative,
      source: 'mult',
      note: `權益 ${equityUsdt.toFixed(0)} × ${mult} 倍`,
    };
  }
  return { value: absolute, source: 'absolute', note: 'MAX_NOTIONAL_USDT 絕對上限' };
}

async function fetchLivePrice(pending, config) {
  if (pending.exchange === 'bingx') {
    const sym = pending.spec.symbol || pending.spec.instId;
    const t = await bingx.fetchTicker(sym, config.bingx);
    return t.last;
  }
  const t = await okx.fetchTicker(pending.spec.instId, config.okx);
  return t.last;
}

async function confirmSignalInner(sigId, ctx) {
  const { config, store } = ctx;
  const now = ctx.now || Date.now();
  const started = Date.now();
  const exchange = ctx.exchange;

  store.expirePendings(now);

  const pending = store.getPending(String(sigId || ''), exchange);
  if (!pending) {
    // 找不到待確認紀錄的原因不只一種，而處置完全不同：
    //   已經下單了     → 你按了兩次，第二次沒事，不必再做什麼
    //   過期或已略過   → 那筆機會沒了
    //   sig_id 有誤    → 是呼叫端的問題
    // 一律回「找不到」等於把三件事講成同一件。
    //
    // 這條路徑在下單路徑序列化之後變得常見：重複點擊的第二次，
    // 現在是排隊等第一次做完，所以看到的是「已經處理完」的狀態，
    // 而不是「正在處理中」。
    // 只有「真的送過單」才算重複點擊。expired 與 skipped 也會寫進
    // processed，但那是機會沒了，不是你按了兩次 —— 講成同一件事
    // 會讓人以為單已經下了。
    const done = store.getProcessed(String(sigId || ''), exchange);
    const attempted = done
      && ['placed', 'dry_run', 'error'].includes(done.outcome);
    const explain = attempted
      ? `這筆已經送出過了（${done.outcome}），不需要再按一次`
      : '找不到這筆待確認訊號，可能已過期、已略過，或 sig_id 有誤';
    return {
      at: new Date(now).toISOString(),
      decision: attempted ? 'already_handling' : 'not_found',
      sigId: sigId || null,
      priorOutcome: done ? done.outcome : null,
      reasons: [explain],
      elapsedMs: Date.now() - started,
    };
  }

  // 併發保護：在任何 await 之前就同步搶下狀態。
  // 第二個請求（重複點擊、Telegram 重送 callback）會在這裡被擋住。
  if (!store.claimPending(sigId, exchange)) {
    return {
      at: new Date(now).toISOString(),
      decision: 'already_handling',
      sigId,
      reasons: [`這筆訊號目前狀態為 ${pending.status}，不再受理確認`],
      elapsedMs: Date.now() - started,
    };
  }

  // 按下按鈕的當下重查會變動的閘門
  const re = risk.recheck(pending.signal, { store, risk: config.risk, exchange: pending.exchange },
    { allowOverflow: Boolean(pending.overLimit) });
  if (!re.passed) {
    store.resolvePending(sigId, 'skipped', '確認時風控未通過：' + re.reasons.join('；'), exchange);
    const result = {
      at: new Date(now).toISOString(),
      decision: 'rejected',
      stage: 'recheck',
      sigId,
      signal: pending.signal,
      sizing: pending.sizing,
      gates: re.gates,
      riskSummary: risk.summarise(re),
      reasons: re.reasons,
      elapsedMs: Date.now() - started,
    };
    await notifyDecision(result, config, pending.exchange, ctx.suppressNotify);
    return result;
  }

  // ---- 進場價漂移檢查 ----
  //
  // 只在這裡做，不在訊號剛進來時做：訊號產生的當下，現價就是 entry，
  // 沒有漂移可言。漂移是「卡片躺在手機上那幾十秒」累積出來的，
  // 也就是說，它是按鈕確認這個功能自己製造出來的風險。
  let drift = null;
  let sizingToUse = pending.sizing;
  // 用 !== false 而不是真值判斷：任何沒有明確關閉的設定都要執行檢查。
  // 一道「欄位漏掉就自動停用」的安全檢查，等於沒有這道檢查 ——
  // 而且它會在最不該出錯的地方無聲地放行。
  if (config.risk.driftCheck !== false) {
    try {
      const live = await fetchLivePrice(pending, config);
      drift = assessDrift({
        signal: pending.signal,
        livePrice: live,
        limits: {
          maxWiden: config.risk.driftMaxWiden,
          maxTighten: config.risk.driftMaxTighten,
        },
      });
    } catch (err) {
      drift = {
        ok: false, verdict: 'no_price', metrics: {},
        reason: '無法取得現價（' + err.message + '），拒絕下單。'
          + '以無法驗證的價格計算倉位，正是這道檢查要防的事。',
      };
    }

    if (!drift.ok) {
      store.resolvePending(sigId, 'skipped', '進場價漂移：' + drift.reason, exchange);
      const rejected = {
        at: new Date(now).toISOString(),
        decision: 'rejected',
        stage: 'drift',
        sigId,
        signal: pending.signal,
        sizing: pending.sizing,
        gates: pending.gates,
        riskSummary: pending.riskSummary,
        drift,
        reasons: [drift.reason],
        elapsedMs: Date.now() - started,
      };
      await notifyDecision(rejected, config, pending.exchange, ctx.suppressNotify);
      return rejected;
    }

    // 通過檢查 → 以現價重算倉位，讓實際風險回到預算。
    // 放行原數量等於默默接受超額風險；重算才是真的把風險控制住。
    if (drift.verdict === 'resize') {
      // 用與當初相同的權益基準重算。這裡刻意不重查 ——
      // 同一筆交易的兩次計算若用了不同的本金，差異會變得無法解釋。
      const eq2 = (pending.equity && pending.equity.equityUsdt)
        || config.risk.equityUsdt;
      const re2 = sizeFor(config, eq2,
        Object.assign({}, pending.signal, { entry: drift.metrics.livePrice }),
        pending.spec, pending.exchange, pending.notionalCap || notionalCapFallback(config));
      if (!re2.ok) {
        store.resolvePending(sigId, 'skipped', '以現價重算倉位失敗：' + re2.error, exchange);
        const rejected = {
          at: new Date(now).toISOString(),
          decision: 'rejected',
          stage: 'drift_resize',
          sigId,
          signal: pending.signal,
          sizing: pending.sizing,
          drift,
          reasons: [re2.error],
          elapsedMs: Date.now() - started,
        };
        await notifyDecision(rejected, config, pending.exchange, ctx.suppressNotify);
        return rejected;
      }
      drift.originalSizing = pending.sizing;
      drift.resized = re2.sizing;
      sizingToUse = re2.sizing;
    }
  }

  let result;
  try {
    result = await placeFromPlan({
      signal: pending.signal,
      spec: pending.spec,
      sizing: sizingToUse,
      exchange: pending.exchange,
      clientOrderId: pending.clientOrderId,
      tpUsed: pending.tpUsed,
      tpDeferred: pending.tpDeferred,
      gates: pending.gates,
      riskSummary: pending.riskSummary,
    }, ctx);
  } catch (err) {
    // placeFromPlan 內部已經接住下單例外，走到這裡代表更底層的問題。
    // 狀態放回 pending，讓使用者可以再按一次。
    store.releasePending(sigId, exchange);
    return {
      at: new Date(now).toISOString(),
      decision: 'error',
      sigId,
      reasons: [err.message],
      elapsedMs: Date.now() - started,
    };
  }

  store.resolvePending(sigId, result.decision === 'placed' ? 'placed' : 'error',
    result.reasons.join('；'), exchange);
  result.confirmedByUser = true;
  if (drift) result.drift = drift;
  if (pending.equity) result.equity = pending.equity;
  result.elapsedMs = Date.now() - started;
  await notifyDecision(result, config, pending.exchange, ctx.suppressNotify);
  return result;
}

// ================================================================
// 入口三：按下「略過」
// ================================================================

/**
 * 略過也要留紀錄。這一筆資料的價值在三個月後才會顯現：
 * 沒有它，就無法回答「那些我沒按的訊號，按了會賺還是賠」，
 * 也就無從判斷自主篩選到底是加分還是扣分。
 */
async function skipSignal(sigId, ctx) {
  const { config, store } = ctx;
  const now = ctx.now || Date.now();

  store.expirePendings(now);

  // 略過是一次略過全部 —— 雙邊下單時兩家各有一筆待確認，
  // 只略過一家會留下一個孤兒 pending，過期之後才消失。
  const all = store.pendingsForSignal(String(sigId || ''));
  if (!all.length) {
    return {
      at: new Date(now).toISOString(),
      decision: 'not_found',
      sigId: sigId || null,
      reasons: ['找不到這筆待確認訊號，可能已過期或已處理'],
    };
  }
  const pending = all[0];
  if (pending.status !== 'pending') {
    return {
      at: new Date(now).toISOString(),
      decision: 'already_handling',
      sigId,
      reasons: [`這筆訊號目前狀態為 ${pending.status}`],
    };
  }

  for (const p of all) store.resolvePending(sigId, 'skipped', '使用者略過', p.exchange);
  store.markProcessed(sigId, 'skipped', '使用者略過');

  const result = {
    at: new Date(now).toISOString(),
    decision: 'skipped',
    sigId,
    signal: pending.signal,
    sizing: pending.sizing,
    reasons: [],
  };
  await notifyDecision(result, config, pending.exchange, ctx.suppressNotify);
  return result;
}

// ================================================================
// 共用
// ================================================================

/** 移除請求中的金鑰，讓決策物件可以安全地寫入日誌。 */
function redactRequest(req) {
  if (!req) return null;
  const headers = Object.assign({}, req.headers);
  for (const k of Object.keys(headers)) {
    if (/key|sign|passphrase|apikey/i.test(k)) headers[k] = '[REDACTED]';
  }
  const out = Object.assign({}, req, { headers });
  if (out.url) out.url = String(out.url).replace(/signature=[^&]+/i, 'signature=[REDACTED]');
  return out;
}

/**
 * @param {boolean} [suppress] Apps Script 轉送時會帶 notify:false，表示
 *   「Telegram 那一則由我來發」。因為帶按鈕的卡片必須由 Apps Script 送出
 *   （按鈕的 callback 會回到它的 webhook），兩邊都發就會變成重複推播。
 *   直接呼叫執行層時（手動測試）不帶這個欄位，照常通知。
 */
async function notifyDecision(result, config, exchange, suppress) {
  if (suppress) return;
  if (!result.signal) return;   // 解析失敗的 payload 不推播，避免被雜訊灌爆
  const text = notify.renderDecision({
    signal: result.signal,
    decision: result.decision,
    sizing: result.sizing,
    riskSummary: result.riskSummary,
    reasons: result.reasons,
    dryRun: config.dryRun,
    demo: config.demo,
    exchange,
    expiresAt: result.expiresAt,
    ttlSec: result.ttlSec,
    confirmedByUser: result.confirmedByUser,
  });
  await notify.send(text, config.telegram);
}

/**
 * 把排隊逾時包成一個正常的決策結果，而不是讓例外往上冒到 HTTP 500。
 *
 * 差別在於使用者看到什麼：500 只說「內部錯誤」，
 * 而這裡會說清楚是「前一筆卡住、這一筆被拒絕」—— 那是完全不同的處置。
 */
function gateRejection(err, sigId, now) {
  return {
    at: new Date(now).toISOString(),
    decision: 'rejected',
    stage: 'gate',
    sigId: sigId || null,
    reasons: [err.message],
    gateTimeout: true,
    // run_timeout 與 gate_timeout 的處置完全不同：
    //   gate_timeout 這筆沒送出去，放掉就好
    //   run_timeout  這筆可能已經送到交易所了，必須去確認
    // 混成一個旗標等於把「安全」和「可能已下單」講成同一件事。
    unconfirmed: err.code === 'run_timeout',
  };
}

/** 兩種逾時都要攔下來轉成決策，否則使用者只會看到 HTTP 500。 */
function isGateError(err) {
  return err && (err.code === 'gate_timeout' || err.code === 'run_timeout');
}

/**
 * 訊號入口。整條路徑序列化 —— 理由見 serialize.js。
 *
 * 包在外層而不是只包 placeFromPlan：競態發生在「風控檢查」與
 * 「寫回 store」之間，只鎖下單那一步擋不住。
 */
async function handleSignal(rawPayload, ctx) {
  const now = (ctx && ctx.now) || Date.now();
  const config = (ctx && ctx.config) || {};
  try {
    return await orderGate.run(() => handleSignalInner(rawPayload, ctx), '訊號處理');
  } catch (err) {
    if (!isGateError(err)) throw err;
    const result = gateRejection(err, rawPayload && rawPayload.sig_id, now);
    // 被佇列擋下的訊號也要推播。
    //
    // 自動模式下你不在迴圈裡，這則訊息是你唯一會知道「有一筆訊號來了、
    // 但因為前一筆卡住而沒有處理」的管道。只寫進日誌等於無聲消失，
    // 而那正是序列化這件事本身要避免的後果。
    if (!ctx.suppressNotify) {
      await notify.send(
        '⛔ 訊號未處理｜' + (rawPayload && rawPayload.symbol ? rawPayload.symbol : '未知代碼')
        + '\n─────────────\n' + err.message
        + (result.unconfirmed
          ? '\n\n⚠️ 這筆可能已經送到交易所，請去確認是否已成交。' : ''),
        config.telegram
      ).catch(() => {});
    }
    return result;
  }
}

/**
 * 按鈕確認入口。與訊號共用同一條佇列 —— 兩者搶的是同一個帳戶額度。
 *
 * 雙邊下單時同一筆訊號在兩家各有一筆待確認，而 Telegram 上只有一個按鈕。
 * 所以一次按下＝兩家都確認。分開兩個按鈕會讓「只按了一個」變成常態，
 * 而那時你的曝險是預期的一半，卡片上卻看不出來。
 */
async function confirmSignal(sigId, ctx) {
  const now = (ctx && ctx.now) || Date.now();
  const store = ctx && ctx.store;
  const pendings = (store && store.pendingsForSignal)
    ? store.pendingsForSignal(String(sigId || '')) : [];

  // 沒有或只有一筆時走原本的路徑，回傳形狀完全不變
  if (pendings.length <= 1) {
    const ex = pendings.length ? pendings[0].exchange : (ctx && ctx.exchange);
    try {
      return await orderGate.run(
        () => confirmSignalInner(sigId, Object.assign({}, ctx, { exchange: ex })),
        '確認下單');
    } catch (err) {
      if (isGateError(err)) return gateRejection(err, sigId, now);
      throw err;
    }
  }

  const results = [];
  for (const p of pendings) {
    try {
      results.push(await orderGate.run(
        () => confirmSignalInner(sigId, Object.assign({}, ctx, { exchange: p.exchange })),
        '確認下單 ' + p.exchange));
    } catch (err) {
      if (isGateError(err)) results.push(gateRejection(err, sigId, now));
      else results.push({
        at: new Date(now).toISOString(), decision: 'error',
        exchange: p.exchange, sigId, reasons: [err.message], unconfirmed: true,
      });
    }
  }
  return aggregateResults(results, pendings.map((p) => p.exchange),
    ctx.config, ctx);
}

module.exports = {
  handleSignal, confirmSignal, skipSignal,
  buildPlan, placeFromPlan, redactRequest,
  orderGate,
};
