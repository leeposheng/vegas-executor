'use strict';
/**
 * 交易對白名單與規格查詢。
 *
 * 【兩件事要分清楚】
 *
 *   白名單   「哪些代碼允許交易」—— 這是你的決定，寫在設定裡
 *   合約規格 「每張多少面值、最小下多少」—— 這是交易所的事實
 *
 * 早期兩者混在同一張靜態表裡。幣種少時還行，但規格是人工抄的，
 * 而 ctVal 抄錯會讓倉位以錯誤倍率計算且毫無錯誤訊息
 * （2026-09-24 就抓到 BTC 的 lotSz 抄錯十倍）。
 * 幣種擴大到數十個之後，手抄出錯是必然的。
 *
 * 現在規格由 instruments.js 於開機時向交易所取得，這裡只負責：
 *   1. 白名單（哪些代碼准許交易）
 *   2. 代碼轉換（TradingView ↔ OKX instId）
 *   3. 少數人工核實過的靜態值，作為交易所與快取都拿不到時的最後退路
 *
 * 白名單仍然是必要的：查不到就拒單，等於自動具備「只交易已驗證幣種」
 * 的保護，不會因為 TradingView 那邊換了圖表代碼就意外開始交易新標的。
 */

const instruments = require('./instruments');

// 人工核實過的少數幾個，作為交易所與快取都拿不到時的最後退路。
// 不再是主要來源 —— 主要來源是開機時向交易所取得的規格。
const MAP = {
  'BTCUSDT.P': {
    // lotSz/minSz 於 2026-09-24 用 npm run preflight 對交易所核實後修正
    // （原本填 0.1，實際是 0.01）。偏大的 lotSz 不會放大風險 ——
    // 無條件捨去只會讓倉位變小 —— 但 minSz 填大 10 倍會讓本來可以下的
    // 訊號被誤判為「低於最小下單量」而拒單。
    okx: { instId: 'BTC-USDT-SWAP', ctVal: 0.01, lotSz: 0.01, minSz: 0.01 },
    bingx: { symbol: 'BTC-USDT', stepSize: 0.0001, minQty: 0.0001 },
  },
  'ETHUSDT.P': {
    okx: { instId: 'ETH-USDT-SWAP', ctVal: 0.1, lotSz: 0.01, minSz: 0.01 },
    bingx: { symbol: 'ETH-USDT', stepSize: 0.01, minQty: 0.01 },
  },
  'SOLUSDT.P': {
    okx: { instId: 'SOL-USDT-SWAP', ctVal: 1, lotSz: 0.01, minSz: 0.01 },
    bingx: { symbol: 'SOL-USDT', stepSize: 0.01, minQty: 0.01 },
  },
  'LINKUSDT.P': {
    okx: { instId: 'LINK-USDT-SWAP', ctVal: 1, lotSz: 0.1, minSz: 0.1 },
    bingx: { symbol: 'LINK-USDT', stepSize: 0.01, minQty: 0.01 },
  },
  'ZECUSDT.P': {
    // 2026-09-25 查交易所公開端點取得。上線前務必跑一次 npm run preflight
    // 核實 —— 這三個值若與交易所不符，倉位會以錯誤的倍率計算，
    // 而且不會有任何錯誤訊息。
    // 注意 lotSz/minSz 是 1（不是 0.01），所以最小一單就是 1 張 = 0.01 ZEC。
    okx: { instId: 'ZEC-USDT-SWAP', ctVal: 0.01, lotSz: 1, minSz: 1 },
  },
};

// ── 執行期白名單 ─────────────────────────────────────────
//
// 由 install() 在開機時填入：設定檔的名單與交易所實際有的合約取交集。
// 在它被填入之前，resolve 只認得上面 MAP 裡那幾個靜態項目 ——
// 這是刻意的：寧可少認幾個，也不要在還沒跟交易所確認過規格時就下單。
let runtime = null;

/**
 * 安裝執行期白名單。
 *
 * @param {object} params
 *   allowed  想交易的 TradingView 代碼清單
 *   specs    instId -> 規格（來自 instruments.load）
 * @returns {{installed:string[], missing:string[]}}
 *   missing = 設定裡有、但交易所沒有（或已下架）的代碼。
 *   這些不是錯誤，只是剔除 —— 名單裡有幾個交易所沒上的幣很正常，
 *   但必須說出來，否則你會以為它在跑而其實訊號一直被拒。
 */
function install(params) {
  const { allowed, specs, bingxSpecs } = params || {};
  const map = {};
  const missing = [];
  const missingBingx = [];

  for (const raw of allowed || []) {
    const tv = String(raw).trim().toUpperCase();
    if (!tv) continue;
    const instId = instruments.toInstId(tv);
    if (!instId) { missing.push(tv + '（代碼格式不是 XXXUSDT.P）'); continue; }

    // ---- OKX 那一側 ----
    const live = specs && specs[instId];
    const fallback = MAP[tv] && MAP[tv].okx;
    let entry = null;
    if (live) entry = { okx: Object.assign({}, live), source: 'exchange' };
    else if (fallback) entry = { okx: Object.assign({}, fallback), source: 'static' };
    if (!entry) { missing.push(tv); continue; }

    // ---- BingX 那一側 ----
    //
    // 沒有 BingX 規格不算失敗 —— 只有真的要在 BingX 下單時才需要它。
    // 把缺的列出來就好，不要因此把整個代碼從白名單剔除，
    // 那會讓「只跑 OKX」的情況莫名其妙少掉標的。
    const bx = instruments.toBingxSymbol(tv);
    const bxLive = bx && bingxSpecs && bingxSpecs[bx];
    const bxFallback = MAP[tv] && MAP[tv].bingx;
    if (bxLive) entry.bingx = Object.assign({}, bxLive);
    else if (bxFallback) entry.bingx = Object.assign({}, bxFallback);
    else missingBingx.push(tv);

    map[tv] = entry;
  }

  runtime = map;
  return { installed: Object.keys(map), missing, missingBingx };
}

/** 測試用：回到未安裝狀態。 */
function reset() { runtime = null; }

/**
 * @returns {{ok:boolean, spec?:object, error?:string}}
 */
function resolve(tvSymbol, exchange) {
  const tv = String(tvSymbol).trim().toUpperCase();
  // 白名單一旦裝好，它就是唯一依據。
  //
  // 曾經寫成 `runtime[tv] || MAP[tv]`，結果是靜態表裡那幾個代碼
  // 永遠放行 —— 你把 ALLOWED_SYMBOLS 設成只有 BTC，ZEC 照樣能下單。
  // 退路只在「還沒裝」時才有意義，裝好之後它是個後門。
  const entry = runtime ? runtime[tv] : MAP[tv];
  if (!entry) {
    return { ok: false, error: `代碼 ${tvSymbol} 不在白名單內，拒絕下單` };
  }
  const spec = entry[exchange];
  if (!spec) {
    return { ok: false, error: `代碼 ${tvSymbol} 未設定 ${exchange} 的對應` };
  }
  return { ok: true, spec: Object.assign({ tvSymbol }, spec) };
}

function listSupported() {
  return Object.keys(runtime || MAP);
}

/** 某個代碼的規格是從哪來的。開機橫幅與 /health 用。 */
function specSource(tvSymbol) {
  const e = runtime && runtime[String(tvSymbol).trim().toUpperCase()];
  return e ? e.source : 'static';
}

module.exports = { resolve, listSupported, install, reset, specSource, MAP };
