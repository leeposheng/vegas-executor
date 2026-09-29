'use strict';
/**
 * 併發測試。
 *
 * 重現的是一個實測出來的缺陷，不是假想的：
 * MAX_CONCURRENT_POSITIONS=1 時同時送四筆訊號，四筆全部成交 ——
 * 因為風控讀 store、寫回卻在交易所回應之後，中間三個 await 都是窗口。
 *
 * 這一組測試的價值在於「它以前會失敗」。若哪天有人把序列化拿掉，
 * 這裡會立刻紅。
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Gate } = require('../src/serialize');

let pass = 0;
const fails = [];
async function ck(name, fn) {
  try { await fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {

  // ── 閘本身 ─────────────────────────────────────────────
  await ck('同時丟進去的工作不會交錯執行', async () => {
    const gate = new Gate();
    const trace = [];
    const work = (id) => gate.run(async () => {
      trace.push('start' + id);
      await sleep(20);
      trace.push('end' + id);
    });
    await Promise.all([work(1), work(2), work(3)]);
    // 交錯的話會出現 start1,start2,... 這種排列
    assert.strictEqual(trace.join(','),
      'start1,end1,start2,end2,start3,end3', trace.join(','));
  });

  await ck('前一筆失敗不會拖垮後面的', async () => {
    const gate = new Gate();
    const first = gate.run(async () => { throw new Error('炸了'); });
    await first.catch(() => {});
    const second = await gate.run(async () => 'ok');
    assert.strictEqual(second, 'ok', '佇列必須繼續動');
  });

  await ck('排隊過久要拒絕，不可無限等待', async () => {
    const gate = new Gate({ maxWaitMs: 50, maxRunMs: 5000 });
    const slow = gate.run(() => sleep(300));
    await sleep(10);
    let caught = null;
    await gate.run(async () => 'never').catch((e) => { caught = e; });
    await slow;
    assert.ok(caught, '第二筆應該被拒絕');
    assert.strictEqual(caught.code, 'gate_timeout');
    assert.ok(caught.message.includes('排隊'), caught.message);
  });

  await ck('單筆執行過久要中止，不可鎖死整條路徑', async () => {
    const gate = new Gate({ maxWaitMs: 5000, maxRunMs: 60 });
    let caught = null;
    await gate.run(() => sleep(500), '假裝卡住').catch((e) => { caught = e; });
    assert.ok(caught && caught.code === 'run_timeout', String(caught));
    assert.ok(caught.message.includes('交易所確認'),
      '訊息要告訴使用者去交易所查，因為單可能已經送出了');
  });

  await ck('排隊中就被拒的工作，不可說成「可能已送出」', async () => {
    const gate = new Gate({ maxWaitMs: 20, maxRunMs: 60 });
    // 立刻掛上 handler：A 會在 60ms 逾時，晚接會變成 unhandled rejection
    const busy = gate.run(() => sleep(200), 'A').catch(() => {});
    await sleep(5);
    let caught = null;
    await gate.run(async () => 'never', 'B').catch((e) => { caught = e; });
    await busy;
    assert.strictEqual(caught.code, 'gate_timeout',
      'B 連跑都沒跑過，不該拿到 run_timeout 那則「去交易所確認」的訊息');
    assert.ok(!caught.message.includes('交易所確認'), caught.message);
  });

  // ── 逾時之後佇列不得放行 ────────────────────────────────
  //
  // 這一項守的是一個改對過一次、又很容易改回去的地方：
  // 若 tail 鏈在 Promise.race 的結果上，逾時會讓佇列提早放行，
  // 而被包住的工作還在背景跑 —— 兩者交錯，序列化整個失效，
  // 而且失效的時機正是「交易所沒回應」這個最該生效的時候。
  await ck('單筆逾時後，下一筆不得在它結束前開始', async () => {
    const gate = new Gate({ maxWaitMs: 5000, maxRunMs: 40 });
    const trace = [];
    const slow = gate.run(async () => {
      trace.push('A進入');
      await sleep(200);
      trace.push('A寫回');       // 模擬 store.addPosition
    }, 'A');
    await slow.catch(() => trace.push('A逾時回覆'));

    await gate.run(async () => {
      trace.push('B檢查');       // 模擬 risk.evaluate 讀 store
      trace.push('B寫回');
    }, 'B');

    const order = trace.join(',');
    assert.ok(order.indexOf('A寫回') < order.indexOf('B檢查'),
      'B 不可以在 A 寫回之前就開始檢查：' + order);
  });

  await ck('逾時的錯誤要能讓呼叫端分辨「可能已送出」', async () => {
    const gate = new Gate({ maxWaitMs: 5000, maxRunMs: 30 });
    let caught = null;
    await gate.run(() => sleep(200)).catch((e) => { caught = e; });
    assert.strictEqual(caught.code, 'run_timeout');
    // 排隊被拒的那種則是確定沒送出
    const gate2 = new Gate({ maxWaitMs: 20, maxRunMs: 5000 });
    const busy = gate2.run(() => sleep(200));
    await sleep(5);
    let c2 = null;
    await gate2.run(async () => 'x').catch((e) => { c2 = e; });
    await busy;
    assert.strictEqual(c2.code, 'gate_timeout');
  });

  // ── 真正的回歸測試：透過 handleSignal 走完整條路徑 ──────
  await ck('同時送四筆訊號，MAX_CONCURRENT=1 只會成交一筆', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-'));
    process.env.DATA_DIR = dir;
    process.env.MAX_CONCURRENT_POSITIONS = '1';
    process.env.EXECUTION_MODE = 'auto';
    process.env.DRY_RUN = 'false';
    process.env.DEMO_MODE = 'true';
    process.env.MIN_GRADE = '1';
    process.env.OKX_API_KEY = 'k';
    process.env.OKX_API_SECRET = 's';
    process.env.OKX_PASSPHRASE = 'p';
    process.env.EXECUTOR_WEBHOOK_SECRET = 'a'.repeat(24);
    process.env.EXECUTOR_CONTROL_SECRET = 'b'.repeat(24);

    // 必須在設定好環境變數之後才 require
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/executor')];
    delete require.cache[require.resolve('../src/exchanges/okx')];
    const okx = require('../src/exchanges/okx');
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const { Store } = require('../src/store');

    // 換掉會連網的部分。placeOrder 故意慢 —— 窗口就是在這段時間打開的。
    let placeCalls = 0;
    okx.placeOrder = async (params) => {
      placeCalls += 1;
      await sleep(120);
      return { sent: true, request: { instId: params.instId }, response: { code: '0' } };
    };
    okx.fetchTicker = async () => ({ last: 84000 });

    const store = new Store(dir);
    const mk = (n) => ({
      v: '11.8',
      sig_id: 'BTCUSDT.P-15-conc' + n + '-long',
      symbol: 'BTCUSDT.P', tf: '15', side: 'long', grade: 3, score: 85,
      entry: 84000, sl: 83500, tp: [84500, 85000, 85500],
      ts: Date.now(),
      notify: false,
    });

    const results = await Promise.all([1, 2, 3, 4].map(
      (n) => handleSignal(mk(n), { config, store, suppressNotify: true })
    ));

    const placed = results.filter((r) => r.decision === 'placed');
    assert.strictEqual(placed.length, 1,
      `只該成交一筆，實際 ${placed.length} 筆；placeOrder 被呼叫 ${placeCalls} 次`);
    assert.strictEqual(placeCalls, 1, `placeOrder 只該被呼叫一次，實際 ${placeCalls} 次`);
    assert.strictEqual(store.listPositions().length, 1);

    const blocked = results.filter((r) => r.decision === 'rejected');
    assert.strictEqual(blocked.length, 3, '其餘三筆應被風控擋下');
    assert.ok(blocked.every((r) => (r.reasons || []).join('').includes('持倉')),
      '拒絕理由應是持倉上限：' + JSON.stringify(blocked.map((r) => r.reasons)));
  });

  await ck('同幣種不同 sig_id 併發，只會開一個部位', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conc2-'));
    process.env.DATA_DIR = dir;
    process.env.MAX_CONCURRENT_POSITIONS = '5';   // 放寬，只留同幣種那道閘

    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/executor')];
    delete require.cache[require.resolve('../src/exchanges/okx')];
    const okx = require('../src/exchanges/okx');
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const { Store } = require('../src/store');

    let placeCalls = 0;
    okx.placeOrder = async (params) => {
      placeCalls += 1;
      await sleep(100);
      return { sent: true, request: { instId: params.instId }, response: { code: '0' } };
    };
    okx.fetchTicker = async () => ({ last: 84000 });

    const store = new Store(dir);
    const mk = (n) => ({
      v: '11.8',
      sig_id: 'BTCUSDT.P-15-dup' + n + '-long',
      symbol: 'BTCUSDT.P', tf: '15', side: 'long', grade: 3, score: 85,
      entry: 84000, sl: 83500, tp: [84500, 85000, 85500],
      ts: Date.now(), notify: false,
    });

    const results = await Promise.all([1, 2].map(
      (n) => handleSignal(mk(n), { config, store, suppressNotify: true })
    ));
    assert.strictEqual(placeCalls, 1,
      `同幣種只該下一次單，實際 ${placeCalls} 次 —— 風險會是預期的兩倍`);
    assert.strictEqual(results.filter((r) => r.decision === 'placed').length, 1);
  });

  // ── 下單例外之後，意圖必須留在磁碟上 ────────────────────
  await ck('下單拋例外時意圖要留著，供對帳反查', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-'));
    process.env.DATA_DIR = dir;
    process.env.MAX_CONCURRENT_POSITIONS = '3';

    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/executor')];
    delete require.cache[require.resolve('../src/exchanges/okx')];
    const okx = require('../src/exchanges/okx');
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const { Store } = require('../src/store');

    // 模擬「請求送出了，但回應在半路不見」
    okx.placeOrder = async () => { throw new Error('socket hang up'); };
    okx.fetchTicker = async () => ({ last: 84000 });

    const store = new Store(dir);
    const r = await handleSignal({
      v: '11.8', sig_id: 'BTCUSDT.P-15-intent1-long',
      symbol: 'BTCUSDT.P', tf: '15', side: 'long', grade: 3, score: 85,
      entry: 84000, sl: 83500, tp: [84500, 85000, 85500],
      ts: Date.now(), notify: false,
    }, { config, store, suppressNotify: true });

    assert.strictEqual(r.decision, 'error');
    assert.strictEqual(r.unconfirmed, true, '要標記成「結果未確認」');
    assert.strictEqual(store.listIntents().length, 1,
      '意圖必須留著 —— 這是唯一能查出那筆到底成交沒的線索');

    // 而且必須是「已經落地的」，不是只存在記憶體裡
    const reloaded = new Store(dir);
    assert.strictEqual(reloaded.listIntents().length, 1,
      '意圖必須在呼叫交易所之前就寫進檔案，行程死掉才救得回來');
    assert.strictEqual(reloaded.listIntents()[0].clOrdId, r.clientOrderId);
  });

  await ck('下單成功時意圖要清掉', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intent2-'));
    process.env.DATA_DIR = dir;

    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/executor')];
    delete require.cache[require.resolve('../src/exchanges/okx')];
    const okx = require('../src/exchanges/okx');
    const { config } = require('../src/config');
    const { handleSignal } = require('../src/executor');
    const { Store } = require('../src/store');

    okx.placeOrder = async () => ({ sent: true, request: {}, response: { code: '0' } });
    okx.fetchTicker = async () => ({ last: 84000 });

    const store = new Store(dir);
    await handleSignal({
      v: '11.8', sig_id: 'BTCUSDT.P-15-intent2-long',
      symbol: 'BTCUSDT.P', tf: '15', side: 'long', grade: 3, score: 85,
      entry: 84000, sl: 83500, tp: [84500, 85000, 85500],
      ts: Date.now(), notify: false,
    }, { config, store, suppressNotify: true });

    assert.strictEqual(store.listIntents().length, 0, '正常路徑不該留下意圖');
    assert.strictEqual(store.listPositions().length, 1);
  });

  console.log(`併發測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
  if (fails.length) {
    console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
    process.exit(1);
  }
})();
