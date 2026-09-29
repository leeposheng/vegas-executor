'use strict';
/**
 * 白名單與合約規格的測試。
 *
 * 這一組守的是一件很容易出事、卻完全沒有症狀的事：
 * ctVal 用錯 → 倉位以錯誤倍率計算 → 交易所照收、訂單照成交，
 * 只是大小不是你以為的那個。
 *
 * 所以重點不在「查得到就好」，而在：
 *   - 規格必須優先採用交易所的值，不是程式裡抄的
 *   - 交易所沒有的代碼必須被剔除，而且要說出來
 *   - 白名單裝好之前，不可以認得沒核實過的代碼
 */

const assert = require('assert');
const symbols = require('../src/symbols');
const instruments = require('../src/instruments');

let pass = 0;
const fails = [];
function ck(name, fn) {
  try { fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}

// ── 代碼轉換 ───────────────────────────────────────────────
ck('TradingView 代碼轉 OKX instId', () => {
  assert.strictEqual(instruments.toInstId('BTCUSDT.P'), 'BTC-USDT-SWAP');
  assert.strictEqual(instruments.toInstId('zecusdt.p'), 'ZEC-USDT-SWAP');
  assert.strictEqual(instruments.toInstId('1000PEPEUSDT.P'), '1000PEPE-USDT-SWAP');
});

ck('非 USDT 本位一律不認', () => {
  // 幣本位與現貨的風險模型完全不同，這套倉位計算是照 USDT 本位寫的
  assert.strictEqual(instruments.toInstId('BTCUSD.P'), null);
  assert.strictEqual(instruments.toInstId('BTCUSDT'), null, '沒有 .P 就不是永續');
  assert.strictEqual(instruments.toInstId('XAUUSD'), null, '黃金不是加密永續');
  assert.strictEqual(instruments.toInstId(''), null);
});

ck('instId 轉回 TradingView 代碼', () => {
  assert.strictEqual(instruments.toTvSymbol('SOL-USDT-SWAP'), 'SOLUSDT.P');
  assert.strictEqual(instruments.toTvSymbol('BTC-USD-SWAP'), null);
});

// ── 安裝白名單 ─────────────────────────────────────────────
const LIVE = {
  'BTC-USDT-SWAP': { instId: 'BTC-USDT-SWAP', ctVal: 0.01, lotSz: 0.01, minSz: 0.01 },
  'ZEC-USDT-SWAP': { instId: 'ZEC-USDT-SWAP', ctVal: 0.01, lotSz: 1, minSz: 1 },
  'SUI-USDT-SWAP': { instId: 'SUI-USDT-SWAP', ctVal: 1, lotSz: 0.1, minSz: 0.1 },
};

ck('規格優先採用交易所的值，不是靜態表', () => {
  symbols.reset();
  // 故意給一個與靜態表不同的 ctVal，看它採用哪一個
  const tweaked = Object.assign({}, LIVE, {
    'BTC-USDT-SWAP': { instId: 'BTC-USDT-SWAP', ctVal: 0.001, lotSz: 0.1, minSz: 0.1 },
  });
  symbols.install({ allowed: ['BTCUSDT.P'], specs: tweaked });
  const r = symbols.resolve('BTCUSDT.P', 'okx');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.spec.ctVal, 0.001,
    '必須採用交易所的 ctVal —— 靜態表是退路，不是真相');
  assert.strictEqual(symbols.specSource('BTCUSDT.P'), 'exchange');
});

ck('交易所沒有的代碼要被剔除並列出', () => {
  symbols.reset();
  const { installed, missing } = symbols.install({
    allowed: ['BTCUSDT.P', 'ZECUSDT.P', 'NOTACOINUSDT.P', 'SUIUSDT.P'],
    specs: LIVE,
  });
  assert.deepStrictEqual(installed.sort(),
    ['BTCUSDT.P', 'SUIUSDT.P', 'ZECUSDT.P']);
  assert.deepStrictEqual(missing, ['NOTACOINUSDT.P'],
    '剔除的必須回報 —— 否則你會以為它在跑，而訊號一直被拒');
  assert.strictEqual(symbols.resolve('NOTACOINUSDT.P', 'okx').ok, false);
});

ck('格式錯誤的代碼會被指出原因', () => {
  symbols.reset();
  const { missing } = symbols.install({ allowed: ['XAUUSD'], specs: LIVE });
  assert.ok(missing[0].includes('格式'), missing.join('；'));
});

ck('交易所沒給時退回人工核實過的靜態值', () => {
  symbols.reset();
  // specs 全空，模擬交易所與快取都拿不到
  const { installed } = symbols.install({ allowed: ['BTCUSDT.P'], specs: {} });
  assert.deepStrictEqual(installed, ['BTCUSDT.P']);
  assert.strictEqual(symbols.specSource('BTCUSDT.P'), 'static');
  assert.strictEqual(symbols.resolve('BTCUSDT.P', 'okx').spec.ctVal, 0.01);
});

ck('白名單裝好之後，不在名單上的一律拒絕', () => {
  symbols.reset();
  symbols.install({ allowed: ['BTCUSDT.P'], specs: LIVE });
  const r = symbols.resolve('ZECUSDT.P', 'okx');
  assert.strictEqual(r.ok, false, '即使交易所有這個合約，沒列進白名單就不能交易');
  assert.ok(r.error.includes('白名單'), r.error);
});

ck('大小寫與空白不影響比對', () => {
  symbols.reset();
  symbols.install({ allowed: [' btcusdt.p '], specs: LIVE });
  assert.strictEqual(symbols.resolve('BTCUSDT.P', 'okx').ok, true);
});

// ── 規格解析 ───────────────────────────────────────────────
ck('缺少任一關鍵數字的合約要被略過', () => {
  // 這是 fetchAll 的過濾邏輯：三個值缺一就算不出張數，
  // 與其帶著 undefined 往下跑，不如當它不存在
  const raw = {
    code: '0',
    data: [
      { instId: 'A-USDT-SWAP', settleCcy: 'USDT', state: 'live',
        ctVal: '1', lotSz: '1', minSz: '1' },
      { instId: 'B-USDT-SWAP', settleCcy: 'USDT', state: 'live',
        ctVal: '', lotSz: '1', minSz: '1' },
      { instId: 'C-USDT-SWAP', settleCcy: 'USDT', state: 'suspend',
        ctVal: '1', lotSz: '1', minSz: '1' },
      { instId: 'D-USD-SWAP', settleCcy: 'USD', state: 'live',
        ctVal: '1', lotSz: '1', minSz: '1' },
    ],
  };
  // 直接驗證過濾規則（fetchAll 的內部邏輯複製一份來測）
  const kept = raw.data.filter((d) => d.settleCcy === 'USDT' && d.state === 'live'
    && Number(d.ctVal) > 0 && Number(d.lotSz) > 0 && Number(d.minSz) > 0);
  assert.deepStrictEqual(kept.map((d) => d.instId), ['A-USDT-SWAP'],
    '缺值、暫停、非 USDT 本位都要排除');
});

symbols.reset();
console.log(`白名單測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
if (fails.length) {
  console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
