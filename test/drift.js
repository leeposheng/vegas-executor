'use strict';
/**
 * 進場價漂移檢查的測試。
 *
 * 所有案例都用同一筆真實訊號當基準（BNBUSDT.P 做多）：
 *   entry 791.3 / sl 783.8 / tp1 798.8  →  風險距離 7.5
 * 這樣每個數字都能手算驗證，不必相信程式自己算的。
 */

const assert = require('assert');
const { assessDrift } = require('../src/drift');
const { computeSize } = require('../src/sizing');

let pass = 0;
const fails = [];
function ck(name, fn) {
  try { fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}

const LONG = { side: 'long', entry: 791.3, sl: 783.8, tp: [798.8, 806.3, 813.8] };
const SHORT = { side: 'short', entry: 791.3, sl: 798.8, tp: [783.8, 776.3, 768.8] };
const LIMITS = { maxWiden: 1.5, maxTighten: 0.75 };

const at = (signal, livePrice, limits) =>
  assessDrift({ signal, livePrice, limits: limits || LIMITS });

// ── 沒有漂移 ────────────────────────────────────────────────
ck('價格沒動應放行', () => {
  const r = at(LONG, 791.3);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.verdict, 'unchanged');
  assert.strictEqual(r.metrics.driftR, 0);
});

ck('小幅漂移應放行並標記為重算', () => {
  const r = at(LONG, 793);            // +1.7 → 0.227R，距離 9.2（1.227 倍）
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.verdict, 'resize');
  assert.strictEqual(r.metrics.driftR, 0.2267);
  assert.strictEqual(r.metrics.distanceRatio, 1.2267);
});

// ── 交易前提已失效 ──────────────────────────────────────────
ck('做多：現價跌破止損應拒絕', () => {
  const r = at(LONG, 783.0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verdict, 'sl_crossed');
  assert.ok(r.reason.includes('前提'), r.reason);
});

ck('做多：現價正好等於止損也算穿過', () => {
  assert.strictEqual(at(LONG, 783.8).verdict, 'sl_crossed');
});

ck('做空：現價漲破止損應拒絕', () => {
  const r = at(SHORT, 799.5);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verdict, 'sl_crossed');
});

ck('做多：現價已達第一目標應拒絕（那是追價）', () => {
  const r = at(LONG, 799);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verdict, 'tp1_passed');
  assert.ok(r.reason.includes('追價'), r.reason);
});

ck('做空：現價已達第一目標應拒絕', () => {
  assert.strictEqual(at(SHORT, 783.0).verdict, 'tp1_passed');
});

// ── 漂移超出容許範圍 ────────────────────────────────────────
ck('進場價變差超過上限應拒絕', () => {
  // 797 → 距離 13.2，是原本的 1.76 倍（上限 1.5）
  const r = at(LONG, 797);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verdict, 'drifted_against');
  assert.ok(r.reason.includes('1.76'), r.reason);
});

ck('進場價變好太多也要拒絕（數量會膨脹）', () => {
  // 786 → 距離 2.2，只剩原本的 0.29 倍，數量會變成 3.4 倍
  const r = at(LONG, 786);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.verdict, 'drifted_toward');
  assert.ok(r.reason.includes('3.41'), r.reason);
});

ck('邊界內側應放行、外側應拒絕', () => {
  // 距離 = 1.5 × 7.5 = 11.25 → live = 783.8 + 11.25 = 795.05
  assert.strictEqual(at(LONG, 795.0).ok, true, '略低於上限應通過');
  assert.strictEqual(at(LONG, 795.1).ok, false, '略高於上限應拒絕');
});

// ── 取不到價格 ──────────────────────────────────────────────
ck('取不到現價應拒絕而非放行', () => {
  for (const bad of [null, undefined, NaN, 0, -1, 'abc']) {
    const r = at(LONG, bad);
    assert.strictEqual(r.ok, false, `${bad} 應被拒絕`);
    assert.strictEqual(r.verdict, 'no_price');
  }
});

// ── 重算後風險是否真的回到預算 ──────────────────────────────
ck('重算後的實際風險應回到預算，而非放大', () => {
  const spec = { instId: 'BNB-USDT-SWAP', ctVal: 0.1, lotSz: 0.01, minSz: 0.01 };
  const common = {
    equityUsdt: 10000, riskPct: 0.005, sl: LONG.sl, spec,
    exchange: 'okx', leverage: 5, maxNotionalUsdt: 30000,
  };
  const budget = 10000 * 0.005;   // 50 USDT

  const approved = computeSize(Object.assign({ entry: LONG.entry }, common));
  assert.ok(approved.ok, approved.error);

  const live = 794;               // 在容許範圍內（距離 10.2，1.36 倍）
  const drift = at(LONG, live);
  assert.strictEqual(drift.ok, true);
  assert.strictEqual(drift.verdict, 'resize');

  // 錯誤做法：沿用核准的數量，止損不變 → 實際風險爆表
  const naiveRisk = approved.sizing.baseQty * Math.abs(live - LONG.sl);
  assert.ok(naiveRisk > budget * 1.3,
    `沿用原數量的風險應明顯超標，實際 ${naiveRisk.toFixed(2)}`);

  // 正確做法：以現價重算
  const resized = computeSize(Object.assign({ entry: live }, common));
  assert.ok(resized.ok, resized.error);
  assert.ok(resized.sizing.actualRiskUsdt <= budget,
    `重算後風險 ${resized.sizing.actualRiskUsdt} 應 <= 預算 ${budget}`);
  assert.ok(resized.sizing.orderQty < approved.sizing.orderQty,
    '進場價變差時數量必須變小');
});

ck('重算後名目上限仍然有效', () => {
  const spec = { instId: 'BNB-USDT-SWAP', ctVal: 0.1, lotSz: 0.01, minSz: 0.01 };
  const r = computeSize({
    equityUsdt: 10000, riskPct: 0.005, entry: 794, sl: LONG.sl, spec,
    exchange: 'okx', leverage: 5, maxNotionalUsdt: 100,   // 刻意設得極低
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('名目價值'), r.error);
});

// ── 結果 ────────────────────────────────────────────────────
console.log(`漂移檢查測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
if (fails.length) {
  console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}

// ════════════════════════════════════════════════════════════
// 整合測試：真的走一次 confirmSignal，確認閘門有接上去
// ════════════════════════════════════════════════════════════

const { handleSignal, confirmSignal } = require('../src/executor');
const { Store } = require('../src/store');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NOW = Date.parse('2026-09-24T00:40:00.000Z');

function cfg(over) {
  return Object.assign({
    dryRun: true, demo: true, primaryExchange: 'okx', refreshSpec: false,
    executionMode: 'manual', autoGradeMin: 3, pendingTtlSec: 300,
    risk: {
      pctPerTrade: 0.005, equityUsdt: 10000, maxConcurrent: 3,
      dailyLossLimitUsdt: 50, maxNotionalUsdt: 50000, leverage: 5,
      minGrade: 2, allowedTimeframes: ['15', '60'], maxSignalAgeSec: 60,
      driftMaxWiden: 1.5, driftMaxTighten: 0.75,
    },
    okx: { apiKey: 'K', apiSecret: 'S', passphrase: 'P',
      baseUrl: 'https://www.okx.com', tdMode: 'cross' },
    bingx: {}, telegram: { token: '', chatId: '' },
  }, over || {});
}

function freshStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'vgdrift-')));
}

const SIGNAL = {
  v: '11.9', sig_id: 'drift-' + Math.random().toString(16).slice(2, 10),
  ts: NOW, symbol: 'BTCUSDT.P', tf: '60', grade: 3, side: 'long',
  entry: 85397.5, sl: 85011.8, tp: [85783.2, 86169.0, 86554.7],
};

function stubPrice(last) {
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ code: '0', data: [{ instId: 'BTC-USDT-SWAP', last: String(last), ts: String(NOW) }] }),
  });
}

async function integration() {
  const realFetch = global.fetch;
  let ipass = 0;
  const ifails = [];
  const ick = async (name, fn) => {
    try { await fn(); ipass++; } catch (err) { ifails.push(`${name}：${err.message}`); }
  };

  const freshSignal = () => Object.assign({}, SIGNAL,
    { sig_id: 'drift-' + Math.random().toString(16).slice(2, 12), ts: NOW });

  await ick('漂移檢查預設啟用（設定沒寫也一樣）', async () => {
    const store = freshStore();
    const c = cfg();                       // 刻意不設 driftCheck
    assert.strictEqual(c.risk.driftCheck, undefined, '前提：這個欄位不存在');
    const a = await handleSignal(freshSignal(), { config: c, store, now: NOW });
    assert.strictEqual(a.decision, 'pending');

    global.fetch = async () => { throw new Error('模擬斷線'); };
    const b = await confirmSignal(a.sigId, { config: c, store, now: NOW + 20000 });
    assert.strictEqual(b.decision, 'rejected',
      '欄位漏掉時必須仍然檢查 —— fail-open 等於沒有這道閘門');
    assert.strictEqual(b.stage, 'drift');
  });

  await ick('取不到現價要拒絕下單', async () => {
    const store = freshStore();
    const c = cfg();
    const a = await handleSignal(freshSignal(), { config: c, store, now: NOW });
    global.fetch = async () => { throw new Error('模擬斷線'); };
    const b = await confirmSignal(a.sigId, { config: c, store, now: NOW + 20000 });
    assert.strictEqual(b.decision, 'rejected');
    assert.ok(b.reasons.join('').includes('無法取得現價'), b.reasons.join('；'));
    assert.strictEqual(store.listPendings().length, 0, '應收束，不留在待確認');
  });

  await ick('價格沒動 → 照原數量下單', async () => {
    const store = freshStore();
    const c = cfg();
    const a = await handleSignal(freshSignal(), { config: c, store, now: NOW });
    stubPrice(85397.5);
    const b = await confirmSignal(a.sigId, { config: c, store, now: NOW + 20000 });
    assert.strictEqual(b.decision, 'placed');
    assert.strictEqual(b.drift.verdict, 'unchanged');
    assert.strictEqual(b.sizing.orderQty, a.sizing.orderQty);
  });

  await ick('價格小漲 → 重算，數量變小、風險回到預算', async () => {
    const store = freshStore();
    const c = cfg();
    const a = await handleSignal(freshSignal(), { config: c, store, now: NOW });
    stubPrice(85500);                      // 距離 488.2，1.266 倍
    const b = await confirmSignal(a.sigId, { config: c, store, now: NOW + 20000 });
    assert.strictEqual(b.decision, 'placed');
    assert.strictEqual(b.drift.verdict, 'resize');
    assert.ok(b.sizing.orderQty < a.sizing.orderQty,
      `重算後數量應變小：${a.sizing.orderQty} → ${b.sizing.orderQty}`);
    assert.ok(b.sizing.actualRiskUsdt <= 50.0001,
      `重算後風險應回到預算，實際 ${b.sizing.actualRiskUsdt}`);
    assert.ok(b.drift.originalSizing, '應保留原本的計算，供卡片對照');
  });

  await ick('價格大漲 → 拒絕，不下單', async () => {
    const store = freshStore();
    const c = cfg();
    const a = await handleSignal(freshSignal(), { config: c, store, now: NOW });
    stubPrice(85700);                      // 距離 688.2，1.785 倍 > 1.5
    const b = await confirmSignal(a.sigId, { config: c, store, now: NOW + 20000 });
    assert.strictEqual(b.decision, 'rejected');
    assert.strictEqual(b.drift.verdict, 'drifted_against');
    assert.strictEqual(store.today(NOW).orders, 0, '拒絕就不該計入當日委託數');
  });

  await ick('價格跌破止損 → 拒絕', async () => {
    const store = freshStore();
    const c = cfg();
    const a = await handleSignal(freshSignal(), { config: c, store, now: NOW });
    stubPrice(84900);
    const b = await confirmSignal(a.sigId, { config: c, store, now: NOW + 20000 });
    assert.strictEqual(b.decision, 'rejected');
    assert.strictEqual(b.drift.verdict, 'sl_crossed');
  });

  await ick('明確關閉時不做檢查', async () => {
    const store = freshStore();
    const c = cfg({ risk: Object.assign(cfg().risk, { driftCheck: false }) });
    const a = await handleSignal(freshSignal(), { config: c, store, now: NOW });
    global.fetch = async () => { throw new Error('不該被呼叫'); };
    const b = await confirmSignal(a.sigId, { config: c, store, now: NOW + 20000 });
    assert.strictEqual(b.decision, 'placed', '關閉後不應因為取不到價格而失敗');
  });

  global.fetch = realFetch;
  console.log(`漂移整合測試：通過 ${ipass} 項` + (ifails.length ? `，失敗 ${ifails.length} 項` : ''));
  if (ifails.length) {
    console.error('\n' + ifails.map((f) => '  ✗ ' + f).join('\n'));
    process.exit(1);
  }
}

integration();
