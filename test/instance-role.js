'use strict';
/**
 * 實盤與模擬服務並行的兩道保護：
 *   1. 狀態檔綁定資金模式 —— 模擬盤的狀態檔不能被實盤服務讀進去
 *   2. INSTANCE_ROLE=shadow 只准跑模擬盤
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { Store } = require('../src/store');

let n = 0;
const queue = [];
// 依序執行（含非同步項目），全部跑完才印總數；任何一項失敗就以非零結束
function ok(name, fn) { queue.push([name, fn]); }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vegas-role-'));

console.log('instance-role');

ok('全新目錄：實盤標記為 live', () => {
  const s = new Store(tmp());
  const r = s.bindMode('live');
  assert.ok(r.ok && r.stamped);
  assert.strictEqual(s.getMode(), 'live');
});

ok('標記會寫進檔案，重開後仍在', () => {
  const dir = tmp();
  new Store(dir).bindMode('demo');
  assert.strictEqual(new Store(dir).getMode(), 'demo');
});

ok('模擬盤狀態檔被實盤讀到 → 拒絕', () => {
  const dir = tmp();
  new Store(dir).bindMode('demo');
  const r = new Store(dir).bindMode('live');
  assert.strictEqual(r.ok, false);
  assert.ok(/DATA_DIR/.test(r.error));
});

ok('實盤狀態檔被模擬盤讀到 → 也拒絕', () => {
  const dir = tmp();
  new Store(dir).bindMode('live');
  assert.strictEqual(new Store(dir).bindMode('demo').ok, false);
});

ok('沒有標記的舊檔有資料：實盤拒絕、模擬盤直接標記', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    daily: { '2026-10-04': { realisedPnlUsdt: -109, orders: 3 } },
  }));
  assert.strictEqual(new Store(dir).bindMode('live').ok, false);
  const s = new Store(dir);
  assert.ok(s.bindMode('demo').ok);
  assert.strictEqual(s.getMode(), 'demo');
});

ok('主服務與模擬服務指到同一個目錄 → 拒絕', () => {
  const dir = tmp();
  new Store(dir).bindMode('demo', 'live');
  const r = new Store(dir).bindMode('demo', 'shadow');
  assert.strictEqual(r.ok, false);
  assert.ok(/不同的 DATA_DIR/.test(r.error));
});

ok('舊檔只有 overrides（例如持倉上限）也算有資料：實盤不接手', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ overrides: { maxConcurrent: 5 } }));
  assert.strictEqual(new Store(dir).bindMode('live').ok, false);
});

ok('狀態檔損壞：實盤不接手（讀不出模式標記）', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{ broken');
  const origErr = console.error; console.error = () => {};
  const s = new Store(dir);
  console.error = origErr;
  const r = s.bindMode('live');
  assert.strictEqual(r.ok, false);
  assert.ok(/損壞/.test(r.error));
});

ok('沒有標記的舊檔是空的：實盤可以接手', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ halted: false }));
  assert.ok(new Store(dir).bindMode('live').ok);
});

function boot(env) {
  const base = {
    PATH: process.env.PATH,
    EXECUTOR_WEBHOOK_SECRET: 'a'.repeat(32),
    EXECUTOR_CONTROL_SECRET: 'b'.repeat(32),
    DRY_RUN: 'true',
  };
  try {
    execFileSync(process.execPath, ['-e',
      "const c=require('./src/config');c.validate(c.config);"
      + "process.stdout.write(JSON.stringify({role:c.config.instanceRole,label:c.config.telegram.label}))"],
    { cwd: path.join(__dirname, '..'), env: Object.assign(base, env), stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: String(e.stderr) };
  }
}

ok('shadow ＋ DEMO_MODE=false → 拒絕啟動', () => {
  const r = boot({ INSTANCE_ROLE: 'shadow', DEMO_MODE: 'false' });
  assert.strictEqual(r.ok, false);
  assert.ok(/INSTANCE_ROLE=shadow/.test(r.msg), r.msg);
});

ok('shadow ＋ DEMO_MODE=true → 可啟動', () => {
  assert.ok(boot({ INSTANCE_ROLE: 'shadow', DEMO_MODE: 'true', EXECUTION_MODE: 'auto' }).ok);
});

ok('INSTANCE_ROLE 打錯字 → 拒絕啟動', () => {
  assert.strictEqual(boot({ INSTANCE_ROLE: 'shadwo' }).ok, false);
});

ok('沒設 INSTANCE_ROLE → live（既有服務行為不變）', () => {
  assert.ok(boot({}).ok);
});

ok('模擬服務的推播加抬頭', async () => {
  const realFetch = global.fetch;
  let sentText = '';
  global.fetch = async (url, opts) => {
    sentText = JSON.parse(opts.body).text;
    return { status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await require('../src/notify').send('平倉', { token: 't', chatId: '1', label: '🧪 模擬服務' });
  } finally {
    global.fetch = realFetch;
  }
  assert.strictEqual(sentText, '🧪 模擬服務\n平倉');
});

ok('轉給模擬服務的訊號（target:shadow）送到實盤服務 → 409 拒收', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const env = {
    PATH: process.env.PATH, DRY_RUN: 'true', DEMO_MODE: 'false', INSTANCE_ROLE: 'live',
    PORT: String(port), DATA_DIR: tmp(),
    EXECUTOR_WEBHOOK_SECRET: 'a'.repeat(32), EXECUTOR_CONTROL_SECRET: 'b'.repeat(32),
  };
  const child = spawn(process.execPath, ['src/index.js'],
    { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      up = await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false);
    }
    assert.ok(up, '服務沒有起來');
    const res = await fetch(`http://127.0.0.1:${port}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Executor-Key': 'a'.repeat(32) },
      body: JSON.stringify({ target: 'shadow', sig_id: 'x' }),
    });
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.strictEqual(body.error, 'target_mismatch');
  } finally {
    child.kill('SIGTERM');
  }
});

(async () => {
  for (const [name, fn] of queue) {
    await fn();
    n += 1;
    console.log('  ✓ ' + name);
  }
  console.log(`  ${n} 項通過`);
})().catch((e) => { console.error(e); process.exit(1); });
