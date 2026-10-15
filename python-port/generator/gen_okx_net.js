'use strict';
// OKX 簽章網路層向量：以腳本化的假 fetch 驅動 Node 版，記錄「送出的請求」與「結果／錯誤訊息」。
const fs = require('fs'), path = require('path');
const SRC = process.argv[2], OUT = process.argv[3];
const R = (m) => require(path.join(SRC, m));
const NOW = 1758470000000;
const RealDate = Date; let FROZEN = NOW;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(FROZEN); } static now() { return FROZEN; } }
global.Date = FakeDate;
const ol = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
const okx = R('exchanges/okx');

let queue = [], seen = [];
global.fetch = async (url, opts) => {
  seen.push({ method: (opts && opts.method) || 'GET', url: String(url), headers: (opts && opts.headers) || null, body: (opts && opts.body) || null });
  const r = queue.shift();
  if (!r) throw new Error('no scripted response');
  if (r.throw) throw new Error(r.throw);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => { if (r.badJson) throw new Error('bad json'); return r.json; } };
};
const clean = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x, (k, v) => (typeof v === 'number' && !Number.isFinite(v)) ? { __num: String(v) } : v));
const CFG = { apiKey: 'K', apiSecret: 'S', passphrase: 'P', baseUrl: 'https://www.okx.com' };
const ok = (data) => ({ status: 200, json: { code: '0', msg: '', data } });
const cases = [];
const C = (id, fn, args, responses, flags) => cases.push({ id, fn, args, responses, flags: flags === undefined ? { demo: true } : flags });

C('acct_lv2_net', 'fetchAccountConfig', [], [ok([{ acctLv: '2', posMode: 'net_mode', uid: '123456789012' }])]);
C('acct_lv3_ls_live', 'fetchAccountConfig', [], [ok([{ acctLv: '3', posMode: 'long_short_mode' }])], { demo: false });
C('acct_spot', 'fetchAccountConfig', [], [ok([{ acctLv: '1', posMode: 'net_mode' }])]);
C('acct_unknown', 'fetchAccountConfig', [], [ok([{ acctLv: '9' }])]);
C('acct_empty', 'fetchAccountConfig', [], [ok([])]);
C('err_50111', 'fetchAccountConfig', [], [{ status: 401, json: { code: '50111', msg: 'Invalid OK-ACCESS-KEY', data: [] } }]);
C('err_http500_nojson', 'fetchAccountConfig', [], [{ status: 500, json: null, badJson: true }]);
C('err_http429', 'fetchAccountConfig', [], [{ status: 429, json: { code: '50011', msg: 'Too Many Requests' } }]);
C('err_network', 'fetchAccountConfig', [], [{ throw: 'fetch failed' }]);
C('equity_eq', 'fetchEquity', [], [ok([{ totalEq: '1000', details: [{ ccy: 'USDT', eq: '812.5', availEq: '700' }] }])]);
C('equity_fallback_total', 'fetchEquity', [], [ok([{ totalEq: '950.25', details: [{ ccy: 'BTC', eq: '1' }] }])]);
C('equity_zero_eq_uses_total', 'fetchEquity', [], [ok([{ totalEq: '77', details: [{ ccy: 'USDT', eq: '0' }] }])]);
C('equity_unparsable', 'fetchEquity', [], [ok([{ totalEq: '', details: [] }])]);
C('equity_err_sCode', 'fetchEquity', [], [{ status: 200, json: { code: '0', data: [{ sCode: '51010', sMsg: 'mode' }] } }]);
C('order_filled', 'fetchOrderByClOrdId', [{ instId: 'BTC-USDT-SWAP', clOrdId: 'vgabc123' }], [ok([{ ordId: '9', clOrdId: 'vgabc123', state: 'filled', accFillSz: '4.75', avgPx: '84010.5', side: 'buy', posSide: 'net', cTime: '1758469990000' }])]);
C('order_live_zero', 'fetchOrderByClOrdId', [{ instId: 'BTC-USDT-SWAP', clOrdId: 'vgabc123' }], [ok([{ ordId: '9', state: 'live', accFillSz: '0', avgPx: '' }])]);
C('order_notfound_51603', 'fetchOrderByClOrdId', [{ instId: 'BTC-USDT-SWAP', clOrdId: 'vgabc123' }], [{ status: 200, json: { code: '51603', msg: 'Order does not exist', data: [] } }]);
C('order_empty_data', 'fetchOrderByClOrdId', [{ instId: 'BTC-USDT-SWAP', clOrdId: 'vgabc123' }], [ok([])]);
C('order_other_err', 'fetchOrderByClOrdId', [{ instId: 'BTC-USDT-SWAP', clOrdId: 'vgabc123' }], [{ status: 401, json: { code: '50113', msg: 'bad sign' } }]);
C('positions_filter', 'fetchPositions', [], [ok([{ instId: 'BTC-USDT-SWAP', posSide: 'net', pos: '4.75', avgPx: '84000', upl: '12.3', mgnMode: 'isolated', lever: '40' }, { instId: 'ETH-USDT-SWAP', pos: '0', avgPx: '' }, { instId: 'SOL-USDT-SWAP', posSide: 'short', pos: '-3', avgPx: '150', upl: '-1', mgnMode: 'cross', lever: '10' }])]);
C('positions_empty', 'fetchPositions', [], [ok([])]);
C('positions_err', 'fetchPositions', [], [{ status: 200, json: { code: '50011', msg: 'rate' } }]);
const H1 = (o) => Object.assign({ instId: 'BTC-USDT-SWAP', posSide: 'net', openAvgPx: '84000', closeAvgPx: '84500', realizedPnl: '19.25', pnl: '23.75', fee: '-4', fundingFee: '-0.5', type: '2', cTime: '1758469000000', uTime: '1758470500000', posId: 'p1' }, o || {});
C('history_basic', 'fetchPositionsHistory', [{ instId: 'BTC-USDT-SWAP', afterMs: 1758469000000 }], [ok([H1(), H1({ uTime: '1758000000000', posId: 'old' }), H1({ uTime: '', posId: 'nouTime' }), H1({ type: '', posId: 'notype' })])]);
C('history_no_params', 'fetchPositionsHistory', [{}], [ok([H1()])]);
C('ensure_net_cross_twice', 'ensureLeverage2', [{ instId: 'BTC-USDT-SWAP', leverage: 40, tdMode: 'cross', posMode: 'net_mode' }], [ok([{ lever: '40' }]), ok([{ lever: '40' }])]);
C('ensure_iso_ls', 'ensureLeverage', [{ instId: 'BTC-USDT-SWAP', leverage: 40, tdMode: 'isolated', posMode: 'long_short_mode' }], [ok([{}]), ok([{}])]);
C('ensure_iso_net', 'ensureLeverage', [{ instId: 'ETH-USDT-SWAP', leverage: 12.5, tdMode: 'isolated', posMode: 'net_mode' }], [ok([{}])]);
C('ensure_no_leverage', 'ensureLeverage', [{ instId: 'BTC-USDT-SWAP', leverage: 0, tdMode: 'cross' }], []);
C('ensure_fail_not_cached', 'ensureLeverageFailThenOk', [{ instId: 'BTC-USDT-SWAP', leverage: 40, tdMode: 'cross', posMode: 'net_mode' }], [{ status: 200, json: { code: '1', data: [{ sCode: '59000', sMsg: 'has pos' }] } }, ok([{}])]);
C('preflight_ok', 'preflight', [{ leverage: 40, tdMode: 'isolated' }], [ok([{ acctLv: '2', posMode: 'net_mode' }]), ok([{ totalEq: '1', details: [{ ccy: 'USDT', eq: '5000' }] }])]);
C('preflight_spot_and_equity_fail', 'preflight', [{ leverage: 40, tdMode: 'cross' }], [ok([{ acctLv: '1', posMode: 'net_mode' }]), { status: 401, json: { code: '50111', msg: 'k' } }]);
C('preflight_ls_warn_specs', 'preflight', [{ instIds: ['BTC-USDT-SWAP', 'XXX-USDT-SWAP'], leverage: 40, tdMode: 'cross', staticSpecs: { 'BTC-USDT-SWAP': { ctVal: 0.01, lotSz: 0.01, minSz: 0.01 } }, liveSpecs: { 'BTC-USDT-SWAP': { ctVal: 0.001, lotSz: 0.01, minSz: 0.01 } } }],
  [ok([{ acctLv: '2', posMode: 'long_short_mode' }]), ok([{ totalEq: '9', details: [{ ccy: 'USDT', eq: '9' }] }])]);
C('preflight_verify_leverage', 'preflight', [{ instIds: ['BTC-USDT-SWAP'], leverage: 40, tdMode: 'isolated', verifyLeverage: true }],
  [ok([{ acctLv: '2', posMode: 'long_short_mode' }]), ok([{ totalEq: '9', details: [{ ccy: 'USDT', eq: '9' }] }]), ok([{}]), ok([{}])]);
const ALGO = (o) => Object.assign({ algoId: 'a1', instId: 'BTC-USDT-SWAP', ordType: 'oco', state: 'live', slTriggerPx: '85011.8', tpTriggerPx: '85783.2', sz: '12.96', posSide: 'net' }, o || {});
C('algo_pending', 'fetchAlgoPending', [{ instId: 'BTC-USDT-SWAP' }], [ok([ALGO()]), ok([ALGO({ algoId: 'a2', ordType: 'conditional', slTriggerPx: '', tpTriggerPx: '', sz: '' })])]);
C('protect_ok', 'verifyProtection', [{ instId: 'BTC-USDT-SWAP', sl: 85011.8 }], [ok([ALGO()]), ok([])]);
C('protect_missing', 'verifyProtection', [{ instId: 'BTC-USDT-SWAP', sl: 85011.8 }], [ok([]), ok([])]);
C('protect_tp_only', 'verifyProtection', [{ instId: 'BTC-USDT-SWAP', sl: 85011.8 }], [ok([ALGO({ slTriggerPx: '' })]), ok([])]);
C('protect_price_mismatch', 'verifyProtection', [{ instId: 'BTC-USDT-SWAP', sl: 85011.8 }], [ok([ALGO({ slTriggerPx: '84000' })]), ok([])]);
C('protect_other_inst', 'verifyProtection', [{ instId: 'BTC-USDT-SWAP', sl: 85011.8 }], [ok([ALGO({ instId: 'ETH-USDT-SWAP' })]), ok([])]);
C('protect_query_throws', 'verifyProtection', [{ instId: 'BTC-USDT-SWAP', sl: 85011.8 }], [{ throw: 'fetch failed' }]);
const OP = (o) => Object.assign({ instId: 'BTC-USDT-SWAP', side: 'long', orderQty: 12.96, clOrdId: 'vgabc123', tdMode: 'isolated', posMode: 'net_mode', sl: 85011.8, tp: 85783.2 }, o || {});
C('place_ok', 'placeOrder', [OP()], [ok([{ ordId: '1', clOrdId: 'vgabc123', sCode: '0', sMsg: '' }])], { demo: true, dryRun: false });
C('place_ok_live_ls_short', 'placeOrder', [OP({ side: 'short', posMode: 'long_short_mode' })], [ok([{ sCode: '0' }])], { demo: false, dryRun: false });
C('place_sCode_fail', 'placeOrder', [OP()], [{ status: 200, json: { code: '1', msg: 'All operations failed', data: [{ sCode: '51008', sMsg: 'Insufficient margin' }] } }], { demo: true, dryRun: false });
C('place_http_fail', 'placeOrder', [OP()], [{ status: 503, json: null, badJson: true }], { demo: true, dryRun: false });
C('place_network_throw', 'placeOrder', [OP()], [{ throw: 'socket hang up' }], { demo: true, dryRun: false });
C('place_dry', 'placeOrder', [OP()], [], { demo: true, dryRun: true });
C('ticker_ok', 'fetchTicker', ['BTC-USDT-SWAP'], [ok([{ instId: 'BTC-USDT-SWAP', last: '85000.5', askPx: '85001', bidPx: '0', ts: '1758469999000' }])]);
C('ticker_bad_last', 'fetchTicker', ['BTC-USDT-SWAP'], [ok([{ last: 'abc' }])]);
C('ticker_http500', 'fetchTicker', ['BTC-USDT-SWAP'], [{ status: 500, json: {} }]);
C('instrument_ok', 'fetchInstrument', ['BTC-USDT-SWAP'], [ok([{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', lotSz: '0.01', minSz: '0.01', tickSz: '0.1' }])]);
C('instrument_empty', 'fetchInstrument', ['BTC-USDT-SWAP'], [ok([])]);

(async () => {
  const out = [];
  for (const c of cases) {
    queue = c.responses.slice(); seen = []; FROZEN = NOW; okx.resetLeverageCache();
    let res, threw = null, res2;
    try {
      if (c.fn === 'ensureLeverage2') { res = await okx.ensureLeverage(c.args[0], CFG, c.flags); res2 = await okx.ensureLeverage(c.args[0], CFG, c.flags); }
      else if (c.fn === 'ensureLeverageFailThenOk') {
        try { await okx.ensureLeverage(c.args[0], CFG, c.flags); res = 'unexpected-ok'; } catch (e) { res = { firstThrew: String(e.message) }; }
        res2 = await okx.ensureLeverage(c.args[0], CFG, c.flags);
      }
      else if (['fetchTicker', 'fetchInstrument'].includes(c.fn)) res = await okx[c.fn](c.args[0], CFG);
      else if (['ensureLeverage', 'fetchOrderByClOrdId', 'fetchPositionsHistory', 'fetchAlgoPending', 'verifyProtection', 'placeOrder', 'preflight'].includes(c.fn)) res = await okx[c.fn](c.args[0], CFG, c.flags);
      else res = await okx[c.fn](CFG, c.flags);
    } catch (e) { threw = String(e.message); }
    out.push({ id: 'okxnet_' + c.id, fn: c.fn, input: clean({ args: c.args, responses: c.responses, flags: c.flags, now: NOW }),
      expected: clean({ result: res, result2: res2, threw, requests: seen }) });
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'okx_net.json'), JSON.stringify(out, null, 1));
  ol('okx_net vectors', out.length);
  for (const o of out) ol(o.id, o.expected.threw ? 'THREW ' + o.expected.threw.slice(0, 60) : 'ok', o.expected.requests.length);
})();
