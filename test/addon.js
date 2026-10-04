'use strict';
/**
 * 加倉模式的測試。全部不連網。
 *
 * 守的是五件事：
 *   1. 同幣同向、交易所確有浮盈部位 → 改成加倉待確認（auto 也一樣要按）
 *   2. 加倉以原部位的實際槓桿計算，不跑自動槓桿
 *      （逐倉下改在場部位的槓桿，等於改了原部位的強平價）
 *   3. 成交後記成原部位的一層，不另開一筆 —— 否則對帳會讓兩筆紀錄
 *      認領同一筆平倉紀錄，損益算兩次
 *   4. 反向、虧損中、交易所查無部位、次數用完 → 不加倉，並說明原因
 *   5. 加倉不佔新的持倉額度
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

function env(dir, extra) {
  Object.assign(process.env, {
    DATA_DIR: dir, EXCHANGES: 'okx', EXECUTION_MODE: 'auto',
    DRY_RUN: 'false', DEMO_MODE: 'true', MIN_GRADE: '1',
    MAX_CONCURRENT_POSITIONS: '3', MAX_CONCURRENT_CEILING: '3', OVERFLOW_POSITIONS: '0',
    ADDON_MAX: '1', ADDON_REQUIRE_PROFIT: 'true',
    DAILY_LOSS_LIMIT_USDT: '200',
    OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p',
    EXECUTOR_WEBHOOK_SECRET: 'a'.repeat(24), EXECUTOR_CONTROL_SECRET: 'b'.repeat(24),
  }, extra || {});
  for (const m of ['../src/config', '../src/executor', '../src/exchanges/okx',
    '../src/symbols', '../src/risk', '../src/reconcile']) {
    delete require.cache[require.resolve(m)];
  }
  const okx = require('../src/exchanges/okx');
  const symbols = require('../src/symbols');
  symbols.reset();
  symbols.install({ allowed: ['BTCUSDT.P', 'ETHUSDT.P'], specs: {} });
  const calls = { placed: [], leverage: [] };
  // 交易所上的部位，各測試可改
  const live = { list: [{ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: 5, upl: 12.5, lever: 20 }] };
  okx.placeOrder = async (p) => { calls.placed.push(p); return { sent: true, request: {}, response: { code: '0' } }; };
  okx.ensureLeverage = async (p) => { calls.leverage.push(p.leverage); };
  okx.fetchTicker = async () => ({ last: 84000 });
  okx.fetchPositions = async () => {
    if (live.throw) throw new Error(live.throw);
    return live.list;
  };
  return { calls, live };
}

function sig(n, side) {
  const long = (side || 'long') === 'long';
  return {
    v: '11.9', sig_id: 'ADDON-TEST-' + n, symbol: 'BTCUSDT.P', tf: '15',
    side: long ? 'long' : 'short', grade: 3, score: 85,
    entry: 84000, sl: long ? 83500 : 84500,
    tp: long ? [84500, 85000, 85500] : [83500, 83000, 82500],
    ts: Date.now(), notify: false,
  };
}

function base(store, side) {
  store.addPosition('BASE-POSITION-1', {
    symbol: 'BTCUSDT.P', exchange: 'okx', side: side || 'long',
    entry: 83000, sl: 82500, tp: [83500], orderQty: 5, leverage: 20,
  });
}

function load() {
  const { config } = require('../src/config');
  const { handleSignal, confirmSignal } = require('../src/executor');
  const { Store } = require('../src/store');
  return { config, handleSignal, confirmSignal, Store };
}

(async function run() {

  await ck('同幣同向、浮盈 → 加倉待確認（auto 也不自動下單）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add1-'));
    const { calls } = env(dir);
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    const r = await handleSignal(sig(1), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'pending', `應為 pending，實際 ${r.decision}：${(r.reasons || []).join('；')}`);
    assert.ok(r.addOn, '要帶 addOn');
    assert.strictEqual(r.addOn.layerNo, 1);
    assert.strictEqual(r.addOn.baseSigId, 'BASE-POSITION-1');
    assert.strictEqual(calls.placed.length, 0, '加倉不得自動下單');
  });

  await ck('加倉以原部位的實際槓桿計算（交易所回報 20x）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add2-'));
    env(dir, { SIZING_MODE: 'fixed_margin', LEVERAGE: '40', AUTO_LEVERAGE: 'true',
      FIXED_MARGIN_USDT: '100', TARGET_LOSS_MIN_USDT: '1', TARGET_LOSS_MAX_USDT: '500',
      MAX_NOTIONAL_USDT: '50000', OKX_TD_MODE: 'isolated' });
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    const r = await handleSignal(sig(2), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'pending', (r.reasons || []).join('；'));
    assert.strictEqual(r.sizing.leverage, 20,
      `應沿用原部位的 20x，實際 ${r.sizing.leverage}x —— 跑了自動槓桿會改到原部位的強平價`);
  });

  await ck('按下加倉 → 下單並記成原部位的一層，部位數不變', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add3-'));
    const { calls } = env(dir);
    const { config, handleSignal, confirmSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    await handleSignal(sig(3), { config, store, suppressNotify: true });
    const c = await confirmSignal('ADDON-TEST-3', { config, store, suppressNotify: true });
    assert.strictEqual(c.decision, 'placed', `應下單，實際 ${c.decision}：${(c.reasons || []).join('；')}`);
    assert.strictEqual(calls.placed.length, 1);
    const ps = store.listPositions('okx');
    assert.strictEqual(ps.length, 1, '不得另開一筆部位紀錄');
    assert.strictEqual((ps[0].layers || []).length, 1, '要記成原部位的一層');
    assert.strictEqual(ps[0].layers[0].sigId, 'ADDON-TEST-3');
    assert.strictEqual(store.openPositionCount('okx'), 1, '加倉不佔新的持倉額度');
  });

  await ck('加倉次數用完 → 拒絕並說明', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add4-'));
    env(dir);
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    store.addLayer('BASE-POSITION-1', 'okx', { sigId: 'L1' });
    const r = await handleSignal(sig(4), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(r.reasons.join(' ').includes('達上限'), r.reasons.join('；'));
  });

  await ck('反向訊號 → 不加倉', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add5-'));
    env(dir);
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store, 'long');
    const r = await handleSignal(sig(5, 'short'), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(!r.addOn);
    assert.ok(r.reasons.join(' ').includes('反向不加倉'), r.reasons.join('；'));
  });

  await ck('既有部位虧損中 → 不加倉', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add6-'));
    const { live } = env(dir);
    live.list[0].upl = -8;
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    const r = await handleSignal(sig(6), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(r.reasons.join(' ').includes('未獲利'), r.reasons.join('；'));
  });

  await ck('ADDON_REQUIRE_PROFIT=false → 虧損中也給加倉', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add7-'));
    const { live } = env(dir, { ADDON_REQUIRE_PROFIT: 'false' });
    live.list[0].upl = -8;
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    const r = await handleSignal(sig(7), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'pending', (r.reasons || []).join('；'));
  });

  await ck('交易所查無部位（本地是殘留紀錄）→ 不加倉', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add8-'));
    const { live } = env(dir);
    live.list = [];
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    const r = await handleSignal(sig(8), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(r.reasons.join(' ').includes('查無'), r.reasons.join('；'));
  });

  await ck('持倉查詢失敗 → 不加倉（無法驗證的前提不算成立）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add9-'));
    const { live } = env(dir);
    live.throw = '限流';
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    const r = await handleSignal(sig(9), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
  });

  await ck('確認前原部位已平倉 → 確認時拒絕', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add10-'));
    const { calls, live } = env(dir);
    const { config, handleSignal, confirmSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    await handleSignal(sig(10), { config, store, suppressNotify: true });
    live.list = [];   // 卡片躺在手機上時，原部位止損出場了
    const c = await confirmSignal('ADDON-TEST-10', { config, store, suppressNotify: true });
    assert.strictEqual(c.decision, 'rejected');
    assert.strictEqual(calls.placed.length, 0);
  });

  await ck('ADDON_MAX=0 → 回到舊行為（同幣一律拒絕）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add11-'));
    env(dir, { ADDON_MAX: '0' });
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    const r = await handleSignal(sig(11), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(!r.addOn);
  });

  await ck('達持倉上限時仍可加倉（不佔新額度）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add12-'));
    env(dir, { MAX_CONCURRENT_POSITIONS: '1', MAX_CONCURRENT_CEILING: '1' });
    const { config, handleSignal, Store } = load();
    const store = new Store(dir);
    base(store);
    const r = await handleSignal(sig(12), { config, store, suppressNotify: true });
    assert.strictEqual(r.decision, 'pending', (r.reasons || []).join('；'));
    assert.ok(r.addOn);
  });

  await ck('對帳補登成交的加倉意圖 → 記成一層，不另開部位', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add13-'));
    env(dir);
    const { reconcileOnce } = require('../src/reconcile');
    const { Store } = require('../src/store');
    const store = new Store(dir);
    base(store);
    store.recordIntent('ADDON-LOST', {
      clOrdId: 'c-lost', instId: 'BTC-USDT-SWAP', symbol: 'BTCUSDT.P', side: 'long',
      exchange: 'okx', orderQty: 2, addOnTo: 'BASE-POSITION-1',
    });
    store.state.intents['okx:ADDON-LOST'].at = new Date(Date.now() - 10 * 60000).toISOString();
    store.save();
    assert.strictEqual(store.openPositionCount('okx'), 1, '加倉意圖不佔額度');
    const ex = {
      async fetchPositions() { return [{ instId: 'BTC-USDT-SWAP', pos: 7 }]; },
      async fetchPositionsHistory() { return []; },
      async fetchOrderByClOrdId() { return { state: 'filled', filledSz: 2, avgPx: 84000, createdAtMs: Date.now() - 600000 }; },
    };
    await reconcileOnce({ config: { okx: {}, demo: true }, store, exchange: ex });
    const ps = store.listPositions('okx');
    assert.strictEqual(ps.length, 1, '不得另開一筆（否則平倉時損益會算兩次）');
    assert.strictEqual((ps[0].layers || []).length, 1);
  });

  if (fails.length) {
    console.error(`✗ ${fails.length} 失敗，${pass} 通過`);
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`加倉測試：通過 ${pass} 項`);
})();
