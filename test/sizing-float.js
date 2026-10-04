'use strict';
/**
 * 名目上限的浮點容差。
 *
 * 情境：小帳戶（權益 300、倍數 3 → 名目上限 900），固定保證金 25、
 * 峰值槓桿 40、自動槓桿開啟。上限生效時槓桿被夾到 36x，名目「剛好」900，
 * 但 0.9 張 × 0.01 面值的浮點結果是 900.0000000000001，
 * 修正前會以「超過絕對上限」拒絕一筆完全合規的單。
 */
const assert = require('assert');
const { computeFixedMargin, overCap } = require('../src/sizing');

let n = 0;
function ok(name, fn) { fn(); n += 1; console.log('  ✓ ' + name); }

const spec = { instId: 'BTC-USDT-SWAP', ctVal: '0.01', lotSz: '0.01', minSz: '0.01', tickSz: '0.1' };
function size(eq, stopPct) {
  const entry = 100000;
  const sl = entry * (1 - stopPct / 100);
  return computeFixedMargin({
    marginUsdt: 25, marginMaxUsdt: 0, leverage: 40, autoLeverage: true, minLiqCushion: 3,
    entry, sl, tp: [entry + (entry - sl) * 1.5], side: 'long', spec, exchange: 'okx',
    feeRateOneWay: 0.0005, lossMinUsdt: 5, lossMaxUsdt: 11,
    maxNotionalUsdt: Math.min(1500, eq * 3), equityUsdt: eq,
  });
}

console.log('sizing-float');
ok('overCap 容許浮點誤差', () => {
  assert.strictEqual(overCap(900.0000000000001, 900), false);
  assert.strictEqual(overCap(900, 900), false);
});
ok('overCap 仍擋下真正超標（多一張）', () => {
  assert.strictEqual(overCap(901, 900), true);
  assert.strictEqual(overCap(900.01, 900), true);
});
ok('上限生效、名目剛好等於上限 → 放行', () => {
  const r = size(300, 0.5);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.sizing.leverage, 36);
  assert.ok(r.sizing.notionalUsdt <= 900 * (1 + 1e-9));
});
ok('上限生效但虧損不足 → 以區間拒絕並標 capBound（不是誤報超上限）', () => {
  const r = size(300, 0.4);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.band, 'below');
  assert.strictEqual(r.capBound, true);
});
ok('權益足夠時不受影響（40x、名目 1000）', () => {
  const r = size(500, 0.5);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.sizing.leverage, 40);
});
console.log(`  ${n} 項通過`);
