const assert = require('assert');
const { handleSignal } = require('../src/executor');
const { Store } = require('../src/store');
const fs=require('fs'), os=require('os'), path=require('path');
const NOW = Date.parse('2026-09-24T08:53:00.000Z');
let n = 0;
const sig = () => ({ v:'11.9', sig_id:'captest-'+(++n)+'-abcdef', ts:NOW,
  symbol:'BTCUSDT.P', tf:'60', grade:3, side:'long',
  entry:84172.7, sl:83793.9, tp:[84551.5,84930.3,85309.1] });   // 止損 0.45%
function cfg(eq, abs, mult) {
  return { dryRun:true, demo:true, primaryExchange:'okx', refreshSpec:false,
    executionMode:'by_grade', autoGradeMin:2, pendingTtlSec:300,
    risk:{ pctPerTrade:0.005, equityUsdt:eq, maxConcurrent:1,
      dailyLossLimitUsdt:15, maxNotionalUsdt:abs, maxNotionalMult:mult,
      leverage:10, minGrade:1, allowedTimeframes:['15','60'],
      maxSignalAgeSec:60, driftCheck:false, equitySource:'config' },
    okx:{ apiKey:'', apiSecret:'', passphrase:'', baseUrl:'x', tdMode:'cross' },
    bingx:{}, telegram:{ token:'', chatId:'' } };
}
const store = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(),'vgcap-')));
(async () => {
  let pass=0; const fails=[];
  const ck = async (name, fn) => { try { await fn(); pass++; }
    catch(e){ fails.push(name+'：'+e.message); } };

  await ck('權益 5000、倍數 3 → 通過（上限 15000）', async () => {
    const r = await handleSignal(sig(), {config:cfg(5000,20000,3), store:store(), now:NOW});
    assert.strictEqual(r.decision, 'placed', (r.reasons||[]).join('；'));
    assert.strictEqual(r.notionalCap.value, 15000);
    assert.strictEqual(r.notionalCap.source, 'mult');
  });

  await ck('權益 1000、倍數 3 → 通過（上限 3000）', async () => {
    const r = await handleSignal(sig(), {config:cfg(1000,20000,3), store:store(), now:NOW});
    assert.strictEqual(r.decision, 'placed', (r.reasons||[]).join('；'));
    assert.strictEqual(r.notionalCap.value, 3000);
  });

  await ck('絕對上限較嚴時由它生效', async () => {
    const r = await handleSignal(sig(), {config:cfg(5000,3000,3), store:store(), now:NOW});
    assert.strictEqual(r.decision, 'rejected');
    assert.strictEqual(r.notionalCap.source, 'absolute');
    assert.ok(r.reasons.join('').includes('絕對上限'), r.reasons.join('；'));
  });

  await ck('倍數較嚴時訊息要說出是倍數擋的', async () => {
    const r = await handleSignal(sig(), {config:cfg(1000,20000,0.5), store:store(), now:NOW});
    assert.strictEqual(r.decision, 'rejected');
    assert.ok(r.reasons.join('').includes('權益 1000 × 0.5 倍'), r.reasons.join('；'));
  });

  await ck('倍數沒設時預設 3', async () => {
    const c = cfg(5000, 20000, undefined);
    delete c.risk.maxNotionalMult;
    const r = await handleSignal(sig(), {config:c, store:store(), now:NOW});
    assert.strictEqual(r.notionalCap.value, 15000);
  });

  console.log(`名目上限測試：通過 ${pass} 項` + (fails.length?`，失敗 ${fails.length}`:''));
  if (fails.length) { console.error(fails.map(f=>'  ✗ '+f).join('\n')); process.exit(1); }
})();
