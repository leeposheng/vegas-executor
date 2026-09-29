'use strict';
/**
 * 權益來源的測試。
 *
 * 這一層的價值不在「能查到權益」—— 那只是一個 HTTP 呼叫。
 * 價值在「查不到的時候會怎樣」：會不會整個停擺、會不會用錯數字、
 * 有沒有誠實說出自己用的是哪一個。這些才是實際會發生的情況。
 */

const assert = require('assert');
const equity = require('../src/equity');

let pass = 0;
const fails = [];
const ck = async (name, fn) => {
  try { await fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
};

const NOW = Date.parse('2026-09-24T00:50:00.000Z');

function cfg(over) {
  const base = {
    primaryExchange: 'okx',
    demo: true,
    risk: { equityUsdt: 10000, equityCacheMs: 60000 },
    okx: { apiKey: 'K', apiSecret: 'S', passphrase: 'P',
      baseUrl: 'https://www.okx.com', tdMode: 'cross' },
  };
  return Object.assign(base, over || {});
}

function stubEquity(value) {
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ code: '0', data: [{
      totalEq: String(value),
      details: [{ ccy: 'USDT', eq: String(value), availEq: String(value) }],
    }] }),
  });
}

async function main() {
  const realFetch = global.fetch;

  await ck('查得到就用交易所的真值', async () => {
    equity.resetCache();
    stubEquity(8432.17);
    const r = await equity.getEquity(cfg(), { demo: true }, NOW);
    assert.strictEqual(r.equityUsdt, 8432.17);
    assert.strictEqual(r.source, 'exchange');
    assert.strictEqual(r.note, null);
  });

  await ck('交易所的值會覆蓋設定檔，即使差很多', async () => {
    // 這是這一層存在的主要理由：設定檔寫 10000、實際只有 500 時，
    // 用 10000 算出來的每一筆倉位都是 20 倍大。
    equity.resetCache();
    stubEquity(500);
    const r = await equity.getEquity(cfg(), { demo: true }, NOW);
    assert.strictEqual(r.equityUsdt, 500, '必須用真值，不能用設定檔的 10000');
  });

  await ck('快取有效期內不重複查詢', async () => {
    equity.resetCache();
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ code: '0',
        data: [{ totalEq: '7000', details: [{ ccy: 'USDT', eq: '7000' }] }] }) };
    };
    await equity.getEquity(cfg(), { demo: true }, NOW);
    const r2 = await equity.getEquity(cfg(), { demo: true }, NOW + 30000);
    assert.strictEqual(calls, 1, '30 秒內不該再查一次');
    assert.strictEqual(r2.source, 'cache');
    assert.strictEqual(r2.ageMs, 30000);
  });

  await ck('快取過期後重新查詢', async () => {
    equity.resetCache();
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ code: '0',
        data: [{ totalEq: '7000', details: [{ ccy: 'USDT', eq: '7000' }] }] }) };
    };
    await equity.getEquity(cfg(), { demo: true }, NOW);
    await equity.getEquity(cfg(), { demo: true }, NOW + 61000);
    assert.strictEqual(calls, 2);
  });

  await ck('查詢失敗時沿用快取，並說明是舊的', async () => {
    equity.resetCache();
    stubEquity(9000);
    await equity.getEquity(cfg(), { demo: true }, NOW);

    global.fetch = async () => { throw new Error('模擬斷線'); };
    const r = await equity.getEquity(cfg(), { demo: true }, NOW + 90000);
    assert.strictEqual(r.equityUsdt, 9000, '應沿用快取而非退回設定檔');
    assert.strictEqual(r.source, 'cache');
    assert.ok(r.note && r.note.includes('90 秒前'), r.note);
  });

  await ck('從沒查成功過就退回設定檔，且必須講明', async () => {
    equity.resetCache();
    global.fetch = async () => { throw new Error('模擬斷線'); };
    const r = await equity.getEquity(cfg(), { demo: true }, NOW);
    assert.strictEqual(r.equityUsdt, 10000);
    assert.strictEqual(r.source, 'config');
    assert.ok(r.note && r.note.includes('不會自己更新'),
      '退回設定檔時必須明確說出這個數字的性質：' + r.note);
  });

  await ck('查詢失敗不可讓流程中斷', async () => {
    equity.resetCache();
    global.fetch = async () => { throw new Error('模擬斷線'); };
    // 不加 try/catch —— 這一層本來就不該拋例外
    const r = await equity.getEquity(cfg(), { demo: true }, NOW);
    assert.ok(Number.isFinite(r.equityUsdt) && r.equityUsdt > 0);
  });

  await ck('沒有憑證時直接用設定檔，不嘗試連線', async () => {
    equity.resetCache();
    global.fetch = async () => { throw new Error('不該被呼叫'); };
    const c = cfg({ okx: { apiKey: '', apiSecret: '', passphrase: '' } });
    const r = await equity.getEquity(c, { demo: true }, NOW);
    assert.strictEqual(r.source, 'config');
    assert.ok(r.note && r.note.includes('未設定交易所憑證'), r.note);
  });

  await ck('明確指定 config 來源時不查詢、不囉嗦', async () => {
    equity.resetCache();
    global.fetch = async () => { throw new Error('不該被呼叫'); };
    const c = cfg();
    c.risk.equitySource = 'config';
    const r = await equity.getEquity(c, { demo: true }, NOW);
    assert.strictEqual(r.source, 'config');
    assert.strictEqual(r.note, null, '刻意選的就不需要警告');
  });

  global.fetch = realFetch;
  equity.resetCache();

  console.log(`權益來源測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
  if (fails.length) {
    console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
    process.exit(1);
  }
}

main();
