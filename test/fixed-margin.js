'use strict';
/**
 * 固定保證金模式的測試。
 *
 * 基準案例用柏昇截圖裡的那筆真實訊號：
 *   BTC 15M 做空  entry 84083.4  SL 84610.7  →  止損距離 0.627%
 * 保證金 100、槓桿 40、費率 0.05%（單邊）時，預估虧損應為 29.08 USDT。
 * 這個數字是手算出來的，不是跑程式得到的 —— 測試才有對答案的意義。
 */

const assert = require('assert');
const { computeFixedMargin } = require('../src/sizing');

let pass = 0;
const fails = [];
function ck(name, fn) {
  try { fn(); pass++; } catch (err) { fails.push(`${name}：${err.message}`); }
}

// BTC 永續：1 張 = 0.01 BTC，最小跳動 0.01 張
const BTC = { instId: 'BTC-USDT-SWAP', ctVal: 0.01, lotSz: 0.01, minSz: 0.01 };

function size(over) {
  return computeFixedMargin(Object.assign({
    marginUsdt: 100,
    leverage: 40,
    entry: 84083.4,
    sl: 84610.7,          // 做空，止損在上方
    spec: BTC,
    exchange: 'okx',
    feeRateOneWay: 0.0005,
    lossMinUsdt: 20,
    lossMaxUsdt: 45,
    maxNotionalUsdt: 20000,
    equityUsdt: 5000,
  }, over || {}));
}

// ── 基準：手算對照 ─────────────────────────────────────────
ck('名目 = 保證金 × 槓桿', () => {
  const r = size();
  assert.ok(r.ok, r.error);
  // 4000 / 84083.4 = 0.047572 BTC → 4.7572 張 → 捨去 4.75 張
  assert.strictEqual(r.sizing.orderQty, 4.75);
  assert.ok(Math.abs(r.sizing.baseQty - 0.0475) < 1e-9);
  // 對齊後名目略低於 4000（只會向下）
  assert.ok(r.sizing.notionalUsdt < 4000 && r.sizing.notionalUsdt > 3960,
    `名目 ${r.sizing.notionalUsdt} 應略低於 4000`);
});

ck('保證金回推應接近目標的 100', () => {
  const r = size();
  assert.ok(Math.abs(r.sizing.marginUsdt - 100) < 1,
    `實際保證金 ${r.sizing.marginUsdt}，目標 100`);
  assert.strictEqual(r.sizing.targetMarginUsdt, 100);
});

ck('虧損拆成價格虧損與手續費，且兩者相加', () => {
  const r = size();
  const s = r.sizing;
  // 價格虧損 = 0.0475 × 527.3 = 25.05
  assert.ok(Math.abs(s.priceLossUsdt - 25.05) < 0.05, `價格虧損 ${s.priceLossUsdt}`);
  // 手續費 = 名目 × 0.0005 × 2 ≈ 3.99
  assert.ok(Math.abs(s.feeUsdt - 3.99) < 0.05, `手續費 ${s.feeUsdt}`);
  assert.ok(Math.abs(s.actualRiskUsdt - (s.priceLossUsdt + s.feeUsdt)) < 1e-6,
    '總虧損必須等於兩者相加');
  assert.ok(Math.abs(s.actualRiskUsdt - 29.04) < 0.1,
    `總虧損 ${s.actualRiskUsdt}，手算約 29.04`);
});

ck('手續費不可被忽略 —— 佔總虧損逾一成', () => {
  const s = size().sizing;
  const share = s.feeUsdt / s.actualRiskUsdt;
  assert.ok(share > 0.1,
    `手續費佔比 ${(share * 100).toFixed(1)}%，若不計入會低估虧損`);
});

// ── 虧損區間閘門 ───────────────────────────────────────────
ck('止損太緊（1 分鐘那種）應拒絕', () => {
  // 0.146%：截圖裡那筆 1 分鐘訊號的實際距離
  const r = size({ sl: 84083.4 * 1.00146 });
  assert.strictEqual(r.ok, false);
  // 措辭改過（B 版卡片一行講完），但必須仍然說出「差多少」與「止損多緊」
  assert.strictEqual(r.band, 'below');
  assert.ok(r.error.includes('下限') && r.error.includes('止損 0.146%'), r.error);
});

ck('止損太寬應拒絕', () => {
  const r = size({ sl: 84083.4 * 1.02 });     // 2%
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.band, 'above');
  assert.ok(r.error.includes('上限') && r.error.includes('止損 2.000%'), r.error);
});

ck('區間邊界：0.4% 與 1.025% 附近應可通過', () => {
  for (const pct of [0.0045, 0.006, 0.0095]) {
    const r = size({ sl: 84083.4 * (1 + pct) });
    assert.ok(r.ok, `止損 ${(pct * 100).toFixed(2)}% 應通過，卻得到：${r.error}`);
    assert.ok(r.sizing.actualRiskUsdt >= 20 && r.sizing.actualRiskUsdt <= 45,
      `止損 ${(pct * 100).toFixed(2)}% → 虧損 ${r.sizing.actualRiskUsdt} 應落在 20-45`);
  }
});

ck('做多方向（止損在下方）也要正確', () => {
  const r = size({ entry: 84083.4, sl: 84083.4 * (1 - 0.00627) });
  assert.ok(r.ok, r.error);
  assert.ok(Math.abs(r.sizing.actualRiskUsdt - 29.04) < 0.2,
    `做多虧損 ${r.sizing.actualRiskUsdt} 應與做空對稱`);
});

// ── 其他保護 ───────────────────────────────────────────────
ck('保證金超過權益應拒絕', () => {
  const r = size({ equityUsdt: 50 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('超過權益'), r.error);
});

ck('絕對名目上限仍然有效', () => {
  const r = size({ maxNotionalUsdt: 1000 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('絕對上限'), r.error);
});

ck('數量不足一手應拒絕，且說明是保證金不夠', () => {
  const r = size({ marginUsdt: 0.1, leverage: 1, lossMinUsdt: 0.0001 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('最小下單量'), r.error);
});

ck('槓桿越高虧損越大（槓桿是風險旋鈕）', () => {
  const lo = size({ leverage: 20, lossMinUsdt: 1 });
  const hi = size({ leverage: 60, lossMaxUsdt: 100 });
  assert.ok(lo.ok && hi.ok, (lo.error || '') + (hi.error || ''));
  assert.ok(hi.sizing.actualRiskUsdt > lo.sizing.actualRiskUsdt * 2.5,
    `20x → ${lo.sizing.actualRiskUsdt}，60x → ${hi.sizing.actualRiskUsdt}，應約三倍`);
  // 但保證金不變 —— 這正是這個模式與風險反推的分界
  assert.ok(Math.abs(hi.sizing.marginUsdt - lo.sizing.marginUsdt) < 2,
    '槓桿改變時保證金應維持在 100 附近');
});

ck('捨去只會讓虧損變小，不會變大', () => {
  const r = size();
  const idealLoss = 100 * 40 * (527.3 / 84083.4) + 4000 * 0.001;
  assert.ok(r.sizing.actualRiskUsdt <= idealLoss + 1e-6,
    `實際 ${r.sizing.actualRiskUsdt} 不得超過未捨去的 ${idealLoss.toFixed(4)}`);
});


// ---- 區間拒絕要帶著可判斷的數字與建議 ----
(function bandAdviceTests() {
  const base = {
    marginUsdt: 100, leverage: 40, spec: { ctVal: 1, lotSz: 1, minSz: 1 },
    exchange: 'okx', feeRateOneWay: 0.0005,
    lossMinUsdt: 20, lossMaxUsdt: 45, maxNotionalUsdt: 50000, equityUsdt: 1000,
  };

  // 真實案例：TRX 做空，止損 0.210%，虧損 12.40 < 下限 20
  const tight = computeFixedMargin(Object.assign({}, base, {
    entry: 0.33349, sl: 0.33419, side: 'short',
    tp: [0.33279, 0.33209, 0.33139],
  }));
  ck('止損過緊被擋下', () => assert.ok(tight.ok === false));
  ck('標記為 band=below', () => assert.ok(tight.band === 'below'));
  ck('附上試算（讓人判斷拒絕對不對）', () => assert.ok(tight.preview && tight.preview.estLossUsdt > 12 && tight.preview.estLossUsdt < 13));
  ck('原因一行講完，含手續費佔比', () => assert.ok(
    tight.error.indexOf('手續費佔 32.3%') !== -1 && tight.error.split('\n').length === 1));
  ck('附上損益比與打平勝率（卡片的 [效益] 那行）', () => {
    assert.ok(Math.abs(tight.preview.rr - 0.3546) < 0.001);
    assert.ok(Math.abs(tight.preview.breakeven - 0.7382) < 0.001);
  });

  // 核心主張：手續費佔比與槓桿無關。
  // 這一條若紅了，代表「加槓桿救不了緊止損」這個結論站不住，
  // 而整段建議文字就是錯的。
  const share = (lev) => {
    const r = computeFixedMargin(Object.assign({}, base, {
      leverage: lev, entry: 0.33349, sl: 0.33419, side: 'short',
      tp: [0.33279], lossMinUsdt: 99999,
    }));
    return r.preview.feeShare;
  };
  const s20 = share(20), s40 = share(40), s100 = share(100);
  ck('手續費佔比不隨槓桿改變（20x／40x／100x 相同）', () => assert.ok(Math.abs(s20 - s40) < 0.002 && Math.abs(s40 - s100) < 0.002));

  // 反方向：止損過寬時，降槓桿是有效建議
  const wide = computeFixedMargin(Object.assign({}, base, {
    entry: 100, sl: 98.5, side: 'long', tp: [103],
  }));
  ck('止損過寬被擋下', () => assert.ok(wide.ok === false && wide.band === 'above'));
  ck('過寬時給出建議槓桿', () => assert.ok(wide.preview.suggestLeverage > 0
    && wide.preview.suggestLeverage < 40));
  // 過緊時一定不能給建議槓桿：升槓桿不會改善手續費佔比，
  // 給了等於鼓勵一件算術上站不住的事。
  ck('過緊時不給建議槓桿', () => assert.ok(tight.preview.suggestLeverage === undefined));
})();


// ---- 自動槓桿 ----
(function autoLeverageTests() {
  const base = {
    marginUsdt: 100, leverage: 40, spec: { ctVal: 1, lotSz: 1, minSz: 1 },
    exchange: 'okx', feeRateOneWay: 0.0005,
    lossMinUsdt: 20, lossMaxUsdt: 45, maxNotionalUsdt: 50000, equityUsdt: 1000,
    minLiqCushion: 3,
  };
  // 真實案例：XLM 15M 做多，止損 3.212%。固定 40x 時虧損 132 被擋下。
  const XLM = { entry: 0.22787, sl: 0.22055, side: 'long', tp: [0.23519] };

  const fixed = computeFixedMargin(Object.assign({}, base, XLM));
  ck('固定槓桿下 XLM 被擋（基準）', () => {
    assert.strictEqual(fixed.ok, false);
    assert.strictEqual(fixed.band, 'above');
  });

  const auto = computeFixedMargin(Object.assign({}, base, XLM, { autoLeverage: true }));
  ck('自動槓桿讓 XLM 通過', () => assert.strictEqual(auto.ok, true));
  ck('自動槓桿算出 10x', () => assert.strictEqual(auto.sizing.leverage, 10));
  ck('虧損落回區間內', () => {
    assert.ok(auto.sizing.actualRiskUsdt >= 20 && auto.sizing.actualRiskUsdt <= 45);
  });
  ck('說得出是哪一道夾的', () =>
    assert.ok(auto.sizing.leverageNote.indexOf('強平緩衝') !== -1));
  ck('保留原始槓桿供卡片對照', () =>
    assert.strictEqual(auto.sizing.baseLeverage, 40));

  // 這條是整個功能的安全性依據。自動槓桿若會往上調，
  // 「開啟它不會增加風險」這個承諾就不成立，也就不能在真錢上開。
  ck('自動槓桿永遠不會高於 LEVERAGE', () => {
    const cases = [
      { entry: 100, sl: 99.9 },     // 極緊
      { entry: 100, sl: 99 },       // 普通
      { entry: 100, sl: 90 },       // 極寬
    ];
    for (const c of cases) {
      const r = computeFixedMargin(Object.assign({}, base, c,
        { side: 'long', tp: [101], autoLeverage: true, lossMinUsdt: 0 }));
      if (r.ok) assert.ok(r.sizing.leverage <= 40,
        `止損 ${(Math.abs(c.entry - c.sl) / c.entry * 100).toFixed(2)}% 算出 ${r.sizing.leverage}x`);
    }
  });

  // 強平緩衝是這個功能存在的主因（LINK 那次的教訓）。
  ck('強平距離必定大於止損距離的 cushion 倍', () => {
    const stopPct = (0.22787 - 0.22055) / 0.22787;
    const liqPct = 1 / auto.sizing.leverage;
    assert.ok(liqPct >= stopPct * 3,
      `強平 ${(liqPct * 100).toFixed(2)}% 應 ≥ 止損 ${(stopPct * 100).toFixed(2)}% × 3`);
  });

  // 止損太緊時自動槓桿不該「幫忙」—— 升槓桿不改善手續費佔比。
  const TRX = { entry: 0.33349, sl: 0.33419, side: 'short', tp: [0.33279] };
  const tightAuto = computeFixedMargin(Object.assign({}, base, TRX, { autoLeverage: true }));
  ck('止損過緊時自動槓桿仍然拒絕', () => {
    assert.strictEqual(tightAuto.ok, false);
    assert.strictEqual(tightAuto.band, 'below');
  });

  // cushion 調大 → 槓桿更保守
  const c4 = computeFixedMargin(Object.assign({}, base, XLM,
    { autoLeverage: true, minLiqCushion: 4 }));
  ck('cushion 調大時槓桿更低', () =>
    assert.ok(c4.sizing.leverage < auto.sizing.leverage,
      `cushion 4 得到 ${c4.sizing.leverage}x，應低於 ${auto.sizing.leverage}x`));

  // 兩道約束會互相牴觸：cushion 越大倉位越小，小到一定程度就
  // 掉出虧損下限。這時候該拒絕，不是硬做一筆手續費佔比很差的單。
  // 這不是 bug，但值得用測試釘住 —— 否則哪天有人「修」掉它。
  const c5 = computeFixedMargin(Object.assign({}, base, XLM,
    { autoLeverage: true, minLiqCushion: 5 }));
  ck('cushion 太大導致倉位低於虧損下限時，照樣拒絕', () => {
    assert.strictEqual(c5.ok, false);
    assert.strictEqual(c5.band, 'below');
  });
})();


// ---- 四道約束一起解（autoSize）----
(function autoSizeTests() {
  const mk = (eq, mMax) => ({
    marginUsdt: 100, marginMaxUsdt: mMax, leverage: 40,
    spec: { ctVal: 1, lotSz: 0.01, minSz: 0.01 }, exchange: 'okx',
    feeRateOneWay: 0.0005, lossMinUsdt: 20, lossMaxUsdt: 45,
    maxNotionalUsdt: Math.min(eq * 3, 5000), equityUsdt: eq,
    minLiqCushion: 3, autoLeverage: true,
  });
  const at = (eq, mMax, stopPct) => {
    const e = 100;
    return computeFixedMargin(Object.assign({}, mk(eq, mMax), {
      entry: e, sl: e * (1 - stopPct / 100), side: 'long',
      tp: [e * (1 + stopPct / 100)],
    }));
  };

  // 【這一條守的是一個真實存在過的 bug】
  // 舊版只夾峰值／緩衝／虧損上限，不看名目上限。止損 0.8% 會算出
  // 40x、名目 4000，然後被外層的 3000 上限拒絕 —— 而 30x（名目 3000）
  // 明明合法。拿掉 autoSize 裡的名目那一項，這條就會紅。
  const r08 = at(1000, 100, 0.8);
  ck('名目上限納入求解（止損 0.8% 應可成交）', () => {
    assert.strictEqual(r08.ok, true, r08.error);
    assert.strictEqual(r08.sizing.leverage, 30);
    assert.ok(r08.sizing.notionalUsdt <= 3000);
  });
  ck('說得出是名目上限夾的', () =>
    assert.ok(r08.sizing.leverageNote.indexOf('名目上限') !== -1,
      r08.sizing.leverageNote));

  // XLM：柏昇手動下單的那一筆。系統算出來要與他一致。
  const xlm = computeFixedMargin(Object.assign({}, mk(1000, 100), {
    entry: 0.22787, sl: 0.22055, side: 'long', tp: [0.23519],
    spec: { ctVal: 1, lotSz: 1, minSz: 1 },
  }));
  ck('XLM 算出 10x／100U（與手動下單一致）', () => {
    assert.strictEqual(xlm.sizing.leverage, 10);
    assert.ok(Math.abs(xlm.sizing.actualRiskUsdt - 33.12) < 0.05);
  });

  // 名目頂到上限仍湊不到下限 → 那是資金規模問題，要標記出來，
  // 否則使用者會去調止損，而那個方向永遠修不好。
  const tight = at(1000, 100, 0.21);
  ck('名目受限時標記 capBound', () => {
    assert.strictEqual(tight.ok, false);
    assert.strictEqual(tight.capBound, true);
    assert.ok(tight.error.indexOf('名目已達上限') !== -1, tight.error);
  });

  // 保證金區間：小帳戶用不到，大帳戶才會啟動。
  ck('權益 1000 時保證金永遠停在下限', () => {
    for (const sp of [0.8, 1.5, 3.212, 5]) {
      const r = at(1000, 300, sp);
      if (r.ok) assert.strictEqual(r.sizing.targetMarginUsdt, 100,
        `止損 ${sp}% 用了 ${r.sizing.targetMarginUsdt}U`);
    }
  });
  ck('權益 2000、止損 0.3% 時會動用保證金區間', () => {
    const r = at(2000, 300, 0.3);
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(r.sizing.targetMarginUsdt > 100 && r.sizing.targetMarginUsdt <= 300,
      `保證金 ${r.sizing.targetMarginUsdt}`);
    assert.ok(r.sizing.leverageNote.indexOf('保證金提高到') !== -1);
  });
  ck('沒設保證金上限時行為與舊版相同', () => {
    const r = at(2000, undefined, 0.3);
    if (r.ok) assert.strictEqual(r.sizing.targetMarginUsdt, 100);
  });

  // 單向性：開啟自動模式只可能讓部位變小。
  ck('槓桿永不超過 LEVERAGE，保證金永不低於下限', () => {
    for (const eq of [500, 1000, 2000, 5000]) {
      for (const sp of [0.1, 0.3, 0.627, 1, 2, 3.212, 8]) {
        const r = at(eq, 300, sp);
        if (!r.ok) continue;
        assert.ok(r.sizing.leverage <= 40, `${eq}/${sp}% → ${r.sizing.leverage}x`);
        assert.ok(r.sizing.targetMarginUsdt >= 100);
      }
    }
  });

  // 強平緩衝是硬約束，任何帳戶規模都不能破。
  ck('強平距離永遠 ≥ 止損 × 3', () => {
    for (const eq of [1000, 2000, 5000]) {
      for (const sp of [0.3, 1, 2, 3.212, 8]) {
        const r = at(eq, 300, sp);
        if (!r.ok) continue;
        assert.ok(1 / r.sizing.leverage >= (sp / 100) * 3 - 1e-9,
          `${eq}/${sp}% → ${r.sizing.leverage}x 緩衝 ${((1 / r.sizing.leverage) / (sp / 100)).toFixed(2)}x`);
      }
    }
  });
})();

console.log(`固定保證金測試：通過 ${pass} 項` + (fails.length ? `，失敗 ${fails.length} 項` : ''));
if (fails.length) {
  console.error('\n' + fails.map((f) => '  ✗ ' + f).join('\n'));
  process.exit(1);
}
