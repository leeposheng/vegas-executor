'use strict';
/**
 * 日損上限重置的測試。
 *
 * 這組測試守的是一件事：重置鍵不能把日損上限變成裝飾品。
 * 每一條都刻意對應一種「看起來能用、實際上把風控拆掉了」的寫法。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../src/store.js');
const risk = require('../src/risk.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-'));
  return new Store(dir);
}

const RISK = {
  dailyLossLimitUsdt: 50,
  dailyResetLimit: 1,
  dailyResetCooldownMin: 30,
};

console.log('\n日損重置');

t('未重置時，採計損益等於真實損益', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  assert.strictEqual(s.dailyPnlSinceReset(), -62.12);
  assert.strictEqual(s.today().realisedPnlUsdt, -62.12);
});

t('重置只移動基準線，真實損益原封不動', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test' });
  // 採計歸零
  assert.ok(Math.abs(s.dailyPnlSinceReset()) < 1e-9, '採計損益應為 0');
  // 真實數字必須還在 —— 歸零 realisedPnlUsdt 的實作會在這裡爆
  assert.strictEqual(s.today().realisedPnlUsdt, -62.12);
});

t('重置後新的虧損從 0 開始累計，上限照樣會再次觸發', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test' });
  s.recordPnl(-51, Date.now());
  assert.strictEqual(Number(s.dailyPnlSinceReset().toFixed(2)), -51);
  const gate = risk.dailyLossGate(s, RISK);
  assert.strictEqual(gate.passed, false, '第二輪超標應再次擋下');
});

t('重置後的閘門說明必須同時講出真實日損', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test' });
  s.recordPnl(-51, Date.now());
  const gate = risk.dailyLossGate(s, RISK);
  // 只顯示 51 會讓人以為今天才虧 51，實際是 113.12
  assert.ok(gate.detail.indexOf('113.12') !== -1,
    '說明應包含真實日損 113.12，實得：' + gate.detail);
  assert.ok(gate.detail.indexOf('已重置 1 次') !== -1, '說明應包含重置次數');
});

t('每一次重置都留下痕跡', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  const r = s.resetDailyLoss({ by: 'telegram', note: 'x' });
  assert.strictEqual(r.count, 1);
  const info = s.dailyResetInfo();
  assert.strictEqual(info.resets.length, 1);
  assert.strictEqual(info.resets[0].by, 'telegram');
  assert.strictEqual(Number(info.resets[0].clearedUsdt.toFixed(2)), -62.12);
});

t('重置狀態能跨行程存活（重新部署不會把次數洗掉）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-'));
  const a = new Store(dir);
  a.recordPnl(-62.12, Date.now());
  a.resetDailyLoss({ by: 'test' });
  // 換一個實例讀同一個目錄，模擬重啟
  const b = new Store(dir);
  assert.strictEqual(b.dailyResetInfo().count, 1, '重啟後次數應仍為 1');
  assert.ok(Math.abs(b.dailyPnlSinceReset()) < 1e-9, '重啟後基準線應仍在');
});

console.log('\n重置後冷卻');

t('剛重置完就在冷卻中', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test' });
  const cool = risk.resetCooldown(s, RISK);
  assert.strictEqual(cool.active, true);
  assert.ok(cool.remainMin > 0 && cool.remainMin <= 30, '剩餘應在 1～30 分鐘');
});

t('冷卻閘門在重置成功的那一刻就生效', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test' });
  const res = risk.evaluate(
    { sigId: 'a', grade: 3, timeframe: '15', symbol: 'BTCUSDT.P' },
    { store: s, exchange: 'okx', risk: Object.assign({
      minGrade: 2, allowedTimeframes: ['15'], maxConcurrent: 3, maxConcurrentCeiling: 5,
    }, RISK) }
  );
  const g = res.gates.filter((x) => x.name === 'reset_cooldown')[0];
  assert.ok(g, '應有 reset_cooldown 閘門');
  assert.strictEqual(g.passed, false, '重置當下應被冷卻擋住');
  // 日損那道反而該通過了 —— 兩道閘門管的是不同事情
  const l = res.gates.filter((x) => x.name === 'daily_loss_limit')[0];
  assert.strictEqual(l.passed, true);
});

t('冷卻時間過了就放行', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test', now: Date.now() - 31 * 60000 });
  const cool = risk.resetCooldown(s, RISK);
  assert.strictEqual(cool.active, false);
});

t('冷卻設 0 就完全不啟用', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test' });
  const cool = risk.resetCooldown(s, Object.assign({}, RISK, { dailyResetCooldownMin: 0 }));
  assert.strictEqual(cool.active, false);
});

t('按下確認時的重新檢查也看得到冷卻', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test' });
  const res = risk.recheck(
    { sigId: 'a', symbol: 'BTCUSDT.P' },
    { store: s, exchange: 'okx', risk: Object.assign({
      maxConcurrent: 3, maxConcurrentCeiling: 5,
    }, RISK) }
  );
  assert.strictEqual(res.passed, false);
  assert.ok(res.reasons.join(' ').indexOf('冷卻') !== -1,
    'recheck 應含冷卻原因，實得：' + res.reasons.join(' '));
});

console.log('\n向後相容');

t('舊狀態檔（沒有 resetBaseline／resets）讀得起來', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgs-'));
  const s0 = new Store(dir);
  const key = s0._todayKey(Date.now());
  s0.save();
  // 手工改成舊格式：那一天只有 realisedPnlUsdt 與 orders
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  raw.daily = {}; raw.daily[key] = { realisedPnlUsdt: -20, orders: 3 };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(raw));

  const s = new Store(dir);
  assert.strictEqual(s.dailyPnlSinceReset(), -20, '舊檔應視為未重置');
  assert.strictEqual(s.dailyResetInfo().count, 0);
  assert.strictEqual(risk.resetCooldown(s, RISK).active, false);
});

console.log('\nTelegram 可調參數');

t('日損上限可以調大，但夾在天花板之下', () => {
  const s = tmpStore();
  const R = Object.assign({}, RISK, { dailyLossCeilingUsdt: 100 });
  assert.strictEqual(risk.effectiveDailyLossLimit(s, R), 50, '沒設覆寫時用環境變數值');
  s.setOverride('dailyLossLimit', 80);
  assert.strictEqual(risk.effectiveDailyLossLimit(s, R), 80);
  // 超過天花板必須被夾住 —— 少了這行，Telegram 那端就是無限權限
  s.setOverride('dailyLossLimit', 999);
  assert.strictEqual(risk.effectiveDailyLossLimit(s, R), 100, '應夾在天花板');
});

t('日損上限調小不受限制（往安全的方向走）', () => {
  const s = tmpStore();
  const R = Object.assign({}, RISK, { dailyLossCeilingUsdt: 100 });
  s.setOverride('dailyLossLimit', 20);
  assert.strictEqual(risk.effectiveDailyLossLimit(s, R), 20);
});

t('調整後的日損上限，閘門真的會用', () => {
  const s = tmpStore();
  const R = Object.assign({}, RISK, { dailyLossCeilingUsdt: 100 });
  s.recordPnl(-30, Date.now());
  assert.strictEqual(risk.dailyLossGate(s, R).passed, true, '-30 未達 50');
  s.setOverride('dailyLossLimit', 25);
  assert.strictEqual(risk.dailyLossGate(s, R).passed, false, '改成 25 之後 -30 應被擋');
});

t('冷卻只能調長，不能調短', () => {
  const s = tmpStore();
  assert.strictEqual(risk.effectiveCooldownMin(s, RISK), 30, '預設等於環境變數');
  s.setOverride('resetCooldownMin', 60);
  assert.strictEqual(risk.effectiveCooldownMin(s, RISK), 60, '調長應生效');
  // 方向與日損上限相反：這裡環境變數是下限
  s.setOverride('resetCooldownMin', 5);
  assert.strictEqual(risk.effectiveCooldownMin(s, RISK), 30, '調短應被下限擋回');
});

t('調長後的冷卻，閘門真的會用', () => {
  const s = tmpStore();
  s.recordPnl(-62.12, Date.now());
  s.resetDailyLoss({ by: 'test', now: Date.now() - 40 * 60000 });
  assert.strictEqual(risk.resetCooldown(s, RISK).active, false, '40 分鐘 > 預設 30');
  s.setOverride('resetCooldownMin', 60);
  assert.strictEqual(risk.resetCooldown(s, RISK).active, true, '改成 60 後應仍在冷卻');
});

// 【這一條是被一個會看時鐘的測試逼出來的】
// 上面那條在台北時間 00:00–00:40 之間會紅：重置寫進「昨天」的紀錄，
// 而 dailyResetInfo() 讀「今天」的，lastAt 因此歸零、冷卻消失。
//
// 那不是測試的問題，是真的漏洞：23:55 按下重置、冷卻 30 分鐘，
// 到了 00:00 冷卻直接不見 —— 而 24 小時的加密市場裡午夜不是休息。
// 日損額度歸零是刻意的，冷卻被一起歸零不是。
t('冷卻跨得過午夜（重置在昨天、現在是今天）', () => {
  const s = tmpStore();
  // 固定一個「昨天 23:50、現在 00:10」的情境，不依賴實際時鐘。
  // 台北是 UTC+8，所以台北 23:50 = 當日 UTC 15:50。
  const resetAt = new Date('2026-09-29T15:50:00Z').getTime();  // 台北 09-29 23:50
  const now = new Date('2026-09-29T16:10:00Z').getTime();      // 台北 09-30 00:10

  s.recordPnl(-62.12, resetAt);
  s.resetDailyLoss({ by: 'test', now: resetAt });

  const info = s.dailyResetInfo(now);
  assert.strictEqual(info.lastAt, resetAt, '重置時間必須跨日保留');
  // 次數則應該歸零 —— 新的一天有新的額度，那是刻意的
  assert.strictEqual(info.count, 0, '新的一天重置次數應歸零');

  const cool = risk.resetCooldown(s, RISK, now);
  assert.strictEqual(cool.active, true, '過了 20 分鐘、冷卻 30 分鐘，應仍在冷卻');
});

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 通過，' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
