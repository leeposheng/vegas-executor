'use strict';
// 黃金向量產生器：以 Node 原版為準，凍結時間，輸出 JSON。
const fs = require('fs'), os = require('os'), path = require('path');
const SRC = process.argv[2], OUT = process.argv[3];
const R = (m) => require(path.join(SRC, m));
const RealDate = Date;
let FROZEN = 1758470000000;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FROZEN); }
  static now() { return FROZEN; }
}
global.Date = FakeDate;
const setNow = (ms) => { FROZEN = ms; };

const signal = R('signal'), sizing = R('sizing'), drift = R('drift'), risk = R('risk');
const instruments = R('instruments'), symbols = R('symbols'), notify = R('notify');
const okx = R('exchanges/okx'), bingx = R('exchanges/bingx');
const { Store } = R('store');

const NOW = 1758470000000;
const vec = {};
const add = (file, v) => { (vec[file] = vec[file] || []).push(v); };
const jsonSafe = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x, (k, v) =>
  (typeof v === 'number' && !Number.isFinite(v)) ? { __num: String(v) } : v));
function run(file, id, fn, input, f) {
  let expected;
  try { expected = { ok: true, value: jsonSafe(f()) }; }
  catch (e) { expected = { ok: false, throws: String(e.message) }; }
  add(file, { id, fn, input: jsonSafe(input), expected });
}

// ---------- signal ----------
const base = { v: '11.9', sig_id: 'BTCUSDT.P-15-1758469990000-L', symbol: 'BTCUSDT.P', tf: '15',
  side: 'long', ts: NOW - 5000, entry: 85397.5, sl: 85011.8, grade: 3, score: 70,
  tp: [85783.2, 86169.0, 86554.7] };
const sigCases = {
  ok_long: base,
  ok_short: { ...base, sig_id: 'BTCUSDT.P-15-1758469990000-S', side: 'short', entry: 85397.5, sl: 85783.2, tp: [85011.8, 84626.0] },
  tf_number: { ...base, tf: 15 },
  side_upper: { ...base, side: ' LONG ' },
  no_score: (() => { const c = { ...base }; delete c.score; return c; })(),
  score_null: { ...base, score: null },
  score_bad: { ...base, score: 101 },
  no_version: (() => { const c = { ...base }; delete c.v; return c; })(),
  sigid_short: { ...base, sig_id: 'abc' },
  sigid_bad_char: { ...base, sig_id: 'abc def ghij' },
  sigid_trim: { ...base, sig_id: '  BTCUSDT.P-15-1758469990000-L  ' },
  no_symbol: { ...base, symbol: '' },
  grade_4: { ...base, grade: 4 },
  grade_str: { ...base, grade: '2' },
  ts_str: { ...base, ts: String(NOW) },
  long_sl_above: { ...base, sl: 86000 },
  short_sl_below: { ...base, side: 'short', sl: 85000, tp: [85000] },
  risk_tiny: { ...base, sl: 85397.4 },
  tp_wrong_side: { ...base, tp: [85000] },
  tp_unordered: { ...base, tp: [85783.2, 85500] },
  tp_empty: { ...base, tp: [] },
  tp_nonnum: { ...base, tp: [85783.2, 'x'] },
  expired: { ...base, ts: NOW - 61000 },
  future: { ...base, ts: NOW + 31000 },
  future_ok: { ...base, ts: NOW + 29000 },
  entry_zero: { ...base, entry: 0 },
  multi_error: { sig_id: '', symbol: 5, side: 'x' },
};
for (const [k, raw] of Object.entries(sigCases)) {
  run('signal.json', 'parse_' + k, 'parse_signal', { raw, nowMs: NOW, maxAgeSec: 60 },
    () => signal.parseSignal(raw, { nowMs: NOW, maxAgeSec: 60 }));
}
for (const raw of [null, [], 'x', 5]) {
  run('signal.json', 'parse_nonobj_' + JSON.stringify(raw), 'parse_signal', { raw, nowMs: NOW, maxAgeSec: 60 },
    () => signal.parseSignal(raw, { nowMs: NOW, maxAgeSec: 60 }));
}
run('signal.json', 'parse_maxage_default', 'parse_signal', { raw: { ...base, ts: NOW - 59000 }, nowMs: NOW },
  () => signal.parseSignal({ ...base, ts: NOW - 59000 }, { nowMs: NOW }));
for (const [s, p] of [['BTCUSDT.P-15-1', 'vg'], ['a', undefined], ['中文', 'vg'], ['x', 'zz'], ['y', 'a-very-long-prefix-aaaaaaaaaaaaaaaaaaaaaaaaaaaa']]) {
  run('signal.json', 'clordid_' + s, 'client_order_id', { sigId: s, prefix: p ?? null },
    () => signal.clientOrderId(s, p));
}

// ---------- floor_to_step / sizing ----------
for (const [v, st] of [[12.969, 0.01], [12.96, 0.01], [0.3, 0.1], [0.7, 0.1], [1.0000000000001, 1], [0.99999999999, 1],
  [5.55, 0.05], [100, 0.001], [0.00039999, 0.0001], [3, 1], [0.1 + 0.2, 0.1], [1e-9, 0.0001], [0, 0.01]]) {
  run('floor_to_step.json', `f_${v}_${st}`, 'floor_to_step', { value: v, step: st }, () => sizing.floorToStep(v, st));
}

const specOkx = { instId: 'BTC-USDT-SWAP', ctVal: 0.01, lotSz: 0.01, minSz: 0.01, tvSymbol: 'BTCUSDT.P' };
const specBingx = { symbol: 'BTC-USDT', stepSize: 0.0001, minQty: 0.0001, tvSymbol: 'BTCUSDT.P' };
const specZec = { instId: 'ZEC-USDT-SWAP', ctVal: 0.01, lotSz: 1, minSz: 1, tvSymbol: 'ZECUSDT.P' };
const sampleSig = { entry: 85397.5, sl: 85011.8, side: 'long', tp: [85783.2, 86169.0, 86554.7] };

const riskCases = {
  okx_base: { equityUsdt: 10000, riskPct: 0.005, ...sampleSig, spec: specOkx, exchange: 'okx', leverage: 5, maxNotionalUsdt: 50000 },
  bingx_base: { equityUsdt: 10000, riskPct: 0.005, ...sampleSig, spec: specBingx, exchange: 'bingx', leverage: 5, maxNotionalUsdt: 50000 },
  below_min: { equityUsdt: 10, riskPct: 0.005, ...sampleSig, spec: specOkx, exchange: 'okx', leverage: 5, maxNotionalUsdt: 50000 },
  over_cap: { equityUsdt: 1000000, riskPct: 0.01, ...sampleSig, spec: specOkx, exchange: 'okx', leverage: 5, maxNotionalUsdt: 1000 },
  zero_dist: { equityUsdt: 10000, riskPct: 0.005, entry: 100, sl: 100, side: 'long', tp: [101], spec: specOkx, exchange: 'okx', leverage: 5, maxNotionalUsdt: 50000 },
  zec_lot1: { equityUsdt: 10000, riskPct: 0.005, entry: 50, sl: 48, side: 'long', tp: [52], spec: specZec, exchange: 'okx', leverage: 5, maxNotionalUsdt: 50000 },
  short: { equityUsdt: 10000, riskPct: 0.005, entry: 85397.5, sl: 85783.2, side: 'short', tp: [85011.8], spec: specOkx, exchange: 'okx', leverage: 5, maxNotionalUsdt: 50000 },
};
for (const [k, p] of Object.entries(riskCases)) run('compute_size.json', 'rp_' + k, 'compute_size', p, () => sizing.computeSize(p));

const fm = (over) => ({ ...sampleSig, spec: specOkx, exchange: 'okx', leverage: 40, marginUsdt: 25, marginMaxUsdt: 0,
  autoLeverage: true, minLiqCushion: 3, feeRateOneWay: 0.0005, lossMinUsdt: 5, lossMaxUsdt: 11,
  maxNotionalUsdt: 1500, equityUsdt: 400, ...over });
const fmCases = {
  live_example: fm({}),
  no_auto: fm({ autoLeverage: false }),
  stop_tiny_reject: fm({ entry: 85397.5, sl: 85300, tp: [85500] }),
  stop_wide: fm({ entry: 85397.5, sl: 83000, tp: [86000] }),
  margin_range: fm({ marginMaxUsdt: 100 }),
  cap_bound: fm({ maxNotionalUsdt: 300 }),
  bingx: fm({ spec: specBingx, exchange: 'bingx' }),
  short: fm({ side: 'short', entry: 85397.5, sl: 85783.2, tp: [85011.8] }),
  zec: fm({ spec: specZec, entry: 50, sl: 48.5, tp: [52] }),
  big_equity: fm({ equityUsdt: 100000 }),
  rule_1007: fm({ marginUsdt: 40, lossMinUsdt: 10, lossMaxUsdt: 20, maxNotionalUsdt: 3000 }),
  zero_dist: fm({ entry: 100, sl: 100, tp: [101] }),
};
for (const [k, p] of Object.entries(fmCases)) run('compute_size.json', 'fm_' + k, 'compute_fixed_margin', p, () => sizing.computeFixedMargin(p));

// 四捨五入平局：toFixed 與 Python round 不同的點
for (const [v, d] of [[0.03125, 4], [1.005, 2], [2.5, 0], [0.00005, 4], [1.45, 1], [8.345, 2], [0.125, 2], [-0.03125, 4], [1234.56785, 4]]) {
  run('tofixed.json', `tf_${v}_${d}`, 'to_fixed', { value: v, digits: d }, () => Number(v).toFixed(d));
}

// ---------- drift ----------
const lim = { maxWiden: 1.5, maxTighten: 0.75 };
for (const [k, side, e, sl, tp, live] of [
  ['unchanged', 'long', 100, 98, [104, 106], 100],
  ['sl_crossed_long', 'long', 100, 98, [104], 97.9],
  ['sl_crossed_short', 'short', 100, 102, [96], 102.1],
  ['tp1_passed_long', 'long', 100, 98, [104], 104.5],
  ['tp1_passed_short', 'short', 100, 102, [96], 95],
  ['widen_reject', 'long', 100, 98, [110], 100 + 1.2],
  ['widen_ok', 'long', 100, 98, [110], 100.9],
  ['tighten_reject', 'long', 100, 98, [110], 98.4],
  ['tighten_ok', 'long', 100, 98, [110], 99.0],
  ['toward', 'long', 100, 98, [110], 99.5],
  ['no_price_nan', 'long', 100, 98, [104], NaN],
  ['no_price_zero', 'long', 100, 98, [104], 0],
  ['no_price_null', 'long', 100, 98, [104], null],
  ['zero_dist', 'long', 100, 100, [104], 100],
]) {
  const p = { signal: { side, entry: e, sl, tp }, livePrice: live, limits: lim };
  run('drift.json', 'drift_' + k, 'assess_drift', p, () => drift.assessDrift(p));
}

// ---------- instruments / symbols ----------
for (const s of ['BTCUSDT.P', ' ethusdt.p ', 'BTCUSD', 'BTCUSDT', '1000PEPEUSDT.P', 'BTC-USDT-SWAP', '', null, undefined, 'BTCUSDC.P']) {
  run('mapping.json', 'map_' + String(s), 'symbol_maps', { tv: s ?? null },
    () => ({ instId: instruments.toInstId(s), bingx: instruments.toBingxSymbol(s) }));
}
for (const s of ['BTC-USDT-SWAP', '1000PEPE-USDT-SWAP', 'BTC-USD-SWAP', 'x', null]) {
  run('mapping.json', 'tv_' + String(s), 'to_tv_symbol', { instId: s }, () => instruments.toTvSymbol(s));
}
symbols.reset();
for (const [s, ex] of [['BTCUSDT.P', 'okx'], ['btcusdt.p', 'bingx'], ['ZECUSDT.P', 'bingx'], ['DOGEUSDT.P', 'okx']]) {
  run('mapping.json', `resolve_static_${s}_${ex}`, 'symbols_resolve_static', { tv: s, exchange: ex }, () => symbols.resolve(s, ex));
}
const specs = { 'BTC-USDT-SWAP': { instId: 'BTC-USDT-SWAP', ctVal: 0.01, lotSz: 0.01, minSz: 0.01 },
  'ETH-USDT-SWAP': { instId: 'ETH-USDT-SWAP', ctVal: 0.1, lotSz: 0.01, minSz: 0.01 } };
const inst = symbols.install({ allowed: ['BTCUSDT.P', 'ETHUSDT.P', 'ZZZUSDT.P'], specs });
add('mapping.json', { id: 'install_runtime', fn: 'symbols_install', input: { allowed: ['BTCUSDT.P', 'ETHUSDT.P', 'ZZZUSDT.P'], specs }, expected: { ok: true, value: jsonSafe(inst) } });
for (const [s, ex] of [['BTCUSDT.P', 'okx'], ['ETHUSDT.P', 'okx'], ['ZECUSDT.P', 'okx'], ['BTCUSDT.P', 'bingx']]) {
  run('mapping.json', `resolve_rt_${s}_${ex}`, 'symbols_resolve_runtime', { tv: s, exchange: ex }, () => symbols.resolve(s, ex));
}
symbols.reset();

// ---------- notify.renderDecision ----------
const sig = signal.parseSignal(base, { nowMs: NOW }).signal;
const sz = sizing.computeSize(riskCases.okx_base).sizing;
const fmSz = sizing.computeFixedMargin(fmCases.live_example);
const baseR = { signal: sig, sizing: sz, riskSummary: '✓停止 ✓冪等', reasons: [], dryRun: false, demo: false, exchange: 'okx' };
const nCases = {
  pending_300: { ...baseR, decision: 'pending', expiresAt: NOW + 300000, ttlSec: 300 },
  pending_90: { ...baseR, decision: 'pending', expiresAt: NOW + 90000, ttlSec: 90 },
  pending_30: { ...baseR, decision: 'pending', expiresAt: NOW + 30000, ttlSec: 30 },
  pending_0: { ...baseR, decision: 'pending', expiresAt: NOW, ttlSec: 0 },
  placed_live: { ...baseR, decision: 'placed' },
  placed_demo: { ...baseR, decision: 'placed', demo: true },
  placed_dry: { ...baseR, decision: 'placed', dryRun: true },
  placed_confirmed: { ...baseR, decision: 'placed', confirmedByUser: true },
  skipped: { ...baseR, decision: 'skipped', reasons: ['使用者略過'] },
  rejected: { ...baseR, sizing: null, decision: 'rejected', reasons: ['min_grade: 等級 1 低於下限 2', 'timeframe: x'] },
  short_noscore: { ...baseR, signal: { ...sig, side: 'short', score: null }, decision: 'placed' },
  bingx_unit: { ...baseR, sizing: { ...sz, unit: 'base', orderQty: 0.1296 }, exchange: 'bingx', decision: 'placed' },
};
for (const [k, o] of Object.entries(nCases)) run('notify.json', 'render_' + k, 'render_decision', o, () => notify.renderDecision(o));

// ---------- 交易所請求建構 ----------
const okxCfg = { apiKey: 'KEY', apiSecret: 'SECRET', passphrase: 'PASS', baseUrl: 'https://www.okx.com' };
for (const [k, o] of Object.entries({
  get_demo: { method: 'get', requestPath: '/api/v5/account/balance?ccy=USDT', cfg: okxCfg, demo: true, now: NOW },
  post_live: { method: 'POST', requestPath: '/api/v5/trade/order', body: { a: 1, b: '中' }, cfg: okxCfg, demo: false, now: NOW },
  ts_ms: { method: 'GET', requestPath: '/x', cfg: okxCfg, demo: false, now: 1758470000007 },
})) run('exchange_requests.json', 'okx_sign_' + k, 'okx_build_signed_request', o, () => okx.buildSignedRequest(o));
for (const [k, o] of Object.entries({
  long_net: { instId: 'BTC-USDT-SWAP', side: 'long', orderQty: 12.96, clOrdId: 'vgabc', tdMode: 'isolated', sl: 85011.8, tp: 85783.2, posMode: 'net_mode' },
  short_ls: { instId: 'BTC-USDT-SWAP', side: 'short', orderQty: 1, clOrdId: 'vgabc', tdMode: 'cross', sl: 85783.2, tp: 85011.8, posMode: 'long_short_mode' },
  float_qty: { instId: 'X-USDT-SWAP', side: 'long', orderQty: 0.1, clOrdId: 'vg', tdMode: 'cross', sl: 1e-7, tp: 2, posMode: 'net_mode' },
})) run('exchange_requests.json', 'okx_body_' + k, 'okx_build_order_body', o, () => okx.buildOrderBody(o));
const bxCfg = { apiKey: 'KEY', apiSecret: 'SECRET', baseUrl: 'https://open-api.bingx.com' };
const bxPairs = [['symbol', 'BTC-USDT'], ['side', 'BUY'], ['empty', ''], ['nul', null], ['q', '0.1296']];
run('exchange_requests.json', 'bingx_qs', 'bingx_build_query_string', { pairs: bxPairs }, () => bingx.buildQueryString(bxPairs));
run('exchange_requests.json', 'bingx_sign', 'bingx_sign', { qs: 'a=1&b=2', secret: 'SECRET' }, () => bingx.sign('a=1&b=2', 'SECRET'));
if (bingx.buildSignedRequest) {
  const o = { method: 'post', path: '/openApi/swap/v2/trade/order', pairs: bxPairs, cfg: bxCfg, now: NOW };
  run('exchange_requests.json', 'bingx_signed', 'bingx_build_signed_request', o, () => bingx.buildSignedRequest(o));
}
for (const [k, o] of Object.entries({
  long: { symbol: 'BTC-USDT', side: 'long', orderQty: 0.1296, clientOrderId: 'vgabc', sl: 85011.8, tp: 85783.2 },
  short: { symbol: 'BTC-USDT', side: 'short', orderQty: 0.1, clientOrderId: 'vgabc', sl: 85783.2, tp: 85011.8 },
})) run('exchange_requests.json', 'bingx_order_' + k, 'bingx_build_order_pairs', o, () => bingx.buildOrderPairs(o));

// ---------- 風控閘門 + store ----------
const RISK = { minGrade: 2, allowedTimeframes: ['15', '60'], maxConcurrent: 1, maxConcurrentCeiling: 2,
  overflowPositions: 1, addOnMax: 1, dailyLossLimitUsdt: 20, dailyLossCeilingUsdt: 20, dailyResetCooldownMin: 30 };
const T0 = Date.parse('2026-09-25T00:00:00Z');
const BTC = (over) => ({ ...sig, ...over });
function mkStore(state, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-'));
  if (state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const s = new Store(dir);
  return s;
}
const posOf = (sigId, symbol, side, extra) => ({ sigId, symbol, side, exchange: 'okx', openedAt: T0, ...extra });
const SCEN = {
  clean: { state: {}, now: T0 + 3600000 },
  halted: { state: { halted: true, haltedReason: '手動', haltedSource: 'manual' }, now: T0 },
  processed: { state: { processed: { ['okx:' + sig.sigId]: { at: T0, outcome: 'placed' } } }, now: T0 },
  processed_legacy: { state: { processed: { [sig.sigId]: { at: T0, outcome: 'placed' } } }, now: T0 },
  max_conc: { state: { positions: { 'okx:A-1-xxxxxxxx': posOf('A-1-xxxxxxxx', 'ETHUSDT.P', 'long') } }, now: T0 },
  dup_symbol: { state: { positions: { 'okx:B-1-xxxxxxxx': posOf('B-1-xxxxxxxx', 'BTCUSDT.P', 'long') } }, now: T0 },
  dup_other_side: { state: { positions: { 'okx:B-1-xxxxxxxx': posOf('B-1-xxxxxxxx', 'BTCUSDT.P', 'short') } }, now: T0 },
  dup_layers_full: { state: { positions: { 'okx:B-1-xxxxxxxx': posOf('B-1-xxxxxxxx', 'BTCUSDT.P', 'long', { layers: [{ sigId: 'L1' }] }) } }, now: T0 },
  legacy_pos_key: { state: { positions: { 'B-1-xxxxxxxx': posOf('B-1-xxxxxxxx', 'BTCUSDT.P', 'long') } }, now: T0 },
  loss_hit: { state: { daily: { '2026-09-25': { realisedPnlUsdt: -20, orders: 3 } } }, now: T0 + 3600000 },
  loss_just_under: { state: { daily: { '2026-09-25': { realisedPnlUsdt: -19.99, orders: 3 } } }, now: T0 + 3600000 },
  loss_after_reset: { state: { daily: { '2026-09-25': { realisedPnlUsdt: -25, orders: 3, resetBaseline: -25, resets: [{ at: T0, by: 'telegram', clearedUsdt: 25, note: '' }] } }, lastResetAtMs: T0 }, now: T0 + 3600000 },
  cooldown_active: { state: { daily: { '2026-09-25': { realisedPnlUsdt: -25, orders: 3, resetBaseline: -25, resets: [{ at: T0 + 3600000 - 600000, by: 'telegram', clearedUsdt: 25, note: '' }] } }, lastResetAtMs: T0 + 3600000 - 600000 }, now: T0 + 3600000 },
  cooldown_over_midnight: { state: { lastResetAtMs: Date.parse('2026-09-25T15:50:00Z') }, now: Date.parse('2026-09-25T16:05:00Z') },
  tzday_boundary_pre: { state: { daily: { '2026-09-25': { realisedPnlUsdt: -30, orders: 1 } } }, now: Date.parse('2026-09-25T15:59:59Z') },
  tzday_boundary_post: { state: { daily: { '2026-09-25': { realisedPnlUsdt: -30, orders: 1 } } }, now: Date.parse('2026-09-25T16:00:00Z') },
  override_conc2: { state: { overrides: { maxConcurrent: 2 }, positions: { 'okx:A-1-xxxxxxxx': posOf('A-1-xxxxxxxx', 'ETHUSDT.P', 'long') } }, now: T0 },
  override_conc9_clamped: { state: { overrides: { maxConcurrent: 9 }, positions: { 'okx:A-1-xxxxxxxx': posOf('A-1-xxxxxxxx', 'ETHUSDT.P', 'long'), 'okx:A-2-xxxxxxxx': posOf('A-2-xxxxxxxx', 'SOLUSDT.P', 'long') } }, now: T0 },
  override_loss_lower: { state: { overrides: { dailyLossLimit: 5 }, daily: { '2026-09-25': { realisedPnlUsdt: -6, orders: 1 } } }, now: T0 + 3600000 },
  override_loss_above_ceiling: { state: { overrides: { dailyLossLimit: 500 }, daily: { '2026-09-25': { realisedPnlUsdt: -21, orders: 1 } } }, now: T0 + 3600000 },
  override_cooldown_long: { state: { overrides: { resetCooldownMin: 9999 }, lastResetAtMs: T0 }, now: T0 + 3600000 },
};
const SIGV = {
  btc_g3: BTC({}), grade1: BTC({ grade: 1 }), tf5: BTC({ timeframe: '5' }), tf60: BTC({ timeframe: '60' }),
  eth: BTC({ symbol: 'ETHUSDT.P', sigId: 'ETH-15-1-xxxxxxxx' }),
  btc_short: BTC({ side: 'short', sigId: 'BTC-S-1-xxxxxxxx' }),
};
for (const [sk, sc] of Object.entries(SCEN)) {
  for (const [vk, sv] of Object.entries(SIGV)) {
    if (!['btc_g3', 'grade1', 'tf5', 'eth'].includes(vk) && !/dup|max_conc|override_conc/.test(sk)) continue;
    setNow(sc.now);
    const store = mkStore(sc.state);
    const ctx = { store, risk: RISK, exchange: 'okx' };
    const ev = risk.evaluate(sv, ctx);
    const base_ = { state: sc.state, now: sc.now, signal: sv, risk: RISK, exchange: 'okx' };
    add('risk.json', { id: `eval_${sk}_${vk}`, fn: 'risk_evaluate', input: jsonSafe(base_), expected: { ok: true, value: jsonSafe({ ...ev, summary: risk.summarise(ev),
      overflowEligible: risk.overflowEligible(ev, store, RISK, 'okx'), addOnEligible: (() => { const a = risk.addOnEligible(ev, store, RISK, 'okx', sv); return a && a.base ? { ...a, base: a.base.sigId } : a; })() }) } });
    for (const opts of [null, { allowOverflow: true }, { addOn: { baseSigId: 'B-1-xxxxxxxx' } }]) {
      const rc = risk.recheck(sv, ctx, opts || undefined);
      add('risk.json', { id: `recheck_${sk}_${vk}_${opts ? Object.keys(opts)[0] : 'plain'}`, fn: 'risk_recheck', input: jsonSafe({ ...base_, opts }), expected: { ok: true, value: jsonSafe(rc) } });
    }
  }
}
// 閘門純函式
for (const [sk, sc] of Object.entries(SCEN)) {
  setNow(sc.now); const store = mkStore(sc.state);
  add('risk.json', { id: 'fx_' + sk, fn: 'risk_effective', input: jsonSafe({ state: sc.state, now: sc.now, risk: RISK }), expected: { ok: true, value: jsonSafe({
    maxConcurrent: risk.effectiveMaxConcurrent(store, RISK), dailyLossLimit: risk.effectiveDailyLossLimit(store, RISK),
    cooldownMin: risk.effectiveCooldownMin(store, RISK), cooldown: risk.resetCooldown(store, RISK), lossGate: risk.dailyLossGate(store, RISK),
    overflow: risk.overflowAllowance(store, RISK, 'okx') }) } });
}

// ---------- store 操作序列 ----------
const SEQ = {
  pnl_and_reset: [
    ['at', T0 + 1000], ['recordOrder'], ['recordPnl', -8.5], ['recordPnl', 2.25], ['at', T0 + 2000],
    ['resetDailyLoss', { by: 'telegram', note: 'x' }], ['recordPnl', -3], ['dailyPnlSinceReset'], ['dailyResetInfo'],
    ['at', Date.parse('2026-09-25T16:00:00Z')], ['recordPnl', -1], ['dailyResetInfo'],
  ],
  processed_prune: [
    ['at', T0], ['markProcessed', 'SIG-OLD-00001', 'placed', {}, 'okx'], ['at', T0 + 8 * 86400000],
    ['markProcessed', 'SIG-NEW-00001', 'skipped', {}, 'okx'], ['isProcessed', 'SIG-OLD-00001', 'okx'], ['isProcessed', 'SIG-NEW-00001', 'okx'],
  ],
  positions: [
    ['at', T0], ['addPosition', 'SIG-A-0000001', { symbol: 'BTCUSDT.P', side: 'long', exchange: 'okx', qty: 1 }],
    ['addPosition', 'SIG-A-0000001', { symbol: 'BTCUSDT.P', side: 'long', exchange: 'bingx', qty: 2 }],
    ['openPositionCount', 'okx'], ['openPositionCount', 'bingx'], ['hasPositionForSymbol', 'BTCUSDT.P', 'okx'], ['hasPositionForSymbol', 'ETHUSDT.P', 'okx'],
    ['patchPosition', 'SIG-A-0000001', 'okx', { status: 'open' }], ['listPositions', 'okx'],
    ['addLayer', 'SIG-A-0000001', 'okx', { sigId: 'L1', qty: 1 }], ['listPositions', 'okx'],
    ['removePosition', 'SIG-A-0000001', 'okx'], ['removePosition', 'SIG-A-0000001', 'okx'], ['listPositions'],
  ],
  pending_machine: [
    ['at', T0], ['addPending', 'SIG-P-0000001', { exchange: 'okx', status: 'pending', expiresAt: T0 + 300000, plan: {} }],
    ['claimPending', 'SIG-P-0000001', 'okx'], ['claimPending', 'SIG-P-0000001', 'okx'], ['getPending', 'SIG-P-0000001', 'okx'],
    ['releasePending', 'SIG-P-0000001', 'okx'], ['getPending', 'SIG-P-0000001', 'okx'],
    ['claimPending', 'SIG-P-0000001', 'okx'], ['resolvePending', 'SIG-P-0000001', 'placed', { orderId: 'o1' }, 'okx'], ['listPendings', 'okx'],
    ['addPending', 'SIG-P-0000002', { exchange: 'okx', status: 'pending', expiresAt: T0 + 1000, plan: {} }],
    ['at', T0 + 5000], ['expirePendings', T0 + 5000], ['listPendings', 'okx'], ['listDecisions', 10],
  ],
  halt: [
    ['isHalted'], ['setHalted', true, '日損', 'daily_loss'], ['isHalted'], ['haltedReason'], ['haltedSource'],
    ['clearHaltIfFrom', 'manual'], ['isHalted'], ['clearHaltIfFrom', 'daily_loss'], ['isHalted'],
    ['setOverride', 'maxConcurrent', 2], ['getOverride', 'maxConcurrent'],
  ],
  intents: [
    ['at', T0], ['recordIntent', 'SIG-I-0000001', { clOrdId: 'vg1', instId: 'BTC-USDT-SWAP', symbol: 'BTCUSDT.P', side: 'long', at: T0, exchange: 'okx' }],
    ['listIntents', 'okx'], ['listIntents', 'bingx'], ['clearIntent', 'SIG-I-0000001', 'okx'], ['listIntents', 'okx'],
  ],
  bind_mode: [
    ['bindMode', 'demo', 'shadow'], ['getMode'], ['bindMode', 'demo', 'shadow'], ['bindMode', 'live', 'live'],
  ],
};
for (const [name, seq] of Object.entries(SEQ)) {
  setNow(T0);
  const store = mkStore(null);
  const steps = [];
  for (const step of seq) {
    const [op, ...args] = step;
    if (op === 'at') { setNow(args[0]); steps.push({ op, args }); continue; }
    let out;
    try { out = { ok: true, value: jsonSafe(store[op](...args)) }; } catch (e) { out = { ok: false, throws: String(e.message) }; }
    steps.push({ op, args: jsonSafe(args), out });
  }
  add('store.json', { id: 'seq_' + name, fn: 'store_sequence', input: { steps: seq }, expected: { steps, finalState: jsonSafe(store.state) } });
}
// 狀態檔損壞
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-')); fs.writeFileSync(path.join(dir, 'state.json'), '{bad');
  const s = new Store(dir);
  add('store.json', { id: 'corrupt_file', fn: 'store_load_corrupt', input: { content: '{bad' },
    expected: { state: jsonSafe(s.state), backedUp: Boolean(s.corruptBackup) } });
}
// 舊格式狀態載入
{
  const old = { positions: { 'ABCDEFGH-1': { symbol: 'BTCUSDT.P', side: 'long' } }, processed: { 'ABCDEFGH-1': { at: T0, outcome: 'placed' } }, intents: { 'ABCDEFGH-1': { clOrdId: 'vg1', instId: 'BTC-USDT-SWAP', symbol: 'BTCUSDT.P', side: 'long', at: T0 } } };
  setNow(T0);
  const s = mkStore(old);
  add('store.json', { id: 'legacy_keys', fn: 'store_legacy_load', input: { state: old }, expected: jsonSafe({
    listPositions: s.listPositions('okx'), listIntents: s.listIntents('okx'), isProcessed: s.isProcessed('ABCDEFGH-1', 'okx'), count: s.openPositionCount('okx') }) });
}

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [f, arr] of Object.entries(vec)) { fs.writeFileSync(path.join(OUT, f), JSON.stringify(arr, null, 1).replace(/\/tmp\/vg-[A-Za-z0-9]+/g, '<DATA_DIR>').replace(/corrupt-\d+/g,'corrupt-<TS>')); total += arr.length; console.log(f, arr.length); }
console.log('total', total);
