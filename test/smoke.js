'use strict';
/**
 * 冒煙測試：不連網、不開伺服器，直接驗證核心邏輯。
 *
 * 這些案例的挑選標準是「出錯會賠錢」，而不是「覆蓋率好看」：
 * 方向反了、數量算錯、重複下單、簽章拼錯、風控失效。
 *
 * 執行：node test/smoke.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseSignal, clientOrderId } = require('../src/signal');
const { computeSize, floorToStep } = require('../src/sizing');
const symbols = require('../src/symbols');
const risk = require('../src/risk');
const { Store } = require('../src/store');
const okx = require('../src/exchanges/okx');
const bingx = require('../src/exchanges/bingx');
const { handleSignal, confirmSignal, skipSignal, redactRequest } = require('../src/executor');

let pass = 0, fail = 0;
function ck(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n       ' + err.message); }
}
async function ckAsync(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n       ' + err.message); }
}
const section = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 50 - t.length)));

const NOW = 1758470000000;
function sig(over) {
  return Object.assign({
    v: '11.8',
    sig_id: 'BTCUSDT.P-60-1758469980000-long',
    ts: NOW - 2000,
    symbol: 'BTCUSDT.P',
    tf: '60',
    grade: 3,
    score: 85,
    side: 'long',
    entry: 85397.5,
    sl: 85011.8,
    tp: [85783.2, 86169.0, 86554.7],
  }, over || {});
}
const parseOpts = { nowMs: NOW, maxAgeSec: 60 };

// ================================================================
section('訊號驗證');
// ================================================================
ck('合法訊號通過', () => {
  const r = parseSignal(sig(), parseOpts);
  assert(r.ok, JSON.stringify(r.errors));
  assert.strictEqual(r.signal.side, 'long');
  assert.ok(Math.abs(r.signal.riskDistance - 385.7) < 1e-6);
});

ck('做多但 SL 在上方 → 拒絕（方向寫反）', () => {
  const r = parseSignal(sig({ sl: 85800 }), parseOpts);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes('必須低於')));
});

ck('做空但 SL 在下方 → 拒絕', () => {
  const r = parseSignal(sig({
    side: 'short', entry: 85397.5, sl: 85011.8, tp: [85000, 84600, 84200],
  }), parseOpts);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes('必須高於')));
});

ck('合法做空訊號通過', () => {
  const r = parseSignal(sig({
    side: 'short', entry: 85397.5, sl: 85783.2, tp: [85011.8, 84626.1, 84240.4],
  }), parseOpts);
  assert(r.ok, JSON.stringify(r.errors));
});

ck('風險距離過小 → 拒絕', () => {
  const r = parseSignal(sig({ sl: 85397.0 }), parseOpts);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes('風險距離過小')));
});

ck('TP 在錯誤方向 → 拒絕', () => {
  const r = parseSignal(sig({ tp: [85000, 86169, 86554] }), parseOpts);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes('獲利方向')));
});

ck('TP 未由近而遠排序 → 拒絕', () => {
  const r = parseSignal(sig({ tp: [86554.7, 85783.2, 86169.0] }), parseOpts);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes('排序')));
});

ck('訊號過期 90 秒 → 拒絕（重放保護）', () => {
  const r = parseSignal(sig({ ts: NOW - 90000 }), parseOpts);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes('已過期')));
});

ck('時間戳在未來 → 拒絕', () => {
  const r = parseSignal(sig({ ts: NOW + 120000 }), parseOpts);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes('未來')));
});

ck('entry 為字串 → 拒絕（型別檢查）', () => {
  const r = parseSignal(sig({ entry: '85397.5' }), parseOpts);
  assert(!r.ok);
  assert(r.errors.some((e) => e.includes('entry')));
});

ck('缺少 sig_id → 拒絕', () => {
  const s = sig(); delete s.sig_id;
  assert(!parseSignal(s, parseOpts).ok);
});

ck('grade 為 4 → 拒絕', () => {
  assert(!parseSignal(sig({ grade: 4 }), parseOpts).ok);
});

ck('clientOrderId 符合 OKX 的 32 字元英數限制', () => {
  const id = clientOrderId('BTCUSDT.P-60-1758469980000-long', 'vg');
  assert.strictEqual(id.length, 32);
  assert(/^[A-Za-z0-9]{32}$/.test(id), id);
  assert.strictEqual(id, clientOrderId('BTCUSDT.P-60-1758469980000-long', 'vg'));
});

// ================================================================
section('倉位計算');
// ================================================================
const okxSpec = symbols.resolve('BTCUSDT.P', 'okx').spec;
const bingxSpec = symbols.resolve('BTCUSDT.P', 'bingx').spec;
const base = {
  equityUsdt: 10000, riskPct: 0.005,
  entry: 85397.5, sl: 85011.8,
  leverage: 5, maxNotionalUsdt: 50000,
};

ck('OKX：以張為單位，且已換算 ctVal', () => {
  const r = computeSize(Object.assign({}, base, { spec: okxSpec, exchange: 'okx' }));
  assert(r.ok, r.error);
  // 風險 50 USDT ÷ 385.7 = 0.129634 BTC ÷ ctVal 0.01 = 12.9634 張
  //   → 捨去到 lotSz 0.01 = 12.96 張 = 0.1296 BTC
  //   → 實際風險 49.9867 USDT（用量 99.97%）
  // 註：2026-09-24 以 npm run preflight 核實後，BTC 的 lotSz 由 0.1 修正為 0.01，
  //     期望值隨之改變。舊的 12.9 是建立在錯誤的規格上。
  assert.strictEqual(r.sizing.unit, 'contracts');
  assert.strictEqual(r.sizing.orderQty, 12.96);
  assert(Math.abs(r.sizing.baseQty - 0.1296) < 1e-9);
  console.log('       → ' + r.sizing.orderQty + ' 張 = ' + r.sizing.baseQty + ' BTC，'
    + '實際風險 ' + r.sizing.actualRiskUsdt + ' USDT');
});

ck('BingX：以幣為單位', () => {
  const r = computeSize(Object.assign({}, base, { spec: bingxSpec, exchange: 'bingx' }));
  assert(r.ok, r.error);
  assert.strictEqual(r.sizing.unit, 'base');
  assert.strictEqual(r.sizing.orderQty, 0.1296);
  console.log('       → ' + r.sizing.orderQty + ' BTC，實際風險 '
    + r.sizing.actualRiskUsdt + ' USDT');
});

ck('實際風險永不超過預算（只向下捨去）', () => {
  for (const ex of ['okx', 'bingx']) {
    const spec = ex === 'okx' ? okxSpec : bingxSpec;
    for (const sl of [85011.8, 84000, 80000, 85300]) {
      const r = computeSize(Object.assign({}, base, { spec, exchange: ex, sl }));
      if (!r.ok) continue;
      assert(r.sizing.actualRiskUsdt <= r.sizing.riskAmountUsdt + 1e-9,
        `${ex} sl=${sl} 實際風險 ${r.sizing.actualRiskUsdt} > 預算 ${r.sizing.riskAmountUsdt}`);
    }
  }
});

ck('SL 越遠，倉位越小（風險受控於預算內）', () => {
  // 正確的不變量不是「兩者風險相等」，而是：
  //   0 <= 預算 − 實際風險 < 一個最小增量所對應的風險
  //
  // 因為數量必須無條件捨去到 lotSz 的整數倍，實際風險只會低於預算，
  // 低多少則取決於「被捨去的那一格」值多少錢。SL 越遠，單格代表的
  // 風險越大，誤差自然越大 —— 這是量化造成的，不是計算錯誤。
  const near = computeSize(Object.assign({}, base, { spec: okxSpec, exchange: 'okx', sl: 85200 }));
  const far = computeSize(Object.assign({}, base, { spec: okxSpec, exchange: 'okx', sl: 83000 }));
  assert(near.sizing.orderQty > far.sizing.orderQty, 'SL 越遠，張數應越少');

  for (const r of [near, far]) {
    const s = r.sizing;
    const riskPerLot = okxSpec.lotSz * okxSpec.ctVal * s.riskDistance;
    const shortfall = s.riskAmountUsdt - s.actualRiskUsdt;
    assert(shortfall >= -1e-9, '實際風險不得超過預算');
    assert(shortfall < riskPerLot,
      `量化誤差 ${shortfall.toFixed(4)} 應小於單格風險 ${riskPerLot.toFixed(4)}`);
  }
  console.log('       → SL 近：' + near.sizing.orderQty + ' 張（用量 '
    + (near.sizing.riskUtilisation * 100).toFixed(1) + '%）／SL 遠：'
    + far.sizing.orderQty + ' 張（用量 '
    + (far.sizing.riskUtilisation * 100).toFixed(1) + '%）');
});

ck('張數過少時，量化誤差顯著（需知悉的性質）', () => {
  // SL 很遠時算出的張數可能只有個位數，此時捨去一格就損失數個百分點的
  // 風險預算。這不會造成超額風險，但代表「實際下注」比預期保守。
  // 若要改善，選項是提高權益或改用 lotSz 更小的合約，而不是改成四捨五入。
  const far = computeSize(Object.assign({}, base, { spec: okxSpec, exchange: 'okx', sl: 83000 }));
  assert(far.sizing.riskUtilisation < 1);
  assert(far.sizing.riskUtilisation > 0.9, '仍應維持在預算的九成以上');
  console.log('       → 2.0855 張 → 捨去為 ' + far.sizing.orderQty
    + ' 張，風險用量 ' + (far.sizing.riskUtilisation * 100).toFixed(1) + '%');
});

ck('低於最小下單量 → 拒絕，不進位湊量', () => {
  // 門檻由規格決定：minSz 0.01 張 × ctVal 0.01 = 0.0001 BTC，
  // 乘上風險距離 385.7 ≈ 0.0386 USDT。風險預算低於這個數字就下不了。
  // 權益 5 → 預算 0.025 USDT → 0.0065 張 → 捨去為 0 → 拒絕。
  //（修正 minSz 之前用權益 50 也會拒絕，那是規格填錯造成的假象。）
  const r = computeSize(Object.assign({}, base, {
    spec: okxSpec, exchange: 'okx', equityUsdt: 5,
  }));
  assert(!r.ok);
  assert(r.error.includes('最小下單量'));
  console.log('       → ' + r.error.slice(0, 60) + '…');
});

ck('超過名目上限 → 拒絕', () => {
  const r = computeSize(Object.assign({}, base, {
    spec: okxSpec, exchange: 'okx', maxNotionalUsdt: 1000,
  }));
  assert(!r.ok);
  assert(r.error.includes('名目價值'));
});

ck('floorToStep 不受浮點誤差影響', () => {
  assert.strictEqual(floorToStep(12.963, 0.1), 12.9);
  assert.strictEqual(floorToStep(0.3, 0.1), 0.3);
  assert.strictEqual(floorToStep(1.0000000001, 0.1), 1);
  assert.strictEqual(floorToStep(0.12969, 0.0001), 0.1296);
});

// ================================================================
section('代碼對應');
// ================================================================
ck('BTCUSDT.P 對應正確', () => {
  assert.strictEqual(symbols.resolve('BTCUSDT.P', 'okx').spec.instId, 'BTC-USDT-SWAP');
  assert.strictEqual(symbols.resolve('BTCUSDT.P', 'bingx').spec.symbol, 'BTC-USDT');
});
ck('白名單外的代碼 → 拒絕', () => {
  const r = symbols.resolve('DOGEUSDT.P', 'okx');
  assert(!r.ok);
  assert(r.error.includes('白名單'));
});

// ================================================================
section('交易所簽章');
// ================================================================
ck('OKX 簽章與官方範例一致', () => {
  // 文件範例：timestamp + 'GET' + '/api/v5/account/balance?ccy=BTC'
  const ts = '2020-12-08T09:08:57.715Z';
  const prehash = ts + 'GET' + '/api/v5/account/balance?ccy=BTC';
  const expected = require('crypto')
    .createHmac('sha256', 'SECRET').update(prehash).digest('base64');
  assert.strictEqual(okx.sign(prehash, 'SECRET'), expected);
});

ck('OKX 時間戳為 ISO8601 含毫秒', () => {
  const ts = okx.okxTimestamp(1758470000123);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts), ts);
});

ck('OKX 請求：prehash 順序為 ts+METHOD+path+body', () => {
  const cfg = { apiKey: 'K', apiSecret: 'S', passphrase: 'P', baseUrl: 'https://www.okx.com' };
  const req = okx.buildSignedRequest({
    method: 'post', requestPath: '/api/v5/trade/order',
    body: { instId: 'BTC-USDT-SWAP' }, cfg, demo: true, now: 1758470000123,
  });
  const ts = req.headers['OK-ACCESS-TIMESTAMP'];
  const expected = okx.sign(
    ts + 'POST' + '/api/v5/trade/order' + JSON.stringify({ instId: 'BTC-USDT-SWAP' }), 'S'
  );
  assert.strictEqual(req.headers['OK-ACCESS-SIGN'], expected);
  assert.strictEqual(req.headers['x-simulated-trading'], '1', '模擬盤標頭應存在');
  assert.strictEqual(req.method, 'POST', 'method 應轉大寫');
});

ck('OKX 非模擬盤不帶 x-simulated-trading', () => {
  const cfg = { apiKey: 'K', apiSecret: 'S', passphrase: 'P', baseUrl: 'https://www.okx.com' };
  const req = okx.buildSignedRequest({
    method: 'GET', requestPath: '/api/v5/account/balance', cfg, demo: false,
  });
  assert(!('x-simulated-trading' in req.headers));
});

ck('OKX 下單 body：sz 為張數字串、含 clOrdId 與附掛止損止盈', () => {
  const body = okx.buildOrderBody({
    instId: 'BTC-USDT-SWAP', side: 'long', orderQty: 12.9,
    clOrdId: 'vgabc', tdMode: 'cross', sl: 85011.8, tp: 85783.2,
  });
  assert.strictEqual(body.side, 'buy');
  assert.strictEqual(body.sz, '12.9');
  assert.strictEqual(body.clOrdId, 'vgabc');
  assert.strictEqual(body.attachAlgoOrds.length, 1);
  assert.strictEqual(body.attachAlgoOrds[0].slTriggerPx, '85011.8');
  assert.strictEqual(body.attachAlgoOrds[0].slOrdPx, '-1');
});

ck('OKX 做空 → side=sell', () => {
  assert.strictEqual(okx.buildOrderBody({
    instId: 'X', side: 'short', orderQty: 1, clOrdId: 'a', tdMode: 'cross', sl: 1, tp: 2,
  }).side, 'sell');
});

ck('BingX 簽章對象與送出的 query string 完全一致', () => {
  const cfg = { apiKey: 'K', apiSecret: 'S', baseUrl: 'https://open-api.bingx.com' };
  const req = bingx.buildSignedRequest({
    method: 'POST', path: '/openApi/swap/v2/trade/order',
    pairs: [['symbol', 'BTC-USDT'], ['side', 'BUY']], cfg, now: 1758470000123,
  });
  const inUrl = req.url.split('?')[1].replace(/&signature=.*$/, '');
  assert.strictEqual(inUrl, req.signedString, '簽章字串與網址中的 query string 必須逐字元相同');
  assert.strictEqual(
    req.url.split('&signature=')[1],
    bingx.sign(req.signedString, 'S')
  );
  assert(req.signedString.includes('timestamp='));
  assert(req.signedString.includes('recvWindow='));
});

ck('BingX 下單參數：quantity 為幣、positionSide 正確', () => {
  const pairs = bingx.buildOrderPairs({
    symbol: 'BTC-USDT', side: 'short', orderQty: 0.1296,
    clientOrderId: 'vgabc', sl: 85783.2, tp: 85011.8,
  });
  const m = Object.fromEntries(pairs);
  assert.strictEqual(m.side, 'SELL');
  assert.strictEqual(m.positionSide, 'SHORT');
  assert.strictEqual(m.quantity, '0.1296');
  assert.strictEqual(JSON.parse(m.stopLoss).stopPrice, 85783.2);
});

// ================================================================
section('風控閘門');
// ================================================================
function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
  return new Store(dir);
}
const riskCfg = {
  minGrade: 2, allowedTimeframes: ['15', '60'],
  dailyLossLimitUsdt: 50, maxConcurrent: 3,
};
const goodSignal = parseSignal(sig(), parseOpts).signal;

ck('全部通過', () => {
  const r = risk.evaluate(goodSignal, { store: freshStore(), risk: riskCfg });
  assert(r.passed, r.reasons.join('；'));
});

ck('kill switch 擋下', () => {
  const s = freshStore();
  s.setHalted(true, '測試');
  const r = risk.evaluate(goodSignal, { store: s, risk: riskCfg });
  assert(!r.passed);
  assert(r.reasons.some((x) => x.includes('kill_switch')));
});

ck('重複 sig_id 擋下', () => {
  const s = freshStore();
  s.markProcessed(goodSignal.sigId, 'placed', 'x');
  const r = risk.evaluate(goodSignal, { store: s, risk: riskCfg });
  assert(!r.passed);
  assert(r.reasons.some((x) => x.includes('idempotency')));
});

ck('等級不足擋下', () => {
  const weak = parseSignal(sig({ grade: 1, score: 35 }), parseOpts).signal;
  const r = risk.evaluate(weak, { store: freshStore(), risk: riskCfg });
  assert(!r.passed);
  assert(r.reasons.some((x) => x.includes('min_grade')));
});

ck('週期不在白名單擋下', () => {
  const s5 = parseSignal(sig({ tf: '5' }), parseOpts).signal;
  const r = risk.evaluate(s5, { store: freshStore(), risk: riskCfg });
  assert(!r.passed);
  assert(r.reasons.some((x) => x.includes('timeframe')));
});

ck('當日虧損達上限擋下', () => {
  const s = freshStore();
  s.recordPnl(-50);
  const r = risk.evaluate(goodSignal, { store: s, risk: riskCfg });
  assert(!r.passed);
  assert(r.reasons.some((x) => x.includes('daily_loss_limit')));
});

ck('同時持倉達上限擋下', () => {
  const s = freshStore();
  ['a', 'b', 'c'].forEach((id, i) => s.addPosition(id, { symbol: 'X' + i }));
  const r = risk.evaluate(goodSignal, { store: s, risk: riskCfg });
  assert(!r.passed);
  assert(r.reasons.some((x) => x.includes('max_concurrent')));
});

ck('同標的已有部位擋下', () => {
  const s = freshStore();
  s.addPosition('other', { symbol: 'BTCUSDT.P' });
  const r = risk.evaluate(goodSignal, { store: s, risk: riskCfg });
  assert(!r.passed);
  assert(r.reasons.some((x) => x.includes('no_duplicate_symbol')));
});

// ================================================================
section('狀態持久化');
// ================================================================
ck('重啟後 processed 仍在（避免重複下單）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
  const a = new Store(dir);
  a.markProcessed('sig-1', 'placed', 'cloid');
  const b = new Store(dir);           // 模擬程序重啟
  assert(b.isProcessed('sig-1'));
  assert.strictEqual(b.getProcessed('sig-1').outcome, 'placed');
});

ck('狀態檔損壞時備份而非靜默重置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
  fs.writeFileSync(path.join(dir, 'state.json'), '{壞掉的 json');
  const s = new Store(dir);
  assert.strictEqual(s.openPositionCount(), 0);
  assert(fs.readdirSync(dir).some((f) => f.includes('corrupt')));
});

// ================================================================
section('完整管線（DRY_RUN）');
// ================================================================
function pipelineCfg(over) {
  return Object.assign({
    dryRun: true, demo: true, primaryExchange: 'okx', refreshSpec: false,
    executionMode: 'auto', autoGradeMin: 3, pendingTtlSec: 300,
    risk: {
      pctPerTrade: 0.005, equityUsdt: 10000, maxConcurrent: 3,
      dailyLossLimitUsdt: 50, maxNotionalUsdt: 50000, leverage: 5,
      minGrade: 2, allowedTimeframes: ['15', '60'], maxSignalAgeSec: 60,
      // 這些測試驗的是流程本身，不連網 —— 漂移檢查需要現價，
      // 在這裡明確關閉。它自己的測試在 test/drift.js。
      driftCheck: false,
    },
    okx: { apiKey: 'K', apiSecret: 'S', passphrase: 'P',
      baseUrl: 'https://www.okx.com', tdMode: 'cross' },
    bingx: { apiKey: 'K', apiSecret: 'S', baseUrl: 'https://open-api.bingx.com' },
    telegram: { token: '', chatId: '' },
  }, over || {});
}

(async () => {
  await ckAsync('合法訊號 → placed 但 sent=false（未送出）', async () => {
    const r = await handleSignal(sig(), { config: pipelineCfg(), store: freshStore(), now: NOW });
    assert.strictEqual(r.decision, 'placed');
    assert.strictEqual(r.sent, false, 'DRY_RUN 下不得送出');
    assert.strictEqual(r.sizing.orderQty, 12.96);
    assert.strictEqual(r.clientOrderId.length, 32);
    assert.strictEqual(r.tpUsed, 85783.2);
    assert.deepStrictEqual(r.tpDeferred, [86169.0, 86554.7]);
  });

  await ckAsync('請求內容不含金鑰（可安全寫入日誌）', async () => {
    const r = await handleSignal(sig(), { config: pipelineCfg(), store: freshStore(), now: NOW });
    const dumped = JSON.stringify(r);
    assert(!dumped.includes('"K"'), 'apiKey 不應出現在決策物件中');
    assert.strictEqual(r.request.headers['OK-ACCESS-KEY'], '[REDACTED]');
    assert.strictEqual(r.request.headers['OK-ACCESS-SIGN'], '[REDACTED]');
    assert.strictEqual(r.request.headers['OK-ACCESS-PASSPHRASE'], '[REDACTED]');
  });

  await ckAsync('BingX 路徑：簽章已遮蔽', async () => {
    const r = await handleSignal(sig(), {
      config: pipelineCfg({ primaryExchange: 'bingx' }), store: freshStore(), now: NOW,
    });
    assert.strictEqual(r.decision, 'placed');
    assert.strictEqual(r.sizing.unit, 'base');
    assert(r.request.url.includes('signature=[REDACTED]'));
  });

  await ckAsync('同一訊號送兩次 → 第二次被冪等擋下', async () => {
    const store = freshStore();
    const cfg = pipelineCfg();
    const a = await handleSignal(sig(), { config: cfg, store, now: NOW });
    const b = await handleSignal(sig(), { config: cfg, store, now: NOW });
    assert.strictEqual(a.decision, 'placed');
    assert.strictEqual(b.decision, 'rejected');
    assert(b.reasons.some((x) => x.includes('idempotency')));
  });

  await ckAsync('DRY_RUN 不佔用持倉額度（可連續測試）', async () => {
    const store = freshStore();
    const cfg = pipelineCfg();
    for (let i = 0; i < 5; i++) {
      const r = await handleSignal(sig({
        sig_id: 'BTCUSDT.P-60-' + i + '-long', ts: NOW - 1000,
      }), { config: cfg, store, now: NOW });
      assert.strictEqual(r.decision, 'placed', '第 ' + (i + 1) + ' 筆應通過，實際：'
        + JSON.stringify(r.reasons));
    }
    assert.strictEqual(store.openPositionCount(), 0);
  });

  await ckAsync('方向寫反的訊號 → 在解析階段就停住', async () => {
    const r = await handleSignal(sig({ sl: 85800 }), {
      config: pipelineCfg(), store: freshStore(), now: NOW,
    });
    assert.strictEqual(r.decision, 'rejected');
    assert.strictEqual(r.stage, 'parse');
  });

  await ckAsync('kill switch 開啟 → 一律拒絕', async () => {
    const store = freshStore();
    store.setHalted(true, '測試停止');
    const r = await handleSignal(sig(), { config: pipelineCfg(), store, now: NOW });
    assert.strictEqual(r.decision, 'rejected');
    assert.strictEqual(r.stage, 'risk');
  });

  await ckAsync('白名單外代碼 → 在對應階段停住', async () => {
    const r = await handleSignal(sig({
      symbol: 'DOGEUSDT.P', sig_id: 'DOGEUSDT.P-60-1-long',
    }), { config: pipelineCfg(), store: freshStore(), now: NOW });
    assert.strictEqual(r.decision, 'rejected');
    assert.strictEqual(r.stage, 'symbol');
  });

  await ckAsync('權益過小 → 在倉位計算階段停住', async () => {
    const cfg = pipelineCfg();
    cfg.risk.equityUsdt = 5;   // 見上方「低於最小下單量」的門檻計算
    const r = await handleSignal(sig(), { config: cfg, store: freshStore(), now: NOW });
    assert.strictEqual(r.decision, 'rejected');
    assert.strictEqual(r.stage, 'sizing');
  });

  await ckAsync('弱訊號（grade 1）預設被擋下', async () => {
    const r = await handleSignal(sig({ grade: 1, score: 38 }), {
      config: pipelineCfg(), store: freshStore(), now: NOW,
    });
    assert.strictEqual(r.decision, 'rejected');
    assert(r.reasons.some((x) => x.includes('min_grade')));
  });


  // ================================================================
  section('待確認狀態機（第一步的核心）');
  // ================================================================
  const manualCfg = (over) => {
    const c = pipelineCfg(over);
    c.executionMode = 'manual';
    return c;
  };

  // by_grade 的三段路由。這張表是使用者實際依賴的行為契約 ——
  // 改動 MIN_GRADE 或 AUTO_GRADE_MIN 的語意時，這裡會先擋下來。
  await ckAsync('by_grade：高品質自動、標準自動、弱訊要按鈕', async () => {
    const expect = { 3: 'placed', 2: 'placed', 1: 'pending' };
    for (const grade of [3, 2, 1]) {
      const cfg = pipelineCfg();
      cfg.executionMode = 'by_grade';
      cfg.autoGradeMin = 2;
      cfg.risk.minGrade = 1;
      const r = await handleSignal(sig({ grade, score: grade * 30 }),
        { config: cfg, store: freshStore(), now: NOW });
      assert.strictEqual(r.decision, expect[grade],
        `等級 ${grade} 應為 ${expect[grade]}，實際 ${r.decision}`);
    }
  });

  await ckAsync('by_grade：MIN_GRADE 太高時弱訊連卡片都沒有', async () => {
    // 這是最容易誤設的一項：想讓弱訊出按鈕，卻忘了 MIN_GRADE 會先砍掉它。
    const cfg = pipelineCfg();
    cfg.executionMode = 'by_grade';
    cfg.autoGradeMin = 2;
    cfg.risk.minGrade = 2;          // 沒調降
    const r = await handleSignal(sig({ grade: 1, score: 30 }),
      { config: cfg, store: freshStore(), now: NOW });
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(r.reasons.join('').includes('min_grade'), r.reasons.join('；'));
  });

  await ckAsync('manual 模式 → decision=pending，未下單', async () => {
    const store = freshStore();
    const r = await handleSignal(sig(), { config: manualCfg(), store, now: NOW });
    assert.strictEqual(r.decision, 'pending');
    assert.strictEqual(r.sent, undefined, '不應有下單動作');
    assert.strictEqual(r.sizing.orderQty, 12.96, '倉位仍然算好了');
    assert.strictEqual(store.listPendings().length, 1);
    assert.strictEqual(store.today(NOW).orders, 0, '未計入下單數');
  });

  await ckAsync('待確認紀錄帶有到期時間', async () => {
    const store = freshStore();
    const r = await handleSignal(sig(), { config: manualCfg(), store, now: NOW });
    assert.strictEqual(new Date(r.expiresAt).getTime(), NOW + 300000);
  });

  await ckAsync('確認 → placed，待確認清空', async () => {
    const store = freshStore();
    const cfg = manualCfg();
    const a = await handleSignal(sig(), { config: cfg, store, now: NOW });
    const b = await confirmSignal(a.sigId, { config: cfg, store, now: NOW + 10000 });
    assert.strictEqual(b.decision, 'placed');
    assert.strictEqual(b.confirmedByUser, true);
    assert.strictEqual(b.sizing.orderQty, 12.96);
    assert.strictEqual(store.listPendings().length, 0);
    assert.strictEqual(store.today(NOW).orders, 1);
  });

  await ckAsync('略過 → skipped，且留下決策紀錄', async () => {
    const store = freshStore();
    const cfg = manualCfg();
    const a = await handleSignal(sig(), { config: cfg, store, now: NOW });
    const b = await skipSignal(a.sigId, { config: cfg, store, now: NOW + 5000 });
    assert.strictEqual(b.decision, 'skipped');
    assert.strictEqual(store.listPendings().length, 0);
    const d = store.listDecisions();
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].outcome, 'skipped');
    assert.strictEqual(d[0].symbol, 'BTCUSDT.P');
    assert.strictEqual(d[0].orderQty, 12.96, '略過也保留當時算出的倉位');
  });

  await ckAsync('逾時 → expired，之後確認無效', async () => {
    const store = freshStore();
    const cfg = manualCfg();
    const a = await handleSignal(sig(), { config: cfg, store, now: NOW });
    const late = NOW + 301000;
    const b = await confirmSignal(a.sigId, { config: cfg, store, now: late });
    assert.strictEqual(b.decision, 'not_found');
    const d = store.listDecisions();
    assert.strictEqual(d[0].outcome, 'expired');
  });

  await ckAsync('重複確認 → 第二次被擋下，只下一次單', async () => {
    const store = freshStore();
    const cfg = manualCfg();
    const a = await handleSignal(sig(), { config: cfg, store, now: NOW });
    const b = await confirmSignal(a.sigId, { config: cfg, store, now: NOW + 1000 });
    const c = await confirmSignal(a.sigId, { config: cfg, store, now: NOW + 2000 });
    assert.strictEqual(b.decision, 'placed');
    // 第二次要說得出「已經送出過了」，而不是「找不到」——
    // 使用者按了兩次，他要知道的是單已經下了，不是訊號不見了。
    assert.strictEqual(c.decision, 'already_handling');
    // 測試在 DRY_RUN 下跑，所以前次結果是 dry_run；真實下單時會是 placed。
    // 兩者都屬於「已經送出過」，這正是 attempted 那組判斷涵蓋的範圍。
    assert.ok(['placed', 'dry_run'].includes(c.priorOutcome), c.priorOutcome);
    assert.strictEqual(store.today(NOW).orders, 1, '只能有一筆下單');
  });

  await ckAsync('併發確認：claimPending 只有一個搶得到', async () => {
    const store = freshStore();
    const cfg = manualCfg();
    const a = await handleSignal(sig(), { config: cfg, store, now: NOW });
    const [x, y] = await Promise.all([
      confirmSignal(a.sigId, { config: cfg, store, now: NOW + 1000 }),
      confirmSignal(a.sigId, { config: cfg, store, now: NOW + 1000 }),
    ]);
    const outcomes = [x.decision, y.decision].sort();
    assert.deepStrictEqual(outcomes, ['already_handling', 'placed'],
      '實際為 ' + JSON.stringify(outcomes));
    assert.strictEqual(store.today(NOW).orders, 1);
  });

  await ckAsync('確認時 kill switch 已開 → 拒絕，不下單', async () => {
    const store = freshStore();
    const cfg = manualCfg();
    const a = await handleSignal(sig(), { config: cfg, store, now: NOW });
    store.setHalted(true, '臨時停止');
    const b = await confirmSignal(a.sigId, { config: cfg, store, now: NOW + 1000 });
    assert.strictEqual(b.decision, 'rejected');
    assert.strictEqual(b.stage, 'recheck');
    assert(b.reasons.some((r) => r.includes('kill_switch')));
    assert.strictEqual(store.today(NOW).orders, 0);
  });

  await ckAsync('確認時持倉已滿 → 拒絕', async () => {
    const store = freshStore();
    const cfg = manualCfg();
    const a = await handleSignal(sig(), { config: cfg, store, now: NOW });
    ['p1', 'p2', 'p3'].forEach((id, i) => store.addPosition(id, { symbol: 'X' + i }));
    const b = await confirmSignal(a.sigId, { config: cfg, store, now: NOW + 1000 });
    assert.strictEqual(b.decision, 'rejected');
    assert(b.reasons.some((r) => r.includes('max_concurrent')));
  });

  await ckAsync('不存在的 sig_id → not_found', async () => {
    const store = freshStore();
    const r = await confirmSignal('不存在的鍵', { config: manualCfg(), store, now: NOW });
    assert.strictEqual(r.decision, 'not_found');
  });

  await ckAsync('待確認狀態在程序重啟後仍在', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
    const cfg = manualCfg();
    const a = await handleSignal(sig(), { config: cfg, store: new Store(dir), now: NOW });
    const reopened = new Store(dir);            // 模擬重啟
    assert.strictEqual(reopened.listPendings().length, 1);
    const b = await confirmSignal(a.sigId, { config: cfg, store: reopened, now: NOW + 1000 });
    assert.strictEqual(b.decision, 'placed');
  });

  // ================================================================
  section('by_grade 模式');
  // ================================================================
  const byGradeCfg = () => {
    const c = pipelineCfg();
    c.executionMode = 'by_grade';
    c.autoGradeMin = 3;
    return c;
  };

  await ckAsync('高品質（3★）→ 直接下單', async () => {
    const r = await handleSignal(sig({ grade: 3 }), {
      config: byGradeCfg(), store: freshStore(), now: NOW,
    });
    assert.strictEqual(r.decision, 'placed');
  });

  await ckAsync('標準（2★）→ 等確認', async () => {
    const r = await handleSignal(sig({ grade: 2, score: 60 }), {
      config: byGradeCfg(), store: freshStore(), now: NOW,
    });
    assert.strictEqual(r.decision, 'pending');
  });

  await ckAsync('auto 模式不受影響（回歸）', async () => {
    const r = await handleSignal(sig({ grade: 2, score: 60 }), {
      config: pipelineCfg(), store: freshStore(), now: NOW,
    });
    assert.strictEqual(r.decision, 'placed');
  });

  await ckAsync('manual 下被閘門擋掉的訊號不會進待確認', async () => {
    const store = freshStore();
    const r = await handleSignal(sig({ grade: 1, score: 30 }), {
      config: manualCfg(), store, now: NOW,
    });
    assert.strictEqual(r.decision, 'rejected');
    assert.strictEqual(store.listPendings().length, 0);
  });

  console.log('\n' + '═'.repeat(56));
  console.log(fail === 0
    ? `全部通過：${pass} 項`
    : `通過 ${pass} 項，失敗 ${fail} 項`);
  console.log('═'.repeat(56));
  process.exit(fail ? 1 : 0);
})();
