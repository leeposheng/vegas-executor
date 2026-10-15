'use strict';
// 模組 D 黃金向量：Telegram 文字訊息分支（指令、暫停、狀態、陌生聊天室、askClaude_）。
// 用法：node gen_dm.js <Code.gs> <Executor.gs> <輸出資料夾>
const fs = require('fs'), path = require('path');
const { makeEnv, J, stateOf, rng } = require('./gas_env.js');
const SRC = fs.readFileSync(path.resolve(process.argv[2]), 'utf8') + '\n' + fs.readFileSync(path.resolve(process.argv[3]), 'utf8');
const OUT = path.resolve(process.argv[4]);
const FULL_PROPS = { TG_TOKEN: '123:TESTTOKEN', ALLOWED_CHAT_ID: '111', TRADINGVIEW_WEBHOOK_SECRET: 'tv', TELEGRAM_WEBHOOK_SECRET: 'tg', WEBAPP_URL: 'https://x' };

function mkEnv(sc) {
  const env = makeEnv(SRC, { props: Object.assign({}, FULL_PROPS, sc.props || {}), cache: sc.cache || {} });
  env.ctx.__sc = J(sc);
  env.run(`
    logEvent_ = function (level, event, details) { __rec.logs.push({ level: level, event: event, details: JSON.parse(JSON.stringify(details || {})) }); };
    console.error = function () {}; console.warn = function () {};
    sendTelegramMessage_ = function (chatId, text, config, threadId) {
      __rec.calls.push({ fn: 'send', chatId: chatId, text: text, threadId: threadId === undefined ? null : threadId });
      if (__sc.sendFails) throw new Error('Telegram HTTP 500: boom');
    };
    sendLimitPanel_ = function (config) { __rec.calls.push({ fn: 'limitPanel' }); };
    sendDailyPanel_ = function (config) { __rec.calls.push({ fn: 'dailyPanel' }); };
    handleExecutorCallback_ = function (cb, config) { __rec.calls.push({ fn: 'execCallback', data: cb.data }); return textOutput_('cb ok'); };
    tgApi_ = function (method, body) { __rec.calls.push({ fn: 'tgApi', method: method, body: JSON.parse(JSON.stringify(body)) }); return { message_id: 1 }; };
    var __cq = (__sc.claude || []).slice();
    fetchWithRetry_ = function (url, options, service) {
      __rec.calls.push({ fn: 'claude', url: url, service: service, options: JSON.parse(JSON.stringify(options)) });
      var p = __cq.length > 1 ? __cq.shift() : __cq[0];
      if (!p) throw new Error('no plan');
      if (p.throw) throw new Error(p.throw);
      return { getContentText: function () { return p.body; } };
    };
  `);
  return env;
}
function flowRun(sc) {
  const env = mkEnv(sc), rec = env.ctx.__rec, out = [];
  for (const st of sc.steps) {
    rec.calls.length = 0; rec.logs.length = 0; env.t += st.dt || 0;
    if (st.lockOk !== undefined) env.lockOk = st.lockOk;
    env.ctx.__e = { postData: { contents: typeof st.update === 'string' ? st.update : JSON.stringify(st.update) } };
    let result = null, error = null;
    try { result = J(env.run('handleTelegramMessage_(__e, getConfig_())')).text; } catch (e) { error = e.message; }
    out.push({ result, error, calls: J(rec.calls), logs: J(rec.logs), t: env.t });
  }
  return { steps: out, final: stateOf(env) };
}
function pureRun(c) {
  const env = mkEnv(c); env.ctx.__a = c.args;
  return J(env.run(c.expr));
}

let uid = 5000;
function msg(text, o) {
  o = o || {};
  const m = { message_id: 1, chat: { id: o.chat === undefined ? 111 : o.chat } };
  if (text !== undefined) m.text = text;
  if (o.thread) m.message_thread_id = o.thread;
  if (o.bot) m.from = { is_bot: true };
  else if (o.from !== null) m.from = { id: 111, is_bot: false };
  const u = { message: m };
  if (o.updateId !== null) u.update_id = o.updateId === undefined ? ++uid : o.updateId;
  return u;
}
const RECENT = JSON.stringify([{ receivedAt: '2026-09-21 20:13', text: '《維加斯訊號》交易訊號\n[幣種] BTCUSDT.P' }, { receivedAt: '2026-09-21 19:00', text: '舊訊號' }]);
const OKBODY = (t) => JSON.stringify({ content: [{ type: 'text', text: t }] });

function scenarios() {
  const S = []; const r = rng(2468);
  const add = (id, steps, o) => S.push(Object.assign({ id, steps }, o || {}));
  const M = (t, o, st) => Object.assign({ update: msg(t, o) }, st || {});
  for (const t of ['停止', '暫停', '/stop', '/pause', '/stop@vegas_bot', '/STOP', '  停止  ', '停止 現在', '／停止'])
    add('pause_' + S.length, [M(t)], {});
  add('pause_then_resume', [M('停止'), M('狀態'), M('hello'), M('啟用'), M('狀態')], {});
  for (const t of ['啟用', '啟動', '開始', '恢復', '/start', '/resume', '/start@bot', '//start']) add('resume_' + S.length, [M(t)], { props: { TELEGRAM_CHAT_PAUSED: 'true' } });
  for (const t of ['部位', '上限', '/limit', '/limits', '/limits@x']) add('limit_' + S.length, [M(t)], {});
  for (const t of ['日損', '重置', '/daily', '/reset', '/日損']) add('daily_' + S.length, [M(t)], {});
  add('id_private', [M('/id')], {});
  add('id_private_thread', [M('chatid', { thread: 42 })], {});
  add('id_stranger', [M('/id', { chat: -100777 }), M('/id', { chat: -100777 }), M('id', { chat: -100777, thread: 9 })], {});
  add('id_stranger_chatid_alias', [M('chatid', { chat: -100888 })], {});
  add('id_stranger_with_thread', [M('/id', { chat: -100889, thread: 15 })], {});
  add('status_one_retry', [M('狀態')], { props: { TVRETRY_1_a: '{}' } });
  add('id_stranger_same_update', [M('/id', { chat: -1002, updateId: 70 }), M('/id', { chat: -1003, updateId: 70 })], {});
  add('id_stranger_after_60s', [M('/id', { chat: -1002 }), M('/id', { chat: -1002 }, { dt: 61000 })], {});
  add('id_stranger_no_update_id', [M('/id', { chat: -1002, updateId: null }), M('/id', { chat: -1002, updateId: null })], {});
  add('stranger_other', [M('hello', { chat: -5 }), M('hello', { chat: -5 }), M('hello', { chat: -5 }, { dt: 61000 })], {});
  add('stranger_chat_zero_like', [M('hello', { chat: -5, updateId: 90 }), M('hello', { chat: -6, updateId: 90 })], {});
  for (const t of ['選單', '指令', '/menu', '/help', '說明']) add('menu_' + S.length, [M(t)], {});
  add('status_plain', [M('狀態')], {});
  add('status_paused', [M('/status')], { props: { TELEGRAM_CHAT_PAUSED: 'true' } });
  add('status_recent_retry', [M('狀態')], { cache: { 'tv:recent': [RECENT, 9e15] }, props: { TVRETRY_1_a: '{}', TVRETRY_2_b: '{}', EXECRETRY_3_c: '{}' } });
  add('status_recent_corrupt', [M('狀態')], { cache: { 'tv:recent': ['{bad', 9e15] } });
  add('status_recent_object', [M('狀態')], { cache: { 'tv:recent': ['{"a":1}', 9e15] } });
  // askClaude_
  add('ask_no_key', [M('BTC 現在怎麼看')], {});
  add('ask_ok', [M('  BTC 現在怎麼看  ')], { props: { ANTHROPIC_API_KEY: ' sk-ant-xxx ' }, claude: [{ body: OKBODY('多頭排列，等回踩。') }] });
  add('ask_ok_recent', [M('剛剛那筆止損多少？')], { props: { ANTHROPIC_API_KEY: 'sk-ant-xxx' }, cache: { 'tv:recent': [RECENT, 9e15] }, claude: [{ body: OKBODY('止損在 85011.8。') }] });
  add('ask_quotes_unicode', [M('他說 "hi" \\ 換行\n與 emoji 😀   \u0007')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: OKBODY('ok') }] });
  add('ask_long_reply', [M('長')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: OKBODY('字'.repeat(4000)) }] });
  add('ask_api_error_message', [M('q')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: JSON.stringify({ error: { message: 'overloaded' } }) }] });
  add('ask_api_error_no_message', [M('q')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: JSON.stringify({ error: {} }) }] });
  add('ask_empty_content', [M('q')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: JSON.stringify({ content: [] }) }] });
  add('ask_empty_text', [M('q')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: JSON.stringify({ content: [{ text: '' }] }) }] });
  add('ask_non_text_block', [M('q')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: JSON.stringify({ content: [{ type: 'tool_use' }] }) }] });
  add('ask_array_body', [M('q')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: '[]' }] });
  add('ask_string_body', [M('q')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: '"hi"' }] });
  add('ask_fetch_throws', [M('q')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ throw: 'Claude HTTP 529: overloaded' }] });
  add('ask_paused', [M('q')], { props: { ANTHROPIC_API_KEY: 'k', TELEGRAM_CHAT_PAUSED: 'true' }, claude: [{ body: OKBODY('x') }] });
  add('ask_command_not_matched', [M('日損怎麼辦')], { props: { ANTHROPIC_API_KEY: 'k' }, claude: [{ body: OKBODY('x') }] });
  // 過濾與錯誤
  add('bot_message', [M('hi', { bot: true })], {});
  add('empty_text', [M('')], {});
  add('blank_text', [M('   \n ')], {});
  add('no_text', [M(undefined)], {});
  add('numeric_text', [{ update: { update_id: 11, message: { chat: { id: 111 }, text: 123 } } }], {});
  add('no_message', [{ update: { update_id: 12 } }], {});
  add('no_chat', [{ update: { update_id: 13, message: { text: 'x' } } }], {});
  add('invalid_json', [{ update: '{oops' }], {});
  add('null_json', [{ update: 'null' }], {});
  add('dup_message', [M('狀態', { updateId: 300 }), M('狀態', { updateId: 300 })], {});
  add('dup_message_logged_once', [M('狀態', { updateId: 301 }), M('狀態', { updateId: 301 }), M('狀態', { updateId: 301 })], {});
  add('bad_update_id', [{ update: Object.assign(msg('狀態'), { update_id: 'x1' }) }], {});
  add('no_update_id', [M('狀態', { updateId: null })], {});
  add('lock_busy', [M('狀態', {}, { lockOk: false })], {});
  add('send_fails', [M('狀態')], { sendFails: true });
  add('callback_dispatch', [{ update: { update_id: 400, callback_query: { id: 'q', data: 'vg.c.x', from: { id: 111 }, message: { chat: { id: 111 }, message_id: 1 } } } }], {});
  add('callback_stranger', [{ update: { update_id: 401, callback_query: { id: 'q', data: 'vg.c.x', message: { chat: { id: 999 } } } } }], {});
  // 隨機文字
  const pool = ['狀態', '/日損', '部位', '/help', 'hello', '停止', '啟用', '/id', '選單 ', 'STATUS', '/Status@x y z', '😀', '/', '@', 'a@b', '日損@bot'];
  for (let i = 0; i < 40; i++) {
    const t = pool[Math.floor(r() * pool.length)] + (r() < 0.3 ? ' 附帶文字' : '');
    add('rand_' + i, [M(t, { chat: r() < 0.2 ? -9 : 111 })], { props: r() < 0.5 ? { ANTHROPIC_API_KEY: 'k' } : {}, claude: [{ body: OKBODY('r' + i) }] });
  }
  return S;
}
function pureCases() {
  const C = [];
  const add = (id, expr, args) => C.push({ id, expr, args });
  for (const t of ['', '  ', '日損', '/日損', '//a', '/DAILY@Bot x', '  /Stop  now', 'a\tb', 'a b', '/x@y@z', '@only', '/', null, undefined, 123, '／x', 'İ', 'ÀB c'])
    add('norm_' + C.length, 'normalizeTelegramCommand_(__a[0])', [t === undefined ? null : t]);
  for (const [c, a] of [['stop', ['停止', '/stop']], ['日損', ['日損', '/daily']], ['daily', ['/DAILY']], ['', ['', 'x']], ['x', ['//x']], ['x', []]])
    add('iscmd_' + C.length, 'isCommand_(__a[0], __a[1])', [c, a]);
  return C;
}

const vectors = [];
for (const sc of scenarios()) vectors.push({ id: 'dflow_' + sc.id, fn: 'dflow', input: sc, expected: flowRun(sc) });
for (const c of pureCases()) vectors.push({ id: 'dpure_' + c.id, fn: 'dpure', input: c, expected: pureRun(c) });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bot_d.json'), JSON.stringify(vectors));
console.log('bot_d.json', vectors.length, 'vectors');
