'use strict';
/**
 * 對本機執行服務送一筆範例訊號，用來驗證端到端串接。
 *
 * 用法：
 *   node tools/send-sample.js                      預設高品質做多
 *   node tools/send-sample.js short                做空
 *   node tools/send-sample.js weak                 弱訊號（應被 MIN_GRADE 擋下）
 *   node tools/send-sample.js bad                  方向寫反（應被解析擋下）
 *   node tools/send-sample.js stale                過期訊號（應被重放保護擋下）
 *   node tools/send-sample.js dup                  連送兩次（第二次應被冪等擋下）
 */

const { config, loadDotEnv } = require('../src/config');

const entry = 85397.5;
const R = 385.7;

const VARIANTS = {
  long: () => ({
    side: 'long', grade: 3, score: 85, entry, sl: entry - R,
    tp: [entry + R, entry + 2 * R, entry + 3 * R], ts: Date.now(),
  }),
  short: () => ({
    side: 'short', grade: 3, score: 82, entry, sl: entry + R,
    tp: [entry - R, entry - 2 * R, entry - 3 * R], ts: Date.now(),
  }),
  weak: () => Object.assign(VARIANTS.long(), { grade: 1, score: 38 }),
  bad: () => Object.assign(VARIANTS.long(), { sl: entry + R }),   // 做多卻把 SL 放上方
  stale: () => Object.assign(VARIANTS.long(), { ts: Date.now() - 300000 }),
};

function build(kind) {
  const v = (VARIANTS[kind] || VARIANTS.long)();
  return Object.assign({
    v: '11.8',
    sig_id: `BTCUSDT.P-60-${v.ts}-${v.side}`,
    symbol: 'BTCUSDT.P',
    tf: '60',
  }, v);
}

async function post(payload) {
  const res = await fetch(`http://127.0.0.1:${config.port}/signal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Executor-Key': config.webhookSecret,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  console.log(`HTTP ${res.status} → ` + JSON.stringify(json, null, 2));
  return json;
}

(async () => {
  loadDotEnv(require('path').join(__dirname, '..', '.env'));
  const kind = (process.argv[2] || 'long').toLowerCase();

  if (kind === 'dup') {
    const payload = build('long');
    console.log('第 1 次：');
    await post(payload);
    console.log('\n第 2 次（相同 sig_id，應被冪等擋下）：');
    await post(payload);
    return;
  }

  const payload = build(kind);
  console.log('送出訊號：\n' + JSON.stringify(payload, null, 2) + '\n');
  await post(payload);
})().catch((err) => {
  console.error('失敗：' + err.message);
  console.error('請確認服務已啟動（npm start），且 .env 的 EXECUTOR_WEBHOOK_SECRET 正確。');
  process.exit(1);
});
