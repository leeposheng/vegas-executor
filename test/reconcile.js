'use strict';
/**
 * 對帳迴圈的測試。全部不連網 —— exchange 是注入的假物件。
 *
 * 這一組測試的重點不是「順利時會不會運作」，而是幾種
 * 會把錢記到錯的地方、或讓交易從系統裡消失的失敗模式：
 *   - 剛下單還沒成交，被誤判成已平倉
 *   - 同幣種先前的舊交易，被誤認成這一筆
 *   - 查詢失敗時仍然刪掉部位
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { reconcileOnce, matchHistory, renderClosedCard } = require('../src/reconcile');
const Store = require('../src/store');

let pass = 0;
const fails = [];
function ck(name, fn) {
  try { fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}
async function ckAsync(name, fn) {
  try { await fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const S = Store.Store || Store;
  return new S(dir);
}

const CONFIG = { okx: {}, demo: true };
const T0 = Date.parse('2026-09-25T00:00:00Z');

/** 造一個假的交易所。positions / history 都是寫死的陣列。 */
function fakeExchange(positions, history, opts) {
  const o = opts || {};
  // 記下每次呼叫收到的旗標。旗標錯了不會拋錯、不會少資料 ——
  // 只是打到另一個環境去。沒有這個記錄，那種錯永遠測不出來。
  const seen = { flags: [] };
  return {
    seen,
    async fetchPositions(cfg, flags) {
      seen.flags.push(flags);
      if (o.positionsThrow) throw new Error(o.positionsThrow);
      return positions;
    },
    async fetchPositionsHistory(params, cfg, flags) {
      seen.flags.push(flags);
      if (o.historyThrow) throw new Error(o.historyThrow);
      return history;
    },
  };
}

function trackedBtc(store, openedAtMs) {
  store.addPosition('sig-btc-1', {
    symbol: 'BTCUSDT.P', exchange: 'okx', side: 'long',
    entry: 84000, sl: 83500, tp: [84500, 85000, 85500],
    orderQty: 4.75, baseQty: 0.0475, clientOrderId: 'c1',
  });
  // addPosition 會蓋上現在時間，測試需要控制它
  // 鍵是「交易所:訊號編號」—— 同一筆訊號可能在兩家各有一個部位
  store.state.positions['okx:sig-btc-1'].openedAt = new Date(openedAtMs).toISOString();
  store.save();
}

const HIST_TP = {
  instId: 'BTC-USDT-SWAP', posSide: 'long',
  openAvgPx: 84000, closeAvgPx: 84500,
  realizedPnl: 19.25, pnl: 23.75, fee: -4.0, fundingFee: -0.5,
  closeType: '3', openedAtMs: T0, closedAtMs: T0 + 3600 * 1000,
  posId: 'p1',
};

(async function run() {

  // ── 正常路徑 ────────────────────────────────────────────
  await ckAsync('部位還在時不做任何事', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([{ instId: 'BTC-USDT-SWAP', pos: 4.75 }], []);
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 7200000 });
    assert.strictEqual(r.stillOpen, 1);
    assert.strictEqual(r.closed.length, 0);
    assert.strictEqual(store.listPositions().length, 1, '部位不該被刪');
  });

  await ckAsync('部位消失且查得到平倉紀錄 → 記損益並刪部位', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([], [HIST_TP]);
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 7200000 });
    assert.strictEqual(r.closed.length, 1, JSON.stringify(r.errors));
    assert.strictEqual(store.listPositions().length, 0, '部位應被刪除');
    assert.ok(Math.abs(store.today(T0 + 7200000).realisedPnlUsdt - 19.25) < 1e-9,
      '應記入 realizedPnl（含手續費），不是 pnl');
  });

  await ckAsync('記的是 realizedPnl 而非價差', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([], [HIST_TP]);
    await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 7200000 });
    const recorded = store.today(T0 + 7200000).realisedPnlUsdt;
    assert.notStrictEqual(recorded, 23.75, '不可記成未扣費用的價差');
    assert.strictEqual(recorded, 19.25);
  });

  // ── 模擬盤旗標：錯了不會有任何症狀，只會打到另一個帳戶 ──
  await ckAsync('demo 旗標必須傳到交易所的每一次呼叫', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([], [HIST_TP]);
    await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 7200000 });
    assert.ok(ex.seen.flags.length >= 2, '持倉與平倉紀錄都該被查過');
    for (const f of ex.seen.flags) {
      assert.strictEqual(f && f.demo, true,
        '旗標必須來自 config.demo —— 寫成 demoMode 會變成 undefined，'
        + '訂單在模擬盤、對帳卻查實盤');
    }
  });

  await ckAsync('實盤設定時旗標必須是 false，不可是 undefined', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([], [HIST_TP]);
    await reconcileOnce({
      config: { okx: {}, demo: false }, store, exchange: ex, now: T0 + 7200000,
    });
    assert.strictEqual(ex.seen.flags[0].demo, false);
  });

  // ── 寬限期：最容易讓交易憑空消失的地方 ──────────────────
  await ckAsync('剛下單尚未成交，不可判定為已平倉', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    // 交易所兩邊都空的：部位還沒出現，平倉紀錄當然也沒有
    const ex = fakeExchange([], []);
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 5000 });
    assert.strictEqual(r.closed.length, 0, '寬限期內不得結算');
    assert.strictEqual(r.errors.length, 0, '寬限期內不該報錯');
    assert.strictEqual(store.listPositions().length, 1, '部位必須留著');
  });

  await ckAsync('超過寬限期又查無紀錄 → 留著部位並回報，不可靜默刪除', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([], []);
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 600000 });
    assert.strictEqual(r.closed.length, 0);
    assert.strictEqual(store.listPositions().length, 1, '查不到紀錄時不可刪部位');
    assert.ok(r.errors.length === 1 && r.errors[0].includes('查不到'), r.errors.join('；'));
  });

  // ── 查詢失敗 ───────────────────────────────────────────
  await ckAsync('查持倉失敗時完全不動作', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([], [HIST_TP], { positionsThrow: '網路逾時' });
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 7200000 });
    assert.strictEqual(r.closed.length, 0);
    assert.strictEqual(store.listPositions().length, 1, '查詢失敗不得刪部位');
    assert.ok(r.errors[0].includes('網路逾時'), r.errors.join('；'));
  });

  await ckAsync('查平倉紀錄失敗時不記損益', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([], [], { historyThrow: '限流' });
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 7200000 });
    assert.strictEqual(store.today(T0 + 7200000).realisedPnlUsdt, 0);
    assert.strictEqual(store.listPositions().length, 1);
    assert.ok(r.errors[0].includes('限流'), r.errors.join('；'));
  });

  // ── 比對邏輯：記到錯的帳上是最貴的錯 ────────────────────
  ck('先前的舊交易不可被認成這一筆', () => {
    const tracked = { openedAt: new Date(T0).toISOString(), side: 'long' };
    const old = Object.assign({}, HIST_TP, { closedAtMs: T0 - 86400000, realizedPnl: -999 });
    assert.strictEqual(matchHistory([old], tracked), null,
      '平倉時間早於開倉時間的紀錄必須被排除');
  });

  ck('方向不符者排除', () => {
    const tracked = { openedAt: new Date(T0).toISOString(), side: 'long' };
    const shortRec = Object.assign({}, HIST_TP, { posSide: 'short' });
    assert.strictEqual(matchHistory([shortRec], tracked), null);
  });

  ck('單向持倉（net）不比對方向', () => {
    const tracked = { openedAt: new Date(T0).toISOString(), side: 'long' };
    const netRec = Object.assign({}, HIST_TP, { posSide: 'net' });
    assert.ok(matchHistory([netRec], tracked), 'net 模式下方向欄位不帶資訊，不可據此排除');
  });

  // 這是整組測試裡最重要的一項。
  //
  // 早先的版本只比對「平倉時間晚於開倉時間」，於是你在 App 上手動開的單
  // 也符合條件，而且因為先平倉，還會被優先選中 —— 它的損益被記到系統這筆
  // 頭上，系統這筆真正的虧損則永遠不入帳，日損上限讀到的是假數字。
  ck('手動開的另一筆單不可被認成系統這一筆', () => {
    const tracked = {
      openedAt: new Date(T0).toISOString(), side: 'long',
      sl: 83500, tp: [84500],
    };
    // 系統 T0 開倉、T0+30min 平倉，虧 40
    const ours = Object.assign({}, HIST_TP, {
      openedAtMs: T0, closedAtMs: T0 + 1800000, realizedPnl: -40,
    });
    // 使用者 T0+5min 手動開、T0+10min 平掉，賺 200
    const manual = Object.assign({}, HIST_TP, {
      openedAtMs: T0 + 300000, closedAtMs: T0 + 600000, realizedPnl: 200,
    });
    const hit = matchHistory([manual, ours], tracked);
    assert.strictEqual(hit.realizedPnl, -40,
      '應比對開倉時間，而非挑最早平倉的那一筆');
  });

  ck('開倉時間差距過大者直接排除', () => {
    const tracked = { openedAt: new Date(T0).toISOString(), side: 'long' };
    const far = Object.assign({}, HIST_TP, {
      openedAtMs: T0 + 30 * 60000, closedAtMs: T0 + 40 * 60000,
    });
    assert.strictEqual(matchHistory([far], tracked), null,
      '開倉差 30 分鐘不可能是同一筆');
  });

  ck('開倉時間在容忍範圍內者仍然收下', () => {
    const tracked = { openedAt: new Date(T0).toISOString(), side: 'long' };
    const near = Object.assign({}, HIST_TP, {
      openedAtMs: T0 + 8000, closedAtMs: T0 + 600000,
    });
    assert.ok(matchHistory([near], tracked), '下單到成交的數秒落差必須容忍');
  });

  ck('交易所沒回開倉時間時退回舊規則，不可整筆漏掉', () => {
    const tracked = { openedAt: new Date(T0).toISOString(), side: 'long' };
    const noOpen = Object.assign({}, HIST_TP, {
      openedAtMs: null, closedAtMs: T0 + 600000,
    });
    assert.ok(matchHistory([noOpen], tracked));
  });

  // ── 日損閘門的接線 ──────────────────────────────────────
  await ckAsync('虧損會累進當日已實現損益（DAILY_LOSS_LIMIT 的輸入）', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const loss = Object.assign({}, HIST_TP, { realizedPnl: -29.04, closeType: '4' });
    const ex = fakeExchange([], [loss]);
    await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 7200000 });
    const today = store.today(T0 + 7200000);
    assert.ok(Math.abs(today.realisedPnlUsdt + 29.04) < 1e-9,
      `當日損益 ${today.realisedPnlUsdt}，應為 -29.04`);
    assert.ok(-today.realisedPnlUsdt > 0, '風控讀的是負號後的值，必須為正的虧損額');
  });

  await ckAsync('損益記在平倉當下，不是對帳當下（跨台北午夜）', async () => {
    const store = newStore();
    // 台北 23:59:20 = UTC 15:59:20
    const closedAt = Date.parse('2026-09-25T15:59:20Z');
    trackedBtc(store, closedAt - 3600000);
    const rec = Object.assign({}, HIST_TP, {
      openedAtMs: closedAt - 3600000, closedAtMs: closedAt, realizedPnl: -45,
    });
    const ex = fakeExchange([], [rec]);
    // 對帳在 60 秒後跑，那時台北已經是隔天 00:00:20
    const reconciledAt = closedAt + 60000;
    await reconcileOnce({ config: CONFIG, store, exchange: ex, now: reconciledAt });

    assert.ok(Math.abs(store.today(closedAt).realisedPnlUsdt + 45) < 1e-9,
      '應記在平倉那一天');
    assert.strictEqual(store.today(reconciledAt).realisedPnlUsdt, 0,
      '不可記到隔天 —— 那會讓新的一天一開盤就背著昨天的虧損');
  });

  // ── 平倉類型：OKX 的 type 不區分止盈止損 ────────────────
  ck('強平不可被說成止盈', () => {
    const { describeCloseType } = require('../src/reconcile');
    assert.strictEqual(describeCloseType('3'), '強制平倉');
    assert.strictEqual(describeCloseType('2'), '平倉');
    assert.strictEqual(describeCloseType('1'), '部分平倉');
  });

  ck('止盈止損只能推斷，且必須標明是推斷', () => {
    const { inferExit } = require('../src/reconcile');
    const t = { sl: 83500, tp: [84500] };
    assert.strictEqual(inferExit(84490, t), '推斷止盈');
    assert.strictEqual(inferExit(83510, t), '推斷止損');
    assert.strictEqual(inferExit(NaN, t), null);
    assert.strictEqual(inferExit(84000, { }), null, '沒有 SL/TP 就不要猜');
  });

  // ── 下單意圖：錢動了但系統不知道，是最貴的一種狀態 ──────
  function withOrder(order, opts) {
    const ex = fakeExchange((opts && opts.positions) || [], [], opts);
    ex.fetchOrderByClOrdId = async () => {
      if (opts && opts.orderThrow) throw new Error(opts.orderThrow);
      return order;
    };
    return ex;
  }

  function trackedIntent(store, atMs) {
    store.recordIntent('sig-int-1', {
      clOrdId: 'c-int-1', instId: 'BTC-USDT-SWAP', symbol: 'BTCUSDT.P',
      side: 'long', exchange: 'okx', entry: 84000, sl: 83500,
      tp: [84500], orderQty: 4.75, baseQty: 0.0475,
    });
    store.state.intents['okx:sig-int-1'].at = new Date(atMs).toISOString();
    store.save();
  }

  await ckAsync('意圖對應的單其實已成交 → 補登部位', async () => {
    const store = newStore();
    trackedIntent(store, T0);
    const ex = withOrder({ state: 'filled', filledSz: 4.75, avgPx: 84010 });
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 600000 });
    assert.strictEqual(r.resolvedIntents.length, 1, JSON.stringify(r.errors));
    assert.strictEqual(r.resolvedIntents[0].outcome, 'filled');
    const pos = store.listPositions();
    assert.strictEqual(pos.length, 1, '必須補登部位，否則額度不扣、損益不入帳');
    assert.strictEqual(pos[0].entry, 84010, '進場價應採實際成交均價');
    assert.strictEqual(pos[0].recoveredBy, 'reconcile', '要標記來源');
    assert.strictEqual(store.listIntents().length, 0, '處理完要清掉意圖');
  });

  await ckAsync('交易所查無此單 → 確認未送達，清掉意圖', async () => {
    const store = newStore();
    trackedIntent(store, T0);
    const ex = withOrder(null);
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 600000 });
    assert.strictEqual(r.resolvedIntents[0].outcome, 'never_sent');
    assert.strictEqual(store.listPositions().length, 0, '沒成交就不該有部位');
    assert.strictEqual(store.listIntents().length, 0);
  });

  await ckAsync('反查失敗時意圖必須留著，不可放掉', async () => {
    const store = newStore();
    trackedIntent(store, T0);
    const ex = withOrder(null, { orderThrow: '網路逾時' });
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 600000 });
    assert.strictEqual(store.listIntents().length, 1,
      '查不到就留著下一輪再試 —— 放掉等於承認它沒成交，而我們並不知道');
    assert.ok(r.errors.some((e) => e.includes('網路逾時')), r.errors.join('；'));
  });

  await ckAsync('寬限期內的意圖先不處理', async () => {
    const store = newStore();
    trackedIntent(store, T0);
    const ex = withOrder(null);
    await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 5000 });
    assert.strictEqual(store.listIntents().length, 1,
      '交易所可能還沒建檔，太早判定會把成交的單當成沒送出');
  });

  await ckAsync('訂單還在掛著（live）時不動作', async () => {
    const store = newStore();
    trackedIntent(store, T0);
    const ex = withOrder({ state: 'live', filledSz: 0 });
    await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 600000 });
    assert.strictEqual(store.listIntents().length, 1);
    assert.strictEqual(store.listPositions().length, 0);
  });

  // ── 孤兒倉：交易所有、系統沒有 ─────────────────────────
  await ckAsync('交易所上有系統不知道的部位 → 告警但不處理', async () => {
    const store = newStore();
    trackedBtc(store, T0);
    const ex = fakeExchange([
      { instId: 'BTC-USDT-SWAP', pos: 4.75 },
      { instId: 'ETH-USDT-SWAP', pos: 2, avgPx: 3000, upl: -12 },
    ], []);
    const r = await reconcileOnce({ config: CONFIG, store, exchange: ex, now: T0 + 7200000 });
    assert.strictEqual(r.orphans.length, 1, '應偵測到一個孤兒倉');
    assert.strictEqual(r.orphans[0].instId, 'ETH-USDT-SWAP');
    assert.strictEqual(r.closed.length, 0, '不可自動替孤兒倉做任何處置');
  });

  // ── kill switch 的來源 ─────────────────────────────────
  ck('自檢停的，自檢通過時要能自己解開', () => {
    const store = newStore();
    store.setHalted(true, '開機自檢失敗：限流', 'preflight');
    assert.strictEqual(store.isHalted(), true);
    assert.strictEqual(store.haltedSource(), 'preflight');
    assert.strictEqual(store.clearHaltIfFrom('preflight'), true);
    assert.strictEqual(store.isHalted(), false);
  });

  ck('人手動停的，程式不得解開', () => {
    const store = newStore();
    store.setHalted(true, '我要休息一下', 'manual');
    assert.strictEqual(store.clearHaltIfFrom('preflight'), false,
      '手動停止是使用者的決定，程式沒資格替他改');
    assert.strictEqual(store.isHalted(), true);
  });

  ck('舊狀態檔沒有 haltedSource 時視為手動', () => {
    const store = newStore();
    store.state.halted = true;
    store.state.haltedReason = '部署前留下的';
    store.save();
    assert.strictEqual(store.haltedSource(), 'manual',
      '來源不明時往安全那邊倒 —— 不自動解除');
    assert.strictEqual(store.clearHaltIfFrom('preflight'), false);
  });

  // ── 持倉上限的執行期調整 ────────────────────────────────
  ck('沒設覆寫時用環境變數的值', () => {
    const { effectiveMaxConcurrent } = require('../src/risk');
    const store = newStore();
    assert.strictEqual(
      effectiveMaxConcurrent(store, { maxConcurrent: 3, maxConcurrentCeiling: 5 }), 3);
  });

  ck('覆寫值生效', () => {
    const { effectiveMaxConcurrent } = require('../src/risk');
    const store = newStore();
    store.setOverride('maxConcurrent', 4);
    assert.strictEqual(
      effectiveMaxConcurrent(store, { maxConcurrent: 1, maxConcurrentCeiling: 5 }), 4);
  });

  ck('覆寫值不得突破天花板', () => {
    const { effectiveMaxConcurrent } = require('../src/risk');
    const store = newStore();
    store.setOverride('maxConcurrent', 99);
    assert.strictEqual(
      effectiveMaxConcurrent(store, { maxConcurrent: 1, maxConcurrentCeiling: 5 }), 5,
      '天花板是唯一保證外部輸入不會失控的地方，必須夾住');
  });

  ck('覆寫值不得小於 1', () => {
    const { effectiveMaxConcurrent } = require('../src/risk');
    const store = newStore();
    store.setOverride('maxConcurrent', 0);
    assert.strictEqual(
      effectiveMaxConcurrent(store, { maxConcurrent: 3, maxConcurrentCeiling: 5 }), 1);
  });

  ck('覆寫值要能撐過重啟', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovr-'));
    const S = Store.Store || Store;
    const a = new S(dir);
    a.setOverride('maxConcurrent', 4);
    const b = new S(dir);   // 模擬重新部署後重新載入
    assert.strictEqual(b.getOverride('maxConcurrent'), 4,
      '不持久化的話，每次上新版都會悄悄退回預設值而你不會發現');
  });

  // ── 推播文字 ───────────────────────────────────────────
  ck('平倉卡片把價差與費用分開列', () => {
    const text = renderClosedCard({
      symbol: 'BTCUSDT.P', side: 'long', win: true,
      openAvgPx: 84000, closeAvgPx: 84500,
      pnlUsdt: 19.25, grossPnlUsdt: 23.75, feeUsdt: -4.0, fundingUsdt: -0.5,
      reason: '止盈觸發',
    });
    assert.ok(text.includes('🟢 獲利平倉'), text);
    assert.ok(text.includes('止盈觸發'), text);
    assert.ok(text.includes('+23.75'), '應列出價差');
    assert.ok(text.includes('-4.50'), '應列出費用合計');
    assert.ok(text.includes('+19.25'), '應列出實際入帳');
  });

  ck('虧損卡片標示為紅', () => {
    const text = renderClosedCard({
      symbol: 'BTCUSDT.P', side: 'short', win: false,
      openAvgPx: 84000, closeAvgPx: 84600,
      pnlUsdt: -29.04, grossPnlUsdt: -25.05, feeUsdt: -3.99, fundingUsdt: 0,
      reason: '止損觸發',
    });
    assert.ok(text.includes('🔴 虧損平倉'), text);
    assert.ok(text.includes('-29.04'), text);
  });

  console.log(`對帳測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
  if (fails.length) {
    console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
    process.exit(1);
  }
})();
