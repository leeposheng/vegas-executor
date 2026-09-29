'use strict';
/**
 * Telegram 通知。
 *
 * 執行層的通知與 Apps Script 的警訊通知刻意分開：
 *   Apps Script  說「出現了什麼訊號」
 *   執行層       說「我對這個訊號做了什麼，或為什麼沒做」
 *
 * 後者才是自動交易真正需要盯的訊息。尤其是「被拒絕」的那些——
 * 如果只在成功下單時通知，系統整晚一單沒下時，你無法分辨是
 * 沒有訊號，還是程式壞了。因此拒絕也要通知。
 */

function fmt(n, digits) {
  return Number(n).toFixed(digits === undefined ? 2 : digits);
}

/** 下單決策（成功、待確認、略過或拒絕）的通知內容。 */
function renderDecision(o) {
  const { signal, decision, sizing, riskSummary, reasons, dryRun, demo, exchange,
    expiresAt, ttlSec, confirmedByUser } = o;

  const placedHead = dryRun ? '🧪 模擬計算（未送單）'
    : demo ? '📄 模擬盤下單' : '✅ 實盤下單';

  const head =
    decision === 'pending' ? '⏳ 待確認'
      : decision === 'skipped' ? '⏭ 已略過'
        : decision === 'placed'
          ? (confirmedByUser ? '👍 已確認｜' + placedHead : placedHead)
          : '⛔ 已拒絕';

  const lines = [
    `${head}｜${signal.symbol} ${signal.side === 'long' ? '做多⬆' : '做空⬇'}`,
    '─────────────',
    `[訊號] ${signal.sigId}`,
    `[週期] ${signal.timeframe}｜[等級] ${signal.grade}★` +
      (signal.score === null || signal.score === undefined
        ? '' : `｜[分數] ${signal.score}`),
    `[進場] ${signal.entry}`,
    `[止損] ${signal.sl}（距離 ${fmt(signal.riskDistance, 4)}）`,
  ];

  if (sizing) {
    lines.push(
      `[數量] ${sizing.orderQty} ${sizing.unit === 'contracts' ? '張' : '幣'}` +
        `（${fmt(sizing.baseQty, 6)} base）`,
      `[風險] 預算 ${fmt(sizing.riskAmountUsdt)} → 實際 ${fmt(sizing.actualRiskUsdt)} USDT` +
        `（用量 ${fmt(sizing.riskUtilisation * 100, 1)}%）`,
      `[名目] ${fmt(sizing.notionalUsdt)} USDT｜保證金 ${fmt(sizing.marginUsdt)} USDT`,
      `[交易所] ${exchange}`
    );
  }
  if (riskSummary) lines.push(`[閘門] ${riskSummary}`);
  if (reasons && reasons.length) {
    lines.push('[原因] ' + reasons.join('；'));
  }

  // 待確認的訊息要讓人一眼看到還剩多久。過了期限按下去也沒用，
  // 與其讓人按了才發現，不如先講清楚。
  if (decision === 'pending' && expiresAt) {
    // 不足一分鐘就用秒表示。Math.round(30/60) 會進位成「1 分鐘」，
    // 在一則有時效的訊息上寫錯時間，比不寫還糟。
    let window = '';
    if (ttlSec >= 60) {
      const mins = Math.floor(ttlSec / 60);
      const rest = ttlSec % 60;
      window = rest ? `${mins} 分 ${rest} 秒內` : `${mins} 分鐘內`;
    } else if (ttlSec > 0) {
      window = `${ttlSec} 秒內`;
    }
    lines.push('─────────────');
    lines.push(`⏱ ${window}有效，逾時自動失效`);
    lines.push('回覆「進場」或「略過」（階段 2 會換成按鈕）');
  }
  return lines.join('\n');
}

async function send(text, cfg) {
  if (!cfg.token || !cfg.chatId) {
    console.log('[notify] 未設定 Telegram，內容僅輸出至主控台：\n' + text);
    return { sent: false };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(cfg.chatId), text }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(JSON.stringify(json).slice(0, 200));
    return { sent: true };
  } catch (err) {
    // 通知失敗不可中斷主流程，但一定要留下痕跡
    console.error('[notify] Telegram 傳送失敗：' + err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { send, renderDecision };
