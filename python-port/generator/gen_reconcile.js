'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const SRC = process.argv[2], OUT = process.argv[3];
const R = (m) => require(path.join(SRC, m));
const T0 = Date.parse('2026-09-25T00:00:00Z');
const RealDate = Date; let FROZEN = T0;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(FROZEN); } static now() { return FROZEN; } }
global.Date = FakeDate;
const ol = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
const notify = R('notify'); const sent = []; notify.send = async (t) => { sent.push(t); return { sent: false }; };
const rec = R('reconcile'); const { Store } = R('store');
const clean = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));
const mk = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'rc-')));
const HIST = (o) => Object.assign({ instId: 'BTC-USDT-SWAP', posSide: 'long', openAvgPx: 84000, closeAvgPx: 84500, realizedPnl: 19.25, pnl: 23.75,
  fee: -4.0, fundingFee: -0.5, closeType: '3', openedAtMs: T0, closedAtMs: T0 + 3600000, posId: 'p1' }, o || {});
const POS = (o) => Object.assign({ symbol: 'BTCUSDT.P', exchange: 'okx', side: 'long', entry: 84000, sl: 83500, tp: [84500, 85000, 85500],
  orderQty: 4.75, baseQty: 0.0475, clientOrderId: 'c1' }, o || {});
const BTCLIVE = { instId: 'BTC-USDT-SWAP', pos: 4.75 };
const INT = (o) => Object.assign({ clOrdId: 'c-int-1', instId: 'BTC-USDT-SWAP', symbol: 'BTCUSDT.P', side: 'long', exchange: 'okx',
  entry: 84000, sl: 83500, tp: [84500], orderQty: 4.75, baseQty: 0.0475 }, o || {});
const cases = [];
const c = (id, o) => cases.push({ id, cfg: o.cfg || { okx: {}, demo: true }, positions: o.positions || [], intents: o.intents || [],
  live: o.live || [], history: o.history || [], order: o.order, orderThrow: o.orderThrow, positionsThrow: o.positionsThrow,
  historyThrow: o.historyThrow, rounds: o.rounds, dt: o.dt === undefined ? 7200000 : o.dt, exchangeName: o.exchangeName });
const P = (openedOffset, o) => ({ sigId: 'sig-btc-1', openedOffsetMs: openedOffset, fields: POS(o) });
const I = (atOffset, o) => ({ sigId: 'sig-int-1', atOffsetMs: atOffset, fields: INT(o) });

c('still_open', { positions: [P(0)], live: [BTCLIVE] });
c('closed_tp', { positions: [P(0)], history: [HIST()] });
c('closed_loss', { positions: [P(0)], history: [HIST({ closeAvgPx: 83500, realizedPnl: -22.5, pnl: -20, closeType: '3' })] });
c('closed_sl_infer', { positions: [P(0)], history: [HIST({ closeAvgPx: 83510, realizedPnl: -5, pnl: -4 })] });
c('closed_manual_type', { positions: [P(0)], history: [HIST({ closeType: '1' })] });
c('closed_liquidation_type', { positions: [P(0)], history: [HIST({ closeType: '2', closeAvgPx: 83000, realizedPnl: -30 })] });
c('grace_no_record', { positions: [P(0)], dt: 5000 });
c('past_grace_no_record', { positions: [P(0)], dt: 600000 });
c('stale_no_record', { positions: [P(0)], dt: 31 * 60000 });
c('positions_throw', { positions: [P(0)], history: [HIST()], positionsThrow: '網路逾時' });
c('history_throw', { positions: [P(0)], historyThrow: '限流' });
c('cross_midnight_pnl', { positions: [P(15 * 3600000)], history: [HIST({ openedAtMs: T0 + 15 * 3600000, closedAtMs: T0 + 15.5 * 3600000 + 1800000 })], dt: 17 * 3600000 });
c('open_time_within_tol', { positions: [P(0)], history: [HIST({ openedAtMs: T0 + 4 * 60000 })] });
c('open_time_outside_tol', { positions: [P(0)], history: [HIST({ openedAtMs: T0 - 6 * 60000 })] });
c('open_time_outside_tol_stale', { positions: [P(0)], history: [HIST({ openedAtMs: T0 - 6 * 60000, closedAtMs: T0 + 20 * 60000 })], dt: 31 * 60000 });
c('side_mismatch', { positions: [P(0)], history: [HIST({ posSide: 'short' })] });
c('two_history_pick_latest', { positions: [P(0)], history: [HIST({ posId: 'old', openedAtMs: T0 - 3 * 3600000, closedAtMs: T0 - 2 * 3600000, realizedPnl: -99 }), HIST()] });
c('two_positions_one_closed', { positions: [P(0), { sigId: 'sig-eth-1', openedOffsetMs: 0, fields: POS({ symbol: 'ETHUSDT.P', clientOrderId: 'c2' }) }], live: [{ instId: 'ETH-USDT-SWAP', pos: 1 }], history: [HIST()] });
c('intent_filled', { intents: [I(0)], order: { state: 'filled', filledSz: 4.75, avgPx: 84010 }, dt: 600000 });
c('intent_partial', { intents: [I(0)], order: { state: 'partially_filled', filledSz: 2, avgPx: 84010 }, dt: 600000 });
c('intent_canceled', { intents: [I(0)], order: { state: 'canceled', filledSz: 0 }, dt: 600000 });
c('intent_live', { intents: [I(0)], order: { state: 'live', filledSz: 0 }, dt: 600000 });
c('intent_notfound', { intents: [I(0)], order: null, dt: 600000 });
c('intent_throw', { intents: [I(0)], orderThrow: '網路逾時', dt: 600000 });
c('intent_throw_stale_no_live', { intents: [I(0)], orderThrow: '網路逾時', dt: 31 * 60000 });
c('intent_throw_stale_live_pos', { intents: [I(0)], orderThrow: '網路逾時', dt: 31 * 60000, live: [BTCLIVE] });
c('intent_grace', { intents: [I(0)], order: null, dt: 5000 });
c('stale_two_rounds_release', { positions: [P(0)], rounds: [10 * 60000, 41 * 60000] });
c('stale_two_rounds_relaxed', { positions: [P(0)], history: [HIST({ openedAtMs: T0 - 6 * 60000, closedAtMs: T0 + 5 * 60000 })], rounds: [10 * 60000, 41 * 60000] });
c('stale_two_rounds_recovered', { positions: [P(0)], rounds: [10 * 60000, 12 * 60000], live: [] });
c('orphan', { positions: [P(0)], live: [BTCLIVE, { instId: 'ETH-USDT-SWAP', pos: 2, avgPx: 3000, upl: -12 }] });
c('bingx_flags', { cfg: { bingx: { k: 1 }, demo: false }, exchangeName: 'bingx', positions: [P(0, { exchange: 'bingx', symbol: 'BTCUSDT.P' })], live: [] });
c('live_flag_false', { cfg: { okx: {}, demo: false }, positions: [P(0)], history: [HIST()] });

(async () => {
  const out = [];
  for (const k of cases) {
    sent.length = 0; FROZEN = T0; const store = mk();
    for (const p of k.positions) { store.addPosition(p.sigId, p.fields); const key = Object.keys(store.state.positions).find((x) => x.endsWith(p.sigId)); store.state.positions[key].openedAt = new Date(T0 + p.openedOffsetMs).toISOString(); }
    for (const i of k.intents) { store.recordIntent(i.sigId, i.fields); const key = Object.keys(store.state.intents).find((x) => x.endsWith(i.sigId)); store.state.intents[key].at = new Date(T0 + i.atOffsetMs).toISOString(); }
    store.save();
    const initialState = clean(store.state);
    const flags = [];
    const ex = {
      async fetchPositions(cfg, f) { flags.push(clean(f)); if (k.positionsThrow) throw new Error(k.positionsThrow); return k.live; },
      async fetchPositionsHistory(p, cfg, f) { flags.push(clean(f)); if (k.historyThrow) throw new Error(k.historyThrow); return k.history; },
      async fetchOrderByClOrdId(p, cfg, f) { flags.push(clean(f)); if (k.orderThrow) throw new Error(k.orderThrow); return k.order === undefined ? null : k.order; },
    };
    FROZEN = T0 + k.dt;
    let r, threw; const rr = [];
    for (const dt of (k.rounds || [k.dt])) {
      FROZEN = T0 + dt;
      try { r = await rec.reconcileOnce({ config: k.cfg, store, exchange: ex, now: T0 + dt, exchangeName: k.exchangeName }); } catch (e) { threw = String(e.message); }
      rr.push(clean(r));
    }
    out.push({ id: 'rc_' + k.id, fn: 'reconcile_once', input: { cfg: k.cfg, initialState, live: k.live, history: k.history, order: k.order === undefined ? null : k.order,
      orderThrow: k.orderThrow || null, positionsThrow: k.positionsThrow || null, historyThrow: k.historyThrow || null, now: T0 + k.dt, rounds: k.rounds || null, exchangeName: k.exchangeName || null },
      expected: { result: clean(r), rounds: k.rounds ? rr : undefined, threw: threw || null, flagsSeen: flags, notifications: sent.slice(), finalState: clean(store.state) } });
  }
  // matchHistory 單獨
  const mh = [];
  const tr = { symbol: 'BTCUSDT.P', side: 'long', entry: 84000, openedAt: new Date(T0).toISOString() };
  for (const [id, hist, now, extra] of [['ok', [HIST()], T0 + 7200000], ['none', [], T0 + 7200000], ['wrong_inst', [HIST({ instId: 'ETH-USDT-SWAP' })], T0 + 7200000], ['tol_edge', [HIST({ openedAtMs: T0 - 300000 })], T0 + 7200000]]) {
    let v; try { v = rec.matchHistory(hist, tr); } catch (e) { v = { threw: String(e.message) }; }
    mh.push({ id: 'mh_' + id, fn: 'match_history', input: { tracked: tr, history: hist, now }, expected: clean(v) });
  }
  const sigInfer = (px, t) => rec.inferExit ? rec.inferExit(px, t) : null;
  const ie = [[84490, { sl: 83500, tp: [84500] }], [83510, { sl: 83500, tp: [84500] }], [NaN, { sl: 83500, tp: [84500] }], [84000, {}], [84250, { sl: 83500, tp: [84500] }]]
    .map(([px, t], i) => ({ id: 'infer_' + i, fn: 'infer_exit', input: { px: Number.isFinite(px) ? px : null, tracked: t }, expected: clean(sigInfer(px, t)) }));
  const dc = ['1', '2', '3', '4', '5', '9', undefined, ''].map((t) => ({ id: 'ct_' + t, fn: 'describe_close_type', input: { t: t === undefined ? null : t }, expected: clean(rec.describeCloseType ? rec.describeCloseType(t) : null) }));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'reconcile.json'), JSON.stringify(out.concat(mh, ie, dc), null, 1).replace(/\/tmp\/rc-[A-Za-z0-9]+/g, '<DATA_DIR>'));
  ol('reconcile vectors', out.length + mh.length + ie.length + dc.length);
  for (const o of out) ol(o.id, JSON.stringify(o.expected.result && { closed: o.expected.result.closed.length, still: o.expected.result.stillOpen, int: o.expected.result.resolvedIntents.map((x) => x.outcome), orph: o.expected.result.orphans.length, rel: o.expected.result.released.length, err: o.expected.result.errors.map((e) => e.slice(0, 30)) }), o.expected.threw || '', 'pnl', Object.values(o.expected.finalState.daily || {}).map((d) => d.realisedPnlUsdt).join(','), 'notif', o.expected.notifications.length);
})();
