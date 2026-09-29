'use strict';
/**
 * 設定解析的測試。
 *
 * 這一組的動機很具體：原本的解析方式會讓「打錯字」變成
 * 「安靜地往危險那側傾斜」，而且開機完全不報錯。
 *
 *   DEMO_MODE=1        → 落到 false → 打真錢帳戶
 *   DAILY_LOSS_LIMIT_USDT=50 USDT → NaN → 日損閘門永遠放行
 *
 * 兩者的共通點是：錯得無聲無息，而且錯的方向永遠是往風險那邊。
 * 所以測試要測的不是「正確的值會不會被解析」，
 * 而是「錯誤的值會不會大聲爆掉」。
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const fails = [];
function ck(name, fn) {
  try { fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}

const BASE = {
  OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p',
  EXECUTOR_WEBHOOK_SECRET: 'a'.repeat(24),
  EXECUTOR_CONTROL_SECRET: 'b'.repeat(24),
};

/** 在子行程裡載入 config，回傳 {ok, config} 或 {ok:false, stderr}。 */
function loadConfig(env) {
  const script = `
    const { config, validate } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'config'))});
    validate();
    process.stdout.write(JSON.stringify({ demo: config.demo, dryRun: config.dryRun,
      dailyLossLimitUsdt: config.risk.dailyLossLimitUsdt,
      maxSignalAgeSec: config.risk.maxSignalAgeSec }));
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: Object.assign({}, process.env, BASE, env, { DOTENV_DISABLE: '1' }),
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, config: JSON.parse(out) };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr || err.message) };
  }
}

// ── 布林值：往危險方向倒是最糟的失敗模式 ──────────────────
ck('DEMO_MODE=1 必須是模擬盤，不可落到實盤', () => {
  const r = loadConfig({ DEMO_MODE: '1' });
  assert.ok(r.ok, r.stderr);
  assert.strictEqual(r.config.demo, true);
});

ck('DEMO_MODE 前後有空白仍然有效（環境變數貼上時很常見）', () => {
  const r = loadConfig({ DEMO_MODE: ' true ' });
  assert.ok(r.ok, r.stderr);
  assert.strictEqual(r.config.demo, true);
});

ck('yes / on 也視為開啟', () => {
  for (const v of ['yes', 'on', 'TRUE', 'True']) {
    const r = loadConfig({ DEMO_MODE: v });
    assert.ok(r.ok && r.config.demo === true, `DEMO_MODE=${v} 應為 true`);
  }
});

ck('0 / no / off 視為關閉', () => {
  for (const v of ['0', 'no', 'off', 'false']) {
    const r = loadConfig({ DEMO_MODE: v });
    assert.ok(r.ok && r.config.demo === false, `DEMO_MODE=${v} 應為 false`);
  }
});

ck('看不懂的布林值必須拒絕啟動，不可預設成實盤', () => {
  const r = loadConfig({ DEMO_MODE: 'maybe' });
  assert.strictEqual(r.ok, false, '應該拒絕啟動');
  assert.ok(r.stderr.includes('DEMO_MODE'), '錯誤訊息要指出是哪一項：' + r.stderr);
});

// ── 數值：NaN 會讓閘門永遠放行 ────────────────────────────
ck('帶單位的數字必須拒絕啟動', () => {
  const r = loadConfig({ DAILY_LOSS_LIMIT_USDT: '50 USDT' });
  assert.strictEqual(r.ok, false, 'NaN 會讓日損閘門永遠放行，必須擋下');
  assert.ok(r.stderr.includes('DAILY_LOSS_LIMIT_USDT'), r.stderr);
});

ck('中文數字必須拒絕啟動', () => {
  const r = loadConfig({ MAX_SIGNAL_AGE_SEC: '六十' });
  assert.strictEqual(r.ok, false, 'NaN 會讓重放保護永遠放行');
  assert.ok(r.stderr.includes('MAX_SIGNAL_AGE_SEC'), r.stderr);
});

ck('空字串退回預設值，不視為錯誤', () => {
  const r = loadConfig({ DAILY_LOSS_LIMIT_USDT: '' });
  assert.ok(r.ok, r.stderr);
  assert.strictEqual(r.config.dailyLossLimitUsdt, 50);
});

ck('正常數字照常解析', () => {
  const r = loadConfig({ DAILY_LOSS_LIMIT_USDT: '120' });
  assert.ok(r.ok, r.stderr);
  assert.strictEqual(r.config.dailyLossLimitUsdt, 120);
});

console.log(`設定解析測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
if (fails.length) {
  console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
