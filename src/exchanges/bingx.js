'use strict';
/**
 * BingX 永續合約串接模組。
 *
 * 與 OKX 的關鍵差異（這是最容易寫錯的地方）：
 *
 *   OKX    簽章放在 HTTP 標頭，對 timestamp+method+path+body 簽
 *   BingX  簽章放在 query string，對 query string 本身簽
 *
 *   OKX    數量單位是「合約張數」
 *   BingX  數量單位是「base 幣」
 *
 * 因此兩者的簽章與倉位邏輯都不能共用，必須各寫一份。硬要抽象成
 * 同一個介面反而會在細節上出錯——這也是這裡刻意寫成兩個獨立檔案的原因。
 *
 * 簽章規則：
 *   qs   = 依固定順序串接的 key=value（含 timestamp）
 *   sign = HMAC-SHA256( qs, secretKey ) 以 hex 輸出
 *   url  = base + path + '?' + qs + '&signature=' + sign
 *
 * 重點：用來簽章的字串，必須與實際送出的字串「逐字元相同」。
 * 若先簽章再對參數做 encode，或簽完又調整順序，簽章一定失敗。
 * 因此這裡只組一次字串，簽章與送出都用同一份。
 */

const crypto = require('crypto');

const PATH_ORDER = '/openApi/swap/v2/trade/order';
const PATH_CONTRACTS = '/openApi/swap/v2/quote/contracts';
const PATH_POSITIONS = '/openApi/swap/v2/user/positions';
const PATH_INCOME = '/openApi/swap/v2/user/income';
const PATH_BALANCE = '/openApi/swap/v3/user/balance';
const PATH_PRICE = '/openApi/swap/v2/quote/price';
const PATH_SET_LEVERAGE = '/openApi/swap/v2/trade/leverage';

/**
 * 依給定順序組出 query string。
 * 刻意用陣列傳入而非物件，因為物件的鍵順序在語意上不該被依賴，
 * 而簽章對順序敏感。
 */
function buildQueryString(pairs) {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function buildSignedRequest(opts) {
  const { method, path, pairs, cfg, now } = opts;
  const withTs = pairs.concat([
    ['timestamp', String(now === undefined ? Date.now() : now)],
    ['recvWindow', '5000'],
  ]);
  const qs = buildQueryString(withTs);
  const signature = sign(qs, cfg.apiSecret);
  const url = `${cfg.baseUrl}${path}?${qs}&signature=${signature}`;

  return {
    exchange: 'bingx',
    method: String(method).toUpperCase(),
    url,
    requestPath: path,
    headers: { 'X-BX-APIKEY': cfg.apiKey },
    body: '',
    // 除錯用：簽章失敗時要比對的就是這一串（不含密鑰）
    signedString: qs,
  };
}

/**
 * 組下單參數。
 *
 * stopLoss / takeProfit 在 BingX 是「JSON 字串」形式的參數，
 * 不是巢狀物件——這點與 OKX 的 attachAlgoOrds 陣列不同。
 */
function buildOrderPairs(p) {
  const { symbol, side, orderQty, clientOrderId, sl, tp } = p;

  const stopLoss = JSON.stringify({
    type: 'STOP_MARKET',
    stopPrice: Number(sl),
    price: Number(sl),
    workingType: 'MARK_PRICE',
  });
  const takeProfit = JSON.stringify({
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: Number(tp),
    price: Number(tp),
    workingType: 'MARK_PRICE',
  });

  return [
    ['symbol', symbol],
    ['side', side === 'long' ? 'BUY' : 'SELL'],
    ['positionSide', side === 'long' ? 'LONG' : 'SHORT'],
    ['type', 'MARKET'],
    ['quantity', String(orderQty)],          // 單位是 base 幣，與 OKX 不同
    ['clientOrderID', clientOrderId],
    ['stopLoss', stopLoss],
    ['takeProfit', takeProfit],
  ];
}

async function fetchContract(symbol, cfg) {
  const res = await fetch(`${cfg.baseUrl}${PATH_CONTRACTS}`, { method: 'GET' });
  if (!res.ok) throw new Error(`BingX contracts HTTP ${res.status}`);
  const json = await res.json();
  const list = (json && json.data) || [];
  const hit = list.find((c) => c.symbol === symbol);
  if (!hit) throw new Error(`BingX 找不到合約 ${symbol}`);
  return {
    symbol: hit.symbol,
    stepSize: Number(hit.quantityPrecision !== undefined
      ? Math.pow(10, -Number(hit.quantityPrecision))
      : hit.size),
    minQty: Number(hit.tradeMinQuantity || hit.minQty || 0),
  };
}

/**
 * 查現價。公開端點，不需簽章。
 *
 * 少了這支，漂移檢查會把每一筆 BingX 的確認都判成「無法取得現價」
 * 而拒單 —— manual 模式下 BingX 那一側等於完全不能用。
 * 回傳欄位名刻意與 OKX 的 fetchTicker 一致，讓呼叫端不必分辨交易所。
 */
async function fetchTicker(symbol, cfg) {
  const base = (cfg && cfg.baseUrl) || 'https://open-api.bingx.com';
  const res = await fetch(`${base}${PATH_PRICE}?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`BingX 現價查詢 HTTP ${res.status}`);
  const json = await res.json();
  if (Number(json.code) !== 0) {
    throw new Error(`BingX 現價查詢 code=${json.code} ${json.msg || ''}`);
  }
  const last = Number(json.data && (json.data.price || json.data.markPrice));
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`BingX 回傳的 ${symbol} 現價無法解析`);
  }
  return { instId: symbol, last };
}

/** 送出已簽章的請求並檢查 BingX 的業務層錯誤碼。 */
async function sendSigned(req, what) {
  const res = await fetch(req.url, { method: req.method, headers: req.headers });
  const json = await res.json().catch(() => ({}));
  // HTTP 200 也可能失敗 —— 與 OKX 同樣的陷阱，錯誤在 body 裡。
  if (!res.ok || Number(json.code) !== 0) {
    throw new Error(
      `BingX ${what} 失敗 HTTP ${res.status} code=${json.code} msg=${json.msg || ''}`
    );
  }
  return json;
}

/**
 * 查詢持倉。只回傳數量不為零的。
 *
 * 與 OKX 的差別：BingX 的數量單位是 base 幣（0.05 BTC），不是張數。
 * 這個差異一路影響到倉位計算，是兩家不能共用同一份邏輯的主因。
 */
async function fetchPositions(cfg, flags) {
  const req = buildSignedRequest({
    method: 'GET', path: PATH_POSITIONS, pairs: [], cfg,
  });
  const json = await sendSigned(req, '查詢持倉');
  return (json.data || [])
    .filter((p) => Number(p.positionAmt) !== 0)
    .map((p) => ({
      // 統一成與 OKX 相同的欄位名，讓對帳邏輯能共用。
      // instId 這裡放 BingX 的 symbol（BTC-USDT），格式不同但用途相同。
      instId: p.symbol,
      posSide: String(p.positionSide || '').toLowerCase(),
      pos: Number(p.positionAmt),
      avgPx: Number(p.avgPrice),
      upl: Number(p.unrealizedProfit),
      lever: Number(p.leverage) || null,
    }));
}

/**
 * 查詢已實現損益。
 *
 * BingX 沒有 OKX 那種「平倉紀錄」端點，只有資金流水。所以做法不同：
 * 取 REALIZED_PNL 與 COMMISSION 兩種流水，依時間與合約歸戶後相加。
 *
 * 這比 OKX 的 realizedPnl 粗糙 —— 那邊交易所已經把手續費算進去了，
 * 這邊要自己加。所以這裡把兩者分開回報，對不上時才查得出差在哪。
 */
async function fetchPositionsHistory(params, cfg, flags) {
  const { instId, afterMs } = params || {};
  const pairs = [
    ['symbol', instId],
    ['startTime', afterMs ? String(Math.floor(afterMs)) : undefined],
    ['limit', '200'],
  ].filter(([, v]) => v !== undefined);

  const req = buildSignedRequest({ method: 'GET', path: PATH_INCOME, pairs, cfg });
  const json = await sendSigned(req, '查詢資金流水');

  // 把同一個合約、同一段時間的流水聚成一筆「平倉紀錄」。
  // BingX 的一次平倉可能拆成多筆流水（分批成交），所以要合併。
  const rows = (json.data || []).filter((r) =>
    r.incomeType === 'REALIZED_PNL' || r.incomeType === 'COMMISSION'
    || r.incomeType === 'FUNDING_FEE');
  if (!rows.length) return [];

  let pnl = 0, fee = 0, funding = 0, lastMs = 0;
  for (const r of rows) {
    const v = Number(r.income) || 0;
    if (r.incomeType === 'REALIZED_PNL') pnl += v;
    else if (r.incomeType === 'COMMISSION') fee += v;
    else funding += v;
    lastMs = Math.max(lastMs, Number(r.time) || 0);
  }

  return [{
    instId,
    posSide: 'net',
    openAvgPx: null,
    closeAvgPx: null,
    // 與 OKX 的欄位對齊：realizedPnl 是含費用的淨額
    realizedPnl: Number((pnl + fee + funding).toFixed(8)),
    pnl: Number(pnl.toFixed(8)),
    fee: Number(fee.toFixed(8)),
    fundingFee: Number(funding.toFixed(8)),
    closeType: '2',
    openedAtMs: null,
    closedAtMs: lastMs || null,
    aggregated: true,   // 標記它是聚出來的，不是交易所的單筆紀錄
  }];
}

/** 用我們自己的 clientOrderID 反查訂單。下單例外之後的求證管道。 */
async function fetchOrderByClOrdId(params, cfg, flags) {
  const { instId, clOrdId } = params;
  const req = buildSignedRequest({
    method: 'GET', path: PATH_ORDER,
    pairs: [['symbol', instId], ['clientOrderID', clOrdId]], cfg,
  });

  let json;
  try {
    json = await sendSigned(req, '反查訂單');
  } catch (err) {
    // 訂單不存在的錯誤訊息裡會帶 not exist / 80016 之類。
    // 分不出來時一律往外拋 —— 「查不到」與「確定沒送出」處置完全不同，
    // 猜錯的代價是把一筆已成交的單當成沒送出。
    if (/not\s*exist|80016/i.test(String(err.message))) return null;
    throw err;
  }

  const o = (json.data && (json.data.order || json.data)) || null;
  if (!o || !o.orderId) return null;
  return {
    ordId: String(o.orderId),
    clOrdId: o.clientOrderID || clOrdId,
    // BingX 的狀態字彙與 OKX 不同，在這裡轉成統一的說法，
    // 讓對帳不必知道自己在跟哪一家講話。
    state: mapOrderState(o.status),
    filledSz: Number(o.executedQty) || 0,
    avgPx: Number(o.avgPrice) || null,
    side: o.side,
    posSide: o.positionSide,
    createdAtMs: Number(o.time) || null,
  };
}

/** BingX 訂單狀態 → 對帳共用的字彙。 */
function mapOrderState(status) {
  const s = String(status || '').toUpperCase();
  if (s === 'FILLED') return 'filled';
  if (s === 'PARTIALLY_FILLED') return 'partially_filled';
  if (s === 'CANCELED' || s === 'CANCELLED' || s === 'EXPIRED') return 'canceled';
  return 'live';
}

/** 查詢權益（USDT）。 */
async function fetchEquity(cfg, flags) {
  const req = buildSignedRequest({
    method: 'GET', path: PATH_BALANCE, pairs: [], cfg,
  });
  const json = await sendSigned(req, '查詢權益');
  const list = Array.isArray(json.data) ? json.data : [json.data];
  const usdt = list.find((b) => b && (b.asset === 'USDT' || b.currency === 'USDT'));
  const value = Number(usdt && (usdt.equity || usdt.balance));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('BingX 回傳的權益無法解析，請確認帳戶內有 USDT 餘額');
  }
  return { equityUsdt: value, source: 'bingx.equity' };
}

/**
 * 取回全部永續合約的規格。與 OKX 同樣是公開端點、不需簽章。
 * @returns {Promise<Object>} symbol -> 規格
 */
async function fetchAllContracts(cfg) {
  const base = (cfg && cfg.baseUrl) || 'https://open-api.bingx.com';
  const res = await fetch(`${base}${PATH_CONTRACTS}`, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (Number(json.code) !== 0) {
    throw new Error(`BingX code=${json.code} ${json.msg || ''}`);
  }
  const out = {};
  for (const c of json.data || []) {
    if (!c.symbol || !String(c.symbol).endsWith('-USDT')) continue;
    // quantityPrecision 是小數位數，轉成最小增量：2 → 0.01
    const prec = Number(c.quantityPrecision);
    const stepSize = Number.isFinite(prec) ? Math.pow(10, -prec) : Number(c.size);
    const minQty = Number(c.tradeMinQuantity || c.minQty || stepSize);
    if (!(stepSize > 0) || !(minQty > 0)) continue;
    out[c.symbol] = { symbol: c.symbol, stepSize, minQty };
  }
  if (!Object.keys(out).length) throw new Error('回應中沒有任何可用的 USDT 永續合約');
  return out;
}

/**
 * 下單。dryRun 為 true 時只回傳將送出的內容。
 */
async function placeOrder(params, cfg, flags) {
  const pairs = buildOrderPairs(params);
  const req = buildSignedRequest({
    method: 'POST',
    path: PATH_ORDER,
    pairs,
    cfg,
  });

  if (flags.dryRun) {
    return { sent: false, request: req, response: null };
  }

  const res = await fetch(req.url, { method: req.method, headers: req.headers });
  const json = await res.json().catch(() => ({}));

  // BingX 同樣是 HTTP 200 也可能失敗，要檢查 code === 0
  if (!res.ok || Number(json.code) !== 0) {
    throw new Error(
      `BingX 下單失敗 HTTP ${res.status} code=${json.code} msg=${json.msg || ''}`
    );
  }
  return { sent: true, request: req, response: json };
}

/**
 * 設定某個合約的槓桿。
 *
 * 【為什麼非做不可】
 * 沒有這一支，BingX 會沿用帳戶上次留下的槓桿，而固定保證金模式的
 * 名目是「保證金 × 槓桿」算出來的。兩邊對不上的結果是：卡片顯示
 * 名目 1000，交易所實際鎖的是別的數字 —— 而且只有 BingX 那一側錯，
 * 你要比對兩家的對帳才看得出來。
 *
 * BingX 的多空槓桿是分開設的（side: LONG / SHORT），
 * 與 OKX 逐倉雙向持倉同一個道理：只設一邊，另一邊會沿用舊值。
 */
async function setLeverage(params, cfg, flags) {
  const { symbol, leverage, side } = params;
  const req = buildSignedRequest({
    method: 'POST',
    path: PATH_SET_LEVERAGE,
    pairs: [['symbol', symbol], ['side', side], ['leverage', String(leverage)]],
    cfg,
  });
  if (flags && flags.dryRun) return { sent: false, request: req };
  await sendSigned(req, '設定槓桿');
  return { sent: true };
}

// 已設過的 symbol|leverage。與 OKX 同樣的快取，理由也一樣：
// 每筆下單都設一次槓桿是多餘的外部呼叫，而且會吃頻率限制。
const leverageDone = new Set();

async function ensureLeverage(params, cfg, flags) {
  const { symbol, leverage } = params;
  if (!leverage) return { skipped: '未設定槓桿' };
  const key = `${symbol}|${leverage}`;
  if (leverageDone.has(key)) return { cached: true };
  // 多空各設一次。只設 LONG 的話，做空那一側會沿用帳戶舊值 ——
  // 而那個錯誤只在做空時發生，最難察覺的那一種。
  for (const side of ['LONG', 'SHORT']) {
    await setLeverage({ symbol, leverage, side }, cfg, flags);
  }
  leverageDone.add(key);
  return { set: true, sides: 2 };
}

function resetLeverageCache() { leverageDone.clear(); }

/**
 * 開機自檢。與 OKX 的 preflight 對齊：在送出任何委託之前，
 * 把「會讓下單失敗的設定」一次查清楚。
 *
 * 只打兩個請求（權益、合約清單），刻意不逐一查每個標的 ——
 * 五十個標的逐一查會在啟動時打出上百個請求，直接撞上頻率限制。
 * 那個教訓是 OKX 那邊用 50011 錯誤換來的。
 *
 * 回傳 { ok, equityUsdt, contracts, isVst, note }。
 * 失敗不拋例外：呼叫端要能區分「自檢失敗」與「服務起不來」，
 * 前者應該讓服務照常啟動並停止下單（對帳仍要跑）。
 */
async function preflight(cfg, flags) {
  const out = { ok: false, checks: [], isVst: /open-api-vst/i.test(cfg.baseUrl) };
  try {
    const eq = await fetchEquity(cfg, flags);
    out.equityUsdt = eq.equityUsdt;
    out.checks.push({ name: '金鑰與權益', ok: true,
      detail: `${eq.equityUsdt.toFixed(2)} USDT` });
  } catch (err) {
    out.checks.push({ name: '金鑰與權益', ok: false, detail: err.message });
    out.error = err.message;
    return out;
  }

  try {
    const specs = await fetchAllContracts(cfg);
    const n = Object.keys(specs).length;
    out.contracts = n;
    out.checks.push({ name: '合約清單', ok: n > 0, detail: `${n} 個` });
    if (!n) { out.error = 'BingX 回傳空的合約清單'; return out; }
  } catch (err) {
    out.checks.push({ name: '合約清單', ok: false, detail: err.message });
    out.error = err.message;
    return out;
  }

  // 模擬盤的權益是虛擬 USDT。這件事要講出來 ——
  // 一個顯示「權益 100000」的自檢報告，看的人會以為那是真錢。
  out.note = out.isVst
    ? 'VST 模擬盤：權益為虛擬 USDT，損益不具真實意義'
    : '';
  out.ok = true;
  return out;
}

module.exports = {
  buildQueryString, sign, buildSignedRequest, buildOrderPairs,
  fetchContract, placeOrder, sendSigned, fetchTicker,
  fetchPositions, fetchPositionsHistory, fetchOrderByClOrdId,
  fetchEquity, fetchAllContracts, mapOrderState,
  setLeverage, ensureLeverage, resetLeverageCache, preflight,
  PATH_ORDER, PATH_CONTRACTS, PATH_POSITIONS, PATH_INCOME, PATH_BALANCE,
  PATH_PRICE, PATH_SET_LEVERAGE,
};
