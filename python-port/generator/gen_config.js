const { spawnSync } = require('child_process'); const fs = require('fs'), path = require('path');
const SRC = path.resolve(process.argv[2]), OUT = process.argv[3];
const child = `const c=require(${JSON.stringify(SRC + '/config.js')});let errs;try{errs=c.validate();}catch(e){errs={threw:String(e.message)}};
console.log(JSON.stringify({config:c.config,validate:errs}))`;
const GOOD = { EXECUTOR_WEBHOOK_SECRET: 'x'.repeat(20), EXECUTOR_CONTROL_SECRET: 'y'.repeat(20), DRY_RUN: 'true', DEMO_MODE: 'true', TG_TOKEN: 't', TG_CHAT_ID: '1' };
const cases = {
  defaults_only: {},
  good_demo: GOOD,
  live_example: { ...GOOD, DRY_RUN: 'false', DEMO_MODE: 'false', EXECUTION_MODE: 'manual', INSTANCE_ROLE: 'live', DATA_DIR: '/data/live',
    SIZING_MODE: 'fixed_margin', FIXED_MARGIN_USDT: '25', FIXED_MARGIN_MAX_USDT: '0', TARGET_LOSS_MIN_USDT: '5', TARGET_LOSS_MAX_USDT: '11',
    TAKER_FEE_RATE: '0.0005', LEVERAGE: '40', AUTO_LEVERAGE: 'true', MIN_LIQ_CUSHION: '3', OKX_TD_MODE: 'isolated', MAX_NOTIONAL_USDT: '1500',
    MAX_NOTIONAL_MULT: '3', EQUITY_SOURCE: 'exchange', ACCOUNT_EQUITY_USDT: '400', MAX_CONCURRENT_POSITIONS: '1', MAX_CONCURRENT_CEILING: '2',
    OVERFLOW_POSITIONS: '0', ADDON_MAX: '0', DAILY_LOSS_LIMIT_USDT: '20', DAILY_LOSS_CEILING_USDT: '20', DAILY_RESET_LIMIT: '0',
    ALLOWED_TIMEFRAMES: '15', ALLOWED_SYMBOLS: 'BTCUSDT.P', EXCHANGES: 'okx', PRIMARY_EXCHANGE: 'okx', OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p' },
  bad_bool: { ...GOOD, DRY_RUN: 'maybe' },
  yes_bool: { ...GOOD, DRY_RUN: 'yes' },
  bad_num: { ...GOOD, LEVERAGE: 'abc', FIXED_MARGIN_USDT: '1e' },
  empty_values: { ...GOOD, LEVERAGE: '', DRY_RUN: '' },
  short_secret: { ...GOOD, EXECUTOR_WEBHOOK_SECRET: 'short' },
  same_secrets: { ...GOOD, EXECUTOR_CONTROL_SECRET: 'x'.repeat(20) },
  shadow_live_money: { ...GOOD, INSTANCE_ROLE: 'shadow', DEMO_MODE: 'false' },
  bad_role: { ...GOOD, INSTANCE_ROLE: 'boss' },
  live_no_keys: { ...GOOD, DRY_RUN: 'false', DEMO_MODE: 'false' },
  bingx_live_money: { ...GOOD, DRY_RUN: 'false', DEMO_MODE: 'false', EXCHANGES: 'okx,bingx', BINGX_API_KEY: 'k', BINGX_API_SECRET: 's', OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p' },
  tf_list_spaces: { ...GOOD, ALLOWED_TIMEFRAMES: ' 15 , 60 ,', ALLOWED_SYMBOLS: 'btcusdt.p, ETHUSDT.P' },
  bool_variants: { ...GOOD, AUTO_LEVERAGE: 'FALSE', DRIFT_CHECK: '0', REFRESH_SPEC: '1' },
};
const out = [];
for (const [id, env] of Object.entries(cases)) {
  const r = spawnSync('node', ['-e', child], { env: { PATH: process.env.PATH, ...env }, cwd: '/tmp', encoding: 'utf8' });
  let parsed = null; try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) {}
  out.push({ id: 'cfg_' + id, fn: 'config_from_env', input: { env }, expected: parsed || { exit: r.status, stderr: (r.stderr || '').slice(0, 400) } });
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(out, null, 1));
for (const o of out) console.log(o.id, JSON.stringify((o.expected.validate || o.expected)).slice(0, 220));
