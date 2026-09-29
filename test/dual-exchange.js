'use strict';
/**
 * 雙邊下單的測試。
 *
 * 這一組守的是三件會讓實際曝險與預期不符的事：
 *   1. 冪等與持倉額度必須按交易所分開算，否則第二家永遠下不了單
 *   2. 單邊失敗時必須看得出「只成交一家」—— 那時曝險只有預期的一半
 *   3. 對帳必須兩家都跑，否則另一家的部位永遠不會結算
 *
 * 前兩件錯了不會有錯誤訊息，只會讓你以為部位是你以為的那個大小。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshEnv(dir) {
  Object.assign(process.env, {
    DATA_DIR: dir,
    EXCHANGES: 'okx,bingx',
    EXECUTION_MODE: 'auto',
    DRY_RUN: 'false',
    DEMO_MODE: 'true',
    MIN_GRADE: '1',
    MAX_CONCURRENT_POSITIONS: '1',
    DAILY_LOSS_LIMIT_USDT: '200',
    OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p',
    BINGX_API_KEY: 'bk', BINGX_API_SECRET: 'bs',
    EXECUTOR_WEBHOOK_SECRET: 'a'.repeat(24),
    EXECUTOR_CONTROL_SECRET: 'b'.repeat(24),
  });
  for (const m of ['../src/config', '../src/executor', '../src/exchanges/okx',
    '../src/exchanges/bingx', '../src/symbols']) {
    delete require.cache[require.resolve(m)];
  }
}

function sig(n) {
  return {
    v: '11.8',
    sig_id: 'BTCUSDT.P-15-dual' + n + '-long',
    symbol: 'BTCUSDT.P', tf: '15', side: 'long', grade: 3, score: 85,
    entry: 84000, sl: 83500, tp: [84500, 85000, 85500],
    ts: Date.now(), notify: false,
  };
}

(async function run() {

  // ── 一筆訊號要在兩家各下一單 ───────────────────────────
  await ck('同一筆訊號在兩家各成交一次', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual1-'));
    freshEnv(dir);
    const okx = require('../src/exchanges/okx');
    const bingx = require('../src/exchanges/bingx');
    const symbols = require('../src/symbols');
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const { Store } = require('../src/store');

    // 兩家都要有 BTC 的規格 —— BingX 的欄位名與 OKX 不同
    symbols.reset();
    symbols.install({ allowed: ['BTCUSDT.P'], specs: {} });

    const calls = { okx: 0, bingx: 0 };
    okx.placeOrder = async () => {
      calls.okx += 1; return { sent: true, request: {}, response: { code: '0' } };
    };
    bingx.placeOrder = async () => {
      calls.bingx += 1; return { sent: true, request: {}, response: { code: 0 } };
    };
    okx.fetchTicker = async () => ({ last: 84000 });

    const store = new Store(dir);
    const r = await handleSignal(sig(1), { config, store, suppressNotify: true });

    assert.strictEqual(calls.okx, 1, 'OKX 應下一次單');
    assert.strictEqual(calls.bingx, 1,
      `BingX 應下一次單，實際 ${calls.bingx} —— 冪等若只看 sig_id 就會擋掉它`);
    assert.strictEqual(r.decision, 'placed');
    assert.strictEqual(r.partial, false, '兩家都成了就不算部分成功');
    assert.strictEqual(store.listPositions().length, 2, '兩家各一個部位');
    assert.strictEqual(store.listPositions('okx').length, 1);
    assert.strictEqual(store.listPositions('bingx').length, 1);
  });

  // ── 持倉額度按交易所分開算 ─────────────────────────────
  await ck('MAX_CONCURRENT=1 時兩家各可持有一個部位', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual2-'));
    freshEnv(dir);
    const okx = require('../src/exchanges/okx');
    const bingx = require('../src/exchanges/bingx');
    const symbols = require('../src/symbols');
    const { config } = require('../src/config');
    const { Store } = require('../src/store');
    symbols.reset();
    symbols.install({ allowed: ['BTCUSDT.P'], specs: {} });

    const store = new Store(dir);
    store.addPosition('x1', { symbol: 'BTCUSDT.P', exchange: 'okx' });
    // 合起來算的話這裡會是 1（已滿）；分開算的話 bingx 仍是 0
    assert.strictEqual(store.openPositionCount('okx'), 1);
    assert.strictEqual(store.openPositionCount('bingx'), 0,
      'BingX 的額度不該被 OKX 的部位吃掉');
    assert.strictEqual(store.openPositionCount(), 1, '不給交易所時算全部');
    assert.strictEqual(store.hasPositionForSymbol('BTCUSDT.P', 'bingx'), false,
      '跨交易所的同標的是刻意允許的 —— 那正是雙邊下單的意思');
  });

  // ── 單邊失敗 ───────────────────────────────────────────
  await ck('BingX 失敗時 OKX 照下，並標記為部分成功', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual3-'));
    freshEnv(dir);
    const okx = require('../src/exchanges/okx');
    const bingx = require('../src/exchanges/bingx');
    const symbols = require('../src/symbols');
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const { Store } = require('../src/store');
    symbols.reset();
    symbols.install({ allowed: ['BTCUSDT.P'], specs: {} });

    let okxCalls = 0;
    okx.placeOrder = async () => {
      okxCalls += 1; return { sent: true, request: {}, response: { code: '0' } };
    };
    bingx.placeOrder = async () => { throw new Error('BingX 限流'); };
    okx.fetchTicker = async () => ({ last: 84000 });

    const store = new Store(dir);
    const r = await handleSignal(sig(3), { config, store, suppressNotify: true });

    assert.strictEqual(okxCalls, 1, 'OKX 不該因為 BingX 失敗而不下單');
    assert.strictEqual(r.partial, true, '必須標記為部分成功');
    assert.ok((r.reasons || []).join('').includes('一半'),
      '理由要講出「實際曝險為預期的一半」：' + JSON.stringify(r.reasons));
    assert.strictEqual(store.listPositions('okx').length, 1);
    assert.strictEqual(store.listPositions('bingx').length, 0);
    // BingX 的意圖要留著給對帳查 —— 那筆可能其實成交了
    assert.strictEqual(store.listIntents('bingx').length, 1,
      '失敗那邊的意圖必須留著，它可能已經送達交易所');
  });

  // ── 對帳兩家都要跑 ─────────────────────────────────────
  await ck('對帳只處理自己那一家的部位', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual4-'));
    freshEnv(dir);
    const symbols = require('../src/symbols');
    symbols.reset();
    symbols.install({ allowed: ['BTCUSDT.P'], specs: {} });
    const { reconcileOnce } = require('../src/reconcile');
    const { Store } = require('../src/store');

    const store = new Store(dir);
    const T0 = Date.parse('2026-09-26T00:00:00Z');
    for (const ex of ['okx', 'bingx']) {
      store.addPosition('s1', {
        symbol: 'BTCUSDT.P', exchange: ex, side: 'long',
        entry: 84000, sl: 83500, tp: [84500], orderQty: 1, baseQty: 0.01,
        clientOrderId: 'c-' + ex,
      });
      store.state.positions[ex + ':s1'].openedAt = new Date(T0).toISOString();
    }
    store.save();
    assert.strictEqual(store.listPositions().length, 2);

    // 只有 OKX 那邊平倉了
    const hist = {
      instId: 'BTC-USDT-SWAP', posSide: 'long', openAvgPx: 84000,
      closeAvgPx: 84500, realizedPnl: 19.25, pnl: 23.75, fee: -4, fundingFee: -0.5,
      closeType: '2', openedAtMs: T0, closedAtMs: T0 + 600000,
    };
    const ex = {
      async fetchPositions() { return []; },
      async fetchPositionsHistory() { return [hist]; },
      async fetchOrderByClOrdId() { return null; },
    };
    const r = await reconcileOnce({
      config: { okx: {}, bingx: {}, demo: true }, store,
      exchange: ex, exchangeName: 'okx', now: T0 + 7200000,
    });

    assert.strictEqual(r.exchange, 'okx');
    assert.strictEqual(r.closed.length, 1);
    assert.strictEqual(r.closed[0].exchange, 'okx');
    assert.strictEqual(store.listPositions('okx').length, 0, 'OKX 那筆應被結算');
    assert.strictEqual(store.listPositions('bingx').length, 1,
      'BingX 那筆不該被 OKX 的對帳動到 —— 它得等自己那一輪');
  });

  // ── manual 模式：兩家各一筆待確認，一個按鈕確認兩家 ──────
  await ck('manual 模式下兩家各存一筆待確認，不互相覆寫', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualm-'));
    freshEnv(dir);
    process.env.EXECUTION_MODE = 'manual';
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/executor')];
    const symbols = require('../src/symbols');
    symbols.reset();
    symbols.install({ allowed: ['BTCUSDT.P'], specs: {} });
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const { Store } = require('../src/store');

    const store = new Store(dir);
    await handleSignal(sig(10), { config, store, suppressNotify: true });

    const all = store.listPendings();
    assert.strictEqual(all.length, 2,
      `兩家各一筆，實際 ${all.length} —— 少了就是後者覆寫了前者，曝險只有一半`);
    assert.deepStrictEqual(all.map((p) => p.exchange).sort(), ['bingx', 'okx']);
    assert.strictEqual(store.listPendings('okx').length, 1);
  });

  await ck('一個按鈕確認兩家', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualc-'));
    freshEnv(dir);
    process.env.EXECUTION_MODE = 'manual';
    process.env.DRIFT_CHECK = 'false';   // 漂移另外測，這裡只驗確認流程
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/executor')];
    const okx = require('../src/exchanges/okx');
    const bingx = require('../src/exchanges/bingx');
    const symbols = require('../src/symbols');
    symbols.reset();
    symbols.install({ allowed: ['BTCUSDT.P'], specs: {} });
    const { config } = require('../src/config');
    const { handleSignal, confirmSignal } = require('../src/executor');
    const { Store } = require('../src/store');

    const calls = { okx: 0, bingx: 0 };
    okx.placeOrder = async () => {
      calls.okx += 1; return { sent: true, request: {}, response: { code: '0' } };
    };
    bingx.placeOrder = async () => {
      calls.bingx += 1; return { sent: true, request: {}, response: { code: 0 } };
    };
    okx.fetchTicker = async () => ({ last: 84000 });
    bingx.fetchTicker = async () => ({ last: 84000 });

    const store = new Store(dir);
    const a = await handleSignal(sig(11), { config, store, suppressNotify: true });
    const r = await confirmSignal(a.sigId, { config, store, suppressNotify: true });

    assert.strictEqual(calls.okx, 1, 'OKX 應下單');
    assert.strictEqual(calls.bingx, 1,
      `BingX 應下單，實際 ${calls.bingx} —— 一個按鈕必須確認兩家`);
    assert.strictEqual(r.decision, 'placed');
    assert.strictEqual(store.listPendings().length, 0, '兩筆都該結案');
  });

  // ── sig_id 含冒號：舊鍵解析錯會讓損益重複入帳 ────────────
  await ck('sig_id 含冒號時，部位的新增與刪除必須一致', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualk-'));
    freshEnv(dir);
    const { Store } = require('../src/store');
    const store = new Store(dir);
    const weird = 'vegas:BTCUSDT.P:15:long';

    store.addPosition(weird, { symbol: 'BTCUSDT.P', exchange: 'okx' });
    const listed = store.listPositions();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].sigId, weird,
      `sigId 解析錯了：${listed[0].sigId} —— 用 indexOf(':') 切鍵會切在 sig_id 裡面`);

    assert.strictEqual(store.removePosition(listed[0].sigId, listed[0].exchange), true,
      '刪不掉的話部位會永遠卡著，而損益每輪重記一次');
    assert.strictEqual(store.listPositions().length, 0);
  });

  await ck('舊格式的鍵（含冒號）仍然讀得到也刪得掉', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dualo-'));
    freshEnv(dir);
    const { Store } = require('../src/store');
    const store = new Store(dir);
    // 直接寫入舊格式（沒有交易所前綴），模擬部署前留下的狀態
    store.state.positions['vegas:BTC:15'] = {
      symbol: 'BTCUSDT.P', side: 'long', openedAt: new Date().toISOString(),
    };
    store.save();

    const listed = store.listPositions();
    assert.strictEqual(listed[0].sigId, 'vegas:BTC:15', listed[0].sigId);
    assert.strictEqual(listed[0].exchange, 'okx', '舊資料預設視為 OKX');
    assert.strictEqual(store.removePosition('vegas:BTC:15', 'okx'), true);
  });

  await ck('刪不掉時要回報失敗，不可靜默', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duald-'));
    freshEnv(dir);
    const { Store } = require('../src/store');
    const store = new Store(dir);
    assert.strictEqual(store.removePosition('不存在的', 'okx'), false,
      '靜默回傳 undefined 的話，對帳會以為刪成功而繼續記損益');
  });

  // ── 平倉卡片要講出是哪一家 ─────────────────────────────
  await ck('平倉卡片標明交易所', async () => {
    const { renderClosedCard } = require('../src/reconcile');
    const text = renderClosedCard({
      symbol: 'BTCUSDT.P', side: 'long', win: true, exchange: 'bingx',
      openAvgPx: 84000, closeAvgPx: 84500,
      pnlUsdt: 19.25, grossPnlUsdt: 23.75, feeUsdt: -4, fundingUsdt: -0.5,
      reason: '平倉',
    });
    assert.ok(text.includes('BINGX'),
      '雙邊下單時「哪一家平的」是必要資訊：' + text.split('\n')[0]);
  });

  console.log(`雙邊下單測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
  if (fails.length) {
    console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
    process.exit(1);
  }
})();
