'use strict';
/**
 * 對帳迴圈。
 *
 * 【它解決什麼】
 * 下單之後，系統就再也不知道那筆交易後來怎麼了。止損止盈是隨單附掛在
 * 交易所那側的，觸發時沒有人通知我們。結果是：
 *   - store 裡的部位永遠不會消失，「同時持倉上限」會被幽靈部位佔滿
 *   - recordPnl 從來沒被呼叫，DAILY_LOSS_LIMIT 這道閘門形同虛設
 *   - 沒有任何勝率或損益資料可以回頭檢討
 *
 * 【方向】
 * 這支不處理訊號。它的輸入是「交易所現在的狀態」，跟 TradingView 無關。
 * 因此它可以在沒有任何訊號的情況下單獨測試 —— 手動在模擬盤開一個部位，
 * 它就會看到。
 *
 * 【核心原則：交易所是唯一事實來源】
 * 本地 store 記的是「我們以為」的狀態，可能因為當機、重啟、手動干預而失準。
 * 對帳永遠以交易所的回應為準，本地紀錄只用來決定「該去查哪些合約」。
 */

const symbols = require('./symbols');

/** 剛下單的部位需要一段寬限期才能判定為「已平倉」。 */
const OPEN_GRACE_MS = 90 * 1000;

/** 比對開倉時間的容忍值。交易所的開倉時間與我們寫入的時刻本就有落差。 */
const OPEN_MATCH_MS = 5 * 60 * 1000;

/**
 * 判斷一筆平倉紀錄是不是我們那一筆。
 *
 * 用「合約 + 方向 + 平倉時間晚於開倉時間」三者比對，而不是只看合約。
 * 只看合約的話，同一個幣種先前的手動交易會被誤認成這一筆，
 * 損益就會記到錯的帳上 —— 而且不會有任何錯誤訊息。
 */
function matchHistory(records, tracked) {
  const openedMs = Date.parse(tracked.openedAt);
  const wantSide = tracked.side === 'long' ? 'long' : 'short';

  const candidates = records.filter((r) => {
    if (!r.closedAtMs) return false;
    // 平倉時間必須晚於我們開倉的時間（留 60 秒容錯給時鐘誤差）
    if (Number.isFinite(openedMs) && r.closedAtMs < openedMs - 60000) return false;
    // 單向持倉時 OKX 回 net，方向資訊不在這個欄位，只能略過方向比對
    if (r.posSide && r.posSide !== 'net' && r.posSide !== wantSide) return false;

    // 開倉時間必須對得上。
    //
    // 這一條才是關鍵。少了它，「同幣種、晚於我們開倉、同方向」這組條件
    // 會把你手動開的單一起收進來 —— 那筆的損益會被記到系統這一單頭上，
    // 而且系統這一單的真實損益永遠不會入帳。日損上限因此讀到錯的數字。
    //
    // 容忍 OPEN_MATCH_MS：下單到成交通常在數秒內，但交易所回報的開倉時間
    // 與我們寫入 openedAt 的時刻本來就有落差，抓太緊會變成一筆都對不上。
    if (Number.isFinite(openedMs) && Number.isFinite(r.openedAtMs)) {
      if (Math.abs(r.openedAtMs - openedMs) > OPEN_MATCH_MS) return false;
    }
    return true;
  });

  if (!candidates.length) return null;
  // 還是多筆的話，取開倉時間最接近的那一筆 —— 比「最早平倉」可靠，
  // 因為我們真正確定的是自己什麼時候開的，不是什麼時候平的。
  if (Number.isFinite(openedMs)) {
    candidates.sort((a, b) =>
      Math.abs(a.openedAtMs - openedMs) - Math.abs(b.openedAtMs - openedMs));
  } else {
    candidates.sort((a, b) => a.closedAtMs - b.closedAtMs);
  }
  return candidates[0];
}

/**
 * OKX 的平倉類型。
 *
 * 【重要】這個欄位不區分止盈與止損 —— 兩者都是「完全平倉(2)」。
 * 想知道是哪一個，只能拿成交價跟訊號的 TP/SL 比，而那是推斷，不是事實，
 * 所以推斷出來的結果一律標上「推斷」二字。
 *
 * 官方定義（2026-09 查證）：
 *   1 部分平倉  2 完全平倉  3 強制平倉  4 部分強平
 *   5 ADL 未全平  6 ADL 全平
 */
function describeCloseType(type) {
  const map = {
    1: '部分平倉',
    2: '平倉',
    3: '強制平倉',
    4: '部分強平',
    5: '自動減倉（未全平）',
    6: '自動減倉',
  };
  return map[String(type)] || '已平倉';
}

/**
 * 推斷平倉屬於止盈還是止損。
 *
 * 用出場價離哪一邊近來判斷。這只在「正常平倉(2)」時才做 ——
 * 強平與 ADL 有自己的原因，硬套止盈止損會蓋掉真正要緊的資訊。
 */
function inferExit(closeAvgPx, tracked) {
  if (!Number.isFinite(closeAvgPx)) return null;
  const sl = Number(tracked.sl);
  const tp1 = Array.isArray(tracked.tp) ? Number(tracked.tp[0]) : NaN;
  if (!Number.isFinite(sl) && !Number.isFinite(tp1)) return null;

  const dSl = Number.isFinite(sl) ? Math.abs(closeAvgPx - sl) : Infinity;
  const dTp = Number.isFinite(tp1) ? Math.abs(closeAvgPx - tp1) : Infinity;
  if (dSl === Infinity && dTp === Infinity) return null;
  return dTp <= dSl ? '推斷止盈' : '推斷止損';
}

/**
 * 跑一輪對帳。
 *
 * @param {object} ctx { config, store, exchange, now }
 *        exchange 需提供 fetchPositions / fetchPositionsHistory，
 *        注入而非直接 require，是為了讓測試能在不連網的情況下驗證邏輯。
 * @returns {Promise<{checked:number, stillOpen:number, closed:Array, errors:Array}>}
 */
async function reconcileOnce(ctx) {
  const { config, store, exchange } = ctx;
  const now = ctx.now || Date.now();
  // 這一輪對的是哪一家。雙邊下單時每家各跑一輪 ——
  // 只對其中一家的話，另一家的部位永遠不會被結算。
  const exName = ctx.exchangeName || 'okx';
  // 欄位名是 config.demo（不是 demoMode）。寫錯的話 x-simulated-trading
  // 標頭不會送出 —— 訂單下在模擬盤，對帳卻去查實盤，而且不會有任何錯誤，
  // 只會永遠查不到平倉紀錄。
  const flags = { demo: config.demo };
  // 每家交易所的連線設定各自獨立
  const exCfg = exName === 'bingx' ? config.bingx : config.okx;

  const tracked = store.listPositions(exName);
  const intents = store.listIntents ? store.listIntents(exName) : [];
  const out = {
    exchange: exName,
    checked: tracked.length, stillOpen: 0, closed: [],
    resolvedIntents: [], orphans: [], errors: [],
  };
  if (!tracked.length && !intents.length) return out;

  // 一次把所有持倉抓回來，而不是每筆部位查一次 ——
  // 查詢有頻率限制，而且部位數量增加時單筆查詢會線性變慢。
  let live;
  try {
    live = await exchange.fetchPositions(exCfg, flags);
  } catch (err) {
    out.errors.push('查詢持倉失敗：' + err.message);
    return out;   // 查不到就什麼都不做。寧可晚一輪，不可誤判成已平倉。
  }
  const openInstIds = new Set(live.map((p) => p.instId));

  // ── 一：把「下單例外」留下的意圖查清楚 ─────────────────
  //
  // 這些是最危險的一類：請求可能已經成交，但系統沒有部位紀錄，
  // 所以額度沒扣、損益不會入帳。用 clOrdId 去問交易所是唯一的答案來源。
  for (const it of intents) {
    // 剛下的單給寬限期，避免在交易所還沒建檔時就判定為未成交
    const atMs = Date.parse(it.at);
    if (Number.isFinite(atMs) && now - atMs < OPEN_GRACE_MS) continue;

    let order;
    try {
      order = await exchange.fetchOrderByClOrdId(
        { instId: it.instId, clOrdId: it.clOrdId }, exCfg, flags
      );
    } catch (err) {
      out.errors.push(`意圖 ${it.clOrdId} 反查失敗：${err.message}`);
      continue;   // 查不到就留著，下一輪再試。絕不猜。
    }

    if (!order) {
      // 交易所沒有這筆 —— 請求確實沒送達，可以安心放掉
      store.clearIntent(it.sigId, it.exchange);
      out.resolvedIntents.push({
        sigId: it.sigId, symbol: it.symbol, outcome: 'never_sent',
        note: '交易所查無此單，該筆請求並未送達，未造成部位',
      });
      continue;
    }

    if (order.state === 'partially_filled') {
      // 部分成交的單還在動，不結案。
      //
      // 不能當成 filled：補登的數量會是意圖的完整張數，與交易所實際持有的
      // 不符；也不能清掉意圖，否則剩下的部分稍後成交就沒人追了。
      // 市價單出現持續的部分成交並不正常，所以要說出來。
      out.errors.push(
        `意圖 ${it.clOrdId} 部分成交（${order.filledSz} / ${it.orderQty} 張），`
        + '尚未結案，下一輪再查。若持續如此請到交易所確認。'
      );
      continue;
    }

    if (order.state === 'filled') {
      // 成交了，而系統原本不知道。補登部位，之後就走正常的平倉對帳。
      store.addPosition(it.sigId, {
        symbol: it.symbol, exchange: exName, side: it.side,
        entry: order.avgPx || it.entry, sl: it.sl, tp: it.tp,
        // 數量以交易所實際成交為準，不用意圖裡的預期值。
        orderQty: order.filledSz || it.orderQty,
        baseQty: it.baseQty,
        clientOrderId: it.clOrdId,
        // 【重要】開倉時間要用交易所的建單時間，不能用「補登的當下」。
        //
        // addPosition 預設會蓋上現在時間，而 matchHistory 用開倉時間
        // 比對平倉紀錄，容忍值只有五分鐘。補登若晚於實際成交超過五分鐘
        // （正是這條路徑要救的那種情境：交易所異常數分鐘、或行程掛掉後
        // 隔很久才重啟），這筆部位就再也對不上任何平倉紀錄 ——
        // 永遠卡在 store、永遠佔著持倉額度、損益永遠不入帳。
        openedAt: order.createdAtMs
          ? new Date(order.createdAtMs).toISOString()
          : it.at,
        // 標記來源。事後檢討時要分得出「正常下單」與「靠對帳撿回來的」。
        recoveredBy: 'reconcile',
      });
      store.clearIntent(it.sigId, it.exchange);
      out.resolvedIntents.push({
        sigId: it.sigId, symbol: it.symbol, outcome: 'filled',
        avgPx: order.avgPx, qty: order.filledSz,
        note: '下單當時未收到回應，但實際已成交，已補登部位',
      });
      continue;
    }

    if (order.state === 'canceled') {
      store.clearIntent(it.sigId, it.exchange);
      out.resolvedIntents.push({
        sigId: it.sigId, symbol: it.symbol, outcome: 'canceled',
        note: '訂單已被取消，未成交',
      });
      continue;
    }
    // live / partially_filled：還在動，留著下一輪再看
  }

  // ── 二：交易所有、本地沒有 ─────────────────────────────
  //
  // 對帳原本是單向的，只看得到「本地有、交易所沒有」。
  // 但真正會讓人賠錢的是反方向：有一個真實部位在市場上，
  // 而系統完全不知道它存在。這裡只告警、不自動處理 ——
  // 那可能是使用者自己手動開的單，系統無權替它做任何決定。
  // 用「現在」的部位清單重建，不是迴圈開始前那份快照 ——
  // 上面剛補登的部位若不算進來，這一輪就會把自己剛補的那筆
  // 報成孤兒倉，使用者同時收到「已補登」與「系統無此紀錄」兩則矛盾訊息。
  // 必須按交易所過濾。少了它，OKX 的 ETH 部位會把 BingX 上
  // 一個系統不知道的 ETH 部位遮掉 —— 而雙邊下單讓兩家的標的高度重疊，
  // 等於把這道偵測大部分時間關掉。
  const current = store.listPositions(exName);
  const knownInstIds = new Set();
  for (const t of current.concat(store.listIntents(exName))) {
    const r = symbols.resolve(t.symbol, exName);
    // OKX 用 instId（BTC-USDT-SWAP），BingX 用 symbol（BTC-USDT）。
    // 兩邊的欄位名不同但用途相同，所以取到哪個就用哪個。
    if (r.ok) knownInstIds.add(r.spec.instId || r.spec.symbol);
  }
  for (const p of live) {
    if (!knownInstIds.has(p.instId)) {
      out.orphans.push({
        instId: p.instId, pos: p.pos, avgPx: p.avgPx, upl: p.upl,
      });
    }
  }

  // ── 三：本地有、交易所沒有 → 已平倉，結算 ───────────────
  for (const t of tracked) {
    const resolved = symbols.resolve(t.symbol, exName);
    if (!resolved.ok) {
      out.errors.push(`${t.symbol}：${resolved.error}`);
      continue;
    }
    const instId = resolved.spec.instId || resolved.spec.symbol;

    if (openInstIds.has(instId)) {
      out.stillOpen += 1;
      continue;
    }

    // 不在持倉清單裡 —— 但剛下的單可能還沒成交，先給寬限期。
    // 少了這一段，下單後數秒內跑的對帳會把還沒成交的單判成已平倉，
    // 然後記下一筆 0 元損益並把部位刪掉，那筆交易就此從系統中消失。
    const openedMs = Date.parse(t.openedAt);
    if (Number.isFinite(openedMs) && now - openedMs < OPEN_GRACE_MS) {
      out.stillOpen += 1;
      continue;
    }

    let history;
    try {
      history = await exchange.fetchPositionsHistory(
        { instId, afterMs: Number.isFinite(openedMs) ? openedMs - 60000 : null },
        exCfg, flags
      );
    } catch (err) {
      out.errors.push(`${t.symbol} 查詢平倉紀錄失敗：${err.message}`);
      continue;
    }

    const rec = matchHistory(history, t);
    if (!rec) {
      // 部位不在、平倉紀錄也查不到。這通常代表訂單根本沒成交
      // （掛單被取消、或下單當下就失敗了）。
      // 不記損益、不刪部位 —— 留著讓它在下一輪再試，
      // 並且在回傳值裡說出來，這種狀態需要人看一眼。
      out.errors.push(
        `${t.symbol} 部位已不存在，但查不到對應的平倉紀錄（sig ${t.sigId.slice(-12)}）`
      );
      continue;
    }

    // realizedPnl 已含手續費與資金費，直接記。
    // 自己用價差重算等於重做一次交易所的會計，永遠會差一點。
    const pnl = Number.isFinite(rec.realizedPnl) ? rec.realizedPnl : 0;

    // 記在「平倉當下」而非「對帳當下」。
    // 差別只在跨午夜那一分鐘，但那一分鐘會讓昨天的虧損整筆算到今天：
    // 昨天的日損上限從未被觸發，今天一開盤就先背了一筆。兩邊都錯。
    // 順序很重要：先確認刪得掉，再記損益。
    //
    // 反過來的話，刪除失敗時損益已經記進去了，而部位還在 ——
    // 下一輪會再記一次，然後一直記下去。這正是發生過的事：
    // 一筆 -30 的停損，三輪後帳上是 -90。
    const removed = store.removePosition(t.sigId, t.exchange);
    if (!removed) {
      out.errors.push(
        `${t.symbol} 的部位紀錄刪不掉（sig ${String(t.sigId).slice(-12)}，`
        + `交易所 ${t.exchange}）。損益未入帳，以免重複累計。`
        + '這通常代表狀態檔的鍵格式有問題，需要人工檢查。'
      );
      continue;
    }
    store.recordPnl(pnl, rec.closedAtMs || now);

    const exit = String(rec.closeType) === '2' ? inferExit(rec.closeAvgPx, t) : null;

    out.closed.push({
      sigId: t.sigId,
      exchange: exName,
      symbol: t.symbol,
      side: t.side,
      entry: t.entry,
      openAvgPx: rec.openAvgPx,
      closeAvgPx: rec.closeAvgPx,
      pnlUsdt: pnl,
      // BingX 沒有單筆平倉紀錄端點，損益是從資金流水聚合出來的。
      // 那段期間若有別的交易或資金費，會一起被算進來。
      // 標記出來，卡片上才講得出「這個數字有多可信」。
      pnlConfidence: rec.aggregated ? 'low' : 'high',
      grossPnlUsdt: rec.pnl,
      feeUsdt: rec.fee,
      fundingUsdt: rec.fundingFee,
      reason: describeCloseType(rec.closeType)
        + (exit ? '（' + exit + '）' : ''),
      closedAtMs: rec.closedAtMs,
      win: pnl > 0,
    });
  }

  return out;
}

/**
 * 把一筆平倉整理成推播用的文字。
 *
 * 刻意把「價差」與「手續費」分開列：兩者相加才是入帳金額，
 * 而手續費在高槓桿下佔比不低 —— 混在一起看不出來錢花在哪。
 */
function renderClosedCard(c) {
  const sign = c.pnlUsdt >= 0 ? '+' : '';
  const head = c.win ? '🟢 獲利平倉' : '🔴 虧損平倉';
  const lines = [
    `${head}｜${c.symbol} ${c.side === 'long' ? '做多⬆' : '做空⬇'}`
      + (c.exchange ? `（${c.exchange.toUpperCase()}）` : ''),
    '─────────────',
    `[原因] ${c.reason}`,
    `[進場] ${c.openAvgPx}`,
    `[出場] ${c.closeAvgPx}`,
    `[價差] ${c.grossPnlUsdt >= 0 ? '+' : ''}${Number(c.grossPnlUsdt).toFixed(2)} USDT`,
    // 交易所偶爾回空字串，相加會變成 NaN 印在卡片上。折成 0 比較誠實：
    // 費用漏算會讓人以為賺得比較多，而 NaN 只是看起來像壞掉。
    `[費用] ${((Number(c.feeUsdt) || 0) + (Number(c.fundingUsdt) || 0)).toFixed(2)} USDT`,
    `[損益] ${sign}${Number(c.pnlUsdt).toFixed(2)} USDT`,
  ];
  if (c.pnlConfidence === 'low') {
    lines.push('');
    lines.push('⚠️ 此損益由資金流水聚合而得，非交易所的單筆平倉紀錄。');
    lines.push('   若同期間有其他交易或資金費，可能被一併計入。');
  }
  return lines.join('\n');
}

/** 當日統計。給推播與 /health 用。 */
function dailySummary(store, now) {
  const today = store.today(now || Date.now());
  return {
    realisedPnlUsdt: Number(today.realisedPnlUsdt.toFixed(4)),
    orders: today.orders,
  };
}

module.exports = {
  reconcileOnce, matchHistory, describeCloseType, inferExit,
  renderClosedCard, dailySummary, OPEN_GRACE_MS, OPEN_MATCH_MS,
};
