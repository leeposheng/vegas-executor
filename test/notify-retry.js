'use strict';
/**
 * Telegram 重送。實際日誌出現過連續三則「fetch failed」，
 * 兩筆止損平倉卡片因此遺失。這裡驗證：網路層失敗會重試、
 * 明確的 4xx 不重試、429 照 retry_after 等待、全部失敗時把內容留在日誌。
 */
const assert = require('assert');
const notify = require('../src/notify');

const cfg = { token: 't', chatId: '1' };
const realFetch = global.fetch;
const realErr = console.error;
const realLog = console.log;
let n = 0;

function netError(code) {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error(code), { code });
  return e;
}
function reply(body, status) {
  return { status: status || 200, json: async () => body };
}
function script(steps) {
  let i = 0;
  global.fetch = async () => {
    const s = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (s instanceof Error) throw s;
    return s;
  };
  return () => i;
}

async function ok(name, fn) {
  const errors = [];
  console.error = (m) => errors.push(String(m));
  console.log = () => {};
  try { await fn(errors); } finally { console.error = realErr; console.log = realLog; }
  n += 1;
  console.log('  ✓ ' + name);
}

(async () => {
  console.log('notify-retry');
  const waits = [];
  const opts = { sleep: async (ms) => { waits.push(ms); }, delays: [1000, 3000] };

  await ok('網路層失敗兩次、第三次成功 → 送出', async () => {
    waits.length = 0;
    const calls = script([netError('ECONNRESET'), netError('ETIMEDOUT'), reply({ ok: true })]);
    const r = await notify.send('平倉', cfg, opts);
    assert.strictEqual(r.sent, true);
    assert.strictEqual(r.attempts, 3);
    assert.strictEqual(calls(), 3);
    assert.deepStrictEqual(waits, [1000, 3000]);
  });

  await ok('三次都失敗 → 不丟例外、日誌留下原因代碼與未送出的內容', async (errors) => {
    script([netError('ECONNRESET')]);
    const r = await notify.send('止損平倉 SUI', cfg, opts);
    assert.strictEqual(r.sent, false);
    assert.ok(/ECONNRESET/.test(r.error), r.error);
    assert.ok(errors.some((e) => e.includes('止損平倉 SUI')));
  });

  await ok('401 token 錯 → 不重試', async () => {
    const calls = script([reply({ ok: false, error_code: 401, description: 'Unauthorized' }, 401)]);
    const r = await notify.send('x', cfg, opts);
    assert.strictEqual(r.sent, false);
    assert.strictEqual(calls(), 1);
  });

  await ok('429 限流 → 依 retry_after 等待後重送', async () => {
    waits.length = 0;
    script([reply({ ok: false, error_code: 429, parameters: { retry_after: 5 } }, 429), reply({ ok: true })]);
    const r = await notify.send('x', cfg, opts);
    assert.strictEqual(r.sent, true);
    assert.deepStrictEqual(waits, [5000]);
  });

  await ok('5xx → 重試', async () => {
    const calls = script([reply({ ok: false, error_code: 502 }, 502), reply({ ok: true })]);
    const r = await notify.send('x', cfg, opts);
    assert.strictEqual(r.sent, true);
    assert.strictEqual(calls(), 2);
  });

  global.fetch = realFetch;
  console.log(`  ${n} 項通過`);
})().catch((e) => { global.fetch = realFetch; console.error(e); process.exit(1); });
