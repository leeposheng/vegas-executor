'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const SRC = process.argv[2], OUT = process.argv[3];
const R = (m) => require(path.join(SRC, m));
const NOW = 1758470000000;
const RealDate = Date; let FROZEN = NOW;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(FROZEN); } static now() { return FROZEN; } }
global.Date = FakeDate;
const origLog = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
const notify = R('notify'); const sent = [];
notify.send = async (text, cfg) => { sent.push(text); return { sent: false }; };
const okx = R('exchanges/okx'); let TICK = 84000;
okx.fetchTicker = async () => ({ last: TICK });
// 權益與持倉查詢一律以假資料取代：向量不可依賴沙箱的網路狀態（先前版本記到的 "fetch failed" 是環境產物）。
let EQ = 'throw'; let POSLIST = [];
okx.fetchEquity = async () => { if (EQ === 'throw') throw new Error('fetch failed'); return { equityUsdt: EQ }; };
okx.fetchPositions = async () => POSLIST;
const equityMod = R('equity');
const { Store } = R('store'); const ex = R('executor');

const pipelineCfg = (over) => Object.assign({
  dryRun: true, demo: true, primaryExchange: 'okx', refreshSpec: false,
  executionMode: 'auto', autoGradeMin: 3, pendingTtlSec: 300,
  risk: { pctPerTrade: 0.005, equityUsdt: 10000, maxConcurrent: 3, dailyLossLimitUsdt: 50, maxNotionalUsdt: 50000,
    leverage: 5, minGrade: 2, allowedTimeframes: ['15', '60'], maxSignalAgeSec: 60, driftCheck: false },
  okx: { apiKey: 'K', apiSecret: 'S', passphrase: 'P', baseUrl: 'https://www.okx.com', tdMode: 'cross' },
  bingx: { apiKey: 'K', apiSecret: 'S', baseUrl: 'https://open-api.bingx.com' },
  telegram: { token: '', chatId: '' } }, over || {});
const withRisk = (o) => ({ risk: Object.assign({}, pipelineCfg().risk, o) });
const sig = (o) => Object.assign({ v: '11.8', sig_id: 'BTCUSDT.P-60-1758469980000-long', ts: NOW - 2000,
  symbol: 'BTCUSDT.P', tf: '60', grade: 3, score: 85, side: 'long', entry: 85397.5, sl: 85011.8,
  tp: [85783.2, 86169.0, 86554.7] }, o || {});
const FM = { sizingMode: 'fixed_margin', fixedMarginUsdt: 25, fixedMarginMaxUsdt: 0, lossMinUsdt: 5, lossMaxUsdt: 11,
  feeRateOneWay: 0.0005, autoLeverage: true, minLiqCushion: 3, leverage: 40, maxNotionalUsdt: 1500 };
const mk = (state) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-')); if (state) fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state)); return new Store(d); };
const clean = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'number' && !Number.isFinite(v)) ? { __num: String(v) } : v));

const S = [];
const scen = (id, cfgOver, state, steps, tick, extra) => S.push(Object.assign({ id, cfgOver, state, steps, tick }, extra || {}));
const H = (payload, dt) => ({ op: 'handle', payload, dt: dt || 0 });
const C = (sigId, dt, extra) => ({ op: 'confirm', sigId, dt, ...(extra || {}) });
const K = (sigId, dt) => ({ op: 'skip', sigId, dt });

// ================================================================
// 隨機差異測試：固定種子 → 同一批情境永遠相同。每個情境與 pipeline.json 同格式，
// 由 Node 版算出標準答案，Python 版以同一個測試逐欄比對。
// ================================================================
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20260915);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const between = (lo, hi) => lo + rnd() * (hi - lo);
const r1 = (x) => Math.round(x * 10) / 10;
const SYMS = [['BTCUSDT.P', 85000, 100], ['ETHUSDT.P', 3000, 3], ['BTCUSDT.P', 85000, 100], ['ETHUSDT.P', 3000, 3], ['DOGEUSDT.P', 0.2, 0.002], ['SOLUSDT.P', 150, 1.5]];
const TFS = ['1', '5', '15', '15', '30', '60', '60', '240'];

function randSignal(i, cfg) {
  const [symbol, px, step] = chance(0.9) ? pick(SYMS.slice(0, 4)) : pick(SYMS.slice(4));
  const rp = (x) => (px < 1 ? Math.round(x * 10000) / 10000 : px < 10 ? Math.round(x * 1000) / 1000 : r1(x));
  const side = chance(0.5) ? 'long' : 'short';
  const dir = side === 'long' ? 1 : -1;
  const entry = rp(px * between(0.995, 1.005));
  const risk = step * between(0.5, 12);
  const sl = rp(entry - dir * risk);
  const tps = [rp(entry + dir * risk * 1.0), rp(entry + dir * risk * 1.8), rp(entry + dir * risk * 2.6)];
  const tf = chance(0.88) ? pick(cfg.risk.allowedTimeframes) : pick(TFS);
  const ts = NOW - Math.floor(rnd() * (chance(0.06) ? 120000 : 25000));
  const s = { v: '11.8', sig_id: symbol + '-' + tf + '-' + (NOW - 20000 - i * 7) + '-' + side, ts, symbol, tf, grade: pick([1, 2, 2, 3, 3, 3]), score: Math.floor(between(30, 100)), side, entry, sl, tp: tps };
  // 刻意製造各種壞資料（每項都只佔少數，讓大多數情境能走到後段的倉位計算與漂移檢查）
  if (chance(0.015)) s.sl = entry;
  if (chance(0.015)) s.sl = rp(entry + dir * risk);
  if (chance(0.015)) s.tp = [rp(entry - dir * risk)];
  if (chance(0.01)) s.tp = [];
  if (chance(0.03)) delete s.score;
  if (chance(0.01)) s.entry = 'abc';
  if (chance(0.01)) s.side = pick(['x', 'LONG', '']);
  if (chance(0.01)) delete s.sig_id;
  if (chance(0.015)) s.grade = pick([0, 4, '3', null, 9, -1]);
  if (chance(0.01)) s.ts = 'now';
  if (chance(0.01)) s.tf = 60;
  return s;
}

function randCfg() {
  const R = Object.assign({}, pipelineCfg().risk);
  if (chance(0.5)) Object.assign(R, FM, { fixedMarginUsdt: pick([10, 25, 100, 400]), leverage: pick([5, 10, 40, 100]), maxNotionalUsdt: pick([500, 1500, 20000]), autoLeverage: chance(0.6), lossMinUsdt: pick([2, 5, 20]), lossMaxUsdt: pick([11, 20, 45]) });
  else Object.assign(R, { pctPerTrade: pick([0.002, 0.005, 0.01, 0.05]), leverage: pick([1, 5, 20]), maxNotionalUsdt: pick([2000, 50000]) });
  R.minGrade = pick([1, 1, 2, 2, 3]);
  R.allowedTimeframes = pick([['15', '60'], ['5', '15', '30', '60'], ['15'], ['60', '240']]);
  R.maxConcurrent = pick([3, 5, 5]);
  R.dailyLossLimitUsdt = pick([20, 50, 100]);
  R.maxSignalAgeSec = pick([30, 60, 120]);
  R.driftCheck = chance(0.55);
  if (R.driftCheck) { R.driftMaxWiden = pick([1.25, 1.5, 2]); R.driftMaxTighten = pick([0.5, 0.75, 0.9]); }
  if (chance(0.4)) { R.addOnMax = pick([1, 2]); R.addOnRequireProfit = chance(0.7); }
  if (chance(0.4)) R.overflowPositions = pick([1, 2]);
  if (chance(0.3)) R.equityCacheMs = pick([0, 60000]);
  return { executionMode: pick(['auto', 'manual', 'by_grade', 'by_grade']), autoGradeMin: pick([1, 2, 3]), pendingTtlSec: pick([60, 300]), risk: R };
}

function randState(symbols) {
  const st = {};
  if (chance(0.03)) { st.halted = true; st.haltedReason = '手動'; st.haltedSource = 'manual'; }
  if (chance(0.25)) st.daily = { '2025-09-21': { realisedPnlUsdt: -Math.round(between(0, 120)), orders: Math.floor(between(0, 6)) } };
  if (chance(0.3)) {
    st.positions = {};
    const n = Math.floor(between(1, 6));
    for (let k = 0; k < n; k++) {
      const sym = chance(0.4) ? pick(symbols) : 'POS' + k;
      st.positions['okx:p' + k] = { sigId: 'p' + k, symbol: sym, side: pick(['long', 'short']), exchange: 'okx', entry: 84000, leverage: 10, layers: chance(0.2) ? [{ sigId: 'L' }] : [] };
    }
  }
  return Object.keys(st).length ? st : null;
}

const N = 520;
for (let i = 0; i < N; i++) {
  const cfgOver = randCfg();
  const s1 = randSignal(i, cfgOver);
  const steps = [H(s1, Math.floor(between(0, 2000)))];
  const kind = rnd();
  if (kind < 0.25) steps.push(H(s1, Math.floor(between(500, 4000))));                                   // 重送（冪等）
  else if (kind < 0.55) steps.push(C(s1.sig_id, pick([1000, 20000, 299000, 300000, 301000, 400000])));  // 確認
  else if (kind < 0.65) steps.push(K(s1.sig_id, pick([1000, 50000])));                                   // 略過
  else if (kind < 0.7) steps.push(C(s1.sig_id, 5000), C(s1.sig_id, 6000));                               // 連點
  else if (kind < 0.8) { const s2 = randSignal(i + 1000, cfgOver); steps.push(H(s2, 10000)); if (chance(0.5)) steps.push(C(s2.sig_id, 20000)); }
  const state = randState([s1.symbol]);
  const px = Number(s1.entry) || 85000;
  const tick = chance(0.1) ? NaN : r1(px * between(0.996, 1.004));
  const extra = {};
  if (chance(0.6)) extra.eq = pick([200, 400, 1000, 5000, 10000, 50000]);
  if (chance(0.4)) extra.positions = [{ instId: pick(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']), posSide: pick(['long', 'short']), pos: pick([1, 5, -5]), upl: pick([-5, 0, 12.5]), lever: 10 }];
  scen('fz_' + String(i).padStart(3, '0'), cfgOver, state, steps, tick, extra);
}

const out = [];
(async () => {
  for (const sc of S) {
    sent.length = 0; FROZEN = NOW; TICK = sc.tick === undefined ? 84000 : sc.tick; EQ = sc.eq === undefined ? 'throw' : sc.eq; POSLIST = sc.positions || []; equityMod.resetCache();
    const store = mk(sc.state); const cfg = pipelineCfg(sc.cfgOver);
    const res = [];
    for (const st of sc.steps) {
      FROZEN = NOW + (st.dt || 0);
      const ctx = { config: cfg, store, now: FROZEN };
      let r;
      try {
        if (st.op === 'handle') r = await ex.handleSignal(st.payload, ctx);
        else if (st.op === 'confirm') r = await ex.confirmSignal(st.sigId, ctx);
        else if (st.op === 'skip') r = await ex.skipSignal(st.sigId, ctx);
        else if (st.op === 'store') { r = store[st.call[0]](...st.call.slice(1)); }
        res.push({ step: clean(st), result: clean(r === undefined ? null : r) });
      } catch (e) { res.push({ step: clean(st), threw: String(e.message) }); }
    }
    out.push({ id: sc.id, fn: 'pipeline', input: clean({ cfgOver: sc.cfgOver, config: cfg, state: sc.state, steps: sc.steps, tick: sc.tick === undefined ? 84000 : sc.tick, eq: sc.eq === undefined ? 'throw' : sc.eq, positions: sc.positions || [], startNow: NOW }),
      expected: { results: res, notifications: sent.slice(), finalState: clean(store.state) } });
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'fuzz.json'), JSON.stringify(out, null, 1).replace(/\/tmp\/vg-[A-Za-z0-9]+/g, '<DATA_DIR>'));
  origLog('fuzz scenarios', out.length);
  const tally = {};
  for (const o of out) for (const r of o.expected.results) { const k = r.result ? r.result.decision : 'THREW'; tally[k] = (tally[k] || 0) + 1; }
  origLog('decision tally', JSON.stringify(tally));
})();
