/**
 * ================================================================
 * 執行層橋接（Executor.gs）
 * 對應指標 v11.9、Apps Script 第 3.5 批、vegas-executor（Zeabur，需含超額進場與加倉）
 * ================================================================
 *
 * 【這個檔案在做什麼】
 * 把 TradingView 送來的「人類可讀的文字訊號」轉成「機器可讀的 JSON」，
 * 再轉送給執行服務（部署在 Zeabur）。
 *
 * 為什麼不直接讓 Pine 輸出 JSON：
 * 1. Pine 的 alert() 一次只能送一個字串。改成 JSON 之後，Telegram 收到的
 *    就會是一堆大括號，人看不懂。
 * 2. Apps Script 本來就在驗證 [幣種]、[週期]、[方向] 這些欄位，解析邏輯
 *    本來就該在這裡，不該拆成兩處。
 * 3. sig_id 現成 —— 去重用的 SHA-256 指紋正好就是唯一鍵。
 *
 * 結果：指標端一行都不用改，Telegram 訊息維持人類可讀，
 *      執行層拿到嚴格驗證過的 JSON。
 *
 * 【安裝方式】
 * 1. Apps Script 編輯器左側「檔案」旁的 + → 指令碼 → 命名為 Executor
 * 2. 把本檔案全部內容貼進去，存檔
 * 3. 在「專案設定 → 指令碼屬性」新增兩個屬性：
 *      EXECUTOR_URL              例如 https://你的服務.zeabur.app（只到網域）
 *      EXECUTOR_WEBHOOK_SECRET   執行層環境變數裡的第一把密鑰
 * 4. Code.gs 的 handleTradingViewSignal_ 已內建 forwardToExecutor_ 呼叫
 *    （位置在送出 Telegram 之前），不需要再手動加。
 * 5. 執行一次 setupExecutorBridge()（建立補送用的觸發器）
 * 6. 執行 testParseSignalToJson() 與 testExecutorConnection() 驗證
 *
 * 【設計原則】
 * 轉送失敗「絕不」影響 Telegram 快訊。執行層離線、重新部署、網路中斷，
 * 都只會讓訊號進入補送佇列，Telegram 照樣即時收到。
 *
 * 【v3.4 修正】
 * 1. 廣播群組改讀 SIGNAL_CHAT_ID／SIGNAL_THREAD_ID，與 Code.gs 共用同一組設定。
 *    原本讀 BROADCAST_CHAT_ID，指向一個同名的舊普通群組，結果是執行層正常時，
 *    正式的話題群組反而收不到訊號（只有執行層故障、改送原始訊號時才收得到）。
 * 2. 廣播版卡片不再帶出權益說明（equity.note）。那一行可能寫著
 *    「改用設定值 N USDT」，等於把帳戶規模公開到群組。
 * 3. forwardToExecutor_ 多回傳 broadcastSent，Code.gs 據此在廣播失敗時
 *    改送原始訊號到群組，群組不會因為廣播失敗而漏訊號。
 * 4. callExecutorApi_ 原本在 catch 裡呼叫 diagnoseFetchFailure_ 時漏傳 cfg，
 *    連線失敗會在 catch 裡再拋一次例外，違反「永不拋例外」。已修正。
 * 5. 連線失敗的處置說明改為 Zeabur 版本（Cloudflare 快速通道已退役）。
 * 6. testChartRequestShape 與現行「水平線排在均線前」的排序對齊；
 *    testRenderPendingCard 加測權益說明不得外洩；新增 testBroadcastTarget()。
 * 7. 併入另一條分支（repo apps-script/Executor.gs）的自動槓桿顯示：
 *    [風險] 標示預算或上限、槓桿被自動調低時註明原槓桿與原因、
 *    保證金被調高時另列 [保證金]。這幾行一樣只出現在私訊。
 *
 * 【v3.6】加倉
 * 同一個幣、同一個方向的訊號再次出現，且交易所上的既有部位浮盈為正時，
 * 執行層回 decision=pending＋addOn。卡片抬頭為「➕ 加倉機會」，多兩行
 * [加倉]／[次數]，按鈕為「➕ 加倉進場（第 N 次）」。群組廣播不受影響。
 *
 * 【v3.5】超額進場
 * 執行層達持倉上限、且只有這一道擋住時，改回 decision=pending＋overLimit。
 * 卡片抬頭為「🟡 已達持倉上限」，多一行 [持倉]，按鈕為「➕ 超額進場（第 N 筆）」。
 * 是否允許超額由執行層依待確認紀錄判定，callback_data 與一般進場相同。
 *
 * 【v3.4.1 修正】
 * postToExecutor_ 沒有把執行層回傳的 band／preview／equity 轉出去。
 * 這三個欄位是「👀 可觀察」抬頭、[效益] 與 [建議] 行、權益說明的資料來源，
 * 少了它們，虧損區間外的拒絕永遠顯示成「⛔ 未執行」、只剩一行 [原因]。
 */

// ---- 指令碼屬性名稱 ----
var EXECUTOR_URL_PROPERTY = 'EXECUTOR_URL';
var EXECUTOR_SECRET_PROPERTY = 'EXECUTOR_WEBHOOK_SECRET';

// ---- 補送佇列 ----
var EXECUTOR_RETRY_PREFIX = 'EXECRETRY_';
var EXECUTOR_RETRY_MAX_QUEUE = 50;
var EXECUTOR_RETRY_MAX_ATTEMPTS = 8;
var EXECUTOR_RETRY_MAX_AGE_MS = 2 * 60 * 60 * 1000;   // 2 小時後放棄
var EXECUTOR_RETRY_MAX_BACKOFF_MIN = 15;
var EXECUTOR_TIMEOUT_NOTE = '執行層無回應（可能是 Zeabur 服務重新部署中、休眠或未啟動）';

// ---- Telegram 按鈕 ----
// callback_data 硬上限 64 位元組。前綴 5 + sig_id 48 = 53，留有餘裕。
var SIG_ID_LENGTH = 48;
var CB_PREFIX = 'vg.';
var CB_CONFIRM = CB_PREFIX + 'c.';
var CB_SKIP = CB_PREFIX + 's.';
// 持倉上限的按鈕。與進場/略過分開前綴，因為它們的權限意義不同：
// 進場只影響這一筆，改上限影響往後所有交易。
var CB_LIMIT = CB_PREFIX + 'L.';

// 日損上限的重置。刻意做成兩段（ask → go）：
// 第一下只是把「你要抹掉多少虧損」攤開來看，第二下才真的執行。
// 風控的解除不該和「進場」一樣只需要一次點擊 —— 會去按這顆鍵的人，
// 正是日損上限當初要擋的那個人。多一步，是唯一還來得及後悔的地方。
var CB_DAILY = CB_PREFIX + 'D.';
var CB_DAILY_ASK = CB_DAILY + 'ask';
var CB_DAILY_GO = CB_DAILY + 'go';
// 日損上限與冷卻分鐘的調整鍵。後面接數值。
// 從拒絕卡片直接叫出日損面板。
var CB_DAILY_PANEL = CB_DAILY + 'panel';
var CB_DAILY_LIMIT = CB_DAILY + 'lim.';
var CB_DAILY_COOL = CB_DAILY + 'cd.';

// ---- 訊號群組（廣播）----
//
// 【兩個聊天室，兩種權限】
//   ALLOWED_CHAT_ID   你的私訊。帶按鈕的卡片、面板、結果都在這裡。
//   SIGNAL_CHAT_ID    群組。只送訊號本身，沒有按鈕，沒有帳戶數字。
//   SIGNAL_THREAD_ID  群組裡的話題（選填）。話題群組才需要。
//
// 為什麼不是「同一張卡片發兩份」：卡片下半段是你的風險金額、名目與
// 倉位大小 —— 那些會反推出你的帳戶規模。訊號是可以分享的，
// 帳戶規模不是。所以廣播版是另外組的，不是把按鈕拿掉而已。
//
// 【v3.4：為什麼改讀 SIGNAL_CHAT_ID】
// 原本這裡讀 BROADCAST_CHAT_ID，Code.gs 讀 SIGNAL_CHAT_ID —— 同一件事
// 有兩個設定，結果兩個設定指到了兩個不同的群組：執行層正常時訊號進
// 舊群組，執行層故障時才進正式群組。群組只該有一個來源。
var BROADCAST_CHAT_PROPERTY = 'SIGNAL_CHAT_ID';
var BROADCAST_THREAD_PROPERTY = 'SIGNAL_THREAD_ID';
var OPERATOR_IDS_PROPERTY = 'OPERATOR_USER_IDS';

// ================================================================
// 一、文字 → JSON
// ================================================================

/**
 * 取出 [標籤] 後面到行尾的內容。
 * 用 [^\r\n] 而非 .* 是為了確保不會跨行誤抓。
 */
function extractField_(text, label) {
  var re = new RegExp('\\[' + label + '\\]\\s*([^\\r\\n]+)');
  var m = String(text || '').match(re);
  return m ? String(m[1]).trim() : null;
}

/**
 * 價格欄位形如「85397.5 USDT」，取開頭的數字。
 * 測試訊號的「測試值」會得到 NaN，由呼叫端擋下。
 */
function parsePrice_(raw) {
  if (raw === null || raw === undefined) return null;
  var n = parseFloat(String(raw).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

/**
 * 週期中文 → 分鐘數字串。這是 Pine 端 f_tfText 的反向轉換，
 * 兩邊必須同步修改，否則週期白名單會失效。
 */
function tfTextToMinutes_(text) {
  var t = String(text || '').trim();
  var m;

  // --- 指標 f_tfText 的中文輸出 ---
  if ((m = t.match(/^(\d+(?:\.\d+)?)分鐘$/))) return String(Math.round(Number(m[1])));
  if ((m = t.match(/^(\d+(?:\.\d+)?)小時$/))) return String(Math.round(Number(m[1]) * 60));
  if (t === '日線') return '1440';
  if ((m = t.match(/^(\d+)日$/))) return String(Number(m[1]) * 1440);
  if (t === '週線') return '10080';
  if ((m = t.match(/^(\d+)週$/))) return String(Number(m[1]) * 10080);

  // --- TradingView 原生 {{interval}} 的輸出 ---
  // 手動建立測試警報時常直接用 {{interval}}，它給的是 "15"、"60"、"D"、"W"
  // 這類原始代碼，而不是中文。這裡一併支援，測試警報才不會卡在解析階段。
  if (/^\d+$/.test(t)) return t;                                   // 已經是分鐘數
  if ((m = t.match(/^(\d*)D$/i))) return String((Number(m[1]) || 1) * 1440);
  if ((m = t.match(/^(\d*)W$/i))) return String((Number(m[1]) || 1) * 10080);

  // 秒級與月線刻意不支援：前者低於執行層的最小粒度，後者不在策略適用範圍
  return null;
}

/** 品質文字 → 等級數字。與指標的 gradeLabel 對應。 */
function gradeTextToNumber_(text) {
  var t = String(text || '').trim();
  if (t === '高品質') return 3;
  if (t === '標準') return 2;
  if (t === '弱訊') return 1;
  return null;
}

/**
 * 主解析函式。
 * @param {string} signalText  TradingView 送來的原始文字
 * @param {string} sigId       唯一鍵（用去重指紋）
 * @param {number} nowMs       目前時間（測試時可注入）
 * @returns {{ok:boolean, payload?:object, errors?:string[]}}
 */
function parseSignalToJson_(signalText, sigId, nowMs) {
  var text = String(signalText || '');
  var errors = [];

  var symbol = extractField_(text, '幣種');
  if (!symbol) errors.push('找不到 [幣種]');

  var tfRaw = extractField_(text, '週期');
  var tf = tfTextToMinutes_(tfRaw);
  if (!tfRaw) errors.push('找不到 [週期]');
  else if (!tf) errors.push('無法解析週期「' + tfRaw + '」（不支援秒級與月線）');

  var gradeRaw = extractField_(text, '品質');
  var grade = gradeTextToNumber_(gradeRaw);
  if (!gradeRaw) errors.push('找不到 [品質]');
  else if (!grade) errors.push('無法解析品質「' + gradeRaw + '」');

  // v11.9 起指標會送 [分數]。舊版指標沒有這個欄位，因此「缺漏」不算錯誤 ——
  // 一個在指標升級前就會全面拒單的解析器，比沒有分數糟得多。
  var scoreInfo = parseScoreField_(text);

  var dirRaw = extractField_(text, '方向');
  var side = null;
  if (!dirRaw) errors.push('找不到 [方向]');
  else if (dirRaw.indexOf('做多') !== -1) side = 'long';
  else if (dirRaw.indexOf('做空') !== -1) side = 'short';
  else errors.push('無法解析方向「' + dirRaw + '」');

  var entryRaw = extractField_(text, '價格');
  var entry = parsePrice_(entryRaw);
  if (entry === null) errors.push('找不到或無法解析 [價格]');

  // 報價幣（USDT）只用於顯示。從 [價格] 取而不是寫死，是因為指標送的是
  // syminfo.currency —— 換成別的計價幣時，卡片要跟著變，不能假設永遠是 USDT。
  var quote = parsePriceUnit_(entryRaw);

  var sl = parsePrice_(extractField_(text, '止損'));
  if (sl === null) errors.push('找不到或無法解析 [止損]');

  var tp = [];
  for (var i = 1; i <= 3; i++) {
    var v = parsePrice_(extractField_(text, '止盈' + i));
    if (v !== null) tp.push(v);
  }
  if (tp.length === 0) errors.push('找不到任何 [止盈N]');

  if (errors.length) return { ok: false, errors: errors };

  // 方向與止損側別的交叉檢查。執行層還會再驗一次，但在這裡先擋下
  // 可以讓錯誤訊息停留在「格式解析」層級，比較好追查來源。
  if (side === 'long' && sl >= entry) {
    errors.push('做多訊號的止損 ' + sl + ' 未低於進場價 ' + entry);
  }
  if (side === 'short' && sl <= entry) {
    errors.push('做空訊號的止損 ' + sl + ' 未高於進場價 ' + entry);
  }
  if (errors.length) return { ok: false, errors: errors };

  return {
    ok: true,
    payload: {
      v: '11.9',
      // 用去重指紋當唯一鍵：同一則訊號永遠得到同一個 sig_id，
      // 因此執行層的冪等保護會自動生效，補送重試不會造成重複下單。
      //
      // 截到 48 字元是為了 Telegram：callback_data 上限 64 位元組，
      // 加上 'vg.c.' 前綴後 53 位元組剛好放得下。SHA-256 取前 48 個
      // 十六進位字元仍有 192 位元，碰撞機率可忽略。
      sig_id: String(sigId || '').replace(/^tv:/, '').slice(0, SIG_ID_LENGTH),
      ts: nowMs === undefined ? Date.now() : nowMs,
      symbol: symbol,
      tf: tf,
      grade: grade,
      // 以下三個是「原樣保留」的顯示欄位，不參與任何判斷。
      // 卡片要跟原始訊號長得一樣，就不能只留轉換後的數值：
      // tf 轉成 '15' 之後，'15分鐘' 這個寫法就回不來了。
      tf_text: tfRaw,
      grade_text: gradeRaw,
      quote: quote,
      // 指標送的時區（webhookTimezone）。K 線圖要用它，否則圖上的
      // 時間軸會與訊號的 [時間] 對不起來 —— 同一根 K 棒在兩邊顯示不同時刻。
      tz: extractField_(text, '時區'),
      // 分數只用於顯示，不參與任何閘門或倉位計算。執行層的 signal.js
      // 對 score 做 0-100 驗證但視為選填，傳 null 等同沒傳。
      score: scoreInfo.score,
      // 降級原因不送到執行層（它不認得這個欄位，也用不到），
      // 留在 payload 是給卡片排版用的。
      demote: scoreInfo.demote,
      side: side,
      entry: entry,
      sl: sl,
      tp: tp
    }
  };
}

/**
 * 解析 [分數] 欄位。形如「82」或「82（降級：觸碰過多＋近期反向訊號）」。
 *
 * 分數與等級看起來矛盾時（82 分卻只有 2★），原因就在括號裡 ——
 * 那不是計算錯誤，是指標的降級機制生效。把它一起帶出來，
 * 是為了讓卡片能直接回答「為什麼」，而不是讓人每次重新推敲。
 *
 * 全形括號與半形括號都接受：指標送的是全形，但人工轉貼常會變成半形。
 */
/**
 * 從「791.3 USDT」取出「USDT」。取不到就回空字串 —— 沒有單位總比
 * 標錯單位好，後者會讓人以為是另一種計價幣。
 */
function parsePriceUnit_(raw) {
  if (raw === null || raw === undefined) return '';
  var m = String(raw).match(/[\d.,]+\s*([A-Za-z][A-Za-z0-9]*)/);
  return m ? m[1] : '';
}

function parseScoreField_(text) {
  var raw = extractField_(text, '分數');
  if (raw === null) return { score: null, demote: null };

  var n = parseFloat(String(raw).replace(/,/g, ''));
  var m = String(raw).match(/降級[：:]\s*([^）)]+)/);
  return {
    score: (isFinite(n) && n >= 0 && n <= 100) ? n : null,
    demote: m ? String(m[1]).trim() : null
  };
}

// ================================================================
// 二、轉送
// ================================================================

/**
 * 把使用者填的網址正規化成「只有 scheme://host」的形式。
 *
 * 這裡刻意做得很寬容，因為最常見的設定錯誤就是直接把瀏覽器網址列的
 * 內容貼進來（例如驗證時開的 https://xxx.zeabur.app/health）。
 * 若不處理，程式會再接一次 /health，變成 /health/health 而得到 404 ——
 * 而且那個 404 是執行層自己回的，看起來像是「連上了但壞掉」，很難追查。
 *
 * 一律只取通訊協定與主機名稱，路徑、查詢字串、尾斜線全部丟棄。
 */
function normalizeExecutorUrl_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var m = s.match(/^(https?:\/\/[^\/\s?#]+)/i);
  return m ? m[1] : s.replace(/\/+$/, '');
}

/** 回報使用者填的網址是否含有多餘的路徑，供診斷用。 */
function executorUrlHadPath_() {
  var raw = String(
    PropertiesService.getScriptProperties().getProperty(EXECUTOR_URL_PROPERTY) || ''
  ).trim();
  if (!raw) return false;
  return raw.replace(/\/+$/, '') !== normalizeExecutorUrl_(raw);
}

function getExecutorConfig_() {
  var props = PropertiesService.getScriptProperties();
  var url = normalizeExecutorUrl_(props.getProperty(EXECUTOR_URL_PROPERTY));
  var secret = String(props.getProperty(EXECUTOR_SECRET_PROPERTY) || '').trim();
  return { url: url, secret: secret, enabled: Boolean(url && secret) };
}

/**
 * 轉送訊號給執行層。這個函式「永遠不拋出例外」——
 * 轉送是附加功能，絕不能拖累 Telegram 快訊。
 *
 * @param {string} signalText  原始文字訊號
 * @param {string} dedupKey    reserveSignal_ 產生的去重鍵
 */
function forwardToExecutor_(signalText, dedupKey) {
  // 回傳值告訴 Code.gs 兩件事：
  //   cardSent       私訊的帶按鈕卡片送出了沒
  //   broadcastSent  群組的廣播版送出了沒
  // Code.gs 依此決定哪一邊要補送原始訊號 —— 通知絕不能因為這個
  // 附加功能而消失，但也不能兩邊重複推。
  var NO_CARD = { cardSent: false, broadcastSent: false };
  try {
    var cfg = getExecutorConfig_();
    if (!cfg.enabled) {
      return NO_CARD;   // 未設定即視為停用，不記錄，避免日誌被灌爆
    }

    var parsed = parseSignalToJson_(signalText, dedupKey);
    if (!parsed.ok) {
      logEvent_('warn', 'executor_parse_failed', {
        source: 'executor',
        errors: parsed.errors.join('；')
      });
      return NO_CARD;
    }

    var result = postToExecutor_(parsed.payload, cfg);
    var cardSent = false;
    var broadcastSent = false;
    if (result.ok) {
      // 待確認的那一則由這裡發，因為按鈕的 callback 會回到 Apps Script 的
      // webhook，訊息必須由同一個 Bot 送出才對得起來。payload 帶 notify:false
      // 就是在告訴執行層「Telegram 這則我來發」，避免重複推播。
      // 三種決策都發卡片。原本只有 pending 會發，其餘退回原始訊號 ——
      // 那在 manual 模式下還說得過去（只有待確認需要你動作），
      // 但在 by_grade／auto 下「已下單」與「被拒絕」變得無法分辨，
      // 兩者都只是一則原始訊號。自動模式下你不在迴圈裡，
      // 這則通知就是唯一的窗口，它必須講清楚發生了什麼。
      // error 也要發卡片，而且它最重要。
      //
      // error 的意思是「下單過程拋了例外」—— 請求可能已經送達交易所
      // 並且成交了，只是回應在半路不見。原本它不在名單裡，於是會退成
      // 一則看起來完全正常的原始訊號：你不會知道有一筆單可能已經成立，
      // 更可能因此手動補一單而變成雙倍部位。
      if (['pending', 'placed', 'rejected', 'error'].indexOf(result.decision) !== -1) {
        var out = sendPendingCard_(parsed.payload, result, signalText);
        cardSent = Boolean(out && out.sent);
        broadcastSent = Boolean(out && out.broadcastSent);
      }
      // 送達不等於被接受，依 decision 分成三個事件，
      // 日誌一眼就能看出「有沒有真的建立水位」。
      var ev = result.decision === 'placed' ? 'executor_placed'
        : result.decision === 'pending' ? 'executor_pending'
          : result.decision === 'error' ? 'executor_error'
            : 'executor_rejected';
      logEvent_(result.decision === 'rejected' ? 'warn' : 'info', ev, {
        source: 'executor',
        sigId: parsed.payload.sig_id.slice(-12),
        decision: result.decision,
        reasons: truncate_((result.reasons || []).join('；'), 200),
        elapsedMs: result.elapsedMs
      });
      // Code.gs 讀 cardSent 與 broadcastSent；result 與 payload 是給測試函式用的，
      // 讓測試能走完整條正式路徑而不必自己重做一遍邏輯（否則兩邊會走鐘）。
      return {
        cardSent: cardSent,
        broadcastSent: broadcastSent,
        result: result,
        payload: parsed.payload
      };
    }

    // 送不到就排進補送佇列。執行層有冪等保護，重送安全。
    var queued = enqueueExecutorRetry_(parsed.payload, result.error);
    logEvent_(queued ? 'warn' : 'error',
      queued ? 'executor_queued_for_retry' : 'executor_forward_dropped', {
        source: 'executor',
        sigId: parsed.payload.sig_id.slice(-12),
        message: result.error
      });
    return NO_CARD;
  } catch (error) {
    // 最外層保險：任何意外都不能影響主流程
    console.error('轉送執行層時發生非預期錯誤：' +
      redactLogText_(error && error.message ? error.message : String(error)));
    return NO_CARD;
  }
}

/**
 * 呼叫執行層的 /limits、/daily 等管理端點。用訊號金鑰，不是控制金鑰 ——
 * 控制金鑰能解除 kill switch，那個權力刻意不放進 Apps Script。
 *
 * 永不拋例外：取不到就回 { ok:false, error }，由呼叫端決定怎麼說。
 */
function callExecutorApi_(path, method, body) {
  var cfg = null;
  try {
    cfg = getExecutorConfig_();
    if (!cfg.enabled) return { ok: false, error: '執行層未設定' };
    var opts = {
      method: method,
      headers: { 'X-Executor-Key': cfg.secret },
      muteHttpExceptions: true,
      followRedirects: true
    };
    if (body) {
      opts.contentType = 'application/json';
      opts.payload = JSON.stringify(body);
    }
    var res = UrlFetchApp.fetch(cfg.url + path, opts);
    var text = res.getContentText();
    try {
      return JSON.parse(text);
    } catch (e) {
      return { ok: false, error: 'HTTP ' + res.getResponseCode() + '：' + truncate_(text, 120) };
    }
  } catch (err) {
    // v3.4：原本這裡呼叫 diagnoseFetchFailure_(err) 漏傳 cfg，
    // 函式內讀 cfg.url 時再拋一次 TypeError —— 「永不拋例外」在連線失敗
    // 這個最需要它的時刻失效了。現在傳入 cfg，函式本身也容許 cfg 為空。
    return { ok: false, error: diagnoseFetchFailure_(err, cfg) };
  }
}

function callExecutorLimits_(method, body) { return callExecutorApi_('/limits', method, body); }
function getExecutorJson_() { return callExecutorApi_('/limits', 'get', null); }
function postExecutorJson_(path, body) { return callExecutorApi_(path || '/limits', 'post', body); }

/** 日損上限的現況。取不到就回 null 讓呼叫端據實以告，不要猜。 */
function getDailyState_() { return callExecutorApi_('/daily', 'get', null); }

/**
 * 實際送出訊號的 HTTP 呼叫。回傳結構化結果而非拋例外，方便呼叫端決定要不要重試。
 */
function postToExecutor_(payload, cfg) {
  var started = Date.now();
  try {
    var res = UrlFetchApp.fetch(cfg.url + '/signal', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Executor-Key': cfg.secret },
      // notify:false —— Telegram 那一則由 Apps Script 發（帶按鈕），
      // 執行層不要再發一則。
      payload: JSON.stringify(Object.assign({ notify: false }, payload)),
      muteHttpExceptions: true,
      followRedirects: true
    });

    var status = res.getResponseCode();
    var bodyText = res.getContentText();

    if (status !== 200) {
      return {
        ok: false,
        elapsedMs: Date.now() - started,
        error: '執行層回應 HTTP ' + status + '：' + truncate_(bodyText, 150)
      };
    }

    var body = {};
    try { body = JSON.parse(bodyText); } catch (e) { /* 保持空物件 */ }

    // 執行層一律回 200，決策結果在 body.decision。
    // 「被拒絕」不是傳輸失敗，不該重試 —— 重試一百次也還是會被同樣的閘門擋下。
    return {
      ok: true,
      elapsedMs: Date.now() - started,
      decision: body.decision || 'unknown',
      reasons: body.reasons || [],
      sizing: body.sizing || null,
      // v3.4.1：這三個欄位執行層一直有回，但這裡原本沒有轉出去 ——
      // 於是 isObservable_ 看不到 band、卡片畫不出 [效益]，權益說明也不會出現。
      // 區間外的拒絕因此一律顯示成「⛔ 未執行」，而不是「👀 可觀察」。
      band: body.band || null,
      preview: body.preview || null,
      equity: body.equity || null,
      // v3.5：達持倉上限時，執行層改回 pending＋overLimit，卡片換成超額進場按鈕
      overLimit: body.overLimit || null,
      // v3.6：同幣同向且已持有浮盈部位時，執行層回 pending＋addOn
      addOn: body.addOn || null,
      dryRun: Boolean(body.dryRun)
    };
  } catch (error) {
    // 連線根本沒建立。分類出來寫進日誌，日後翻紀錄時才分得出
    //「網址失效」與「服務沒在跑」—— 兩者的處置完全不同。
    var kind = typeof classifyFetchError_ === 'function'
      ? classifyFetchError_(error) : 'unknown';
    var note = kind === 'dns'
      ? '執行層網址已失效（網域查不到，請到 Zeabur 確認公開網域並更新 ' + EXECUTOR_URL_PROPERTY + '）'
      : EXECUTOR_TIMEOUT_NOTE;
    return {
      ok: false,
      errorKind: kind,
      elapsedMs: Date.now() - started,
      error: note + '：' +
        truncate_(String(error && error.message ? error.message : error), 120)
    };
  }
}

// ================================================================
// 三、補送佇列
// ================================================================

function enqueueExecutorRetry_(payload, reason) {
  try {
    var props = PropertiesService.getScriptProperties();
    var pending = countKeysWithPrefix_(props.getKeys(), EXECUTOR_RETRY_PREFIX);
    if (pending >= EXECUTOR_RETRY_MAX_QUEUE) {
      console.error('執行層補送佇列已滿（' + EXECUTOR_RETRY_MAX_QUEUE + '），本筆丟棄。');
      return false;
    }
    var now = Date.now();
    props.setProperty(EXECUTOR_RETRY_PREFIX + now + '_' + payload.sig_id.slice(-12),
      JSON.stringify({
        payload: payload,
        firstFailedAt: now,
        nextAttemptAt: now,
        attempts: 1,
        lastError: truncate_(redactLogText_(reason), 200)
      }));
    return true;
  } catch (error) {
    console.error('執行層補送佇列寫入失敗：' +
      redactLogText_(error && error.message ? error.message : String(error)));
    return false;
  }
}

/**
 * 每分鐘觸發器的處理函式。
 *
 * 重要：補送時「不」更新 payload 的 ts。
 * 執行層有 60 秒的重放保護，所以超過一分鐘的補送會被它以「訊號已過期」拒絕。
 * 這是正確的行為 —— 一筆兩小時前的進場訊號，價格早已不同，不該再下單。
 * 補送的意義在於「讓執行層知道曾經有過這筆訊號」並留下完整紀錄，
 * 而不是強行讓它成交。
 */
function flushExecutorQueue() {
  // getKeys() 只取鍵名，比 getProperties() 取回所有值便宜得多。
  // 佇列為空時（絕大多數的每分鐘觸發）就直接結束，不再整包讀取屬性。
  var props = PropertiesService.getScriptProperties();
  var keys = props.getKeys().filter(function (k) {
    return k.indexOf(EXECUTOR_RETRY_PREFIX) === 0;
  }).sort();
  if (keys.length === 0) return;

  var cfg = getExecutorConfig_();
  if (!cfg.enabled) return;

  // 執行層離線時，每筆 POST 都要等連線逾時，整批可能超過 60 秒而與下一次
  // 觸發重疊。沒有鎖的話兩個執行緒會處理同一批，產生重複轉送與混亂的日誌。
  // 用 UserLock，與 Code.gs 主流程的 ScriptLock 分開，避免互相阻塞。
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) {
    console.warn('執行層補送已在進行中，本次略過。');
    return;
  }

  try {
    keys.forEach(function (key) {
      var raw = props.getProperty(key);
      if (!raw) return;
      var item;
      try {
        item = JSON.parse(raw);
      } catch (e) {
        props.deleteProperty(key);
        return;
      }

      var now = Date.now();
      var attempts = Number(item.attempts || 1);
      var ageMs = now - Number(item.firstFailedAt || now);
      var shortId = String((item.payload && item.payload.sig_id) || '').slice(-12);

      if (ageMs > EXECUTOR_RETRY_MAX_AGE_MS || attempts >= EXECUTOR_RETRY_MAX_ATTEMPTS) {
        props.deleteProperty(key);
        logEvent_('error', 'executor_signal_dropped', {
          source: 'executor',
          sigId: shortId,
          attempts: attempts,
          ageMinutes: Math.round(ageMs / 60000),
          lastError: item.lastError || ''
        });
        return;
      }

      if (now < Number(item.nextAttemptAt || 0)) return;

      var result = postToExecutor_(item.payload, cfg);

      if (result.ok) {
        props.deleteProperty(key);
        // 送達不等於被接受。執行層有 60 秒重放保護，延遲超過一分鐘的補送
        // 會以「訊號已過期」被拒 —— 那是正確的行為（價格早已不同），
        // 但若和真正成交共用同一個 info 事件，日誌會讓人誤以為補送成功。
        // 因此依 decision 分流成三種事件，等級也不同。
        var accepted = result.decision === 'placed';
        var reasons = (result.reasons || []).join('；');
        logEvent_(accepted ? 'info' : 'warn',
          accepted ? 'executor_retry_placed' : 'executor_retry_rejected', {
            source: 'executor',
            sigId: shortId,
            attempts: attempts + 1,
            decision: result.decision,
            delayMinutes: Math.round(ageMs / 60000),
            reasons: truncate_(reasons, 200)
          });
        return;
      }

      var backoff = Math.min(Math.pow(2, attempts - 1), EXECUTOR_RETRY_MAX_BACKOFF_MIN);
      item.attempts = attempts + 1;
      item.nextAttemptAt = now + backoff * 60000;
      item.lastError = truncate_(redactLogText_(result.error), 200);
      props.setProperty(key, JSON.stringify(item));
    });
  } finally {
    lock.releaseLock();
  }
}


// ================================================================
// 四、Telegram 按鈕
// ================================================================

/** 呼叫 Telegram Bot API。回傳解析後的 JSON，失敗時回 null 而不拋例外。 */
function tgApi_(method, body) {
  try {
    var cfg = getConfig_();
    var res = UrlFetchApp.fetch(
      'https://api.telegram.org/bot' + cfg.tgToken + '/' + method,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      }
    );
    var data = JSON.parse(res.getContentText());
    if (!data.ok) {
      console.warn('Telegram ' + method + ' 失敗：' +
        redactLogText_(truncate_(res.getContentText(), 200)));
      return null;
    }
    return data.result;
  } catch (error) {
    console.error('Telegram ' + method + ' 例外：' +
      redactLogText_(error && error.message ? error.message : String(error)));
    return null;
  }
}

/** 待確認卡片的文字。刻意把「數量」與「風險金額」放在最顯眼的位置。 */
/**
 * 卡片的第一行。依決策而變 —— 這是整張卡片裡最先被讀到、也最常只被讀到的一行。
 *
 * 自動模式下這件事特別重要：你不在迴圈裡，這則通知就是你唯一的窗口。
 * 如果「已下單」和「被拒絕」長得一樣（都只是原始訊號），
 * 你會以為每一筆訊號都進場了 —— 那是最危險的誤解。
 */
/**
 * 這筆拒絕是不是「可觀察」而非「有問題」。
 *
 * 【為什麼要分】
 * 一個把品質不足、止損過緊、系統停止、標的不在白名單全部畫成
 * 紅色「⛔ 未執行」的介面，會在一天幾十則之後訓練出一個反射：
 * 看到紅色就滑掉。那時候真正需要你看的那一則也會被滑掉。
 *
 * 所以把「訊號本身沒問題、只是不符合這個帳戶的下單條件」獨立成
 * 一種外觀。它們是行情資訊，不是故障。
 */
function isObservable_(result) {
  if (result.decision !== 'rejected') return false;
  if (result.band) return true;                 // 虧損區間外
  var why = String((result.reasons || []).join(' '));
  // 品質不足與週期不符都屬於「訊號在、條件不合」
  return why.indexOf('min_grade') !== -1
    || why.indexOf('等級') !== -1
    || why.indexOf('timeframe') !== -1;
}

function cardHead_(result) {
  var d = result.decision;
  if (d === 'placed') {
    return result.dryRun ? '🧪 已下單（DRY_RUN，未真的送出）' : '✅ 已自動下單';
  }
  if (d === 'rejected') {
    return isObservable_(result) ? '👀 可觀察' : '⛔ 未執行';
  }
  if (d === 'skipped') return '⏭ 已略過';
  // 「結果未知」與「未執行」必須看起來完全不同 ——
  // 前者要你去交易所確認，後者不必做任何事。
  if (d === 'error') return '⚠️ 結果未知，請到交易所確認';
  // 超額待確認：與一般待確認分開，一眼看得出「按下去會超過平常的上限」
  if (d === 'pending' && result.addOn) {
    return '➕ 加倉機會' + (result.dryRun ? '（DRY_RUN）' : '');
  }
  if (d === 'pending' && result.overLimit) {
    return '🟡 已達持倉上限' + (result.dryRun ? '（DRY_RUN）' : '');
  }
  return result.dryRun ? '🧪 待確認（DRY_RUN，不會真的下單）' : '⏳ 待確認';
}

function renderPendingCard_(payload, result, originalText, forBroadcast) {
  var sz = forBroadcast ? {} : (result.sizing || {});
  var dirText = payload.side === 'long' ? '做多⬆' : '做空⬇';
  var qtyUnit = sz.unit === 'contracts' ? '張' : '幣';
  var u = payload.quote ? ' ' + payload.quote : '';

  // 卡片取代了原始訊號那一則，所以上半段刻意與原始訊號逐行對齊：
  // 欄位名稱、順序、單位全部相同。這不是排版偏好 —— 兩者長得一樣，
  // 才有辦法一眼看出「執行層收到的，就是指標送出的那一筆」。
  var when = originalText ? extractField_(originalText, '時間') : null;

  // 品質：標籤在前，分數與降級原因收進同一組括號。
  // 分數解釋「為什麼是這個等級」，降級解釋「為什麼分數與等級不一致」，
  // 兩者服務同一個問題，放在同一行才不用來回看。
  var quality = payload.grade_text || (payload.grade + '★');
  var note = [];
  if (payload.score !== null && payload.score !== undefined) {
    note.push(String(payload.score));
  }
  if (payload.demote) note.push('降級：' + payload.demote);
  if (note.length) quality += '（' + note.join('｜') + '）';

  // 方向留在標題行而非獨立一行：卡片被改寫成結果時，標題行的「｜之後」
  // 會被保留下來（見 editCardResult_），方向因此不會在確認後消失。
  var lines = [
    (forBroadcast ? '📡 維加斯訊號' : cardHead_(result)) + '｜' + dirText,
    '─────────────'
  ];
  if (when) lines.push('[時間] ' + when);
  lines.push('[幣種] ' + payload.symbol);
  lines.push('[週期] ' + (payload.tf_text || payload.tf + ' 分鐘'));
  lines.push('[品質] ' + quality);
  lines.push('[價格] ' + payload.entry + u);
  lines.push('[止損] ' + payload.sl + u);
  for (var i = 0; i < payload.tp.length; i++) {
    lines.push('[止盈' + (i + 1) + '] ' + payload.tp[i] + u);
  }

  // 下半段的順序刻意與計算順序相反。
  //
  // 計算順序是：先算數量 → 再回推風險 → 再算名目。
  // 但按下按鈕時只有幾十秒，腦中的順序是：
  //   我最多賠多少（風險）→ 倉位合不合理（名目）→ 送出去的是什麼（數量）。
  // 版面服從閱讀順序，不服從計算順序。
  //
  // 分隔線把「指標給的」與「執行層算的」切開：上半段換一個帳戶看也一樣，
  // 下半段完全取決於這個帳戶的權益與風險設定。
  if (sz.orderQty !== undefined) {
    lines.push('─────────────');
    // 自動模式下 lossMax 是「天花板」而不是「打算賠的錢」，
    // 標成「預算」會讓人把上限讀成計畫。
    lines.push('[風險] ' + Number(sz.actualRiskUsdt).toFixed(2) + ' USDT' +
      '（' + (sz.riskBudgetIsCap ? '上限 ' : '預算 ')
      + Number(sz.riskAmountUsdt).toFixed(2) + '）');
    // 自動槓桿動過的話要說出來，還要說是為什麼。
    // 沉默地把 40x 換成 10x，使用者會以為設定沒生效而跑去改環境變數。
    var levText = sz.leverage ? '｜槓桿 ' + sz.leverage + 'x' : '';
    var changed = (sz.baseLeverage && sz.leverage && sz.leverage !== sz.baseLeverage)
      || (sz.baseMarginUsdt && sz.targetMarginUsdt
          && Number(sz.targetMarginUsdt).toFixed(0) !== Number(sz.baseMarginUsdt).toFixed(0));
    if (changed) {
      levText += '（自動，原 ' + sz.baseLeverage + 'x'
        + (sz.leverageNote ? '：' + sz.leverageNote : '') + '）';
    }
    lines.push('[名目] ' + Number(sz.notionalUsdt).toFixed(2) + ' USDT' + levText);
    // 保證金被自動調高時要單獨列出來 —— 那是實際鎖住的本金，
    // 直接影響「還能再開幾筆」，不該藏在名目後面的括號裡。
    if (sz.targetMarginUsdt && sz.baseMarginUsdt
        && Number(sz.targetMarginUsdt) > Number(sz.baseMarginUsdt)) {
      lines.push('[保證金] ' + Number(sz.targetMarginUsdt).toFixed(0) + ' USDT'
        + '（預設 ' + Number(sz.baseMarginUsdt).toFixed(0) + '）');
    }
    lines.push('[數量] ' + sz.orderQty + ' ' + qtyUnit);
  }

  // 權益來源。只有在「本來想查卻查不到」時才出現 ——
  // 上面的數量與風險全都是從權益推出來的，那個數字是查來的
  // 還是設定檔裡放著的，看的人有權知道。
  //
  // v3.4：只限私訊。這一行描述的是「這個帳戶的權益」，
  // 內容可能直接寫出設定值多少 USDT —— 原本沒有擋廣播版，
  // 等於在群組裡公布帳戶規模。
  if (!forBroadcast && result.equity && result.equity.note) {
    lines.push('⚠️ ' + result.equity.note);
  }

  // 加倉待確認：原部位的方向、浮盈與這是第幾次加倉。只放私訊。
  if (!forBroadcast && result.decision === 'pending' && result.addOn) {
    var ao = result.addOn;
    var upl = (ao.upl === null || ao.upl === undefined) ? null : Number(ao.upl);
    lines.push('─────────────');
    lines.push('[加倉] 已持有' + (ao.baseSide === 'short' ? '做空' : '做多') + '部位'
      + (ao.baseEntry ? '（進場 ' + ao.baseEntry + '）' : '')
      + (upl !== null ? '，未實現 ' + (upl >= 0 ? '+' : '') + upl.toFixed(2) + ' USDT' : ''));
    lines.push('[次數] 第 ' + ao.layerNo + ' 次加倉（上限 ' + ao.max + '）'
      + (ao.lever ? '｜沿用原部位槓桿 ' + ao.lever + 'x' : ''));
    lines.push('這筆有自己的止損止盈，只作用在加倉的數量上。');
  }

  // 超額待確認：把「按下去會變成第幾筆、最多到幾筆」講清楚。
  // 這是帳戶專屬資訊，只放私訊。
  if (!forBroadcast && result.decision === 'pending' && result.overLimit) {
    var ol = result.overLimit;
    lines.push('─────────────');
    lines.push('[持倉] 目前 ' + ol.openCount + ' 筆／上限 ' + ol.maxNow
      + '，超額進場將開第 ' + (ol.openCount + 1) + ' 筆（硬上限 ' + ol.hardCap + '）');
  }

  // 被拒絕時，「為什麼」比任何數字都重要。沒有它，這張卡片只是
  // 一則看不出所以然的訊息。
  if (!forBroadcast && result.decision === 'rejected'
      && result.reasons && result.reasons.length) {
    lines.push('─────────────');
    lines.push('[原因] ' + result.reasons.join('；'));

    // 虧損落在區間外時，多兩行讓人判斷「這個拒絕對不對」。
    //
    // 【為什麼只有兩行】
    // 名目與槓桿是固定設定，你本來就知道；把它們印出來只是佔位置。
    // 真正需要當場看的是兩件事：費用吃掉多少（已併進 [原因]），
    // 以及這筆就算照劇本走值不值得（[效益]）。
    //
    // 刻意不寫「建議你怎麼做」的說明文字 —— 數字自己會說話，
    // 而每天幾十則裡的說教只會讓人開始略過整張卡片。
    var pv = result.preview;
    if (pv) {
      if (pv.rr !== undefined && pv.rr !== null) {
        var eff = '[效益] TP1 損益比 ' + Number(pv.rr).toFixed(2) + ':1';
        if (pv.breakeven !== null && pv.breakeven !== undefined) {
          eff += '，打平勝率 ' + (Number(pv.breakeven) * 100).toFixed(1) + '%';
        } else {
          eff += '（扣費後為負，照劇本走也不賺）';
        }
        lines.push(eff);
      }
      // 只有「止損過寬」才給建議 —— 降槓桿讓名目變小是真的有效。
      // 過緊時升槓桿不會改善手續費佔比，所以那個方向不給。
      if (pv.suggestLeverage) {
        lines.push('[建議] 槓桿降到 ' + pv.suggestLeverage + 'x 可回到上限內');
      }
    }
  }

  // 廣播版到此為止：上面全是指標算出來的，換一個帳戶看也一樣；
  // 剛剛跳過的下半段（風險、名目、數量、權益、拒絕原因）
  // 才是這個帳戶專屬的，一個字都不該離開私訊。
  if (forBroadcast) {
    lines.push('─────────────');
    lines.push('⚠️ 僅供參考，非投資建議');
  }
  return lines.join('\n');
}

// ================================================================
// 訊號群組（廣播）
// ================================================================

/**
 * 群組 chat id。沒設、或與私訊是同一個聊天室，就回空字串，
 * 整個廣播功能靜默關閉。
 *
 * 與私訊相同時為什麼要關：那不是廣播，是在私訊裡把同一筆訊號
 * 再發一次。Code.gs 對同一情況也採相同判斷，兩邊才不會一邊補一邊重複。
 */
function getBroadcastChatId_() {
  var props = PropertiesService.getScriptProperties();
  var id = String(props.getProperty(BROADCAST_CHAT_PROPERTY) || '').trim();
  var own = String(props.getProperty('ALLOWED_CHAT_ID') || '').trim();
  if (id && own && id === own) return '';
  return id;
}

/**
 * 群組裡的話題 ID。只有開啟話題的超級群組需要；
 * 沒設或格式不對就回空字串，訊息送到群組預設位置（General）。
 */
function getBroadcastThreadId_() {
  var v = String(
    PropertiesService.getScriptProperties().getProperty(BROADCAST_THREAD_PROPERTY) || ''
  ).trim();
  return /^\d+$/.test(v) ? v : '';
}

/**
 * 有權按按鈕的 Telegram 使用者 id（逗號分隔）。
 *
 * 【為什麼授權要從「聊天室」改成「人」】
 * 原本的檢查是「這則 callback 來自不來自我的聊天室」。在私訊裡
 * 兩者等價 —— 那個聊天室只有我。一旦有了群組就不等價了：
 * 群組是一個聊天室，裡面有很多人，而 inline 按鈕任何成員都按得到。
 * 屆時「聊天室對」不再代表「按的人對」。
 *
 * 所以改成認人。沒設定時退回 ALLOWED_CHAT_ID —— 私訊的 chat id
 * 就等於你的 user id，所以現有設定不必改動也是安全的。
 */
function getOperatorIds_() {
  var props = PropertiesService.getScriptProperties();
  var raw = String(props.getProperty(OPERATOR_IDS_PROPERTY) || '').trim();
  if (!raw) raw = String(props.getProperty('ALLOWED_CHAT_ID') || '').trim();
  var out = [];
  var parts = raw.split(',');
  for (var i = 0; i < parts.length; i++) {
    var v = parts[i].trim();
    if (v) out.push(v);
  }
  return out;
}

/** 這個人可不可以按按鈕。 */
function isOperator_(userId) {
  if (userId === null || userId === undefined) return false;
  var ids = getOperatorIds_();
  var me = String(userId);
  for (var i = 0; i < ids.length; i++) {
    if (safeEquals_(ids[i], me)) return true;
  }
  return false;
}

/**
 * 把訊號廣播到群組（指定話題時只進該話題）。
 *
 * fileId 是關鍵：Telegram 的 sendPhoto 回傳裡帶著剛上傳那張圖的
 * file_id，拿它再發一次就不用重新上傳，也不用再跟 CHART-IMG 要一次圖。
 * 少掉的是一次 44KB 上傳加一次 API 額度 —— BASIC 方案一天只有 50 張，
 * 一張圖發兩次就等於額度砍半。
 *
 * 永不拋例外：群組發不出去，私訊那則與下單流程都不該受影響。
 * 回傳 Telegram 的訊息物件，失敗回 null —— Code.gs 據此決定要不要
 * 改送原始訊號到群組。
 */
function broadcastSignal_(payload, result, originalText, fileId) {
  var chatId = getBroadcastChatId_();
  if (!chatId) return null;
  var threadId = getBroadcastThreadId_();
  try {
    var text = renderPendingCard_(payload, result, originalText, true);
    var base = { chat_id: chatId };
    if (threadId) base.message_thread_id = Number(threadId);

    var sent = null;
    if (fileId) {
      sent = tgApi_('sendPhoto', Object.assign({ photo: fileId, caption: text }, base));
    }
    // 沒有 file_id（取圖失敗）或送圖失敗，就退成純文字。
    // 群組看不到圖可以接受，看不到訊號不行。
    if (!sent) sent = tgApi_('sendMessage', Object.assign({ text: text }, base));
    logEvent_(sent ? 'info' : 'warn',
      sent ? 'broadcast_sent' : 'broadcast_failed',
      { source: 'executor', sigId: String(payload.sig_id).slice(-12),
        threadId: threadId || null,
        withPhoto: Boolean(fileId && sent) });
    return sent;
  } catch (error) {
    logEvent_('warn', 'broadcast_failed', {
      source: 'executor',
      message: redactLogText_(error && error.message ? error.message : String(error))
    });
    return null;
  }
}


// ================================================================
// 五、K 線圖（CHART-IMG）
// ================================================================
//
// 【一個必須先知道的限制】
// CHART-IMG 的一般端點只能畫 TradingView 的「內建」指標，
// 畫不出你自己的 Pine 腳本 —— 維加斯通道、進場水位那些都不會出現。
// （它的 Shared Layout 端點可以，但要把 TradingView 的 session 憑證
//   交給第三方服務，等於讓對方能以你的身分操作 TradingView。不建議。）
//
// 所以這裡的做法是：畫乾淨的 K 線，再用「水平線」把這筆交易的幾何畫上去。
// 免費方案每次請求最多 3 個 studies + drawings 物件，正好放
// ENTRY / SL / TP1 —— 那也是這張圖真正要回答的三件事：
// 我在哪進、錯了在哪出、對了在哪出。TP2/TP3 卡片文字裡有。

var CHART_KEY_PROPERTY = 'CHART_IMG_API_KEY';
var CHART_EXCHANGE_PROPERTY = 'CHART_TV_EXCHANGE';
var CHART_UP_PROPERTY = 'CHART_CANDLE_UP';
var CHART_DOWN_PROPERTY = 'CHART_CANDLE_DOWN';
var CHART_ENDPOINT = 'https://api.chart-img.com/v2/tradingview/advanced-chart';

// TradingView 的預設漲跌色。改成你圖表上的顏色即可 ——
// 兩邊一致，從 Telegram 看圖和從 TradingView 看圖才不會需要重新適應。
var CHART_UP_DEFAULT = 'rgb(8,153,129)';
var CHART_DOWN_DEFAULT = 'rgb(242,54,69)';

/** 時區預設值。只在訊號沒帶 [時區] 時使用。 */
var CHART_TZ_DEFAULT = 'Asia/Taipei';

// ── 維加斯通道的七條 EMA ──────────────────────────────────
// 長度直接對應指標裡的 len1-len5 / lenT1-lenT2。
// 這七條是 TradingView 內建的均線，不是你的 Pine 邏輯 ——
// 所以 CHART-IMG 畫得出來，但畫出來的是「構成通道的線」，
// 不是通道的填色與箭頭。視覺上的結構是一樣的。
//
// 顏色分組的用意：同一條通道的兩條線同色，一眼看得出誰跟誰成對。
// 顏色取自 v11.9 指標的「顏色設定」群組，數值逐一對應：
//   小通道 144/169   #2B4C7E 深靛藍
//   大通道 576/676   #7D2E3A 深酒紅
//   過濾通道 250/288 #4F6349 深墨軍綠
//   過濾線 12        #C08A2E 暗金
//
// 【這組顏色是為淺色背景挑的】
// 深靛藍、深酒紅、深墨軍綠在深色底上明度差不足，線會糊進背景。
// 所以搭配 CHART_THEME=light 使用 —— 那也才是你 TradingView 上的樣子。
// 想留深色主題的話，用 CHART_EMA_COLORS 覆寫成亮一階的版本。
//
// 通道之間的填色（指標裡的透明度 82）CHART-IMG 畫不出來 ——
// 它只能畫內建指標的線，沒有「兩條線之間填色」這種物件。
// 圖上看到的會是兩條平行線而不是一條帶。
var CHART_EMA_SET = [
  { len: 144, color: 'rgb(43,76,126)',   width: 1, label: '小通道' },
  { len: 169, color: 'rgb(43,76,126)',   width: 1, label: '小通道' },
  { len: 576, color: 'rgb(125,46,58)',   width: 1, label: '大通道' },
  { len: 676, color: 'rgb(125,46,58)',   width: 1, label: '大通道' },
  { len: 250, color: 'rgb(79,99,73)',    width: 1, label: '過濾通道' },
  { len: 288, color: 'rgb(79,99,73)',    width: 1, label: '過濾通道' },
  { len: 12,  color: 'rgb(192,138,46)',  width: 1, label: '過濾線' }
];

// v11.9 的訊號配色，用在水平線上：
//   做多（標準）#1F7A5E  做空（標準）#A32E3E
// 進場線用中性灰，因為它不代表對或錯，只代表「從這裡開始」。
var LEVEL_COLOR_ENTRY = 'rgb(120,120,130)';
var LEVEL_COLOR_SL = 'rgb(163,46,62)';
var LEVEL_COLOR_TP = 'rgb(31,122,94)';

// 水平線的挑選。逗號分隔，可用 entry,sl,tp1,tp2,tp3，或 none／all。
//
// 【額度算術】studies 與 drawings 共用 Max Parameter：
//   七條均線 + 三條線（entry,sl,tp1）= 10  ← MEGA 剛好裝滿
//   七條均線 + 五條線（含 tp2,tp3）  = 12  ← 裝不下，會砍掉兩條均線
// 想要 TP2／TP3 全上，就得放棄過濾通道那一組。這個取捨沒有正確答案，
// 所以做成設定而不是替你決定。
var CHART_LEVELS_SET_PROPERTY = 'CHART_LEVEL_SET';
var CHART_LEVELS_SET_DEFAULT = 'entry,sl,tp1';

// 圖表主題。預設深色 —— 圖卡是在 Telegram 深色介面裡看的，
// 淺色圖夾在深色對話串中間會刺眼。
//
// 代價是 v11.9 那組顏色（為白底挑的）在深底上明度不足，
// 所以搭配 CHART_EMA_COLORS 用亮一階的版本。說明見 .env 旁的註解。
var CHART_THEME_PROPERTY = 'CHART_THEME';
var CHART_THEME_DEFAULT = 'dark';

// 均線顏色覆寫。格式 "144:#2B4C7E,576:#7D2E3A"，只改列出的那幾條。
var CHART_EMA_COLORS_PROPERTY = 'CHART_EMA_COLORS';

// 水平線的「線」顏色覆寫。格式 "entry:#FFFFFF,sl:#A32E3E,tp:#1F7A5E"
// （tp 一次套用到 tp1／tp2／tp3，要個別指定就寫 tp1:...）
var CHART_LEVEL_COLORS_PROPERTY = 'CHART_LEVEL_COLORS';

// 水平線的「文字」顏色覆寫。格式同上。
var CHART_LEVEL_TEXT_PROPERTY = 'CHART_LEVEL_TEXT_COLORS';

// 文字顏色在 CHART-IMG 請求裡的欄位名稱。
//
// 【為什麼這是一個設定，而不是寫死的字串】
// 與 CHART_EMA_STUDY_NAME 同一個理由：這個名稱是用探測試出來的，
// 不是從文件抄的。文件與 API 打架時以 API 為準，而 API 可能改。
// 做成屬性的話，下次名稱變了你自己改一個格子就好，不必等我出新版。
//
// 預設 textColor 是目前最可能的候選，但「沒驗證過」——
// 跑 probeLevelTextColor() 會告訴你哪一個真的有效。
var CHART_LEVEL_TEXT_FIELD_PROPERTY = 'CHART_LEVEL_TEXT_FIELD';
var CHART_LEVEL_TEXT_FIELD_DEFAULT = 'textColor';

// 指標名稱以 API 實測為準，不以文件為準（文件寫的那個會回 422）。
// 做成可從指令碼屬性覆寫：CHART-IMG 哪天改名，改屬性即可，不必動程式。
var CHART_EMA_NAME_PROPERTY = 'CHART_EMA_STUDY_NAME';
var CHART_EMA_NAME_DEFAULT = 'Moving Average Exponential';

/** 取目前要用的 EMA 指標名稱。 */
function emaStudyName_(props) {
  try {
    var p = props || PropertiesService.getScriptProperties();
    var v = String(p.getProperty(CHART_EMA_NAME_PROPERTY) || '').trim();
    return v || CHART_EMA_NAME_DEFAULT;
  } catch (e) {
    return CHART_EMA_NAME_DEFAULT;   // 不連環境時（單元測試）也能組
  }
}

// 均線的採用順序。第一條會排在 TP1 之前（見 buildChartRequest_ 的排序理由），
// 其餘依序往後。改順序 = 改屬性 CHART_EMA_ORDER，例如 "144,169,576"。
var CHART_EMA_ORDER_DEFAULT = [144, 169, 576, 676, 250, 288, 12];
var CHART_EMA_ORDER_PROPERTY = 'CHART_EMA_ORDER';

// 方案的 Max Parameter：BASIC 3、PRO 5、MEGA 10。
// 升級方案後把屬性 CHART_MAX_PARAMS 改成新數字，圖上的內容自動變多。
var CHART_MAX_PARAMS_PROPERTY = 'CHART_MAX_PARAMS';
var CHART_MAX_PARAMS_DEFAULT = 3;

// 要不要在圖上畫 ENTRY／SL／TP1 的水平線。
// 關掉 = 額度全給均線，圖上只有價格結構；價位數字仍在卡片文字裡。
// 開啟 = 圖上看得到這筆交易的幾何，但會排擠掉均線。
var CHART_LEVELS_PROPERTY = 'CHART_SHOW_LEVELS';
var CHART_LEVELS_DEFAULT = false;

// 左上角圖例的開關。名稱由 probeLegendOptions() 實測決定。
//
// 預設關掉 OHLC 與漲跌幅（第二輪的 A3）：這兩項在卡片文字裡沒有，
// 但圖上一眼看得出來，留著只是讓左上角變擁擠。代碼與週期則留著。
//
// 註：免費方案的 CHART-IMG.COM 浮水印不是這裡能關的，那是方案差異。
// 升上 PRO（$7）之後浮水印消失，那時把這個屬性設成 showLegend，
// 左上角就會完全淨空。
var CHART_HIDE_LEGEND_PROPERTY = 'CHART_HIDE_LEGEND_KEYS';
var CHART_HIDE_LEGEND_DEFAULT = 'showSeriesOHLC,showBarChange';

// 背景浮水印（TradingView 原本就有，預設關著）。
// 填 0-100 的透明度即可開啟，例如 85。空白 = 不開。
// 用途：圖例全關之後，代碼還能用浮水印留在背景，不跟價格軸搶注意力。
var CHART_WATERMARK_PROPERTY = 'CHART_WATERMARK';

// ---- 圖片尺寸 ----
//
// 800×600 是 BASIC 方案的上限，所以也是這裡的預設值 ——
// 預設值要在最低方案上能動，升級的人自己去設屬性。
// 反過來預設 1920 的話，沒升級的人會拿到 422 而不是一張小圖，
// 而「整張圖消失」比「圖比較小」難查得多。
var CHART_WIDTH_PROPERTY = 'CHART_WIDTH';
var CHART_HEIGHT_PROPERTY = 'CHART_HEIGHT';
var CHART_WIDTH_DEFAULT = 800;
var CHART_HEIGHT_DEFAULT = 600;
var CHART_WIDTH_MAX = 1920;
var CHART_HEIGHT_MAX = 1600;

/** 組一個內建 EMA 的 study 物件。 */
function emaStudy_(spec) {
  return {
    name: emaStudyName_(),
    // 欄位名是 length / source。曾經用過 in_0 / in_1 —— API 回 200，
    // 但「安靜地」忽略未知欄位、改用預設長度 9 畫。有圖、沒錯誤、線是錯的。
    // 所以任何時候改這裡，都要用 probeEmaInputShape() 驗一次。
    //
    // source 必須是 close，跟指標裡的 ta.ema(close, ...) 一致 ——
    // 否則圖上的線跟訊號判斷依據的線不是同一條，那比沒有線更糟。
    input: { length: spec.len, source: 'close' },
    override: {
      'Plot.plottype': 'line',
      'Plot.linewidth': spec.width || 1,
      'Plot.color': spec.color
    }
  };
}

/** 從指令碼屬性讀出圖表設定。沒設的項目一律用預設值。 */
/**
 * 把使用者填的顏色轉成 CHART-IMG 認得的格式。
 *
 * 【為什麼需要這一層】
 * CHART-IMG 只接受 rgb()／rgba()，填 hex 會回 422 整張圖不見：
 *   {"value":"#FFFFFF","msg":"must be a valid rgb/rgba color"}
 *
 * 但你手上的顏色全是 hex —— Pine 指標裡是 hex、TradingView 調色盤給的是 hex、
 * 截圖上看到的也是 hex。要求使用者自己換算成 rgb()，等於把一個
 * 程式兩行就能做的事推給人做，而且每次都有算錯的機會。
 *
 * 所以屬性收 hex，這裡轉。rgb() 原樣放行，兩種都能填。
 *
 * 認不出來的回 null，呼叫端會保留原本的顏色並印出警告 ——
 * 一個打錯的色碼只該讓那一條線維持原色，不該讓整張圖消失。
 */
function toRgbColor_(raw) {
  var v = String(raw || '').trim();
  if (!v) return null;
  if (/^rgba?\s*\(/i.test(v)) return v;          // 已經是 rgb()／rgba()

  var m = v.replace(/^#/, '');
  if (m.length === 3) {                            // #abc → #aabbcc
    m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
  }
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(m)) return null;

  var r = parseInt(m.slice(0, 2), 16);
  var g = parseInt(m.slice(2, 4), 16);
  var b = parseInt(m.slice(4, 6), 16);
  if (m.length === 8) {                            // 帶透明度
    var a = parseInt(m.slice(6, 8), 16) / 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (Math.round(a * 100) / 100) + ')';
  }
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

/**
 * 切開 "a:#111,b:rgb(1,2,3)" 這種字串。
 *
 * 不能直接 split(',') —— rgb(1,2,3) 裡面就有逗號，切下去會碎成三段。
 * 所以只在括號外面切。
 */
function splitColorPairs_(raw) {
  var out = [];
  var depth = 0;
  var cur = '';
  var str = String(raw || '');
  for (var i = 0; i < str.length; i++) {
    var ch = str[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function chartOptions_(props) {
  var p = props || PropertiesService.getScriptProperties();
  var pick = function (name, dflt) {
    var v = String(p.getProperty(name) || '').trim();
    return v || dflt;
  };
  // 額度寫錯（填 0、填文字）會讓圖整張消失，所以夾在 1-10 之間。
  // 寧可少畫幾條，也不要因為一個打錯的設定就沒有圖。
  var budget = parseInt(pick(CHART_MAX_PARAMS_PROPERTY, ''), 10);
  if (!isFinite(budget) || budget < 1) budget = CHART_MAX_PARAMS_DEFAULT;
  if (budget > 10) budget = 10;

  var orderRaw = pick(CHART_EMA_ORDER_PROPERTY, '');
  var order = orderRaw
    ? orderRaw.split(',').map(function (s) { return parseInt(s.trim(), 10); })
        .filter(function (n) { return isFinite(n) && n > 0; })
    : CHART_EMA_ORDER_DEFAULT;
  if (!order.length) order = CHART_EMA_ORDER_DEFAULT;

  // 只認 true/1/on 為開啟。填錯字一律當關閉 ——
  // 「以為開了其實沒開」比「以為關了其實沒關」容易察覺（看圖就知道）。
  var levelsRaw = pick(CHART_LEVELS_PROPERTY, '').toLowerCase();
  var showLevels = levelsRaw
    ? (levelsRaw === 'true' || levelsRaw === '1' || levelsRaw === 'on')
    : CHART_LEVELS_DEFAULT;

  // 逗號分隔的開關名稱，全部設成 false。例如 "showStudyLastValue,showLegendValues"
  // 填 none 可以完全不動圖例（回到 TradingView 原樣）
  var hideRaw = pick(CHART_HIDE_LEGEND_PROPERTY, CHART_HIDE_LEGEND_DEFAULT);
  var hideKeys = (hideRaw && hideRaw.toLowerCase() !== 'none')
    ? hideRaw.split(',').map(function (s) { return s.trim(); })
        .filter(function (s) { return s; })
    : [];

  // 透明度必須是 0-100。填錯就當沒開 —— 送出範圍外的值，
  // CHART-IMG 可能整張回錯，而圖卡少一張圖比少一個浮水印嚴重。
  var wm = parseInt(pick(CHART_WATERMARK_PROPERTY, ''), 10);
  var watermark = (isFinite(wm) && wm >= 0 && wm <= 100) ? wm : null;

  // 尺寸同樣夾在範圍內。填 3000 會被 CHART-IMG 退件，
  // 而退件的後果是整張圖不見 —— 一樣採「寧可小一點」的原則。
  var w = parseInt(pick(CHART_WIDTH_PROPERTY, ''), 10);
  if (!isFinite(w) || w < 320) w = CHART_WIDTH_DEFAULT;
  if (w > CHART_WIDTH_MAX) w = CHART_WIDTH_MAX;
  var h = parseInt(pick(CHART_HEIGHT_PROPERTY, ''), 10);
  if (!isFinite(h) || h < 240) h = CHART_HEIGHT_DEFAULT;
  if (h > CHART_HEIGHT_MAX) h = CHART_HEIGHT_MAX;

  // 主題只認 light／dark，填別的一律當 light ——
  // v11.9 的配色是淺色底的，猜錯方向會讓線糊進背景。
  var themeRaw = pick(CHART_THEME_PROPERTY, CHART_THEME_DEFAULT).toLowerCase();
  var theme = themeRaw === 'dark' ? 'dark' : 'light';

  // 水平線挑選。showLevels 仍然是總開關：關掉就一條都不畫。
  var setRaw = pick(CHART_LEVELS_SET_PROPERTY, CHART_LEVELS_SET_DEFAULT).toLowerCase();
  var levelSet;
  if (!showLevels || setRaw === 'none') levelSet = [];
  else if (setRaw === 'all') levelSet = ['entry', 'sl', 'tp1', 'tp2', 'tp3'];
  else {
    levelSet = setRaw.split(',').map(function (x) { return x.trim(); })
      .filter(function (x) {
        return ['entry', 'sl', 'tp1', 'tp2', 'tp3'].indexOf(x) !== -1;
      });
  }

  // 均線顏色覆寫 "144:#2B4C7E,576:#7D2E3A"
  var emaColors = {};
  var colRaw = pick(CHART_EMA_COLORS_PROPERTY, '');
  if (colRaw) {
    splitColorPairs_(colRaw).forEach(function (pair) {
      var at = pair.indexOf(':');
      if (at < 0) return;
      var len = parseInt(pair.slice(0, at).trim(), 10);
      var col = toRgbColor_(pair.slice(at + 1));
      if (!isFinite(len)) return;
      if (!col) {
        console.warn('CHART_EMA_COLORS 認不得的色碼，該條維持原色：'
          + truncate_(pair, 40));
        return;
      }
      emaColors[len] = col;
    });
  }

  // 水平線的顏色覆寫。key 可以是 entry／sl／tp（套三條）／tp1／tp2／tp3。
  var parseLevelColors = function (raw, who) {
    var out = {};
    if (!raw) return out;
    splitColorPairs_(raw).forEach(function (pair) {
      var at = pair.indexOf(':');
      if (at < 0) return;
      var k = pair.slice(0, at).trim().toLowerCase();
      var v = toRgbColor_(pair.slice(at + 1));
      if (!k) return;
      if (!v) {
        console.warn(who + ' 認不得的色碼，該條維持原色：' + truncate_(pair, 40));
        return;
      }
      if (k === 'tp') { out.tp1 = v; out.tp2 = v; out.tp3 = v; }
      else out[k] = v;
    });
    return out;
  };

  return {
    levelColors: parseLevelColors(pick(CHART_LEVEL_COLORS_PROPERTY, ''),
      CHART_LEVEL_COLORS_PROPERTY),
    levelTextColors: parseLevelColors(pick(CHART_LEVEL_TEXT_PROPERTY, ''),
      CHART_LEVEL_TEXT_PROPERTY),
    levelTextField: pick(CHART_LEVEL_TEXT_FIELD_PROPERTY, CHART_LEVEL_TEXT_FIELD_DEFAULT),
    exchange: pick(CHART_EXCHANGE_PROPERTY, 'OKX'),
    upColor: pick(CHART_UP_PROPERTY, CHART_UP_DEFAULT),
    downColor: pick(CHART_DOWN_PROPERTY, CHART_DOWN_DEFAULT),
    theme: theme,
    levelSet: levelSet,
    emaColors: emaColors,
    width: w,
    height: h,
    maxParams: budget,
    emaOrder: order,
    noDrawings: !showLevels,
    hideLegendKeys: hideKeys,
    watermark: watermark
  };
}

/** 週期（分鐘字串）→ CHART-IMG 的 interval 寫法。 */
function chartInterval_(tfMinutes) {
  var m = Number(tfMinutes);
  if (!isFinite(m) || m <= 0) return '1h';
  if (m < 60) return m + 'm';
  if (m < 1440) return (m / 60) + 'h';
  return (m / 1440) + 'D';
}

/**
 * 組出 CHART-IMG 的請求內容。抽成獨立函式是為了能在不連網的情況下
 * 檢查它 —— 這張圖錯了不會有任何錯誤訊息，只會默默畫錯。
 */
function buildChartRequest_(payload, opts) {
  var o = opts || {};
  var exchange = o.exchange || 'OKX';
  var isLong = payload.side === 'long';

  // ── 額度分配 ────────────────────────────────────────────
  // studies 與 drawings 共用同一份 Max Parameter（BASIC 3、PRO 5、MEGA 10）。
  // 超過的話 CHART-IMG 直接回錯、整張圖沒了，不會替你挑掉幾個。
  //
  // 所以這裡把所有候選項目排成一條優先序，額度多少就取前幾個。
  // 用優先序而不是一堆開關，是因為升級方案時不必重新決定要開哪些 ——
  // 額度變大，名單自動往下長。
  //
  // 排序理由：
  //   ENTRY   沒有它這張圖沒有主詞
  //   SL      「錯了在哪出」比「對了在哪出」重要
  //   EMA144  給價格一個結構參照
  //   TP1     卡片文字裡已經有數字，圖上是加分不是必要
  //   EMA169  把小通道補成完整的帶
  //   其餘    大通道與過濾線，MEGA 才放得下
  var line = function (price, label, color, key) {
    var ov = { lineWidth: 2, lineColor: color, showLabel: true };
    // 線顏色的覆寫
    if (o.levelColors && o.levelColors[key]) ov.lineColor = o.levelColors[key];
    // 文字顏色的覆寫。欄位名稱本身也是設定 —— 見 CHART_LEVEL_TEXT_FIELD。
    if (o.levelTextColors && o.levelTextColors[key]) {
      ov[o.levelTextField || CHART_LEVEL_TEXT_FIELD_DEFAULT] = o.levelTextColors[key];
    }
    return {
      name: 'Horizontal Line',
      // 標記沿用指標圖上的寫法：目標用 ◆、止損用 ✕、進場用 ▸。
      // 一眼分辨靠的是形狀不是顏色 —— 圖縮到手機寬度時顏色先糊掉。
      input: { price: price, text: label + ' ' + price },
      // 顏色與交易語意對齊：進場中性、止損紅、目標綠。
      // 方向不影響顏色 —— 紅色永遠代表「錯了」，不代表「向下」。
      override: ov
    };
  };
  var ema = function (len) {
    for (var i = 0; i < CHART_EMA_SET.length; i++) {
      if (CHART_EMA_SET[i].len === len) {
        var spec = CHART_EMA_SET[i];
        // 屬性裡的覆寫優先。改一條顏色不必動程式碼。
        if (o.emaColors && o.emaColors[len]) {
          spec = { len: spec.len, width: spec.width, label: spec.label,
                   color: o.emaColors[len] };
        }
        return emaStudy_(spec);
      }
    }
    // 屬性裡填了七條以外的長度：照畫，用中性色。
    // 悄悄跳過會讓人以為設定沒生效，而去改別的地方。
    return emaStudy_({ len: len, color: (o.emaColors && o.emaColors[len])
      || 'rgb(160,160,160)', width: 1 });
  };

  // 水平線的候選。挑哪幾條由設定決定，這裡只負責「挑到的要畫得出來」。
  var levelDefs = {
    entry: { price: payload.entry, label: '▸ ENTRY', color: LEVEL_COLOR_ENTRY },
    sl: { price: payload.sl, label: '✕ SL', color: LEVEL_COLOR_SL },
    tp1: { price: (payload.tp || [])[0], label: '◆ TP1', color: LEVEL_COLOR_TP },
    tp2: { price: (payload.tp || [])[1], label: '◆ TP2', color: LEVEL_COLOR_TP },
    tp3: { price: (payload.tp || [])[2], label: '◆ TP3', color: LEVEL_COLOR_TP }
  };

  var queue = [];

  // 【順序：選到的水平線排在均線前面】
  // 使用者在設定裡列出 tp2、tp3，那是一個明確的要求；
  // 均線則是「額度有剩就多畫幾條」。明確的要求不該被預設值排擠掉 ——
  // 否則設定會變成「我填了但它沒畫，也沒告訴我為什麼」。
  var wanted = o.noDrawings ? [] : (o.levelSet || []);
  for (var w2 = 0; w2 < wanted.length; w2++) {
    var def = levelDefs[wanted[w2]];
    if (!def || def.price === undefined || def.price === null) continue;
    queue.push({ kind: 'd', item: line(def.price, def.label, def.color, wanted[w2]) });
  }

  var order = o.emaOrder || CHART_EMA_ORDER_DEFAULT;
  for (var k = 0; k < order.length; k++) {
    queue.push({ kind: 's', item: ema(order[k]) });
  }

  // noDrawings 模式（試畫）沒有水平線，額度全給均線
  if (o.noDrawings && o.emaSet) {
    queue = o.emaSet.map(function (s) { return { kind: 's', item: emaStudy_(s) }; });
  }

  var budget = o.maxParams || 3;
  var drawings = [];
  var studies = [];
  for (var q = 0; q < queue.length && drawings.length + studies.length < budget; q++) {
    if (!queue[q].item) continue;
    if (queue[q].kind === 'd') drawings.push(queue[q].item);
    else studies.push(queue[q].item);
  }

  var up = o.upColor || CHART_UP_DEFAULT;
  var down = o.downColor || CHART_DOWN_DEFAULT;

  var req = {
    // 代碼與週期都是從訊號本身推導的，不是設定檔寫死的 ——
    // 換標的、換週期時圖會自己跟上，不必記得去改另一個地方。
    symbol: exchange + ':' + payload.symbol,
    interval: chartInterval_(payload.tf),
    // 時區同理：用指標送來的 [時區]，圖上的時間軸才會與卡片的 [時間] 一致。
    timezone: o.timezone || payload.tz || CHART_TZ_DEFAULT,
    theme: o.theme || 'dark',
    style: 'candle',
    format: 'png',
    // 免費方案上限 800x600。方案升級後把這兩個值調大即可。
    width: o.width || 800,
    height: o.height || 600,
    // override 不計入方案的 Max Parameter 額度（那個只算 studies + drawings），
    // 所以配色可以隨意調，不會排擠到那三條線。
    override: {
      style: {
        'candleStyle.upColor': up,
        'candleStyle.downColor': down,
        'candleStyle.borderUpColor': up,
        'candleStyle.borderDownColor': down,
        'candleStyle.wickUpColor': up,
        'candleStyle.wickDownColor': down
      }
    },
    drawings: drawings
  };

  // 圖例開關：名稱由 probeLegendOptions() 實測後填進屬性。
  // 掛在 override 的第一層（與 style 同層），不佔 Max Parameter 額度。
  (o.hideLegendKeys || []).forEach(function (k) { req.override[k] = false; });

  // 浮水印：圖例關掉之後把代碼留在背景。掛在 style 底下，同樣不佔額度。
  if (o.watermark !== null && o.watermark !== undefined) {
    req.override.style['symbolWatermarkProperties.visibility'] = true;
    req.override.style['symbolWatermarkProperties.transparency'] = o.watermark;
  }

  // 沒有 EMA 時不送空陣列 —— 有些 API 會把空陣列當成「明確要求零個」
  // 以外的東西處理，少送一個欄位比較安全。
  if (studies.length) req.studies = studies;
  return req;
}

/**
 * 取得圖片。永不拋例外 —— 取不到就回 null，卡片改用純文字發出。
 * 附加功能不能讓核心功能消失，這跟權益查不到時的取捨是同一條原則。
 */
function fetchChartImage_(payload) {
  var props = PropertiesService.getScriptProperties();
  var key = String(props.getProperty(CHART_KEY_PROPERTY) || '').trim();
  if (!key) return null;          // 未設定即視為停用，不記錄

  var started = Date.now();
  try {
    var body = buildChartRequest_(payload, chartOptions_(props));
    var res = UrlFetchApp.fetch(CHART_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) {
      logEvent_('warn', 'chart_image_failed', {
        source: 'executor',
        status: res.getResponseCode(),
        message: truncate_(res.getContentText(), 150),
        elapsedMs: Date.now() - started
      });
      return null;
    }
    var blob = res.getBlob().setName(payload.symbol + '.png');
    logEvent_('info', 'chart_image_ok', {
      source: 'executor',
      bytes: blob.getBytes().length,
      elapsedMs: Date.now() - started
    });
    return blob;
  } catch (error) {
    logEvent_('warn', 'chart_image_error', {
      source: 'executor',
      message: truncate_(String(error && error.message ? error.message : error), 150),
      elapsedMs: Date.now() - started
    });
    return null;
  }
}

/**
 * 用 multipart 送出帶圖的訊息。
 * payload 裡放 Blob 時 Apps Script 會自動改用 multipart/form-data，
 * 但也因此 reply_markup 必須自己先轉成字串 —— 表單欄位不能是物件。
 */
function tgSendPhoto_(chatId, blob, caption, replyMarkup) {
  try {
    var cfg = getConfig_();
    var form = { chat_id: String(chatId), caption: caption, photo: blob };
    if (replyMarkup) form.reply_markup = JSON.stringify(replyMarkup);

    var res = UrlFetchApp.fetch(
      'https://api.telegram.org/bot' + cfg.tgToken + '/sendPhoto',
      { method: 'post', payload: form, muteHttpExceptions: true }
    );
    var data = JSON.parse(res.getContentText());
    if (!data.ok) {
      console.warn('Telegram sendPhoto 失敗：' +
        redactLogText_(truncate_(res.getContentText(), 200)));
      return null;
    }
    return data.result;
  } catch (error) {
    console.error('Telegram sendPhoto 例外：' +
      redactLogText_(error && error.message ? error.message : String(error)));
    return null;
  }
}

/** 圖片說明的長度上限。Telegram 的硬限制是 1024 字元。 */
var TG_CAPTION_LIMIT = 1024;

/**
 * 送出帶按鈕的待確認卡片，接著把廣播版送到群組。
 *
 * 按鈕本身不帶任何交易資料，只帶動作與 sig_id —— 實際的數量、
 * 止損止盈全都留在執行層。這樣即使有人拿到 callback_data，
 * 能做的也只是確認或略過一筆「執行層已經算好且通過風控」的訊號。
 *
 * 回傳 { sent, broadcastSent }：
 *   sent           私訊卡片的 Telegram 訊息物件，失敗為 null
 *   broadcastSent  群組廣播是否成功（未設定群組時為 false）
 */
function sendPendingCard_(payload, result, originalText) {
  var cfg = getConfig_();
  var text = renderPendingCard_(payload, result, originalText);

  // 按鈕只有「待確認」需要。已下單與已拒絕都是既成事實，
  // 掛上按鈕只會讓人以為還有得選。
  var markup = null;
  if (result.decision === 'pending') {
    markup = {
      inline_keyboard: [[
        // 超額單用不同的文字，避免把「超過上限」當成一般進場順手按下去。
        // callback_data 不變：是否允許超額由執行層依待確認紀錄判定，
        // 不是由按鈕告訴它 —— 按鈕內容可以被偽造，紀錄不行。
        { text: result.addOn
            ? '➕ 加倉進場（第 ' + result.addOn.layerNo + ' 次）'
            : result.overLimit
            ? '➕ 超額進場（第 ' + (result.overLimit.openCount + 1) + ' 筆）'
            : '✅ 進場',
          callback_data: CB_CONFIRM + payload.sig_id },
        { text: '⏭ 略過', callback_data: CB_SKIP + payload.sig_id }
      ]]
    };
  } else if (result.decision === 'rejected'
      && String((result.reasons || []).join(' ')).indexOf('daily_loss_limit') !== -1) {
    // 【按鈕要放在問題出現的地方】
    // 日損面板原本只能靠打「日損」叫出來，而重置鍵又只在被擋住時才顯示 ——
    // 兩個條件疊在一起的結果是：真正需要它的那一刻，你得先想起有這個指令。
    //
    // 被日損擋下的拒絕卡片，正是那一刻。把入口掛在這裡，
    // 不必記得任何指令；而重置本身仍然是兩段確認，友善的是找到它，
    // 不是按下它。
    markup = {
      inline_keyboard: [[
        { text: '📊 查看日損／重置', callback_data: CB_DAILY_PANEL }
      ]]
    };
  }

  // 有圖就發圖，沒有就發純文字。取圖失敗不能讓卡片消失 ——
  // 附加功能絕不可以拖垮核心功能。
  //
  // 另有一個硬限制：圖片說明上限 1024 字元。卡片目前約 300-400，
  // 但欄位只會越加越多，所以在這裡擋，而不是等 Telegram 退件
  // （退件的後果是整張卡片不見，那比沒有圖嚴重得多）。
  var blob = null;
  if (text.length <= TG_CAPTION_LIMIT) {
    blob = fetchChartImage_(payload);
  } else {
    logEvent_('warn', 'chart_skipped_caption_too_long', {
      source: 'executor', length: text.length, limit: TG_CAPTION_LIMIT
    });
  }

  var sent = blob
    ? tgSendPhoto_(cfg.allowedChatId, blob, text, markup)
    : tgApi_('sendMessage',
        markup ? { chat_id: String(cfg.allowedChatId), text: text, reply_markup: markup }
               : { chat_id: String(cfg.allowedChatId), text: text });
  if (!sent) {
    logEvent_('error', 'executor_card_failed', {
      source: 'executor', sigId: payload.sig_id.slice(-12)
    });
  }

  // 廣播排在私訊之後，而且失敗不影響私訊的結果。
  // 你的卡片是下單用的，群組那則是給人看的 —— 順序與重要性一致。
  var fileId = null;
  if (sent && sent.photo && sent.photo.length) {
    fileId = sent.photo[sent.photo.length - 1].file_id;
  }
  var broadcast = broadcastSignal_(payload, result, originalText, fileId);

  return { sent: sent, broadcastSent: Boolean(broadcast) };
}

/**
 * 處理按鈕點擊。由 Code.gs 的 handleTelegramMessage_ 在看到
 * update.callback_query 時呼叫。
 *
 * 順序刻意如此：
 * 1. 先驗證來源聊天室 —— 訊息可能被轉發
 * 2. 立刻 answerCallbackQuery —— Telegram 約 10 秒內沒回應，
 *    按鈕會一直轉圈，使用者就會重複點
 * 3. 才去呼叫執行層
 * 4. 用 editMessageText 改寫原訊息並移除按鈕，物理上阻止再點
 */
/**
 * 送出「持倉上限」面板。使用者在 Telegram 打「部位」時觸發。
 *
 * 為什麼用按鈕而不是打數字：打字會錯（打成 30、打成中文），
 * 而按鈕只能按到合法的值。風控參數不該有「輸入驗證失敗」這種狀態。
 */
function sendLimitPanel_(config) {
  var info = getExecutorJson_();
  if (!info || !info.ok) {
    tgApi_('sendMessage', {
      chat_id: String(config.allowedChatId),
      text: '⚠️ 取不到目前的持倉上限：' + ((info && info.error) || '執行層沒有回應')
    });
    return;
  }

  var ceiling = Number(info.ceiling) || 5;
  var row = [];
  for (var n = 1; n <= ceiling; n++) {
    row.push({
      text: (n === info.maxConcurrent ? '● ' : '') + n,
      callback_data: CB_LIMIT + n
    });
  }

  tgApi_('sendMessage', {
    chat_id: String(config.allowedChatId),
    text: '⚙️ 同時持倉上限\n─────────────\n'
      + '目前：' + info.maxConcurrent + ' 個'
      + (info.overridden ? '（手動設定）' : '（環境變數預設）') + '\n'
      + '在場：' + info.openPositions + ' 個\n'
      + '可選範圍：1 ～ ' + ceiling + '\n\n'
      + '要超過 ' + ceiling + '，得改 Zeabur 的 MAX_CONCURRENT_CEILING。',
    reply_markup: { inline_keyboard: [row] }
  });
}

/** 處理上限按鈕。 */
function handleLimitCallback_(wanted, queryId, msg, config) {
  var res = postExecutorJson_(null, { maxConcurrent: wanted });
  var okNow = res && res.ok;

  if (queryId) {
    tgApi_('answerCallbackQuery', {
      callback_query_id: queryId,
      text: okNow ? ('已改為 ' + res.maxConcurrent + ' 個')
        : ('失敗：' + ((res && res.error) || '執行層沒有回應'))
    });
  }

  if (okNow && msg && msg.message_id) {
    // 就地改寫面板，讓「現在是幾」一眼看得到。
    // 另開一則新訊息的話，聊天室裡會留下好幾個狀態不同的面板。
    var ceiling = Number(res.ceiling) || 5;
    var row = [];
    for (var n = 1; n <= ceiling; n++) {
      row.push({
        text: (n === res.maxConcurrent ? '● ' : '') + n,
        callback_data: CB_LIMIT + n
      });
    }
    tgApi_('editMessageText', {
      chat_id: String(msg.chat.id),
      message_id: msg.message_id,
      text: '⚙️ 同時持倉上限\n─────────────\n'
        + '目前：' + res.maxConcurrent + ' 個（手動設定）\n'
        + '在場：' + res.openPositions + ' 個\n'
        + '可選範圍：1 ～ ' + ceiling,
      reply_markup: { inline_keyboard: [row] }
    });
  }

  logEvent_(okNow ? 'info' : 'warn', okNow ? 'limit_changed' : 'limit_change_failed', {
    source: 'executor', wanted: wanted,
    result: okNow ? res.maxConcurrent : ((res && res.error) || 'no_response')
  });
  return textOutput_(okNow ? 'limit updated' : 'limit failed');
}

/**
 * 日損上限面板。使用者在 Telegram 打「日損」時觸發。
 *
 * 面板永遠同時顯示兩個數字：真實日損與採計日損。
 * 重置過之後這兩個會分岔，而只看得到其中一個的人會做出錯誤判斷 ——
 * 「今天才虧 12」和「今天虧 112、已經重置過一次」是完全不同的處境。
 */
function sendDailyPanel_(config) {
  var d = getDailyState_();
  if (!d || !d.ok) {
    tgApi_('sendMessage', {
      chat_id: String(config.allowedChatId),
      text: '⚠️ 取不到日損狀態：' + ((d && d.error) || '執行層沒有回應')
        + '\n\n執行層可能還是舊版（/daily 這個端點不存在），'
        + '或 EXECUTOR_URL 設錯了。'
    });
    return;
  }

  var sent = tgApi_('sendMessage', {
    chat_id: String(config.allowedChatId),
    text: renderDailyPanel_(d),
    reply_markup: dailyMarkup_(d)
  });

  // 【絕不靜默失敗】
  // tgApi_ 失敗時只回 null 並寫 console —— 使用者那端什麼都沒有。
  // 而「打了指令、什麼都沒發生」是最難查的一種故障：
  // 分不出是沒部署、被暫停、執行層掛了，還是訊息根本沒送出。
  //
  // 按鈕的結構比純文字脆弱（欄位錯、callback_data 過長都會被 Telegram 退件），
  // 所以退一步只送文字。數字看得到，比整則消失有用得多。
  if (!sent) {
    logEvent_('warn', 'daily_panel_markup_failed', { source: 'executor' });
    var plain = tgApi_('sendMessage', {
      chat_id: String(config.allowedChatId),
      text: renderDailyPanel_(d) + '\n\n⚠️ 按鈕送不出去，只顯示數字。'
    });
    if (!plain) {
      logEvent_('error', 'daily_panel_failed', { source: 'executor' });
    }
  }
}

/**
 * 從候選值裡挑出落在合法範圍內的幾個，做成按鈕列。
 *
 * 用固定候選值而不是「目前值 ±10」，是因為按鈕要可預測 ——
 * 同一顆位置每次按都是同一個數字，才有辦法形成肌肉記憶。
 * 相對值的按鈕每按一次整排都會變，等於每次都要重看。
 */
function pickSteps_(candidates, lo, hi, cap) {
  var out = [];
  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (v >= lo && v <= hi && out.indexOf(v) === -1) out.push(v);
  }
  // 邊界值一定要按得到。範圍是 10～240 卻按不到 240，
  // 等於那個設定只有一半能用。
  if (hi >= lo && out.indexOf(hi) === -1) out.push(hi);
  out.sort(function (a, b) { return a - b; });
  var max = cap || 5;
  if (out.length > max) {
    // 保留最大值，其餘等距取樣
    var keep = [out[out.length - 1]];
    var step = (out.length - 1) / (max - 1);
    for (var k = max - 2; k >= 0; k--) keep.unshift(out[Math.round(k * step)]);
    out = keep.filter(function (v, idx, arr) { return arr.indexOf(v) === idx; });
  }
  return out;
}

/** 面板文字。查詢、確認前、重置後三種情境共用同一份排版。 */
function renderDailyPanel_(d) {
  var real = -Number(d.realisedPnlUsdt || 0);
  var eff = -Number(d.effectivePnlUsdt || 0);
  var lines = [
    (d.blocked ? '🛑 日損上限：已觸發' : '📊 日損上限'),
    '─────────────',
    '真實日損：' + real.toFixed(2) + ' USDT',
  ];
  // 沒重置過的話兩個數字一樣，多寫一行只是雜訊。
  if (d.resetCount > 0) {
    lines.push('採計日損：' + eff.toFixed(2) + ' USDT（重置後重算）');
  }
  lines.push('上限：' + d.dailyLossLimitUsdt + ' USDT');
  lines.push('今日筆數：' + (d.orders || 0));
  lines.push('─────────────');
  lines.push('今日已重置：' + d.resetCount + ' / ' + d.resetLimit + ' 次');
  lines.push('冷卻設定：' + d.cooldownMin + ' 分鐘');
  if (d.cooldownActive) {
    lines.push('❄️ 冷卻中，還有 ' + d.cooldownRemainMin + ' 分鐘才會放行');
  }
  if (d.resetLimit <= 0) {
    lines.push('（重置功能已關閉：DAILY_RESET_LIMIT=0）');
  }
  lines.push('─────────────');
  lines.push('上限可調範圍：10 ～ ' + (d.dailyLossCeiling || d.dailyLossLimitUsdt) + ' USDT');
  lines.push('冷卻最短：' + (d.cooldownFloor || 0) + ' 分鐘（只能調長）');
  return lines.join('\n');
}

/**
 * 面板按鈕。只有在「真的擋住了、還有額度、不在冷卻中」時才給重置鍵。
 *
 * 按不到的按鈕不如不要有。一顆按下去只會回「目前未達上限」的按鈕，
 * 會訓練人養成「先按再說」的習慣 —— 那正是這組設計要避免的東西。
 */
function dailyMarkup_(d) {
  var rows = [];

  // 重置鍵：只有在「真的擋住了、還有額度、不在冷卻中」時才出現。
  //
  // 按不到的按鈕不如不要有。一顆按下去只會回「目前未達上限」的按鈕，
  // 會訓練人養成「先按再說」的習慣 —— 那正是這組設計要避免的東西。
  if (d.blocked && d.resetLimit > 0 && d.resetsLeft > 0 && !d.cooldownActive) {
    rows.push([{ text: '♻️ 重置日損上限', callback_data: CB_DAILY_ASK }]);
  }

  var ceiling = Number(d.dailyLossCeiling || d.dailyLossLimitUsdt) || 100;
  var limits = pickSteps_([10, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300],
    10, ceiling, 5);
  if (limits.length) {
    rows.push(limits.map(function (v) {
      return {
        text: (v === Number(d.dailyLossLimitUsdt) ? '● ' : '') + v,
        callback_data: CB_DAILY_LIMIT + v
      };
    }));
  }

  var floor = Number(d.cooldownFloor || 0);
  // 按鈕上界收在 240 分（4 小時）。執行層允許到 720，
  // 但 12 小時的冷卻等於「今天不交易了」—— 那個決定該用停止鍵表達，
  // 不是藏在一顆看起來和其他幾顆一樣的按鈕裡。
  var cools = pickSteps_([0, 15, 30, 45, 60, 90, 120, 180, 240], floor, 240, 5);
  if (cools.length) {
    rows.push(cools.map(function (v) {
      return {
        text: (v === Number(d.cooldownMin) ? '● ' : '') + v + '分',
        callback_data: CB_DAILY_COOL + v
      };
    }));
  }

  return rows.length ? { inline_keyboard: rows } : undefined;
}

/**
 * 重置按鈕。兩段式：ask 攤開後果，go 才執行。
 */
function handleDailyCallback_(data, queryId, msg, config) {
  var chatId = msg && msg.chat && msg.chat.id;
  var messageId = msg && msg.message_id;

  // ---- 第一段：問清楚 ----
  if (data === CB_DAILY_ASK) {
    var d = getDailyState_();
    if (queryId) tgApi_('answerCallbackQuery', { callback_query_id: queryId });
    if (!d || !d.ok) return textOutput_('daily state unavailable');
    var real = -Number(d.realisedPnlUsdt || 0);
    var eff = -Number(d.effectivePnlUsdt || 0);
    tgApi_('editMessageText', {
      chat_id: String(chatId),
      message_id: messageId,
      text: [
        '⚠️ 確認要重置日損上限？',
        '─────────────',
        '這會把風控採計的 ' + eff.toFixed(2) + ' USDT 虧損歸零，',
        '今天可以再虧到 ' + d.dailyLossLimitUsdt + ' USDT 才會再次被擋。',
        '',
        '真實日損不會改變，現在是 ' + real.toFixed(2) + ' USDT，',
        '重置後最壞情況會變成 ' + (real + Number(d.dailyLossLimitUsdt)).toFixed(2) + ' USDT。',
        '',
        '重置之後還有 ' + d.cooldownMin + ' 分鐘冷卻期，期間一樣不會下單。',
        '今日剩餘重置次數：' + d.resetsLeft + ' 次（用掉就沒有了）'
      ].join('\n'),
      reply_markup: {
        inline_keyboard: [[
          { text: '確定重置', callback_data: CB_DAILY_GO },
          { text: '取消', callback_data: CB_DAILY + 'no' }
        ]]
      }
    });
    return textOutput_('daily reset confirm');
  }

  // ---- 從拒絕卡片叫出面板 ----
  // 另發一則而不是改寫原卡片：那張卡片是交易紀錄，
  // 把它改成設定面板等於把當時發生的事抹掉。
  if (data === CB_DAILY_PANEL) {
    if (queryId) tgApi_('answerCallbackQuery', { callback_query_id: queryId });
    sendDailyPanel_(config);
    return textOutput_('daily panel sent');
  }

  // ---- 調整日損上限／冷卻 ----
  //
  // 這兩個不做兩段確認，與重置鍵不同。理由：重置是「現在就解除一道
  // 已經生效的保護」，調參數是「改變往後的門檻」，而且兩個方向都被
  // 夾在環境變數的界線裡 —— 按錯一下再按回來就好，沒有不可逆的那一刻。
  if (data.indexOf(CB_DAILY_LIMIT) === 0 || data.indexOf(CB_DAILY_COOL) === 0) {
    var isLimit = data.indexOf(CB_DAILY_LIMIT) === 0;
    var val = Number(data.slice((isLimit ? CB_DAILY_LIMIT : CB_DAILY_COOL).length));
    var payload = isLimit ? { dailyLossLimit: val } : { resetCooldownMin: val };
    var r = postExecutorJson_('/limits', payload);
    var good = r && r.ok;

    if (queryId) {
      tgApi_('answerCallbackQuery', {
        callback_query_id: queryId,
        text: good
          ? (isLimit ? ('日損上限 → ' + val + ' USDT') : ('冷卻 → ' + val + ' 分鐘'))
          : ('失敗：' + ((r && r.error) || '執行層沒有回應'))
      });
    }

    // 成功就重畫面板。/limits 回的欄位與 /daily 不同名，
    // 所以重新查一次 /daily —— 少掉的那次往返，換來的是
    // 「面板上的數字永遠等於執行層的真實狀態」。
    if (good && chatId && messageId) {
      var fresh = getDailyState_();
      if (fresh && fresh.ok) {
        tgApi_('editMessageText', {
          chat_id: String(chatId), message_id: messageId,
          text: renderDailyPanel_(fresh), reply_markup: dailyMarkup_(fresh)
        });
      }
    }

    logEvent_(good ? 'warn' : 'error',
      good ? 'daily_setting_changed' : 'daily_setting_failed', {
        source: 'executor',
        key: isLimit ? 'dailyLossLimit' : 'resetCooldownMin',
        value: val,
        error: good ? null : ((r && r.error) || 'no_response')
      });
    return textOutput_(good ? 'daily setting updated' : 'daily setting failed');
  }

  // ---- 取消 ----
  if (data === CB_DAILY + 'no') {
    if (queryId) tgApi_('answerCallbackQuery', { callback_query_id: queryId, text: '已取消' });
    var cur = getDailyState_();
    if (cur && cur.ok && chatId && messageId) {
      tgApi_('editMessageText', {
        chat_id: String(chatId), message_id: messageId,
        text: renderDailyPanel_(cur), reply_markup: dailyMarkup_(cur)
      });
    }
    return textOutput_('daily reset cancelled');
  }

  // ---- 第二段：真的執行 ----
  if (data === CB_DAILY_GO) {
    var res = postExecutorJson_('/daily/reset', { confirm: true, note: 'telegram' });
    var okNow = res && res.ok;
    if (queryId) {
      tgApi_('answerCallbackQuery', {
        callback_query_id: queryId,
        text: okNow ? '已重置' : ('失敗：' + ((res && res.error) || '執行層沒有回應'))
      });
    }
    if (chatId && messageId) {
      var body;
      if (okNow) {
        body = [
          '♻️ 日損上限已重置',
          '─────────────',
          '抹掉的採計虧損：' + (-Number(res.clearedUsdt || 0)).toFixed(2) + ' USDT',
          '真實日損（不變）：' + (-Number(res.realisedPnlUsdt || 0)).toFixed(2) + ' USDT',
          '今日已重置：' + res.resetCount + ' / ' + res.resetLimit + ' 次',
          '❄️ 冷卻 ' + res.cooldownMin + ' 分鐘，期間不會下單'
        ].join('\n');
      } else {
        body = '⚠️ 重置失敗\n─────────────\n'
          + ((res && res.error) || '執行層沒有回應');
      }
      tgApi_('editMessageText', {
        chat_id: String(chatId), message_id: messageId, text: body
      });
    }
    logEvent_(okNow ? 'warn' : 'error',
      okNow ? 'daily_loss_reset' : 'daily_loss_reset_failed', {
        source: 'executor',
        cleared: okNow ? Number((-res.clearedUsdt).toFixed(2)) : null,
        resetCount: okNow ? res.resetCount : null,
        error: okNow ? null : ((res && res.error) || 'no_response')
      });
    return textOutput_(okNow ? 'daily reset' : 'daily reset failed');
  }

  if (queryId) tgApi_('answerCallbackQuery', { callback_query_id: queryId });
  return textOutput_('unknown daily action');
}

function handleExecutorCallback_(cb, config) {
  var queryId = cb && cb.id;
  var msg = cb && cb.message;
  // 帶圖的訊息內容在 caption，純文字訊息在 text。統一成 text 供後續使用。
  if (msg && !msg.text && msg.caption) msg.text = msg.caption;
  var chatId = msg && msg.chat && msg.chat.id;
  var data = String((cb && cb.data) || '');

  // 1. 授權。兩道都要過：聊天室要對，「按的那個人」也要對。
  //
  // 【為什麼不能只驗聊天室】
  // 私訊裡聊天室等於人，兩者同義。加進群組之後就不是了 ——
  // 群組是一個 chat id，裡面有 N 個人，而 inline 按鈕每個成員都按得到。
  // 只驗聊天室的話，只要有一張帶按鈕的卡片流進群組（轉發、貼錯、
  // 哪天改了設定），任何成員都能替你下單。
  //
  // 現在按鈕只發私訊，所以第一道就已經擋住了 —— 第二道是為了
  // 「第一道哪天被改壞」而存在。風控不該只有一層。
  var fromId = cb && cb.from && cb.from.id;
  if (!chatId || !safeEquals_(String(chatId), config.allowedChatId)
      || !isOperator_(fromId)) {
    logEvent_('warn', 'executor_callback_unauthorized', {
      source: 'executor', fromId: fromId, chatOk: Boolean(
        chatId && safeEquals_(String(chatId), config.allowedChatId))
    });
    if (queryId) tgApi_('answerCallbackQuery', { callback_query_id: queryId, text: '未授權' });
    return textOutput_('forbidden callback');
  }

  if (data.indexOf(CB_PREFIX) !== 0) {
    if (queryId) tgApi_('answerCallbackQuery', { callback_query_id: queryId });
    return textOutput_('ignored callback');
  }

  // 持倉上限的按鈕不走訊號那條路 —— 它沒有 sig_id，也不需要冪等鎖。
  if (data.indexOf(CB_LIMIT) === 0) {
    return handleLimitCallback_(Number(data.slice(CB_LIMIT.length)), queryId, msg, config);
  }
  if (data.indexOf(CB_DAILY) === 0) {
    return handleDailyCallback_(data, queryId, msg, config);
  }

  var isConfirm = data.indexOf(CB_CONFIRM) === 0;
  var sigId = data.slice((isConfirm ? CB_CONFIRM : CB_SKIP).length);

  // 2. 以 sig_id 上鎖。
  //
  // update_id 去重擋得住 Telegram 的重送，但擋不住「使用者連點三下」——
  // 那是三個不同的 update_id、同一筆訊號。執行層本身有冪等保護，
  // 第二次之後會回 not_found，所以不會重複下單；問題出在顯示：
  // 每一次回應都會改寫卡片，於是「✅ 已進場」被後面的「⌛ 已失效」蓋掉，
  // 讓人看不出到底成交了沒。在一個用來下單的介面上，這比日誌雜訊嚴重得多。
  if (!claimCallback_(sigId)) {
    if (queryId) {
      tgApi_('answerCallbackQuery', {
        callback_query_id: queryId,
        text: '這筆已在處理或已完成，結果以上方訊息為準'
      });
    }
    logEvent_('info', 'executor_callback_duplicate', {
      source: 'executor', sigId: String(sigId).slice(-12)
    });
    return textOutput_('duplicate callback');
  }

  // 3. 先回應，避免按鈕轉圈
  if (queryId) {
    tgApi_('answerCallbackQuery', {
      callback_query_id: queryId,
      text: isConfirm ? '確認中…' : '略過中…'
    });
  }

  // 4. 呼叫執行層
  var cfg = getExecutorConfig_();
  if (!cfg.enabled) {
    releaseCallback_(sigId);
    editCardResult_(chatId, msg.message_id, '⚠️ 未設定執行層網址，無法處理');
    return textOutput_('executor not configured');
  }
  var res = callExecutorAction_(isConfirm ? 'confirm' : 'skip', sigId, cfg);

  // 連不上不是「已處理」，要放掉鎖，否則使用者連重試的機會都沒有。
  // 執行層那邊什麼都沒發生，重按是安全的。
  if (!res.ok) releaseCallback_(sigId);

  // 5. 改寫原訊息並移除按鈕
  var head;
  if (!res.ok) {
    head = '⚠️ 連不上執行層，這筆未處理';
  } else if (res.decision === 'placed') {
    head = res.dryRun ? '👍 已確認（DRY_RUN，未真的送單）' : '✅ 已進場';
  } else if (res.decision === 'skipped') {
    head = '⏭ 已略過';
  } else if (res.decision === 'not_found') {
    head = '⌛ 已失效（逾時或已處理過）';
  } else if (res.decision === 'already_handling') {
    head = '⏳ 已在處理中，請稍候';
  } else {
    head = '⛔ 未執行：' + truncate_((res.reasons || []).join('；'), 120);
  }
  // 重算的差異緊貼在標題下面 —— 下方保留的是「當時核准的內容」，
  // 兩者並列才看得出發生了什麼，而不是讓人以為數字自己變了。
  if (res.drift && res.drift.verdict === 'resize'
      && res.drift.fromQty !== undefined && res.drift.toQty !== undefined) {
    head += '\n🔄 依現價 ' + res.drift.livePrice + ' 重算：'
      + res.drift.fromQty + ' → ' + res.drift.toQty + ' 張'
      + '（漂移 ' + res.drift.driftR + 'R，風險已拉回預算）';
  }
  editCardResult_(chatId, msg.message_id, head, msg.text);

  logEvent_(res.ok && (res.decision === 'placed' || res.decision === 'skipped')
    ? 'info' : 'warn',
    isConfirm ? 'executor_user_confirmed' : 'executor_user_skipped', {
      source: 'executor',
      sigId: String(sigId).slice(-12),
      decision: res.decision || 'unreachable',
      reasons: truncate_((res.reasons || []).join('；'), 160)
    });

  return textOutput_('ok');
}

// ---- 按鈕點擊的 sig_id 鎖 ----
// TTL 取 600 秒，比執行層的 PENDING_TTL_SEC（300）長一倍：
// 待確認訊號都過期了，鎖還在，確保不會有「過期後又被點開」的空窗。
var CB_CLAIM_PREFIX = 'execcb_';
var CB_CLAIM_TTL_SEC = 600;

/**
 * 嘗試取得某筆 sig_id 的處理權。已被取走就回 false。
 *
 * 用 CacheService 而非指令碼屬性：這是短命狀態，用完即棄，
 * 寫進屬性只會佔用那 500 KB 的共用額度。
 */
function claimCallback_(sigId) {
  var key = CB_CLAIM_PREFIX + String(sigId);
  var lock = LockService.getScriptLock();
  try {
    // CacheService 沒有原子的 check-and-set，靠鎖把「讀→寫」包起來。
    if (!lock.tryLock(3000)) return false;   // 拿不到鎖＝另一個請求正在處理
    var cache = CacheService.getScriptCache();
    if (cache.get(key)) return false;
    cache.put(key, '1', CB_CLAIM_TTL_SEC);
    return true;
  } catch (error) {
    // 快取或鎖異常不該讓按鈕整個失效。放行，改由執行層的冪等保護兜底 ——
    // 最差情況是卡片被改寫兩次，不會重複下單。
    console.error('callback 上鎖失敗，改由執行層冪等保護兜底：' + error);
    return true;
  } finally {
    try { lock.releaseLock(); } catch (e) { /* 忽略 */ }
  }
}

/** 放掉處理權，讓使用者可以重按。只在「執行層那邊確定沒發生任何事」時呼叫。 */
function releaseCallback_(sigId) {
  try {
    CacheService.getScriptCache().remove(CB_CLAIM_PREFIX + String(sigId));
  } catch (error) {
    // 最差情況是這 10 分鐘內不能重按，不影響資金安全
    console.error('callback 解鎖失敗：' + error);
  }
}

/** 呼叫執行層的 /confirm 或 /skip。 */
function callExecutorAction_(action, sigId, cfg) {
  try {
    var r = UrlFetchApp.fetch(cfg.url + '/' + action, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Executor-Key': cfg.secret },
      // notify:false —— 結果由這裡改寫原訊息呈現，執行層不用再發一則
      payload: JSON.stringify({ sig_id: sigId, notify: false }),
      muteHttpExceptions: true
    });
    if (r.getResponseCode() !== 200) {
      return { ok: false, error: 'HTTP ' + r.getResponseCode() };
    }
    var body = JSON.parse(r.getContentText());
    return {
      ok: true,
      decision: body.decision,
      reasons: body.reasons || [],
      // 執行層可能依現價把數量改掉了。卡片上的數字是按下去之前核准的，
      // 不把差異講出來，就等於默默換掉了使用者核准的那筆交易。
      drift: body.drift || null,
      dryRun: Boolean(body.dryRun)
    };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * 把原卡片的第一行換成結果，其餘內容保留，並移除按鈕。
 * 保留明細的用意是讓紀錄完整 —— 事後回頭看，能知道當時看到的是什麼數字。
 */
function editCardResult_(chatId, messageId, head, originalText) {
  var rest = '';
  if (originalText) {
    var lines = String(originalText).split('\n');
    var oldHead = lines.shift();        // 丟掉舊的標題行
    rest = lines.join('\n');

    // ……但保留它「｜」之後的部分。方向（做多⬆／做空⬇）就放在那裡，
    // 整行換掉會讓已確認的卡片變成一筆沒有方向的紀錄 —— 事後翻訊息時，
    // 看得到價格與數量卻看不出做多還是做空，是最沒有用的那種紀錄。
    var bar = String(oldHead).indexOf('｜');
    if (bar !== -1) head += String(oldHead).slice(bar);
  }
  var full = head + (rest ? '\n' + rest : '');
  // 帶圖的訊息沒有 text 只有 caption，用 editMessageText 會被退件
  // （Telegram 回 "there is no text in the message to edit"）。
  // 先試 caption，失敗再退回 text —— 兩種卡片都要能被改寫。
  var edited = tgApi_('editMessageCaption', {
    chat_id: String(chatId),
    message_id: messageId,
    caption: full,
    reply_markup: { inline_keyboard: [] }   // 空陣列＝移除按鈕
  });
  if (!edited) {
    tgApi_('editMessageText', {
      chat_id: String(chatId),
      message_id: messageId,
      text: full,
      reply_markup: { inline_keyboard: [] }
    });
  }
}

// ================================================================
// 五、安裝與診斷（手動執行）
// ================================================================

/**
 * 執行一次：建立補送用的每分鐘觸發器，並檢查設定。
 */
function setupExecutorBridge() {
  var cfg = getExecutorConfig_();
  var problems = [];

  if (!cfg.url) problems.push('缺少指令碼屬性 ' + EXECUTOR_URL_PROPERTY);
  else if (!/^https:\/\//.test(cfg.url)) problems.push(EXECUTOR_URL_PROPERTY + ' 必須是 https 開頭');
  if (!cfg.secret) problems.push('缺少指令碼屬性 ' + EXECUTOR_SECRET_PROPERTY);
  else if (cfg.secret.length < 16) problems.push(EXECUTOR_SECRET_PROPERTY + ' 長度不足 16 字元');

  if (problems.length) {
    throw new Error('執行層橋接設定不完整：\n  - ' + problems.join('\n  - '));
  }

  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'flushExecutorQueue';
  });
  if (!exists) {
    ScriptApp.newTrigger('flushExecutorQueue').timeBased().everyMinutes(1).create();
    console.log('已建立每分鐘補送觸發器 flushExecutorQueue。');
  } else {
    console.log('補送觸發器已存在，未重複建立。');
  }
  console.log('執行層橋接設定完成。接著請執行 testExecutorConnection() 驗證連線。');
}

/** 檢查橋接狀態；不輸出任何密鑰。 */
function diagnoseExecutorBridge() {
  var props = PropertiesService.getScriptProperties();
  var raw = String(props.getProperty(EXECUTOR_URL_PROPERTY) || '').trim();
  var cfg = getExecutorConfig_();
  console.log(JSON.stringify({
    urlAsEntered: raw || null,
    urlActuallyUsed: cfg.url || null,
    urlHadExtraPath: executorUrlHadPath_(),
    healthEndpoint: cfg.url ? cfg.url + '/health' : null,
    signalEndpoint: cfg.url ? cfg.url + '/signal' : null,
    secretConfigured: Boolean(cfg.secret),
    secretLength: cfg.secret.length,
    triggerConfigured: ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'flushExecutorQueue';
    }),
    pendingRetries: countKeysWithPrefix_(props.getKeys(), EXECUTOR_RETRY_PREFIX),
    broadcastChatId: getBroadcastChatId_() || '(未設定或與私訊相同，廣播關閉)',
    broadcastThreadId: getBroadcastThreadId_() || '(未設定，送到群組 General)'
  }, null, 2));
  if (executorUrlHadPath_()) {
    console.log('提醒：' + EXECUTOR_URL_PROPERTY +
      ' 含有多餘的路徑，已自動忽略。建議把屬性值改成上面的 urlActuallyUsed。');
  }
}

/** 清空補送佇列。僅在確定不需要補送時使用。 */
function clearExecutorQueue() {
  var props = PropertiesService.getScriptProperties();
  var keys = props.getKeys().filter(function (k) {
    return k.indexOf(EXECUTOR_RETRY_PREFIX) === 0;
  });
  keys.forEach(function (k) { props.deleteProperty(k); });
  console.log('已清除 ' + keys.length + ' 筆待補送訊號。');
}

// ================================================================
// 六、測試（手動執行）
// ================================================================

/**
 * 以現價為基準，生成一筆「此刻合理」的測試訊號。
 *
 * 寫死價格的樣本有個致命缺陷：市場一走遠，它就永遠停在漂移檢查，
 * 下單那條路再也測不到。而那正是最需要驗證的一段。
 *
 * 這裡打的是 OKX 的公開行情端點，不需要簽章，也不需要憑證 ——
 * 所以在還沒填金鑰時一樣能用。
 *
 * 止損距離取 0.45%，與原本的固定樣本相同（385.7 / 85397.5）；
 * 三個止盈依 1R / 2R / 3R 推算。
 */
function buildLiveSampleSignalText_(over) {
  var o = over || {};
  var instId = o.instId || 'BTC-USDT-SWAP';
  var res = UrlFetchApp.fetch(
    'https://www.okx.com/api/v5/market/ticker?instId=' + encodeURIComponent(instId),
    { method: 'get', muteHttpExceptions: true });

  if (res.getResponseCode() !== 200) {
    throw new Error('取得現價失敗：HTTP ' + res.getResponseCode());
  }
  var body = JSON.parse(res.getContentText());
  var last = body && body.data && body.data[0] ? Number(body.data[0].last) : NaN;
  if (!isFinite(last) || last <= 0) {
    throw new Error('OKX 回傳的現價無法解析');
  }

  // 取兩位小數即可；BTC 永續的 tickSz 是 0.1，多餘的位數會被交易所自行截掉。
  var r = function (x) { return Math.round(x * 100) / 100; };
  var isLong = (o.side || '做多⬆').indexOf('做多') !== -1;
  var dist = r(last * 0.0045);
  var entry = r(last);
  var sl = isLong ? r(entry - dist) : r(entry + dist);
  var tp = [1, 2, 3].map(function (n) {
    return isLong ? r(entry + dist * n) : r(entry - dist * n);
  });

  return buildSampleSignalText_({
    symbol: o.symbol || 'BTCUSDT.P',
    tf: o.tf, grade: o.grade, score: o.score, side: o.side,
    entry: String(entry), sl: String(sl),
    tp1: String(tp[0]), tp2: String(tp[1]), tp3: String(tp[2]),
    time: new Date().toISOString().slice(0, 16).replace('T', ' ')
  });
}

function buildSampleSignalText_(over) {
  var o = over || {};
  return '《維加斯訊號》交易訊號\n' +
    '─────────────\n' +
    '[時間] ' + (o.time || '2026-09-22 01:50') + '\n' +
    '[幣種] ' + (o.symbol || 'BTCUSDT.P') + '\n' +
    '[週期] ' + (o.tf || '1小時') + '\n' +
    '[時區] Asia/Taipei\n' +
    '[品質] ' + (o.grade || '高品質') + '\n' +
    // v11.9 的欄位。傳 o.score = '' 可以模擬舊版指標（沒有這一行）。
    (o.score === '' ? '' : '[分數] ' + (o.score || '88') + '\n') +
    '[方向] ' + (o.side || '做多⬆') + '\n' +
    '[價格] ' + (o.entry || '85397.5') + ' USDT\n' +
    '[止損] ' + (o.sl || '85011.8') + ' USDT\n' +
    '[止盈1] ' + (o.tp1 || '85783.2') + ' USDT\n' +
    '[止盈2] ' + (o.tp2 || '86169.0') + ' USDT\n' +
    '[止盈3] ' + (o.tp3 || '86554.7') + ' USDT';
}

/**
 * 解析邏輯的單元測試。不連網、不需設定，隨時可執行。
 */
function testParseSignalToJson() {
  var fails = [];
  function ck(name, cond) { if (!cond) fails.push(name); }

  // 正常做多
  var a = parseSignalToJson_(buildSampleSignalText_(), 'tv:abc123def456', 1758470000000);
  ck('做多訊號應解析成功：' + JSON.stringify(a.errors || []), a.ok);
  if (a.ok) {
    ck('symbol', a.payload.symbol === 'BTCUSDT.P');
    ck('tf 1小時→60', a.payload.tf === '60');
    ck('grade 高品質→3', a.payload.grade === 3);
    ck('side', a.payload.side === 'long');
    ck('entry 去除 USDT', a.payload.entry === 85397.5);
    ck('sl', a.payload.sl === 85011.8);
    ck('tp 三段', a.payload.tp.length === 3 && a.payload.tp[0] === 85783.2);
    ck('sig_id 去掉 tv: 前綴', a.payload.sig_id === 'abc123def456');
  }

  // 正常做空
  var b = parseSignalToJson_(buildSampleSignalText_({
    side: '做空⬇', grade: '標準', entry: '85397.5', sl: '85783.2',
    tp1: '85011.8', tp2: '84626.1', tp3: '84240.4'
  }), 'tv:xyz', 1758470000000);
  ck('做空訊號應解析成功', b.ok && b.payload.side === 'short' && b.payload.grade === 2);

  // 週期轉換
  ck('15分鐘→15', tfTextToMinutes_('15分鐘') === '15');
  ck('4小時→240', tfTextToMinutes_('4小時') === '240');
  ck('日線→1440', tfTextToMinutes_('日線') === '1440');
  ck('週線→10080', tfTextToMinutes_('週線') === '10080');
  ck('30秒不支援', tfTextToMinutes_('30秒') === null);
  ck('月線不支援', tfTextToMinutes_('月線') === null);

  // 應被擋下的情況
  ck('做多但止損在上方應失敗',
    !parseSignalToJson_(buildSampleSignalText_({ sl: '85800' }), 'x').ok);
  ck('缺少幣種應失敗',
    !parseSignalToJson_('《維加斯訊號》交易訊號\n[週期] 1小時', 'x').ok);
  ck('測試訊號的「測試值」應失敗',
    !parseSignalToJson_(buildSampleSignalText_({ entry: '測試值' }), 'x').ok);
  ck('一般聊天訊息應失敗', !parseSignalToJson_('今天走勢如何', 'x').ok);

  // --- [分數] 欄位（v11.9）---
  ck('分數應解析為數字', a.payload.score === 88);
  ck('無降級時 demote 應為 null', a.payload.demote === null);

  var demoted = parseSignalToJson_(
    buildSampleSignalText_({ grade: '標準', score: '88（降級：觸碰過多）' }), 'x');
  ck('降級原因應解析出來',
    demoted.ok && demoted.payload.score === 88 && demoted.payload.demote === '觸碰過多');

  var multi = parseSignalToJson_(
    buildSampleSignalText_({ score: '71（降級：弱收盤過多＋近期反向訊號）' }), 'x');
  ck('多重降級原因應完整保留',
    multi.ok && multi.payload.demote === '弱收盤過多＋近期反向訊號');

  var halfWidth = parseSignalToJson_(buildSampleSignalText_({ score: '60(降級:觸碰過多)' }), 'x');
  ck('半形括號也要能解析', halfWidth.ok && halfWidth.payload.demote === '觸碰過多');

  // 舊版指標（v11.8 以前）不送 [分數]。這種訊號必須照常成立，
  // 否則指標還沒升級就全面停單 —— 那比沒有分數嚴重得多。
  var legacy = parseSignalToJson_(buildSampleSignalText_({ score: '' }), 'x');
  ck('舊版指標無 [分數] 仍應解析成功', legacy.ok);
  ck('舊版指標的 score 應為 null', legacy.ok && legacy.payload.score === null);

  var bad = parseSignalToJson_(buildSampleSignalText_({ score: '不明' }), 'x');
  ck('分數無法解析時應視為未提供而非拒單',
    bad.ok && bad.payload.score === null);
  var over = parseSignalToJson_(buildSampleSignalText_({ score: '150' }), 'x');
  ck('分數超出 0-100 應視為未提供', over.ok && over.payload.score === null);

  if (fails.length) {
    throw new Error('解析測試失敗 ' + fails.length + ' 項：\n  - ' + fails.join('\n  - '));
  }
  console.log('解析測試全數通過。範例輸出：\n' + JSON.stringify(a.payload, null, 2));
}

/**
 * 把「連線層」的例外分類。
 *
 * 錯誤的種類本身就是最有價值的線索，因為每一種只對應一個處置：
 *   dns      網域名稱查不到 —— 網址已失效或打錯
 *   timeout  名稱查得到但沒人回應 —— 服務重新部署中、休眠或當機
 *   ssl      連到了，但憑證不對 —— 網址打錯
 *   refused  連到了，但對方拒絕 —— 網域在、後面的服務沒在聽
 *
 * 注意這一層跟「HTTP 狀態碼錯誤」是兩回事：能拿到 404，代表連線是成功的。
 */
function classifyFetchError_(err) {
  var msg = String(err && err.message ? err.message : err);
  if (/DNS/i.test(msg)) return 'dns';
  if (/timed?\s?out|timeout/i.test(msg)) return 'timeout';
  if (/SSL|certificate|憑證/i.test(msg)) return 'ssl';
  if (/refused|unreachable|Address unavailable/i.test(msg)) return 'refused';
  return 'unknown';
}

/**
 * 把連線層例外翻成「接下來該做什麼」。
 * cfg 可以為空（設定讀取本身失敗時），此時只顯示通用說明。
 */
function diagnoseFetchFailure_(err, cfg) {
  var msg = truncate_(String(err && err.message ? err.message : err), 200);
  var kind = classifyFetchError_(err);
  var url = cfg && cfg.url ? String(cfg.url) : '';
  var host = url ? url.replace(/^https?:\/\//, '') : '（未設定）';
  var advice;

  if (kind === 'dns') {
    advice =
      '網域名稱解析失敗：「' + host + '」這個名字現在查不到。\n' +
      '這不是服務回錯，是網址本身失效 —— 能拿到 404 之類的回應才叫連得到。\n' +
      '常見原因：Zeabur 服務被刪除重建、網域被改名，或 ' + EXECUTOR_URL_PROPERTY + ' 打錯。\n' +
      '處理方式：\n' +
      '  1. 到 Zeabur 主控台確認服務目前的公開網域\n' +
      '  2. 專案設定 → 指令碼屬性，把 ' + EXECUTOR_URL_PROPERTY + ' 改成該網域（只到網域，不含路徑）\n' +
      '  3. 再跑一次 testExecutorConnection()';
  } else if (kind === 'timeout') {
    advice =
      '連線逾時：網址查得到，但沒有回應。\n' +
      '通常是 Zeabur 服務正在重新部署、已休眠或當機。\n' +
      '先在瀏覽器打開 ' + (url ? url + '/health' : '執行層的 /health') +
      ' 確認服務本身活著，再看 Zeabur 的執行日誌。';
  } else if (kind === 'ssl') {
    advice =
      '憑證驗證失敗：連到的東西不是預期的服務，通常代表網址打錯了。\n' +
      '執行 diagnoseExecutorBridge() 看目前實際採用的網址。';
  } else if (kind === 'refused') {
    advice =
      '連線被拒絕：網域在，但後面的服務沒有在聽。\n' +
      '請到 Zeabur 確認服務狀態為 Running，必要時重新部署。';
  } else {
    advice =
      '連線未建立。請依序確認：Zeabur 服務為 Running、' +
      EXECUTOR_URL_PROPERTY + ' 是目前的公開網域。';
  }

  return advice + '\n\n（原始錯誤：' + msg + '）';
}

/**
 * 測試與執行層的連線。先打 /health，再送一筆標記為測試的訊號。
 * 執行層在 DRY_RUN 下不會下單，但會回傳完整的倉位計算結果。
 *
 * 注意：這筆測試訊號也會走廣播，群組會收到一則「📡 維加斯訊號」。
 */
function testExecutorConnection() {
  var cfg = getExecutorConfig_();
  if (!cfg.enabled) {
    throw new Error('尚未設定 ' + EXECUTOR_URL_PROPERTY + ' 或 ' + EXECUTOR_SECRET_PROPERTY);
  }

  console.log('實際請求的網址：' + cfg.url + '/health');

  // muteHttpExceptions 只吞掉「HTTP 狀態碼錯誤」，不會吞掉
  // 「連線根本沒建立」的錯誤（DNS 查不到、逾時、憑證問題）。
  // 後者會直接拋例外，原始訊息只有一行 "DNS error"，看不出該做什麼，
  // 所以在這裡翻成可行動的說明。
  var health;
  try {
    health = UrlFetchApp.fetch(cfg.url + '/health', {
      method: 'get', muteHttpExceptions: true
    });
  } catch (err) {
    throw new Error(diagnoseFetchFailure_(err, cfg));
  }

  var code = health.getResponseCode();
  var body = health.getContentText();
  console.log('/health HTTP ' + code + '：' + truncate_(body, 400));

  if (code === 404 && body.indexOf('not found') !== -1) {
    // 這個 404 是執行層自己回的，代表「連得到、但路徑不對」。
    throw new Error(
      '連線成功，但路徑錯誤。執行層回了它自己的 404，代表服務正常。\n' +
      '請檢查指令碼屬性 ' + EXECUTOR_URL_PROPERTY + '：它只能填到網域為止，\n' +
      '例如 https://你的服務.zeabur.app ，不可以包含 /health 或其他路徑。\n' +
      '執行 diagnoseExecutorBridge() 可以看到目前實際採用的網址。'
    );
  }
  if (code !== 200) {
    throw new Error('執行層 /health 回應 HTTP ' + code +
      '。請到 Zeabur 確認服務狀態為 Running，並確認 ' + EXECUTOR_URL_PROPERTY +
      ' 是目前的公開網域。');
  }

  // 刻意走 forwardToExecutor_ 而不是直接呼叫 postToExecutor_。
  //
  // 因為 postToExecutor_ 送出的 payload 帶 notify:false，意思是
  //「Telegram 那一則由 Apps Script 發」。直接呼叫它，執行層不會發、
  // 這裡也不會發 —— 測試通過卻一則推播都沒有，等於沒測到按鈕。
  // 卡片是在 forwardToExecutor_ 裡發的，測試必須走同一條路才有意義。
  // 以現價為基準生成樣本。寫死的價格一旦與市場脫節，這個測試就永遠
  // 停在漂移檢查，下單那條路再也測不到 —— 而那正是最需要驗證的一段。
  var sampleText;
  try {
    sampleText = buildLiveSampleSignalText_();
    console.log('已用現價生成測試訊號：\n' + sampleText);
  } catch (err) {
    sampleText = buildSampleSignalText_();
    console.log('⚠️ 取現價失敗（' + err.message + '），改用固定樣本。\n' +
      '   固定樣本的價格是 2026-09-22 的，多半會被漂移檢查擋下 ——\n' +
      '   那代表行情路徑正常，不是故障。');
  }
  var forwarded = forwardToExecutor_(sampleText,
    'tv:conntest' + Utilities.getUuid().replace(/-/g, '').slice(0, 20));

  var result = forwarded && forwarded.result;
  if (!result) {
    throw new Error('轉送失敗，訊號已進入補送佇列。' +
      '請執行 diagnoseExecutorBridge() 查看，並檢閱上方的日誌列。');
  }
  console.log('/signal 結果：' + JSON.stringify(result, null, 2));
  console.log('群組廣播：' + (forwarded.broadcastSent ? '已送出' :
    (getBroadcastChatId_() ? '失敗（看日誌的 broadcast_failed）' : '未設定 SIGNAL_CHAT_ID')));

  if (result.decision === 'pending') {
    if (forwarded.cardSent) {
      console.log('✅ 已送出帶按鈕的卡片。請到 Telegram 點「✅ 進場」或「⏭ 略過」驗證按鈕。');
    } else {
      throw new Error(
        '執行層已收下訊號並轉為待確認，但 Telegram 卡片沒送出去。\n' +
        '請檢查：1) TG_TOKEN 與 ALLOWED_CHAT_ID 兩個指令碼屬性是否正確；\n' +
        '2) 上方日誌是否有 executor_card_failed 事件。'
      );
    }
  } else if (result.decision === 'placed') {
    console.log('✅ 執行層已直接下單（EXECUTION_MODE 非 manual）。');
  } else {
    var why = (result.reasons || []).join('；') || '未提供';
    console.log('⚠️ 執行層收下了，但決策為「' + result.decision + '」，原因：' + why);
    if (why.indexOf('現價') !== -1 || why.indexOf('漂移') !== -1) {
      console.log('   這是漂移檢查擋下的 —— 它必須先向 OKX 查到現價才能做這個判斷，\n' +
        '   所以「被它擋下」本身就證明了行情串接是通的。');
    } else {
      console.log('   這是風控閘門擋下的，連線正常。');
    }
  }
}

/**
 * 只測廣播路徑：送一則純文字測試訊息到 SIGNAL_CHAT_ID（與 SIGNAL_THREAD_ID）。
 * 不碰執行層、不產生訂單、不消耗 CHART-IMG 額度。
 * 與 Code.gs 的 testSignalThread() 送到同一個位置才算設定一致。
 */
function testBroadcastTarget() {
  var chatId = getBroadcastChatId_();
  if (!chatId) {
    throw new Error('廣播關閉：SIGNAL_CHAT_ID 未設定，或與 ALLOWED_CHAT_ID 相同。');
  }
  var threadId = getBroadcastThreadId_();
  var body = { chat_id: chatId, text: '🧪 執行層廣播路徑測試（非實盤訊號）' };
  if (threadId) body.message_thread_id = Number(threadId);
  var sent = tgApi_('sendMessage', body);
  if (!sent) {
    throw new Error('送出失敗。常見原因：bot 不在該群組、沒有發言權限，' +
      '或話題 ' + (threadId || '(無)') + ' 不存在／已關閉。看上方執行記錄的 Telegram 回應。');
  }
  console.log('已送到 ' + chatId + (threadId ? ' 的話題 ' + threadId : '（General）') +
    '。請確認它和 testSignalThread() 出現在同一個話題。');
}

/**
 * 驗證 callback_data 沒有超過 Telegram 的 64 位元組上限。
 * 這個限制很容易在改動 sig_id 長度時被忘記，而超過的後果是
 * Telegram 直接拒絕整則訊息 —— 卡片根本不會出現。
 */
function testCallbackDataLength() {
  var maxSig = new Array(SIG_ID_LENGTH + 1).join('f');
  var confirm = CB_CONFIRM + maxSig;
  var skip = CB_SKIP + maxSig;
  var over = [];
  [confirm, skip].forEach(function (d) {
    if (Utilities.newBlob(d).getBytes().length > 64) over.push(d);
  });
  if (over.length) {
    throw new Error('callback_data 超過 64 位元組：' + over.join(', '));
  }
  if (confirm.slice(CB_CONFIRM.length) !== maxSig) {
    throw new Error('callback_data 解析不回原 sig_id');
  }
  if (CB_SKIP.indexOf(CB_PREFIX) !== 0 || CB_CONFIRM === CB_SKIP) {
    throw new Error('兩個動作的前綴必須不同且共用命名空間');
  }
  console.log('callback_data 長度檢查通過：' +
    Utilities.newBlob(confirm).getBytes().length + ' / 64 位元組');
}

/**
 * 測試 K 線圖。會實際向 CHART-IMG 請求一張圖並發到 Telegram。
 * 不碰執行層、不產生任何訂單。
 *
 * 用現價生成樣本，所以三條線會落在畫面的合理位置 ——
 * 用寫死的舊價格會讓線跑到畫面外，看起來像畫錯了。
 */
function testChartImage() {
  var props = PropertiesService.getScriptProperties();
  if (!String(props.getProperty(CHART_KEY_PROPERTY) || '').trim()) {
    throw new Error('尚未設定指令碼屬性 ' + CHART_KEY_PROPERTY +
      '\n請到 chart-img.com 取得 API Key 後填入。');
  }

  var text;
  try {
    text = buildLiveSampleSignalText_();
  } catch (err) {
    console.log('⚠️ 取現價失敗（' + err.message + '），改用固定樣本，' +
      '三條線可能落在畫面外。');
    text = buildSampleSignalText_();
  }
  var parsed = parseSignalToJson_(text, 'tv:charttest' +
    Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  if (!parsed.ok) throw new Error('樣本解析失敗：' + parsed.errors.join('；'));

  var req = buildChartRequest_(parsed.payload, chartOptions_(props));
  console.log('請求內容：\n' + JSON.stringify(req, null, 2));
  console.log('時區來源：' +
    (parsed.payload.tz ? '訊號的 [時區] 欄位（' + parsed.payload.tz + '）'
                       : '預設值 ' + CHART_TZ_DEFAULT));

  var started = Date.now();
  var blob = fetchChartImage_(parsed.payload);
  var elapsed = Date.now() - started;

  if (!blob) {
    throw new Error(
      '取圖失敗。請看上方日誌的 chart_image_failed 事件，' +
      '裡面有 CHART-IMG 回的狀態碼與訊息。\n' +
      '常見原因：API Key 錯誤、代碼寫法不對（目前用 ' + req.symbol + '）、' +
      '或超過每日 50 次的免費額度。'
    );
  }

  console.log('取圖成功：' + blob.getBytes().length + ' 位元組，耗時 ' + elapsed + ' ms');
  var cfg = getConfig_();
  var sent = tgSendPhoto_(cfg.allowedChatId, blob,
    '🧪 K 線圖測試\n' + text.split('\n').slice(2).join('\n'), null);
  if (!sent) throw new Error('圖片取得成功，但 Telegram 發送失敗。');
  console.log('已送到 Telegram。請確認三條線（ENTRY／SL／TP1）位置正確。');
}

/**
 * 【探測】找出 CHART-IMG 接受的 EMA 指標名稱。
 *
 * 為什麼要探測：官方文件頁是動態渲染的，抓回來的內容與 API 實際
 * 接受的不一致（文件說 "Exponential Moving Average"，API 回 422）。
 * 文件與 API 打架時，以 API 為準 —— 所以直接問它。
 *
 * 每個候選送一次請求，共 5 次（BASIC 每日 50 次，每秒 1 次）。
 * 哪個回 200 就是哪個，不必再猜。
 */
function probeEmaStudyName() {
  var props = PropertiesService.getScriptProperties();
  var key = String(props.getProperty(CHART_KEY_PROPERTY) || '').trim();
  if (!key) throw new Error('尚未設定 ' + CHART_KEY_PROPERTY);

  var candidates = [
    'Moving Average Exponential',   // TradingView 內建指標的實際顯示名稱
    'Exponential Moving Average',   // 文件寫的（已知回 422，留著當對照組）
    'EMA',
    'Moving Average',
    'MA Exponential'
  ];

  var winner = null;
  for (var i = 0; i < candidates.length; i++) {
    var name = candidates[i];
    var body = {
      symbol: 'OKX:BTCUSDT.P',
      interval: '15m',
      theme: 'dark',
      width: 400,
      height: 300,
      studies: [{ name: name, input: { in_0: 144, in_1: 'close' } }]
    };
    var res = UrlFetchApp.fetch(CHART_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 200) {
      console.log('✓ 「' + name + '」→ 200，可用');
      if (!winner) winner = name;
    } else {
      console.log('✗ 「' + name + '」→ ' + code + '：' +
        truncate_(res.getContentText(), 200));
    }
    Utilities.sleep(1200);          // BASIC 限每秒 1 次
  }

  if (!winner) {
    console.log('\n五個候選全被拒。請把上面每一行完整貼回來 —— ' +
      '錯誤訊息的差異會指出正確寫法（例如它可能要求 input 用別的欄位名）。');
  } else {
    console.log('\n把 emaStudy_ 裡的 name 改成：' + winner);
  }
  return winner;
}

/**
 * 【探測】找出關掉左上角圖例文字的正確開關。
 *
 * 跟 in_0 是同一類問題：寫錯了不會報錯，只是安靜地不生效。
 * 所以一樣用 MD5 比對 —— 圖變了才算數。
 *
 * 同時測兩種掛法（override.X 與 override.style.X），
 * 因為蠟燭顏色是掛在 override.style 底下的，不能假設圖例也一樣。
 */
function probeLegendOptions() {
  // 前三個是「指標標題與參數」層級 —— 你要關的那一行屬於這裡。
  // 後面幾個是整體圖例層級，會連左上角的代碼與 OHLC 一起關掉。
  chartProbe_([
    ['showStudyTitles',        { showStudyTitles: false }],
    ['showStudyArguments',     { showStudyArguments: false }],
    ['showStudyValues',        { showStudyValues: false }],
    ['style.paneProperties.legendProperties.showStudyTitles',
      { style: { 'paneProperties.legendProperties.showStudyTitles': false } }],
    ['showStudyLastValue',     { showStudyLastValue: false }],
    ['showLegendValues',       { showLegendValues: false }],
    ['showLegend（會連代碼一起關）', { showLegend: false }]
  ]);
}

/**
 * 【探測 · 第二輪】目標很具體：EMA 字樣消失、幣種代碼留著。
 *
 * 兩條路線同時試：
 *   A. 細粒度開關 —— 只關指標那幾行，圖例其餘保留
 *   B. showLegend 全關 + 把代碼用浮水印放回背景
 *      （TradingView 原本就有這個浮水印，只是預設關著）
 *
 * B 路線如果成立，視覺上會比 A 更乾淨 —— 代碼在背景淡淡地放著，
 * 不會跟價格軸搶注意力。
 */
function probeLegendOptions2() {
  chartProbe_([
    ['A1 只關指標標題＋參數',
      { showStudyTitles: false, showStudyArguments: false }],
    ['A2 關指標數值＋末值',
      { showStudyValues: false, showStudyLastValue: false }],
    ['A3 關 OHLC 與漲跌（代碼應留著）',
      { showSeriesOHLC: false, showBarChange: false }],
    ['B1 全關圖例＋浮水印',
      { showLegend: false,
        style: { 'symbolWatermarkProperties.visibility': true,
                 'symbolWatermarkProperties.transparency': 85 } }],
    ['B2 全關圖例＋浮水印（更明顯）',
      { showLegend: false,
        style: { 'symbolWatermarkProperties.visibility': true,
                 'symbolWatermarkProperties.transparency': 70 } }]
  ]);
}

/**
 * 探測的共用骨架：對每個候選送一張圖，跟基準比 MD5，
 * 有變化的直接發到 Telegram。
 *
 * 為什麼一定要發圖：雜湊只能判斷「變了沒」，
 * 判斷不了「關掉的是不是你要關的那一塊」。那件事只能用眼睛。
 */
function chartProbe_(cases) {
  var props = PropertiesService.getScriptProperties();
  var key = String(props.getProperty(CHART_KEY_PROPERTY) || '').trim();
  if (!key) throw new Error('尚未設定 ' + CHART_KEY_PROPERTY);

  var shoot = function (override) {
    var body = {
      symbol: 'OKX:BTCUSDT.P', interval: '15m', theme: 'dark',
      width: 500, height: 360,
      studies: [{
        name: emaStudyName_(),
        input: { length: 144, source: 'close' }
      }]
    };
    if (override) body.override = override;
    var res = UrlFetchApp.fetch(CHART_ENDPOINT, {
      method: 'post', contentType: 'application/json',
      headers: { 'x-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      return { err: res.getResponseCode() + '：' + truncate_(res.getContentText(), 150) };
    }
    var blob = res.getBlob();
    var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, blob.getBytes());
    return {
      blob: blob,
      hash: d.map(function (b) {
        return ((b & 0xFF) + 0x100).toString(16).slice(1);
      }).join('')
    };
  };

  var base = shoot(null);
  if (base.err) throw new Error('基準圖失敗：' + base.err);
  console.log('基準（圖例全開）：' + base.hash.slice(0, 12));
  Utilities.sleep(1200);

  // 有變化的直接發到 Telegram —— 雜湊只能判斷「變了沒」，
  // 判斷不了「關掉的是不是你要關的那一塊」。那件事只能用眼睛。
  var cfg = getConfig_();
  var hits = 0;
  for (var i = 0; i < cases.length; i++) {
    var r = shoot(cases[i][1]);
    if (r.err) {
      console.log('✗ ' + cases[i][0] + ' → ' + r.err);
    } else if (r.hash === base.hash) {
      console.log('✗ ' + cases[i][0] + ' → 圖沒變，此開關無效');
    } else {
      hits++;
      console.log('✓ ' + cases[i][0] + ' → 圖變了，已發到 Telegram');
      tgSendPhoto_(cfg.allowedChatId,
        r.blob.setName('legend-' + i + '.png'),
        '【' + (i + 1) + '】' + cases[i][0] + '\n左上角剩下什麼？', null);
    }
    Utilities.sleep(1200);
  }

  if (!hits) {
    console.log('\n這一輪的開關全都沒作用。把日誌貼回來 —— ' +
      '可能要改用別的結構（例如 studies[].override）。');
  } else {
    console.log('\nTelegram 裡有 ' + hits + ' 張圖。挑出左上角符合你要求的那張，' +
      '把編號告訴我，我把對應設定寫成預設。');
  }
}

/**
 * 【探測】驗證 EMA 的長度參數真的有吃進去。
 *
 * 為什麼需要這支：CHART-IMG 對未知的 input 欄位不報錯，
 * 直接忽略、用預設值畫。狀態碼 200、圖也有，只有線是錯的 ——
 * 這種錯不看圖抓不到，而看圖是人工的、會漏。
 *
 * 做法：先畫一張不帶 input 的（＝預設長度 9）當基準，
 * 再把各種欄位寫法各畫一張，比對圖片的 MD5。
 * 雜湊不同 ⇒ 長度真的被改了；雜湊相同 ⇒ 這個欄位名被忽略了。
 *
 * 用 400 長度而非 144，是為了讓差異一定大到會反映在圖上 ——
 * 若長度只差一點，兩張圖可能近乎相同，比對就失去意義。
 */
/**
 * 找出「水平線文字顏色」在 CHART-IMG 裡真正的欄位名稱。
 *
 * 【為什麼要探測，不能查文件】
 * 因為這個專案已經被同一件事咬過一次：EMA 的長度欄位，文件寫 in_0，
 * 實際是 length，而填 in_0 時 API 回 200、圖照出、線用預設長度 9 畫。
 * 狀態碼分辨不出「接受了」和「安靜地忽略了」。
 *
 * 所以判準是圖的 MD5：
 *   422        欄位被拒絕 → 名字錯
 *   200 且同雜湊  欄位被忽略 → 名字錯（最危險的一種，看狀態碼會以為成功）
 *   200 且不同雜湊 圖真的變了 → 就是它
 *
 * 用黑白兩色各畫一次來比對：如果欄位有效，兩張圖必定不同；
 * 只畫一次的話無從分辨「生效了」與「本來就長這樣」。
 */
function probeLevelTextColor() {
  var props = PropertiesService.getScriptProperties();
  var key = String(props.getProperty(CHART_KEY_PROPERTY) || '').trim();
  if (!key) throw new Error('尚未設定 ' + CHART_KEY_PROPERTY);

  var shoot = function (extra) {
    var ov = { lineWidth: 2, lineColor: 'rgb(120,120,130)', showLabel: true };
    for (var k in extra) if (extra.hasOwnProperty(k)) ov[k] = extra[k];
    var res = UrlFetchApp.fetch(CHART_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key },
      payload: JSON.stringify({
        symbol: 'OKX:BTCUSDT.P', interval: '1h', theme: 'dark',
        width: 500, height: 360,
        drawings: [{
          name: 'Horizontal Line',
          input: { price: 84000, text: 'PROBE 84000' },
          override: ov
        }]
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      return { err: res.getResponseCode() + '：' + truncate_(res.getContentText(), 160) };
    }
    var d = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, res.getBlob().getBytes());
    return { hash: d.map(function (b) {
      return ((b & 0xFF) + 0x100).toString(16).slice(1);
    }).join('') };
  };

  var candidates = [
    'textColor', 'textcolor', 'labelTextColor',
    'color', 'labelColor', 'textColour'
  ];

  console.log('探測「水平線文字顏色」的欄位名稱');
  console.log('判準：黑白兩色畫出來的圖，雜湊必須不同\n');

  var winner = null;
  for (var i = 0; i < candidates.length; i++) {
    var name = candidates[i];
    var o1 = {}; o1[name] = 'rgb(255,255,255)';
    var o2 = {}; o2[name] = 'rgb(0,0,0)';

    var white = shoot(o1);
    Utilities.sleep(400);
    if (white.err) { console.log('✗ ' + name + ' → 被拒絕：' + white.err); continue; }

    var black = shoot(o2);
    Utilities.sleep(400);
    if (black.err) { console.log('✗ ' + name + ' → 被拒絕：' + black.err); continue; }

    if (white.hash === black.hash) {
      console.log('✗ ' + name + ' → 回 200 但黑白兩張一模一樣，欄位被忽略');
    } else {
      console.log('✓ ' + name + ' → 圖真的變了，就是這個');
      if (!winner) winner = name;
    }
  }

  console.log('');
  if (winner) {
    console.log('把這兩個指令碼屬性設起來：');
    console.log('  CHART_LEVEL_TEXT_FIELD   = ' + winner);
    console.log('  CHART_LEVEL_TEXT_COLORS  = entry:#FFFFFF');
  } else {
    console.log('沒有一個候選有效 —— 代表 CHART-IMG 的水平線不支援');
    console.log('獨立的文字顏色，文字顏色是跟著 lineColor 走的。');
    console.log('那就改用 CHART_LEVEL_COLORS = entry:#FFFFFF，');
    console.log('線和字會一起變白。');
  }
}

function probeEmaInputShape() {
  var props = PropertiesService.getScriptProperties();
  var key = String(props.getProperty(CHART_KEY_PROPERTY) || '').trim();
  if (!key) throw new Error('尚未設定 ' + CHART_KEY_PROPERTY);

  var shoot = function (input) {
    var study = { name: emaStudyName_() };
    if (input) study.input = input;
    var res = UrlFetchApp.fetch(CHART_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key },
      payload: JSON.stringify({
        symbol: 'OKX:BTCUSDT.P', interval: '1h', theme: 'dark',
        width: 400, height: 300, studies: [study]
      }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      return { err: res.getResponseCode() + '：' + truncate_(res.getContentText(), 150) };
    }
    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, res.getBlob().getBytes());
    return { hash: digest.map(function (b) {
      return ((b & 0xFF) + 0x100).toString(16).slice(1);
    }).join('') };
  };

  var base = shoot(null);
  if (base.err) throw new Error('基準圖失敗：' + base.err);
  console.log('基準（不帶 input，長度 9）：' + base.hash.slice(0, 12));
  Utilities.sleep(1200);

  var cases = [
    ['length / source', { length: 400, source: 'close' }],
    ['只有 length',     { length: 400 }],
    ['in_0 / in_1',     { in_0: 400, in_1: 'close' }]
  ];
  var winner = null;
  for (var i = 0; i < cases.length; i++) {
    var r = shoot(cases[i][1]);
    if (r.err) {
      console.log('✗ ' + cases[i][0] + ' → ' + r.err);
    } else if (r.hash === base.hash) {
      console.log('✗ ' + cases[i][0] + ' → 與基準圖完全相同，參數被忽略');
    } else {
      console.log('✓ ' + cases[i][0] + ' → ' + r.hash.slice(0, 12) + '，長度有生效');
      if (!winner) winner = cases[i][0];
    }
    Utilities.sleep(1200);
  }

  if (!winner) {
    console.log('\n三種寫法都被忽略。把這幾行貼回來 —— ' +
      '可能要改用 override 或不同的參數結構。');
  } else {
    console.log('\n可用寫法：' + winner + '（程式目前用的就是這個）');
  }
  return winner;
}

/**
 * 【EMA 試畫】用 BASIC 的 3 個額度全部畫均線，不畫水平線。
 *
 * 這一張是拿來「決定要不要升級方案」的，不是最終樣式：
 * 額度只有 3，七條裡只能挑三條。挑 144/169（小通道）＋576（大通道上緣），
 * 因為這三條決定了你圖上最主要的視覺結構 ——
 * 若這三條的顏色與粗細看起來對了，七條全開就會像你那張截圖。
 *
 * 跑完去 Telegram 看圖，再回頭決定要不要升 MEGA。
 */
function testChartEmaPreview() {
  var props = PropertiesService.getScriptProperties();
  if (!String(props.getProperty(CHART_KEY_PROPERTY) || '').trim()) {
    throw new Error('尚未設定指令碼屬性 ' + CHART_KEY_PROPERTY);
  }

  // 指定 15 分鐘：預設樣本是 1 小時，但你實際交易的是 15 分鐘與 1 小時，
  // 而通道在兩個週期上的相對位置差很多。試畫要跟實戰同週期才有判斷價值。
  var text;
  try {
    text = buildLiveSampleSignalText_({ tf: '15分鐘' });
  } catch (err) {
    console.log('⚠️ 取現價失敗（' + err.message + '），改用固定樣本。');
    text = buildSampleSignalText_({ tf: '15分鐘' });
  }
  var parsed = parseSignalToJson_(text, 'tv:emapreview' +
    Utilities.getUuid().replace(/-/g, '').slice(0, 18));
  if (!parsed.ok) throw new Error('樣本解析失敗：' + parsed.errors.join('；'));

  // 【這裡曾經把 3 寫死】
  // 舊版本固定挑前三條 EMA、固定 maxParams=3、固定關掉水平線，
  // 於是不管 CHART_MAX_PARAMS 設成多少，試畫永遠只有三條 ——
  // 而它是使用者唯一用來驗證那個設定的工具。
  //
  // 一個「不會反映設定」的驗證工具，比沒有驗證工具更糟：
  // 它會讓人以為設定沒生效而跑去改別的地方。
  //
  // 現在完全照正式圖卡的路徑走，只差在用樣本訊號而非真訊號。
  var opts = chartOptions_(props);
  var req = buildChartRequest_(parsed.payload, opts);

  var drawCount = (req.drawings || []).length;
  var studyCount = (req.studies || []).length;
  var lens = (req.studies || []).map(function (st) { return st.input.length; });
  var levels = (req.drawings || []).map(function (d) {
    return String(d.input.text).split(' ')[0];
  });

  console.log('額度設定：' + opts.maxParams + '（CHART_MAX_PARAMS）');
  console.log('實際用量：水平線 ' + drawCount + ' + 均線 ' + studyCount
    + ' = ' + (drawCount + studyCount));
  console.log('均線：' + (lens.join('、') || '（無）'));
  console.log('水平線：' + (levels.join('、') || '（無，CHART_SHOW_LEVELS 未開）'));
  console.log('尺寸：' + req.width + '×' + req.height);

  var key = String(props.getProperty(CHART_KEY_PROPERTY) || '').trim();
  var started = Date.now();
  var res = UrlFetchApp.fetch(CHART_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key },
    payload: JSON.stringify(req),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('CHART-IMG 回 ' + res.getResponseCode() + '：' +
      truncate_(res.getContentText(), 300) +
      '\n（若訊息提到 study 名稱或 input，代表內建 EMA 的欄位寫法要調整，' +
      '把這段完整貼給我。）');
  }

  var blob = res.getBlob().setName('ema-preview.png');
  console.log('取圖成功：' + blob.getBytes().length + ' 位元組，耗時 ' +
    (Date.now() - started) + ' ms');

  var cfg = getConfig_();
  // 說明文字一律從實際請求內容生成，不寫死。
  // 寫死的說明只要與實際行為分岔一次，往後每一次都會誤導。
  var labelOf = function (len) {
    for (var i = 0; i < CHART_EMA_SET.length; i++) {
      if (CHART_EMA_SET[i].len === len) return CHART_EMA_SET[i].label;
    }
    return '';
  };
  var emaLines = [];
  var seen = {};
  for (var li = 0; li < lens.length; li++) {
    var lab = labelOf(lens[li]) || '其他';
    if (!seen[lab]) { seen[lab] = []; emaLines.push(lab); }
    seen[lab].push(lens[li]);
  }
  var caption = '🧪 圖表試畫（' + studyCount + '／' + CHART_EMA_SET.length + ' 條均線）\n';
  for (var ci = 0; ci < emaLines.length; ci++) {
    caption += 'EMA ' + seen[emaLines[ci]].join(' ／ ') + '：' + emaLines[ci] + '\n';
  }
  caption += '水平線：' + (levels.join('、') || '未開啟（CHART_SHOW_LEVELS）') + '\n';
  caption += '尺寸 ' + req.width + '×' + req.height
    + '｜額度用量 ' + (drawCount + studyCount) + '／' + opts.maxParams + '\n\n';
  if (studyCount < CHART_EMA_SET.length) {
    caption += '⚠️ 均線沒全開。額度是 ' + opts.maxParams
      + '，七條全開加三條水平線需要 10（MEGA 方案）。\n';
  }
  caption += '對照你 TradingView 的圖看：線的位置對不對、顏色要不要調。';

  var sent = tgSendPhoto_(cfg.allowedChatId, blob, caption, null);
  if (!sent) throw new Error('圖片取得成功，但 Telegram 發送失敗。');
  console.log('已送到 Telegram。');
}

/** 不連網的請求內容檢查：驗證代碼、週期與水平線、均線的排序都組對了。 */
function testChartRequestShape() {
  var parsed = parseSignalToJson_(
    buildSampleSignalText_({ tf: '15分鐘' }), 'tv:' + new Array(60).join('a'));
  if (!parsed.ok) throw new Error(parsed.errors.join('；'));

  // v3.4：明確帶 noDrawings:false 與 levelSet。水平線改由 levelSet 挑選、
  // 並排在均線前面之後，舊版測試（假設 ENTRY→SL→EMA144→TP1 的交錯排序、
  // 且不帶 levelSet）就一直跑不過了。這支測的是「價位線開啟時」的排序，
  // 不受屬性 CHART_SHOW_LEVELS／CHART_LEVEL_SET 目前設成什麼影響。
  var LV = ['entry', 'sl', 'tp1'];
  var req = buildChartRequest_(parsed.payload,
    { exchange: 'OKX', noDrawings: false, levelSet: LV });

  var fails = [];
  function ck(name, cond) { if (!cond) fails.push(name); }

  ck('代碼應為 OKX:BTCUSDT.P', req.symbol === 'OKX:BTCUSDT.P');
  ck('15 分鐘應轉成 15m', req.interval === '15m');
  // 預設是「原樣」：不畫價位線，額度全給均線。
  var plain = buildChartRequest_(parsed.payload,
    { exchange: 'OKX', noDrawings: true, maxParams: 3 });
  ck('預設不畫價位線', plain.drawings.length === 0);
  ck('預設是 144/169/576', plain.studies.length === 3 &&
    plain.studies[0].input.length === 144 &&
    plain.studies[2].input.length === 576);

  // 圖例開關掛在 override 第一層，不能弄壞 style
  var hid = buildChartRequest_(parsed.payload,
    { exchange: 'OKX', noDrawings: true, hideLegendKeys: ['showStudyLastValue'] });
  ck('圖例開關寫進 override', hid.override.showStudyLastValue === false);
  ck('圖例開關不影響蠟燭配色', Object.keys(hid.override.style).length === 6);

  // 打開水平線之後（BASIC 額度 3）：選到的水平線排在均線前面，三條就用完額度。
  ck('BASIC 下應有三條水平線', req.drawings.length === 3);
  ck('第一條是 ENTRY', req.drawings[0].input.price === parsed.payload.entry);
  ck('第二條是 SL', req.drawings[1].input.price === parsed.payload.sl);
  ck('第三條是 TP1', req.drawings[2].input.price === parsed.payload.tp[0]);
  ck('SL 應為止損色', req.drawings[1].override.lineColor === LEVEL_COLOR_SL);
  ck('BASIC 下額度被水平線用完，沒有均線', !req.studies);
  ck('時區應取自訊號的 [時區]', req.timezone === 'Asia/Taipei');
  ck('六個蠟燭顏色欄位都要設', Object.keys(req.override.style).length === 6);
  ck('漲色套用到實體、邊框與影線',
    req.override.style['candleStyle.upColor'] === req.override.style['candleStyle.wickUpColor']
    && req.override.style['candleStyle.upColor'] === req.override.style['candleStyle.borderUpColor']);
  // override 不計入 Max Parameter：六個顏色欄位都在，額度仍只用了 3
  ck('override 不佔用額度',
    req.drawings.length + (req.studies ? req.studies.length : 0) === 3 &&
    Object.keys(req.override.style).length === 6);

  // EMA 模式：額度必須被夾住，不能靠「應該不會超過」
  var ema = buildChartRequest_(parsed.payload,
    { exchange: 'OKX', emaSet: CHART_EMA_SET, noDrawings: true, maxParams: 3 });
  ck('EMA 模式不畫水平線', ema.drawings.length === 0);
  ck('七條被夾成三條', ema.studies.length === 3);
  ck('EMA 長度對應指標', ema.studies[0].input.length === 144 &&
    ema.studies[1].input.length === 169);
  ck('EMA 來源必須是 close', ema.studies[0].input.source === 'close');
  // in_0 是舊的錯誤寫法。它不報錯、只會安靜地畫錯，所以明確擋掉。
  ck('不得再出現 in_0', !('in_0' in ema.studies[0].input));

  var mega = buildChartRequest_(parsed.payload,
    { exchange: 'OKX', maxParams: 10, levelSet: LV });
  ck('MEGA 額度下三線七均線全上', mega.drawings.length === 3 && mega.studies.length === 7);

  // PRO（額度 5）：三條水平線之後，小通道兩條補上。
  var pro = buildChartRequest_(parsed.payload,
    { exchange: 'OKX', maxParams: 5, levelSet: LV });
  ck('PRO 下三條水平線都在', pro.drawings.length === 3 &&
    pro.drawings[2].input.price === parsed.payload.tp[0]);
  ck('PRO 下小通道補完整', pro.studies && pro.studies.length === 2 &&
    pro.studies[1].input.length === 169);

  // 額度極小時也不能爆：優先序保證留下的是 ENTRY
  var one = buildChartRequest_(parsed.payload,
    { exchange: 'OKX', maxParams: 1, levelSet: LV });
  ck('額度 1 時只留 ENTRY', one.drawings.length === 1 && !one.studies &&
    one.drawings[0].input.text.indexOf('ENTRY') !== -1);

  ck('免費方案每次上限 3 個物件',
    req.drawings.length + (req.studies ? req.studies.length : 0) <= 3);
  ck('寬度不超過方案上限 ' + CHART_WIDTH_MAX, req.width <= CHART_WIDTH_MAX);

  // 週期轉換
  ck('60 → 1h', chartInterval_('60') === '1h');
  ck('240 → 4h', chartInterval_('240') === '4h');
  ck('1440 → 1D', chartInterval_('1440') === '1D');
  ck('5 → 5m', chartInterval_('5') === '5m');

  if (fails.length) throw new Error('請求內容檢查失敗：\n  - ' + fails.join('\n  - '));
  console.log('請求內容檢查通過：\n' + JSON.stringify(req, null, 2));
}

/** 產出一張範例卡片的文字，用來目視確認排版。不會送出。 */
function testRenderPendingCard() {
  // 樣本刻意用「88 分但只有標準級」這個組合 —— 那正是 [降級] 欄位存在的理由。
  var parsed = parseSignalToJson_(
    buildSampleSignalText_({ grade: '標準', score: '88（降級：觸碰過多）' }),
    'tv:' + new Array(65).join('a'));
  if (!parsed.ok) throw new Error(parsed.errors.join('；'));
  if (parsed.payload.sig_id.length !== SIG_ID_LENGTH) {
    throw new Error('sig_id 長度應為 ' + SIG_ID_LENGTH +
      '，實際 ' + parsed.payload.sig_id.length);
  }
  // 帶一則權益說明與自動槓桿欄位：前者 v3.4 之前會漏進廣播版，
  // 後者（[保證金]、原槓桿）同樣是帳戶專屬資訊，一起守。
  var sample = {
    decision: 'pending', dryRun: true,
    sizing: { orderQty: 12.9, unit: 'contracts', actualRiskUsdt: 49.7553,
      riskAmountUsdt: 50, notionalUsdt: 11016.2775,
      leverage: 20, baseLeverage: 40, leverageNote: '強平緩衝',
      targetMarginUsdt: 150, baseMarginUsdt: 100 },
    equity: { note: '權益查詢失敗，改用設定值 10000 USDT' }
  };
  var text = renderPendingCard_(parsed.payload, sample);
  console.log('【私訊版】');
  console.log(text);

  // 廣播版必須通過「一個帳戶數字都不能有」的檢查。
  // 這是整個群組功能唯一真正危險的地方：漏掉一個欄位，
  // 群組裡的人就能從倉位大小反推出你的帳戶規模。
  var bc = renderPendingCard_(parsed.payload, sample, null, true);
  console.log('\n【廣播版】');
  console.log(bc);

  var banned = ['[風險]', '[名目]', '[數量]', '[保證金]', '49.75', '11016', '12.9',
    '槓桿', '權益', '10000'];
  for (var i = 0; i < banned.length; i++) {
    if (bc.indexOf(banned[i]) !== -1) {
      throw new Error('廣播版外洩了帳戶資訊：' + banned[i]);
    }
  }
  var required = ['[幣種]', '[週期]', '[品質]', '[價格]', '[止損]'];
  for (var j = 0; j < required.length; j++) {
    if (bc.indexOf(required[j]) === -1) {
      throw new Error('廣播版少了訊號欄位：' + required[j]);
    }
  }
  if (text.indexOf('權益') === -1) {
    throw new Error('私訊版應保留權益說明');
  }
  if (text.indexOf('[保證金] 150 USDT') === -1 || text.indexOf('自動，原 40x') === -1) {
    throw new Error('私訊版應顯示自動槓桿與保證金調整');
  }
  console.log('\n✓ 廣播版檢查通過：無帳戶數字、無權益說明、訊號欄位齊全');

  console.log('\n按鈕 callback_data：');
  console.log('  ' + CB_CONFIRM + parsed.payload.sig_id);
  console.log('  ' + CB_SKIP + parsed.payload.sig_id);
  console.log('  ' + CB_DAILY_ASK + '（長度 ' + CB_DAILY_ASK.length + '）');
}
