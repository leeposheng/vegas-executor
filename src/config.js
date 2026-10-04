'use strict';
/**
 * 設定載入與驗證。
 *
 * 設計原則：
 * 1. 所有金鑰只從環境變數讀，程式碼與 git 內絕不出現。
 * 2. DRY_RUN 預設為 true。要送出真實委託，必須「明確」把它設成 false，
 *    不是「忘記設定就會下單」。這是階段 0 最重要的一條防線。
 * 3. 啟動時就驗證，設定錯誤要在開機當下失敗，不要等到訊號來了才爆。
 */

const fs = require('fs');
const path = require('path');

/** 極簡 .env 讀取器（零依賴）。已存在的環境變數優先，不覆蓋。 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

// ---- 設定值解析 ----
//
// 這兩個小函式的行為，決定了「打錯字」會發生什麼事。
// 原本的寫法有兩個往危險方向倒的問題：
//
//   bool：`=== 'true'` 讓 DEMO_MODE=1 / yes / on / " true"（貼上時多一個空白）
//         全部落到 false，也就是「實盤」。使用者的意圖明明是開模擬盤。
//   num ：Number('50 USDT') 是 NaN，而 NaN 參與比較恆為 false，
//         於是 DAILY_LOSS_LIMIT_USDT 這類閘門變成永遠放行，開機還不報錯。
//
// 兩者都改成「看不懂就拒絕啟動」。設定錯誤要在開機時大聲爆掉，
// 不能變成一個安靜的、往風險那側傾斜的預設值。
const TRUTHY = ['true', '1', 'yes', 'on'];
const FALSY = ['false', '0', 'no', 'off'];

// 解析錯誤收集在這裡，由 validate() 一次報出，而不是在 require 當下就拋。
// 差別在於使用者看到什麼：立刻拋會得到一串堆疊，而且只會看到第一個錯；
// 收集起來則能一次列出全部問題，並且走 index.js 那條逐行輸出的路徑
// （雲端日誌收集器會把多行訊息吃掉，只留第一行）。
const parseErrors = [];

// 市值前段、且 OKX 有 USDT 永續的幣種（2026-09 整理）。
//
// 這份清單只是「候選」—— 開機時會與交易所實際有的合約取交集，
// 已下架或從未上架的會被自動剔除並在日誌列出。所以清單裡多寫幾個
// 不存在的代碼是安全的，不會讓服務起不來，也不會悄悄交易到錯的標的。
//
// 合約規格（ctVal / lotSz / minSz）不在這裡 —— 那些是交易所的事實，
// 由 instruments.js 在開機時取得。手抄五十組數字必然會錯一組，
// 而錯的那組要等它剛好出訊號才會爆。
const DEFAULT_SYMBOLS = [
  // 幣安／OKX／BingX 三家永續都要有的 50 個標的。
  //
  // 【排序依據】
  // 1-22 是查證過的市值順序（2026-09-26，排除穩定幣與三家沒有永續的標的）。
  // 23-50 是同一份名單裡的其餘標的，排名都在 40 名之後，未逐一查證 ——
  // 但全部是主流永續，三家上架的機率極高。
  //
  // 【三家都有，是開機時才真正確認的】
  // 這份清單只是「想要哪些」。開機時會跟每一家交易所要實際的合約清單，
  // 取交集之後才是真正生效的名單；對不上的會被剔除並印在日誌裡
  // （BingX 缺的會另外列一段，見 index.js 的 installSymbols）。
  //
  // 所以這裡不必、也不該追求百分之百精準 —— 追求精準的地方在開機日誌，
  // 那是唯一會隨交易所上下架自動更新的來源。寫死的清單只會越來越舊。

  // 1-10（查證過的市值順序）
  'BTCUSDT.P', 'ETHUSDT.P', 'BNBUSDT.P', 'XRPUSDT.P', 'SOLUSDT.P',
  'TRXUSDT.P', 'ZECUSDT.P', 'DOGEUSDT.P', 'LINKUSDT.P', 'ADAUSDT.P',
  // 11-22
  'XLMUSDT.P', 'BCHUSDT.P', 'NEARUSDT.P', 'UNIUSDT.P', 'LTCUSDT.P',
  'SUIUSDT.P', 'AVAXUSDT.P', 'HBARUSDT.P', 'TAOUSDT.P', 'ENAUSDT.P',
  'ONDOUSDT.P', 'AAVEUSDT.P',
  // 23-36（大型標的，排名 40 名外）
  'DOTUSDT.P', 'TONUSDT.P', 'PEPEUSDT.P', 'ICPUSDT.P', 'ETCUSDT.P',
  'ATOMUSDT.P', 'APTUSDT.P', 'POLUSDT.P', 'ARBUSDT.P', 'OPUSDT.P',
  'FILUSDT.P', 'ALGOUSDT.P', 'VETUSDT.P', 'TIAUSDT.P',
  // 37-50
  'INJUSDT.P', 'SEIUSDT.P', 'IMXUSDT.P', 'RUNEUSDT.P', 'GRTUSDT.P',
  'STXUSDT.P', 'WLDUSDT.P', 'LDOUSDT.P', 'JUPUSDT.P', 'CRVUSDT.P',
  'PYTHUSDT.P', 'SANDUSDT.P', 'GALAUSDT.P', 'AXSUSDT.P',
];

const bool = (v, dflt, name) => {
  if (v === undefined || String(v).trim() === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (TRUTHY.includes(s)) return true;
  if (FALSY.includes(s)) return false;
  parseErrors.push(
    `${name || '布林值'} 的值「${v}」無法解析，`
    + '請填 true / false（也接受 1 / 0、yes / no、on / off）'
  );
  // 回傳預設值只是為了讓其餘解析能繼續跑完、一次看到所有錯誤。
  // validate() 一定會擋下啟動，所以這個值不會被真的用到。
  return dflt;
};

const num = (v, dflt, name) => {
  if (v === undefined || String(v).trim() === '') return dflt;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) {
    parseErrors.push(
      `${name || '數值'} 的值「${v}」不是數字，`
      + '只填數字不要帶單位（例如 50，不是「50 USDT」）'
    );
    return dflt;
  }
  return n;
};

const config = {
  // ---- 執行模式 ----
  // true  = 只計算與記錄，不呼叫交易所下單端點（階段 0／1 前期）
  // false = 真實送單。切換前請先看 README 的檢查清單。
  dryRun: bool(process.env.DRY_RUN, true, 'DRY_RUN'),
  // true = 走交易所模擬盤（OKX x-simulated-trading、BingX VST）
  demo: bool(process.env.DEMO_MODE, true, 'DEMO_MODE'),

  // ---- 下單決策模式 ----
  // auto     = 通過閘門就直接下單（原本的行為）
  // manual   = 算完存成待確認，等 /confirm 才下單
  // by_grade = 依品質等級決定：高品質自動、其餘待確認
  //
  // 預設 manual。理由：這個功能存在的目的就是讓人在迴圈裡，
  // 若預設 auto，忘了設定就等於直接放手，方向錯了。
  executionMode: (process.env.EXECUTION_MODE || 'manual').toLowerCase(),
  // by_grade 模式下，等級 >= 此值才自動下單
  autoGradeMin: num(process.env.AUTO_GRADE_MIN, 3, 'AUTO_GRADE_MIN'),
  // 待確認訊號的存活秒數。超過就失效，不能再按。
  // 五分鐘是權衡：夠你從口袋掏出手機，又不至於用嚴重過時的價格進場。
  pendingTtlSec: num(process.env.PENDING_TTL_SEC, 300, 'PENDING_TTL_SEC'),

  // true = 每筆訊號都向交易所取一次合約規格，不用靜態表。
  // 預設 false：規格極少變動，而這會在下單的關鍵路徑上多掛一次外部呼叫。
  // 靜態表過時的偵測交給 npm run preflight —— 那是刻意執行的動作，
  // 失敗了看得見，不會在訊號進來的當下才爆。
  refreshSpec: bool(process.env.REFRESH_SPEC, false, 'REFRESH_SPEC'),

  // 要下單的交易所，逗號分隔。填兩家 = 同一筆訊號在兩邊各下一單。
  //
  // 【雙邊下單會讓曝險加倍，這點沒有商量餘地】
  // 兩家各用 FIXED_MARGIN_USDT 的保證金，所以總曝險是設定值的兩倍，
  // 單筆最大虧損也是兩倍。DAILY_LOSS_LIMIT_USDT 必須跟著調 ——
  // 否則第一筆虧損就會觸發上限，當天不再交易。
  //
  // 兩家的風控額度分開計算：MAX_CONCURRENT_POSITIONS=3 的意思是
  // 「每家最多三個標的在場」，不是「合計三個」。
  exchanges: (process.env.EXCHANGES
    || process.env.PRIMARY_EXCHANGE || 'okx')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  // 對帳間隔（秒）。0 = 停用。
  //
  // 60 秒是刻意的折衷：止損觸發到你收到推播之間最多差一分鐘，
  // 而每天約 1440 次查詢，遠低於 OKX 的頻率限制。
  // 調太短沒有意義 —— 部位已經平掉了，早一點知道不會改變結果；
  // 調太長則會讓 DAILY_LOSS_LIMIT 的反應變慢，那是有代價的。
  reconcileSec: num(process.env.RECONCILE_SEC, 60, 'RECONCILE_SEC'),
  // 殘留判定時限（分鐘）。交易所已無此部位、又查不到平倉紀錄，
  // 持續這麼久就放寬比對；仍對不上則釋放持倉額度並推播。
  // 太短會把交易所的短暫延遲誤判成殘留；太長則殘留會擋住新訊號。
  reconcileStaleMin: num(process.env.RECONCILE_STALE_MIN, 30, 'RECONCILE_STALE_MIN'),

  port: num(process.env.PORT, 8080, 'PORT'),
  // Apps Script 或 TradingView 轉送訊號時要帶的共用密鑰
  webhookSecret: process.env.EXECUTOR_WEBHOOK_SECRET || '',
  // 控制端點（/halt、/resume）用的密鑰，與上面分開
  controlSecret: process.env.EXECUTOR_CONTROL_SECRET || '',

  // ---- 風控 ----
  risk: {
    // 單筆風險佔權益比例。0.005 = 0.5%
    // ---- 倉位模式 ----
    // risk_pct      固定「虧損」＝權益 × RISK_PCT_PER_TRADE，名目隨止損距離浮動
    // fixed_margin  固定「保證金」＝FIXED_MARGIN_USDT，虧損隨止損距離浮動
    //
    // 兩者的槓桿意義完全相反：risk_pct 下槓桿與風險無關（只決定鎖多少錢），
    // fixed_margin 下槓桿就是風險旋鈕。換模式時不要沿用同一組直覺。
    sizingMode: (process.env.SIZING_MODE || 'risk_pct').toLowerCase(),
    fixedMarginUsdt: num(process.env.FIXED_MARGIN_USDT, 100, 'FIXED_MARGIN_USDT'),

    // 保證金上限。只在 AUTO_LEVERAGE=true 時有意義，而且只在一種
    // 情況下會被動用：槓桿已經頂到天花板、名目還沒到上限、虧損卻
    // 仍低於下限 —— 那時加保證金是唯一能把倉位放大的路。
    //
    // 【它在小帳戶上不會生效，這是對的】
    // 名目上限 ＝ 權益 × MAX_NOTIONAL_MULT。權益 1000、倍數 3 時
    // 上限是 3000，配最小保證金 100 就已經把槓桿壓到 30x，
    // 峰值 40x 根本碰不到，也就永遠輪不到加保證金。
    // 大約要權益 1700 以上這個區間才會開始運作。
    //
    // 留空 = 等於下限 = 不准加保證金（與舊行為相同）。
    fixedMarginMaxUsdt: num(process.env.FIXED_MARGIN_MAX_USDT, 0,
      'FIXED_MARGIN_MAX_USDT'),
    // 預估虧損（含來回手續費）必須落在這個區間，否則拒單。
    // 這是 fixed_margin 模式的主要保護：止損太緊或太寬的訊號都擋掉。
    lossMinUsdt: num(process.env.TARGET_LOSS_MIN_USDT, 20, 'TARGET_LOSS_MIN_USDT'),
    lossMaxUsdt: num(process.env.TARGET_LOSS_MAX_USDT, 45, 'TARGET_LOSS_MAX_USDT'),
    // 單邊 taker 費率。OKX 永續 VIP0 約 0.05%。
    feeRateOneWay: num(process.env.TAKER_FEE_RATE, 0.0005, 'TAKER_FEE_RATE'),

    pctPerTrade: num(process.env.RISK_PCT_PER_TRADE, 0.005, 'RISK_PCT_PER_TRADE'),
    // 帳戶權益（USDT）。階段 0 先手動填，階段 1 之後改為向交易所查詢
    // 這是「退路」而非「設定」。有憑證時會向交易所查真值；
    // 查不到才用這個數字 —— 而它永遠不會自己更新，所以只是保底。
    equityUsdt: num(process.env.ACCOUNT_EQUITY_USDT, 1000, 'ACCOUNT_EQUITY_USDT'),
    // exchange = 向交易所查（預設）｜config = 只用上面那個數字
    equitySource: (process.env.EQUITY_SOURCE || 'exchange').toLowerCase(),
    // 權益快取秒數。太短會在下單的關鍵路徑上多掛一次外部呼叫，
    // 太長則在連續下單時用到過時的本金。
    equityCacheMs: num(process.env.EQUITY_CACHE_SEC, 60, 'EQUITY_CACHE_SEC') * 1000,
    // 同時最多持有幾個部位
    maxConcurrent: num(process.env.MAX_CONCURRENT_POSITIONS, 3, 'MAX_CONCURRENT_POSITIONS'),

    // 持倉上限的「天花板」。Telegram 只能在 1 ～ 這個值之間調整。
    //
    // 【為什麼要兩層】
    // 按「進場」只賭這一筆；改持倉上限是改往後所有交易的風險範圍。
    // 兩者的後果差一個數量級，不該由同一道權限管。
    //
    // 環境變數只有你（或能登入 Zeabur 的人）改得到，所以天花板放這裡。
    // Telegram 那端就算被冒用，也踩不過這條線。
    maxConcurrentCeiling: num(process.env.MAX_CONCURRENT_CEILING, 5,
      'MAX_CONCURRENT_CEILING'),

    // 超額額度：達到持倉上限後，還允許「逐筆按鈕確認」再多開幾筆。
    //
    // 達上限且「只有」持倉上限這一道擋住時，訊號不再直接拒絕，而是改成
    // 待確認卡片＋「➕ 超額進場」按鈕。硬上限 ＝ 目前上限 ＋ 這個值。
    //
    // 為什麼不沿用 MAX_CONCURRENT_CEILING：它的預設值也是 5，上限調到 5
    // 的人會發現超額按鈕一筆都加不了。兩者管的是不同的事 ——
    // 天花板管「平常最多幾個」，超額管「我逐筆同意的例外最多幾個」。
    //
    // 只放環境變數：Telegram 那端就算被冒用，也加不出這個數字以外的倉位。
    // 0 ＝ 停用超額，達上限一律拒絕（舊行為）。
    overflowPositions: num(process.env.OVERFLOW_POSITIONS, 2, 'OVERFLOW_POSITIONS'),
    // 單日累計虧損達此金額（USDT）即停止當日下單
    dailyLossLimitUsdt: num(process.env.DAILY_LOSS_LIMIT_USDT, 50, 'DAILY_LOSS_LIMIT_USDT'),

    // 日損上限的天花板。Telegram 只能在 10 ～ 這個值之間調整。
    // 與 MAX_CONCURRENT_CEILING 同一個道理：能從手機改的東西，
    // 一定要有一個只能從 Zeabur 改的上界，否則兩層權限等於一層。
    //
    // 【預設值為什麼跟著現值走，而不是寫死 100】
    // 寫死的話，任何原本把 DAILY_LOSS_LIMIT_USDT 設超過 100 的人，
    // 一升級就啟動失敗 —— 他沒改任何設定，服務卻不動了，
    // 而錯誤訊息講的是一個他從沒聽過的新變數。
    // 新增一道限制不該讓既有設定變成非法；預設取「現值的兩倍」，
    // 既保證裝得下原本的值，又保留「最多調到兩倍」這個有意義的界線。
    dailyLossCeilingUsdt: num(
      process.env.DAILY_LOSS_CEILING_USDT,
      Math.max(100, num(process.env.DAILY_LOSS_LIMIT_USDT, 50, 'DAILY_LOSS_LIMIT_USDT') * 2),
      'DAILY_LOSS_CEILING_USDT'),

    // ---- 日損上限的重置 ----
    //
    // 【為什麼要有次數上限】
    // 一個按一下就歸零、想按幾次按幾次的重置鍵，等於沒有日損上限 ——
    // 而日損上限存在的唯一理由，就是擋住「剛虧完、想馬上贏回來」的那個人。
    // 那個人正好就是會去按重置鍵的人。
    //
    // 所以這裡設的不是「能不能重置」，是「今天最多能重置幾次」。
    // DAILY_RESET_LIMIT=1 的意思是：當日最大虧損從 50 變成約 100，
    // 就這樣，不會變成無限。0 代表完全關閉重置。
    //
    // 天花板一樣放環境變數，理由與 MAX_CONCURRENT_CEILING 相同：
    // Telegram 那端就算被冒用，也只能在這個範圍內動。
    dailyResetLimit: num(process.env.DAILY_RESET_LIMIT, 1, 'DAILY_RESET_LIMIT'),

    // 重置之後的冷卻分鐘數。這段期間閘門照樣擋單。
    //
    // 這是整組設計裡唯一真正有用的部分。連續觸發停損之後最危險的
    // 不是「額度用完」，是接下來那半小時的判斷力 —— 重置鍵解得開額度，
    // 解不開那個。冷卻是唯一把兩者分開的機制。
    // 設 0 就沒有冷卻，但請先想清楚自己是在關掉什麼。
    // 這個值是「下限」而不是預設值：Telegram 可以把冷卻調得更長，
    // 但調不短於它。
    //
    // 方向與日損上限相反，因為風險的方向相反 —— 日損「調大」比較危險，
    // 所以那邊管的是上界；冷卻「調短」比較危險，所以這邊管的是下界。
    // 一律只給天花板的話，這個參數會變成可以一鍵歸零的擺設。
    dailyResetCooldownMin: num(process.env.DAILY_RESET_COOLDOWN_MIN, 30,
      'DAILY_RESET_COOLDOWN_MIN'),
    // 單筆名目價值上限（USDT），防止倉位計算出錯時下出巨單
    // 名目上限有兩道，取較嚴格的那一道：
    //
    //   絕對上限 MAX_NOTIONAL_USDT —— 「無論如何都不准超過」的硬天花板
    //   相對上限 MAX_NOTIONAL_MULT —— 權益的幾倍，會跟著權益自動調整
    //
    // 只有絕對上限的話，權益一變它就失準：對小帳戶太鬆（攔不住任何東西），
    // 對大帳戶太緊（每一筆都被擋）。而權益是會變的 —— 入金、出金、賺賠。
    // 相對上限才是能長期放著不管的那一個。
    maxNotionalUsdt: num(process.env.MAX_NOTIONAL_USDT, 5000, 'MAX_NOTIONAL_USDT'),
    // 正常單筆名目約落在權益的 0.5～1.1 倍（視止損距離而定），
    // 所以 3 倍留有餘裕，又足以攔下「倉位算錯一個數量級」這類錯誤。
    maxNotionalMult: num(process.env.MAX_NOTIONAL_MULT, 3, 'MAX_NOTIONAL_MULT'),
    // 槓桿。只影響保證金估算與名目上限檢查，不影響風險金額
    leverage: num(process.env.LEVERAGE, 5, 'LEVERAGE'),

    // ---- 自動槓桿（fixed_margin 模式）----
    //
    // 開啟後，每筆訊號的槓桿由止損距離反推，而不是固定用 LEVERAGE。
    //
    // 【唯一的方向保證：只會往下調，不會往上調】
    // 起點永遠是 LEVERAGE，往下夾到兩個約束之內。所以自動槓桿
    // 只可能讓部位變小，不可能讓它變大 —— 這條性質讓它可以在
    // 真錢上開啟而不必重新評估風險上界。
    //
    // 兩個約束：
    //   1. 強平距離 ≥ 止損距離 × MIN_LIQ_CUSHION
    //      這是 LINK 那次的教訓。40x 的強平距離是 2.5%，若訊號的止損
    //      是 3.2%，這筆單一定先強平再談止損 —— 止損根本輪不到觸發。
    //   2. 預估虧損 ≤ TARGET_LOSS_MAX_USDT
    //      止損越寬名目要越小，才不會單筆超出預算。
    //
    // 止損「太緊」的情況刻意不處理：升槓桿不會改善手續費佔比
    //（費率 ÷（止損＋費率）與名目無關），只是用同樣的劣勢賭更大的金額。
    autoLeverage: bool(process.env.AUTO_LEVERAGE, false, 'AUTO_LEVERAGE'),

    // 強平距離至少要是止損距離的幾倍。
    // 低於 2 等於「止損稍微沒吃到就強平」，那道保護形同虛設。
    minLiqCushion: num(process.env.MIN_LIQ_CUSHION, 3, 'MIN_LIQ_CUSHION'),

    // ---- 確認時的進場價漂移檢查 ----
    // 只在 manual／by_grade 的「按下確認」那一刻生效。訊號剛產生時
    // 價格就是 entry，沒有漂移可言；漂移是人看卡片那幾十秒累積出來的。
    driftCheck: bool(process.env.DRIFT_CHECK, true, 'DRIFT_CHECK'),
    // 風險距離最多可以放大到原本的幾倍（進場價變差）
    driftMaxWiden: num(process.env.DRIFT_MAX_WIDEN, 1.5, 'DRIFT_MAX_WIDEN'),
    // 風險距離最少要保留原本的幾成（進場價變好，但數量會膨脹）
    driftMaxTighten: num(process.env.DRIFT_MAX_TIGHTEN, 0.75, 'DRIFT_MAX_TIGHTEN'),
    // 只接受等級 >= 此值的訊號。3=高品質 2=標準 1=弱訊
    minGrade: num(process.env.MIN_GRADE, 2, 'MIN_GRADE'),
    // 只接受這些週期（對應指標的 [週期] 欄位，以分鐘表示）
    // 允許交易的代碼。開機時會與交易所實際有的 USDT 永續取交集，
    // 名單裡有、交易所沒有的（下架、從未上架、打錯字）會被剔除並告警。
    //
    // 預設是三家交易所都有 USDT 永續、市值前 30 的幣種。刻意排除穩定幣
    // （USDC、DAI 之流）—— 它們的永續價格幾乎不動，維加斯通道那套
    // 趨勢邏輯在上面沒有意義，只會產生雜訊。
    //
    // 要改的話設 ALLOWED_SYMBOLS，逗號分隔，例如 "BTCUSDT.P,ETHUSDT.P"。
    // 名單越長，同時持倉上限與日損上限就越重要 —— 五十個標的一起發訊號
    // 時，擋下多餘部位的是那兩道閘門，不是你的手速。
    allowedSymbols: (process.env.ALLOWED_SYMBOLS || DEFAULT_SYMBOLS.join(','))
      .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),

    allowedTimeframes: (process.env.ALLOWED_TIMEFRAMES || '5,15,30,60')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // 訊號時間戳與現在時間差超過此秒數即丟棄（重放保護）
    maxSignalAgeSec: num(process.env.MAX_SIGNAL_AGE_SEC, 60, 'MAX_SIGNAL_AGE_SEC'),
  },

  // ---- 交易所 ----
  // 哪一家負責實際執行。另一家仍會做完整計算並記錄，方便比對。
  primaryExchange: (process.env.PRIMARY_EXCHANGE || 'okx').toLowerCase(),
  okx: {
    apiKey: process.env.OKX_API_KEY || '',
    apiSecret: process.env.OKX_API_SECRET || '',
    passphrase: process.env.OKX_PASSPHRASE || '',
    baseUrl: process.env.OKX_BASE_URL || 'https://www.okx.com',
    tdMode: process.env.OKX_TD_MODE || 'cross',
    // 持倉模式（net_mode / long_short_mode）不由使用者填寫 ——
    // 它是帳戶上的事實，填錯會讓每一筆下單被退件。
    // 開機自檢向交易所查得之後寫回這裡；自檢沒跑就維持 null。
    posMode: null,
  },
  bingx: {
    apiKey: process.env.BINGX_API_KEY || '',
    apiSecret: process.env.BINGX_API_SECRET || '',
    // ---- 模擬盤走不同的「網域」，不是不同的標頭 ----
    //
    // OKX 的模擬盤是同一個網域加一個 x-simulated-trading 標頭，
    // BingX 是整個換網域（VST ＝ Virtual USDT）。兩家做法不同，
    // 但使用者只設一個 DEMO_MODE，所以這裡要替他把網域選對。
    //
    // 【不自動選的話會發生什麼】
    // DEMO_MODE=true 但忘了改 BINGX_BASE_URL → OKX 走模擬、BingX 走真錢。
    // 同一筆訊號在兩邊，一邊是假的一邊是真的，而且沒有任何警告。
    // 這是這個系統裡最不該靜默發生的一類錯誤。
    //
    // 明確設了 BINGX_BASE_URL 就尊重它（有人會用自架代理），
    // 但 validate() 會檢查它與 DEMO_MODE 對不對得上。
    //
    // 【這道檢查在 BingX 上比在 OKX 上重要得多】
    // OKX 的模擬金鑰是獨立環境的，物理上碰不到真實資金 —— 填錯網域
    // 最多是打不通。BingX 的 VST 是同一個帳戶底下的虛擬餘額，
    // 決定真假的是網域而不是金鑰，所以填錯就是真錢。
    // 金鑰本身給不了任何保護，這道檢查是唯一的防線。
    baseUrl: process.env.BINGX_BASE_URL
      || (bool(process.env.DEMO_MODE, true, 'DEMO_MODE')
        ? 'https://open-api-vst.bingx.com'
        : 'https://open-api.bingx.com'),
  },

  // ---- 通知 ----
  telegram: {
    token: process.env.TG_TOKEN || '',
    chatId: process.env.TG_CHAT_ID || '',
  },

  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
};

/**
 * 啟動時驗證。分成「一定要有」與「送真單才要有」兩類，
 * 讓階段 0 能在沒有交易所金鑰的情況下跑起來。
 */
function validate() {
  // 解析階段的錯誤排在最前面：值都讀錯了，後面的規則檢查沒有意義。
  const errors = parseErrors.slice();

  if (!config.webhookSecret || config.webhookSecret.length < 16) {
    errors.push('EXECUTOR_WEBHOOK_SECRET 未設定或長度不足 16 字元');
  }
  if (!config.controlSecret || config.controlSecret.length < 16) {
    errors.push('EXECUTOR_CONTROL_SECRET 未設定或長度不足 16 字元');
  }
  if (config.controlSecret && config.webhookSecret === config.controlSecret) {
    errors.push('EXECUTOR_CONTROL_SECRET 不可與 EXECUTOR_WEBHOOK_SECRET 相同');
  }
  const r = config.risk;
  if (!(r.pctPerTrade > 0 && r.pctPerTrade <= 0.05)) {
    errors.push('RISK_PCT_PER_TRADE 必須介於 0 與 0.05（5%）之間');
  }
  if (!(r.equityUsdt > 0)) errors.push('ACCOUNT_EQUITY_USDT 必須大於 0');
  if (!['exchange', 'config'].includes(r.equitySource)) {
    errors.push('EQUITY_SOURCE 必須是 exchange 或 config');
  }
  if (!(r.equityCacheMs >= 0)) errors.push('EQUITY_CACHE_SEC 不可為負');
  // 下限 10 秒：更短只會撞上交易所頻率限制，換不到任何有用的即時性。
  if (!(config.reconcileStaleMin >= 5)) {
    errors.push('RECONCILE_STALE_MIN 必須至少 5 分鐘');
  }
  if (config.reconcileSec !== 0 && config.reconcileSec < 10) {
    errors.push('RECONCILE_SEC 必須是 0（停用）或至少 10 秒');
  }
  if (!(r.maxConcurrent >= 1)) errors.push('MAX_CONCURRENT_POSITIONS 必須 >= 1');
  if (!(r.maxConcurrentCeiling >= 1) || r.maxConcurrentCeiling > 20) {
    errors.push('MAX_CONCURRENT_CEILING 必須介於 1 與 20 之間');
  }
  if (!(r.overflowPositions >= 0) || r.overflowPositions > 10
      || !Number.isInteger(r.overflowPositions)) {
    errors.push('OVERFLOW_POSITIONS 必須是 0 到 10 的整數');
  }
  if (r.maxConcurrent > r.maxConcurrentCeiling) {
    errors.push(
      `MAX_CONCURRENT_POSITIONS(${r.maxConcurrent}) 不可超過 `
      + `MAX_CONCURRENT_CEILING(${r.maxConcurrentCeiling})。`
      + '天花板的意義就是「誰都不能超過」，包含這個預設值。'
    );
  }
  if (!Number.isInteger(r.dailyResetLimit) || r.dailyResetLimit < 0 || r.dailyResetLimit > 5) {
    errors.push(
      'DAILY_RESET_LIMIT 必須是 0 到 5 的整數。'
      + '0 代表關閉重置；超過 5 的話日損上限已經沒有意義了。'
    );
  }
  if (!(r.dailyResetCooldownMin >= 0) || r.dailyResetCooldownMin > 720) {
    errors.push('DAILY_RESET_COOLDOWN_MIN 必須介於 0 與 720 之間');
  }
  if (!(r.dailyLossCeilingUsdt > 0) || r.dailyLossCeilingUsdt > 100000) {
    errors.push('DAILY_LOSS_CEILING_USDT 必須大於 0 且不超過 100000');
  }
  if (r.dailyLossLimitUsdt > r.dailyLossCeilingUsdt) {
    errors.push(
      `DAILY_LOSS_LIMIT_USDT(${r.dailyLossLimitUsdt}) 不可超過 `
      + `DAILY_LOSS_CEILING_USDT(${r.dailyLossCeilingUsdt})。`
      + '天花板的意義就是「誰都不能超過」，包含這個預設值。'
    );
  }
  if (!(r.minLiqCushion >= 2) || r.minLiqCushion > 20) {
    errors.push(
      'MIN_LIQ_CUSHION 必須介於 2 與 20 之間。'
      + '低於 2 代表強平距離不到止損距離的兩倍，止損形同虛設。'
    );
  }
  if (!(r.maxNotionalUsdt > 0)) errors.push('MAX_NOTIONAL_USDT 必須大於 0');
  if (!(r.maxNotionalMult > 0)) errors.push('MAX_NOTIONAL_MULT 必須大於 0');
  if (!['risk_pct', 'fixed_margin'].includes(r.sizingMode)) {
    errors.push('SIZING_MODE 必須是 risk_pct 或 fixed_margin');
  }
  if (r.sizingMode === 'fixed_margin') {
    if (!(r.fixedMarginUsdt > 0)) errors.push('FIXED_MARGIN_USDT 必須大於 0');
    if (r.fixedMarginMaxUsdt && r.fixedMarginMaxUsdt < r.fixedMarginUsdt) {
      errors.push(
        `FIXED_MARGIN_MAX_USDT(${r.fixedMarginMaxUsdt}) 不可小於 `
        + `FIXED_MARGIN_USDT(${r.fixedMarginUsdt})。`
        + '上限小於下限的區間是空的，那樣設等於把自動加保證金關掉，'
        + '但看起來像開著。'
      );
    }
    if (!(r.lossMinUsdt > 0)) errors.push('TARGET_LOSS_MIN_USDT 必須大於 0');
    if (!(r.lossMaxUsdt > r.lossMinUsdt)) {
      errors.push('TARGET_LOSS_MAX_USDT 必須大於 TARGET_LOSS_MIN_USDT');
    }
    if (!(r.feeRateOneWay >= 0 && r.feeRateOneWay < 0.01)) {
      errors.push('TAKER_FEE_RATE 必須介於 0 與 0.01 之間');
    }
    // 固定保證金只有搭配逐倉才有意義：全倉模式下整個帳戶都在背書，
    // 跳空穿過止損時虧損可以遠超過那筆保證金。
    if (config.primaryExchange === 'okx' && config.okx.tdMode !== 'isolated') {
      console.warn(
        '⚠️ SIZING_MODE=fixed_margin 但 OKX_TD_MODE=' + config.okx.tdMode + '。\n'
        + '   固定保證金的前提是「單筆最多賠掉那筆保證金」，'
        + '而那只有逐倉（isolated）成立。\n'
        + '   全倉模式下整個帳戶都在背書，跳空時虧損不受 FIXED_MARGIN_USDT 限制。\n'
        + '   建議設 OKX_TD_MODE=isolated。'
      );
    }
  }
  if (!(r.leverage >= 1)) errors.push('LEVERAGE 必須 >= 1');
  if (!(r.driftMaxWiden > 1)) {
    errors.push('DRIFT_MAX_WIDEN 必須大於 1（等於 1 代表不容許任何漂移）');
  }
  if (!(r.driftMaxTighten > 0 && r.driftMaxTighten < 1)) {
    errors.push('DRIFT_MAX_TIGHTEN 必須介於 0 與 1 之間');
  }
  if (![1, 2, 3].includes(r.minGrade)) errors.push('MIN_GRADE 必須是 1、2 或 3');
  if (r.allowedTimeframes.length === 0) errors.push('ALLOWED_TIMEFRAMES 不可為空');
  for (const ex of config.exchanges) {
    if (!['okx', 'bingx'].includes(ex)) {
      errors.push(`EXCHANGES 裡的「${ex}」不認得，只能是 okx 或 bingx`);
    }
  }
  if (!config.exchanges.length) errors.push('EXCHANGES 不可為空');
  if (config.exchanges.includes('bingx')
      && (!config.bingx.apiKey || !config.bingx.apiSecret)) {
    errors.push('EXCHANGES 含 bingx，但 BINGX_API_KEY／BINGX_API_SECRET 未設定');
  }

  // BingX 目前有兩個已知且尚未補齊的缺口，兩者都只在真錢上才致命：
  //
  //   1. 沒有開機自檢，也沒有 setLeverage。.env 寫 LEVERAGE=40 不代表
  //      BingX 帳戶就是 40 —— 不一致的話兩家的曝險不對稱，
  //      而「固定保證金」這個前提在 BingX 那側是假的。
  //   2. 已實現損益是從資金流水聚合出來的（BingX 沒有單筆平倉紀錄端點）。
  //      同期間的其他交易或資金費會被一併計入，DAILY_LOSS_LIMIT
  //      因此可能讀到錯的數字。
  //
  // 模擬盤上這兩件事只是數字難看，真錢上是實質風險。所以擋在這裡，
  // 而不是留一行註解等人自己發現。
  // ---- 模擬／真實不可以混著跑 ----
  //
  // 這道檢查存在的理由，是一個沉默到無法察覺的失誤：
  // DEMO_MODE=true 配上真實盤網域，會讓 OKX 那一側是假的、
  // BingX 那一側是真的。卡片上兩邊都顯示「已下單」，
  // 而你要到看帳戶餘額時才發現其中一邊動了真錢。
  //
  // 反過來（DEMO_MODE=false 配 VST 網域）危害較小但一樣要擋：
  // 你以為在跑真錢，實際上所有損益都是假的，
  // 而日損上限與對帳全部建立在那些假數字上。
  if (config.exchanges.includes('bingx')) {
    const isVst = /open-api-vst\.bingx\.com/i.test(config.bingx.baseUrl);
    if (config.demo && !isVst) {
      errors.push(
        'DEMO_MODE=true 但 BINGX_BASE_URL 指向真實盤。\n'
        + `   目前：${config.bingx.baseUrl}\n`
        + '   這會讓 OKX 走模擬、BingX 走真錢 —— 同一筆訊號一邊假一邊真。\n'
        + '   要模擬就刪掉 BINGX_BASE_URL（會自動用 VST），'
        + '或填 https://open-api-vst.bingx.com'
      );
    }
    if (!config.demo && isVst) {
      errors.push(
        'DEMO_MODE=false 但 BINGX_BASE_URL 指向 VST 模擬盤。\n'
        + '   你會以為在跑真錢，而所有損益都是假的 —— '
        + '日損上限與對帳全部建立在那些數字上。'
      );
    }
  }

  if (config.exchanges.includes('bingx') && !config.dryRun && !config.demo) {
    errors.push(
      'BingX 尚未支援真實資金交易。\n'
      + '   開機自檢與槓桿設定已完成（2026-09-29）。剩下一件：\n'
      + '   已實現損益只能從資金流水（/user/income）聚合，同期間的其他\n'
      + '   交易會被算進來 —— 日損上限建立在那個數字上，因此不可信。\n'
      + '   解法是改用成交明細（/trade/allFillOrders）逐筆歸戶，\n'
      + '   而那需要在 VST 模擬盤上先累積幾筆真實成交才驗得了。\n'
      + '   目前請用 DEMO_MODE=true，或把 EXCHANGES 設成只有 okx。'
    );
  }
  // 雙邊下單時曝險加倍，日損上限必須撐得住至少一筆完整虧損，
  // 否則第一筆停損就會讓當天停止交易 —— 那不是風控，是設定沒跟上。
  if (config.exchanges.length > 1 && config.risk.sizingMode === 'fixed_margin') {
    const worstCase = config.risk.lossMaxUsdt * config.exchanges.length;
    if (config.risk.dailyLossLimitUsdt < worstCase) {
      console.warn(
        `⚠️ 雙邊下單的單筆最壞虧損為 ${worstCase} USDT`
        + `（${config.risk.lossMaxUsdt} × ${config.exchanges.length} 家），`
        + `但 DAILY_LOSS_LIMIT_USDT 只有 ${config.risk.dailyLossLimitUsdt}。\n`
        + '   第一筆停損就會觸發當日上限、停止所有交易。\n'
        + `   若這不是本意，把它調到 ${worstCase} 以上。`
      );
    }
  }
  if (!['okx', 'bingx'].includes(config.primaryExchange)) {
    errors.push('PRIMARY_EXCHANGE 必須是 okx 或 bingx');
  }
  if (!['auto', 'manual', 'by_grade'].includes(config.executionMode)) {
    errors.push('EXECUTION_MODE 必須是 auto、manual 或 by_grade');
  }
  if (![1, 2, 3].includes(config.autoGradeMin)) {
    errors.push('AUTO_GRADE_MIN 必須是 1、2 或 3');
  }

  // by_grade 的「按鈕區間」是 MIN_GRADE <= 等級 < AUTO_GRADE_MIN。
  // 兩者設成一樣（或 MIN_GRADE 更高）時這個區間是空的，
  // by_grade 會靜靜退化成 auto —— 每一筆都自動下單，沒有任何一筆需要確認。
  // 這不算設定錯誤（也許就是本意），但它與「by_grade」這個名字的預期相反，
  // 而且錯的方向是「比你以為的更自動」，所以必須在開機時講出來。
  if (config.executionMode === 'by_grade' && config.risk.minGrade >= config.autoGradeMin) {
    console.warn(
      '⚠️ EXECUTION_MODE=by_grade，但 MIN_GRADE(' + config.risk.minGrade + ')'
      + ' >= AUTO_GRADE_MIN(' + config.autoGradeMin + ')。\n'
      + '   沒有任何等級會落在「需要按鈕確認」的區間，實際行為等同 auto ——\n'
      + '   每一筆通過閘門的訊號都會直接下單。\n'
      + '   若要保留人工確認，請把 MIN_GRADE 調到低於 AUTO_GRADE_MIN。'
    );
  }
  if (!(config.pendingTtlSec >= 30 && config.pendingTtlSec <= 3600)) {
    errors.push('PENDING_TTL_SEC 必須介於 30 與 3600 秒之間');
  }

  // 只有要送真單時才強制要求金鑰
  if (!config.dryRun) {
    if (config.primaryExchange === 'okx') {
      if (!config.okx.apiKey || !config.okx.apiSecret || !config.okx.passphrase) {
        errors.push('DRY_RUN=false 時，OKX_API_KEY／SECRET／PASSPHRASE 皆為必填');
      }
    }
    if (config.primaryExchange === 'bingx') {
      if (!config.bingx.apiKey || !config.bingx.apiSecret) {
        errors.push('DRY_RUN=false 時，BINGX_API_KEY／SECRET 皆為必填');
      }
    }
  }

  if (errors.length) {
    throw new Error('設定驗證失敗：\n  - ' + errors.join('\n  - '));
  }
  return config;
}

module.exports = { config, validate, loadDotEnv };
