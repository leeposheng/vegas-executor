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
const SID = 'BTCUSDT.P-60-1758469980000-long';
const man = { executionMode: 'manual' };

scen('auto_ok', {}, null, [H(sig())]);
scen('auto_duplicate', {}, null, [H(sig()), H(sig(), 1000)]);
scen('auto_shortside', {}, null, [H(sig({ sig_id: 'BTCUSDT.P-60-1758469980000-short', side: 'short', sl: 85783.2, tp: [85011.8, 84626] }))]);
scen('reject_parse', {}, null, [H(sig({ side: 'x' }))]);
scen('reject_expired', {}, null, [H(sig({ ts: NOW - 120000 }))]);
scen('reject_grade', {}, null, [H(sig({ grade: 1 }))]);
scen('reject_timeframe', {}, null, [H(sig({ tf: '5' }))]);
scen('reject_symbol', {}, null, [H(sig({ symbol: 'DOGEUSDT.P' }))]);
scen('reject_killswitch', {}, { halted: true, haltedReason: '手動', haltedSource: 'manual' }, [H(sig())]);
scen('reject_dailyloss', {}, { daily: { '2025-09-21': { realisedPnlUsdt: -60, orders: 2 } } }, [H(sig())]);
scen('reject_maxconc', {}, { positions: { 'okx:p1': { sigId: 'p1', symbol: 'A', exchange: 'okx' }, 'okx:p2': { sigId: 'p2', symbol: 'B', exchange: 'okx' }, 'okx:p3': { sigId: 'p3', symbol: 'C', exchange: 'okx' } } }, [H(sig())]);
scen('reject_dupsymbol', {}, { positions: { 'okx:p1': { sigId: 'p1', symbol: 'BTCUSDT.P', side: 'long', exchange: 'okx' } } }, [H(sig())]);
scen('by_grade_low_pending', { executionMode: 'by_grade', autoGradeMin: 3 }, null, [H(sig({ grade: 2 }))]);
scen('by_grade_high_auto', { executionMode: 'by_grade', autoGradeMin: 3 }, null, [H(sig({ grade: 3 }))]);
scen('manual_pending', man, null, [H(sig())]);
scen('manual_confirm', man, null, [H(sig()), C(SID, 10000)]);
scen('manual_confirm_twice', man, null, [H(sig()), C(SID, 1000), C(SID, 2000)]);
scen('manual_skip', man, null, [H(sig()), K(SID, 5000)]);
scen('manual_expired', man, null, [H(sig()), C(SID, 301000)]);
scen('manual_ttl_edge_exact', man, null, [H(sig()), C(SID, 300000)]);
scen('confirm_notfound', man, null, [C('nope', 0)]);
scen('confirm_killswitch', man, null, [H(sig()), { op: 'store', call: ['setHalted', true, '臨時停止'] }, C(SID, 1000)]);
scen('confirm_full', man, null, [H(sig()), { op: 'store', call: ['addPosition', 'p1', { symbol: 'X1' }] }, { op: 'store', call: ['addPosition', 'p2', { symbol: 'X2' }] }, { op: 'store', call: ['addPosition', 'p3', { symbol: 'X3' }] }, C(SID, 1000)]);
scen('fixed_margin_ok', Object.assign({}, { risk: Object.assign({}, pipelineCfg().risk, FM) }), null, [H(sig({ tf: '60' }))]);
scen('fixed_margin_reject_band', { risk: Object.assign({}, pipelineCfg().risk, FM) }, null, [H(sig({ sl: 85300, tp: [85500] }))]);
const drift = { risk: Object.assign({}, pipelineCfg().risk, { driftCheck: true, driftMaxWiden: 1.5, driftMaxTighten: 0.75 }) };
scen('drift_unchanged', Object.assign({ executionMode: 'manual' }, drift), null, [H(sig()), C(SID, 5000)], 85397.5);
scen('drift_resize', Object.assign({ executionMode: 'manual' }, drift), null, [H(sig()), C(SID, 5000)], 85500);
scen('drift_sl_crossed', Object.assign({ executionMode: 'manual' }, drift), null, [H(sig()), C(SID, 5000)], 85000);
scen('drift_tp1_passed', Object.assign({ executionMode: 'manual' }, drift), null, [H(sig()), C(SID, 5000)], 85800);
scen('drift_widen_reject', Object.assign({ executionMode: 'manual' }, drift), null, [H(sig()), C(SID, 5000)], 85600);
scen('drift_tighten_reject', Object.assign({ executionMode: 'manual' }, drift), null, [H(sig()), C(SID, 5000)], 85297.5);
scen('drift_toward_ok', Object.assign({ executionMode: 'manual' }, drift), null, [H(sig()), C(SID, 5000)], 85350);
scen('drift_no_price', Object.assign({ executionMode: 'manual' }, drift), null, [H(sig()), C(SID, 5000)], NaN);
scen('addon_disabled_dup', { risk: Object.assign({}, pipelineCfg().risk, { addOnMax: 0 }) }, { positions: { 'okx:p1': { sigId: 'p1', symbol: 'BTCUSDT.P', side: 'long', exchange: 'okx' } } }, [H(sig())]);

// ---- 權益來源 ----
scen('equity_exchange_ok', {}, null, [H(sig())], undefined, { eq: 10000 });
scen('equity_small_account_cap', { risk: Object.assign({}, pipelineCfg().risk, FM) }, null, [H(sig({ tf: '60' }))], undefined, { eq: 400 });
scen('equity_cache_second_call', { risk: Object.assign({}, pipelineCfg().risk, { equityCacheMs: 60000 }) }, null, [H(sig()), H(sig({ sig_id: 'BTCUSDT.P-60-1758469990000-long', ts: NOW + 8000 }), 10000)], undefined, { eq: 9000 });
// ---- 加倉與超額 ----
const LONGPOS = { 'okx:p1': { sigId: 'p1', symbol: 'BTCUSDT.P', side: 'long', exchange: 'okx', entry: 84000, leverage: 10, layers: [] } };
const addCfg = (o) => ({ executionMode: 'auto', risk: Object.assign({}, pipelineCfg().risk, { addOnMax: 1, addOnRequireProfit: true }, o || {}) });
scen('addon_ok_pending_then_confirm', addCfg(), { positions: LONGPOS }, [H(sig()), C(SID, 5000)], undefined, { positions: [{ instId: 'BTC-USDT-SWAP', posSide: 'long', pos: 5, upl: 12.5, lever: 10 }] });
scen('addon_loss_reject', addCfg(), { positions: LONGPOS }, [H(sig())], undefined, { positions: [{ instId: 'BTC-USDT-SWAP', posSide: 'long', pos: 5, upl: -3, lever: 10 }] });
scen('addon_not_on_exchange', addCfg(), { positions: LONGPOS }, [H(sig())], undefined, { positions: [] });
scen('addon_wrong_side_live', addCfg(), { positions: LONGPOS }, [H(sig())], undefined, { positions: [{ instId: 'BTC-USDT-SWAP', posSide: 'short', pos: -5, upl: 5, lever: 10 }] });
scen('addon_layers_full', addCfg(), { positions: { 'okx:p1': Object.assign({}, LONGPOS['okx:p1'], { layers: [{ sigId: 'L1' }] }) } }, [H(sig())], undefined, { positions: [{ instId: 'BTC-USDT-SWAP', posSide: 'long', pos: 5, upl: 5, lever: 10 }] });
const full3 = { 'okx:p1': { sigId: 'p1', symbol: 'AAA', exchange: 'okx' }, 'okx:p2': { sigId: 'p2', symbol: 'BBB', exchange: 'okx' }, 'okx:p3': { sigId: 'p3', symbol: 'CCC', exchange: 'okx' } };
const ovCfg = (n) => ({ executionMode: 'auto', risk: Object.assign({}, pipelineCfg().risk, { overflowPositions: n }) });
scen('overflow_pending_then_confirm', ovCfg(1), { positions: full3 }, [H(sig()), C(SID, 5000)]);
scen('overflow_disabled', ovCfg(0), { positions: full3 }, [H(sig())]);
scen('overflow_recheck_filled_meanwhile', ovCfg(1), { positions: full3 }, [H(sig()), { op: 'store', call: ['addPosition', 'p4', { symbol: 'DDD' }] }, C(SID, 5000)]);
// ---- Zeabur 實際設定（DRY_RUN 版）----
const ZB = { sizingMode: 'fixed_margin', fixedMarginUsdt: 100, fixedMarginMaxUsdt: 0, lossMinUsdt: 20, lossMaxUsdt: 45, feeRateOneWay: 0.0005,
  pctPerTrade: 0.005, equityUsdt: 10000, equitySource: 'exchange', equityCacheMs: 60000, maxConcurrent: 5, maxConcurrentCeiling: 5, overflowPositions: 2,
  addOnMax: 1, addOnRequireProfit: true, dailyLossLimitUsdt: 50, dailyLossCeilingUsdt: 100, dailyResetLimit: 1, dailyResetCooldownMin: 30,
  maxNotionalUsdt: 20000, maxNotionalMult: 3, leverage: 40, autoLeverage: true, minLiqCushion: 3, driftCheck: true, driftMaxWiden: 1.5,
  driftMaxTighten: 0.75, minGrade: 1, allowedTimeframes: ['5', '15', '30', '60'], maxSignalAgeSec: 60 };
const zbCfg = (o) => Object.assign({ executionMode: 'by_grade', autoGradeMin: 2, pendingTtlSec: 300, risk: Object.assign({}, ZB, o || {}) });
const zs = (o) => sig(Object.assign({ tf: '15' }, o || {}));
scen('zb_grade3_auto', zbCfg(), null, [H(zs())], undefined, { eq: 10000 });
scen('zb_grade2_auto', zbCfg(), null, [H(zs({ grade: 2, sig_id: 'BTCUSDT.P-15-1758469980001-long' }))]);
scen('zb_grade1_pending_confirm', zbCfg(), null, [H(zs({ grade: 1, sig_id: 'BTCUSDT.P-15-1758469980002-long' })), C('BTCUSDT.P-15-1758469980002-long', 20000)], 85420);
scen('zb_grade1_drift_reject', zbCfg(), null, [H(zs({ grade: 1, sig_id: 'BTCUSDT.P-15-1758469980002-long' })), C('BTCUSDT.P-15-1758469980002-long', 20000)], 85700);
scen('zb_tf5_tight_stop_band_reject', zbCfg(), null, [H(zs({ tf: '5', sl: 85300, tp: [85500, 85700] }))]);
scen('zb_wide_stop_autolev', zbCfg(), null, [H(zs({ sl: 83000, tp: [86000, 86500] }))]);
scen('zb_tf1_not_allowed', zbCfg(), null, [H(zs({ tf: '1' }))]);
scen('zb_eth_short', zbCfg(), null, [H(zs({ symbol: 'ETHUSDT.P', sig_id: 'ETHUSDT.P-15-1758469980000-short', side: 'short', entry: 3000, sl: 3015, tp: [2985, 2970] }))]);
scen('zb_dailyloss_limit_hit', zbCfg(), { daily: { '2025-09-21': { realisedPnlUsdt: -50, orders: 2 } } }, [H(zs())]);
scen('zb_fifth_position_ok_sixth_overflow', zbCfg(), { positions: Object.fromEntries([1, 2, 3, 4, 5].map((i) => ['okx:p' + i, { sigId: 'p' + i, symbol: 'S' + i, exchange: 'okx' }])) }, [H(zs())]);

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
  fs.writeFileSync(path.join(OUT, 'pipeline.json'), JSON.stringify(out, null, 1).replace(/\/tmp\/vg-[A-Za-z0-9]+/g, '<DATA_DIR>'));
  origLog('pipeline scenarios', out.length);
  for (const o of out) origLog(o.id, '→', o.expected.results.map((r) => r.result ? r.result.decision + (r.result.reasons ? ':' + String(r.result.reasons[0]).slice(0, 40) : '') : 'THREW ' + r.threw).join(' | '));
})();
