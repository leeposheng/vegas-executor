'use strict';
// 模組 B 黃金向量：在假 GAS 環境執行「原版 Code.gs＋Executor.gs」。
// 用法：node gen_bot.js <Code.gs> <Executor.gs> <輸出資料夾>
const fs = require('fs'), path = require('path');
const { makeEnv, J, stateOf, rng, T0 } = require('./gas_env.js');
const SRC = fs.readFileSync(path.resolve(process.argv[2]), 'utf8') + '\n' + fs.readFileSync(path.resolve(process.argv[3]), 'utf8');
const OUT = path.resolve(process.argv[4]);
const mk = (seed) => makeEnv(SRC, seed);
const FULL_PROPS = { TG_TOKEN: '123:TESTTOKEN', ALLOWED_CHAT_ID: '111', TRADINGVIEW_WEBHOOK_SECRET: 'tv', TELEGRAM_WEBHOOK_SECRET: 'tg', WEBAPP_URL: 'https://x',
  EXECUTOR_URL: 'https://exec.example.com/health', EXECUTOR_WEBHOOK_SECRET: 'sec' };
const stub = (env) => env.run(`
  logEvent_ = function (level, event, details) { __rec.logs.push({ level: level, event: event, details: JSON.parse(JSON.stringify(details || {})) }); };
  console.error = function () {}; console.warn = function () {};
`);

// ---------- 1. 解析 ----------
function sig(o) {
  o = Object.assign({ sym: 'BTCUSDT.P', tf: '15分鐘', q: '標準', side: '做多', price: '85397.5 USDT', sl: '85011.8 USDT', tps: ['85783.2 USDT', '86169 USDT', '86554.7 USDT'], score: '72', tz: 'Asia/Taipei', time: '2026-09-21 20:13:00' }, o || {});
  const L = ['《維加斯訊號》交易訊號', '─────────────'];
  if (o.time !== null) L.push('[時間] ' + o.time);
  if (o.sym !== null) L.push('[幣種] ' + o.sym);
  if (o.tf !== null) L.push('[週期] ' + o.tf);
  if (o.tz !== null) L.push('[時區] ' + o.tz);
  if (o.q !== null) L.push('[品質] ' + o.q);
  if (o.score !== null) L.push('[分數] ' + o.score);
  if (o.side !== null) L.push('[方向] ' + o.side);
  if (o.price !== null) L.push('[價格] ' + o.price);
  if (o.sl !== null) L.push('[止損] ' + o.sl);
  o.tps.forEach((t, i) => L.push('[止盈' + (i + 1) + '] ' + t));
  return L.join('\n');
}
function parseCases() {
  const P = [];
  const base = [
    sig(), sig({ side: '做空', sl: '85800 USDT', tps: ['85000 USDT', '84600 USDT'] }), sig({ tps: ['85783.2 USDT'] }), sig({ tps: [] }),
    sig({ sym: null }), sig({ tf: null }), sig({ q: null }), sig({ side: null }), sig({ price: null }), sig({ sl: null }),
    sig({ tf: '4小時' }), sig({ tf: '1.5小時' }), sig({ tf: '1.5分鐘' }), sig({ tf: '2.5分鐘' }), sig({ tf: '日線' }), sig({ tf: '3日' }), sig({ tf: '週線' }), sig({ tf: '2週' }),
    sig({ tf: '15' }), sig({ tf: '60' }), sig({ tf: 'D' }), sig({ tf: '2D' }), sig({ tf: 'w' }), sig({ tf: '3W' }), sig({ tf: '30秒' }), sig({ tf: '1月' }), sig({ tf: '4H' }), sig({ tf: '0.1小時' }),
    sig({ q: '高品質' }), sig({ q: '弱訊' }), sig({ q: '普通' }), sig({ q: '高品質（85）' }),
    sig({ side: '觀望' }), sig({ side: '做多（試單）' }), sig({ side: '做空多' }),
    sig({ price: '85,397.5 USDT', sl: '85,011.8 USDT' }), sig({ price: '測試值' }), sig({ price: 'NaN' }), sig({ price: '0.00001234 USDT', sl: '0.00001 USDT', tps: ['0.00002 USDT'] }),
    sig({ price: '1e-7 USDT', sl: '5e-8 USDT', tps: ['2e-7 USDT'] }), sig({ price: '85397.5', sl: '85011.8' }), sig({ price: '85397.5 USDC' }), sig({ price: '85397.5USDT' }),
    sig({ sl: '85397.5 USDT' }), sig({ side: '做空', sl: '85397.5 USDT' }), sig({ sl: '90000 USDT' }), sig({ side: '做空', sl: '80000 USDT' }),
    sig({ score: null }), sig({ score: '82（降級：觸碰過多＋近期反向訊號）' }), sig({ score: '82(降級: 觸碰過多)' }), sig({ score: 'abc' }), sig({ score: '105' }), sig({ score: '-3' }), sig({ score: '0' }), sig({ score: '100' }), sig({ score: '72.5' }), sig({ score: '1,5' }), sig({ score: '（降級：x）' }),
    sig({ tz: null }), sig({ tz: 'UTC' }), sig({ time: null }), sig({ tps: ['85783.2 USDT', 'x', '86554.7 USDT'] }),
    '', null, 'hello', '[幣種] BTC\n[週期] 15分鐘', sig().replace(/\n/g, '\r\n'), sig({ sym: '' }), sig({ sym: '   ' }),
    '🧪 測試（非實盤訊號）\n' + sig(), sig({ sym: '長'.repeat(30) + 'USDT.P' }),
  ];
  const ids = ['tv:' + 'ab12'.repeat(16), 'tv:short', 'plain' + 'x'.repeat(60), '', null, 'tv:tv:double'];
  base.forEach((t, i) => P.push(['parseSignalToJson_', [t, ids[i % ids.length], i % 7 === 0 ? undefined : T0 + i * 1000]]));
  for (const t of ['', '  ', '15分鐘', '15 分鐘', '１５分鐘', '15分', '日', '1440', '0', '00', '7.5', '10.25小時', '999999日', '1週', '週', 'D ', ' w', 'DD', '1D1']) P.push(['tfTextToMinutes_', [t]]);
  for (const t of ['高品質', '標準', '弱訊', '', null, '高品質 ', ' 標準', '高']) P.push(['gradeTextToNumber_', [t]]);
  for (const t of [null, undefined, '', '85397.5 USDT', '1,234.5', '1,2,3', 'x1', '-5', '+5', '.5', '5.', '1e3', 'Infinity', '-Infinity', '0x10', '  7 ', '1e400']) P.push(['parsePrice_', [t]]);
  for (const t of [null, undefined, '', '791.3 USDT', '791.3USDT', '1,234 USDC', 'USDT', '5 x', '5 1x', '5   BTC2']) P.push(['parsePriceUnit_', [t]]);
  for (const t of ['a\n[x] y', '[x]\n  y', '[x]   \n', '[x]\n', '[x] y\n[x] z', '[x]\t y z \t', '[x][x] q', 'no']) P.push(['extractField_', [t, 'x']]);
  return P;
}
function runPure(fn, args) {
  const env = mk({}); stub(env); env.ctx.__a = args;
  return J(env.run(`${fn}.apply(null, __a)`));
}

// ---------- 2. 卡片 ----------
function cardPayload(r) {
  const long = r() < 0.5, entry = [85397.5, 0.5824, 3123.4, 0.00001234, 61.07, 1e-7][Math.floor(r() * 6)];
  const d = entry * (0.004 + r() * 0.03);
  const p = { v: '11.9', sig_id: 'a'.repeat(48), ts: T0, symbol: ['BTCUSDT.P', 'ETHUSDT.P', 'TIAUSDT.P'][Math.floor(r() * 3)], tf: ['5', '15', '60', '240'][Math.floor(r() * 4)],
    grade: 1 + Math.floor(r() * 3), tf_text: r() < 0.8 ? ['15分鐘', '1小時', '4小時'][Math.floor(r() * 3)] : null, grade_text: r() < 0.8 ? ['弱訊', '標準', '高品質'][Math.floor(r() * 3)] : null,
    quote: r() < 0.85 ? 'USDT' : '', tz: 'Asia/Taipei', score: r() < 0.8 ? Math.floor(r() * 101) : null, demote: r() < 0.3 ? '觸碰過多＋近期反向訊號' : null,
    side: long ? 'long' : 'short', entry, sl: long ? entry - d : entry + d, tp: [] };
  const n = 1 + Math.floor(r() * 3);
  for (let i = 1; i <= n; i++) p.tp.push(long ? entry + d * i : entry - d * i);
  p.sl = Number(p.sl.toPrecision(7)); p.tp = p.tp.map((x) => Number(x.toPrecision(7)));
  return p;
}
function cardResult(r) {
  const decisions = ['pending', 'pending', 'placed', 'rejected', 'rejected', 'error', 'skipped', 'weird'];
  const d = decisions[Math.floor(r() * decisions.length)];
  const res = { ok: true, decision: d, dryRun: r() < 0.3, reasons: [] };
  if (d === 'rejected' || d === 'error') {
    const pool = ['timeframe: 週期 5 不在白名單 [15, 30]', 'min_grade: 等級 1 低於下限 2', 'daily_loss_limit: 當日已實現虧損 62.12 USDT 達上限', 'max_concurrent: 目前持倉 2 筆，已達上限 2', '虧損 14.06 < 下限 20（止損 0.252%，手續費佔 28.4%）', '預估虧損 45.45 USDT 超過上限 45 USDT', '代碼 RUNEUSDT.P 不在白名單內，拒絕下單', '系統停止下單中', 'drift: 現價偏離'];
    const k = 1 + Math.floor(r() * 2);
    for (let i = 0; i < k; i++) res.reasons.push(pool[Math.floor(r() * pool.length)]);
  }
  if (r() < 0.2) res.reasons = [];
  if (d === 'rejected' && r() < 0.3) res.band = { min: 20, max: 45, loss: 14.06 };
  if (r() < 0.75 && d !== 'skipped') {
    const lev = [3, 5, 12, 20, 40][Math.floor(r() * 5)];
    res.sizing = { exchange: 'okx', unit: r() < 0.8 ? 'contracts' : 'coin', orderQty: [12.96, 1030, 709, 0.5, 16.02][Math.floor(r() * 5)], actualRiskUsdt: [16.67, 49.9867, 22, 0.005, 10][Math.floor(r() * 5)],
      riskAmountUsdt: [22, 50, 10.5][Math.floor(r() * 3)], riskBudgetIsCap: r() < 0.5, notionalUsdt: [599.87, 1049.595, 0.1 + 0.2][Math.floor(r() * 3)], leverage: r() < 0.9 ? lev : null };
    if (r() < 0.5) { res.sizing.baseLeverage = r() < 0.6 ? 40 : lev; if (r() < 0.6) res.sizing.leverageNote = '強平緩衝 3x 限制'; }
    if (r() < 0.4) { res.sizing.baseMarginUsdt = 50; res.sizing.targetMarginUsdt = [50, 50.4, 75, 100][Math.floor(r() * 4)]; }
  }
  if (r() < 0.3) res.equity = { note: r() < 0.7 ? '權益查詢失敗，改用設定值 1000 USDT' : '' };
  if (d === 'rejected' && r() < 0.5) res.preview = { rr: [1.23, 0.5, null, 2][Math.floor(r() * 4)], breakeven: r() < 0.5 ? 0.4567 : null, suggestLeverage: r() < 0.5 ? 12 : undefined };
  if (d === 'pending' && r() < 0.25) res.overLimit = { openCount: 2, maxNow: 2, hardCap: 5 };
  if (d === 'pending' && r() < 0.25) res.addOn = { baseSide: r() < 0.5 ? 'long' : 'short', baseEntry: r() < 0.7 ? 85000 : null, upl: [12.345, -3.2, 0, null, undefined][Math.floor(r() * 5)], layerNo: 1 + Math.floor(r() * 3), max: 3, lever: r() < 0.5 ? 20 : null };
  if (r() < 0.1) delete res.decision;
  return res;
}
function runCard(c) {
  const env = mk({}); stub(env); env.ctx.__c = c;
  return J(env.run('({ text: renderPendingCard_(__c.payload, __c.result, __c.original, __c.forBroadcast), head: cardHead_(__c.result), observable: isObservable_(__c.result) })'));
}
function cardVectors() {
  const V = []; const r = rng(7700);
  for (let i = 0; i < 400; i++) {
    const payload = cardPayload(r), result = cardResult(r);
    const original = r() < 0.7 ? sig({ time: '2026-09-21 20:13:00' }) : (r() < 0.5 ? null : '');
    V.push({ id: 'card_rand_' + i, payload, result, original, forBroadcast: r() < 0.3 });
  }
  return V;
}

// ---------- 3. 轉送與送卡 ----------
function flowRun(sc) {
  const env = mk({ props: Object.assign({}, FULL_PROPS, sc.props || {}) }); stub(env);
  const rec = env.ctx.__rec; env.ctx.__sc = sc;
  env.run(`
    postToExecutor_ = function (payload, cfg) { __rec.calls.push({ fn: 'post', payload: JSON.parse(JSON.stringify(payload)) }); return JSON.parse(JSON.stringify(__sc.post)); };
    fetchChartImage_ = function (payload) { __rec.calls.push({ fn: 'chart', symbol: payload.symbol }); return __sc.chart ? { blob: true } : null; };
    tgSendPhoto_ = function (chatId, blob, caption, markup) { __rec.calls.push({ fn: 'sendPhoto', chatId: String(chatId), caption: caption, markup: markup || null });
      return __sc.photo === undefined ? { photo: [{ file_id: 'small' }, { file_id: 'FILE1' }] } : __sc.photo; };
    var __seq = (__sc.tgSeq || []).slice();
    tgApi_ = function (method, body) { __rec.calls.push({ fn: 'tgApi', method: method, body: JSON.parse(JSON.stringify(body)) });
      return __seq.length ? __seq.shift() : { message_id: 1 }; };
  `);
  const out = [];
  for (const st of sc.steps) {
    rec.calls.length = 0; rec.logs.length = 0; env.ctx.__st = J(st);
    let result, error = null;
    try { result = J(env.run('forwardToExecutor_(__st.text, __st.key)')); } catch (e) { error = e.message; }
    out.push({ result, error, calls: J(rec.calls), logs: J(rec.logs) });
  }
  return { steps: out, final: stateOf(env) };
}
function flowScenarios() {
  const S = []; const r = rng(4242);
  const text = sig({ time: '2026-09-21 20:13:00' });
  const key = 'tv:' + 'cd34'.repeat(16);
  const sizing = { exchange: 'okx', unit: 'contracts', orderQty: 12.96, actualRiskUsdt: 16.67, riskAmountUsdt: 22, riskBudgetIsCap: true, notionalUsdt: 599.87, leverage: 12, baseLeverage: 40, leverageNote: '強平緩衝 3x 限制' };
  const R = (o) => Object.assign({ ok: true, elapsedMs: 123, decision: 'pending', reasons: [], sizing, band: null, preview: null, equity: null, overLimit: null, addOn: null, dryRun: false }, o || {});
  const step = (o) => Object.assign({ text, key }, o || {});
  const add = (id, sc) => S.push(Object.assign({ id, steps: [step()] }, sc));
  add('pending_chart_group', { props: { SIGNAL_CHAT_ID: '-100', SIGNAL_THREAD_ID: '9' }, post: R(), chart: true });
  add('pending_nochart_group', { props: { SIGNAL_CHAT_ID: '-100', SIGNAL_THREAD_ID: '9' }, post: R(), chart: false });
  add('pending_no_group', { post: R(), chart: false });
  add('group_same_as_private', { props: { SIGNAL_CHAT_ID: '111' }, post: R(), chart: false });
  add('group_bad_thread', { props: { SIGNAL_CHAT_ID: '-100', SIGNAL_THREAD_ID: 'abc' }, post: R(), chart: false });
  add('group_thread_spaces', { props: { SIGNAL_CHAT_ID: ' -100 ', SIGNAL_THREAD_ID: ' 12 ' }, post: R(), chart: true });
  add('placed', { post: R({ decision: 'placed' }), chart: false });
  add('placed_dry', { post: R({ decision: 'placed', dryRun: true }), chart: true, props: { SIGNAL_CHAT_ID: '-100' } });
  add('rejected_observable', { post: R({ decision: 'rejected', reasons: ['timeframe: 週期 5 不在白名單 [15, 30]'], sizing: null }), chart: false });
  add('rejected_daily_loss', { post: R({ decision: 'rejected', reasons: ['daily_loss_limit: 當日已實現虧損 62.12 USDT 達上限'], sizing: null }), chart: false });
  add('rejected_band', { post: R({ decision: 'rejected', reasons: ['虧損 14.06 < 下限 20（止損 0.252%，手續費佔 28.4%）'], band: { min: 20 }, preview: { rr: 1.2, breakeven: 0.45, suggestLeverage: 10 } }), chart: false });
  add('error_decision', { post: R({ decision: 'error', reasons: ['order failed'] }), chart: false });
  add('skipped_decision_no_card', { post: R({ decision: 'skipped' }), chart: false });
  add('unknown_decision_no_card', { post: R({ decision: 'unknown' }), chart: false });
  add('overlimit', { post: R({ overLimit: { openCount: 2, maxNow: 2, hardCap: 5 } }), chart: false });
  add('addon', { post: R({ addOn: { baseSide: 'long', baseEntry: 85000, upl: 12.345, layerNo: 2, max: 3, lever: 20 } }), chart: false });
  add('private_card_fails', { post: R(), chart: false, tgSeq: [null, { message_id: 2 }], props: { SIGNAL_CHAT_ID: '-100' } });
  add('photo_fails_no_fallback', { post: R(), chart: true, photo: null, props: { SIGNAL_CHAT_ID: '-100' } });
  add('broadcast_photo_fails_text_ok', { post: R(), chart: true, tgSeq: [null, { message_id: 3 }], props: { SIGNAL_CHAT_ID: '-100' } });
  add('broadcast_all_fail', { post: R(), chart: true, tgSeq: [null, null], props: { SIGNAL_CHAT_ID: '-100' } });
  add('photo_without_array', { post: R(), chart: true, photo: { message_id: 5 }, props: { SIGNAL_CHAT_ID: '-100' } });
  add('caption_too_long', { post: R({ decision: 'rejected', reasons: ['x'.repeat(1100)], sizing: null }), chart: true });
  for (const n of [827, 828, 829]) add('caption_edge_' + n, { post: R({ decision: 'rejected', reasons: ['x'.repeat(n)], sizing: null }), chart: true });
  add('executor_disabled', { props: { EXECUTOR_URL: '' }, post: R(), chart: false });
  add('executor_disabled_secret', { props: { EXECUTOR_WEBHOOK_SECRET: '' }, post: R(), chart: false });
  add('parse_fail', { post: R(), chart: false, steps: [step({ text: 'garbage' }), step({ text: sig({ sym: null, tf: null }) })] });
  add('post_failed_queued', { post: { ok: false, elapsedMs: 5, error: '執行層回應 HTTP 502：bad gateway' }, chart: false });
  add('post_failed_queue_full', { props: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['EXECRETRY_' + i + '_x', '{}'])), post: { ok: false, elapsedMs: 5, error: 'down' }, chart: false });
  add('no_config_props', { props: { TG_TOKEN: '' }, post: R(), chart: false });
  for (let i = 0; i < 80; i++) {
    const res = cardResult(r); const d = res.decision || 'unknown';
    S.push({ id: 'flow_rand_' + i, props: r() < 0.5 ? { SIGNAL_CHAT_ID: '-100', SIGNAL_THREAD_ID: r() < 0.5 ? '9' : '' } : {},
      post: Object.assign({ ok: r() < 0.9, elapsedMs: Math.floor(r() * 900), decision: d, reasons: res.reasons, sizing: res.sizing || null, band: res.band || null, preview: res.preview || null, equity: res.equity || null, overLimit: res.overLimit || null, addOn: res.addOn || null, dryRun: !!res.dryRun }, r() < 0.1 ? { ok: false, error: 'boom' } : {}),
      chart: r() < 0.5, photo: r() < 0.2 ? null : undefined, tgSeq: r() < 0.3 ? [r() < 0.5 ? null : { message_id: 9 }, r() < 0.5 ? null : { message_id: 10 }] : [],
      steps: [step({ text: sig({ side: r() < 0.5 ? '做多' : '做空', sl: null, tps: [] }) === '' ? text : text })] });
  }
  return S;
}

// ---------- 4. 補送佇列（執行層）----------
function retryRun(sc) {
  const env = mk({ props: Object.assign({}, FULL_PROPS, sc.props || {}), }); stub(env);
  Object.entries(sc.seedProps || {}).forEach(([k, v]) => { env.props[k] = typeof v === 'string' ? v : JSON.stringify(v); });
  const rec = env.ctx.__rec; env.ctx.__sc = sc; env.ctx.__seq = (sc.postSeq || []).slice();
  env.run(`postToExecutor_ = function (payload, cfg) { __rec.calls.push({ fn: 'post', sigId: payload.sig_id }); return JSON.parse(JSON.stringify(__seq.length ? __seq.shift() : { ok: true, decision: 'placed', reasons: [] })); };`);
  const out = [];
  for (const st of sc.steps) {
    env.t += st.dt || 0; rec.calls.length = 0; rec.logs.length = 0; env.ctx.__st = J(st);
    if (st.lockOk !== undefined) env.lockOk = st.lockOk;
    let result = null, error = null;
    try {
      if (st.op === 'enqueue') result = J(env.run('enqueueExecutorRetry_(__st.payload, __st.reason)'));
      else env.run('flushExecutorQueue()');
    } catch (e) { error = e.message; }
    out.push({ result, error, calls: J(rec.calls), logs: J(rec.logs), t: env.t });
  }
  return { steps: out, final: stateOf(env) };
}
function retryScenarios() {
  const S = []; const payload = (n) => ({ v: '11.9', sig_id: String(n).padStart(48, 'a'), ts: T0, symbol: 'BTCUSDT.P', tf: '15', grade: 2, side: 'long', entry: 100, sl: 99, tp: [101] });
  const item = (n, over) => Object.assign({ payload: payload(n), firstFailedAt: T0, nextAttemptAt: T0, attempts: 1, lastError: 'x' }, over || {});
  S.push({ id: 'enqueue_basic', steps: [{ op: 'enqueue', payload: payload(1), reason: 'HTTP 502 for https://a/b?key=SECRET&x=1' }, { op: 'enqueue', dt: 5, payload: payload(2), reason: '' }] });
  S.push({ id: 'enqueue_full', seedProps: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['EXECRETRY_' + i + '_x', '{}'])), steps: [{ op: 'enqueue', payload: payload(1), reason: 'r' }] });
  S.push({ id: 'flush_empty', steps: [{ op: 'flush' }] });
  S.push({ id: 'flush_disabled', props: { EXECUTOR_URL: '' }, seedProps: { EXECRETRY_1_a: item(1) }, steps: [{ op: 'flush' }] });
  S.push({ id: 'flush_ok_placed_and_rejected', seedProps: { EXECRETRY_1_a: item(1, { firstFailedAt: T0 - 150000 }), EXECRETRY_2_b: item(2, { firstFailedAt: T0 - 90000 }) },
    postSeq: [{ ok: true, decision: 'placed', reasons: [] }, { ok: true, decision: 'rejected', reasons: ['signal_expired: 訊號已過期', 'x'.repeat(300)] }], steps: [{ op: 'flush' }] });
  S.push({ id: 'flush_fail_backoff', seedProps: { EXECRETRY_1_a: item(1) }, postSeq: Array.from({ length: 8 }, () => ({ ok: false, error: 'down https://x?token=ZZZ' })),
    steps: [{ op: 'flush' }, { op: 'flush', dt: 30000 }, { op: 'flush', dt: 90000 }, { op: 'flush', dt: 200000 }, { op: 'flush', dt: 500000 }, { op: 'flush', dt: 1000000 }] });
  S.push({ id: 'flush_dropped', seedProps: { EXECRETRY_1_a: item(1, { attempts: 8 }), EXECRETRY_2_b: item(2, { firstFailedAt: T0 - 3 * 3600e3 }), EXECRETRY_3_c: '{bad' }, steps: [{ op: 'flush' }] });
  S.push({ id: 'flush_not_due', seedProps: { EXECRETRY_1_a: item(1, { nextAttemptAt: T0 + 60000 }) }, steps: [{ op: 'flush' }, { op: 'flush', dt: 61000 }] });
  S.push({ id: 'flush_age_edge', seedProps: { EXECRETRY_1_a: item(1, { firstFailedAt: T0 - 7200000 }), EXECRETRY_2_b: item(2, { firstFailedAt: T0 - 7200001 }) }, postSeq: [{ ok: true, decision: 'placed', reasons: [] }], steps: [{ op: 'flush' }] });
  S.push({ id: 'flush_lock_busy', seedProps: { EXECRETRY_1_a: item(1) }, steps: [{ op: 'flush', lockOk: false }] });
  S.push({ id: 'flush_round_age', seedProps: { EXECRETRY_1_a: item(1, { firstFailedAt: T0 - 150000 }) }, postSeq: [{ ok: true, decision: 'placed', reasons: [] }], steps: [{ op: 'flush' }] });
  return S;
}

// ---------- 5. 廣播對象與操作者 ----------
function opCases() {
  const C = [];
  const P = (o) => Object.assign({ ALLOWED_CHAT_ID: '111' }, o);
  for (const props of [P({ SIGNAL_CHAT_ID: '-100' }), P({ SIGNAL_CHAT_ID: '111' }), P({}), P({ SIGNAL_CHAT_ID: ' -100 ', SIGNAL_THREAD_ID: ' 7 ' }), P({ SIGNAL_CHAT_ID: '-100', SIGNAL_THREAD_ID: '7a' }), P({ SIGNAL_THREAD_ID: '0' }),
    P({ OPERATOR_USER_IDS: '1, 2 ,,3' }), P({ OPERATOR_USER_IDS: '' }), { OPERATOR_USER_IDS: '5' }, {}]) {
    C.push({ props, users: [1, '1', 2, 3, 111, 5, '', null, undefined, 'abc'] });
  }
  return C;
}
function opRun(c) {
  const env = mk({ props: c.props }); stub(env); env.ctx.__u = c.users;
  return J(env.run(`({ chat: getBroadcastChatId_(), thread: getBroadcastThreadId_(), ids: getOperatorIds_(), ops: __u.map(function (u) { return isOperator_(u); }) })`));
}

const vectors = [];
for (const [fn, args] of parseCases()) vectors.push({ id: `bparse_${fn}_${vectors.length}`, fn: 'bparse', input: { fn, args }, expected: runPure(fn, args) });
for (const c of cardVectors()) vectors.push({ id: c.id, fn: 'bcard', input: c, expected: runCard(c) });
for (const sc of flowScenarios()) vectors.push({ id: 'bflow_' + sc.id, fn: 'bflow', input: sc, expected: flowRun(sc) });
for (const sc of retryScenarios()) vectors.push({ id: 'bretry_' + sc.id, fn: 'bretry', input: sc, expected: retryRun(sc) });
opCases().forEach((c, i) => vectors.push({ id: 'bops_' + i, fn: 'bops', input: c, expected: opRun(c) }));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bot_b.json'), JSON.stringify(vectors));
console.log('bot_b.json', vectors.length, 'vectors');
