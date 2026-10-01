/**
 * 維加斯通道＋QQE 快訊機器人
 * 第 3.5 批（對應指標 v11.8 以上；須搭配 Executor.gs 第 3.4 批）
 *
 * 【第 3.5 批是兩條分支的合併】
 * 這份檔案曾在兩個不同的對話裡各自演進：
 *   A 分支（本機 repo apps-script/、另一個對話）：webhook_received 只寫 console、
 *     斜線指令修正（/日損 與 日損 都通）；但沒有訊號群組與話題。
 *   B 分支（第 3.1～3.4 批）：SIGNAL_CHAT_ID／SIGNAL_THREAD_ID 話題群組、
 *     checkChatIds、群組補送。
 * 兩邊的功能全部保留。從這一版起，以這一份為唯一版本。
 *
 * 第 3.4 批 → 第 3.5 批：
 * 【合併】A 分支的 logConsoleOnly_、normalizeTelegramCommand_ 脫斜線、isCommand_。
 * 【修正】原始訊號補送改為私訊與群組各自判斷，兩邊都保證送得到：
 *          卡片沒送出           → 補送原始訊號到私訊
 *          有設群組且廣播沒送出 → 補送原始訊號到群組
 *        （3.4 有設群組時，執行層離線私訊就收不到；A 分支則是群組會漏。）
 * 【修正】補送佇列記錄「哪幾個目的地沒送到」，只補那幾個，不再重送已送到的一邊。
 *        舊版沒有這個欄位的補送紀錄，沿用原本的 sendSignalMessage_ 行為。
 *
 * 第 3.3 批 → 第 3.4 批：
 * 【修正】群組補送邏輯。原本只看 cardSent：卡片送出就不送原始訊號。
 *        但卡片是私訊，群組靠的是 Executor.gs 的廣播 —— 廣播失敗時，
 *        群組就什麼都收不到。現在分開判斷：
 *          有設群組：廣播沒送出（broadcastSent=false）才補送原始訊號到群組
 *          沒設群組：卡片沒送出（cardSent=false）才補送原始訊號到私訊
 * 【整理】日誌的 via 欄位分開記錄私訊與群組各走哪條路；延遲說明更新為 Zeabur 實測值。
 *
 * 第 3.2 批 → 第 3.3 批：
 * 【修正】陌生聊天室 /id 的回覆改為提示 SIGNAL_CHAT_ID，話題群組另附話題 ID 與
 *        SIGNAL_THREAD_ID 說明。（Executor.gs 原本讀 BROADCAST_CHAT_ID，
 *        第 3.4 批起兩個檔案統一讀 SIGNAL_CHAT_ID。）
 * 【新增】checkChatIds()：以 getChat 檢查 BROADCAST_CHAT_ID 與 SIGNAL_CHAT_ID
 *        的實際狀態（群組類型、名稱、是否開話題、是否已升級為超級群組），
 *        用來確認 BROADCAST_CHAT_ID 是否為可刪除的舊 ID。
 * 【整理】指令碼屬性清單補上 SIGNAL_CHAT_ID／SIGNAL_THREAD_ID；
 *        移除一段沒有對應函式的孤立註解；修正 debugSignalThread 的說明。
 *
 * 第 2.5 批 → 第 3 批 修正重點：
 * 【P1-A】驗證通過後才寫入系統日誌；被拒絕的請求只記 console，並以
 *        CacheService 彙總，每 10 分鐘最多寫 1 筆，避免未授權請求灌爆
 *        指令碼屬性（約 500 KB，與去重／暫停狀態共用）。
 * 【P1-B】Telegram 傳送失敗的交易訊號不再遺失：寫入補送佇列，由每分鐘
 *        觸發器以指數退避補送（1→2→4…最多 30 分鐘間隔，最多 10 次、
 *        最長 6 小時），補送訊息標註「延遲送達」。
 * 【P1-C】系統日誌暫存佇列設上限 200 筆，超過只寫入執行記錄。
 * 【P2-D】Claude 問答附上最近 5 筆交易訊號作為上下文。
 * 【P2-E】System prompt 依指標 v11.8 實際邏輯更新。
 * 【P2-F】Telegram 先驗證聊天室，再做 update_id 去重。
 * 【P3-G】Webhook 回應改用 ContentService 純文字。
 * 【P3-H】日誌遮蔽新增 Anthropic 金鑰（sk-ant-…）。
 * 【P3-I】系統日誌工作表保留最近 5,000 列，超過自動刪除最舊資料。
 * 【P3-J】觸發器維持每分鐘，但無待辦事項時直接結束（僅讀一次快取），
 *        每 15 分鐘做一次完整掃描作為快取遺失的保險。
 *
 * 第 3.1 批 → 第 3.2 批：
 * 【新增】allowed_updates 加入 callback_query，Telegram 才會送按鈕事件。
 *        改完必須重新執行一次 setupTelegramWebhook()，否則設定不會生效。
 * 【新增】handleTelegramMessage_ 開頭分流 callback_query 到 Executor.gs。
 *
 * 第 3 批 → 第 3.1 批：
 * 【新增】handleTradingViewSignal_ 內加入 forwardToExecutor_ 呼叫，
 *        位置在 sendTelegramMessage_ 之前（理由見該處註解）。
 *        需搭配 Executor.gs；未安裝時以 typeof 檢查略過，不影響既有功能。
 *
 * 相容性：觸發器處理函式名稱仍為 flushSystemLogs，指令碼屬性名稱不變，
 * 貼上後以「管理部署作業 → 編輯 → 新版本」發布即可，網址不變。
 *
 * 請先在「Apps Script → 專案設定 → 指令碼屬性」建立：
 * - TG_TOKEN
 * - ALLOWED_CHAT_ID（你自己的私訊；按鈕與指令只在這裡生效，不要填群組）
 * - ANTHROPIC_API_KEY（選填；僅供 Telegram 問答使用）
 * - TRADINGVIEW_WEBHOOK_SECRET
 * - TELEGRAM_WEBHOOK_SECRET
 * - WEBAPP_URL
 * - SIGNAL_CHAT_ID（選填；訊號廣播群組，未設定時訊號送到 ALLOWED_CHAT_ID）
 * - SIGNAL_THREAD_ID（選填；話題群組中訊號要進的話題 ID）
 * - SYSTEM_LOG_SPREADSHEET_ID（選填；未設定時使用程式內預設值）
 *
 * 不要把任何 Token 或密鑰直接寫進這個檔案。
 */

const STRATEGY_SYSTEM_PROMPT = [
  "你是「維加斯通道＋QQE 訊號系統」（TradingView 指標 v11.8）的交易助理。",
  "【結構】EMA 144/169 為小通道、EMA 576/676 為大通道、EMA 12 為過濾線、EMA 250/288 為過濾通道。",
  "【正式訊號六道必要閘門】小通道排列同向；收盤位於過濾線同側；QQE 出現該段動能第一根同向色柱；N 根內回踩小通道；未處於纏繞盤整；大通道方向與大小通道距離成立。訊號另標註測試型或貫穿型。",
  "【過濾通道】訊號 K 棒價格與 EMA 250/288 相交時，改列觀察型態，不給品質分級。",
  "【品質】七項計分共 100 分：乾淨插針拒絕 20、通道斜率 15、脫離通道 15、大小通道距離 15、觸碰次數少 10、近期無反向訊號 10、無 RSI+MACD 共同背離 15。預設 80 分以上為高品質、55 分以上為標準，其餘為弱訊；觸碰過多或近期出現反向訊號各降一級。",
  "【進場管理】ENTRY 為訊號 K 棒收盤價；SL 預設為近期波段高低點加 ATR 緩衝；TP1/TP2/TP3 依序為 1R/2R/3R。策略建議週期 15M–1H；連續止損 3 單應暫停交易。",
  "回答請用繁體中文，簡潔專業，以 2–4 句為主，避免空泛免責聲明與贅詞。若問題涉及使用者訊息中附上的最近訊號，請直接引用其數值分析；沒有提供的資料不要臆測。"
].join("\n");

const REQUIRED_PROPERTIES = [
  "TG_TOKEN",
  "ALLOWED_CHAT_ID",
  "TRADINGVIEW_WEBHOOK_SECRET",
  "TELEGRAM_WEBHOOK_SECRET",
  "WEBAPP_URL"
];

const HTTP_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];
const SIGNAL_DEDUP_TTL_SECONDS = 1800;
const MAX_TELEGRAM_CHUNK_LENGTH = 3800;
const CACHE_MAX_TTL_SECONDS = 21600;

// 系統日誌
const DEFAULT_SYSTEM_LOG_SPREADSHEET_ID = "1LTbDKWHk36_99MXt9waHUMrjvADqhqWxX9VP4MHkzG0";
const SYSTEM_LOG_SHEET_NAME = "系統日誌";
const SYSTEM_LOG_PROPERTY_PREFIX = "SYSLOG_";
const SYSTEM_LOG_HEADERS = [
  "時間", "等級", "來源", "事件", "說明", "耗時(ms)", "事件ID"
];
const SYSTEM_LOG_BATCH_SIZE = 100;
const SYSTEM_LOG_QUEUE_MAX = 200;
const SYSTEM_LOG_MAX_ROWS = 5000;
const SYSTEM_LOG_TRIM_SLACK = 500;
const LOG_QUEUE_COUNT_CACHE_KEY = "syslog:queued";

// 交易訊號補送佇列
const SIGNAL_RETRY_PREFIX = "TVRETRY_";
const SIGNAL_RETRY_MAX_QUEUE = 50;
const SIGNAL_RETRY_MAX_ATTEMPTS = 10;
const SIGNAL_RETRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SIGNAL_RETRY_MAX_BACKOFF_MINUTES = 30;

// Claude 問答上下文
const RECENT_SIGNALS_CACHE_KEY = "tv:recent";
const RECENT_SIGNALS_MAX = 5;

// 背景維護（每分鐘觸發器）
const MAINTENANCE_FLAG_KEY = "maint:pending";
const MAINTENANCE_FULL_SCAN_KEY = "maint:fullscan";
const MAINTENANCE_FULL_SCAN_SECONDS = 900;

// 被拒絕請求的彙總
const REJECT_COUNT_CACHE_KEY = "reject:count";
const REJECT_LOGGED_CACHE_KEY = "reject:logged";
const REJECT_SUMMARY_INTERVAL_SECONDS = 600;

// ================================================================
// 設定
// ================================================================
function getConfig_() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  const missing = REQUIRED_PROPERTIES.filter(function (name) {
    return !properties[name] || !String(properties[name]).trim();
  });

  if (missing.length > 0) {
    throw new Error("缺少指令碼屬性：" + missing.join(", "));
  }

  return {
    tgToken: properties.TG_TOKEN.trim(),
    allowedChatId: properties.ALLOWED_CHAT_ID.trim(),
    anthropicApiKey: String(properties.ANTHROPIC_API_KEY || "").trim(),
    tradingViewSecret: properties.TRADINGVIEW_WEBHOOK_SECRET.trim(),
    telegramSecret: properties.TELEGRAM_WEBHOOK_SECRET.trim(),
    webAppUrl: properties.WEBAPP_URL.trim(),
    signalChatId: String(properties.SIGNAL_CHAT_ID || "").trim(),
    signalThreadId: String(properties.SIGNAL_THREAD_ID || "").trim()
  };
}

function getLogSpreadsheetId_() {
  const configured = String(
    PropertiesService.getScriptProperties().getProperty("SYSTEM_LOG_SPREADSHEET_ID") || ""
  ).trim();
  return configured || DEFAULT_SYSTEM_LOG_SPREADSHEET_ID;
}

// ================================================================
// Webhook 入口
// ================================================================

/**
 * GET 只做健康檢查，不處理訊號，避免開啟網址時誤發快訊。
 */
function doGet() {
  return textOutput_("service alive");
}

/**
 * Webhook 路由：
 * - Telegram:    ?source=telegram&key=...
 * - TradingView: ?source=tradingview&key=...
 * 只有驗證通過的請求才寫入系統日誌；被拒絕的請求改由彙總機制處理。
 */
function doPost(e) {
  const source = String((e && e.parameter && e.parameter.source) || "").toLowerCase();
  const bodyLength = String((e && e.postData && e.postData.contents) || "").length;

  try {
    const config = getConfig_();
    const requestKey = String((e && e.parameter && e.parameter.key) || "");

    if (source === "telegram") {
      if (!safeEquals_(requestKey, config.telegramSecret)) {
        noteRejectedRequest_("telegram_auth_rejected");
        return textOutput_("forbidden");
      }
      // 只進 console：這一筆回答不了任何問題 —— 它之後發生什麼事，
      // 各自都有自己的日誌（送出、拒絕、重複、失敗）。而且它排在
      // 去重「之前」，所以 Telegram 每一次重送都會記一筆，
      // 記的全是等一下就會被正確丟棄的訊息。
      logConsoleOnly_("info", "webhook_received", {
        source: "telegram", bodyLength: bodyLength });
      return handleTelegramMessage_(e, config);
    }

    if (source === "tradingview") {
      if (!safeEquals_(requestKey, config.tradingViewSecret)) {
        noteRejectedRequest_("tradingview_auth_rejected");
        return textOutput_("forbidden");
      }
      // 同上。TradingView 這條路徑每一筆最後都會落到一個明確結果
      //（signal_sent／queued_for_retry／delivery_failed／duplicate／
      // unexpected_payload），那些才是你會拿來查的。
      logConsoleOnly_("info", "webhook_received", {
        source: "tradingview", bodyLength: bodyLength });
      return handleTradingViewSignal_(e, config, "webhook");
    }

    noteRejectedRequest_(source ? "unknown_webhook_source" : "missing_webhook_source");
    return textOutput_("unknown source");
  } catch (error) {
    logEvent_("error", "webhook_failed", {
      source: source || "missing",
      message: errorMessage_(error)
    });
    return textOutput_("error");
  }
}

/**
 * 被拒絕的請求一律寫入執行記錄；系統日誌每 10 分鐘最多一筆彙總，
 * 並附上這段期間累計的拒絕次數，避免惡意請求消耗指令碼屬性配額。
 */
function noteRejectedRequest_(reason) {
  console.warn(JSON.stringify({ time: new Date().toISOString(), event: reason }));
  try {
    const cache = CacheService.getScriptCache();
    const count = Number(cache.get(REJECT_COUNT_CACHE_KEY) || 0) + 1;
    if (cache.get(REJECT_LOGGED_CACHE_KEY)) {
      cache.put(REJECT_COUNT_CACHE_KEY, String(count), CACHE_MAX_TTL_SECONDS);
      return;
    }
    cache.put(REJECT_LOGGED_CACHE_KEY, "1", REJECT_SUMMARY_INTERVAL_SECONDS);
    cache.put(REJECT_COUNT_CACHE_KEY, "0", CACHE_MAX_TTL_SECONDS);
    logEvent_("warn", "webhook_rejected", {
      source: "rejected",
      reason: reason,
      countSinceLastSummary: count
    });
  } catch (error) {
    console.warn("拒絕請求彙總失敗：" + redactLogText_(errorMessage_(error)));
  }
}

// ================================================================
// TradingView 訊號
// ================================================================
function handleTradingViewSignal_(e, config, origin) {
  const startedAtMs = Date.now();
  const via = origin || "webhook";
  const signalText = String(
    (e && e.postData && e.postData.contents) || ""
  ).trim();

  if (!signalText) {
    logEvent_("warn", "empty_tradingview_payload", { origin: via });
    return textOutput_("empty payload");
  }

  if (!isExpectedTradingViewSignal_(signalText)) {
    logEvent_("warn", "unexpected_tradingview_payload", {
      origin: via,
      bodyLength: signalText.length
    });
    return textOutput_("ignored unexpected signal");
  }

  const dedupKey = reserveSignal_(signalText);
  if (!dedupKey) {
    logEvent_("info", "duplicate_tradingview_signal_ignored", { origin: via });
    return textOutput_("duplicate");
  }

  try {
    // ── 順序很重要 ──────────────────────────────────────────────
    // 執行層必須排在 Telegram 之前，理由有三：
    //
    // 1. 若放在 sendTelegramMessage_ 之後，Telegram 一故障就會拋例外跳到
    //    catch，執行層便永遠收不到這筆訊號 —— 即使執行層完全正常。
    //    等於「下單決策被通知管道綁架」，優先順序是反的。
    // 2. forwardToExecutor_ 內部整個包在 try/catch 裡，永不拋例外，
    //    所以放在最前面不會影響 Telegram 快訊的送出。
    // 3. 兩邊各有獨立的補送佇列（TVRETRY_ 給 Telegram、EXECRETRY_ 給執行層），
    //    任一方失敗都不會拖累另一方。
    //
    // 代價是 webhook 總延遲多了執行層往返（Zeabur 約 0.5 秒），
    // 加上取圖與送卡片的時間。TradingView 可接受。
    // typeof 檢查是為了讓本檔案在「尚未安裝 Executor.gs」時也能獨立運作。
    var forwarded = { cardSent: false, broadcastSent: false };
    if (typeof forwardToExecutor_ === "function") {
      forwarded = forwardToExecutor_(signalText, dedupKey) || forwarded;
    }

    // ── 原始訊號要不要補送（v3.5）──────────────────────────────
    // 執行層正常時，私訊收到帶按鈕的卡片、群組收到 Executor.gs 的廣播版，
    // 兩者都是原始訊號的超集，不必再推原始訊號。
    //
    // 但「私訊卡片」與「群組廣播」是兩條獨立的路，各自判斷、各自補送：
    //   卡片沒送出               → 補送原始訊號到私訊
    //   有設群組且廣播沒送出     → 補送原始訊號到群組
    //
    // v3.4 有設群組時只補群組，執行層一離線私訊就什麼都收不到；
    // 另一條分支則是只補私訊，群組在廣播失敗時整則漏掉。兩邊各漏一半，
    // 合併後兩條路都保證送得到。
    //
    // 群組與私訊是同一個 chat id 時視為「沒設群組」，與 Executor.gs 的
    // getBroadcastChatId_ 判斷一致，否則會在私訊裡重複推。
    const hasGroup = hasSignalGroup_(config);
    const targets = [];
    if (!forwarded.cardSent) targets.push("private");
    if (hasGroup && !forwarded.broadcastSent) targets.push("group");

    // TradingView 快訊優先：只轉送原始訊號，不等待 Claude。
    const delivery = deliverRawSignal_(signalText, targets, config);
    rememberRecentSignal_(signalText);

    // 私訊與群組各走哪條路。查「群組今天怎麼沒收到」時，看這一欄就知道。
    const viaText =
      (forwarded.cardSent ? "private_card" : "private_raw") +
      (hasGroup ? "|" + (forwarded.broadcastSent ? "group_broadcast" : "group_raw") : "");

    if (delivery.failed.length === 0) {
      logEvent_("info", "tradingview_signal_sent", {
        origin: via,
        fingerprint: dedupKey.slice(-12),
        via: viaText,
        elapsedMs: Date.now() - startedAtMs
      });
      return textOutput_("ok");
    }

    // 部分或全部原始訊號送不出去：只把「失敗的那幾個目的地」排進補送佇列，
    // 已經送到的不重送。TradingView 不會重送 webhook，這裡不補就永遠沒了。
    const queued = enqueueSignalRetry_(signalText, dedupKey, delivery.error, delivery.failed);
    const deliveredAnything = forwarded.cardSent || forwarded.broadcastSent ||
      delivery.failed.length < targets.length;
    if (!queued && !deliveredAnything) {
      CacheService.getScriptCache().remove(dedupKey);
    }
    logEvent_("error", queued ? "tradingview_signal_queued_for_retry" : "tradingview_signal_delivery_failed", {
      origin: via,
      fingerprint: dedupKey.slice(-12),
      via: viaText,
      failedTargets: delivery.failed.join(","),
      elapsedMs: Date.now() - startedAtMs,
      message: delivery.error
    });
    return textOutput_(queued ? "queued" : "error");
  } catch (error) {
    // 非預期例外（不是傳送失敗，那些在上面已處理）：保守起見兩邊都補。
    const fallbackTargets = ["private"];
    if (hasSignalGroup_(config)) fallbackTargets.push("group");
    const queued = enqueueSignalRetry_(signalText, dedupKey, errorMessage_(error), fallbackTargets);
    if (!queued) {
      CacheService.getScriptCache().remove(dedupKey);
    }
    logEvent_("error", queued ? "tradingview_signal_queued_for_retry" : "tradingview_signal_delivery_failed", {
      origin: via,
      fingerprint: dedupKey.slice(-12),
      elapsedMs: Date.now() - startedAtMs,
      message: errorMessage_(error)
    });
    return textOutput_(queued ? "queued" : "error");
  }
}

/** 有沒有設定獨立的訊號群組（與私訊相同的 chat id 不算）。 */
function hasSignalGroup_(config) {
  return Boolean(config.signalChatId) && config.signalChatId !== config.allowedChatId;
}

/**
 * 把原始訊號送到指定的目的地。永不拋例外。
 *
 * targets 可含：
 *   "private"  ALLOWED_CHAT_ID
 *   "group"    SIGNAL_CHAT_ID（＋SIGNAL_THREAD_ID 話題）
 *   "signal"   舊版補送紀錄沒有 targets 欄位時用：沿用 sendSignalMessage_ 的舊行為
 *
 * 回傳 { failed: [送失敗的目的地], error: 最後一個錯誤訊息 }。
 */
function deliverRawSignal_(text, targets, config) {
  const failed = [];
  let lastError = "";
  (targets || []).forEach(function (target) {
    try {
      if (target === "private") {
        sendTelegramMessage_(config.allowedChatId, text, config);
      } else if (target === "group") {
        sendTelegramMessage_(config.signalChatId, text, config, config.signalThreadId);
      } else {
        sendSignalMessage_(text, config);
      }
    } catch (error) {
      failed.push(target);
      lastError = errorMessage_(error);
    }
  });
  return { failed: failed, error: lastError };
}

/**
 * 格式需與指標 f_buildAlertMsg 一致：開頭標題（前 80 字內）、[幣種]、[週期]、[方向]。
 */
function isExpectedTradingViewSignal_(signalText) {
  const text = String(signalText || "");
  return text.slice(0, 80).indexOf("《維加斯訊號》交易訊號") !== -1 &&
    /\[幣種\]\s*[^\r\n]+/.test(text) &&
    /\[週期\]\s*[^\r\n]+/.test(text) &&
    /\[方向\]\s*(做多|做空)/.test(text);
}

function reserveSignal_(signalText) {
  const dedupKey = "tv:" + sha256Hex_(signalText);
  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(3000)) {
    throw new Error("無法取得訊號去重鎖，請稍後重試");
  }

  try {
    if (cache.get(dedupKey)) {
      return null;
    }
    cache.put(dedupKey, "processing", SIGNAL_DEDUP_TTL_SECONDS);
    return dedupKey;
  } finally {
    lock.releaseLock();
  }
}

// ================================================================
// 補送佇列
// ================================================================
function enqueueSignalRetry_(signalText, dedupKey, reason, targets) {
  try {
    const properties = PropertiesService.getScriptProperties();
    const pendingCount = countKeysWithPrefix_(properties.getKeys(), SIGNAL_RETRY_PREFIX);
    if (pendingCount >= SIGNAL_RETRY_MAX_QUEUE) {
      console.error("補送佇列已滿（" + SIGNAL_RETRY_MAX_QUEUE + "），本筆訊號無法排入。");
      return false;
    }
    const now = Date.now();
    const key = SIGNAL_RETRY_PREFIX + now + "_" + String(dedupKey).slice(-12);
    properties.setProperty(key, JSON.stringify({
      text: signalText,
      dedupKey: dedupKey,
      // v3.5：記下「哪幾個目的地沒送到」。補送只送這幾個 ——
      // 私訊已經收到卡片的話，就不該再收一則延遲的原始訊號。
      targets: Array.isArray(targets) && targets.length ? targets : ["signal"],
      firstFailedAt: now,
      nextAttemptAt: now,
      attempts: 1,
      lastError: truncate_(redactLogText_(reason), 200)
    }));
    markMaintenancePending_();
    return true;
  } catch (error) {
    console.error("補送佇列寫入失敗：" + redactLogText_(errorMessage_(error)));
    return false;
  }
}

/**
 * 回傳仍在等待補送的筆數。
 */
function processSignalRetries_(allProperties, config) {
  const properties = PropertiesService.getScriptProperties();
  const keys = Object.keys(allProperties).filter(function (key) {
    return key.indexOf(SIGNAL_RETRY_PREFIX) === 0;
  }).sort();
  let remaining = 0;

  keys.forEach(function (key) {
    let item;
    try {
      item = JSON.parse(allProperties[key]);
    } catch (error) {
      properties.deleteProperty(key);
      logEvent_("error", "tradingview_retry_record_corrupted", {});
      return;
    }

    const now = Date.now();
    const attempts = Number(item.attempts || 1);
    const ageMs = now - Number(item.firstFailedAt || now);
    const fingerprint = String(item.dedupKey || "").slice(-12);

    if (ageMs > SIGNAL_RETRY_MAX_AGE_MS || attempts >= SIGNAL_RETRY_MAX_ATTEMPTS) {
      properties.deleteProperty(key);
      logEvent_("error", "tradingview_signal_dropped", {
        fingerprint: fingerprint,
        attempts: attempts,
        ageMinutes: Math.round(ageMs / 60000),
        lastError: item.lastError || ""
      });
      return;
    }

    if (now < Number(item.nextAttemptAt || 0)) {
      remaining += 1;
      return;
    }

    const delayMinutes = Math.max(1, Math.round(ageMs / 60000));
    const delayedText = "⏱ 延遲送達（首次傳送失敗，約晚 " + delayMinutes + " 分鐘補送）\n" + item.text;
    // 舊版紀錄沒有 targets：沿用舊行為（sendSignalMessage_）。
    const targets = Array.isArray(item.targets) && item.targets.length ? item.targets : ["signal"];
    const result = deliverRawSignal_(delayedText, targets, config);

    if (result.failed.length === 0) {
      properties.deleteProperty(key);
      rememberRecentSignal_(item.text);
      logEvent_("info", "tradingview_signal_retry_sent", {
        fingerprint: fingerprint,
        attempts: attempts + 1,
        delayMinutes: delayMinutes,
        targets: targets.join(",")
      });
    } else {
      // 只留下還沒送到的目的地；已送到的那邊下一輪不再重送。
      const backoffMinutes = Math.min(Math.pow(2, attempts - 1), SIGNAL_RETRY_MAX_BACKOFF_MINUTES);
      item.targets = result.failed;
      item.attempts = attempts + 1;
      item.nextAttemptAt = now + backoffMinutes * 60000;
      item.lastError = truncate_(redactLogText_(result.error), 200);
      properties.setProperty(key, JSON.stringify(item));
      remaining += 1;
      logEvent_("warn", "tradingview_signal_retry_failed", {
        fingerprint: fingerprint,
        attempts: item.attempts,
        nextRetryMinutes: backoffMinutes,
        targets: result.failed.join(",")
      });
    }
  });

  return remaining;
}

// ================================================================
// 最近訊號（供 Claude 問答上下文）
// ================================================================
function rememberRecentSignal_(signalText) {
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(2000)) {
      return;
    }
    try {
      const recent = getRecentSignals_();
      recent.unshift({
        receivedAt: Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm"),
        text: truncate_(signalText, 1500)
      });
      CacheService.getScriptCache().put(
        RECENT_SIGNALS_CACHE_KEY,
        JSON.stringify(recent.slice(0, RECENT_SIGNALS_MAX)),
        CACHE_MAX_TTL_SECONDS
      );
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.warn("最近訊號快取寫入失敗：" + redactLogText_(errorMessage_(error)));
  }
}

function getRecentSignals_() {
  const raw = CacheService.getScriptCache().get(RECENT_SIGNALS_CACHE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function buildClaudeUserContent_(userText) {
  const recent = getRecentSignals_();
  if (recent.length === 0) {
    return userText;
  }
  const blocks = recent.map(function (item, index) {
    return "#" + (index + 1) + "（收到時間 " + item.receivedAt + "）\n" + item.text;
  });
  return "<recent_signals>\n以下是最近 6 小時內收到的交易訊號（由新到舊），僅供回答參考：\n\n" +
    blocks.join("\n\n") +
    "\n</recent_signals>\n\n使用者問題：" + userText;
}

// ================================================================
// Telegram 問答
// ================================================================
function handleTelegramMessage_(e, config) {
  const raw = String(
    (e && e.postData && e.postData.contents) || ""
  );

  let update;
  try {
    update = JSON.parse(raw);
  } catch (error) {
    logEvent_("warn", "invalid_telegram_json");
    return textOutput_("invalid json");
  }

  // 按鈕點擊。Telegram 送的是 callback_query 而非 message，結構完全不同，
  // 必須在取 update.message 之前就分流出去。實際處理放在 Executor.gs，
  // 這裡只負責導向；typeof 檢查讓本檔案在未安裝 Executor.gs 時仍可運作。
  //
  // 順序與下面的訊息流程一致：先驗證聊天室（陌生來源不得寫入去重狀態），
  // 再做 update_id 去重。去重不能省 —— Telegram 在 webhook 未及時回應時
  // 會重送同一個 update，而「重送一次確認」就是「重送一次下單請求」。
  if (update && update.callback_query) {
    const cb = update.callback_query;
    const cbChatId = cb.message && cb.message.chat && cb.message.chat.id;

    if (!cbChatId || !safeEquals_(String(cbChatId), config.allowedChatId)) {
      noteRejectedRequest_("unauthorized_telegram_callback");
      return textOutput_("forbidden callback");
    }

    if (!claimTelegramUpdate_(update.update_id)) {
      if (shouldLogDuplicateUpdate_(update.update_id)) {
        logEvent_("info", "duplicate_telegram_update_ignored", {
          updateId: update.update_id,
          kind: "callback_query"
        });
      }
      // 仍要回應 Telegram，否則使用者那端的按鈕會一直轉圈。
      if (cb.id && typeof tgApi_ === "function") {
        tgApi_("answerCallbackQuery", { callback_query_id: cb.id });
      }
      return textOutput_("duplicate callback");
    }

    if (typeof handleExecutorCallback_ === "function") {
      return handleExecutorCallback_(cb, config);
    }
    logEvent_("warn", "callback_query_no_handler");
    return textOutput_("ignored callback");
  }

  const message = update && update.message;
  const chatId = message && message.chat && message.chat.id;
  const userText = message && message.text;

  if (!chatId) {
    return textOutput_("ignored update");
  }

  // 先驗證聊天室，陌生聊天室的訊息不寫入任何去重狀態。
  //
  // 【群組的例外：只有 /id】
  // 訊號群組（SIGNAL_CHAT_ID）是唯讀的，任何指令都不該在那裡生效 ——
  // 群組裡的人看得到訊號，但不該查得到我的持倉、損益或風控參數。
  //
  // 唯一放行的是 /id，因為設定訊號群組時需要知道群組的 chat id 與話題 ID，
  // 而那些值群組成員本來就取得到（把 bot 加進來的人就是我自己）。
  // 它不揭露任何額外資訊，卻是整個設定流程唯一的入口。
  if (!safeEquals_(String(chatId), config.allowedChatId)) {
    // 這裡在授權檢查「之前」，拿不到下方 command 的結果，所以自己正規化一次。
    // /id、id、/id@bot、ID、chatid 都要通。
    const probe = normalizeTelegramCommand_(userText);
    if (probe === "id" || probe === "chatid") {
      // 【這裡一定要去重，理由見 claimStrangerIdRequest_】
      // Apps Script 的 /exec 回的是 302，Telegram 不跟隨轉址，
      // 於是每一次回應在它眼裡都是投遞失敗 —— 它會一直重送同一筆 update。
      // 整個 bot 之所以行為正常，靠的就是去重把重送吃掉。
      // 任何「在去重之前就回訊息」的分支，都會變成無限洗版。
      if (!claimStrangerIdRequest_(update.update_id, chatId)) {
        return textOutput_("duplicate chat id request");
      }
      // v3.3：原本提示的 BROADCAST_CHAT_ID 從未被程式讀取，照填訊號不會進群組。
      // 實際讀取的是 SIGNAL_CHAT_ID（群組）與 SIGNAL_THREAD_ID（話題）。
      sendTelegramMessage_(chatId,
        "本聊天室的 chat id：\n" + chatId
        + (message.message_thread_id ? "\n話題 ID：\n" + message.message_thread_id : "")
        + "\n\n要設成訊號群組，把 chat id 填進指令碼屬性 SIGNAL_CHAT_ID；"
        + "若要訊號只進某個話題，再把話題 ID 填進 SIGNAL_THREAD_ID。",
        config,
        message.message_thread_id ? String(message.message_thread_id) : "");
      return textOutput_("chat id sent");
    }
    // 【這裡也要去重，理由與上面的 /id 相同】
    // 上一次我只修了 /id 那條分支，漏掉它正下方這一條 ——
    // 而陌生聊天室的訊息走的正是這裡。
    //
    // Apps Script 回的是 302，Telegram 視為投遞失敗並持續重送；
    // 沒有去重的話，同一則被拒絕的訊息會一遍遍重跑這段，
    // 把執行配額與日誌配額燒在一個「什麼都不做」的分支上。
    //
    // 注意：去重擋的是「重複做事」，擋不住 Telegram 重送本身。
    // 要讓重送停下來，得清掉 webhook 佇列
    //（resetTelegramWebhookAndDropPendingUpdates）。
    if (claimStrangerIdRequest_(update.update_id, chatId)) {
      noteRejectedRequest_("unauthorized_telegram_chat");
    }
    return textOutput_("forbidden chat");
  }

  if (message.from && message.from.is_bot) {
    return textOutput_("ignored bot message");
  }

  if (typeof userText !== "string" || !userText.trim()) {
    return textOutput_("ignored update");
  }

  // Telegram 在 Webhook 未及時完成時可能重送同一個 update。
  // 先持久記錄 update_id 再做耗時的 Claude 呼叫，避免重複消耗 API 與重複回覆。
  if (!claimTelegramUpdate_(update.update_id)) {
    if (shouldLogDuplicateUpdate_(update.update_id)) {
      logEvent_("info", "duplicate_telegram_update_ignored", {
        updateId: update.update_id,
        kind: "message"
      });
    }
    return textOutput_("duplicate update");
  }

  const command = normalizeTelegramCommand_(userText);

  if (isCommand_(command, ["停止", "暫停", "/stop", "/pause"])) {
    setTelegramPaused_(true);
    sendTelegramMessage_(
      chatId,
      "⏸ Telegram 問答已暫停。TradingView 交易快訊仍會正常推送；輸入「啟用」即可恢復問答。",
      config
    );
    return textOutput_("paused");
  }

  if (isCommand_(command, ["啟用", "啟動", "開始", "恢復", "/start", "/resume"])) {
    setTelegramPaused_(false);
    sendTelegramMessage_(chatId, "▶️ Telegram 問答已恢復。", config);
    return textOutput_("resumed");
  }

  // 持倉上限面板。實作在 Executor.gs，這裡只導向 ——
  // typeof 檢查讓本檔案在未安裝 Executor.gs 時仍可運作。
  if (isCommand_(command, ["部位", "上限", "/limit", "/limits"])) {
    if (typeof sendLimitPanel_ === "function") {
      sendLimitPanel_(config);
      return textOutput_("limit panel sent");
    }
    sendTelegramMessage_(chatId, "尚未安裝執行層橋接（Executor.gs），無法調整持倉上限。", config);
    return textOutput_("no executor");
  }

  // 日損上限面板（含重置鍵）。實作在 Executor.gs。
  if (isCommand_(command, ["日損", "重置", "/daily", "/reset"])) {
    if (typeof sendDailyPanel_ === "function") {
      sendDailyPanel_(config);
      return textOutput_("daily panel sent");
    }
    sendTelegramMessage_(chatId, "尚未安裝執行層橋接（Executor.gs），無法查看日損狀態。", config);
    return textOutput_("no executor");
  }

  // 任何聊天室都回自己的 chat id。私訊這邊一併支援，
  // 是為了讓「設定訊號群組」這件事只需要記住一個指令。
  if (isCommand_(command, ["/id", "chatid"])) {
    sendTelegramMessage_(chatId, "本聊天室的 chat id：\n" + chatId
      + "\n話題 ID（message_thread_id）：\n"
      + (message.message_thread_id ? message.message_thread_id : "無（General 或非話題群組）"), config);
    return textOutput_("chat id sent");
  }

  // 指令清單。做這個的理由很實際：功能一路加上來，
  // 而沒有人記得住一組只在對話紀錄裡出現過一次的中文指令。
  if (isCommand_(command, ["選單", "指令", "/menu", "/help", "說明"])) {
    sendTelegramMessage_(chatId, [
      "📋 可用指令",
      "─────────────",
      "日損　　查看當日損益、調整上限與冷卻、重置",
      "部位　　調整同時持倉上限",
      "狀態　　系統狀態與補送佇列",
      "/id　　　顯示本聊天室的 chat id",
      "選單　　這張清單",
      "",
      "重置鍵只在「真的被日損上限擋住」時才會出現。",
      "沒被擋住時按不到，是刻意的 —— 按不到的按鈕會養成先按再說的習慣。"
    ].join("\n"), config);
    return textOutput_("menu sent");
  }

  if (isCommand_(command, ["狀態", "/status"])) {
    const retryCount = countKeysWithPrefix_(
      PropertiesService.getScriptProperties().getKeys(), SIGNAL_RETRY_PREFIX
    );
    const statusText = (isTelegramPaused_()
      ? "ℹ️ Bot 狀態：Telegram 問答暫停；TradingView 快訊維持啟用。"
      : "ℹ️ Bot 狀態：Telegram 問答與 TradingView 快訊皆為啟用。") +
      "\n📨 最近 6 小時快取訊號：" + getRecentSignals_().length + " 筆" +
      (retryCount > 0 ? "\n⏱ 待補送訊號：" + retryCount + " 筆" : "");
    sendTelegramMessage_(chatId, statusText, config);
    return textOutput_("status sent");
  }

  if (isTelegramPaused_()) {
    logEvent_("info", "telegram_message_ignored_while_paused");
    return textOutput_("paused");
  }

  const claudeReply = askClaude_(userText.trim(), config);
  sendTelegramMessage_(chatId, claudeReply, config);
  return textOutput_("ok");
}

function askClaude_(userText, config) {
  if (!config.anthropicApiKey) {
    return "目前未啟用 AI 問答；TradingView 交易快訊仍可正常接收。";
  }

  try {
    const response = fetchWithRetry_(
      "https://api.anthropic.com/v1/messages",
      {
        method: "post",
        contentType: "application/json",
        headers: {
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01"
        },
        payload: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 500,
          system: STRATEGY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildClaudeUserContent_(userText) }]
        })
      },
      "Claude"
    );

    const data = JSON.parse(response.getContentText());
    if (data.content && data.content[0] && data.content[0].text) {
      return data.content[0].text;
    }
    throw new Error(
      data.error && data.error.message ? data.error.message : "回應缺少文字內容"
    );
  } catch (error) {
    logEvent_("error", "claude_request_failed", {
      message: errorMessage_(error)
    });
    return "（AI 解讀服務暫時無法取得，請稍後再試；交易快訊推送不受影響。）";
  }
}

/**
 * 訊號專用發送：設定了 SIGNAL_CHAT_ID 就送到該群組（可再指定話題 SIGNAL_THREAD_ID），
 * 否則維持原行為，送到 ALLOWED_CHAT_ID。
 * ALLOWED_CHAT_ID 仍是「授權聊天室」（問答、按鈕驗證用），不因此改變。
 */
function sendSignalMessage_(text, config) {
  const toGroup = !!config.signalChatId;
  sendTelegramMessage_(
    toGroup ? config.signalChatId : config.allowedChatId,
    text,
    config,
    toGroup ? config.signalThreadId : ""
  );
}

function sendTelegramMessage_(chatId, text, config, threadId) {
  const url = "https://api.telegram.org/bot" + config.tgToken + "/sendMessage";
  const chunks = splitTelegramText_(String(text), MAX_TELEGRAM_CHUNK_LENGTH);

  chunks.forEach(function (chunk, index) {
    const partPrefix = chunks.length > 1
      ? "[" + (index + 1) + "/" + chunks.length + "]\n"
      : "";
    const payload = {
      chat_id: String(chatId),
      text: partPrefix + chunk
    };
    // 話題群組：指定話題 ID 時，訊息只進該話題（未設定則維持原行為）
    if (threadId) payload.message_thread_id = String(threadId);

    const response = fetchWithRetry_(
      url,
      {
        method: "post",
        contentType: "application/x-www-form-urlencoded",
        payload: payload
      },
      "Telegram"
    );

    const data = JSON.parse(response.getContentText());
    if (!data.ok) {
      throw new Error("Telegram API 未回傳成功狀態");
    }
  });
}

/**
 * 非授權聊天室的 /id 專用節流。兩道，缺一不可。
 *
 * 【為什麼不直接用 claimTelegramUpdate_】
 * 那個函式把 update_id 寫進指令碼屬性，而屬性是有配額的共用資源。
 * 陌生聊天室的訊息量不受我控制 —— 任何人把 bot 拉進他的群組亂打，
 * 就能把那份只存 100 筆的去重清單洗掉，連帶讓「我自己的」訊息
 * 失去重複保護。所以陌生來源用快取，與正式去重完全隔離。
 *
 * 第一道（update_id）擋 Telegram 的重送；
 * 第二道（每個聊天室 60 秒一次）擋「不同 update_id 的連續洗版」——
 * 少了它，有人連打十次 /id 就是十則回覆。
 *
 * 快取條目可能被提前逐出，屆時最多多回一則；60 秒那道保證了上限。
 */
function claimStrangerIdRequest_(updateId, chatId) {
  const cache = CacheService.getScriptCache();

  if (updateId !== null && typeof updateId !== "undefined") {
    const uKey = "SIDU_" + String(updateId);
    if (cache.get(uKey)) return false;
    cache.put(uKey, "1", 3600);
  }

  const cKey = "SIDC_" + String(chatId);
  if (cache.get(cKey)) return false;
  cache.put(cKey, "1", 60);

  return true;
}

function claimTelegramUpdate_(updateId) {
  if (updateId === null || typeof updateId === "undefined") {
    logEvent_("warn", "telegram_update_without_id");
    return true;
  }

  const normalizedId = String(updateId).trim();
  if (!/^\d+$/.test(normalizedId)) {
    logEvent_("warn", "invalid_telegram_update_id");
    return false;
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    throw new Error("無法取得 Telegram update_id 鎖，請稍後重試");
  }

  try {
    const properties = PropertiesService.getScriptProperties();
    const storedValue = properties.getProperty("TELEGRAM_RECENT_UPDATE_IDS");
    let recentIds = [];

    if (storedValue) {
      try {
        const parsed = JSON.parse(storedValue);
        recentIds = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch (error) {
        logEvent_("warn", "telegram_dedup_state_reset");
      }
    }

    if (recentIds.indexOf(normalizedId) !== -1) {
      return false;
    }

    recentIds.push(normalizedId);
    if (recentIds.length > 100) {
      recentIds = recentIds.slice(recentIds.length - 100);
    }
    properties.setProperty("TELEGRAM_RECENT_UPDATE_IDS", JSON.stringify(recentIds));
    return true;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 把使用者打的第一個詞正規化成「指令」。
 *
 * 脫掉三樣東西：前後空白、結尾的 @botname、**開頭的斜線**。
 *
 * 【為什麼要脫斜線】
 * Telegram 的介面一直在誘導使用者打斜線 —— 鍵盤上有 `/` 鍵，
 * 打了 `/` 就跳出指令選單。所以人自然會打 `/日損` 而不是 `日損`。
 *
 * 原本只脫 @botname，於是 `/日損` 與清單裡的 `日損` 對不起來，
 * 落到最後的問答分支；而問答若被暫停，整件事就是「打了沒反應」——
 * 最難查的那種故障，因為沒有任何錯誤訊息。
 *
 * 配合 isCommand_ 一起看：那邊也會把清單裡的斜線脫掉，
 * 所以 `/daily`、`daily`、`/日損`、`日損` 四種寫法都通。
 */
function normalizeTelegramCommand_(text) {
  const firstToken = String(text || "").trim().toLowerCase().split(/\s+/)[0];
  return firstToken.replace(/@[^\s]+$/, "").replace(/^\/+/, "");
}

/**
 * 指令比對。兩邊都脫掉開頭的斜線再比，所以清單裡怎麼寫都行。
 */
function isCommand_(command, aliases) {
  for (let i = 0; i < aliases.length; i++) {
    if (String(aliases[i]).toLowerCase().replace(/^\/+/, "") === command) return true;
  }
  return false;
}

function setTelegramPaused_(paused) {
  PropertiesService.getScriptProperties().setProperty(
    "TELEGRAM_CHAT_PAUSED",
    paused ? "true" : "false"
  );
}

function isTelegramPaused_() {
  return PropertiesService.getScriptProperties()
    .getProperty("TELEGRAM_CHAT_PAUSED") === "true";
}

// ================================================================
// Webhook 設定工具（手動執行）
// ================================================================

/**
 * 更換部署或 Webhook 密鑰後執行一次。
 */
function setupTelegramWebhook() {
  setTelegramWebhook_(false);
}

/**
 * 重設 Webhook 並「丟掉所有積壓未確認的 update」。
 *
 * Telegram 收不到成功回應時，會把那筆 update 留在佇列裡持續重送 ——
 * 間隔拉長到一分半左右就固定下來，於是同一筆訊息每小時被投遞約 40 次，
 * 而且永遠不會自己停。這個函式把佇列清空，讓系統從乾淨狀態重新開始。
 *
 * 代價：佇列裡還沒處理的訊息會一起消失。對這個系統而言不是損失 ——
 * 積壓的都是早就處理過、只是 Telegram 不知道的重複投遞。
 */
function resetTelegramWebhook() {
  setTelegramWebhook_(true);
  console.log("已重設 Webhook 並清空積壓佇列。請接著執行 diagnoseTelegramWebhook() 確認。");
}

/**
 * 查詢 Telegram 自己記錄的 Webhook 狀態。
 *
 * 這是唯一能「從 Telegram 的角度」看事情的方法。試算表只能看到
 * 「它又送來了」，看不到「它為什麼認為上次沒送成功」——
 * last_error_message 正是那個答案。
 */
function diagnoseTelegramWebhook() {
  const config = getConfig_();
  const response = fetchWithRetry_(
    "https://api.telegram.org/bot" + config.tgToken + "/getWebhookInfo",
    { method: "get", muteHttpExceptions: true },
    "Telegram getWebhookInfo"
  );

  let info = {};
  try {
    info = (JSON.parse(response.getContentText()) || {}).result || {};
  } catch (error) {
    console.log("無法解析回應：" + redactLogText_(response.getContentText()));
    return;
  }

  const lastErrorAt = info.last_error_date
    ? new Date(info.last_error_date * 1000).toISOString()
    : null;

  // Telegram 記著的網址，與「這份指令碼目前的部署網址」是否相同。
  // 重新部署時若選了「新增部署作業」而不是「編輯現有部署」，網址會變，
  // 而 Telegram 還在打舊的那個 —— 症狀是「程式明明改了卻沒生效」。
  const expectedUrl = appendQuery_(config.webAppUrl, {
    source: "telegram",
    key: config.telegramSecret
  });

  console.log(JSON.stringify({
    // 網址含密鑰，只印出「有沒有設定」與結尾片段，不印完整值
    urlConfigured: Boolean(info.url),
    urlTail: info.url ? String(info.url).slice(-12) : null,
    urlMatchesCurrentDeployment: info.url === expectedUrl,
    pendingUpdateCount: info.pending_update_count || 0,
    maxConnections: info.max_connections,
    allowedUpdates: info.allowed_updates || "(未限制)",
    lastErrorAt: lastErrorAt,
    lastErrorMessage: info.last_error_message || null,
    lastSynchronizationErrorAt: info.last_synchronization_error_date
      ? new Date(info.last_synchronization_error_date * 1000).toISOString()
      : null
  }, null, 2));

  if ((info.pending_update_count || 0) > 0) {
    console.log("\n⚠️ 佇列裡有 " + info.pending_update_count +
      " 筆未確認的 update，Telegram 會持續重送它們。\n" +
      "   執行 resetTelegramWebhook() 可以清空。");
  }
  if (info.last_error_message) {
    console.log("\n⚠️ Telegram 最後一次投遞失敗的原因：" + info.last_error_message +
      "\n   這一行就是根因。把它貼出來才能對症處理。");
  }
  if (info.url && info.url !== expectedUrl) {
    console.log("\n⚠️ Telegram 打的網址，跟這份指令碼目前的部署網址不一樣。" +
      "\n   意思是：你改的程式沒有在跑。執行 resetTelegramWebhook() 重新指過來。");
  }
  if (!info.last_error_message && !(info.pending_update_count > 0)) {
    console.log("\n✅ Webhook 狀態正常，沒有積壓也沒有投遞錯誤。");
  }
}

/**
 * 同一個 update_id 的重複投遞，只記錄第一次。
 *
 * 第一次要留 —— 那是「有東西不對勁」的證據。
 * 後面的不留 —— 那只是同一件事的回音，每小時四十列，一天上千列，
 * 真正的訊號會被埋在裡面，而試算表的列數是有上限的。
 *
 * 用 CacheService 而非指令碼屬性：這是短命狀態，用完即棄，
 * 寫進屬性只會吃掉那 500 KB 的共用額度。
 */
function shouldLogDuplicateUpdate_(updateId) {
  const key = "dupupd_" + String(updateId);
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return false;
    cache.put(key, "1", 21600);   // 6 小時（CacheService 上限）
    return true;
  } catch (error) {
    // 快取異常就照記 —— 寧可吵，不要漏掉異常的第一個徵兆
    return true;
  }
}

/**
 * 僅在修復重送、切換 Bot Token 或確定不要保留舊訊息時執行。
 * Telegram 佇列中尚未處理的更新會被捨棄。
 */
function resetTelegramWebhookAndDropPendingUpdates() {
  setTelegramWebhook_(true);
  const properties = PropertiesService.getScriptProperties();
  properties.deleteProperty("LAST_TELEGRAM_UPDATE_ID");
  properties.deleteProperty("TELEGRAM_RECENT_UPDATE_IDS");
  properties.deleteProperty("TELEGRAM_CHAT_PAUSED");
  console.log("Telegram Webhook 已重設；舊佇列、去重記錄及暫停狀態已清除。");
}

function setTelegramWebhook_(dropPendingUpdates) {
  const config = getConfig_();
  const webhookUrl = appendQuery_(config.webAppUrl, {
    source: "telegram",
    key: config.telegramSecret
  });

  const response = fetchWithRetry_(
    "https://api.telegram.org/bot" + config.tgToken + "/setWebhook",
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        url: webhookUrl,
        // 允許少量併行，避免單筆 Claude 請求卡住後續控制指令。
        // 每筆 update_id 仍會獨立去重，不會因此重複回覆。
        max_connections: 5,
        // callback_query 是按鈕點擊。沒有列在這裡，Telegram 根本不會把
        // 按鈕事件送過來 —— 卡片畫得出來，按下去卻毫無反應。
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: Boolean(dropPendingUpdates)
      })
    },
    "Telegram setWebhook"
  );

  console.log("Telegram setWebhook HTTP " + response.getResponseCode());
  console.log(redactLogText_(response.getContentText()));
}

/**
 * 第一次設定或更換密鑰時執行：只會補上空白的密鑰，不覆蓋既有值。
 * 更換 TradingView 密鑰：先刪除 TRADINGVIEW_WEBHOOK_SECRET，再執行本函式，
 * 然後執行 showTradingViewWebhookUrl()，把新網址更新到所有 TradingView 警報。
 */
function initializeWebhookSecrets() {
  const properties = PropertiesService.getScriptProperties();
  const updates = {};

  if (!String(properties.getProperty("TRADINGVIEW_WEBHOOK_SECRET") || "").trim()) {
    updates.TRADINGVIEW_WEBHOOK_SECRET = generateSecret_();
  }

  if (!String(properties.getProperty("TELEGRAM_WEBHOOK_SECRET") || "").trim()) {
    updates.TELEGRAM_WEBHOOK_SECRET = generateSecret_();
  }

  if (Object.keys(updates).length === 0) {
    console.log("Webhook 密鑰已存在，未進行變更。");
    return;
  }

  properties.setProperties(updates, false);
  console.log("Webhook 密鑰已安全產生並寫入指令碼屬性：" + Object.keys(updates).join(", "));
  if (updates.TELEGRAM_WEBHOOK_SECRET) {
    console.log("Telegram 密鑰已更新，請接著執行 setupTelegramWebhook()。");
  }
}

/**
 * 執行後會在日誌顯示 TradingView 要填入的 Webhook URL。
 * 注意：網址含密鑰，不要公開分享日誌、截圖或網址。
 */
function showTradingViewWebhookUrl() {
  const config = getConfig_();
  const webhookUrl = appendQuery_(config.webAppUrl, {
    source: "tradingview",
    key: config.tradingViewSecret
  });
  console.log(webhookUrl);
}

function testConfiguration() {
  getConfig_();
  console.log("設定檢查完成：必要的指令碼屬性皆存在。");
}

// ================================================================
// 系統日誌與背景維護
// ================================================================

/**
 * 執行一次：在指定試算表建立「系統日誌」，並設定每分鐘背景維護。
 * 不改動試算表中的其他工作表或既有資料。
 */
function setupSystemLogSheet() {
  getOrCreateSystemLogSheet_();
  const existing = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === "flushSystemLogs";
  });
  if (!existing) {
    ScriptApp.newTrigger("flushSystemLogs")
      .timeBased()
      .everyMinutes(1)
      .create();
  }
  logEvent_("info", "system_log_ready", { source: "setup" });
  flushSystemLogs();
  console.log("系統日誌已準備完成，請到試算表查看「系統日誌」工作表。");
}

/**
 * 每分鐘觸發器的處理函式（名稱沿用舊版，不需重設觸發器）。
 * 1. 無待辦事項且未到完整掃描時間：只讀一次快取就結束。
 * 2. 先補送失敗的交易訊號，再把暫存日誌寫入工作表。
 * 使用 UserLock，避免與快訊／Telegram 去重用的 ScriptLock 互相阻塞。
 */
function flushSystemLogs() {
  const cache = CacheService.getScriptCache();
  const pending = cache.get(MAINTENANCE_FLAG_KEY) === "1";
  const fullScanDue = !cache.get(MAINTENANCE_FULL_SCAN_KEY);
  if (!pending && !fullScanDue) {
    return;
  }

  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) {
    console.warn("背景維護已在執行，本次略過。");
    return;
  }

  let stillPending = true;
  try {
    if (fullScanDue) {
      cache.put(MAINTENANCE_FULL_SCAN_KEY, "1", MAINTENANCE_FULL_SCAN_SECONDS);
    }

    const properties = PropertiesService.getScriptProperties();
    const all = properties.getProperties();

    let retryRemaining = countKeysWithPrefix_(Object.keys(all), SIGNAL_RETRY_PREFIX);
    if (retryRemaining > 0) {
      try {
        retryRemaining = processSignalRetries_(all, getConfig_());
      } catch (error) {
        console.error("補送佇列處理失敗：" + redactLogText_(errorMessage_(error)));
      }
    }

    const logRemaining = writeQueuedLogs_(properties);
    stillPending = retryRemaining > 0 || logRemaining > 0;
  } catch (error) {
    // 寫入失敗時保留暫存事件，下一次觸發器會重試；避免在這裡呼叫 logEvent_。
    console.error("背景維護失敗：" + redactLogText_(errorMessage_(error)));
    throw error;
  } finally {
    if (stillPending) {
      cache.put(MAINTENANCE_FLAG_KEY, "1", CACHE_MAX_TTL_SECONDS);
    } else {
      cache.remove(MAINTENANCE_FLAG_KEY);
    }
    lock.releaseLock();
  }
}

/**
 * 把暫存日誌寫入工作表，成功後才刪除暫存；回傳仍待寫入的筆數。
 */
function writeQueuedLogs_(properties) {
  const cache = CacheService.getScriptCache();
  const all = properties.getProperties();
  const allKeys = Object.keys(all).filter(function (key) {
    return key.indexOf(SYSTEM_LOG_PROPERTY_PREFIX) === 0;
  }).sort();

  if (allKeys.length === 0) {
    cache.put(LOG_QUEUE_COUNT_CACHE_KEY, "0", CACHE_MAX_TTL_SECONDS);
    return 0;
  }

  const keys = allKeys.slice(0, SYSTEM_LOG_BATCH_SIZE);
  const sheet = getOrCreateSystemLogSheet_();
  const lastRow = sheet.getLastRow();
  const lookbackCount = Math.min(Math.max(lastRow - 1, 0), 500);
  const recentIds = lookbackCount > 0
    ? sheet.getRange(lastRow - lookbackCount + 1, 7, lookbackCount, 1)
      .getValues().map(function (row) { return String(row[0]); })
    : [];
  const rows = [];

  keys.forEach(function (key) {
    if (recentIds.indexOf(key) !== -1) {
      return;
    }
    try {
      const record = JSON.parse(all[key]);
      rows.push([
        new Date(record.time),
        safeSheetText_(record.level),
        safeSheetText_(record.source),
        safeSheetText_(record.event),
        safeSheetText_(record.details),
        typeof record.elapsedMs === "number" ? record.elapsedMs : "",
        key
      ]);
    } catch (error) {
      rows.push([new Date(), "error", "system", "log_parse_failed",
        "暫存日誌格式損壞", "", key]);
    }
  });

  if (rows.length > 0) {
    sheet.getRange(lastRow + 1, 1, rows.length, SYSTEM_LOG_HEADERS.length)
      .setValues(rows);
    sheet.getRange(lastRow + 1, 1, rows.length, 1)
      .setNumberFormat("yyyy-mm-dd hh:mm:ss");
    SpreadsheetApp.flush();
  }
  keys.forEach(function (key) { properties.deleteProperty(key); });

  const remaining = allKeys.length - keys.length;
  cache.put(LOG_QUEUE_COUNT_CACHE_KEY, String(remaining), CACHE_MAX_TTL_SECONDS);
  trimSystemLogSheet_(sheet);
  console.log("系統日誌背景寫入完成：" + rows.length + " 筆；尚待寫入 " + remaining + " 筆。");
  return remaining;
}

/**
 * 只保留最近 SYSTEM_LOG_MAX_ROWS 列資料；累積超過緩衝量才批次刪除，減少寫入次數。
 */
function trimSystemLogSheet_(sheet) {
  const dataRows = sheet.getLastRow() - 1;
  if (dataRows <= SYSTEM_LOG_MAX_ROWS + SYSTEM_LOG_TRIM_SLACK) {
    return;
  }
  const excess = dataRows - SYSTEM_LOG_MAX_ROWS;
  sheet.deleteRows(2, excess);
  console.log("系統日誌已刪除最舊的 " + excess + " 列。");
}

function getOrCreateSystemLogSheet_() {
  const spreadsheet = SpreadsheetApp.openById(getLogSpreadsheetId_());
  let sheet = spreadsheet.getSheetByName(SYSTEM_LOG_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SYSTEM_LOG_SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SYSTEM_LOG_HEADERS.length)
      .setValues([SYSTEM_LOG_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, SYSTEM_LOG_HEADERS.length)
      .setBackground("#26354A")
      .setFontColor("#FFFFFF")
      .setFontWeight("bold");
    sheet.setColumnWidth(1, 165);
    sheet.setColumnWidth(2, 70);
    sheet.setColumnWidth(3, 100);
    sheet.setColumnWidth(4, 250);
    sheet.setColumnWidth(5, 460);
    sheet.setColumnWidth(6, 90);
    sheet.setColumnWidth(7, 390);
  } else {
    const actualHeaders = sheet.getRange(1, 1, 1, SYSTEM_LOG_HEADERS.length)
      .getValues()[0];
    if (actualHeaders.some(function (value, index) {
      return value !== SYSTEM_LOG_HEADERS[index];
    })) {
      throw new Error("既有「系統日誌」工作表欄位不符，未覆寫任何內容");
    }
  }
  return sheet;
}

/** 手動檢查背景日誌與補送佇列狀態；不輸出試算表 ID 或任何密鑰。 */
function diagnoseSystemLog() {
  const keys = PropertiesService.getScriptProperties().getKeys();
  const cache = CacheService.getScriptCache();
  const triggerConfigured = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === "flushSystemLogs";
  });
  const sheet = SpreadsheetApp.openById(getLogSpreadsheetId_())
    .getSheetByName(SYSTEM_LOG_SHEET_NAME);
  console.log(JSON.stringify({
    sheetReady: Boolean(sheet),
    triggerConfigured: triggerConfigured,
    queuedLogs: countKeysWithPrefix_(keys, SYSTEM_LOG_PROPERTY_PREFIX),
    queuedLogsLimit: SYSTEM_LOG_QUEUE_MAX,
    pendingSignalRetries: countKeysWithPrefix_(keys, SIGNAL_RETRY_PREFIX),
    maintenancePendingFlag: cache.get(MAINTENANCE_FLAG_KEY) === "1",
    recentSignalsCached: getRecentSignals_().length,
    writtenRows: sheet ? Math.max(sheet.getLastRow() - 1, 0) : 0,
    maxRows: SYSTEM_LOG_MAX_ROWS
  }));
}

/**
 * 只寫執行記錄，不進試算表。
 *
 * logEvent_ 每一筆都會呼叫 PropertiesService.setProperty，那是 Apps Script
 * 最慢的呼叫之一，而且排在 doPost 的關鍵路徑上。佇列上限 200 筆，
 * 高頻但無法據以行動的事件塞滿之後，真正需要留存的錯誤反而寫不進去。
 *
 * 判準：這一筆能不能讓你做出一個決定？不能的，就只留在 console。
 */
function logConsoleOnly_(level, eventName, details) {
  const entry = Object.assign({
    time: new Date().toISOString(),
    event: eventName
  }, details || {});
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](redactLogText_(JSON.stringify(entry)));
}

function logEvent_(level, eventName, details) {
  const entry = Object.assign({
    time: new Date().toISOString(),
    event: eventName
  }, details || {});
  const method = level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](redactLogText_(JSON.stringify(entry)));

  try {
    const cache = CacheService.getScriptCache();
    const queued = getQueuedLogCount_(cache);
    if (queued >= SYSTEM_LOG_QUEUE_MAX) {
      console.warn("系統日誌佇列已達上限（" + SYSTEM_LOG_QUEUE_MAX + "），本筆僅保留於執行記錄。");
      return;
    }

    const safeDetails = Object.assign({}, details || {});
    delete safeDetails.source;
    delete safeDetails.elapsedMs;
    const source = details && details.source
      ? String(details.source)
      : eventName.indexOf("tradingview") !== -1 ? "tradingview"
      : eventName.indexOf("telegram") !== -1 ? "telegram"
      : eventName.indexOf("claude") !== -1 ? "claude"
      : details && details.service ? String(details.service) : "system";
    const id = SYSTEM_LOG_PROPERTY_PREFIX + Date.now() + "_" +
      Utilities.getUuid().replace(/-/g, "");
    PropertiesService.getScriptProperties().setProperty(id, JSON.stringify({
      time: entry.time,
      level: level,
      source: redactLogText_(source),
      event: eventName,
      details: redactLogText_(JSON.stringify(safeDetails)),
      elapsedMs: details && typeof details.elapsedMs === "number"
        ? details.elapsedMs : null
    }));
    cache.put(LOG_QUEUE_COUNT_CACHE_KEY, String(queued + 1), CACHE_MAX_TTL_SECONDS);
    cache.put(MAINTENANCE_FLAG_KEY, "1", CACHE_MAX_TTL_SECONDS);
  } catch (error) {
    // 日誌失敗不能阻斷 TradingView 快訊；Apps Script 執行日誌仍保留原事件。
    console.warn("系統日誌暫存失敗：" + redactLogText_(errorMessage_(error)));
  }
}

/**
 * 佇列筆數以快取計數為主；快取遺失時才重新清點屬性鍵（軟上限，允許極小誤差）。
 */
function getQueuedLogCount_(cache) {
  const cached = cache.get(LOG_QUEUE_COUNT_CACHE_KEY);
  if (cached !== null) {
    return Number(cached) || 0;
  }
  const count = countKeysWithPrefix_(
    PropertiesService.getScriptProperties().getKeys(), SYSTEM_LOG_PROPERTY_PREFIX
  );
  cache.put(LOG_QUEUE_COUNT_CACHE_KEY, String(count), CACHE_MAX_TTL_SECONDS);
  return count;
}

function markMaintenancePending_() {
  CacheService.getScriptCache().put(MAINTENANCE_FLAG_KEY, "1", CACHE_MAX_TTL_SECONDS);
}

// ================================================================
// 共用工具
// ================================================================
function countKeysWithPrefix_(keys, prefix) {
  return keys.filter(function (key) {
    return key.indexOf(prefix) === 0;
  }).length;
}

function errorMessage_(error) {
  return error && error.message ? error.message : String(error);
}

function appendQuery_(baseUrl, parameters) {
  const query = Object.keys(parameters).map(function (name) {
    return encodeURIComponent(name) + "=" + encodeURIComponent(parameters[name]);
  }).join("&");
  return baseUrl + (baseUrl.indexOf("?") === -1 ? "?" : "&") + query;
}

function generateSecret_() {
  return (
    Utilities.getUuid().replace(/-/g, "") +
    Utilities.getUuid().replace(/-/g, "")
  );
}

function sha256Hex_(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (byte) {
    const unsignedByte = byte < 0 ? byte + 256 : byte;
    return ("0" + unsignedByte.toString(16)).slice(-2);
  }).join("");
}

function splitTelegramText_(text, maxLength) {
  const characters = Array.from(String(text));
  const chunks = [];
  let offset = 0;

  while (offset < characters.length) {
    let end = Math.min(offset + maxLength, characters.length);

    if (end < characters.length) {
      let newline = end;
      while (newline > offset + Math.floor(maxLength * 0.6)) {
        if (characters[newline - 1] === "\n") {
          end = newline;
          break;
        }
        newline -= 1;
      }
    }

    chunks.push(characters.slice(offset, end).join(""));
    offset = end;
  }

  return chunks.length > 0 ? chunks : [""];
}

function fetchWithRetry_(url, options, serviceName) {
  const requestOptions = Object.assign({}, options || {}, {
    muteHttpExceptions: true
  });
  let lastError = null;

  for (let attempt = 0; attempt < HTTP_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = UrlFetchApp.fetch(url, requestOptions);
    } catch (error) {
      lastError = error;
      if (attempt >= HTTP_MAX_ATTEMPTS - 1) {
        break;
      }
      const networkDelay = getRetryDelayMs_(attempt, null);
      logEvent_("warn", "http_network_retry", {
        service: serviceName,
        attempt: attempt + 1,
        delayMs: networkDelay
      });
      Utilities.sleep(networkDelay);
      continue;
    }

    const status = response.getResponseCode();
    if (status >= 200 && status < 300) {
      return response;
    }

    lastError = new Error(
      serviceName + " HTTP " + status + ": " +
      truncate_(response.getContentText(), 300)
    );

    if (!isRetryableStatus_(status) || attempt >= HTTP_MAX_ATTEMPTS - 1) {
      break;
    }

    const retryDelay = getRetryDelayMs_(attempt, response);
    logEvent_("warn", "http_status_retry", {
      service: serviceName,
      status: status,
      attempt: attempt + 1,
      delayMs: retryDelay
    });
    Utilities.sleep(retryDelay);
  }

  throw lastError || new Error(serviceName + " 請求失敗");
}

function isRetryableStatus_(status) {
  return status === 408 || status === 429 || status >= 500;
}

function getRetryDelayMs_(attempt, response) {
  if (response) {
    const headers = response.getAllHeaders();
    const retryAfterKey = Object.keys(headers).find(function (name) {
      return name.toLowerCase() === "retry-after";
    });
    const retryAfterSeconds = retryAfterKey
      ? parseFloat(headers[retryAfterKey])
      : NaN;
    if (isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.min(retryAfterSeconds * 1000, 5000);
    }
  }

  const baseDelay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  return baseDelay + Math.floor(Math.random() * 250);
}

function truncate_(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : text.slice(0, maxLength) + "…";
}

function redactLogText_(value) {
  return String(value || "")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[REDACTED]")
    .replace(/([?&](?:key|token|secret)=)[^&\s"]+/gi, "$1[REDACTED]")
    .slice(0, 700);
}

function safeSheetText_(value) {
  const text = String(value == null ? "" : value).slice(0, 700);
  return /^[\s]*[=+@-]/.test(text) ? "'" + text : text;
}

/**
 * 避免直接用 === 比對 Webhook 密鑰時產生明顯的提早返回差異。
 */
function safeEquals_(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function textOutput_(text) {
  return ContentService.createTextOutput(String(text))
    .setMimeType(ContentService.MimeType.TEXT);
}

// ================================================================
// 測試函式（手動執行）
// ================================================================
function buildTestSignal_(label) {
  return "🧪 " + label + "（非實盤訊號）\n" +
    "《維加斯訊號》交易訊號\n" +
    "─────────────\n" +
    "[時間] " + Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy-MM-dd HH:mm:ss") + "\n" +
    "[幣種] BTCUSDT.P\n" +
    "[週期] 15分鐘\n" +
    "[時區] Asia/Taipei\n" +
    "[品質] 測試\n" +
    "[方向] 做多⬆\n" +
    "[價格] 測試值\n" +
    "[止損] 測試值\n" +
    "[止盈1] 測試值\n" +
    "[止盈2] 測試值\n" +
    "[止盈3] 測試值\n" +
    "[測試ID] " + Utilities.getUuid();
}

function testBatch2Helpers() {
  const sample = Array(9001).join("測");
  const chunks = splitTelegramText_(sample, MAX_TELEGRAM_CHUNK_LENGTH);
  const valid = chunks.length === 3 && chunks.every(function (chunk) {
    return Array.from(chunk).length <= MAX_TELEGRAM_CHUNK_LENGTH;
  });
  if (!valid) {
    throw new Error("Telegram 分段測試失敗");
  }
  console.log("Telegram 分段輔助函式測試通過。");
}

function testTelegramCommandHelpers() {
  const cases = [
    normalizeTelegramCommand_("停止") === "停止",
    normalizeTelegramCommand_("/pause@my_bot") === "pause",
    normalizeTelegramCommand_("啟用") === "啟用",
    normalizeTelegramCommand_("/resume 其他文字") === "resume",
    normalizeTelegramCommand_("/status") === "status",
    normalizeTelegramCommand_("/日損") === "日損",
    normalizeTelegramCommand_("ID") === "id",
    isCommand_(normalizeTelegramCommand_("/daily"), ["日損", "/daily"]),
    isCommand_(normalizeTelegramCommand_("日損"), ["日損", "/daily"]),
    isCommand_(normalizeTelegramCommand_("/日損@my_bot"), ["日損", "/daily"]),
    !isCommand_(normalizeTelegramCommand_("日損上限多少"), ["日損", "/daily"])
  ];
  if (!cases.every(function (value) { return value; })) {
    throw new Error("Telegram 指令解析測試失敗");
  }
  console.log("Telegram 指令解析測試通過。");
}

function testTradingViewSignalValidation() {
  const v118Sample = "《維加斯訊號》交易訊號\n" +
    "─────────────\n" +
    "[時間] 2026-09-21 22:17\n" +
    "[幣種] BTCUSDT.P\n" +
    "[週期] 1小時\n" +
    "[時區] Asia/Taipei\n" +
    "[品質] 標準\n" +
    "[方向] 做空⬇\n" +
    "[價格] 85397.5 USDT";
  const v116Sample = "《維加斯訊號》交易訊號\n" +
    "[幣種] BTC\n" +
    "[時區] 15分鐘\n" +
    "[方向] 做多⬆";

  if (!isExpectedTradingViewSignal_(v118Sample) ||
      isExpectedTradingViewSignal_(v116Sample) ||
      isExpectedTradingViewSignal_("一般聊天訊息")) {
    throw new Error("TradingView 訊號驗證測試失敗");
  }
  console.log("TradingView 訊號驗證測試通過（v11.8 通過、v11.6 舊格式與一般訊息被擋下）。");
}

function testRedaction() {
  const sample = "bot123456:ABC_def-ghi sk-ant-api03-XYZ_abc " +
    "https://x/exec?source=tradingview&key=abcdef123";
  const redacted = redactLogText_(sample);
  if (redacted.indexOf("ABC_def") !== -1 ||
      redacted.indexOf("api03-XYZ") !== -1 ||
      redacted.indexOf("abcdef123") !== -1) {
    throw new Error("日誌遮蔽測試失敗：" + redacted);
  }
  console.log("日誌遮蔽測試通過：" + redacted);
}

/**
 * 手動執行會真的傳一則清楚標示為「非實盤」的測試快訊到 Telegram。
 * 只測 Apps Script → Telegram；日誌事件會標註 origin=manual_test，
 * 與 TradingView 真實 webhook（origin=webhook）區分。
 */
function testTradingViewSignalDelivery() {
  const config = getConfig_();
  handleTradingViewSignal_(
    { postData: { contents: buildTestSignal_("系統測試") } },
    config,
    "manual_test"
  );
  console.log("非實盤測試快訊已送出。請確認 Telegram 與系統日誌。");
}

/**
 * 模擬一筆傳送失敗的訊號進入補送佇列，並立即執行背景維護補送。
 * Telegram 應收到帶「⏱ 延遲送達」前綴的測試訊息。
 */
function testSignalRetryQueue() {
  getConfig_();
  const dedupKey = "tv:test_" + Utilities.getUuid().replace(/-/g, "");
  if (!enqueueSignalRetry_(buildTestSignal_("補送佇列測試"), dedupKey, "manual retry test")) {
    throw new Error("補送佇列寫入失敗");
  }
  flushSystemLogs();
  console.log("補送佇列測試完成：請確認 Telegram 收到「延遲送達」測試訊息。");
}

/**
 * 由 Apps Script 編輯器直接測試 Claude 與 Telegram 出站連線。
 * 會實際傳送一則測試訊息到 ALLOWED_CHAT_ID。
 */
function testClaudeAndTelegramDelivery() {
  const config = getConfig_();
  const reply = askClaude_("請只回覆：Claude 連線正常", config);
  sendTelegramMessage_(
    config.allowedChatId,
    "🧪 Apps Script 主動測試\n" + reply,
    config
  );
  console.log("Claude 與 Telegram 主動傳送測試已完成，請檢查聊天室。");
}

/**
 * 測試：把一則訊息送到 SIGNAL_THREAD_ID 指定的話題（未設定則送到群組預設處）。
 */
function testSignalThread() {
  const c = getConfig_();
  sendSignalMessage_("🧪 訊號組話題測試", c);
}

/**
 * 診斷：檢查訊號實際送達的聊天室（SIGNAL_CHAT_ID，未設定則為 ALLOWED_CHAT_ID）
 * 是否為開啟話題的群組，並顯示目前的 SIGNAL_THREAD_ID。結果請看「執行記錄」。
 */
function debugSignalThread() {
  const c = getConfig_();
  const target = c.signalChatId || c.allowedChatId;
  const res = UrlFetchApp.fetch(
    "https://api.telegram.org/bot" + c.tgToken + "/getChat?chat_id=" + encodeURIComponent(target),
    { muteHttpExceptions: true }
  );
  const d = JSON.parse(res.getContentText());
  const r = d.result || {};
  console.log(JSON.stringify({
    ok: d.ok,
    description: d.description || null,
    ALLOWED_CHAT_ID: c.allowedChatId,
    SIGNAL_CHAT_ID: c.signalChatId || "(未設定，訊號送到 ALLOWED_CHAT_ID)",
    target_type: r.type || null,
    target_title: r.title || null,
    target_is_forum: r.is_forum === true,
    SIGNAL_THREAD_ID: c.signalThreadId || "(未設定)"
  }, null, 2));
}

/**
 * v3.3 新增：檢查 BROADCAST_CHAT_ID 與 SIGNAL_CHAT_ID 的實際狀態。
 *
 * 第 3.4 批起，Code.gs 與 Executor.gs 都不再讀 BROADCAST_CHAT_ID，留著只會混淆。
 * 執行後依結果判讀：
 * - migrated_to 有值：舊的普通群組升級成超級群組後留下的失效 ID，可直接刪除。
 * - ok=true 且 title 是另一個群組：你有兩個群組，先決定訊號要進哪一個。
 * - ok=false 且無 migrated_to：bot 不在該群組或 ID 錯誤，可刪除。
 * 刪除前請先在 Executor.gs 搜尋 BROADCAST_CHAT_ID，確認沒有其他地方在讀它。
 * 只輸出群組資訊，不輸出 Token。
 */
function checkChatIds() {
  const c = getConfig_();
  const p = PropertiesService.getScriptProperties();
  ["BROADCAST_CHAT_ID", "SIGNAL_CHAT_ID"].forEach(function (name) {
    const id = String(p.getProperty(name) || "").trim();
    if (!id) {
      console.log(name + "：未設定");
      return;
    }
    const res = UrlFetchApp.fetch(
      "https://api.telegram.org/bot" + c.tgToken + "/getChat?chat_id=" + encodeURIComponent(id),
      { muteHttpExceptions: true }
    );
    let d = {};
    try {
      d = JSON.parse(res.getContentText());
    } catch (error) {
      console.log(name + "：無法解析回應");
      return;
    }
    const r = d.result || {};
    console.log(name + " " + JSON.stringify({
      id: id,
      ok: d.ok === true,
      type: r.type || null,
      title: r.title || null,
      is_forum: r.is_forum === true,
      error: d.description || null,
      migrated_to: (d.parameters && d.parameters.migrate_to_chat_id) || null
    }));
  });
}
