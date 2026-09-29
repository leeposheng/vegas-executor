'use strict';
/**
 * OKX V5 串接模組。
 *
 * 簽章規則（已對照官方文件確認）：
 *   prehash = timestamp + METHOD + requestPath + body
 *   sign    = Base64( HMAC-SHA256( prehash, secretKey ) )
 *
 *   timestamp   ISO 8601 UTC 含毫秒，例如 2026-09-21T14:17:02.715Z
 *   METHOD      大寫
 *   requestPath 含 query string，且必須與實際送出的完全一致
 *   body        POST 為 JSON 字串，GET 為空字串
 *
 * 伺服器容許的時間誤差為 30 秒，因此主機務必啟用 NTP。
 *
 * 模擬盤：加標頭 x-simulated-trading: 1，其餘完全相同。
 *
 * ── 階段 0 行為 ──
 * placeOrder() 會完成「所有」工作：組參數、算簽章、組出完整請求，
 * 然後在 dryRun 為 true 時回傳該請求而不送出。
 * 這樣做的用意是：等到要送真單時，唯一改變的只有最後那一行 fetch，
 * 前面的邏輯早已在階段 0 被檢查過無數次。
 */

const crypto = require('crypto');

const PATH_INSTRUMENTS = '/api/v5/public/instruments';
const PATH_TICKER = '/api/v5/market/ticker';
const PATH_ORDER = '/api/v5/trade/order';
const PATH_ACCOUNT_CONFIG = '/api/v5/account/config';
const PATH_BALANCE = '/api/v5/account/balance';
const PATH_SET_LEVERAGE = '/api/v5/account/set-leverage';
const PATH_POSITIONS = '/api/v5/account/positions';
const PATH_POSITIONS_HISTORY = '/api/v5/account/positions-history';
const PATH_ALGO_PENDING = '/api/v5/trade/orders-algo-pending';

/**
 * 帳戶模式（acctLv）。永續合約至少要「合約模式」。
 * 這是最常見的卡關點，而且 API 改不了 —— 必須在 OKX 網頁或 App 上設定。
 */
const ACCT_LEVEL = {
  '1': { name: '現貨模式', canSwap: false },
  '2': { name: '合約模式', canSwap: true },
  '3': { name: '跨幣種保證金模式', canSwap: true },
  '4': { name: '投資組合保證金模式', canSwap: true },
};

/**
 * 把 OKX 的錯誤碼翻成「接下來該做什麼」。
 *
 * 同一個原則：錯誤的種類本身就是線索。50102 和 50113 都會讓下單失敗，
 * 但一個要去校時、一個要去檢查金鑰，混成「下單失敗」就等於什麼都沒說。
 */
function explainOkxError(code, sCode, msg) {
  const c = String(sCode && sCode !== '0' ? sCode : code || '');
  const hints = {
    '50102': '時間戳過期。主機時鐘與 OKX 相差超過 30 秒，請確認機器有啟用 NTP 校時。',
    '50103': '缺少 OK-ACCESS-KEY 標頭。',
    '50104': '缺少 OK-ACCESS-PASSPHRASE 標頭。',
    '50105': 'Passphrase 錯誤。它是建立金鑰時你自己輸入的那一串，不是 Secret Key。',
    '50111': 'API Key 無效。最常見原因是把實盤金鑰用在模擬盤（或相反）—— 兩者完全不通用。',
    '50113': '簽章驗證失敗。prehash 必須是 timestamp+METHOD+requestPath+body，'
      + '且 requestPath 要與實際送出的完全一致（含 query string）。',
    '50114': '無效的授權，通常是模擬盤標頭 x-simulated-trading 漏掉或多加。',
    '51000': '參數錯誤。請看 sMsg 指出的欄位。',
    '51008': '保證金不足。模擬盤可在 OKX 介面重置模擬資金。',
    '51010': '目前帳戶模式不支援此操作 —— 永續合約需要「合約模式」以上。'
      + '請到 OKX 網頁或 App 切換帳戶模式，這個設定 API 改不了。',
    '51011': '重複的 clOrdId。這代表冪等保護生效，同一筆訊號已經下過單了。',
    '51020': '下單量低於最小下單量（minSz）。',
    '51116': '委託價格超出允許範圍。',
    '51121': '下單量必須是 lotSz 的整數倍。',
    '59000': '有持倉或掛單時不能切換設定，請先平倉或撤單。',
    '50011': '觸發限流，請降低請求頻率。',
  };
  return hints[c] || null;
}

/** 統一的回應檢查。OKX 的 HTTP 200 不代表成功，必須看 code。 */
async function readOkxResponse(res, what) {
  const json = await res.json().catch(() => ({}));
  const detail = (json.data && json.data[0]) || {};
  const failed = !res.ok || json.code !== '0'
    || (detail.sCode !== undefined && detail.sCode !== '0');

  if (failed) {
    const hint = explainOkxError(json.code, detail.sCode, json.msg);
    throw new Error(
      `OKX ${what} 失敗 HTTP ${res.status} code=${json.code || '?'}`
      + (detail.sCode ? ` sCode=${detail.sCode}` : '')
      + ` msg=${detail.sMsg || json.msg || '(無)'}`
      + (hint ? `\n  → ${hint}` : '')
    );
  }
  return json;
}

/** 送出一個已簽章的請求並檢查回應。 */
async function sendSigned(req, what) {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' ? undefined : req.body,
  });
  return readOkxResponse(res, what);
}

/** ISO 8601 UTC 含毫秒 —— toISOString() 的輸出正好符合。 */
function okxTimestamp(now) {
  return new Date(now === undefined ? Date.now() : now).toISOString();
}

function sign(prehash, secret) {
  return crypto.createHmac('sha256', secret).update(prehash).digest('base64');
}

/**
 * 組出一個已簽章的請求描述物件（不送出）。
 * 抽成獨立函式是為了讓簽章邏輯能被單元測試，不必接觸網路。
 */
function buildSignedRequest(opts) {
  const { method, requestPath, body, cfg, demo, now } = opts;
  const upper = String(method).toUpperCase();
  const bodyStr = body === undefined || body === null ? '' : JSON.stringify(body);
  const ts = okxTimestamp(now);
  const prehash = ts + upper + requestPath + bodyStr;

  const headers = {
    'Content-Type': 'application/json',
    'OK-ACCESS-KEY': cfg.apiKey,
    'OK-ACCESS-SIGN': sign(prehash, cfg.apiSecret),
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': cfg.passphrase,
  };
  if (demo) headers['x-simulated-trading'] = '1';

  return {
    exchange: 'okx',
    method: upper,
    url: cfg.baseUrl + requestPath,
    requestPath,
    headers,
    body: bodyStr,
    // 除錯用：出問題時九成是 prehash 拼錯，但這串含不了密鑰，可安全記錄
    prehashShape: `${ts}|${upper}|${requestPath}|${bodyStr ? 'body(' + bodyStr.length + ')' : ''}`,
  };
}

/**
 * 取得合約規格（ctVal / lotSz / minSz）。
 * 這是公開端點，不需簽章。
 *
 * 階段 0 預設走靜態表（symbols.js），因為 ctVal 這類值極少變動，
 * 而「多一個開機必須成功的外部相依」在階段 0 沒有好處。
 * 階段 1 起建議改為啟動時抓一次、每日更新，並與靜態表比對，
 * 不一致就告警 —— 交易所調整合約面值時，這是唯一會提早發現的機制。
 */
async function fetchInstrument(instId, cfg) {
  const url = `${cfg.baseUrl}${PATH_INSTRUMENTS}?instType=SWAP&instId=${encodeURIComponent(instId)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`OKX instruments HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== '0' || !json.data || !json.data.length) {
    throw new Error(`OKX instruments 回應異常：${JSON.stringify(json).slice(0, 200)}`);
  }
  const d = json.data[0];
  return {
    instId: d.instId,
    ctVal: Number(d.ctVal),
    lotSz: Number(d.lotSz),
    minSz: Number(d.minSz),
    tickSz: Number(d.tickSz),
  };
}

/**
 * 取得現價。公開端點，不需簽章 —— 因此在還沒填憑證時也能運作。
 *
 * 取 last（最新成交價）而非 markPx（標記價）：市價單成交在盤口，
 * 標記價是用來算保證金的平滑值，兩者在急動時會差一截。
 * 這裡要回答的是「我現在按下去大概會成交在哪」。
 */
async function fetchTicker(instId, cfg) {
  const url = `${cfg.baseUrl}${PATH_TICKER}?instId=${encodeURIComponent(instId)}`;
  const res = await fetch(url, { method: 'GET' });
  const json = await readOkxResponse(res, `查詢 ${instId} 現價`);
  const d = (json.data && json.data[0]) || {};
  const last = Number(d.last);
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`OKX 回傳的 ${instId} 現價無法解析`);
  }
  return {
    instId: d.instId || instId,
    last,
    askPx: Number(d.askPx) || null,
    bidPx: Number(d.bidPx) || null,
    ts: Number(d.ts) || Date.now(),
  };
}

/**
 * 查詢帳戶設定：帳戶模式與持倉模式。
 *
 * 這兩個值決定下單參數怎麼組，而且都只能在 OKX 網頁／App 上設定。
 * 與其要求使用者「記得設對」再靠下單失敗才發現，不如開機就問清楚。
 */
async function fetchAccountConfig(cfg, flags) {
  const req = buildSignedRequest({
    method: 'GET', requestPath: PATH_ACCOUNT_CONFIG, cfg, demo: flags && flags.demo,
  });
  const json = await sendSigned(req, '查詢帳戶設定');
  const d = (json.data && json.data[0]) || {};
  return {
    acctLv: String(d.acctLv || ''),
    acctLvName: (ACCT_LEVEL[String(d.acctLv)] || {}).name || `未知(${d.acctLv})`,
    canTradeSwap: Boolean((ACCT_LEVEL[String(d.acctLv)] || {}).canSwap),
    posMode: String(d.posMode || ''),        // net_mode | long_short_mode
    uid: d.uid ? String(d.uid).slice(-6) : null,   // 只留尾碼，足以辨識又不外洩
  };
}

/**
 * 查詢 USDT 權益。
 *
 * 取代 .env 裡手動填的 ACCOUNT_EQUITY_USDT —— 那個值一旦與實際脫節，
 * 倉位就會整批算錯，而且錯得很安靜：每一筆看起來都合理，
 * 只是全部以錯誤的本金為基準。
 */
async function fetchEquity(cfg, flags) {
  const requestPath = PATH_BALANCE + '?ccy=USDT';
  const req = buildSignedRequest({
    method: 'GET', requestPath, cfg, demo: flags && flags.demo,
  });
  const json = await sendSigned(req, '查詢權益');
  const acct = (json.data && json.data[0]) || {};
  const usdt = ((acct.details || []).find((x) => x.ccy === 'USDT')) || {};

  // eq = 該幣種權益（含未實現損益）。取不到就退回 totalEq（以美元計）。
  const eq = Number(usdt.eq);
  const total = Number(acct.totalEq);
  const value = Number.isFinite(eq) && eq > 0 ? eq : total;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('OKX 回傳的權益無法解析，請確認帳戶內有 USDT 餘額');
  }
  return {
    equityUsdt: value,
    source: Number.isFinite(eq) && eq > 0 ? 'USDT.eq' : 'totalEq',
    availEq: Number(usdt.availEq) || null,
  };
}

/**
 * 用我們自己的 clOrdId 反查一筆訂單。
 *
 * 這是「下單例外之後」唯一的求證管道：請求可能已經送達並成交，
 * 只是回應在半路不見了。clOrdId 是我們送出去的，所以即使沒收到回應，
 * 也還是問得出這筆的下落。
 *
 * 回傳 null 表示交易所根本沒有這筆 —— 那才代表請求確實沒送達。
 */
async function fetchOrderByClOrdId(params, cfg, flags) {
  const { instId, clOrdId } = params;
  const requestPath = PATH_ORDER
    + '?instId=' + encodeURIComponent(instId)
    + '&clOrdId=' + encodeURIComponent(clOrdId);
  const req = buildSignedRequest({
    method: 'GET', requestPath, cfg, demo: flags && flags.demo,
  });

  let json;
  try {
    json = await sendSigned(req, '反查訂單');
  } catch (err) {
    // 51603 = 訂單不存在。這是「確定沒送達」，與「查不到」不同，
    // 必須分開回報 —— 前者可以安心放掉，後者要留著再查。
    if (String(err.message).includes('51603')) return null;
    throw err;
  }

  const o = (json.data && json.data[0]) || null;
  if (!o) return null;
  return {
    ordId: o.ordId,
    clOrdId: o.clOrdId,
    state: o.state,               // live | partially_filled | filled | canceled
    filledSz: Number(o.accFillSz) || 0,
    avgPx: Number(o.avgPx) || null,
    side: o.side,
    posSide: o.posSide,
    createdAtMs: Number(o.cTime) || null,
  };
}

/**
 * 查詢目前持有的部位。
 *
 * 只回傳張數不為零的項目。OKX 會把「曾經持有、現在已平」的合約
 * 以 pos:"0" 的形式留在回應裡一段時間 —— 若不過濾，對帳會誤判成仍在場內，
 * 永遠等不到平倉，損益也就永遠不會被記錄。
 */
async function fetchPositions(cfg, flags) {
  const requestPath = PATH_POSITIONS + '?instType=SWAP';
  const req = buildSignedRequest({
    method: 'GET', requestPath, cfg, demo: flags && flags.demo,
  });
  const json = await sendSigned(req, '查詢持倉');
  return (json.data || [])
    .filter((p) => Number(p.pos) !== 0)
    .map((p) => ({
      instId: p.instId,
      posSide: p.posSide,
      pos: Number(p.pos),
      avgPx: Number(p.avgPx),
      upl: Number(p.upl),
      mgnMode: p.mgnMode,
      lever: Number(p.lever),
    }));
}

/**
 * 查詢已平倉的部位紀錄。這是「已實現損益」的權威來源。
 *
 * 為什麼不自己用成交價去算：OKX 的 realizedPnl 已經把手續費、
 * 資金費、強平罰金都算進去了。自己算等於重做一次交易所的會計，
 * 而且永遠會差一點 —— 差在哪還查不出來。
 *
 * @param {object} params { instId, afterMs }  afterMs 之前的紀錄會被濾掉
 */
async function fetchPositionsHistory(params, cfg, flags) {
  const { instId, afterMs } = params || {};
  let requestPath = PATH_POSITIONS_HISTORY + '?instType=SWAP&limit=20';
  if (instId) requestPath += '&instId=' + encodeURIComponent(instId);

  const req = buildSignedRequest({
    method: 'GET', requestPath, cfg, demo: flags && flags.demo,
  });
  const json = await sendSigned(req, '查詢平倉紀錄');
  return (json.data || [])
    .map((p) => ({
      instId: p.instId,
      posSide: p.posSide,
      openAvgPx: Number(p.openAvgPx),
      closeAvgPx: Number(p.closeAvgPx),
      // realizedPnl 已含手續費與資金費；pnl 是純價差。兩個都留著，
      // 對不上時才有辦法判斷差額來自哪裡。
      realizedPnl: Number(p.realizedPnl),
      pnl: Number(p.pnl),
      fee: Number(p.fee),
      fundingFee: Number(p.fundingFee),
      // 平倉原因：3=止盈 4=止損 5=強平（OKX 的 type 欄位）
      closeType: String(p.type || ''),
      openedAtMs: Number(p.cTime) || null,
      closedAtMs: Number(p.uTime) || null,
      posId: p.posId,
    }))
    .filter((p) => !afterMs || !p.closedAtMs || p.closedAtMs >= afterMs);
}

/** 設定某個合約的槓桿。必須在下單前做，否則會沿用帳戶預設值。 */
async function setLeverage(params, cfg, flags) {
  const { instId, lever, mgnMode, posSide } = params;
  const body = { instId, lever: String(lever), mgnMode };
  // 逐倉的雙向持倉必須指定方向；其餘情況帶了反而會被拒。
  if (posSide) body.posSide = posSide;

  const req = buildSignedRequest({
    method: 'POST', requestPath: PATH_SET_LEVERAGE, body, cfg, demo: flags && flags.demo,
  });
  return sendSigned(req, `設定 ${instId} 槓桿`);
}

// 已經設過槓桿的合約。行程重啟就清空 —— 重設一次的成本是一個 API 呼叫，
// 而「以為設過其實沒設」的成本是整筆交易的倉位算錯。
const leverageDone = new Set();

/**
 * 確保某個合約的槓桿是設定值。同一個合約在同一次執行中只設一次。
 *
 * 【為什麼改成下單前才設，而不是開機時全設】
 * 白名單有 50 個代碼，但你一天可能只交易其中兩三個。開機時全設
 * 等於為了「可能用不到的 47 個」在啟動瞬間灌 50-100 個請求給交易所，
 * 然後撞上 50011 限流、自檢失敗、一張單都下不了。
 *
 * 下單前才設的代價是關鍵路徑多一次呼叫，但只在該合約的第一筆交易發生，
 * 之後就從快取跳過。而且它設的一定是真正要用到的那個。
 */
async function ensureLeverage(params, cfg, flags) {
  const { instId, leverage, tdMode, posMode } = params;
  if (!leverage) return { skipped: '未設定槓桿' };
  const key = `${instId}|${tdMode}|${leverage}`;
  if (leverageDone.has(key)) return { cached: true };

  // 雙向持倉的逐倉模式下，多空兩側的槓桿是分開設定的。
  // 只設 long 的話，做空那一側會沿用帳戶預設值 —— 於是固定保證金
  // 算出來的名目與實際鎖倉不符，而且只有做空時才發生。
  const sides = (tdMode === 'isolated' && posMode === 'long_short_mode')
    ? ['long', 'short'] : [undefined];
  for (const posSide of sides) {
    await setLeverage({ instId, lever: leverage, mgnMode: tdMode, posSide }, cfg, flags);
  }
  leverageDone.add(key);
  return { set: true, sides: sides.length };
}

/** 測試用：清掉「已設過」的記憶。 */
function resetLeverageCache() { leverageDone.clear(); }

/**
 * 開機自檢。在送出任何委託之前，把「會讓下單失敗的設定」一次查清楚。
 *
 * 檢查四件事：
 *   1. 金鑰可用（任何一個私有端點成功就證明了 key/secret/passphrase 三者都對）
 *   2. 帳戶模式支援永續合約
 *   3. 持倉模式（決定要不要帶 posSide）
 *   4. 合約規格與 symbols.js 的靜態表是否一致
 *
 * 第 4 點特別值得做：ctVal（每張面值）若被交易所調整而靜態表沒跟上，
 * 倉位會以錯誤的倍率計算，而且不會有任何錯誤訊息。
 */
async function preflight(params, cfg, flags) {
  const { instIds, leverage, tdMode, staticSpecs } = params;
  const report = { ok: true, warnings: [], errors: [], instruments: {} };

  const account = await fetchAccountConfig(cfg, flags);
  report.account = account;

  if (!account.canTradeSwap) {
    report.ok = false;
    report.errors.push(
      `帳戶模式為「${account.acctLvName}」，不能交易永續合約。`
      + '請到 OKX 網頁或 App 改成「合約模式」以上 —— 這個設定 API 改不了。'
    );
  }
  if (account.posMode === 'long_short_mode') {
    report.warnings.push(
      '持倉模式為「開平倉模式（雙向）」，下單會帶 posSide。'
      + '若非刻意設定，建議改為「買賣模式（單向）」，邏輯較單純。'
    );
  }

  // 每一項各自 try —— 自檢的目的是「一次把所有問題列出來」。
  // 第一項失敗就整個拋出，會變成修一項、重啟、再發現下一項，
  // 那正是這個函式該消滅的來回。
  try {
    report.equity = await fetchEquity(cfg, flags);
  } catch (err) {
    report.ok = false;
    report.errors.push('查詢權益失敗：' + err.message);
  }

  // ── 合約規格的核對 ──────────────────────────────────────
  //
  // 【這裡曾經每個代碼各打一次 API】
  // 四個幣種時沒問題。白名單擴到 50 個之後，開機瞬間對 OKX 發出
  // 約 100 個請求（每個幣一次查規格、一次設槓桿），直接撞上
  // 50011 Too Many Requests —— 自檢失敗、kill switch 開啟、一張單都下不了。
  //
  // 而這些請求本來就是多餘的：instruments.js 已經用「一次」公開端點
  // 呼叫拿回全部合約的規格了。比對用那份資料就好，不必再問一次。
  const liveSpecs = params.liveSpecs || {};
  for (const instId of instIds || []) {
    const live = liveSpecs[instId];
    if (!live) continue;
    report.instruments[instId] = live;

    const stat = staticSpecs && staticSpecs[instId];
    if (!stat) continue;
    for (const field of ['ctVal', 'lotSz', 'minSz']) {
      if (Number(stat[field]) !== Number(live[field])) {
        report.warnings.push(
          `${instId} 的 ${field} 不一致：靜態表 ${stat[field]}，交易所 ${live[field]}。`
          + '請更新 symbols.js，否則倉位會以錯誤的倍率計算。'
        );
      }
    }
  }

  // 槓桿改成「下單前才設」，不在開機時一次設 50 個 —— 見 ensureLeverage。
  // 留著這段是為了讓 npm run preflight 仍能驗證槓桿設得起來，
  // 但只驗第一個代碼，不掃全部。
  if (leverage && params.verifyLeverage && (instIds || []).length) {
    const instId = instIds[0];
    try {
      await ensureLeverage({ instId, leverage, tdMode, posMode: account.posMode },
        cfg, flags);
      report.leverageVerifiedOn = instId;
    } catch (err) {
      report.ok = false;
      report.errors.push(`${instId}：${err.message}`);
    }
  }

  return report;
}

/**
 * 查詢某個標的目前掛著的策略委託（止損止盈）。
 *
 * 【這個函式存在的理由】
 * 下單時用 attachAlgoOrds 附掛止損止盈，而下單回應 sCode=0 只代表
 * 「主單被接受」—— 它沒有保證那張附掛的保護單真的建立起來了。
 *
 * 這正是這個專案的第一條規則（HTTP 200 不代表成功）在一個我們
 * 從來沒套用過的地方。代價是：一個自以為有止損的部位，實際上是裸的，
 * 而你要到強平的時候才會知道。
 *
 * 40x 逐倉下這個差別是致命的：止損距離 0.4%～1.0%，強平距離約 2.3%。
 * 止損在的時候永遠先觸發；止損不在的時候，你賠的是全部保證金。
 */
async function fetchAlgoPending(params, cfg, flags) {
  const { instId } = params || {};
  // oco 是「止盈止損成對」的類型，attachAlgoOrds 產生的就是它。
  // conditional 是單邊觸發單，一併查是為了涵蓋只掛了一邊的情況。
  const out = [];
  for (const ordType of ['oco', 'conditional']) {
    let requestPath = PATH_ALGO_PENDING + '?ordType=' + ordType;
    if (instId) requestPath += '&instId=' + encodeURIComponent(instId);
    const req = buildSignedRequest({
      method: 'GET', requestPath, cfg, demo: flags && flags.demo,
    });
    const json = await sendSigned(req, '查詢保護單');
    for (const a of (json.data || [])) {
      out.push({
        algoId: a.algoId,
        instId: a.instId,
        ordType: a.ordType,
        state: a.state,
        slTriggerPx: a.slTriggerPx ? Number(a.slTriggerPx) : null,
        tpTriggerPx: a.tpTriggerPx ? Number(a.tpTriggerPx) : null,
        sz: a.sz ? Number(a.sz) : null,
        posSide: a.posSide || '',
      });
    }
  }
  return out;
}

/**
 * 確認某個標的的止損真的在交易所掛著。
 *
 * 回傳 { ok, hasSl, hasTp, found, note }。
 * 查不到不等於沒有 —— 網路錯誤會往上拋，由呼叫端決定怎麼處理；
 * 這裡只在「查得到而且裡面沒有止損」時回 ok:false。
 * 兩者的意思差很多：前者是「我不知道」，後者是「我確定沒有」。
 */
async function verifyProtection(params, cfg, flags) {
  const { instId, sl } = params || {};
  const list = await fetchAlgoPending({ instId }, cfg, flags);
  const mine = list.filter((a) => a.instId === instId);
  const hasSl = mine.some((a) => a.slTriggerPx !== null && a.slTriggerPx > 0);
  const hasTp = mine.some((a) => a.tpTriggerPx !== null && a.tpTriggerPx > 0);

  let note = '';
  if (hasSl && sl) {
    // 觸發價對不對得上也要看。掛著一張「別人的」止損，
    // 與沒有止損同樣危險 —— 而且更難發現。
    const near = mine.some((a) => a.slTriggerPx
      && Math.abs(a.slTriggerPx - Number(sl)) / Number(sl) < 0.005);
    if (!near) {
      note = `交易所有止損，但觸發價與這筆訊號的 ${sl} 差超過 0.5%`;
    }
  }

  return {
    ok: hasSl,
    hasSl,
    hasTp,
    found: mine.length,
    orders: mine,
    note: note || (hasSl ? '' : '交易所查不到這個標的的止損單'),
  };
}

/**
 * 組出下單請求。
 *
 * 止損止盈用 attachAlgoOrds 隨單附掛，而不是成交後另外送 algo order。
 * 理由：分兩步送，中間存在「已進場但尚無保護單」的裸倉窗口。
 * 若第二步因網路或限流失敗，就會留下一個沒有止損的部位。
 */
function buildOrderBody(p) {
  const { instId, side, orderQty, clOrdId, tdMode, sl, tp, posMode } = p;

  const body = {
    instId,
    tdMode,                                   // cross | isolated
    side: side === 'long' ? 'buy' : 'sell',
    ordType: 'market',                        // 階段 0 先用市價；階段 2 可改 limit
    sz: String(orderQty),                     // 注意：單位是「張」，不是幣
    clOrdId,                                  // 冪等鍵
    attachAlgoOrds: [{
      // 觸發價用 -1 代表市價成交，避免掛出去的保護單因價格跳空而吃不到
      slTriggerPx: String(sl),
      slOrdPx: '-1',
      tpTriggerPx: String(tp),
      tpOrdPx: '-1',
    }],
  };

  // 雙向持倉（long_short_mode）必須指定 posSide，否則 OKX 直接退件。
  // 單向持倉（net_mode）帶了反而會被拒 —— 所以是「依帳戶設定決定」，
  // 不是「一律帶上比較保險」。開機自檢查到的 posMode 就是為了這裡。
  if (posMode === 'long_short_mode') {
    body.posSide = side === 'long' ? 'long' : 'short';
  }
  return body;
}

/**
 * 下單。dryRun 為 true 時只回傳「將會送出的內容」，不呼叫交易所。
 * @returns {Promise<{sent:boolean, request:object, response?:object}>}
 */
async function placeOrder(params, cfg, flags) {
  const body = buildOrderBody(params);
  const req = buildSignedRequest({
    method: 'POST',
    requestPath: PATH_ORDER,
    body,
    cfg,
    demo: flags.demo,
  });

  if (flags.dryRun) {
    return { sent: false, request: req, response: null };
  }

  // 回應檢查與其他端點共用 —— 錯誤碼的解讀邏輯只寫一次，
  // 才不會出現「下單看得到提示、查權益卻只有一串代碼」的落差。
  const json = await sendSigned(req, '下單');
  return { sent: true, request: req, response: json };
}

module.exports = {
  okxTimestamp, sign, buildSignedRequest, buildOrderBody,
  fetchInstrument, fetchTicker, placeOrder,
  fetchAccountConfig, fetchEquity, setLeverage, ensureLeverage,
  resetLeverageCache, preflight,
  fetchPositions, fetchPositionsHistory, fetchOrderByClOrdId,
  fetchAlgoPending, verifyProtection,
  explainOkxError, readOkxResponse,
  ACCT_LEVEL,
  PATH_ORDER, PATH_INSTRUMENTS, PATH_TICKER, PATH_ACCOUNT_CONFIG,
  PATH_BALANCE, PATH_SET_LEVERAGE, PATH_POSITIONS, PATH_POSITIONS_HISTORY,
};
