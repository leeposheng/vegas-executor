'use strict';
// 模組 C 黃金向量：按鈕回呼（進場／略過、持倉上限、日損面板、sig_id 鎖、update_id 去重）。
// 用法：node gen_cb.js <Code.gs> <Executor.gs> <輸出資料夾>
const fs = require('fs'), path = require('path');
const { makeEnv, J, stateOf, rng, T0 } = require('./gas_env.js');
const SRC = fs.readFileSync(path.resolve(process.argv[2]), 'utf8') + '\n' + fs.readFileSync(path.resolve(process.argv[3]), 'utf8');
const OUT = path.resolve(process.argv[4]);
const FULL_PROPS = { TG_TOKEN: '123:TESTTOKEN', ALLOWED_CHAT_ID: '111', TRADINGVIEW_WEBHOOK_SECRET: 'tv', TELEGRAM_WEBHOOK_SECRET: 'tg', WEBAPP_URL: 'https://x',
  EXECUTOR_URL: 'https://exec.example.com/health', EXECUTOR_WEBHOOK_SECRET: 'sec' };
const SIG = 'ab12'.repeat(12);

function stub(env) {
  env.run(`
    logEvent_ = function (level, event, details) { __rec.logs.push({ level: level, event: event, details: JSON.parse(JSON.stringify(details || {})) }); };
    console.error = function () {}; console.warn = function () {};
    tgApi_ = function (method, body) {
      __rec.calls.push({ fn: 'tgApi', method: method, body: JSON.parse(JSON.stringify(body)) });
      var q = (__sc.tgSeq || {})[method];
      if (q && q.length) return q.shift();
      if ((__sc.tgNull || []).indexOf(method) !== -1) return null;
      return { message_id: 1 };
    };
    callExecutorApi_ = function (p, method, body) {
      __rec.calls.push({ fn: 'api', method: method, path: p, body: body ? JSON.parse(JSON.stringify(body)) : null });
      var q = (__sc.api || {})[method.toUpperCase() + ' ' + p];
      if (!q) return { ok: false, error: 'no_plan' };
      return JSON.parse(JSON.stringify(q.length > 1 ? q.shift() : q[0]));
    };
    callExecutorAction_ = function (action, sigId, cfg) {
      __rec.calls.push({ fn: 'action', action: action, sigId: sigId });
      var q = __sc.action || [{ ok: true, decision: 'placed', reasons: [], drift: null, dryRun: false }];
      return JSON.parse(JSON.stringify(q.length > 1 ? q.shift() : q[0]));
    };
  `);
}
function mkEnv(sc) {
  const env = makeEnv(SRC, { props: Object.assign({}, FULL_PROPS, sc.props || {}) });
  env.ctx.__sc = J(sc); stub(env); return env;
}

// ---------- 流程：整條 handleTelegramMessage_ ----------
let uid = 1000;
function cbUpdate(data, o) {
  o = o || {};
  const message = { message_id: o.messageId || 77, chat: { id: o.chat === undefined ? 111 : o.chat } };
  if (o.caption) message.caption = o.caption; else message.text = o.text === undefined ? '⏳ 待確認｜做多⬆\n─────────────\n[幣種] BTCUSDT.P\n[數量] 12.96 張' : o.text;
  const cb = { id: o.qid === undefined ? 'q' + (++uid) : o.qid, data, message };
  if (o.from !== null) cb.from = { id: o.from === undefined ? 111 : o.from };
  const u = { callback_query: cb };
  if (o.updateId !== null) u.update_id = o.updateId === undefined ? ++uid : o.updateId;
  return u;
}
function flowRun(sc) {
  const env = mkEnv(sc), rec = env.ctx.__rec; const out = [];
  for (const st of sc.steps) {
    rec.calls.length = 0; rec.logs.length = 0; env.t += st.dt || 0;
    if (st.lockOk !== undefined) env.lockOk = st.lockOk;
    env.lockSeq = st.lockSeq ? st.lockSeq.slice() : null;
    env.ctx.__e = { postData: { contents: JSON.stringify(st.update) } };
    let result = null, error = null;
    try { result = J(env.run('handleTelegramMessage_(__e, getConfig_())')).text; } catch (e) { error = e.message; }
    out.push({ result, error, calls: J(rec.calls), logs: J(rec.logs), t: env.t });
  }
  return { steps: out, final: stateOf(env) };
}
const DAILY = (o) => Object.assign({ ok: true, blocked: false, realisedPnlUsdt: -35.5, effectivePnlUsdt: -35.5, dailyLossLimitUsdt: 50, dailyLossCeiling: 100, orders: 4,
  resetCount: 0, resetLimit: 2, resetsLeft: 2, cooldownMin: 30, cooldownFloor: 15, cooldownActive: false, cooldownRemainMin: 0 }, o || {});
const LIM = (o) => Object.assign({ ok: true, maxConcurrent: 2, ceiling: 5, overridden: true, openPositions: 1 }, o || {});

function flowScenarios() {
  const S = []; const r = rng(991);
  const add = (id, steps, o) => S.push(Object.assign({ id, steps }, o || {}));
  const U = (data, o, st) => Object.assign({ update: cbUpdate(data, o) }, st || {});
  const C = 'vg.c.' + SIG, K = 'vg.s.' + SIG;
  const act = (o) => Object.assign({ ok: true, decision: 'placed', reasons: [], drift: null, dryRun: false }, o);
  add('confirm_placed', [U(C)], {});
  add('confirm_placed_caption', [U(C, { caption: '⏳ 待確認｜做空⬇\n[幣種] ETHUSDT.P' })], {});
  add('confirm_edit_caption_fails', [U(C)], { tgNull: ['editMessageCaption'] });
  add('confirm_both_edits_fail', [U(C)], { tgNull: ['editMessageCaption', 'editMessageText'] });
  add('confirm_dry', [U(C)], { action: [act({ dryRun: true })] });
  add('skip', [U(K)], { action: [act({ decision: 'skipped' })] });
  add('not_found', [U(C)], { action: [act({ decision: 'not_found' })] });
  add('already_handling', [U(C)], { action: [act({ decision: 'already_handling' })] });
  add('rejected_reasons', [U(C)], { action: [act({ decision: 'rejected', reasons: ['a'.repeat(100), 'b'.repeat(100)] })] });
  add('rejected_no_reasons', [U(C)], { action: [act({ decision: 'rejected', reasons: [] })] });
  add('unknown_decision', [U(C)], { action: [act({ decision: 'weird' })] });
  add('drift_resize', [U(C)], { action: [act({ drift: { verdict: 'resize', livePrice: 85400.5, fromQty: 12.96, toQty: 12.5, driftR: 0.31 } })] });
  add('drift_resize_missing_qty', [U(C)], { action: [act({ drift: { verdict: 'resize', livePrice: 1 } })] });
  add('drift_other', [U(C)], { action: [act({ drift: { verdict: 'ok' } })] });
  add('action_fail_then_retry', [U(C), U(C)], { action: [{ ok: false, error: 'HTTP 502' }, act({})] });
  add('action_fail_twice', [U(C), U(C)], { action: [{ ok: false, error: 'HTTP 502' }] });
  add('double_click_other_update', [U(C), U(C)], {});
  add('confirm_then_skip_same_sig', [U(C), U(K)], {});
  add('same_update_id_twice', [{ update: cbUpdate(C, { updateId: 5, qid: 'qa' }) }, { update: cbUpdate(C, { updateId: 5, qid: 'qb' }) }], {});
  add('same_update_id_no_qid', [{ update: cbUpdate(C, { updateId: 6 }) }, { update: cbUpdate(C, { updateId: 6, qid: null }) }], {});
  add('update_without_id', [{ update: cbUpdate(C, { updateId: null }) }], {});
  add('update_bad_id', [{ update: Object.assign(cbUpdate(C), { update_id: 'abc' }) }], {});
  add('update_id_float', [{ update: Object.assign(cbUpdate(C), { update_id: 12.5 }) }], {});
  add('update_id_lock_busy', [U(C, {}, { lockOk: false })], {});
  add('claim_lock_busy_only', [U(C, {}, { lockSeq: [true, false] }), U(C)], {});
  const ids = Array.from({ length: 100 }, (_, i) => String(i + 1));
  add('update_window_full', [{ update: cbUpdate(C, { updateId: 1 }) }, { update: cbUpdate(C, { updateId: 100, qid: 'qz' }) }, { update: cbUpdate(C, { updateId: 101 }) }, { update: cbUpdate(C, { updateId: 1 }) }, { update: cbUpdate(C, { updateId: 2 }) }], { props: { TELEGRAM_RECENT_UPDATE_IDS: JSON.stringify(ids) } });
  add('update_state_corrupted', [U(C)], { props: { TELEGRAM_RECENT_UPDATE_IDS: '{bad' } });
  add('update_state_not_array', [U(C)], { props: { TELEGRAM_RECENT_UPDATE_IDS: '{"a":1}' } });
  add('update_state_numbers', [{ update: cbUpdate(C, { updateId: 7 }) }], { props: { TELEGRAM_RECENT_UPDATE_IDS: '[7,8]' } });
  add('drift_other_verdict_with_qty', [U(C)], { action: [act({ drift: { verdict: 'ok', livePrice: 1, fromQty: 1, toQty: 2, driftR: 0.1 } })] });
  add('drift_resize_zero_qty', [U(C)], { action: [act({ drift: { verdict: 'resize', livePrice: 1, fromQty: 0, toQty: 0, driftR: 0 } })] });
  add('stranger_chat', [U(C, { chat: 999 })], {});
  add('no_chat', [U(C, { chat: null })], {});
  add('non_operator', [U(C, { from: 222 })], {});
  add('no_from', [U(C, { from: null })], {});
  add('operator_list', [U(C, { from: 222 }), U(K, { from: 333 })], { props: { OPERATOR_USER_IDS: '222, 333' } });
  add('operator_list_excludes_owner', [U(C, { from: 111 })], { props: { OPERATOR_USER_IDS: '222' } });
  add('executor_disabled', [U(C)], { props: { EXECUTOR_URL: '' } });
  add('foreign_prefix', [U('zz.c.' + SIG)], {});
  add('empty_data', [U('')], {});
  add('vg_unknown_acts_as_skip', [U('vg.zzz.' + SIG)], { action: [act({ decision: 'skipped' })] });
  add('no_qid', [U(C, { qid: null })], {});
  // 持倉上限
  add('limit_ok', [U('vg.L.3')], { api: { 'POST /limits': [LIM({ maxConcurrent: 3 })] } });
  add('limit_ok_big_ceiling', [U('vg.L.2')], { api: { 'POST /limits': [LIM({ maxConcurrent: 2, ceiling: 8 })] } });
  add('limit_ok_no_ceiling', [U('vg.L.2')], { api: { 'POST /limits': [LIM({ ceiling: undefined })] } });
  add('limit_fail', [U('vg.L.9')], { api: { 'POST /limits': [{ ok: false, error: 'out of range' }] } });
  add('limit_no_response', [U('vg.L.1')], {});
  add('limit_nan', [U('vg.L.x')], { api: { 'POST /limits': [{ ok: false, error: 'bad' }] } });
  add('limit_no_qid', [U('vg.L.3', { qid: null })], { api: { 'POST /limits': [LIM({ maxConcurrent: 3 })] } });
  // 日損
  add('daily_ask', [U('vg.D.ask')], { api: { 'GET /daily': [DAILY({ blocked: true, effectivePnlUsdt: -60.456, realisedPnlUsdt: -112.2, resetCount: 1 })] } });
  add('daily_ask_unavailable', [U('vg.D.ask')], { api: { 'GET /daily': [{ ok: false, error: 'x' }] } });
  add('daily_panel_ok', [U('vg.D.panel')], { api: { 'GET /daily': [DAILY({ blocked: true })] } });
  add('daily_panel_unavailable', [U('vg.D.panel')], { api: { 'GET /daily': [{ ok: false, error: '回應非 JSON' }] } });
  add('daily_panel_no_response', [U('vg.D.panel')], {});
  add('daily_panel_markup_fails', [U('vg.D.panel')], { api: { 'GET /daily': [DAILY({ blocked: true })] }, tgSeq: { sendMessage: [null, { message_id: 4 }] } });
  add('daily_panel_all_fail', [U('vg.D.panel')], { api: { 'GET /daily': [DAILY()] }, tgSeq: { sendMessage: [null, null] } });
  add('daily_limit_ok', [U('vg.D.lim.75')], { api: { 'POST /limits': [{ ok: true }], 'GET /daily': [DAILY({ dailyLossLimitUsdt: 75 })] } });
  add('daily_limit_fail', [U('vg.D.lim.5')], { api: { 'POST /limits': [{ ok: false, error: '低於下限' }] } });
  add('daily_cool_ok', [U('vg.D.cd.60')], { api: { 'POST /limits': [{ ok: true }], 'GET /daily': [DAILY({ cooldownMin: 60 })] } });
  add('daily_cool_ok_fresh_fails', [U('vg.D.cd.60')], { api: { 'POST /limits': [{ ok: true }], 'GET /daily': [{ ok: false, error: 'x' }] } });
  add('daily_cancel', [U('vg.D.no')], { api: { 'GET /daily': [DAILY({ blocked: true })] } });
  add('daily_cancel_unavailable', [U('vg.D.no')], { api: { 'GET /daily': [{ ok: false }] } });
  add('daily_go_ok', [U('vg.D.go')], { api: { 'POST /daily/reset': [{ ok: true, clearedUsdt: -60.456, realisedPnlUsdt: -112.2, resetCount: 1, resetLimit: 2, cooldownMin: 30 }] } });
  add('daily_go_fail', [U('vg.D.go')], { api: { 'POST /daily/reset': [{ ok: false, error: '冷卻中' }] } });
  add('daily_go_no_response', [U('vg.D.go')], {});
  add('daily_unknown', [U('vg.D.zzz')], {});
  add('daily_unknown_no_qid', [U('vg.D.zzz', { qid: null })], {});
  // 隨機日損狀態經面板
  for (let i = 0; i < 40; i++) {
    const d = randDaily(r);
    add('daily_rand_' + i, [U(r() < 0.5 ? 'vg.D.panel' : r() < 0.5 ? 'vg.D.no' : 'vg.D.ask')], { api: { 'GET /daily': [d] } });
  }
  return S;
}
function randDaily(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const d = DAILY({ blocked: r() < 0.5, realisedPnlUsdt: pick([-35.5, 0, -112.234, 12.5, -0.005, '-7.1', null]), effectivePnlUsdt: pick([-35.5, 0, -60.456, 5, undefined]),
    dailyLossLimitUsdt: pick([10, 20, 50, 75, 300, '50', 7]), dailyLossCeiling: pick([100, 300, 10, undefined, 0, 47]), orders: pick([0, 4, undefined]),
    resetCount: pick([0, 1, 2]), resetLimit: pick([0, 1, 2, 3]), resetsLeft: pick([0, 1, 2]), cooldownMin: pick([0, 15, 30, 60, 240, 100]), cooldownFloor: pick([0, 15, 30, 300, undefined]),
    cooldownActive: r() < 0.3, cooldownRemainMin: pick([0, 12, 29]) });
  return d;
}

// ---------- 直接呼叫：面板產生函式與純函式 ----------
function directRun(c) {
  const env = mkEnv(c), rec = env.ctx.__rec;
  let error = null, result = null;
  try { result = J(env.run(c.expr)); } catch (e) { error = e.message; }
  return { result, error, calls: J(rec.calls), logs: J(rec.logs), final: stateOf(env) };
}
function directCases() {
  const C = []; const r = rng(31337);
  const add = (id, expr, o) => C.push(Object.assign({ id, expr, props: {} }, o || {}));
  add('limit_panel_ok', 'sendLimitPanel_(getConfig_())', { api: { 'GET /limits': [LIM()] } });
  add('limit_panel_default', 'sendLimitPanel_(getConfig_())', { api: { 'GET /limits': [LIM({ overridden: false, maxConcurrent: 5, ceiling: 5 })] } });
  add('limit_panel_ceiling3', 'sendLimitPanel_(getConfig_())', { api: { 'GET /limits': [LIM({ ceiling: 3 })] } });
  add('limit_panel_no_ceiling', 'sendLimitPanel_(getConfig_())', { api: { 'GET /limits': [LIM({ ceiling: 0 })] } });
  add('limit_panel_fail', 'sendLimitPanel_(getConfig_())', { api: { 'GET /limits': [{ ok: false, error: '執行層未設定' }] } });
  add('limit_panel_none', 'sendLimitPanel_(getConfig_())', {});
  add('daily_panel_ok', 'sendDailyPanel_(getConfig_())', { api: { 'GET /daily': [DAILY({ blocked: true })] } });
  add('daily_panel_fail', 'sendDailyPanel_(getConfig_())', { api: { 'GET /daily': [{ ok: false, error: 'HTTP 404' }] } });
  add('daily_panel_none', 'sendDailyPanel_(getConfig_())', {});
  add('daily_panel_fallback', 'sendDailyPanel_(getConfig_())', { api: { 'GET /daily': [DAILY()] }, tgSeq: { sendMessage: [null, { message_id: 3 }] } });
  add('daily_panel_all_fail', 'sendDailyPanel_(getConfig_())', { api: { 'GET /daily': [DAILY()] }, tgNull: ['sendMessage'] });
  for (let i = 0; i < 80; i++) {
    const d = randDaily(r);
    C.push({ id: 'render_' + i, props: {}, expr: 'JSON.stringify([renderDailyPanel_(__sc.d), dailyMarkup_(__sc.d) || null])', d });
  }
  for (let i = 0; i < 60; i++) {
    const n = 1 + Math.floor(r() * 12), cand = Array.from({ length: n }, () => Math.floor(r() * 400)), lo = Math.floor(r() * 50), hi = lo + Math.floor(r() * 300 - 10), cap = r() < 0.3 ? undefined : 1 + Math.floor(r() * 6);
    C.push({ id: 'steps_' + i, props: {}, expr: 'pickSteps_(__sc.cand, __sc.lo, __sc.hi, __sc.cap)', cand, lo, hi, cap: cap === undefined ? null : cap });
  }
  for (const [h, t] of [['✅ 已進場', '⏳ 待確認｜做多⬆\n[a] b\n[c] d'], ['✅ 已進場', '⏳ 待確認\n[a] b'], ['⏭ 已略過', ''], ['⏭ 已略過', null], ['x', '一行｜'], ['x', 'a｜b｜c\nrest'], ['x', '\n\nz']])
    C.push({ id: 'edit_' + C.length, props: {}, expr: 'editCardResult_(5, 9, __sc.h, __sc.t)', h, t });
  for (const t of [{ editMessageCaption: [null] }, {}]) C.push({ id: 'edit_fallback_' + C.length, props: {}, expr: 'editCardResult_("111", 9, "H", "X｜Y\\nZ")', tgSeq: t });
  return C;
}

const vectors = [];
for (const sc of flowScenarios()) vectors.push({ id: 'cflow_' + sc.id, fn: 'cflow', input: sc, expected: flowRun(sc) });
for (const c of directCases()) vectors.push({ id: 'cdirect_' + c.id, fn: 'cdirect', input: c, expected: directRun(c) });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bot_c.json'), JSON.stringify(vectors, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? { __num: String(v) } : v)));
console.log('bot_c.json', vectors.length, 'vectors');
