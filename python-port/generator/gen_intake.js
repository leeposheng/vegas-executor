'use strict';
// 模組 A 黃金向量：在假 GAS 環境（Cache／Properties／Lock／UrlFetch／時鐘）裡執行「原版 Code.gs」，記錄答案。
// 用法：node gen_intake.js <Code.gs 路徑> <輸出資料夾>
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const CODE = path.resolve(process.argv[2]), OUT = path.resolve(process.argv[3]);
const SRC = fs.readFileSync(CODE, 'utf8');
const T0 = 1758470000000;

function makeEnv(seed) {
  const env = { t: T0, props: Object.assign({}, seed.props || {}), cache: new Map(), lockOk: true, sleeps: [], uuid: 0,
    fetchPlan: [], fetchCalls: [] };
  for (const [k, v] of Object.entries(seed.cache || {})) env.cache.set(k, { v: v[0], exp: v[1] });
  class FD extends Date { constructor(...a) { if (a.length) super(...a); else super(env.t); } static now() { return env.t; } }
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date: FD,
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    PropertiesService: { getScriptProperties: () => ({
      getProperties: () => Object.assign({}, env.props), getKeys: () => Object.keys(env.props),
      getProperty: (k) => (k in env.props ? env.props[k] : null),
      setProperty: (k, v) => { env.props[k] = String(v); }, deleteProperty: (k) => { delete env.props[k]; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => { const e = env.cache.get(k); if (!e) return null; if (e.exp <= env.t) { env.cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl) => { env.cache.set(k, { v: String(v), exp: env.t + ttl * 1000 }); },
      remove: (k) => { env.cache.delete(k); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => env.lockOk, releaseLock() {} }) },
    ContentService: { MimeType: { TEXT: 'TEXT' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (a, s) => Array.from(crypto.createHash('sha256').update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => 'u' + (++env.uuid), sleep: (ms) => { env.sleeps.push(ms); },
      formatDate: (d, tz, fmt) => { const x = new Date(d.getTime() + 8 * 3600e3).toISOString();
        const p = x.slice(0, 10) + ' ' + x.slice(11, 16); return fmt.endsWith('ss') ? p + ':' + x.slice(17, 19) : p; } },
    UrlFetchApp: { fetch: (url, opts) => {
      env.fetchCalls.push({ url, opts: JSON.parse(JSON.stringify(opts)) });
      const plan = env.fetchPlan.length ? env.fetchPlan.shift() : { status: 200, body: '{"ok":true}' };
      if (plan.throw) throw new Error(plan.throw);
      return { getResponseCode: () => plan.status, getContentText: () => plan.body, getAllHeaders: () => plan.headers || {} }; } },
    __rec: { calls: [], logs: [] }, __plan: {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx);
  env.ctx = ctx; env.run = (code) => vm.runInContext(code, ctx);
  return env;
}

const J = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));
function stateOf(env) {
  const props = {};
  for (const [k, v] of Object.entries(env.props)) { try { props[k] = JSON.parse(v); } catch (e) { props[k] = v; } }
  const cache = {};
  for (const [k, e] of env.cache) if (e.exp > env.t) cache[k] = [e.v, e.exp];
  return { props, cache };
}

// ---------- 1. 純函式 ----------
function pureCases() {
  const long = '長'.repeat(900) + '\n' + '字'.repeat(2900) + '\n' + 'x'.repeat(700);
  const emo = '🧪'.repeat(40) + 'a';
  return [
    ['truncate', ['abc', 5]], ['truncate', ['abcdef', 5]], ['truncate', [null, 5]], ['truncate', [0, 5]], ['truncate', [12345678, 4]],
    ['truncate', ['🧪🧪🧪', 3]], ['truncate', ['🧪🧪🧪', 4]], ['truncate', ['a🧪b', 2]], ['truncate', ['長'.repeat(1600), 1500]],
    ['redact', ['url https://api.telegram.org/bot123456:ABC-def_GH/sendMessage failed']],
    ['redact', ['sk-ant-api03-AbC_dEf-12 and ?key=secret123&x=1 &token=abc']],
    ['redact', ['?Secret=zzz ?KEY=k2']], ['redact', [null]], ['redact', ['a'.repeat(800)]], ['redact', ['🧪'.repeat(400)]],
    ['safeEquals', ['abc', 'abc']], ['safeEquals', ['abc', 'abd']], ['safeEquals', ['abc', 'abcd']], ['safeEquals', ['', '']],
    ['safeEquals', [null, '']], ['safeEquals', [undefined, 'x']], ['safeEquals', ['密鑰', '密鑰']], ['safeEquals', ['密鑰', '密鈅']],
    ['sha256Hex', ['']], ['sha256Hex', ['abc']], ['sha256Hex', ['《維加斯訊號》交易訊號\n[幣種] BTCUSDT.P']], ['sha256Hex', ['🧪']],
    ['splitTelegramText', ['hello', 3800]], ['splitTelegramText', ['', 3800]], ['splitTelegramText', [long, 3800]],
    ['splitTelegramText', [long, 1000]], ['splitTelegramText', ['a'.repeat(25), 10]], ['splitTelegramText', [emo, 7]],
    ['splitTelegramText', ['ab\ncd\nef\ngh\nij', 6]], ['splitTelegramText', [null, 10]],
  ].concat([
    '《維加斯訊號》交易訊號\n[幣種] BTCUSDT.P\n[週期] 15分鐘\n[方向] 做多',
    '🧪 測試（非實盤訊號）\n《維加斯訊號》交易訊號\n[幣種] BTCUSDT.P\n[週期] 15分鐘\n[方向] 做空',
    '《維加斯訊號》交易訊號\n[幣種] \n[週期] 15分鐘\n[方向] 做多', '《維加斯訊號》交易訊號\n[幣種] BTC\n[週期] 15\n[方向] 觀望',
    '[幣種] BTC\n[週期] 15\n[方向] 做多', '', null, 'x'.repeat(100) + '《維加斯訊號》交易訊號\n[幣種] A\n[週期] 1\n[方向] 做多',
    '🧪'.repeat(30) + '《維加斯訊號》交易訊號\n[幣種] A\n[週期] 1\n[方向] 做多',
    '《維加斯訊號》交易訊號\n[幣種]　 BTC\n[週期]﻿15\n[方向] 做多',
    '《維加斯訊號》交易訊號\r\n[幣種] BTC\r\n[週期] 15\r\n[方向] 做多\r\n', '《維加斯訊號》交易訊號[幣種]x\n[週期]y\n[方向]做多',
    '《維加斯訊號》交易訊號\n[幣種]\n BTC\n[週期]\n 15\n[方向] 做多',
  ].map((t) => ['isExpected', [t]]));
}
function runPure(env, f, args) {
  env.ctx.__a = args;
  const fn = { truncate: 'truncate_', redact: 'redactLogText_', safeEquals: 'safeEquals_', sha256Hex: 'sha256Hex_',
    splitTelegramText: 'splitTelegramText_', isExpected: 'isExpectedTradingViewSignal_' }[f];
  return J(env.run(`${fn}.apply(null, __a)`));
}

// ---------- 2. sendTelegramMessage_ ----------
function sendCases() {
  const ok = { status: 200, body: '{"ok":true}' };
  const long = '長'.repeat(4000) + '\n' + '字'.repeat(3000);
  return [
    { id: 'single', chatId: '111', text: 'hello', threadId: '', plan: [ok] },
    { id: 'thread', chatId: -100123, text: 'hello', threadId: 77, plan: [ok] },
    { id: 'multi_chunk', chatId: '111', text: long, threadId: '', plan: [ok, ok, ok] },
    { id: 'api_not_ok', chatId: '111', text: 'x', threadId: '', plan: [{ status: 200, body: '{"ok":false}' }] },
    { id: 'http_400_no_retry', chatId: '111', text: 'x', threadId: '', plan: [{ status: 400, body: '{"ok":false,"description":"bad"}' }] },
    { id: 'retry_500_then_ok', chatId: '111', text: 'x', threadId: '', plan: [{ status: 500, body: 'oops' }, ok] },
    { id: 'retry_429_retry_after', chatId: '111', text: 'x', threadId: '', plan: [{ status: 429, body: 'slow', headers: { 'Retry-After': '2' } }, ok] },
    { id: 'retry_429_cap', chatId: '111', text: 'x', threadId: '', plan: [{ status: 429, body: 'slow', headers: { 'retry-after': '30' } }, ok] },
    { id: 'retry_exhausted', chatId: '111', text: 'x', threadId: '', plan: [{ status: 503, body: 'a' }, { status: 502, body: 'b' }, { status: 500, body: 'c'.repeat(400) }] },
    { id: 'network_then_ok', chatId: '111', text: 'x', threadId: '', plan: [{ throw: 'DNS error' }, { throw: 'timeout' }, ok] },
    { id: 'network_exhausted', chatId: '111', text: 'x', threadId: '', plan: [{ throw: 'e1' }, { throw: 'e2' }, { throw: 'e3 final' }] },
    { id: 'second_chunk_fails', chatId: '111', text: long, threadId: '', plan: [ok, { status: 400, body: 'nope' }] },
    { id: 'empty_text', chatId: '111', text: '', threadId: '', plan: [ok] },
    { id: 'retry_after_zero', chatId: '111', text: 'x', threadId: '', plan: [{ status: 408, body: 't', headers: { 'Retry-After': '0' } }, ok] },
    { id: 'retry_after_junk', chatId: '111', text: 'x', threadId: '', plan: [{ status: 500, body: 't', headers: { 'Retry-After': 'soon' } }, ok] },
  ];
}
function runSend(c) {
  const env = makeEnv({});
  env.fetchPlan = J(c.plan);
  env.ctx.__cfg = { tgToken: '123:TESTTOKEN' }; env.ctx.__c = c;
  env.run(`logEvent_ = function (level, event, details) { __rec.logs.push({ level: level, event: event, details: JSON.parse(JSON.stringify(details || {})) }); };`);
  let error = null;
  try { env.run('sendTelegramMessage_(__c.chatId, __c.text, __cfg, __c.threadId)'); } catch (e) { error = e.message; }
  return { error, fetchCalls: env.fetchCalls, sleeps: env.sleeps, logs: J(env.ctx.__rec.logs) };
}

// ---------- 3. 訊號入口流程 ----------
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sigText(sym, tf, side, extra) {
  return `《維加斯訊號》交易訊號\n─────────────\n[時間] 2026-09-21 20:13:00\n[幣種] ${sym}\n[週期] ${tf}分鐘\n[時區] Asia/Taipei\n[方向] ${side}\n[價格] 85397.5 USDT${extra || ''}`;
}
const CFG = (o) => Object.assign({ tgToken: '123:TESTTOKEN', allowedChatId: '111', signalChatId: '', signalThreadId: '', tradingViewSecret: 's' }, o || {});

function runFlow(sc) {
  const env = makeEnv(sc.seed || {});
  const rec = env.ctx.__rec;
  env.ctx.__cfg = sc.config;
  env.run(`
    logEvent_ = function (level, event, details) { __rec.logs.push({ level: level, event: event, details: JSON.parse(JSON.stringify(details || {})) }); };
    sendTelegramMessage_ = function (chatId, text, config, threadId) {
      __rec.calls.push({ fn: 'send', chatId: String(chatId), text: text, threadId: threadId === undefined ? null : threadId });
      if (__plan.failChats && __plan.failChats.indexOf(String(chatId)) !== -1) throw new Error('Telegram HTTP 500: boom ' + chatId);
    };
    forwardToShadow_ = function (text, key) { __rec.calls.push({ fn: 'shadow', text: text, key: key }); };
  `);
  const out = [];
  for (const st of sc.steps) {
    env.t += st.dt || 0;
    rec.calls.length = 0; rec.logs.length = 0;
    env.ctx.__plan = J(st.plan || {}); env.ctx.__st = J(st);
    if (st.lockOk !== undefined) env.lockOk = st.lockOk;
    // forwardToExecutor_ 依步驟設定：absent=未安裝；throw；result；advanceMs=模擬耗時
    const f = st.forward || { absent: true };
    env.ctx.__fwd = f;
    if (f.absent) env.run('forwardToExecutor_ = undefined;');
    else env.run(`forwardToExecutor_ = function (text, key) { __rec.calls.push({ fn: 'forward', text: text, key: key });
      if (__fwd.advance) __advance(__fwd.advance); if (__fwd.throw) throw new Error(__fwd.throw); return __fwd.result; };`);
    env.ctx.__advance = (ms) => { env.t += ms; };
    if (st.shadow === false) env.run('forwardToShadow_ = undefined;');
    else env.run(`forwardToShadow_ = function (text, key) { __rec.calls.push({ fn: 'shadow', text: text, key: key }); };`);
    let result, error = null;
    try {
      if (st.op === 'handle') {
        env.ctx.__e = { postData: { contents: st.body }, parameter: {} };
        result = J(env.run('handleTradingViewSignal_(__e, __cfg, __st.origin).text'));
      } else if (st.op === 'retry') {
        result = J(env.run('processSignalRetries_(PropertiesService.getScriptProperties().getProperties(), __cfg)'));
      } else if (st.op === 'reject') {
        env.run('noteRejectedRequest_(__st.reason)'); result = null;
      } else if (st.op === 'reserve') {
        result = J(env.run('reserveSignal_(__st.body)'));
      } else if (st.op === 'recent') {
        env.run('rememberRecentSignal_(__st.body)'); result = J(env.run('getRecentSignals_()'));
      } else if (st.op === 'deliver') {
        result = J(env.run('deliverRawSignal_(__st.body, __st.targets, __cfg)'));
      }
    } catch (e) { error = e.message; }
    out.push({ result, error, calls: J(rec.calls), logs: J(rec.logs), t: env.t });
  }
  return { steps: out, final: stateOf(env) };
}

function flowScenarios() {
  const S = [];
  const A = sigText('BTCUSDT.P', 15, '做多'), B = sigText('ETHUSDT.P', 60, '做空');
  const fwdOk = { result: { cardSent: true, broadcastSent: true } };
  const H = (body, o) => Object.assign({ op: 'handle', dt: 0, body, origin: 'webhook', forward: fwdOk }, o || {});
  S.push({ id: 'happy_card_and_broadcast', config: CFG({ signalChatId: '-100' }), steps: [H(A)] });
  S.push({ id: 'happy_no_group', config: CFG(), steps: [H(A, { forward: { result: { cardSent: true } } })] });
  S.push({ id: 'dup_ignored', config: CFG(), steps: [H(A), H(A, { dt: 1000 }), H(A, { dt: 1800 * 1000 })] });
  S.push({ id: 'empty_and_unexpected', config: CFG(), steps: [H(''), H('   \n '), H('hello world'), H(null)] });
  S.push({ id: 'card_failed_raw_private', config: CFG(), steps: [H(A, { forward: { result: { cardSent: false, broadcastSent: false } } })] });
  S.push({ id: 'broadcast_failed_raw_group', config: CFG({ signalChatId: '-100', signalThreadId: '9' }),
    steps: [H(A, { forward: { result: { cardSent: true, broadcastSent: false } } })] });
  S.push({ id: 'both_raw_with_group', config: CFG({ signalChatId: '-100', signalThreadId: '9' }),
    steps: [H(A, { forward: { result: { cardSent: false, broadcastSent: false } } })] });
  S.push({ id: 'group_same_as_private', config: CFG({ signalChatId: '111' }),
    steps: [H(A, { forward: { result: { cardSent: false, broadcastSent: false } } })] });
  S.push({ id: 'forward_absent', config: CFG({ signalChatId: '-100' }), steps: [H(A, { forward: { absent: true } })] });
  S.push({ id: 'forward_returns_null', config: CFG(), steps: [H(A, { forward: { result: null } })] });
  S.push({ id: 'forward_throws', config: CFG({ signalChatId: '-100' }), steps: [H(A, { forward: { throw: 'executor exploded' } })] });
  S.push({ id: 'raw_private_fails_queued', config: CFG(), steps: [H(A, { forward: { result: { cardSent: false, broadcastSent: false } }, plan: { failChats: ['111'] } })] });
  S.push({ id: 'raw_group_fails_card_ok', config: CFG({ signalChatId: '-100' }),
    steps: [H(A, { forward: { result: { cardSent: true, broadcastSent: false } }, plan: { failChats: ['-100'] } })] });
  S.push({ id: 'one_of_two_fails', config: CFG({ signalChatId: '-100' }),
    steps: [H(A, { forward: { result: { cardSent: false, broadcastSent: false } }, plan: { failChats: ['-100'] } })] });
  S.push({ id: 'all_fail_then_retry_ok', config: CFG({ signalChatId: '-100' }), steps: [
    H(A, { forward: { result: { cardSent: false, broadcastSent: false } }, plan: { failChats: ['111', '-100'] } }),
    { op: 'retry', dt: 30 * 1000 }, { op: 'retry', dt: 90 * 1000 }, { op: 'recent', body: 'x' }] });
  S.push({ id: 'retry_backoff_and_partial', config: CFG({ signalChatId: '-100' }), steps: [
    H(A, { forward: { result: { cardSent: false, broadcastSent: false } }, plan: { failChats: ['111', '-100'] } }),
    { op: 'retry', dt: 1000, plan: { failChats: ['111', '-100'] } },
    { op: 'retry', dt: 60 * 1000, plan: { failChats: ['111'] } },
    { op: 'retry', dt: 130 * 1000, plan: { failChats: ['111'] } },
    { op: 'retry', dt: 300 * 1000, plan: { failChats: ['111'] } },
    { op: 'retry', dt: 600 * 1000 }] });
  S.push({ id: 'retry_dropped_attempts', config: CFG(), steps: [
    H(A, { forward: { result: { cardSent: false } }, plan: { failChats: ['111'] } }),
    ...Array.from({ length: 12 }, () => ({ op: 'retry', dt: 31 * 60 * 1000, plan: { failChats: ['111'] } }))] });
  S.push({ id: 'retry_dropped_age', config: CFG(), steps: [
    H(A, { forward: { result: { cardSent: false } }, plan: { failChats: ['111'] } }),
    { op: 'retry', dt: 7 * 3600 * 1000, plan: { failChats: ['111'] } }] });
  S.push({ id: 'retry_legacy_record', config: CFG({ signalChatId: '-100' }),
    seed: { props: { TVRETRY_1_abc: JSON.stringify({ text: A, dedupKey: 'tv:abcdef0123456789', firstFailedAt: T0 - 120000, nextAttemptAt: T0 - 1, attempts: 2, lastError: 'old' }),
      TVRETRY_2_bad: '{not json' } }, steps: [{ op: 'retry', dt: 0 }] });
  S.push({ id: 'queue_full', config: CFG(), seed: { props: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['TVRETRY_' + i + '_x', '{}'])) },
    steps: [H(A, { forward: { result: { cardSent: false } }, plan: { failChats: ['111'] } })] });
  S.push({ id: 'lock_unavailable', config: CFG(), steps: [{ op: 'handle', dt: 0, body: A, origin: 'webhook', forward: fwdOk, lockOk: false }] });
  S.push({ id: 'shadow_absent', config: CFG(), steps: [H(A, { shadow: false })] });
  S.push({ id: 'elapsed_ms', config: CFG(), steps: [H(A, { forward: { result: { cardSent: true }, advance: 640 } })] });
  S.push({ id: 'recent_signals', config: CFG(), steps: [
    ...Array.from({ length: 7 }, (_, i) => ({ op: 'recent', dt: 60000, body: 'sig' + i + '長'.repeat(i * 300) })), { op: 'recent', body: '🧪'.repeat(800) }] });
  S.push({ id: 'reject_summary', config: CFG(), steps: [
    { op: 'reject', reason: 'tradingview_auth_rejected' }, { op: 'reject', dt: 1000, reason: 'a' }, { op: 'reject', dt: 1000, reason: 'b' },
    { op: 'reject', dt: 600 * 1000, reason: 'c' }, { op: 'reject', dt: 1000, reason: 'd' }] });
  S.push({ id: 'deliver_targets', config: CFG({ signalChatId: '-100', signalThreadId: '5' }), steps: [
    { op: 'deliver', body: 't', targets: ['private'] }, { op: 'deliver', body: 't', targets: ['group'] },
    { op: 'deliver', body: 't', targets: ['signal'] }, { op: 'deliver', body: 't', targets: [] },
    { op: 'deliver', body: 't', targets: ['private', 'group'], plan: { failChats: ['111'] } }] });
  S.push({ id: 'deliver_signal_no_group', config: CFG(), steps: [{ op: 'deliver', body: 't', targets: ['signal'] }] });
  S.push({ id: 'queue_full_but_card_ok', config: CFG({ signalChatId: '-100' }), seed: { props: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['TVRETRY_' + i + '_x', '{}'])) },
    steps: [H(A, { forward: { result: { cardSent: true, broadcastSent: false } }, plan: { failChats: ['-100'] } })] });
  S.push({ id: 'queue_full_one_of_two_ok', config: CFG({ signalChatId: '-100' }), seed: { props: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['TVRETRY_' + i + '_x', '{}'])) },
    steps: [H(A, { forward: { result: { cardSent: false, broadcastSent: false } }, plan: { failChats: ['-100'] } })] });
  S.push({ id: 'forward_throws_queue_full', config: CFG(), seed: { props: Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['TVRETRY_' + i + '_x', '{}'])) },
    steps: [H(A, { forward: { throw: 'boom' } })] });
  for (const ms of [30000, 90000, 150000, 210000, 270000, 330000]) {
    S.push({ id: 'retry_round_' + ms, config: CFG(), steps: [
      H(A, { forward: { result: { cardSent: false } }, plan: { failChats: ['111'] } }), { op: 'retry', dt: ms } ] });
  }
  S.push({ id: 'dropped_age_round', config: CFG(), seed: { props: { TVRETRY_9_z: JSON.stringify({ text: A, dedupKey: 'tv:zzzzzzzzzzzzzzzz', firstFailedAt: T0 - 6 * 3600e3 - 90000, nextAttemptAt: 0, attempts: 1, lastError: 'e' }) } },
    steps: [{ op: 'retry', dt: 0 }] });

  // 隨機流程
  const r = rng(20261015);
  const syms = ['BTCUSDT.P', 'ETHUSDT.P', 'SOLUSDT.P', 'DOGEUSDT.P'], sides = ['做多', '做空'];
  const bodies = () => { const k = r();
    if (k < 0.55) return sigText(syms[Math.floor(r() * 4)], [5, 15, 30, 60][Math.floor(r() * 4)], sides[Math.floor(r() * 2)], r() < 0.3 ? ' 🧪' : '');
    if (k < 0.7) return A; if (k < 0.8) return ''; if (k < 0.9) return 'noise ' + Math.floor(r() * 99); return B; };
  for (let n = 0; n < 160; n++) {
    const group = r() < 0.5;
    const steps = [];
    const len = 3 + Math.floor(r() * 7);
    for (let i = 0; i < len; i++) {
      const k = r(); const dt = Math.floor(r() * 4) * Math.floor(r() * 400000);
      const fails = ['111', '-100'].filter(() => r() < 0.3);
      if (k < 0.6) {
        const fk = r();
        const forward = fk < 0.45 ? { result: { cardSent: r() < 0.7, broadcastSent: r() < 0.7 } } : fk < 0.6 ? { absent: true }
          : fk < 0.7 ? { throw: 'fwd err' } : fk < 0.8 ? { result: null } : { result: { cardSent: true, broadcastSent: true }, advance: Math.floor(r() * 900) };
        steps.push({ op: 'handle', dt, body: bodies(), origin: r() < 0.9 ? 'webhook' : 'manual', forward, plan: { failChats: fails }, shadow: r() < 0.8 });
      } else if (k < 0.85) steps.push({ op: 'retry', dt, plan: { failChats: fails } });
      else if (k < 0.93) steps.push({ op: 'reject', dt, reason: 'r' + Math.floor(r() * 4) });
      else steps.push({ op: 'recent', dt, body: bodies() });
    }
    S.push({ id: 'flow_rand_' + n, config: CFG(group ? { signalChatId: r() < 0.9 ? '-100' : '111', signalThreadId: r() < 0.5 ? '9' : '' } : {}), steps });
  }
  return S;
}


// ---------- 4. doPost 路由（密鑰驗證、來源分流、設定缺漏）----------
const FULL_PROPS = { TG_TOKEN: ' 123:TESTTOKEN ', ALLOWED_CHAT_ID: '111', TRADINGVIEW_WEBHOOK_SECRET: 'tv-secret', TELEGRAM_WEBHOOK_SECRET: 'tg-secret', WEBAPP_URL: 'https://x', SIGNAL_CHAT_ID: '-100', SIGNAL_THREAD_ID: ' 9 ', ANTHROPIC_API_KEY: ' k ' };
function runDoPost(sc) {
  const env = makeEnv({ props: sc.props });
  const rec = env.ctx.__rec; env.ctx.__sc = sc;
  env.run(`
    logEvent_ = function (level, event, details) { __rec.logs.push({ level: level, event: event, details: JSON.parse(JSON.stringify(details || {})) }); };
    logConsoleOnly_ = function () {};
    sendTelegramMessage_ = function (chatId, text, config, threadId) { __rec.calls.push({ fn: 'send', chatId: String(chatId), text: text, threadId: threadId === undefined ? null : threadId }); };
    forwardToShadow_ = undefined;
    forwardToExecutor_ = function (text, key) { __rec.calls.push({ fn: 'forward', key: key }); return { cardSent: true, broadcastSent: true }; };
    handleTelegramMessage_ = function (e, config) { __rec.calls.push({ fn: 'telegram', body: e.postData.contents, cfg: config }); return textOutput_('tg-handled'); };
  `);
  const outs = [];
  for (const st of sc.steps) {
    env.t += st.dt || 0; rec.calls.length = 0; rec.logs.length = 0; env.ctx.__e = J(st.e);
    let result = null, error = null;
    try { result = J(env.run('doPost(__e).text')); } catch (e) { error = e.message; }
    outs.push({ result, error, calls: J(rec.calls), logs: J(rec.logs) });
  }
  return { steps: outs, final: stateOf(env) };
}
function doPostScenarios() {
  const A = sigText('BTCUSDT.P', 15, '做多');
  const E = (source, key, body) => ({ parameter: { source, key }, postData: { contents: body } });
  const P = (o) => Object.assign({}, FULL_PROPS, o || {});
  const S = [];
  S.push({ id: 'tv_ok', props: P(), steps: [{ e: E('tradingview', 'tv-secret', A) }] });
  S.push({ id: 'tv_ok_case_source', props: P(), steps: [{ e: E('TradingView', 'tv-secret', A) }] });
  S.push({ id: 'tv_bad_key', props: P(), steps: [{ e: E('tradingview', 'nope', A) }, { dt: 1000, e: E('tradingview', '', A) }] });
  S.push({ id: 'tv_key_wrong_source_secret', props: P(), steps: [{ e: E('tradingview', 'tg-secret', A) }] });
  S.push({ id: 'tg_ok', props: P(), steps: [{ e: E('telegram', 'tg-secret', '{"update_id":1}') }] });
  S.push({ id: 'tg_bad_key', props: P(), steps: [{ e: E('telegram', 'tv-secret', '{}') }] });
  S.push({ id: 'unknown_source', props: P(), steps: [{ e: E('foo', 'x', A) }, { e: E('', 'x', A) }, { e: { postData: { contents: A } } }] });
  S.push({ id: 'missing_props', props: P({ TG_TOKEN: '' }), steps: [{ e: E('tradingview', 'tv-secret', A) }] });
  S.push({ id: 'missing_many', props: { TG_TOKEN: 'x' }, steps: [{ e: E('telegram', 'k', '{}') }, { e: E('', '', '') }] });
  S.push({ id: 'no_event', props: P(), steps: [{ e: {} }] });
  S.push({ id: 'dup_via_route', props: P(), steps: [{ e: E('tradingview', 'tv-secret', A) }, { dt: 1000, e: E('tradingview', 'tv-secret', A) }] });
  S.push({ id: 'reject_summary_route', props: P(), steps: [
    { e: E('tradingview', 'bad', A) }, { dt: 1000, e: E('telegram', 'bad', A) }, { dt: 1000, e: E('x', 'bad', A) }, { dt: 700000, e: E('', 'bad', A) }] });
  S.push({ id: 'no_group', props: P({ SIGNAL_CHAT_ID: '' }), steps: [{ e: E('tradingview', 'tv-secret', A) }] });
  return S;
}

// ---------- 輸出 ----------
const vectors = [];
for (const [f, args] of pureCases()) vectors.push({ id: `pure_${f}_${vectors.length}`, fn: 'pure', input: { f, args }, expected: runPure(makeEnv({}), f, args) });
for (const c of sendCases()) vectors.push({ id: 'send_' + c.id, fn: 'send_telegram', input: c, expected: runSend(c) });
for (const sc of flowScenarios()) vectors.push({ id: 'intake_' + sc.id, fn: 'intake_flow', input: sc, expected: runFlow(sc) });
for (const sc of doPostScenarios()) vectors.push({ id: 'dopost_' + sc.id, fn: 'do_post', input: sc, expected: runDoPost(sc) });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'intake.json'), JSON.stringify(vectors));
console.log('intake.json', vectors.length, 'vectors');
