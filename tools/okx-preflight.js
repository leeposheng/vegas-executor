'use strict';
/**
 * OKX 開機自檢。用法：npm run preflight
 *
 * 在送出任何委託之前，把「會讓下單失敗的設定」一次查清楚：
 *   1. 三組憑證（Key / Secret / Passphrase）是否都對
 *   2. 帳戶模式是否支援永續合約   ← 最常見的卡關點，API 改不了
 *   3. 持倉模式（決定下單要不要帶 posSide）
 *   4. 實際權益是多少            ← 取代 .env 裡手填的數字
 *   5. 合約規格是否與 symbols.js 的靜態表一致
 *
 * 這支程式「只讀不寫」，唯一的例外是設定槓桿（那是下單前的必要準備，
 * 且不會產生部位）。它不會下任何單。
 */

const { config } = require('../src/config');
const okx = require('../src/exchanges/okx');
const symbols = require('../src/symbols');

const LINE = '─'.repeat(56);

function collectStaticSpecs() {
  const out = {};
  for (const tv of symbols.listSupported()) {
    const r = symbols.resolve(tv, 'okx');
    if (r.ok) out[r.spec.instId] = r.spec;
  }
  return out;
}

async function main() {
  if (config.primaryExchange !== 'okx') {
    console.log(`PRIMARY_EXCHANGE 目前是 ${config.primaryExchange}，這支自檢只檢查 OKX。`);
  }
  if (!config.okx.apiKey || !config.okx.apiSecret || !config.okx.passphrase) {
    console.error(
      '缺少 OKX 憑證。請先在環境變數（或 .env）填入：\n'
      + '  OKX_API_KEY / OKX_API_SECRET / OKX_PASSPHRASE\n\n'
      + '提醒：模擬盤與實盤的金鑰完全不通用。DEMO_MODE=true 時必須用\n'
      + '「模擬交易 → 個人中心 → 模擬盤 API」建立的那一組。'
    );
    process.exit(1);
  }

  const flags = { demo: config.demo, dryRun: config.dryRun };
  const staticSpecs = collectStaticSpecs();

  console.log(LINE);
  console.log('OKX 開機自檢');
  console.log('  端點      : ' + config.okx.baseUrl);
  console.log('  模式      : ' + (flags.demo ? '模擬盤（x-simulated-trading: 1）' : '⚠️ 實盤'));
  console.log('  保證金模式: ' + config.okx.tdMode);
  console.log('  槓桿      : ' + config.risk.leverage + 'x');
  console.log(LINE);

  let report;
  try {
    // 這支是刻意執行的完整核對，所以打得比開機自檢多：
    // 用一次公開端點取回全部合約規格拿來比對，並實際驗證槓桿設得起來。
    // 開機自檢只做帳戶設定與權益兩件事，不走這條路（會撞上限流）。
    const instruments = require('../src/instruments');
    let liveSpecs = {};
    try {
      liveSpecs = await instruments.fetchAll(config.okx.baseUrl);
      console.log('  已取回 ' + Object.keys(liveSpecs).length + ' 個合約規格');
    } catch (err) {
      console.warn('  ⚠️ 合約規格查詢失敗：' + err.message + '（略過規格比對）');
    }
    report = await okx.preflight({
      instIds: Object.keys(staticSpecs),
      leverage: config.risk.leverage,
      tdMode: config.okx.tdMode,
      staticSpecs,
      liveSpecs,
      verifyLeverage: true,
    }, config.okx, flags);
  } catch (err) {
    // 走到這裡代表連第一個端點都沒查成。分成兩類，處置完全不同：
    // 「連不出去」要看網路，「連到了但被拒」要看憑證。
    const msg = String(err && err.message ? err.message : err);
    const networkIssue = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg);
    console.error('\n✗ 自檢無法進行：\n  ' + msg);
    console.error(networkIssue
      ? '\n  → 請求沒送出去。請確認這台機器能連到 ' + config.okx.baseUrl
        + '\n    （雲端主機若有出口限制，OKX 的網域必須在允許清單內）。'
      : '\n  → 請求送到了但被拒絕。上面的錯誤碼說明就是該處理的方向。');
    process.exit(1);
  }

  const a = report.account || {};
  console.log('\n【帳戶】');
  console.log('  UID 尾碼  : ' + (a.uid || '(未提供)'));
  console.log('  帳戶模式  : ' + a.acctLvName + (a.canTradeSwap ? ' ✓' : ' ✗'));
  console.log('  持倉模式  : ' + (a.posMode === 'long_short_mode' ? '開平倉（雙向）' : '買賣（單向）'));

  if (report.equity) {
    console.log('\n【權益】');
    console.log('  USDT 權益 : ' + report.equity.equityUsdt.toFixed(2)
      + '（來源 ' + report.equity.source + '）');
    console.log('  設定檔值  : ' + config.risk.equityUsdt.toFixed(2));

    const diff = Math.abs(report.equity.equityUsdt - config.risk.equityUsdt);
    const ratio = diff / report.equity.equityUsdt;
    if (ratio > 0.1) {
      console.log('  ⚠️ 兩者相差 ' + (ratio * 100).toFixed(1) + '%。');
      console.log('     倉位是以設定檔的數字反推的，差太多代表每一筆的風險都算錯 ——');
      console.log('     看起來合理，只是全部以錯誤的本金為基準。');
      console.log('     請把 ACCOUNT_EQUITY_USDT 改成 '
        + report.equity.equityUsdt.toFixed(0) + '。');
    }
  }

  const instIds = Object.keys(report.instruments || {});
  if (instIds.length) {
    console.log('\n【合約規格】');
    for (const id of instIds) {
      const s = report.instruments[id];
      console.log(`  ${id.padEnd(16)} ctVal=${s.ctVal}  lotSz=${s.lotSz}  minSz=${s.minSz}`);
    }
  }

  if (report.warnings.length) {
    console.log('\n【提醒】');
    report.warnings.forEach((w) => console.log('  • ' + w));
  }
  if (report.errors.length) {
    console.log('\n【必須處理】');
    report.errors.forEach((e) => console.log('  ✗ ' + e));
  }

  console.log('\n' + LINE);
  if (report.ok) {
    console.log('✓ 自檢通過。憑證、帳戶模式、權益、合約規格都沒問題。');
    console.log('  下一步：保持 DRY_RUN=true，送一筆測試訊號，');
    console.log('  確認「將會送出的請求」內容正確之後，才考慮切換 DRY_RUN。');
  } else {
    console.log('✗ 自檢未通過。請先處理上面「必須處理」的項目。');
  }
  console.log(LINE);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('自檢發生非預期錯誤：' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
