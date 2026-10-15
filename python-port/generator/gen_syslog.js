'use strict';
// 模組 F 黃金向量：logEvent_ 寫進系統日誌佇列的欄位（來源判定、耗時分離、佇列上限）。
// 用法：node gen_syslog.js <Code.gs> <Executor.gs> <輸出資料夾>
const fs = require('fs'), path = require('path');
const { makeEnv, J } = require('./gas_env.js');
const SRC = fs.readFileSync(path.resolve(process.argv[2]), 'utf8') + '\n' + fs.readFileSync(path.resolve(process.argv[3]), 'utf8');
const OUT = path.resolve(process.argv[4]);
function run(c) {
  const env = makeEnv(SRC, { props: {}, cache: c.queued === undefined ? {} : { 'syslog:queued': [String(c.queued), 1e18] } });
  env.ctx.__a = J(c);
  env.run('logEvent_(__a.level, __a.event, __a.hasDetails === false ? undefined : __a.details)');
  const keys = Object.keys(env.props).filter((k) => k.indexOf('SYSLOG_') === 0);
  if (!keys.length) return { queued: false };
  const rec = JSON.parse(env.props[keys[0]]);
  return { queued: true, source: rec.source, level: rec.level, event: rec.event, details: JSON.parse(rec.details), elapsedMs: rec.elapsedMs };
}
const cases = [];
const add = (id, level, event, details, extra) => cases.push(Object.assign({ id, level, event, details }, extra || {}));
add('src_given', 'info', 'x_event', { source: 'executor', a: 1 });
add('src_tv', 'info', 'tradingview_signal_sent', { a: 1 });
add('src_tg', 'warn', 'telegram_api_failed', {});
add('src_claude', 'error', 'claude_failed', { message: 'm' });
add('src_service', 'info', 'plain', { service: 'okx' });
add('src_none', 'info', 'plain', { a: [1, 2] });
add('src_tv_over_service', 'info', 'tradingview_x', { service: 'okx' });
add('src_tg_before_claude', 'info', 'telegram_claude', {});
add('src_given_empty', 'info', 'telegram_x', { source: '' });
add('src_given_num', 'info', 'e', { source: 5 });
add('elapsed', 'info', 'e', { elapsedMs: 123, a: 1 });
add('elapsed_zero', 'info', 'e', { elapsedMs: 0 });
add('elapsed_str', 'info', 'e', { elapsedMs: '12' });
add('elapsed_float', 'info', 'e', { elapsedMs: 1.5 });
add('nodetails', 'info', 'e', undefined, { hasDetails: false });
add('nested', 'info', 'e', { a: { b: [1, { c: null }] } });
add('queue_full', 'info', 'e', { a: 1 }, { queued: 200 });
add('queue_199', 'info', 'e', { a: 1 }, { queued: 199 });
add('queue_201', 'info', 'e', { a: 1 }, { queued: 201 });
const vectors = cases.map((c) => ({ id: 'syslog_' + c.id, fn: 'syslog', input: c, expected: run(c) }));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bot_f.json'), JSON.stringify(vectors));
console.log('bot_f.json', vectors.length, 'vectors');
