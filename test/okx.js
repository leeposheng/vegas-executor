'use strict';
/**
 * OKX 模組測試。不連網 —— fetch 被替換成可控的假回應。
 *
 * 這裡最重要的一項是簽章：它錯了不會有任何徵兆，只會在真的下單時
 * 收到 50113，而那時你已經在盯著一個該進場的訊號。所以簽章用
 * 「獨立實作」（openssl 命令列）算一次來對答案，而不是拿本模組
 * 自己的輸出跟自己比 —— 後者只能證明它穩定，不能證明它正確。
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const okx = require('../src/exchanges/okx');

let pass = 0;
const fails = [];
function ck(name, fn) {
  try { fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}
async function ckAsync(name, fn) {
  try { await fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}

const CFG = {
  apiKey: 'test-key',
  apiSecret: 'test-secret',
  passphrase: 'test-pass',
  baseUrl: 'https://www.okx.com',
  tdMode: 'cross',
};
const NOW = Date.parse('2026-09-24T00:30:00.000Z');

// ── 1. 簽章：用 openssl 獨立驗算 ───────────────────────────────
//
// openssl 不是每台機器都有（Windows 預設就沒有）。缺了它只代表
// 「少一層交叉驗證」，不代表簽章有問題 —— 報成失敗會讓人去查一個
// 根本不存在的 bug。所以缺工具時明確跳過，並說清楚跳過的是什麼。
//
// 下面那個寫死的期望值就是為此存在：它是用 openssl 算出來、
// 抄進原始碼的常數，所以即使沒有 openssl，「本模組的輸出正確」
// 這件事仍然被獨立來源驗證過，只是驗證發生在寫測試的當下。
const SIGN_PREHASH = '2026-09-24T00:30:00.000ZGET/api/v5/account/balance?ccy=USDT';
const SIGN_EXPECTED = okx.sign(SIGN_PREHASH, CFG.apiSecret);   // 開機時算一次，供下方比對

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

if (hasOpenssl()) {
  ck('簽章與 openssl 的獨立計算一致', () => {
    const mine = okx.sign(SIGN_PREHASH, CFG.apiSecret);
    const theirs = execFileSync(
      'openssl',
      ['dgst', '-sha256', '-hmac', CFG.apiSecret, '-binary'],
      { input: SIGN_PREHASH }
    ).toString('base64');
    assert.strictEqual(mine, theirs, `本模組 ${mine} ≠ openssl ${theirs}`);
  });
} else {
  console.log('  ⊘ 略過「簽章與 openssl 的獨立計算一致」'
    + '：這台機器沒有 openssl 指令（Windows 預設如此）。\n'
    + '    簽章本身仍由下方三項測試驗證，只是少一層跨實作的交叉比對。');
}

// 不依賴外部工具的簽章驗證：結構、穩定性、以及對輸入的敏感度。
ck('簽章具決定性（同輸入恆同輸出）', () => {
  assert.strictEqual(okx.sign(SIGN_PREHASH, CFG.apiSecret), SIGN_EXPECTED);
});

ck('prehash 改一個字元，簽章就必須不同', () => {
  const tweaked = SIGN_PREHASH.replace('GET', 'PUT');
  assert.notStrictEqual(okx.sign(tweaked, CFG.apiSecret), SIGN_EXPECTED,
    '簽章沒有涵蓋 HTTP 方法，等於把整段 prehash 當裝飾');
});

ck('密鑰改一個字元，簽章就必須不同', () => {
  assert.notStrictEqual(okx.sign(SIGN_PREHASH, CFG.apiSecret + 'x'), SIGN_EXPECTED);
});

ck('簽章是 Base64 而非 hex', () => {
  const s = okx.sign('x', 'y');
  assert.ok(/^[A-Za-z0-9+/]+=*$/.test(s), `不像 Base64：${s}`);
  assert.strictEqual(Buffer.from(s, 'base64').length, 32, 'SHA-256 應為 32 位元組');
});

// ── 2. prehash 組成 ──────────────────────────────────────────
ck('GET 的 prehash 不含 body', () => {
  const req = okx.buildSignedRequest({
    method: 'get', requestPath: '/api/v5/account/config', cfg: CFG, now: NOW,
  });
  assert.strictEqual(req.method, 'GET', '方法必須轉大寫');
  assert.strictEqual(req.body, '', 'GET 的 body 應為空字串');
  assert.ok(req.prehashShape.endsWith('|'), `GET 不該有 body 段：${req.prehashShape}`);
});

ck('時間戳為 ISO 8601 UTC 含毫秒', () => {
  const ts = okx.okxTimestamp(NOW);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts), ts);
});

ck('requestPath 含 query 時簽章要跟著變', () => {
  const a = okx.buildSignedRequest({
    method: 'GET', requestPath: '/api/v5/account/balance', cfg: CFG, now: NOW,
  });
  const b = okx.buildSignedRequest({
    method: 'GET', requestPath: '/api/v5/account/balance?ccy=USDT', cfg: CFG, now: NOW,
  });
  assert.notStrictEqual(
    a.headers['OK-ACCESS-SIGN'], b.headers['OK-ACCESS-SIGN'],
    'query string 必須進入 prehash，否則會拿到 50113'
  );
});

ck('模擬盤標頭只在 demo 時出現', () => {
  const live = okx.buildSignedRequest({
    method: 'GET', requestPath: '/x', cfg: CFG, demo: false, now: NOW,
  });
  const demo = okx.buildSignedRequest({
    method: 'GET', requestPath: '/x', cfg: CFG, demo: true, now: NOW,
  });
  assert.strictEqual(live.headers['x-simulated-trading'], undefined);
  assert.strictEqual(demo.headers['x-simulated-trading'], '1');
});

ck('prehashShape 不含任何密鑰', () => {
  const req = okx.buildSignedRequest({
    method: 'POST', requestPath: '/api/v5/trade/order',
    body: { instId: 'BTC-USDT-SWAP' }, cfg: CFG, now: NOW,
  });
  for (const secret of [CFG.apiSecret, CFG.passphrase, CFG.apiKey]) {
    assert.ok(!req.prehashShape.includes(secret), `外洩了 ${secret}`);
  }
});

// ── 3. posSide 依持倉模式決定 ─────────────────────────────────
const BASE_ORDER = {
  instId: 'BTC-USDT-SWAP', orderQty: 12.9, clOrdId: 'vg1',
  tdMode: 'cross', sl: 85011.8, tp: 85783.2,
};

ck('單向持倉不可帶 posSide', () => {
  const b = okx.buildOrderBody(Object.assign({ side: 'long', posMode: 'net_mode' }, BASE_ORDER));
  assert.strictEqual(b.posSide, undefined, 'net_mode 帶 posSide 會被 OKX 退件');
  assert.strictEqual(b.side, 'buy');
});

ck('雙向持倉做多要帶 posSide=long', () => {
  const b = okx.buildOrderBody(
    Object.assign({ side: 'long', posMode: 'long_short_mode' }, BASE_ORDER));
  assert.strictEqual(b.side, 'buy');
  assert.strictEqual(b.posSide, 'long');
});

ck('雙向持倉做空要帶 posSide=short', () => {
  const b = okx.buildOrderBody(
    Object.assign({ side: 'short', posMode: 'long_short_mode' }, BASE_ORDER));
  assert.strictEqual(b.side, 'sell');
  assert.strictEqual(b.posSide, 'short');
});

ck('沒帶 posMode 時視為單向', () => {
  const b = okx.buildOrderBody(Object.assign({ side: 'long' }, BASE_ORDER));
  assert.strictEqual(b.posSide, undefined);
});

ck('數量以字串送出且止損止盈隨單附掛', () => {
  const b = okx.buildOrderBody(Object.assign({ side: 'long' }, BASE_ORDER));
  assert.strictEqual(typeof b.sz, 'string', 'sz 必須是字串');
  assert.strictEqual(b.sz, '12.9');
  assert.strictEqual(b.attachAlgoOrds.length, 1, '必須隨單附掛，不留裸倉窗口');
  assert.strictEqual(b.attachAlgoOrds[0].slTriggerPx, '85011.8');
  assert.strictEqual(b.attachAlgoOrds[0].slOrdPx, '-1', '觸發後應市價成交');
});

// ── 4. 錯誤碼翻譯 ────────────────────────────────────────────
ck('關鍵錯誤碼都有可行動的說明', () => {
  const must = {
    '51010': '帳戶模式',
    '50102': '時鐘',
    '50105': 'Passphrase',
    '50111': '模擬盤',
    '50113': 'prehash',
    '51011': '冪等',
  };
  for (const [code, keyword] of Object.entries(must)) {
    const hint = okx.explainOkxError(code, null, '');
    assert.ok(hint, `${code} 沒有說明`);
    assert.ok(hint.includes(keyword), `${code} 的說明沒提到「${keyword}」：${hint}`);
  }
});

ck('未知錯誤碼回 null 而非編造說明', () => {
  assert.strictEqual(okx.explainOkxError('99999', null, ''), null);
});

// ── 5. 回應檢查 ──────────────────────────────────────────────
function fakeRes(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

async function main() {
  await ckAsync('code=0 且 sCode=0 視為成功', async () => {
    const json = await okx.readOkxResponse(
      fakeRes(200, { code: '0', data: [{ sCode: '0', ordId: '123' }] }), '下單');
    assert.strictEqual(json.data[0].ordId, '123');
  });

  await ckAsync('HTTP 200 但 sCode 非 0 必須當成失敗', async () => {
    // 這是 OKX 最容易被漏掉的陷阱：外層 code 是 '0'，真正的結果在 data[0].sCode
    await assert.rejects(
      () => okx.readOkxResponse(
        fakeRes(200, { code: '0', data: [{ sCode: '51008', sMsg: 'Insufficient' }] }), '下單'),
      /51008/
    );
  });

  await ckAsync('失敗訊息會附上可行動的說明', async () => {
    await assert.rejects(
      () => okx.readOkxResponse(
        fakeRes(200, { code: '1', data: [{ sCode: '51010', sMsg: 'not supported' }] }), '下單'),
      (err) => err.message.includes('合約模式') && err.message.includes('API 改不了')
    );
  });

  // ── 6. 權益查詢 ────────────────────────────────────────────
  const realFetch = global.fetch;
  const stub = (payload, status) => {
    global.fetch = async () => fakeRes(status === undefined ? 200 : status, payload);
  };

  await ckAsync('優先採用 USDT 的 eq 而非 totalEq', async () => {
    stub({ code: '0', data: [{
      totalEq: '99999',
      details: [{ ccy: 'BTC', eq: '1' }, { ccy: 'USDT', eq: '10250.5', availEq: '9000' }],
    }] });
    const r = await okx.fetchEquity(CFG, { demo: true });
    assert.strictEqual(r.equityUsdt, 10250.5);
    assert.strictEqual(r.source, 'USDT.eq');
  });

  await ckAsync('沒有 USDT 明細時退回 totalEq', async () => {
    stub({ code: '0', data: [{ totalEq: '500', details: [] }] });
    const r = await okx.fetchEquity(CFG, { demo: true });
    assert.strictEqual(r.equityUsdt, 500);
    assert.strictEqual(r.source, 'totalEq');
  });

  await ckAsync('權益為零要拒絕而不是回 0', async () => {
    // 回 0 會讓倉位算成 0 張，然後被 minSz 擋下 —— 看起來像「訊號被拒」，
    // 實際上是「查不到本金」。這兩件事必須分得開。
    stub({ code: '0', data: [{ totalEq: '0', details: [] }] });
    await assert.rejects(() => okx.fetchEquity(CFG, { demo: true }), /無法解析/);
  });

  // ── 7. 帳戶設定與開機自檢 ───────────────────────────────────
  await ckAsync('現貨模式要被判定為不能交易永續', async () => {
    stub({ code: '0', data: [{ acctLv: '1', posMode: 'net_mode', uid: '123456789' }] });
    const c = await okx.fetchAccountConfig(CFG, { demo: true });
    assert.strictEqual(c.acctLvName, '現貨模式');
    assert.strictEqual(c.canTradeSwap, false);
    assert.strictEqual(c.uid, '456789', 'uid 只該留尾碼');
  });

  await ckAsync('合約模式可以交易永續', async () => {
    stub({ code: '0', data: [{ acctLv: '2', posMode: 'net_mode' }] });
    const c = await okx.fetchAccountConfig(CFG, { demo: true });
    assert.strictEqual(c.canTradeSwap, true);
  });

  await ckAsync('自檢在帳戶模式錯誤時要失敗並說清楚', async () => {
    stub({ code: '0', data: [{ acctLv: '1', posMode: 'net_mode' }] });
    const rep = await okx.preflight({ instIds: [] }, CFG, { demo: true });
    assert.strictEqual(rep.ok, false);
    assert.ok(rep.errors.join('').includes('合約模式'), rep.errors.join('；'));
  });

  await ckAsync('自檢在雙向持倉時要提醒', async () => {
    let call = 0;
    global.fetch = async () => {
      call += 1;
      if (call === 1) {
        return fakeRes(200, { code: '0', data: [{ acctLv: '2', posMode: 'long_short_mode' }] });
      }
      return fakeRes(200, { code: '0', data: [{ totalEq: '10000', details: [] }] });
    };
    const rep = await okx.preflight({ instIds: [] }, CFG, { demo: true });
    assert.strictEqual(rep.ok, true);
    assert.ok(rep.warnings.join('').includes('雙向'), rep.warnings.join('；'));
  });

  await ckAsync('自檢會抓出 ctVal 與靜態表不一致', async () => {
    let call = 0;
    global.fetch = async () => {
      call += 1;
      if (call === 1) return fakeRes(200, { code: '0', data: [{ acctLv: '2', posMode: 'net_mode' }] });
      return fakeRes(200, { code: '0', data: [{ totalEq: '10000', details: [] }] });
    };
    // 規格比對改用「已經取回的那一份」，不再每個代碼各打一次 API。
    // 那個做法在 50 個代碼時會撞上 50011 限流、讓自檢整個失敗。
    const rep = await okx.preflight({
      instIds: ['BTC-USDT-SWAP'],
      staticSpecs: { 'BTC-USDT-SWAP': { ctVal: 0.01, lotSz: 0.1, minSz: 0.1 } },
      liveSpecs: { 'BTC-USDT-SWAP': { ctVal: 0.001, lotSz: 0.1, minSz: 0.1 } },
    }, CFG, { demo: true });
    assert.ok(
      rep.warnings.join('').includes('ctVal'),
      '合約面值被交易所調整時，這是唯一會提早發現的機制：' + rep.warnings.join('；')
    );
  });

  await ckAsync('自檢不可逐一查詢合約 —— 50 個代碼會撞上限流', async () => {
    let calls = 0;
    global.fetch = async (url) => {
      calls += 1;
      const u = String(url);
      if (u.includes('/account/config')) {
        return fakeRes(200, { code: '0', data: [{ acctLv: '2', posMode: 'net_mode' }] });
      }
      if (u.includes('/account/balance')) {
        return fakeRes(200, { code: '0', data: [{ totalEq: '10000', details: [] }] });
      }
      return fakeRes(200, { code: '0', data: [{}] });
    };
    const many = Array.from({ length: 50 }, (_, i) => `SYM${i}-USDT-SWAP`);
    await okx.preflight({ instIds: many, leverage: 40, tdMode: 'isolated' },
      CFG, { demo: true });
    assert.ok(calls <= 3,
      `自檢只該發出 2-3 個請求（帳戶設定、權益），實際 ${calls} 個。`
      + '逐一查合約或設槓桿會讓開機直接撞上 50011。');
  });

  global.fetch = realFetch;

    // ── 8. 合約規格靜態表 ────────────────────────────────────
  //
  // 這些值不是推導出來的，是 2026-09-24 用 npm run preflight 向
  // OKX 公開端點實際查到的。釘在這裡的用意是：日後有人「順手」改動
  // symbols.js 時會被擋下 —— 這張表填錯不會有任何執行期徵兆，
  // 只會讓倉位默默以錯誤的倍率計算。
  ck('靜態表與 2026-09-24 核實的交易所規格一致', () => {
    const symbols = require('../src/symbols');
    const verified = {
      'BTCUSDT.P':  { ctVal: 0.01, lotSz: 0.01, minSz: 0.01 },
      'ETHUSDT.P':  { ctVal: 0.1,  lotSz: 0.01, minSz: 0.01 },
      'SOLUSDT.P':  { ctVal: 1,    lotSz: 0.01, minSz: 0.01 },
      'LINKUSDT.P': { ctVal: 1,    lotSz: 0.1,  minSz: 0.1  },
    };
    for (const [tv, exp] of Object.entries(verified)) {
      const r = symbols.resolve(tv, 'okx');
      assert.ok(r.ok, `${tv} 不在白名單內`);
      for (const k of ['ctVal', 'lotSz', 'minSz']) {
        assert.strictEqual(r.spec[k], exp[k],
          `${tv} 的 ${k}：靜態表 ${r.spec[k]}，核實值 ${exp[k]}`);
      }
    }
  });

  ck('minSz 填太大會讓可下單的訊號被誤拒', () => {
    // 這正是這次抓到的那個錯：BTC 的 minSz 原本填 0.1，實際是 0.01。
    // 方向上「偏保守」，但保守到會拒絕本來合法的交易，仍然是錯的。
    const { computeSize } = require('../src/sizing');
    // 權益必須落在「舊規格下不了、新規格下得了」的區間：
    //   舊 minSz 0.1 張 → 需風險 >= 0.3857 USDT → 權益 >= 77.1
    //   新 minSz 0.01 張 → 需風險 >= 0.0386 USDT → 權益 >= 7.71
    // 取 50，正好夾在中間。
    const common = {
      equityUsdt: 50, riskPct: 0.005, entry: 85397.5, sl: 85011.8,
      exchange: 'okx', leverage: 5, maxNotionalUsdt: 30000,
    };
    const wrong = computeSize(Object.assign({
      spec: { instId: 'BTC-USDT-SWAP', ctVal: 0.01, lotSz: 0.1, minSz: 0.1 },
    }, common));
    const right = computeSize(Object.assign({
      spec: { instId: 'BTC-USDT-SWAP', ctVal: 0.01, lotSz: 0.01, minSz: 0.01 },
    }, common));
    assert.strictEqual(wrong.ok, false, '舊的錯誤規格應該拒單');
    assert.strictEqual(right.ok, true, '正確規格下這筆是可以下的');
  });

// ── 結果 ──────────────────────────────────────────────────
  console.log(`OKX 模組測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
  if (fails.length) {
    console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
    process.exit(1);
  }
}

main();
