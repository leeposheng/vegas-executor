'use strict';
// 模組 G 黃金向量：Webhook 管理（setWebhook 請求、getWebhookInfo 診斷輸出、網址組裝）。
// 用法：node gen_wh.js <Code.gs> <Executor.gs> <輸出資料夾>
const fs = require('fs'), path = require('path');
const { makeEnv, J } = require('./gas_env.js');
const SRC = fs.readFileSync(path.resolve(process.argv[2]), 'utf8') + '\n' + fs.readFileSync(path.resolve(process.argv[3]), 'utf8');
const OUT = path.resolve(process.argv[4]);
const BASE = { TG_TOKEN: '123:TESTTOKEN', ALLOWED_CHAT_ID: '111', TRADINGVIEW_WEBHOOK_SECRET: 'tvsecret', TELEGRAM_WEBHOOK_SECRET: 'tgsecret', WEBAPP_URL: 'https://example.test/exec' };
function mk(props, resp) {
  const env = makeEnv(SRC, { props: Object.assign({}, BASE, props || {}) });
  env.ctx.__resp = J(resp || { status: 200, body: '{"ok":true}' });
  env.run(`
    __rec.lines = []; __rec.fetches = [];
    console.log = function (s) { __rec.lines.push(String(s)); };
    console.warn = function () {}; console.error = function () {};
    fetchWithRetry_ = function (url, options, service) {
      __rec.fetches.push({ url: url, options: JSON.parse(JSON.stringify(options)), service: service });
      return { getResponseCode: function () { return __resp.status; }, getContentText: function () { return __resp.body; } };
    };
  `);
  return env;
}
const out = (env) => ({ lines: J(env.ctx.__rec.lines), fetches: J(env.ctx.__rec.fetches) });
const cases = [];
const V = (id, fn, input, expected) => cases.push({ id, fn, input, expected });

// setWebhook
for (const [id, drop, props, resp] of [
  ['plain', false, {}, { status: 200, body: '{"ok":true,"result":true,"description":"Webhook was set"}' }],
  ['drop', true, {}, { status: 200, body: '{"ok":true}' }],
  ['q_in_base', false, { WEBAPP_URL: 'https://a.b/c?x=1' }, { status: 200, body: 'ok' }],
  ['uri_safe_chars', false, { TELEGRAM_WEBHOOK_SECRET: "a-_.!~*'()b" }, { status: 200, body: 'ok' }],
  ['special_secret', false, { TELEGRAM_WEBHOOK_SECRET: 'a b&c=d/é+😀' }, { status: 200, body: 'ok' }],
  ['err_body_token', true, {}, { status: 401, body: '{"ok":false,"description":"Unauthorized bot123:ABCdef-ghi"}' }],
  ['err_secret_url', false, {}, { status: 400, body: 'bad url https://x/?key=SECRETVALUE&a=1' }],
  ['long_body', false, {}, { status: 500, body: 'x'.repeat(900) }],
]) {
  const env = mk(props, resp);
  env.run('setTelegramWebhook_(' + drop + ')');
  V('set_' + id, 'wh_set', { drop, props, resp }, out(env));
}
// 診斷
const URLX = 'https://example.test/exec?source=telegram&key=tgsecret';
const infos = {
  ok_clean: { url: URLX, pending_update_count: 0, max_connections: 5, allowed_updates: ['message', 'callback_query'] },
  pending: { url: URLX, pending_update_count: 12, max_connections: 40 },
  error: { url: URLX, last_error_date: 1758470000, last_error_message: 'Wrong response from the webhook: 500', pending_update_count: 3 },
  sync_error: { url: URLX, last_synchronization_error_date: 1758470123 },
  url_mismatch: { url: 'https://old.test/exec?source=telegram&key=zzz', pending_update_count: 0 },
  no_url: { pending_update_count: 0 },
  empty: {},
  all: { url: URLX, last_error_date: 1758470000, last_error_message: 'boom', last_synchronization_error_date: 1, pending_update_count: 1, max_connections: 5, allowed_updates: [] },
  short_url: { url: 'abc' },
  err_only_no_pending: { url: URLX, last_error_message: 'x', pending_update_count: 0 },
};
for (const [id, info] of Object.entries(infos)) {
  const resp = { status: 200, body: JSON.stringify({ ok: true, result: info }) };
  const env = mk({}, resp); env.run('diagnoseTelegramWebhook()');
  V('diag_' + id, 'wh_diag', { resp, props: {} }, out(env));
}
for (const [id, body] of Object.entries({ html: '<html>502 token bot123:ABC</html>', empty: '', null: 'null', no_result: '{"ok":true}', str_result: '{"result":"abc"}', num: '5', arr: '[]' })) {
  const resp = { status: 200, body };
  const env = mk({}, resp); env.run('diagnoseTelegramWebhook()');
  V('diag_raw_' + id, 'wh_diag', { resp, props: {} }, out(env));
}
{ const props = { WEBAPP_URL: 'https://a.b/c?x=1' };
  const resp = { status: 200, body: JSON.stringify({ ok: true, result: { url: 'https://a.b/c?x=1&source=telegram&key=tgsecret' } }) };
  const env = mk(props, resp); env.run('diagnoseTelegramWebhook()');
  V('diag_q_base', 'wh_diag', { resp, props }, out(env)); }
// 顯示 TV 網址
for (const props of [{}, { WEBAPP_URL: 'https://a.b/c?x=1' }, { TRADINGVIEW_WEBHOOK_SECRET: 'a+b c' }]) {
  const env = mk(props); env.run('showTradingViewWebhookUrl()');
  V('tvurl_' + cases.length, 'wh_tvurl', { props }, out(env));
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bot_g.json'), JSON.stringify(cases));
console.log('bot_g.json', cases.length, 'vectors');
