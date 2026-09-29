'use strict';
/**
 * 合約規格的動態載入。
 *
 * 【為什麼不寫死在程式裡】
 * 每個永續合約有三個關鍵數字：
 *   ctVal  每張的面值（例如 BTC 一張 = 0.01 BTC）
 *   lotSz  下單數量的最小跳動
 *   minSz  最小下單量
 *
 * ctVal 抄錯會讓倉位以錯誤的倍率計算 —— 抄成十分之一，你以為下了
 * 100 USDT 的單，實際是 1000。而且**不會有任何錯誤訊息**：
 * 交易所會照收，訂單會成交，只是大小不是你以為的那個。
 *
 * 四個幣種時手動維護還算可行（而且 2026-09-24 那次就抓到 BTC 的
 * lotSz 抄錯了）。五十個幣種手抄，出錯幾乎是必然的，而錯的那一個
 * 要等到它剛好出訊號才會爆。
 *
 * 所以改成開機時向交易所要一次。公開端點、不需簽章、一次拿回全部。
 *
 * 【三層退路】
 *   1. 交易所（最新，開機時抓）
 *   2. 磁碟快取（上次抓到的，交易所暫時不通時用）
 *   3. 靜態表（symbols.js 裡人工核實過的少數幾個）
 *
 * 少了退路的話，OKX 的公開端點一抖動就會讓服務起不來 ——
 * 而規格這種東西幾個月才變一次，用昨天的值完全可以接受。
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_INSTRUMENTS = '/api/v5/public/instruments?instType=SWAP';
const CACHE_FILE = 'instruments.json';

/**
 * 把 TradingView 的代碼轉成 OKX 的 instId。
 *   ZECUSDT.P → ZEC-USDT-SWAP
 *
 * 只認 USDT 本位的永續。幣本位（ZECUSD）與現貨的風險模型完全不同，
 * 這套系統的倉位計算是照 USDT 本位寫的，混進來會算錯。
 */
function toInstId(tvSymbol) {
  const s = String(tvSymbol || '').trim().toUpperCase();
  const m = s.match(/^([A-Z0-9]+)USDT\.P$/);
  return m ? `${m[1]}-USDT-SWAP` : null;
}

/**
 * TradingView 代碼 → BingX 的 symbol。
 *   ZECUSDT.P → ZEC-USDT
 *
 * 與 OKX 的差別只有結尾（BingX 沒有 -SWAP），但兩者不能混用 ——
 * 用錯格式的結果是「查無此合約」，而那在下單當下才會發現。
 */
function toBingxSymbol(tvSymbol) {
  const s = String(tvSymbol || '').trim().toUpperCase();
  const m = s.match(/^([A-Z0-9]+)USDT\.P$/);
  return m ? `${m[1]}-USDT` : null;
}

/** 反向：OKX instId → TradingView 代碼。 */
function toTvSymbol(instId) {
  const m = String(instId || '').match(/^([A-Z0-9]+)-USDT-SWAP$/);
  return m ? `${m[1]}USDT.P` : null;
}

/**
 * 向交易所取回全部 USDT 永續的規格。
 * @returns {Promise<Object>} instId -> { ctVal, lotSz, minSz, tickSz }
 */
async function fetchAll(baseUrl) {
  const url = (baseUrl || 'https://www.okx.com') + PUBLIC_INSTRUMENTS;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== '0') {
    throw new Error(`OKX code=${json.code} ${json.msg || ''}`);
  }

  const out = {};
  for (const d of json.data || []) {
    if (d.settleCcy !== 'USDT') continue;       // 只要 USDT 本位
    if (d.state !== 'live') continue;           // 下架或暫停的不要
    const ctVal = Number(d.ctVal);
    const lotSz = Number(d.lotSz);
    const minSz = Number(d.minSz);
    // 三個值缺一不可。少了任何一個就算不出張數 —— 與其帶著
    // undefined 往下跑，不如當作這個合約不存在。
    if (!(ctVal > 0) || !(lotSz > 0) || !(minSz > 0)) continue;
    out[d.instId] = {
      instId: d.instId, ctVal, lotSz, minSz,
      tickSz: Number(d.tickSz) || null,
      maxLever: Number(d.lever) || null,
    };
  }
  if (!Object.keys(out).length) {
    throw new Error('回應中沒有任何可用的 USDT 永續合約');
  }
  return out;
}

function cachePath(dataDir) {
  return path.join(dataDir, CACHE_FILE);
}

function readCache(dataDir) {
  try {
    const raw = fs.readFileSync(cachePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.specs && Object.keys(parsed.specs).length) return parsed;
  } catch (_) { /* 沒有快取或壞掉都一樣：當作沒有 */ }
  return null;
}

function writeCache(dataDir, specs) {
  try {
    const tmp = cachePath(dataDir) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      count: Object.keys(specs).length,
      specs,
    }, null, 2));
    fs.renameSync(tmp, cachePath(dataDir));
  } catch (err) {
    // 寫不進去不影響這次執行，只是下次沒有退路可用
    console.warn('[規格] 快取寫入失敗：' + err.message);
  }
}

/**
 * 載入規格。依序嘗試交易所 → 磁碟快取，兩者都失敗就回空。
 *
 * @returns {Promise<{specs:object, source:string, note:string, ageHours?:number}>}
 */
async function load(opts) {
  const { baseUrl, dataDir, skipNetwork } = opts || {};

  if (!skipNetwork) {
    try {
      const specs = await fetchAll(baseUrl);
      if (dataDir) writeCache(dataDir, specs);
      return {
        specs, source: 'exchange',
        note: `向交易所取得 ${Object.keys(specs).length} 個 USDT 永續合約規格`,
      };
    } catch (err) {
      console.warn('[規格] 向交易所查詢失敗：' + err.message + '，改用快取');
    }
  }

  const cached = dataDir && readCache(dataDir);
  if (cached) {
    const ageHours = (Date.now() - Date.parse(cached.fetchedAt)) / 3600000;
    return {
      specs: cached.specs, source: 'cache', ageHours,
      note: `使用 ${ageHours.toFixed(1)} 小時前的快取（${cached.count} 個合約）`,
    };
  }

  return { specs: {}, source: 'none', note: '取不到任何合約規格' };
}

module.exports = {
  load, fetchAll, toInstId, toTvSymbol, toBingxSymbol, PUBLIC_INSTRUMENTS,
};
