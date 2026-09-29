'use strict';
/**
 * 訊號解析與驗證。
 *
 * 這一層的職責只有一個：把外部送進來的任意 JSON，變成「可信的、型別正確的」
 * 內部物件，或明確拒絕。下游的倉位計算與下單都假設這裡已經驗過，
 * 所以這裡放寬一格，後面就可能下出方向相反或數量荒謬的單子。
 *
 * 驗證分三層：
 *   結構層 — 欄位存在、型別正確
 *   語意層 — 數值合理、SL 在正確的一側、TP 排序正確
 *   時效層 — 訊號沒有過期（重放保護）
 */

const VALID_SIDES = ['long', 'short'];

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {object} raw  webhook 收到的已解析 JSON
 * @param {object} opts { nowMs, maxAgeSec }
 * @returns {{ok: boolean, signal?: object, errors?: string[]}}
 */
function parseSignal(raw, opts) {
  const errors = [];
  const nowMs = opts && opts.nowMs !== undefined ? opts.nowMs : Date.now();
  const maxAgeSec = opts && opts.maxAgeSec !== undefined ? opts.maxAgeSec : 60;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['payload 不是 JSON 物件'] };
  }

  // ---- 結構層 ----
  const sigId = typeof raw.sig_id === 'string' ? raw.sig_id.trim() : '';
  if (!sigId) errors.push('sig_id 缺少或非字串');
  else if (!/^[A-Za-z0-9._:-]{8,64}$/.test(sigId)) {
    errors.push('sig_id 格式不合法（僅允許英數與 . _ : -，長度 8-64）');
  }

  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : '';
  if (!symbol) errors.push('symbol 缺少或非字串');

  const tf = raw.tf === undefined ? '' : String(raw.tf).trim();
  if (!tf) errors.push('tf 缺少');

  const side = typeof raw.side === 'string' ? raw.side.trim().toLowerCase() : '';
  if (!VALID_SIDES.includes(side)) errors.push('side 必須是 long 或 short');

  if (!isFiniteNumber(raw.ts)) errors.push('ts 缺少或非數字（需為毫秒時間戳）');
  if (!isFiniteNumber(raw.entry)) errors.push('entry 缺少或非數字');
  if (!isFiniteNumber(raw.sl)) errors.push('sl 缺少或非數字');

  const grade = Number(raw.grade);
  if (![1, 2, 3].includes(grade)) errors.push('grade 必須是 1、2 或 3');

  // score 為選填。它只用於通知文字，不參與任何閘門或倉位決策，
  // 而指標 v11.8 的文字訊息只帶 [品質]（等級）不帶分數，
  // 因此強制要求會讓所有真實訊號被擋下。有給就驗，沒給就是 null。
  let score = null;
  if (raw.score !== undefined && raw.score !== null) {
    score = Number(raw.score);
    if (!isFiniteNumber(score) || score < 0 || score > 100) {
      errors.push('score 若提供，必須是 0-100 的數字');
    }
  }

  const tp = Array.isArray(raw.tp) ? raw.tp : null;
  if (!tp || tp.length === 0) errors.push('tp 必須是非空陣列');
  else if (!tp.every(isFiniteNumber)) errors.push('tp 內含非數字');

  // 結構層不過就直接退回，避免後面拿 undefined 做算術
  if (errors.length) return { ok: false, errors };

  // ---- 語意層 ----
  const entry = raw.entry;
  const sl = raw.sl;

  if (entry <= 0) errors.push('entry 必須大於 0');
  if (sl <= 0) errors.push('sl 必須大於 0');

  // 方向與止損側別：做多的 SL 必須低於進場價，做空反之。
  // 這一條最重要 —— 方向寫反會讓風險距離變成負數，倉位計算直接失控。
  if (side === 'long' && sl >= entry) {
    errors.push(`做多訊號的 sl(${sl}) 必須低於 entry(${entry})`);
  }
  if (side === 'short' && sl <= entry) {
    errors.push(`做空訊號的 sl(${sl}) 必須高於 entry(${entry})`);
  }

  // 風險距離不可過小，否則會算出天文數字的倉位。
  // 以 entry 的 0.02% 作為下限（足以涵蓋所有正常的 tick size）。
  const riskDistance = Math.abs(entry - sl);
  if (riskDistance < entry * 0.0002) {
    errors.push(`風險距離過小（${riskDistance}），可能是資料錯誤`);
  }

  // TP 必須在獲利方向，且由近而遠排列
  tp.forEach((t, i) => {
    if (side === 'long' && t <= entry) errors.push(`tp[${i}]=${t} 未在做多的獲利方向`);
    if (side === 'short' && t >= entry) errors.push(`tp[${i}]=${t} 未在做空的獲利方向`);
    if (i > 0) {
      const ordered = side === 'long' ? t > tp[i - 1] : t < tp[i - 1];
      if (!ordered) errors.push(`tp[${i}] 未依由近而遠排序`);
    }
  });

  // ---- 時效層（重放保護）----
  const ageSec = (nowMs - raw.ts) / 1000;
  if (ageSec > maxAgeSec) {
    errors.push(`訊號已過期 ${ageSec.toFixed(1)} 秒（上限 ${maxAgeSec} 秒）`);
  }
  // 時間戳明顯在未來，通常代表送訊端時鐘錯誤，同樣拒絕
  if (ageSec < -30) {
    errors.push(`訊號時間戳位於未來 ${(-ageSec).toFixed(1)} 秒，請檢查送訊端時鐘`);
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    signal: {
      version: String(raw.v || 'unknown'),
      sigId,
      tsMs: raw.ts,
      ageSec,
      symbol,
      timeframe: tf,
      grade,
      score,
      side,
      entry,
      sl,
      tp: tp.slice(),
      riskDistance,
    },
  };
}

/**
 * 由 sig_id 推導交易所可用的 client order id。
 * OKX 的 clOrdId 限 1-32 字元英數，所以取雜湊而非原字串。
 */
function clientOrderId(sigId, prefix) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(String(sigId)).digest('hex');
  return (String(prefix || 'vg') + hash).slice(0, 32);
}

module.exports = { parseSignal, clientOrderId, VALID_SIDES };
