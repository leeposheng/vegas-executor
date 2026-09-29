'use strict';
/**
 * 下單路徑的序列化閘。
 *
 * 【要解決的問題】
 * 風控閘門讀的是 store 的記憶體狀態，但寫回（markProcessed／addPosition）
 * 發生在交易所回應之後。中間隔著三個 await：查合約規格、查權益、下單本身。
 *
 * 於是兩筆訊號同時進來時，兩邊都會在對方寫回之前讀到「還沒有部位」，
 * 然後兩邊都通過 max_concurrent 與 no_duplicate_symbol，兩張單都送出去。
 * 實測：MAX_CONCURRENT_POSITIONS=1，同時送四筆 → 四筆全部成交。
 *
 * TradingView 同一根 K 棒重送、Apps Script 補送佇列、使用者連按兩次按鈕，
 * 都會產生這個時序。它不是理論上的競態，是這個系統日常會遇到的。
 *
 * 【為什麼用序列化而不是佔位】
 * 佔位（先把 sigId 塞進一個 reserving 集合）要改動 store 的三個查詢函式，
 * 而且失敗路徑一多就容易漏掉釋放 —— 漏掉的後果是額度永久被吃掉。
 *
 * 序列化把問題消滅在源頭：同一時間只有一條下單流程在跑，
 * 「檢查」與「寫回」之間不可能插進另一筆。代價是第二筆要等第一筆做完，
 * 而這個系統一小時只有數筆訊號，等待幾秒毫無影響。
 *
 * 【等待上限】
 * 但序列化本身帶來一個新風險：若第一筆卡住（交易所沒回應、網路半死），
 * 後面的全部跟著卡。所以排隊有上限 —— 等太久就直接拒絕，
 * 並且說清楚是排隊逾時，而不是讓訊號無聲無息地消失在佇列裡。
 */

class Gate {
  constructor(opts) {
    const o = opts || {};
    // 佇列最長等待。超過就拒絕 —— 一筆等了 20 秒才下的單，
    // 價格早就不是訊號當下那個價了，拒絕比遲到正確。
    this.maxWaitMs = o.maxWaitMs || 20000;
    // 單一工作的執行上限。防止一個永遠不回應的請求鎖死整條路徑。
    this.maxRunMs = o.maxRunMs || 30000;
    this.tail = Promise.resolve();
    this.depth = 0;
  }

  /** 目前有幾筆在排隊（含執行中）。給 /health 用。 */
  get queued() { return this.depth; }

  /**
   * 把 fn 排進佇列。回傳 fn 的結果。
   * 排隊逾時會丟出帶有 code='gate_timeout' 的錯誤。
   */
  run(fn, label) {
    this.depth += 1;
    const enqueuedAt = Date.now();

    // work 在「fn 真正跑完」時才 settle。
    //
    // 【這裡曾經寫錯，而且錯得很隱蔽】
    // 原本是 `this.tail.then(() => withTimeout(fn(), ...))`，
    // 也就是把 race 的結果接到 tail 上。但 Promise.race 只是讓外層
    // 提早 settle —— 被包住的 fn 沒有被中止，還在背景跑。
    // 於是逾時的那一刻佇列就放行了下一筆，而上一筆的 fn 稍後才會
    // 執行 store.addPosition。兩者交錯，序列化的保證整個失效，
    // 而且失效的時機正是「交易所沒回應」——也就是它最該生效的時候。
    //
    // 所以 tail 必須鏈在 fn 本身上。逾時只影響「呼叫端等多久」，
    // 不影響「佇列什麼時候放行」。
    // 執行時限的計時「從 fn 真正開始跑」才起算，不是從排進佇列起算。
    //
    // 兩者的差別不是精度問題，是語意問題：run_timeout 的訊息會叫人
    // 「去交易所確認這筆是否已成交」。若計時涵蓋排隊時間，一筆還在
    // 佇列裡、連請求都沒送出的工作也會拿到這則訊息 —— 那是錯誤的指示。
    let armRunTimer;
    const started = new Promise((resolve) => { armRunTimer = resolve; });

    const work = this.tail.then(async () => {
      const waited = Date.now() - enqueuedAt;
      if (waited > this.maxWaitMs) {
        const err = new Error(
          `排隊等待 ${Math.round(waited / 1000)} 秒已超過上限 `
          + `${Math.round(this.maxWaitMs / 1000)} 秒，拒絕執行`
          + (label ? `（${label}）` : '')
          + '。前一筆下單可能卡在交易所回應。'
        );
        err.code = 'gate_timeout';
        throw err;
      }
      armRunTimer();
      return fn();
    });

    // tail 接住錯誤，否則一次失敗會讓後面所有工作跟著 reject。
    // 刻意不把錯誤往下傳 —— 佇列要繼續動，錯誤由呼叫端自己處理。
    this.tail = work.then(() => undefined, () => undefined);
    work.then(() => { this.depth -= 1; }, () => { this.depth -= 1; });

    // 呼叫端拿到的是「加了時限」的版本：等太久就先回覆，
    // 但佇列仍然在等真正的 fn 結束。
    //
    // 代價要說清楚：一個永遠不回應的 fn 會讓佇列永久停住。
    // 那是刻意的取捨 —— 後續訊號會因 maxWaitMs 被明確拒絕，
    // 而「明確拒絕」遠優於「在不知道前一筆下場的情況下再下一單」。
    if (!this.maxRunMs) return work;
    const runTimeout = started.then(() => new Promise((_, reject) => {
      const t = setTimeout(() => {
        const err = new Error(
          `執行超過 ${Math.round(this.maxRunMs / 1000)} 秒未完成`
          + (label ? `（${label}）` : '')
          + '。請到交易所確認這筆是否已成交。'
        );
        err.code = 'run_timeout';
        reject(err);
      }, this.maxRunMs);
      if (t.unref) t.unref();
    }));
    // runTimeout 若沒被用到會是一個沒人接的 rejection，先掛一個空 handler
    runTimeout.catch(() => {});
    return Promise.race([work, runTimeout]);
  }
}

/** 給一個 Promise 加上時限。逾時丟出 code='run_timeout'。 */
function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(
        `執行超過 ${Math.round(ms / 1000)} 秒未完成`
        + (label ? `（${label}）` : '')
        + '。請到交易所確認這筆是否已成交。'
      );
      err.code = 'run_timeout';
      reject(err);
    }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout])
    .finally(() => { if (timer) clearTimeout(timer); });
}

module.exports = { Gate, withTimeout };
