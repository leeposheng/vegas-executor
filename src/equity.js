'use strict';
/**
 * 帳戶權益來源。
 *
 * ── 為什麼需要一層 ──
 *
 * 倉位是由權益反推的：風險金額 = 權益 × 風險比例。所以權益一旦與實際
 * 脫節，每一筆的風險都會跟著偏掉 —— 而且是「安靜地」偏掉：卡片上的
 * 數字都合理，只是全部以錯誤的本金為基準。
 *
 * 階段 0 用 .env 手填的 ACCOUNT_EQUITY_USDT。那在還沒接交易所時是唯一
 * 的選擇，但它有個致命特性：**它永遠不會自己更新**。你入金、出金、
 * 賺了、賠了，那個數字都不動。三個月後它和現實差多少，沒有人知道。
 *
 * ── 設計 ──
 *
 * 1. 優先向交易所查詢；查到就用真的。
 * 2. 查到的值快取數十秒。權益不會秒秒變，而每筆訊號都去查一次，
 *    等於在下單的關鍵路徑上多掛一個可能失敗的外部相依。
 * 3. 查不到就退回快取，再不行才退回設定檔 —— 但**一定要標明來源**。
 *
 * 第 3 點是重點。這一層不會讓流程失敗（沒有權益就完全不能下單，
 * 代價太大），但它絕不假裝自己拿到的是真值。來源會一路帶到卡片上，
 * 讓人看得到「這個數字是查來的，還是猜的」。
 */

const okx = require('./exchanges/okx');

const DEFAULT_TTL_MS = 60 * 1000;

// 模組層級的快取。單一實例、單一帳戶，不需要更複雜的結構。
let cache = null;   // { equityUsdt, fetchedAt }

/** 測試用：清掉快取，讓每個案例從乾淨狀態開始。 */
function resetCache() {
  cache = null;
}

/**
 * 取得目前應採用的權益。永不拋例外。
 *
 * @returns {Promise<{equityUsdt:number, source:string, ageMs:number, note:string|null}>}
 *   source: 'exchange' 剛查到 | 'cache' 快取內 | 'config' 退回設定檔
 */
async function getEquity(config, flags, now) {
  const at = now === undefined ? Date.now() : now;
  const fallback = config.risk.equityUsdt;
  const ttl = config.risk.equityCacheMs === undefined
    ? DEFAULT_TTL_MS : config.risk.equityCacheMs;

  // 明確指定用設定檔，或根本沒有憑證（階段 0）—— 不必嘗試連線
  const canQuery = config.risk.equitySource !== 'config'
    && config.primaryExchange === 'okx'
    && Boolean(config.okx && config.okx.apiKey && config.okx.apiSecret
      && config.okx.passphrase);

  if (!canQuery) {
    return {
      equityUsdt: fallback, source: 'config', ageMs: 0,
      note: config.risk.equitySource === 'config'
        ? null
        : '未設定交易所憑證，倉位以設定檔的權益計算',
    };
  }

  if (cache && (at - cache.fetchedAt) < ttl) {
    return {
      equityUsdt: cache.equityUsdt, source: 'cache',
      ageMs: at - cache.fetchedAt, note: null,
    };
  }

  try {
    const r = await okx.fetchEquity(config.okx, flags);
    cache = { equityUsdt: r.equityUsdt, fetchedAt: at };
    return { equityUsdt: r.equityUsdt, source: 'exchange', ageMs: 0, note: null };
  } catch (err) {
    // 查不到就用手上最好的資料，但把「這是舊的／這是猜的」寫清楚。
    // 讓流程整個停下來不是更安全的選擇：訊號有時效，而權益在數十秒內
    // 的變化遠小於「錯過一筆已經通過所有風控的交易」。
    if (cache) {
      return {
        equityUsdt: cache.equityUsdt, source: 'cache', ageMs: at - cache.fetchedAt,
        note: `權益查詢失敗（${err.message}），沿用 ${Math.round((at - cache.fetchedAt) / 1000)} 秒前的數值`,
      };
    }
    return {
      equityUsdt: fallback, source: 'config', ageMs: 0,
      note: `權益查詢失敗（${err.message}），退回設定檔的 ${fallback} USDT —— `
        + '這個數字不會自己更新，請確認它仍接近實際',
    };
  }
}

module.exports = { getEquity, resetCache, DEFAULT_TTL_MS };
