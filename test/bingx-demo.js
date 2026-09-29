'use strict';
/**
 * BingX 模擬盤（VST）與槓桿設定的測試。
 *
 * 這組守的核心是一個沉默到無法察覺的失誤：
 * DEMO_MODE=true 配上真實盤網域，會讓 OKX 走模擬、BingX 走真錢。
 * 卡片上兩邊都顯示「已下單」，而你要到看帳戶餘額才發現其中一邊動了真錢。
 */

const assert = require('assert');
const bingx = require('../src/exchanges/bingx.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

const BASE_ENV = {
  EXCHANGES: 'okx,bingx',
  DRY_RUN: 'true',
  TG_TOKEN: 'x',
  TG_CHAT_ID: '1',
  EXECUTOR_WEBHOOK_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  EXECUTOR_CONTROL_SECRET: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  BINGX_API_KEY: 'k',
  BINGX_API_SECRET: 's',
};

function loadConfig(env) {
  for (const k of ['DEMO_MODE', 'BINGX_BASE_URL']) delete process.env[k];
  Object.assign(process.env, BASE_ENV, env);
  delete require.cache[require.resolve('../src/config.js')];
  return require('../src/config.js');
}

console.log('\nVST 網域的自動選擇');

t('DEMO_MODE=true 自動選 VST 網域', () => {
  const { config } = loadConfig({ DEMO_MODE: 'true' });
  assert.ok(/open-api-vst/.test(config.bingx.baseUrl), config.bingx.baseUrl);
});

t('DEMO_MODE=false 自動選真實盤網域', () => {
  const { config } = loadConfig({ DEMO_MODE: 'false' });
  assert.strictEqual(config.bingx.baseUrl, 'https://open-api.bingx.com');
});

t('明確指定的網域會被尊重', () => {
  const { config } = loadConfig({
    DEMO_MODE: 'false', BINGX_BASE_URL: 'https://proxy.example.com',
  });
  assert.strictEqual(config.bingx.baseUrl, 'https://proxy.example.com');
});

console.log('\n模擬／真實不可混跑');

t('DEMO=true 配真實盤網域 → 拒絕啟動', () => {
  const m = loadConfig({
    DEMO_MODE: 'true', BINGX_BASE_URL: 'https://open-api.bingx.com',
  });
  assert.throws(() => m.validate(), /指向真實盤/);
});

t('DEMO=false 配 VST 網域 → 拒絕啟動', () => {
  const m = loadConfig({
    DEMO_MODE: 'false', BINGX_BASE_URL: 'https://open-api-vst.bingx.com',
  });
  assert.throws(() => m.validate(), /指向 VST/);
});

t('兩邊一致時正常啟動', () => {
  const m = loadConfig({ DEMO_MODE: 'true' });
  m.validate();   // 不該拋
});

t('沒啟用 bingx 時不檢查網域', () => {
  const m = loadConfig({
    EXCHANGES: 'okx', DEMO_MODE: 'true',
    BINGX_BASE_URL: 'https://open-api.bingx.com',
  });
  m.validate();   // 不該拋
  Object.assign(process.env, { EXCHANGES: 'okx,bingx' });
});

console.log('\n槓桿設定');

t('setLeverage 在 dryRun 下只組請求、不送出', async () => {
  const cfg = { apiKey: 'k', apiSecret: 's', baseUrl: 'https://open-api-vst.bingx.com' };
  const r = await bingx.setLeverage(
    { symbol: 'BTC-USDT', leverage: 10, side: 'LONG' }, cfg, { dryRun: true });
  assert.strictEqual(r.sent, false);
  assert.ok(r.request.url.indexOf('leverage=10') !== -1, r.request.url);
  assert.ok(r.request.url.indexOf('side=LONG') !== -1);
  // 簽章一定要有，否則上真錢時才會發現組錯
  assert.ok(r.request.url.indexOf('signature=') !== -1);
});

t('請求打到設定的網域（VST 不會跑到真實盤）', async () => {
  const cfg = { apiKey: 'k', apiSecret: 's', baseUrl: 'https://open-api-vst.bingx.com' };
  const r = await bingx.setLeverage(
    { symbol: 'BTC-USDT', leverage: 10, side: 'LONG' }, cfg, { dryRun: true });
  assert.ok(r.request.url.indexOf('open-api-vst.bingx.com') === 8,
    '網域錯了：' + r.request.url.slice(0, 40));
});

t('ensureLeverage 多空各設一次', async () => {
  bingx.resetLeverageCache();
  const seen = [];
  const cfg = { apiKey: 'k', apiSecret: 's', baseUrl: 'https://open-api-vst.bingx.com' };
  // dryRun 下不會真的送，改用快取行為驗證「只設一次」
  const r1 = await bingx.ensureLeverage({ symbol: 'BTC-USDT', leverage: 10 },
    cfg, { dryRun: true });
  assert.strictEqual(r1.sides, 2, '應多空各設一次');
  const r2 = await bingx.ensureLeverage({ symbol: 'BTC-USDT', leverage: 10 },
    cfg, { dryRun: true });
  assert.strictEqual(r2.cached, true, '同一組不該重設');
  const r3 = await bingx.ensureLeverage({ symbol: 'BTC-USDT', leverage: 20 },
    cfg, { dryRun: true });
  assert.strictEqual(r3.set, true, '換了槓桿就要重設');
  void seen;
});

t('沒給槓桿就跳過，不要靜默送出錯的值', async () => {
  bingx.resetLeverageCache();
  const cfg = { apiKey: 'k', apiSecret: 's', baseUrl: 'https://open-api-vst.bingx.com' };
  const r = await bingx.ensureLeverage({ symbol: 'BTC-USDT' }, cfg, { dryRun: true });
  assert.ok(r.skipped);
});

console.log('\n真錢仍然封鎖');

t('BingX 真錢交易仍被擋下，且理由已更新', () => {
  const m = loadConfig({ DEMO_MODE: 'false', DRY_RUN: 'false' });
  assert.throws(() => m.validate(), /BingX 尚未支援真實資金交易/);
  try { m.validate(); } catch (e) {
    assert.ok(e.message.indexOf('開機自檢與槓桿設定已完成') !== -1,
      '理由應反映 §6.1 已完成');
    assert.ok(e.message.indexOf('allFillOrders') !== -1,
      '應說明剩下的那一件與解法');
  }
});

setTimeout(() => {
  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 通過，' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
}, 50);
