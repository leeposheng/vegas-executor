'use strict';
// 模組 E 黃金向量：CHART-IMG 設定／請求組裝／取圖／sendPhoto。
// 用法：node gen_chart.js <Code.gs> <Executor.gs> <輸出資料夾>
const fs = require('fs'), path = require('path');
const { makeEnv, J, rng } = require('./gas_env.js');
const SRC = fs.readFileSync(path.resolve(process.argv[2]), 'utf8') + '\n' + fs.readFileSync(path.resolve(process.argv[3]), 'utf8');
const OUT = path.resolve(process.argv[4]);
const BASE = { TG_TOKEN: '123:TESTTOKEN', ALLOWED_CHAT_ID: '111', TRADINGVIEW_WEBHOOK_SECRET: 'tv', TELEGRAM_WEBHOOK_SECRET: 'tg', WEBAPP_URL: 'https://x' };

function mkEnv(props, plan) {
  const env = makeEnv(SRC, { props: Object.assign({}, BASE, props || {}) });
  env.fetchPlan = (plan || []).slice();
  env.run(`
    logEvent_ = function (level, event, details) { __rec.logs.push({ level: level, event: event, details: JSON.parse(JSON.stringify(details || {})) }); };
    console.error = function () {}; console.warn = function () {};
  `);
  return env;
}
function withArgs(env, a) { env.ctx.__a = J(a); return env; }

const run = {
  opts(c) { const env = mkEnv(c.props); return J(env.run('chartOptions_(PropertiesService.getScriptProperties())')); },
  color(c) { return J(mkEnv({}).run('toRgbColor_(' + JSON.stringify(c.raw === undefined ? null : c.raw) + ')')); },
  split(c) { return J(mkEnv({}).run('splitColorPairs_(' + JSON.stringify(c.raw === undefined ? null : c.raw) + ')')); },
  interval(c) { const env = withArgs(mkEnv({}), [c.tf]); return J(env.run('chartInterval_(__a[0])')); },
  build(c) {
    const env = withArgs(mkEnv(c.props), [c.payload, c.override || {}]);
    const out = env.run(`(function () { var o = chartOptions_(PropertiesService.getScriptProperties());
      var ov = __a[1]; for (var k in ov) o[k] = ov[k];
      var req = buildChartRequest_(__a[0], o); return { req: req, body: JSON.stringify(req) }; })()`);
    return J(out);
  },
  fetch(c) {
    const env = mkEnv(c.props, c.plan); const rec = env.ctx.__rec;
    withArgs(env, [c.payload]);
    let blob = null, error = null;
    try { blob = J(env.run('fetchChartImage_(__a[0])')); } catch (e) { error = e.message; }
    return { blob, error, calls: J(env.fetchCalls), logs: J(rec.logs), t: env.t };
  },
  send(c) {
    const env = mkEnv(c.props, c.plan);
    env.ctx.__blob = env.ctx.__mkBlob('X.png', c.photo);
    withArgs(env, [c.chatId, c.caption, c.markup === undefined ? null : c.markup]);
    const result = J(env.run('tgSendPhoto_(__a[0], __blob, __a[1], __a[2])'));
    return { result, calls: J(env.fetchCalls) };
  },
};

const r = rng(97531);
const pickOf = (a) => a[Math.floor(r() * a.length)];
const POOL = {
  CHART_MAX_PARAMS: ['', '0', 'abc', '1', '2', '3', '4', '5', '7', '10', '11', '999', '-2', '4.7', ' 7 ', '3x'],
  CHART_EMA_ORDER: ['', '144,169', '12,250', 'x,y', '0,-1,5', '144, 169 ,576', '999,144', '1,2,3,4,5,6,7,8,9', '  ', '144;169', '12.9,7x'],
  CHART_SHOW_LEVELS: ['', 'true', 'TRUE', '1', 'on', 'yes', 'false', '0', 'On ', 'true', 'true'],
  CHART_LEVEL_SET: ['', 'all', 'none', 'entry', 'sl,tp2', 'tp3, tp1,bogus', 'ENTRY,SL', 'bogus', 'ALL', 'tp1,tp2,tp3'],
  CHART_HIDE_LEGEND_KEYS: ['', 'none', 'NONE', 'showLegend', 'a, b,,c', ' '],
  CHART_WATERMARK: ['', '0', '50', '100', '101', '-1', 'abc', '85.5'],
  CHART_WIDTH: ['', '320', '319', '1920', '1921', 'abc', '1000', '0'],
  CHART_HEIGHT: ['', '240', '239', '1600', '1601', 'abc', '700'],
  CHART_THEME: ['', 'dark', 'DARK', 'light', 'blue', ' Dark '],
  CHART_EMA_COLORS: ['', '144:#2B4C7E,576:#7D2E3A', '144:rgb(1,2,3),12:#abc', '144:zzz,169:#12345678', 'bad', '999:#fff', 'x:#fff', '144:#FFF,,', '144 : #123456', '144:rgba(1,2,3,0.5),576:#00000080', '12:rgb(1, 2, 3),250:#fff'],
  CHART_LEVEL_COLORS: ['', 'entry:#FFFFFF,sl:#A32E3E,tp:#1F7A5E', 'tp1:#111,tp:#222', 'ENTRY:rgb(1,2,3)', ':#fff', 'entry:nonsense', 'tp:#abc, tp2:#def', 'sl:#ff0000'],
  CHART_LEVEL_TEXT_COLORS: ['', 'entry:#FFFFFF,sl:#A32E3E', 'tp:#00ff00', 'sl:bad', 'tp3:#123'],
  CHART_LEVEL_TEXT_FIELD: ['', 'color', 'textColor2'],
  CHART_TV_EXCHANGE: ['', 'BINANCE'],
  CHART_CANDLE_UP: ['', '#00ff00', 'rgb(1,2,3)'],
  CHART_CANDLE_DOWN: ['', '#ff0000'],
  CHART_EMA_STUDY_NAME: ['', 'Moving Average Exponential2'],
};
function randProps(density) {
  const p = {};
  for (const k of Object.keys(POOL)) if (r() < density) p[k] = pickOf(POOL[k]);
  return p;
}
function randPayload() {
  const p = {};
  const maybe = (k, vals, pr) => { if (r() < (pr === undefined ? 0.9 : pr)) p[k] = pickOf(vals); };
  maybe('side', ['long', 'short', 'LONG', null]);
  maybe('symbol', ['BTCUSDT.P', 'ETHUSDT', '', null, 12, '日本語幣', 'A:B']);
  maybe('tf', ['15', '60', '240', '1440', '90', '10080', 'abc', '', null, 60, 5, '1', '45', '2880', '0', '-5', '1e3', ' 30 ', '0x10', true]);
  maybe('tz', ['Asia/Tokyo', '', null, 'UTC'], 0.5);
  maybe('entry', [65000.5, 65000, '65000', null, 1e-7, 0, 123456789012, '', 0.1 + 0.2, true]);
  maybe('sl', [64000, 63999.99, '63999', null, 1e21, 0.000001]);
  maybe('tp', [[66000, 67000, 68000], [], [66000], [66000, null, 68000], 'abc', null, [1.5, 2.5], 0, ['a', 'b', 'c', 'd']], 0.9);
  return p;
}

const vectors = [];
const V = (id, fn, input, expected) => vectors.push({ id, fn, input, expected });

// ---- 顏色／切割／週期 ----
const COLORS = ['#fff', '#FFF', '#2B4C7E', '2b4c7e', '#2b4c7e80', '#2B4C7EFF', '#2B4C7E00', 'rgb(1,2,3)', 'RGB(1,2,3)', 'rgba(1,2,3,0.5)', ' rgb (1,2,3)', 'rgb', '#abcd', '#abcde', '#12', '#gggggg', '', '   ', null, undefined, 0, 123456, '##fff', '#fff\n', ' #abc ', '#aabbccdd11', '😀😀😀', '#ffffff80', '#ffffff40', '#ffffff01', '#ffffffC8'];
COLORS.forEach((raw, i) => V('color_' + i, 'chart_color', { raw }, run.color({ raw })));
for (let a = 0; a < 256; a++) { const raw = '#336699' + a.toString(16).padStart(2, '0'); V('color_alpha_' + a, 'chart_color', { raw }, run.color({ raw })); }
const SPLITS = ['', null, 'a:#111,b:rgb(1,2,3)', 'a,b,c', ',a,', 'rgb(1,2,3)', 'a:rgb(1,(2),3),b:#fff', '((,))', ')a,b(', '  ,  ', 'x:rgba(1,2,3,0.5),y', ' ,a', 'a,'];
SPLITS.forEach((raw, i) => V('split_' + i, 'chart_split', { raw }, run.split({ raw })));
const TFS = ['1', '5', '15', '59', '60', '61', '90', '120', '240', '1440', '2880', '10080', '1500', '0', '-1', 'abc', '', null, 60, 1440, 30.5, 'Infinity', ' 15 ', '1e2', '0x20', true, false];
TFS.forEach((tf, i) => V('interval_' + i, 'chart_interval', { tf }, run.interval({ tf })));
V('interval_undef', 'chart_interval', { tf: '__undef' }, J(mkEnv({}).run('chartInterval_(undefined)')));

// ---- 設定 ----
V('opts_default', 'chart_opts', { props: {} }, run.opts({ props: {} }));
for (const k of Object.keys(POOL)) for (const v of POOL[k]) { const c = { props: { [k]: v } }; V('opts_' + vectors.length, 'chart_opts', c, run.opts(c)); }
for (let i = 0; i < 150; i++) { const c = { props: randProps(0.5) }; V('opts_r' + i, 'chart_opts', c, run.opts(c)); }
V('opts_nullvals', 'chart_opts', { props: { CHART_WIDTH: null, CHART_THEME: null } }, run.opts({ props: { CHART_WIDTH: null, CHART_THEME: null } }));

// ---- 請求組裝 ----
const FULLP = { side: 'long', symbol: 'BTCUSDT.P', tf: '15', tz: 'Asia/Taipei', entry: 65000.5, sl: 64000, tp: [66000, 67000, 68000] };
const bld = (id, c) => V(id, 'chart_build', c, run.build(c));
bld('build_default', { props: {}, payload: FULLP });
bld('build_levels', { props: { CHART_SHOW_LEVELS: 'true' }, payload: FULLP });
bld('build_levels_all_mega', { props: { CHART_SHOW_LEVELS: 'true', CHART_LEVEL_SET: 'all', CHART_MAX_PARAMS: '10' }, payload: FULLP });
bld('build_budget_exact', { props: { CHART_SHOW_LEVELS: 'on', CHART_LEVEL_SET: 'entry,sl,tp1', CHART_MAX_PARAMS: '5' }, payload: FULLP });
bld('build_wm', { props: { CHART_WATERMARK: '0' }, payload: FULLP });
bld('build_nostudies', { props: { CHART_SHOW_LEVELS: 'true', CHART_LEVEL_SET: 'entry,sl,tp1', CHART_MAX_PARAMS: '3' }, payload: FULLP });
bld('build_tz_override', { props: {}, payload: Object.assign({}, FULLP, { tz: 'UTC' }), override: { timezone: 'Europe/London' } });
bld('build_emaset', { props: {}, payload: FULLP, override: { emaSet: [{ len: 20, color: 'rgb(1,1,1)', width: 2 }, { len: 50, color: 'rgb(2,2,2)' }] } });
bld('build_emaset_levels', { props: { CHART_SHOW_LEVELS: 'true' }, payload: FULLP, override: { emaSet: [{ len: 20, color: 'rgb(1,1,1)' }] } });
bld('build_theme_override', { props: {}, payload: FULLP, override: { theme: '' } });
bld('build_exchange_empty', { props: {}, payload: FULLP, override: { exchange: '' } });
bld('build_budget_zero', { props: {}, payload: FULLP, override: { maxParams: 0 } });
bld('build_order_empty', { props: {}, payload: FULLP, override: { emaOrder: [] } });
bld('build_order_unknown', { props: { CHART_EMA_ORDER: '20,144' }, payload: FULLP });
bld('build_order_unknown_color', { props: { CHART_EMA_ORDER: '20,144', CHART_EMA_COLORS: '20:#fff,144:#000' }, payload: FULLP });
for (let i = 0; i < 260; i++) {
  const c = { props: randProps(0.45), payload: randPayload() };
  if (r() < 0.25) c.props.CHART_SHOW_LEVELS = 'true';
  if (r() < 0.1) c.override = { timezone: pickOf(['', 'Asia/Seoul']) };
  bld('build_r' + i, c);
}

// ---- 取圖 ----
const LONGBODY = '{"error":"' + 'x'.repeat(145) + '😀' + 'tail"}';
const fetchCases = [
  ['nokey', {}, [], FULLP],
  ['blankkey', { CHART_IMG_API_KEY: '   ' }, [], FULLP],
  ['ok', { CHART_IMG_API_KEY: 'k1' }, [{ status: 200, body: 'PNGDATA' }], FULLP],
  ['ok_multibyte', { CHART_IMG_API_KEY: ' k1 ' }, [{ status: 200, body: '圖圖圖' }], FULLP],
  ['ok_empty', { CHART_IMG_API_KEY: 'k1' }, [{ status: 200, body: '' }], FULLP],
  ['ok_slow', { CHART_IMG_API_KEY: 'k1' }, [{ status: 200, body: 'abc', advance: 1234 }], FULLP],
  ['e422', { CHART_IMG_API_KEY: 'k1' }, [{ status: 422, body: '{"msg":"bad"}', advance: 50 }], FULLP],
  ['e500_long', { CHART_IMG_API_KEY: 'k1' }, [{ status: 500, body: LONGBODY }], FULLP],
  ['e429', { CHART_IMG_API_KEY: 'k1' }, [{ status: 429, body: '' }], FULLP],
  ['e201', { CHART_IMG_API_KEY: 'k1' }, [{ status: 201, body: 'x' }], FULLP],
  ['throw', { CHART_IMG_API_KEY: 'k1' }, [{ throw: 'DNS failure', advance: 7 }], FULLP],
  ['throw_long', { CHART_IMG_API_KEY: 'k1' }, [{ throw: 'y'.repeat(200) }], FULLP],
  ['levels', { CHART_IMG_API_KEY: 'k1', CHART_SHOW_LEVELS: 'true', CHART_THEME: 'light', CHART_WATERMARK: '85' }, [{ status: 200, body: 'P' }], FULLP],
  ['sym_undef', { CHART_IMG_API_KEY: 'k1' }, [{ status: 200, body: 'P' }], { side: 'long', tf: '60' }],
  ['sym_num', { CHART_IMG_API_KEY: 'k1' }, [{ status: 200, body: 'P' }], { symbol: 5, tf: 60 }],
];
fetchCases.forEach(([id, props, plan, payload]) => { const c = { props, plan, payload }; V('fetch_' + id, 'chart_fetch', c, run.fetch(c)); });
for (let i = 0; i < 40; i++) {
  const c = { props: Object.assign({ CHART_IMG_API_KEY: 'k' }, randProps(0.4)), plan: [pickOf([{ status: 200, body: 'IMG' }, { status: 400, body: 'bad' }, { throw: 'boom' }])], payload: randPayload() };
  V('fetch_r' + i, 'chart_fetch', c, run.fetch(c));
}

// ---- sendPhoto ----
const MK = { inline_keyboard: [[{ text: '✅ 進場', callback_data: 'vg.c.abc' }, { text: '⏭ 略過', callback_data: 'vg.s.abc' }]] };
const OKP = JSON.stringify({ ok: true, result: { message_id: 7, photo: [{ file_id: 'a' }, { file_id: 'b' }] } });
const sendCases = [
  ['ok', 111, 'cap', MK, [{ status: 200, body: OKP }]],
  ['ok_nomarkup', '111', 'cap', undefined, [{ status: 200, body: OKP }]],
  ['ok_nullmarkup', -100123, '圖說😀', null, [{ status: 200, body: OKP }]],
  ['ok_emptymarkup', 5, 'c', {}, [{ status: 200, body: OKP }]],
  ['ok_noresult', 111, 'c', MK, [{ status: 200, body: '{"ok":true}' }]],
  ['notok', 111, 'c', MK, [{ status: 400, body: '{"ok":false,"description":"bad"}' }]],
  ['notok_long', 111, 'c', MK, [{ status: 400, body: '{"ok":false,"description":"' + 'z'.repeat(300) + '"}' }]],
  ['html', 111, 'c', MK, [{ status: 502, body: '<html>bad gateway</html>' }]],
  ['null_body', 111, 'c', MK, [{ status: 200, body: 'null' }]],
  ['array_body', 111, 'c', MK, [{ status: 200, body: '[]' }]],
  ['empty_body', 111, 'c', MK, [{ status: 200, body: '' }]],
  ['throw', 111, 'c', MK, [{ throw: 'timeout' }]],
  ['ok_truthy_num', 111, 'c', MK, [{ status: 200, body: '{"ok":1,"result":{"message_id":1}}' }]],
  ['ok_zero', 111, 'c', MK, [{ status: 200, body: '{"ok":0,"result":{"message_id":1}}' }]],
];
sendCases.forEach(([id, chatId, caption, markup, plan]) => {
  const c = { props: {}, plan, chatId, caption, markup, photo: 'PNGBYTES' };
  V('send_' + id, 'chart_send', c, run.send(c));
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'bot_e.json'), JSON.stringify(vectors));
console.log('bot_e.json', vectors.length, 'vectors');
