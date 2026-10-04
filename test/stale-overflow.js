'use strict';
/**
 * 殘留部位釋放與超額進場的測試。全部不連網。
 *
 * 起因（2026-10-04）：OKX 模擬盤上只有 1 個部位，執行層卻認定持倉 5 筆，
 * 新訊號全部被 max_concurrent 與 no_duplicate_symbol 擋下。
 * 對帳在「交易所已無此部位、又查不到平倉紀錄」時會永遠保留紀錄，
 * 而且只寫伺服器日誌 —— 名額被悄悄佔滿，沒有人看得到。
 *
 * 這一組守的是：
 *   1. 殘留部位在時限內保留、逾時後放寬比對、仍對不上則釋放並回報
 *   2. 反查一直失敗的下單意圖，在交易所確定沒有部位時才釋放
 *   3. 達上限時只有「唯一擋住的是持倉上限」才能改成超額進場
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0;
const fails = [];
async function ck(name, fn) {
  try { await fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-04T00:00:00Z');

// ================================================================
// 一、對帳：殘留部位
// ================================================================
const { reconcileOnce } = require('../src/reconcile');
const { Store } = require('../src/store');

function newStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'stale-')));
}

function trackZec(store, openedAtMs) {
  store.addPosition('sig-zec', {
    symbol: 'ZECUSDT.P', exchange: 'okx', side: 'short',
    entry: 1305, sl: 1323, tp: [1287, 1269, 1251], orderQty: 300, clientOrderId: 'c-zec',
  });
  store.state.positions['okx:sig-zec'].openedAt = new Date(openedAtMs).toISOString();
  store.save();
}

function fakeEx(positions, history, opts) {
  const o = opts || {};
  return {
    async fetchPositions() { return positions; },
    async fetchPositionsHistory() { return history; },
    async fetchOrderByClOrdId() {
      if (o.orderThrow) throw new Error(o.orderThrow);
      return o.order === undefined ? null : o.order;
    },
  };
}

const CFG = { okx: {}, demo: true, reconcileStaleMin: 30 };

(async function run() {

  await ck('殘留部位第一輪只標記、不刪除', async () => {
    const store = newStore();
    trackZec(store, T0);
    const r = await reconcileOnce({ config: CFG, store, exchange: fakeEx([], []), now: T0 + 10 * MIN });
    assert.strictEqual(store.listPositions().length, 1, '時限內必須保留');
    assert.strictEqual(r.released.length, 0);
    assert.ok(store.listPositions()[0].goneSinceMs, '要記下從何時起不在');
  });

  await ck('時限內第二輪仍保留', async () => {
    const store = newStore();
    trackZec(store, T0);
    const ex = fakeEx([], []);
    await reconcileOnce({ config: CFG, store, exchange: ex, now: T0 + 10 * MIN });
    await reconcileOnce({ config: CFG, store, exchange: ex, now: T0 + 30 * MIN });
    assert.strictEqual(store.listPositions().length, 1, '只過了 20 分鐘，不該釋放');
  });

  await ck('逾時且仍無平倉紀錄 → 釋放額度、不入帳、回報', async () => {
    const store = newStore();
    trackZec(store, T0);
    const ex = fakeEx([], []);
    await reconcileOnce({ config: CFG, store, exchange: ex, now: T0 + 10 * MIN });
    const before = store.openPositionCount('okx');
    const r = await reconcileOnce({ config: CFG, store, exchange: ex, now: T0 + 41 * MIN });
    assert.strictEqual(before, 1);
    assert.strictEqual(store.openPositionCount('okx'), 0, '額度必須被釋放');
    assert.strictEqual(r.released.length, 1);
    assert.strictEqual(r.released[0].kind, 'position');
    assert.strictEqual(store.today(T0 + 41 * MIN).realisedPnlUsdt, 0,
      '查不到損益就不入帳 —— 記 0 會讓日損上限讀到假數字');
  });

  await ck('逾時後放寬比對：開倉時間差超過 5 分鐘也能對上並入帳', async () => {
    const store = newStore();
    trackZec(store, T0);
    // 交易所的開倉時間比系統紀錄晚 12 分鐘 —— 嚴格比對對不上
    const hist = [{
      instId: 'ZEC-USDT-SWAP', posSide: 'net', openAvgPx: 1305, closeAvgPx: 1323,
      realizedPnl: -30.5, pnl: -27, fee: -3.5, fundingFee: 0, closeType: '4',
      openedAtMs: T0 + 12 * MIN, closedAtMs: T0 + 20 * MIN,
    }];
    const ex = fakeEx([], hist);
    const r1 = await reconcileOnce({ config: CFG, store, exchange: ex, now: T0 + 25 * MIN });
    assert.strictEqual(r1.closed.length, 0, '時限內只用嚴格比對');
    const r2 = await reconcileOnce({ config: CFG, store, exchange: ex, now: T0 + 60 * MIN });
    assert.strictEqual(r2.closed.length, 1, '逾時後放寬比對應對上');
    assert.strictEqual(r2.closed[0].matchedBy, 'relaxed');
    assert.strictEqual(r2.released.length, 0, '對上了就不是釋放');
    assert.strictEqual(store.openPositionCount('okx'), 0);
    assert.strictEqual(store.today(T0 + 60 * MIN).realisedPnlUsdt, -30.5, '損益要入帳');
  });

  await ck('部位重新出現時清除計時', async () => {
    const store = newStore();
    trackZec(store, T0);
    await reconcileOnce({ config: CFG, store, exchange: fakeEx([], []), now: T0 + 10 * MIN });
    await reconcileOnce({ config: CFG, store,
      exchange: fakeEx([{ instId: 'ZEC-USDT-SWAP', pos: -300 }], []), now: T0 + 20 * MIN });
    assert.strictEqual(store.listPositions()[0].goneSinceMs, undefined, '計時應歸零');
    // 之後再短暫消失，不能被立刻釋放
    const r = await reconcileOnce({ config: CFG, store, exchange: fakeEx([], []), now: T0 + 45 * MIN });
    assert.strictEqual(r.released.length, 0);
    assert.strictEqual(store.listPositions().length, 1);
  });

  await ck('持倉查詢失敗時絕不釋放', async () => {
    const store = newStore();
    trackZec(store, T0);
    store.patchPosition('sig-zec', 'okx', { goneSinceMs: T0 });
    const ex = fakeEx([], []);
    ex.fetchPositions = async () => { throw new Error('限流'); };
    const r = await reconcileOnce({ config: CFG, store, exchange: ex, now: T0 + 120 * MIN });
    assert.strictEqual(r.released.length, 0);
    assert.strictEqual(store.listPositions().length, 1);
  });

  // ================================================================
  // 二、對帳：卡住的下單意圖
  // ================================================================
  function intent(store, atMs, symbol, extra) {
    store.recordIntent('sig-int', Object.assign({
      clOrdId: 'c-int', symbol: symbol || 'ZECUSDT.P', side: 'short', exchange: 'okx',
      entry: 1305, sl: 1323, tp: [1287], orderQty: 300,
    }, extra || { instId: 'ZEC-USDT-SWAP' }));
    store.state.intents['okx:sig-int'].at = new Date(atMs).toISOString();
    store.save();
  }

  await ck('意圖反查失敗、逾時、交易所無此合約 → 釋放', async () => {
    const store = newStore();
    intent(store, T0);
    const r = await reconcileOnce({ config: CFG, store,
      exchange: fakeEx([], [], { orderThrow: '50011 too many requests' }), now: T0 + 40 * MIN });
    assert.strictEqual(store.listIntents().length, 0);
    assert.strictEqual(r.released.length, 1);
    assert.strictEqual(r.released[0].kind, 'intent');
  });

  await ck('意圖反查失敗但交易所有此合約部位 → 保留', async () => {
    const store = newStore();
    intent(store, T0);
    const r = await reconcileOnce({ config: CFG, store,
      exchange: fakeEx([{ instId: 'ZEC-USDT-SWAP', pos: -300 }], [], { orderThrow: 'timeout' }),
      now: T0 + 40 * MIN });
    assert.strictEqual(store.listIntents().length, 1, '可能就是這筆成交的部位，不能放掉');
    assert.strictEqual(r.released.length, 0);
  });

  await ck('意圖反查失敗但未逾時 → 保留', async () => {
    const store = newStore();
    intent(store, T0);
    await reconcileOnce({ config: CFG, store,
      exchange: fakeEx([], [], { orderThrow: 'timeout' }), now: T0 + 10 * MIN });
    assert.strictEqual(store.listIntents().length, 1);
  });

  await ck('沒有 instId 的意圖（BingX 格式）反查時要從代碼表補齊', async () => {
    const store = newStore();
    store.recordIntent('sig-bx', {
      clOrdId: 'c-bx', symbol: 'SOLUSDT.P', side: 'long', exchange: 'bingx', orderQty: 1,
    });
    store.state.intents['bingx:sig-bx'].at = new Date(T0).toISOString();
    store.save();
    let asked = null;
    const ex = fakeEx([], []);
    ex.fetchOrderByClOrdId = async (p) => { asked = p.instId; return null; };
    await reconcileOnce({ config: { bingx: {}, demo: true }, store, exchange: ex,
      exchangeName: 'bingx', now: T0 + 5 * MIN });
    assert.strictEqual(asked, 'SOL-USDT', `應以 SOL-USDT 反查，實際送出 ${asked}`);
  });

  // ================================================================
  // 三、超額進場
  // ================================================================
  function env(dir, extra) {
    Object.assign(process.env, {
      DATA_DIR: dir, EXCHANGES: 'okx', EXECUTION_MODE: 'auto',
      DRY_RUN: 'false', DEMO_MODE: 'true', MIN_GRADE: '1',
      MAX_CONCURRENT_POSITIONS: '2', MAX_CONCURRENT_CEILING: '2', OVERFLOW_POSITIONS: '1',
      DAILY_LOSS_LIMIT_USDT: '200',
      OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p',
      EXECUTOR_WEBHOOK_SECRET: 'a'.repeat(24), EXECUTOR_CONTROL_SECRET: 'b'.repeat(24),
    }, extra || {});
    for (const m of ['../src/config', '../src/executor', '../src/exchanges/okx',
      '../src/symbols', '../src/risk']) delete require.cache[require.resolve(m)];
    const okx = require('../src/exchanges/okx');
    const symbols = require('../src/symbols');
    symbols.reset();
    symbols.install({ allowed: ['BTCUSDT.P', 'ETHUSDT.P', 'SOLUSDT.P', 'LINKUSDT.P'], specs: {} });
    const placed = [];
    okx.placeOrder = async (p) => { placed.push(p.instId); return { sent: true, request: {}, response: { code: '0' } }; };
    okx.ensureLeverage = async () => {};
    okx.verifyProtection = async () => ({ ok: true, found: true });
    okx.fetchTicker = async () => ({ last: 84000 });
    return { placed };
  }

  function sig(n, symbol) {
    return {
      v: '11.9', sig_id: 'OVERFLOW-TEST-' + n, symbol: symbol || 'BTCUSDT.P', tf: '15',
      side: 'long', grade: 3, score: 85,
      entry: 84000, sl: 83500, tp: [84500, 85000, 85500], ts: Date.now(), notify: false,
    };
  }

  function fill(store, n) {
    for (let i = 0; i < n; i++) {
      store.addPosition('old-' + i, { symbol: 'X' + i + 'USDT.P', exchange: 'okx', side: 'long' });
    }
  }

  await ck('達上限、只有持倉上限擋住 → auto 模式也改成超額待確認', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf1-'));
    const { placed } = env(dir);
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const store = new Store(dir);
    fill(store, 2);
    const r = await handleSignal(sig(1), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'pending', `應為 pending，實際 ${r.decision}：${(r.reasons || []).join('；')}`);
    assert.ok(r.overLimit, '要帶 overLimit');
    assert.strictEqual(r.overLimit.openCount, 2);
    assert.strictEqual(r.overLimit.hardCap, 3);
    assert.ok(r.sizing && r.sizing.orderQty > 0, '超額卡片也要算出倉位');
    assert.strictEqual(placed.length, 0, '超額單不得自動下單');
  });

  await ck('按下超額進場 → 以硬上限重查並下單', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf2-'));
    const { placed } = env(dir);
    const { config } = require('../src/config');
    const { handleSignal, confirmSignal } = require('../src/executor');
    const store = new Store(dir);
    fill(store, 2);
    await handleSignal(sig(2), { config, store, suppressNotify: true });
    const c = await confirmSignal('OVERFLOW-TEST-2', { config, store, suppressNotify: true });
    assert.strictEqual(c.decision, 'placed', `確認應下單，實際 ${c.decision}：${(c.reasons || []).join('；')}`);
    assert.strictEqual(placed.length, 1);
    assert.strictEqual(store.openPositionCount('okx'), 3);
  });

  await ck('已達硬上限 → 一般拒絕，不給超額按鈕', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf3-'));
    env(dir);
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const store = new Store(dir);
    fill(store, 3);
    const r = await handleSignal(sig(3), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(!r.overLimit);
  });

  await ck('確認前額度被別筆用掉 → 確認時被硬上限擋下', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf4-'));
    const { placed } = env(dir);
    const { config } = require('../src/config');
    const { handleSignal, confirmSignal } = require('../src/executor');
    const store = new Store(dir);
    fill(store, 2);
    await handleSignal(sig(4), { config, store, suppressNotify: true });
    store.addPosition('late', { symbol: 'LATEUSDT.P', exchange: 'okx', side: 'long' });
    const c = await confirmSignal('OVERFLOW-TEST-4', { config, store, suppressNotify: true });
    assert.strictEqual(c.decision, 'rejected', '按下去的當下已滿到硬上限');
    assert.strictEqual(placed.length, 0);
  });

  await ck('同時有其他閘門失敗（同標的重複）→ 不給超額', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf5-'));
    env(dir);
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const store = new Store(dir);
    fill(store, 1);
    store.addPosition('dup', { symbol: 'BTCUSDT.P', exchange: 'okx', side: 'long' });
    const r = await handleSignal(sig(5), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(!r.overLimit, '重複持倉不能用按鈕繞過');
  });

  await ck('OVERFLOW_POSITIONS=0 → 回到舊行為，直接拒絕', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf6-'));
    env(dir, { OVERFLOW_POSITIONS: '0' });
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const store = new Store(dir);
    fill(store, 2);
    const r = await handleSignal(sig(6), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(!r.overLimit);
  });

  await ck('未達上限 → 照常自動下單，不帶 overLimit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf7-'));
    const { placed } = env(dir);
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const store = new Store(dir);
    fill(store, 1);
    const r = await handleSignal(sig(7), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'placed');
    assert.ok(!r.overLimit);
    assert.strictEqual(placed.length, 1);
  });

  if (fails.length) {
    console.error(`✗ ${fails.length} 失敗，${pass} 通過`);
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`殘留與超額測試：通過 ${pass} 項`);
})();
