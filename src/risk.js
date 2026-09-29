'use strict';

/**
 * 目前生效的持倉上限。
 *
 * 優先序：Telegram 設的覆寫值 → 環境變數的預設值，兩者都夾在天花板底下。
 * 夾一次不夠 —— 覆寫值是從外部進來的，而天花板是唯一保證它不會失控的地方。
 */
function effectiveMaxConcurrent(store, risk) {
  const ceiling = risk.maxConcurrentCeiling || risk.maxConcurrent;
  const override = store && store.getOverride ? store.getOverride('maxConcurrent') : undefined;
  const wanted = Number.isFinite(Number(override)) ? Number(override) : risk.maxConcurrent;
  return Math.max(1, Math.min(wanted, ceiling));
}
/**
 * 目前生效的日損上限。
 *
 * 方向：Telegram 調大有天花板（DAILY_LOSS_CEILING_USDT），調小不限 ——
 * 因為調小永遠是往安全的方向走，不需要保護。
 */
function effectiveDailyLossLimit(store, risk) {
  const ceiling = risk.dailyLossCeilingUsdt || risk.dailyLossLimitUsdt;
  const override = store && store.getOverride ? store.getOverride('dailyLossLimit') : undefined;
  const wanted = Number.isFinite(Number(override)) ? Number(override) : risk.dailyLossLimitUsdt;
  return Math.max(1, Math.min(wanted, ceiling));
}

/**
 * 目前生效的冷卻分鐘數。
 *
 * 方向與日損上限「相反」：環境變數是下限，Telegram 只能調更長。
 * 冷卻調短才是危險的那一邊，所以要保護的是下界。
 */
function effectiveCooldownMin(store, risk) {
  const floor = Number(risk.dailyResetCooldownMin) || 0;
  const override = store && store.getOverride ? store.getOverride('resetCooldownMin') : undefined;
  const wanted = Number.isFinite(Number(override)) ? Number(override) : floor;
  return Math.max(floor, Math.min(wanted, 720));
}

/**
 * 重置後的冷卻狀態。
 *
 * 回傳 { active, remainMs, remainMin }。沒設冷卻或今天沒重置過就是 active:false。
 */
function resetCooldown(store, risk, now) {
  const mins = effectiveCooldownMin(store, risk);
  if (!mins || !store || !store.dailyResetInfo) {
    return { active: false, remainMs: 0, remainMin: 0 };
  }
  const info = store.dailyResetInfo(now);
  if (!info.lastAt) return { active: false, remainMs: 0, remainMin: 0 };
  const remainMs = info.lastAt + mins * 60000 - (now || Date.now());
  return {
    active: remainMs > 0,
    remainMs: Math.max(0, remainMs),
    remainMin: Math.ceil(Math.max(0, remainMs) / 60000),
  };
}

/** 日損閘門的判斷與說明文字。evaluate 與 recheck 共用，避免兩邊寫法漂移。 */
function dailyLossGate(store, risk, now) {
  const effective = store.dailyPnlSinceReset
    ? store.dailyPnlSinceReset(now)
    : store.today(now).realisedPnlUsdt;
  const limit = effectiveDailyLossLimit(store, risk);
  const exceeded = -effective >= limit;
  if (!exceeded) return { passed: true, detail: '' };

  const info = store.dailyResetInfo ? store.dailyResetInfo(now) : null;
  let detail = `當日已實現虧損 ${(-effective).toFixed(2)} USDT `
    + `達上限 ${limit} USDT`;
  // 重置過就一定要把真實數字一起說出來。只顯示重置後的計數，
  // 會讓人以為今天才虧 50 —— 而實際上是 112。
  if (info && info.count > 0) {
    detail += `（今日已重置 ${info.count} 次，真實日損 `
      + `${(-info.realisedPnlUsdt).toFixed(2)} USDT）`;
  }
  return { passed: false, detail };
}

/**
 * 風控閘門。
 *
 * 設計成「一組獨立的布林檢查，全部通過才放行」，而不是散落在下單流程裡的
 * if 判斷。好處是每一道閘門都能單獨測試，而且拒絕原因可以完整記錄下來——
 * 事後檢討「為什麼這筆沒進場」時，這份紀錄就是答案。
 *
 * 順序刻意由「成本最低、最該優先擋下」排到「需要讀狀態」：
 *   1. kill switch        ← 人為緊急停止，最高優先
 *   2. 冪等（重複訊號）
 *   3. 品質等級
 *   4. 週期白名單
 *   5. 每日虧損上限
 *  5b. 日損重置後的冷卻
 *   6. 同時持倉上限
 *   7. 同標的重複持倉
 */

function evaluate(signal, ctx) {
  const { store, risk } = ctx;
  const gates = [];
  const add = (name, passed, detail) => gates.push({ name, passed, detail: detail || '' });

  // 1. kill switch
  add('kill_switch', !store.isHalted(),
    store.isHalted() ? `系統已停止下單：${store.haltedReason()}` : '');

  // 2. 冪等
  const dup = store.isProcessed(signal.sigId, ctx.exchange);
  add('idempotency', !dup,
    dup ? `sig_id ${signal.sigId} 已處理過（${(store.getProcessed(signal.sigId, ctx.exchange) || {}).outcome}）` : '');

  // 3. 品質等級
  add('min_grade', signal.grade >= risk.minGrade,
    signal.grade >= risk.minGrade ? '' :
      `等級 ${signal.grade} 低於下限 ${risk.minGrade}`);

  // 4. 週期白名單
  const tfOk = risk.allowedTimeframes.includes(String(signal.timeframe));
  add('timeframe', tfOk,
    tfOk ? '' : `週期 ${signal.timeframe} 不在白名單 [${risk.allowedTimeframes.join(', ')}]`);

  // 5. 每日虧損上限
  const loss = dailyLossGate(store, risk);
  add('daily_loss_limit', loss.passed, loss.detail);

  // 5b. 重置後的冷卻。
  //
  // 與日損上限分開成獨立閘門，是因為它們擋的是不同東西：
  // 上限擋的是「額度用完」，冷卻擋的是「剛按完重置鍵的那個人」。
  // 合併成一道的話，重置成功的當下冷卻就被一起解掉了 —— 而那正是
  // 最該擋住的那一刻。
  const cool = resetCooldown(store, risk);
  add('reset_cooldown', !cool.active,
    cool.active ? `日損重置後冷卻中，還有 ${cool.remainMin} 分鐘` : '');

  // 6. 同時持倉上限
  //
  // 按交易所分別計算。雙邊下單時一筆訊號會在兩家各開一個部位，
  // 合起來算的話 MAX_CONCURRENT_POSITIONS=3 只夠一點五筆訊號 ——
  // 而那個數字的意思一直是「同時最多幾個標的在場」。
  const openCount = store.openPositionCount(ctx.exchange);
  const maxNow = effectiveMaxConcurrent(store, risk);
  const underMax = openCount < maxNow;
  add('max_concurrent', underMax,
    underMax ? '' : `目前持倉 ${openCount} 筆，已達上限 ${maxNow}`);

  // 7. 同標的重複持倉。同一個幣在同一家同時開兩個部位會讓風險加倍，
  //    而且與指標的「加倉」語意不同，階段 0 一律拒絕。
  //    跨交易所的同標的則是刻意允許的 —— 那正是雙邊下單的意思。
  const dupSymbol = store.hasPositionForSymbol(signal.symbol, ctx.exchange);
  add('no_duplicate_symbol', !dupSymbol,
    dupSymbol ? `${signal.symbol} 已有未平倉部位` : '');

  const failed = gates.filter((g) => !g.passed);
  return {
    passed: failed.length === 0,
    gates,
    reasons: failed.map((g) => `${g.name}: ${g.detail}`),
  };
}

/**
 * 按下確認的當下，重新檢查「會隨時間改變」的那幾道閘門。
 *
 * 訊號產生到你按下按鈕之間可能過了幾分鐘，這段期間狀況會變：
 * 你可能按了緊急停止、可能有另一筆訊號先成交把持倉額度用掉、
 * 當日虧損可能已經觸頂。不重查就等於用舊的世界觀下單。
 *
 * 刻意「不」重查的項目：
 *   idempotency —— 待確認紀錄本身就是那筆訊號，必然已標記為處理過
 *   min_grade / timeframe —— 訊號的屬性，不隨時間改變
 */
function recheck(signal, ctx) {
  const { store, risk } = ctx;
  const gates = [];
  const add = (name, passed, detail) => gates.push({ name, passed, detail: detail || '' });

  add('kill_switch', !store.isHalted(),
    store.isHalted() ? `系統已停止下單：${store.haltedReason()}` : '');

  const loss = dailyLossGate(store, risk);
  add('daily_loss_limit', loss.passed, loss.detail);

  const cool = resetCooldown(store, risk);
  add('reset_cooldown', !cool.active,
    cool.active ? `日損重置後冷卻中，還有 ${cool.remainMin} 分鐘` : '');

  const openCount = store.openPositionCount(ctx.exchange);
  const maxNow = effectiveMaxConcurrent(store, risk);
  add('max_concurrent', openCount < maxNow,
    openCount < maxNow ? '' :
      `目前持倉 ${openCount} 筆，已達上限 ${maxNow}`);

  const dupSymbol = store.hasPositionForSymbol(signal.symbol, ctx.exchange);
  add('no_duplicate_symbol', !dupSymbol,
    dupSymbol ? `${signal.symbol} 已有未平倉部位` : '');

  const failed = gates.filter((g) => !g.passed);
  return {
    passed: failed.length === 0,
    gates,
    reasons: failed.map((g) => `${g.name}: ${g.detail}`),
  };
}

/** 供日誌與 Telegram 使用的緊湊摘要，例如 "✓停止 ✓冪等 ✗等級 ✓週期…" */
function summarise(result) {
  const zh = {
    kill_switch: '停止',
    idempotency: '冪等',
    min_grade: '等級',
    timeframe: '週期',
    daily_loss_limit: '日損',
    reset_cooldown: '冷卻',
    max_concurrent: '倉數',
    no_duplicate_symbol: '重複',
  };
  return result.gates
    .map((g) => (g.passed ? '✓' : '✗') + (zh[g.name] || g.name))
    .join(' ');
}

module.exports = {
  effectiveMaxConcurrent, effectiveDailyLossLimit, effectiveCooldownMin,
  resetCooldown, dailyLossGate, evaluate, recheck, summarise };
