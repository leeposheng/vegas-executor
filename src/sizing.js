'use strict';
/**
 * 倉位計算：由「風險金額」反推下單數量。
 *
 * 核心公式
 *   風險金額   = 權益 × 單筆風險比例
 *   風險距離   = |entry − sl|              （每 1 單位 base 幣的潛在虧損，以 quote 計）
 *   base 數量  = 風險金額 ÷ 風險距離
 *
 * 由此，不論標的波動大小，單筆訊號一旦止損，虧損金額都會接近同一個數字。
 * 這與「每次固定下 0.01 BTC」有本質差異：後者在 SL 較遠時風險會放大數倍。
 *
 * 兩個關鍵細節：
 *
 * 【無條件捨去，不四捨五入】
 *   數量必須向下對齊到交易所的最小增量。若向上進位，實際風險會超過預算。
 *   捨去後若低於最小下單量，做法是「拒單」而非「湊到最小量」——
 *   湊上去等於默默放大風險，這類妥協是實單虧損的常見來源。
 *
 * 【OKX 的張數不是幣數】
 *   OKX 永續的 sz 單位是合約張數，1 張 = ctVal 個 base 幣。
 *   BTC-USDT-SWAP 的 ctVal 為 0.01，所以 0.05 BTC = 5 張。
 *   把 0.05 直接填進 sz 會變成 0.05 張（約 0.0005 BTC），差了兩個數量級。
 */

/** 四捨五入到小數四位。顯示用的數字都經過它，才能彼此對得起來。 */
function round4(n) {
  return Number(Number(n).toFixed(4));
}

/** 無條件捨去到 step 的整數倍，並修掉浮點誤差。 */
function floorToStep(value, step) {
  if (!(step > 0)) return value;
  const decimals = (String(step).split('.')[1] || '').length;
  const n = Math.floor((value + 1e-12) / step) * step;
  return Number(n.toFixed(Math.max(decimals, 8)));
}

/**
 * 固定保證金模式。
 *
 * 與風險反推模式的根本差異：
 *
 *   風險反推  固定「虧損」，名目與保證金隨止損距離浮動
 *   固定保證金 固定「保證金」，虧損隨止損距離浮動
 *
 * 後者的核心式子：
 *
 *   名目 = 保證金 × 槓桿
 *   虧損 = 名目 × 止損距離%  +  名目 × 手續費率 × 2
 *
 * 於是槓桿從「與風險無關的參數」變成「風險旋鈕」—— 這與風險反推模式
 * 剛好相反，所以兩種模式不能混用同一組直覺。
 *
 * 【為什麼用固定槓桿 + 虧損區間閘門，而不是每筆反算槓桿】
 *
 * 反算槓桿（讓虧損永遠正好等於目標）在數學上更漂亮，但工程上有兩個問題：
 *   1. 每筆都要先呼叫 set-leverage，在下單的關鍵路徑上多一次往返
 *   2. 該端點在「已有持倉或掛單」時會被拒（OKX 59000）
 * 固定槓桿只要設定一次，代價是虧損會在一個區間內浮動 ——
 * 而那個區間正好可以拿來當閘門：止損太緊或太鬆的訊號本來就該拒絕。
 *
 * 【務必搭配逐倉（isolated）】
 * 「保證金 100」在全倉模式下不是真的邊界 —— 整個帳戶都在背書，
 * 跳空穿過止損時虧損可以遠超過 100。逐倉才讓 100 成為真正的上限。
 */
/**
 * 虧損落在區間外時，把判斷需要的數字算出來。
 *
 * 【只算數字，不寫句子】
 * 排版屬於卡片，不屬於這裡。這個函式回傳的是 feeShare、rr、breakeven
 * 這種可以直接比大小的值 —— 卡片要一行還是三行、要不要顯示，
 * 由卡片決定。混在一起的話，改版面就得動倉位計算，那是兩件事。
 *
 * 【為什麼要算手續費佔比】
 * 因為使用者看到「虧損太小被擋」時，第一個念頭是加槓桿。而
 *   手續費佔比 ＝ 費率 ÷（止損距離 ＋ 費率）
 * 分子分母都與名目成正比，所以這個比例**完全不隨槓桿改變**。
 * 把它印在卡片上，比任何文字說明都能更快讓人放棄那個念頭。
 *
 * 【為什麼只在「過寬」時給建議槓桿】
 * 過寬是名目太大，降槓桿名目變小、虧損變小，而手續費佔比不動 ——
 * 調整是真的划算。過緊則相反，升槓桿只是用同一個劣勢賭更大的金額，
 * 給了建議等於鼓勵一件算術上站不住的事。
 */
function bandNumbers(o) {
  const { stopPct, feeRateOneWay, tp, entry, estLossUsdt,
    lossMaxUsdt, marginUsdt, tooSmall } = o;
  const feePct = feeRateOneWay * 2;
  const out = { feeShare: round4(feePct / (stopPct + feePct)) };

  const tp1 = Array.isArray(tp) ? Number(tp[0]) : null;
  if (tp1 && entry) {
    const tpPct = Math.abs(tp1 - Number(entry)) / Number(entry);
    const winNet = tpPct - feePct;
    const lossCost = stopPct + feePct;
    out.rr = round4(winNet / lossCost);
    // 扣費後獲利為負時，打平勝率沒有意義（永遠達不到）。
    // 回 null 讓卡片改印警語，而不是印一個 >100% 的數字。
    out.breakeven = winNet > 0 ? round4(lossCost / (winNet + lossCost)) : null;
  }

  if (!tooSmall) {
    out.suggestLeverage = Math.max(1,
      Math.floor(lossMaxUsdt / (marginUsdt * (stopPct + feePct))));
  }
  return out;
}

/**
 * 自動決定這一筆的槓桿與保證金。
 *
 * 【為什麼是兩個變數一起解】
 * 名目 ＝ 保證金 × 槓桿，而虧損只取決於名目。所以這兩個數字對
 * 「賠多少」是同一件事，真正把它們分開的是另外兩件：
 *   槓桿單獨決定強平距離（≈ 1/槓桿）
 *   保證金單獨決定鎖住多少本金
 * 因此解法是：先用最小保證金配最高「安全」槓桿，湊不到最低虧損
 * 時才動保證金。這個順序讓佔用的本金永遠是最小的那一個。
 *
 * 四道約束，缺一不可：
 *   1. 峰值槓桿      LEVERAGE，只往下夾不往上
 *   2. 強平緩衝      1/槓桿 ≥ 止損 × MIN_LIQ_CUSHION
 *   3. 名目上限      保證金 × 槓桿 ≤ maxNotional（權益的倍數）
 *   4. 單筆虧損上限  名目 × (止損+費率) ≤ lossMax
 *
 * 【第 3 道是後來補的，因為它原本不在這裡】
 * 舊版只夾 1、2、4，算完才在外面檢查名目上限 —— 於是止損 0.5% 的
 * 訊號會算出 40x／名目 4000，撞上 3000 的上限被拒，
 * 而 30x（名目 3000）明明是合法的，只是沒人去算。
 * 拒絕訊息還會寫「名目超過上限」，看起來像參數設錯，
 * 實際上是這個函式沒把那道限制納入考慮。
 */
function autoSize(o) {
  const { baseLeverage, stopPct, feeRateOneWay, marginMin, marginMax,
    lossMinUsdt, lossMaxUsdt, maxNotionalUsdt, minLiqCushion } = o;
  const tot = stopPct + feeRateOneWay * 2;

  // 槓桿的天花板：峰值與強平緩衝，取嚴格者
  const byCushion = Math.floor(1 / (stopPct * minLiqCushion));
  const levCap = Math.max(1, Math.min(baseLeverage, byCushion));

  // 先用最小保證金。本金佔用越少越好 —— 同樣一筆交易，
  // 鎖 100 還是 300 對損益沒有影響，對「還能開幾筆」影響很大。
  let margin = marginMin;
  let lev = Math.min(
    levCap,
    Math.floor(lossMaxUsdt / (margin * tot)),      // 不超過單筆虧損上限
    Math.floor(maxNotionalUsdt / margin)           // 不超過名目上限
  );
  if (!(lev >= 1)) lev = 1;

  let loss = margin * lev * tot;

  // 湊不到最低虧損時，才考慮加保證金。
  //
  // 能加的前提是槓桿已經頂到天花板 —— 否則該先升槓桿，那不花本金。
  // 加完仍受名目上限約束：保證金 × 槓桿永遠不能超過它。
  let marginRaised = false;
  if (loss < lossMinUsdt && lev >= levCap) {
    const needNotional = lossMinUsdt / tot;
    const allowedNotional = Math.min(needNotional, maxNotionalUsdt);
    const wantMargin = allowedNotional / lev;
    if (wantMargin > margin) {
      margin = Math.min(marginMax, wantMargin);
      loss = margin * lev * tot;
      marginRaised = margin > marginMin;
    }
  }

  // 說明是哪一道夾的。卡片要能回答「為什麼是這個數字」，
  // 而每一道的處置方式不同：緩衝是安全考量，名目上限是資金規模，
  // 虧損上限是預算 —— 混成一句「已自動調整」等於沒說。
  let reason = '';
  if (lev < baseLeverage) {
    const byLoss = Math.floor(lossMaxUsdt / (marginMin * tot));
    const byCap = Math.floor(maxNotionalUsdt / marginMin);
    if (byCushion <= byLoss && byCushion <= byCap) {
      reason = `強平緩衝 ${minLiqCushion}x 限制`;
    } else if (byCap <= byLoss) {
      reason = `名目上限 ${Math.round(maxNotionalUsdt)} USDT 限制`;
    } else {
      reason = `單筆虧損上限 ${lossMaxUsdt} USDT 限制`;
    }
  }
  if (marginRaised) {
    reason += (reason ? '；' : '') + `保證金提高到 ${margin.toFixed(0)} USDT`;
  }

  // 名目已經頂到上限卻仍湊不到最低虧損 —— 這是資金規模的問題，
  // 不是訊號的問題。分開標記，因為兩者的處置完全不同：
  // 前者要加資金或放寬倍數，後者是這筆本來就不該做。
  const capBound = loss < lossMinUsdt
    && Math.abs(margin * lev - maxNotionalUsdt) / maxNotionalUsdt < 0.02;

  return { leverage: lev, marginUsdt: margin, reason, capBound, levCap };
}

function computeFixedMargin(p) {
  const { entry, sl, spec, exchange, tp, side,
    feeRateOneWay, lossMinUsdt, lossMaxUsdt, maxNotionalUsdt, equityUsdt } = p;
  const baseLeverage = p.leverage;

  const riskDistance = Math.abs(entry - sl);
  if (!(riskDistance > 0)) {
    return { ok: false, error: '風險距離為 0，無法計算倉位' };
  }

  // 自動模式要在算數量「之前」決定 —— 它會改變名目，而名目決定數量。
  let leverage = baseLeverage;
  let marginUsdt = p.marginUsdt;
  let autoNote = '';
  let capBound = false;
  if (p.autoLeverage) {
    const auto = autoSize({
      baseLeverage,
      stopPct: riskDistance / entry,
      feeRateOneWay,
      marginMin: p.marginUsdt,
      // 保證金上限沒設時就等於下限 —— 等同「不准加保證金」，
      // 與舊行為相同。要開放區間得明確設 FIXED_MARGIN_MAX_USDT。
      marginMax: p.marginMaxUsdt || p.marginUsdt,
      lossMinUsdt,
      lossMaxUsdt,
      maxNotionalUsdt,
      minLiqCushion: p.minLiqCushion || 3,
    });
    leverage = auto.leverage;
    marginUsdt = auto.marginUsdt;
    autoNote = auto.reason;
    capBound = auto.capBound;
  }

  if (marginUsdt > equityUsdt) {
    return {
      ok: false,
      error: `單筆保證金 ${marginUsdt} USDT 超過權益 ${equityUsdt.toFixed(2)} USDT`,
    };
  }

  const targetNotional = marginUsdt * leverage;
  const rawBaseQty = targetNotional / entry;

  let orderQty; let baseQty; let unit; let step; let minimum;
  if (exchange === 'okx') {
    unit = 'contracts';
    step = spec.lotSz;
    minimum = spec.minSz;
    orderQty = floorToStep(rawBaseQty / spec.ctVal, step);
    baseQty = orderQty * spec.ctVal;
  } else {
    unit = 'base';
    step = spec.stepSize;
    minimum = spec.minQty;
    orderQty = floorToStep(rawBaseQty, step);
    baseQty = orderQty;
  }

  if (!(orderQty >= minimum) || orderQty <= 0) {
    return {
      ok: false,
      error: `對齊後數量 ${orderQty} ${unit} 低於最小下單量 ${minimum}。`
        + `保證金 ${marginUsdt} × 槓桿 ${leverage} 在此價格下不足以成交一手。`,
    };
  }

  // 對齊之後才是真正的名目與保證金 —— 捨去會讓它略低於目標
  const notionalUsdt = baseQty * entry;
  const actualMarginUsdt = notionalUsdt / leverage;
  // 先各自取到小數四位，再相加 —— 不是先加再取。
  // 卡片上會同時顯示這三個數字，若總計不等於兩項相加，看起來就是算錯了。
  // 顯示用的數字必須自己對得起來。
  const priceLossUsdt = round4(baseQty * riskDistance);
  // 來回兩次：進場一次、止損觸發平倉一次。都以市價計，故用 taker 費率。
  const feeUsdt = round4(notionalUsdt * feeRateOneWay * 2);
  const estLossUsdt = round4(priceLossUsdt + feeUsdt);
  const stopPct = riskDistance / entry;

  if (notionalUsdt > maxNotionalUsdt) {
    return {
      ok: false,
      error: `名目價值 ${notionalUsdt.toFixed(2)} USDT 超過絕對上限 `
        + `${Number(maxNotionalUsdt).toFixed(0)} USDT，拒絕下單`,
    };
  }

  // 虧損區間閘門。這是這個模式的主要保護 ——
  // 止損太緊（虧損過小）代表訊號品質可疑或週期太短；
  // 止損太鬆（虧損過大）代表這筆的代價超出你願意承受的範圍。
  if (estLossUsdt < lossMinUsdt || estLossUsdt > lossMaxUsdt) {
    const tooSmall = estLossUsdt < lossMinUsdt;
    const nums = bandNumbers({
      stopPct, feeRateOneWay, tp, entry, estLossUsdt,
      lossMaxUsdt, marginUsdt, tooSmall,
    });
    return {
      ok: false,
      // band 標記讓上層知道「這是區間問題」，而不是別種錯誤 ——
      // 區間問題的卡片要長得不一樣（有數字、沒有進場鈕）。
      band: tooSmall ? 'below' : 'above',
      // 一行講完：差多少、止損多緊、費用吃掉多少。
      // 名目已經頂到上限的話，真正的限制是資金規模而不是訊號。
      // 說成「止損太緊」會讓人跑去調止損 —— 那個方向永遠修不好。
      capBound,
      error: tooSmall
        ? `虧損 ${estLossUsdt.toFixed(2)} < 下限 ${lossMinUsdt}`
          + `（止損 ${(stopPct * 100).toFixed(3)}%，手續費佔 `
          + `${(nums.feeShare * 100).toFixed(1)}%`
          + (capBound ? `，名目已達上限 ${Math.round(maxNotionalUsdt)}` : '')
          + '）'
        : `虧損 ${estLossUsdt.toFixed(2)} > 上限 ${lossMaxUsdt}`
          + `（止損 ${(stopPct * 100).toFixed(3)}%，手續費佔 `
          + `${(nums.feeShare * 100).toFixed(1)}%）`,
      // 卡片要畫出來就需要這些。拒絕不代表不必告知細節。
      preview: Object.assign({
        notionalUsdt: round4(notionalUsdt),
        orderQty, baseQty: round4(baseQty),
        estLossUsdt: round4(estLossUsdt),
        feeUsdt: round4(feeUsdt),
        stopPct: round4(stopPct),
        leverage, marginUsdt,
      }, nums),
    };
  }

  return {
    ok: true,
    sizing: {
      mode: 'fixed_margin',
      exchange,
      unit,
      orderQty,
      baseQty,
      step,
      minimum,
      riskDistance,
      stopPct: Number((stopPct * 100).toFixed(4)),
      // 對齊「風險反推」模式的欄位名稱，讓卡片與日誌不必分兩套
      // 自動模式下「預算」是上限而非目標，兩者差很多。
      // 卡片顯示「35.57（預算 45.00）」時，使用者以為 45 是打算賠的錢，
      // 實際上那只是天花板 —— 標註出來免得把上限讀成計畫。
      riskAmountUsdt: round4(lossMaxUsdt),
      riskBudgetIsCap: Boolean(p.autoLeverage),
      actualRiskUsdt: estLossUsdt,
      priceLossUsdt: priceLossUsdt,
      feeUsdt: feeUsdt,
      riskUtilisation: Number((estLossUsdt / lossMaxUsdt).toFixed(4)),
      notionalUsdt: Number(notionalUsdt.toFixed(4)),
      marginUsdt: Number(actualMarginUsdt.toFixed(4)),
      targetMarginUsdt: marginUsdt,
      baseMarginUsdt: p.marginUsdt,
      leverage,
      // 自動槓桿動過的話，卡片要說得出「為什麼是這個數字」。
      // 沉默地把 40x 換成 10x，使用者會以為設定沒生效。
      baseLeverage,
      leverageNote: autoNote,
    },
  };
}

/**
 * @param {object} p
 * @param {number} p.equityUsdt      帳戶權益
 * @param {number} p.riskPct         單筆風險比例（0.005 = 0.5%）
 * @param {number} p.entry           進場價
 * @param {number} p.sl              止損價
 * @param {object} p.spec            symbols.resolve() 回傳的規格
 * @param {string} p.exchange        'okx' | 'bingx'
 * @param {number} p.leverage
 * @param {number} p.maxNotionalUsdt
 * @returns {{ok:boolean, sizing?:object, error?:string}}
 */
function computeSize(p) {
  const { equityUsdt, riskPct, entry, sl, spec, exchange, leverage,
    maxNotionalUsdt, maxNotionalNote } = p;

  const riskDistance = Math.abs(entry - sl);
  if (!(riskDistance > 0)) {
    return { ok: false, error: '風險距離為 0，無法計算倉位' };
  }

  const riskAmountUsdt = equityUsdt * riskPct;
  const rawBaseQty = riskAmountUsdt / riskDistance;

  let orderQty;      // 實際送給交易所的數量（OKX 為張、BingX 為幣）
  let baseQty;       // 對齊後換算回 base 幣的數量，用於名目價值計算
  let unit;
  let step;
  let minimum;

  if (exchange === 'okx') {
    unit = 'contracts';
    step = spec.lotSz;
    minimum = spec.minSz;
    const rawContracts = rawBaseQty / spec.ctVal;   // 幣 → 張
    orderQty = floorToStep(rawContracts, step);
    baseQty = orderQty * spec.ctVal;                // 張 → 幣（對齊後）
  } else {
    unit = 'base';
    step = spec.stepSize;
    minimum = spec.minQty;
    orderQty = floorToStep(rawBaseQty, step);
    baseQty = orderQty;
  }

  if (!(orderQty >= minimum) || orderQty <= 0) {
    return {
      ok: false,
      error: `對齊後數量 ${orderQty} ${unit} 低於最小下單量 ${minimum}。` +
        `在目前的風險預算（${riskAmountUsdt.toFixed(2)} USDT）與風險距離` +
        `（${riskDistance}）下無法合法下單，拒絕此訊號（不進位湊量）。`,
    };
  }

  const notionalUsdt = baseQty * entry;
  const marginUsdt = notionalUsdt / leverage;

  // 名目上限是「倉位計算出錯」的最後一道攔截。正常情況不應觸發，
  // 一旦觸發代表參數或價格資料有問題，寧可不下單。
  if (notionalUsdt > maxNotionalUsdt) {
    return {
      ok: false,
      error: `名目價值 ${notionalUsdt.toFixed(2)} USDT 超過上限 `
        + `${Number(maxNotionalUsdt).toFixed(0)} USDT`
        + (maxNotionalNote ? `（${maxNotionalNote}）` : '')
        + '，拒絕下單',
    };
  }
  if (marginUsdt > equityUsdt) {
    return {
      ok: false,
      error: `所需保證金 ${marginUsdt.toFixed(2)} USDT 超過權益 ` +
        `${equityUsdt} USDT，拒絕下單`,
    };
  }

  // 對齊造成的實際風險必定 <= 預算（因為只會向下捨去）
  const actualRiskUsdt = baseQty * riskDistance;

  return {
    ok: true,
    sizing: {
      exchange,
      unit,
      orderQty,
      baseQty,
      step,
      minimum,
      riskDistance,
      riskAmountUsdt: Number(riskAmountUsdt.toFixed(4)),
      actualRiskUsdt: Number(actualRiskUsdt.toFixed(4)),
      riskUtilisation: Number((actualRiskUsdt / riskAmountUsdt).toFixed(4)),
      notionalUsdt: Number(notionalUsdt.toFixed(4)),
      marginUsdt: Number(marginUsdt.toFixed(4)),
      leverage,
    },
  };
}

module.exports = { computeSize, computeFixedMargin, floorToStep };
