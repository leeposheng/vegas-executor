'use strict';
/**
 * 進場價漂移檢查。
 *
 * ── 為什麼需要它 ──
 *
 * 這個漏洞是「按鈕確認」這個功能自己製造出來的。
 *
 * 訊號產生時算好倉位：entry 791.3、sl 783.8 → 風險距離 7.5，
 * 用 50 USDT 的預算反推出數量。然後卡片送到你手機，你看了三十秒才按。
 *
 * 那三十秒裡價格會動。假設漲到 795，你用市價買在 795，止損還在 783.8：
 *
 *   實際風險距離 = 795 − 783.8 = 11.2   （不是 7.5）
 *   實際風險     = 數量 × 11.2 ≈ 74.7   （不是 50）
 *
 * 超出預算 49%，而且完全無聲 —— 卡片上寫的每個數字都還在，
 * 只是它們描述的是一筆已經不存在的交易。
 *
 * 反方向一樣糟。價格跌到 788，風險距離縮到 4.2，重算數量會膨脹到
 * 原本的 1.8 倍 —— 更大的倉位配更近的止損，被掃出場的機率大增。
 *
 * ── 處理方式 ──
 *
 * 1. 價格已經穿過止損 → 拒絕。這筆交易的前提沒了。
 * 2. 價格已經過了第一目標 → 拒絕。那叫追價，不是進場。
 * 3. 風險距離變化超出容許範圍 → 拒絕，而不是硬著頭皮下。
 * 4. 在容許範圍內 → 以「現價」重算倉位，讓實際風險回到預算。
 *
 * 第 4 點是重點：不是放行原本的數量，而是重算。放行等於接受超額風險，
 * 重算才是真的把風險控制住。重算後的數量會和卡片上不同，
 * 所以結果必須回報給使用者，不能默默換掉。
 */

/**
 * @param {object} p
 * @param {object} p.signal      待確認的訊號（entry / sl / tp / side）
 * @param {number} p.livePrice   現價
 * @param {object} p.limits      { maxWiden, maxTighten }
 * @returns {{ok:boolean, verdict:string, reason?:string, metrics:object}}
 */
function assessDrift(p) {
  const { signal, livePrice, limits } = p;
  const isLong = signal.side === 'long';
  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const live = Number(livePrice);

  const metrics = { entry, sl, livePrice: live };

  if (!Number.isFinite(live) || live <= 0) {
    return { ok: false, verdict: 'no_price', metrics,
      reason: '無法取得現價，拒絕下單。以無法驗證的價格計算倉位，正是這道檢查要防的事。' };
  }

  const originalDistance = Math.abs(entry - sl);
  if (!(originalDistance > 0)) {
    return { ok: false, verdict: 'invalid', metrics, reason: '原始風險距離為 0' };
  }

  // 帶正負號的漂移，以 R 表示。正值 = 進場價變差（離止損更遠）。
  // 用 R 而不是百分比，是因為 R 直接對應「倉位會變多少」，
  // 而 0.3% 在 BTC 和在 LINK 上代表的意義完全不同。
  const driftR = (isLong ? (live - entry) : (entry - live)) / originalDistance;
  metrics.originalDistance = Number(originalDistance.toFixed(8));
  metrics.driftR = Number(driftR.toFixed(4));
  metrics.driftPct = Number((((live - entry) / entry) * 100).toFixed(4));

  // 1. 現價已經穿過止損 —— 這筆交易在你按下去之前就已經結束了
  const crossedSl = isLong ? (live <= sl) : (live >= sl);
  if (crossedSl) {
    return { ok: false, verdict: 'sl_crossed', metrics,
      reason: `現價 ${live} 已穿過止損 ${sl}，這筆訊號的前提已不成立` };
  }

  // 2. 現價已經過了第一目標 —— 進場只剩追價
  const tp1 = Array.isArray(signal.tp) && signal.tp.length ? Number(signal.tp[0]) : null;
  if (tp1 !== null && Number.isFinite(tp1)) {
    const passedTp1 = isLong ? (live >= tp1) : (live <= tp1);
    if (passedTp1) {
      return { ok: false, verdict: 'tp1_passed', metrics,
        reason: `現價 ${live} 已達第一目標 ${tp1}，此時進場等同追價` };
    }
  }

  // 3. 風險距離的變化幅度
  const newDistance = Math.abs(live - sl);
  const ratio = newDistance / originalDistance;
  metrics.newDistance = Number(newDistance.toFixed(8));
  metrics.distanceRatio = Number(ratio.toFixed(4));
  // 數量與風險距離成反比，先算出來讓使用者一眼看到影響
  metrics.qtyRatio = Number((1 / ratio).toFixed(4));

  const maxWiden = limits.maxWiden;
  const maxTighten = limits.maxTighten;

  if (ratio > maxWiden) {
    return { ok: false, verdict: 'drifted_against', metrics,
      reason: `進場價已偏離 ${driftR.toFixed(2)}R，風險距離放大為原本的 `
        + `${ratio.toFixed(2)} 倍（上限 ${maxWiden}）。若照原數量下單，`
        + `實際風險會是預算的 ${ratio.toFixed(2)} 倍` };
  }
  if (ratio < maxTighten) {
    return { ok: false, verdict: 'drifted_toward', metrics,
      reason: `現價已接近止損，風險距離縮為原本的 ${ratio.toFixed(2)} 倍`
        + `（下限 ${maxTighten}）。重算會把數量放大到 ${(1 / ratio).toFixed(2)} 倍，`
        + `更大的倉位配更近的止損，不是原本核准的那筆交易` };
  }

  return { ok: true, verdict: ratio === 1 ? 'unchanged' : 'resize', metrics };
}

module.exports = { assessDrift };
