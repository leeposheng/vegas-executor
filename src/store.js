'use strict';
/**
 * 狀態持久化（階段 0 用單一 JSON 檔）。
 *
 * 保存四類狀態：
 *   processed  — 已處理過的 sig_id，冪等的第一道防線
 *   positions  — 系統認為自己持有的部位，供階段 2 的對帳迴圈比對
 *   daily      — 當日累計已實現損益與筆數，供每日虧損上限判斷
 *   halted     — kill switch
 *
 * 為什麼不用記憶體：程序重啟（部署、當機、VPS 重開）後若狀態歸零，
 * 同一筆訊號會被視為新訊號而重複下單。這是自動交易最典型的重複下單原因。
 *
 * 寫入採「先寫暫存檔再 rename」。rename 在同一檔案系統上是原子操作，
 * 可避免寫到一半斷電留下半截 JSON。
 *
 * 階段 2 以後若要跑多個執行實例，這層應換成 SQLite 或 Redis；
 * 目前刻意維持單檔單程序，語意最單純。
 */

const fs = require('fs');
const path = require('path');

const EMPTY = {
  halted: false,
  haltedReason: '',
  haltedSource: '',   // 誰停的：preflight／manual／daily_loss
  processed: {},   // sigId -> { at, outcome }
  positions: {},   // sigId -> { ... }
  pendings: {},    // sigId -> { status, expiresAt, plan, ... } 見下方說明
  daily: {},       // 'YYYY-MM-DD' -> { realisedPnlUsdt, orders }
  // 已結束的待確認訊號。刻意與 pendings 分開保存：
  // 「按了什麼、沒按什麼、沒按的後來怎麼走」是之後檢討自主篩選價值的唯一依據，
  // 資料留著不花錢，少了就永遠補不回來。
  decisions: [],   // [{ sigId, at, outcome, signal, sizing }]
  // 下單意圖。在呼叫交易所「之前」就寫進來，成功之後才刪掉。
  //
  // 存在的理由只有一個：送出請求到收到回應之間，行程可能死掉、
  // 網路可能斷掉。那時候錢已經動了，但系統什麼都不知道 ——
  // 沒有部位紀錄，對帳也就不會去查。留下的痕跡就是這裡的 intent。
  intents: {},     // sigId -> { clOrdId, instId, symbol, side, at, exchange }
  // 執行期覆寫的設定。目前只有持倉上限。
  //
  // 存在狀態檔裡而不是只放記憶體：重新部署之後你設的值要還在。
  // 否則每次上新版都會悄悄退回環境變數的預設值，而你不會發現。
  overrides: {},   // { maxConcurrent }
  // 最後一次日損重置的時間戳。
  //
  // 【為什麼不能只存在 daily[今天].resets 裡】
  // daily 是按台北日期切的。23:55 按下重置，冷卻 30 分鐘 ——
  // 到了 00:00，dailyResetInfo() 開始讀新的一天，那一天沒有 resets，
  // 於是 lastAt 變成 0，冷卻直接消失。
  //
  // 而 24 小時的加密市場裡午夜不是任何一種休息。剛重置完的那個人，
  // 在 00:05 跟在 23:55 是同一個人 —— 冷卻本來就該跨過去。
  // 日損額度歸零是刻意的（那是「新的一天」的意思），冷卻被一起歸零不是。
  lastResetAtMs: 0,
};

// 已處理紀錄保留天數，避免檔案無限成長
const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// 已知的交易所前綴。鍵的解析只認這幾個 ——
//
// 【為什麼不能用 indexOf(':') 切】
// sig_id 本身允許含冒號（signal.js 的白名單有 `:`）。舊格式的鍵
// 「vegas:BTC:15」會被切成「前綴 vegas + sigId BTC:15」，
// 於是 removePosition 找不到那個鍵、靜默失敗，部位永遠刪不掉，
// 而損益每一輪對帳重記一次 —— 一筆 -30 的停損三輪後帳上是 -90，
// 日損上限被假數字觸發。整個過程沒有任何錯誤訊息。
const EXCHANGE_PREFIXES = ['okx', 'bingx'];
const KEY_RE = new RegExp('^(' + EXCHANGE_PREFIXES.join('|') + '):([\\s\\S]+)$');

/** 把儲存鍵拆成 { sigId, exchange }。認不出前綴就視為舊格式。 */
function splitKey(key, fallbackExchange) {
  const m = KEY_RE.exec(key);
  if (m) return { exchange: m[1], sigId: m[2] };
  return { exchange: fallbackExchange || 'okx', sigId: key };
}

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.state = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        return Object.assign(JSON.parse(JSON.stringify(EMPTY)), parsed);
      }
    } catch (err) {
      // 檔案損壞時不要靜默重置：改名保留，讓人能事後查
      const backup = this.file + '.corrupt-' + Date.now();
      try { fs.renameSync(this.file, backup); } catch (_) { /* ignore */ }
      console.error('[store] 狀態檔損壞，已備份至 ' + backup);
    }
    return JSON.parse(JSON.stringify(EMPTY));
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---- 冪等 ----
  //
  // 鍵同樣是「交易所:訊號編號」。雙邊下單時同一筆訊號要在兩家各下一單，
  // 若冪等只看訊號編號，第一家成功之後第二家會被自己的冪等擋掉 ——
  // 而那看起來會像「BingX 一直不下單」，查半天查不出原因。
  //
  // 舊格式（沒有前綴）仍然讀得到，避免部署後重複下單。
  _procKey(sigId, exchange) {
    const withEx = `${exchange || 'okx'}:${sigId}`;
    if (this.state.processed[withEx] !== undefined) return withEx;
    if (this.state.processed[sigId] !== undefined) return sigId;
    return withEx;
  }

  isProcessed(sigId, exchange) {
    return Object.prototype.hasOwnProperty.call(
      this.state.processed, this._procKey(sigId, exchange));
  }

  getProcessed(sigId, exchange) {
    return this.state.processed[this._procKey(sigId, exchange)];
  }

  markProcessed(sigId, outcome, detail, exchange) {
    this.state.processed[`${exchange || 'okx'}:${sigId}`] = {
      at: new Date().toISOString(),
      outcome,
      detail: detail || '',
      exchange: exchange || 'okx',
    };
    this._pruneProcessed();
    this.save();
  }

  _pruneProcessed() {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    for (const [id, rec] of Object.entries(this.state.processed)) {
      if (new Date(rec.at).getTime() < cutoff) delete this.state.processed[id];
    }
  }

  // ---- 部位 ----
  // 未結案的下單意圖一律算進持倉。
  //
  // 意圖的語意就是「這筆可能已經成交，我們還不知道」。在對帳把它查清楚
  // 之前當作沒有部位，等於明知有風險敞口還加倉 —— 實測過：
  // MAX_CONCURRENT=1 時第一筆下單拋例外留下意圖，第二筆同幣種訊號
  // 照樣通過閘門下單，交易所上可能就有兩個部位。
  //
  // 代價是：一筆永遠查不清的意圖會一直佔著額度。這是刻意的方向 ——
  // 額度被佔住頂多少做幾筆，算錯風險則會賠錢。
  /**
   * 同時持倉數。
   *
   * @param {string} [exchange] 只算這家的；不給就全部
   *
   * 雙邊下單時必須按交易所分開算 —— 一筆訊號會在兩家各開一個部位，
   * 合起來算的話 MAX_CONCURRENT_POSITIONS=3 只夠一點五筆訊號。
   * 那個數字的意思一直是「同時最多幾個標的在場」，不是「幾個部位物件」。
   */
  openPositionCount(exchange) {
    return this.listPositions(exchange).length
      + this.listIntents(exchange).length;
  }

  hasPositionForSymbol(symbol, exchange) {
    return this.listPositions(exchange).some((p) => p.symbol === symbol)
      || this.listIntents(exchange).some((i) => i.symbol === symbol);
  }

  // ---- 多交易所的鍵 ----
  //
  // 同一筆訊號可能在兩家交易所各開一個部位，所以「訊號編號」本身
  // 不足以當鍵。鍵改成「交易所:訊號編號」。
  //
  // 舊資料（沒有前綴的鍵）仍然讀得到：_posKey 在找不到新格式時
  // 會退回舊格式。少了這段，一次部署就會讓所有在場部位從系統中消失。
  _posKey(sigId, exchange) {
    const withEx = `${exchange || 'okx'}:${sigId}`;
    if (this.state.positions[withEx] !== undefined) return withEx;
    if (this.state.positions[sigId] !== undefined) return sigId;   // 舊格式
    return withEx;
  }

  addPosition(sigId, position) {
    const ex = (position && position.exchange) || 'okx';
    this.state.positions[`${ex}:${sigId}`] = Object.assign(
      { openedAt: new Date().toISOString() }, position, { sigId, exchange: ex }
    );
    this.save();
  }

  /**
   * @returns {boolean} 有沒有真的刪掉
   *
   * 回傳值不是裝飾。刪除失敗曾經是靜默的，結果是部位永遠留在 store、
   * 而對帳每一輪都重記一次同一筆損益。呼叫端必須看得到失敗。
   */
  removePosition(sigId, exchange) {
    const key = this._posKey(sigId, exchange);
    if (this.state.positions[key] === undefined) return false;
    delete this.state.positions[key];
    this.save();
    return true;
  }

  /**
   * @param {string} [exchange] 只列這家的；不給就全部
   */
  listPositions(exchange) {
    return Object.entries(this.state.positions)
      .map(([key, p]) => {
        // value 裡存的 sigId 優先 —— 鍵只當索引用。
        // 舊資料沒有這個欄位，才退回解析鍵。
        const parsed = splitKey(key, p.exchange);
        return Object.assign({}, p, {
          sigId: p.sigId || parsed.sigId,
          exchange: p.exchange || parsed.exchange,
        });
      })
      .filter((p) => !exchange || p.exchange === exchange);
  }

  // ---- 下單意圖 ----
  //
  // 這三個函式撐起「動錢」與「記帳」之間那道縫。
  // 寫入必須在呼叫交易所之前，而且必須立刻落地（save 是同步的），
  // 否則就失去意義 —— 意圖的全部價值就在於它比請求先到磁碟上。
  recordIntent(sigId, intent) {
    const ex = (intent && intent.exchange) || 'okx';
    this.state.intents[`${ex}:${sigId}`] = Object.assign(
      { at: new Date().toISOString() }, intent, { sigId, exchange: ex }
    );
    this.save();
  }

  clearIntent(sigId, exchange) {
    const withEx = `${exchange || 'okx'}:${sigId}`;
    const key = this.state.intents[withEx] !== undefined ? withEx
      : (this.state.intents[sigId] !== undefined ? sigId : null);
    if (!key) return;
    delete this.state.intents[key];
    this.save();
  }

  listIntents(exchange) {
    return Object.entries(this.state.intents)
      .map(([key, i]) => {
        const parsed = splitKey(key, i.exchange);
        return Object.assign({}, i, {
          sigId: i.sigId || parsed.sigId,
          exchange: i.exchange || parsed.exchange,
        });
      })
      .filter((i) => !exchange || i.exchange === exchange);
  }

  // ---- 當日損益 ----
  _todayKey(now) {
    // 以台北時區切日，與交易習慣一致
    const d = new Date((now || Date.now()) + 8 * 3600 * 1000);
    return d.toISOString().slice(0, 10);
  }

  today(now) {
    const key = this._todayKey(now);
    if (!this.state.daily[key]) {
      this.state.daily[key] = { realisedPnlUsdt: 0, orders: 0 };
    }
    const d = this.state.daily[key];
    // 舊狀態檔沒有這兩個欄位。在這裡補齊而不是在載入時做一次性遷移，
    // 是因為 daily 是按日新增的：遷移只修得到「當下存在的那幾天」，
    // 補在讀取路徑上才連明天新建的那一天也一起管到。
    if (typeof d.resetBaseline !== 'number') d.resetBaseline = 0;
    if (!Array.isArray(d.resets)) d.resets = [];
    return d;
  }

  /**
   * 風控實際採計的當日損益 ＝ 真實損益 − 重置基準。
   *
   * 【為什麼不直接把 realisedPnlUsdt 歸零】
   * 那會毀掉當天真正虧了多少的紀錄，而那個數字是事後檢討唯一的依據 ——
   * 「我今天到底虧多少」和「風控還讓不讓我下單」是兩個問題，
   * 把前者改掉來回答後者，等於為了關掉警報而拆掉溫度計。
   *
   * 所以重置只移動基準線，真實損益永遠只增不改。
   */
  dailyPnlSinceReset(now) {
    const d = this.today(now);
    return d.realisedPnlUsdt - (d.resetBaseline || 0);
  }

  /** 當日重置狀態。供閘門、/health 與 Telegram 面板共用同一份事實。 */
  dailyResetInfo(now) {
    const d = this.today(now);
    const last = d.resets.length ? d.resets[d.resets.length - 1] : null;
    return {
      count: d.resets.length,
      // 次數看今天（跨日重算是對的），時間看全域（跨日不該重算）。
      // 兩者的日界線意義不同，所以來源也不同。
      lastAt: Math.max(this.state.lastResetAtMs || 0, last ? last.at : 0),
      realisedPnlUsdt: d.realisedPnlUsdt,
      baseline: d.resetBaseline || 0,
      effectivePnlUsdt: d.realisedPnlUsdt - (d.resetBaseline || 0),
      resets: d.resets.slice(),
    };
  }

  /**
   * 把日損上限的計數歸零（移動基準線），並留下痕跡。
   *
   * 每一次重置都寫進 resets 陣列：時間、誰按的、當下抹掉多少虧損。
   * 這份紀錄比重置本身重要 —— 一個月後回頭看「我那天按了三次」，
   * 比任何風控參數都更能說明問題出在哪裡。
   */
  resetDailyLoss(opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const d = this.today(now);
    const cleared = d.realisedPnlUsdt - (d.resetBaseline || 0);
    d.resetBaseline = d.realisedPnlUsdt;
    d.resets.push({
      at: now,
      by: o.by || 'telegram',
      clearedUsdt: cleared,
      note: String(o.note || ''),
    });
    // 全域記一份，讓冷卻跨得過午夜
    if (now > (this.state.lastResetAtMs || 0)) this.state.lastResetAtMs = now;
    this.save();
    return { count: d.resets.length, clearedUsdt: cleared, at: now };
  }

  recordOrder(now) {
    this.today(now).orders += 1;
    this.save();
  }

  recordPnl(pnlUsdt, now) {
    this.today(now).realisedPnlUsdt += Number(pnlUsdt) || 0;
    this.save();
  }

  // ---- 待確認訊號 ----
  //
  // 狀態機：pending → confirming → placed
  //                 → skipped
  //                 → expired
  //
  // confirming 是一個「短暫但必要」的中間狀態。下單要等交易所回應，
  // 而那段等待期間第二個確認請求可能進來（重複點擊、Telegram 重送 callback）。
  // 在任何 await 之前就同步把狀態改成 confirming，第二個請求才擋得住。
  // 只靠 sig_id 冪等不夠——那是在交易所端生效，這裡要在送出前就攔下。

  // 待確認紀錄同樣是「交易所:訊號編號」。
  //
  // 這是最後一個改過來的集合，而它漏掉的後果最嚴重：雙邊下單時
  // 兩家各存一筆，後者會直接覆寫前者 —— 於是只剩一筆、只會下一單，
  // 曝險是你以為的一半，而且卡片上完全看不出來。
  _pendKey(sigId, exchange) {
    const withEx = `${exchange || 'okx'}:${sigId}`;
    if (this.state.pendings[withEx] !== undefined) return withEx;
    if (this.state.pendings[sigId] !== undefined) return sigId;
    return withEx;
  }

  addPending(sigId, record) {
    const ex = (record && record.exchange) || 'okx';
    const key = `${ex}:${sigId}`;
    this.state.pendings[key] = Object.assign({
      status: 'pending',
      createdAt: new Date().toISOString(),
    }, record, { sigId, exchange: ex });
    this.save();
    return this.state.pendings[key];
  }

  getPending(sigId, exchange) {
    return this.state.pendings[this._pendKey(sigId, exchange)] || null;
  }

  /** 同步標記為處理中，回傳是否搶到。已非 pending 則回 false。 */
  claimPending(sigId, exchange) {
    const p = this.state.pendings[this._pendKey(sigId, exchange)];
    if (!p || p.status !== 'pending') return false;
    p.status = 'confirming';
    this.save();
    return true;
  }

  /** 認領失敗後把狀態放回去，讓使用者能再試一次。 */
  releasePending(sigId, exchange) {
    const p = this.state.pendings[this._pendKey(sigId, exchange)];
    if (p && p.status === 'confirming') {
      p.status = 'pending';
      this.save();
    }
  }

  /** 某筆訊號在各家的待確認紀錄。按鈕確認時要一次處理全部。 */
  pendingsForSignal(sigId) {
    return Object.entries(this.state.pendings)
      .map(([key, p]) => Object.assign({}, p, {
        sigId: p.sigId || splitKey(key, p.exchange).sigId,
        exchange: p.exchange || splitKey(key, p.exchange).exchange,
      }))
      .filter((p) => p.sigId === sigId);
  }

  resolvePending(sigId, outcome, detail, exchange) {
    const key = this._pendKey(sigId, exchange);
    const p = this.state.pendings[key];
    if (!p) return null;
    p.status = outcome;
    p.resolvedAt = new Date().toISOString();
    if (detail) p.detail = detail;

    this.state.decisions.push({
      sigId,
      at: p.resolvedAt,
      outcome,
      symbol: p.signal && p.signal.symbol,
      side: p.signal && p.signal.side,
      grade: p.signal && p.signal.grade,
      entry: p.signal && p.signal.entry,
      sl: p.signal && p.signal.sl,
      orderQty: p.sizing && p.sizing.orderQty,
      riskUsdt: p.sizing && p.sizing.actualRiskUsdt,
    });
    if (this.state.decisions.length > 2000) {
      this.state.decisions = this.state.decisions.slice(-2000);
    }

    delete this.state.pendings[key];
    this.save();
    return p;
  }

  /**
   * 掃出過期的待確認訊號。沒有背景計時器，改由每次請求進來時順手掃一遍——
   * 這樣不必多跑一個排程，而且「有人在看」的時候狀態一定是準的。
   */
  expirePendings(nowMs) {
    const now = nowMs || Date.now();
    const expired = [];
    for (const [key, p] of Object.entries(this.state.pendings)) {
      // confirming 中的不動：它正在等交易所回應，不是沒人理
      if (p.status !== 'pending') continue;
      if (new Date(p.expiresAt).getTime() <= now) {
        const parsed = splitKey(key, p.exchange);
        expired.push(Object.assign({}, p, {
          sigId: p.sigId || parsed.sigId,
          exchange: p.exchange || parsed.exchange,
        }));
      }
    }
    expired.forEach((p) =>
      this.resolvePending(p.sigId, 'expired', '超過存活時間未確認', p.exchange));
    return expired;
  }

  listPendings(exchange) {
    return Object.entries(this.state.pendings)
      .map(([key, p]) => {
        const parsed = splitKey(key, p.exchange);
        return Object.assign({}, p, {
          sigId: p.sigId || parsed.sigId,
          exchange: p.exchange || parsed.exchange,
        });
      })
      .filter((p) => !exchange || p.exchange === exchange);
  }

  listDecisions(limit) {
    const n = limit || 50;
    return this.state.decisions.slice(-n).reverse();
  }

  // ---- kill switch ----
  isHalted() {
    return Boolean(this.state.halted);
  }

  /**
   * @param {string} [source] 'preflight' | 'manual' | 'daily_loss' …
   *
   * 記下「是誰停的」，因為解除的條件不一樣：自檢停的，下次自檢通過就該
   * 自己解開；人手動停的，只能人手動解開。
   *
   * 少了這個欄位，一次自檢失敗會讓 kill switch 永遠留在狀態檔裡 ——
   * 就算把失敗原因修好、重新部署，服務照樣不下單，而 haltedReason
   * 還顯示著那個早就不存在的錯誤，看起來像修改沒生效。
   */
  setHalted(halted, reason, source) {
    this.state.halted = Boolean(halted);
    this.state.haltedReason = halted ? String(reason || '手動停止') : '';
    this.state.haltedSource = halted ? (source || 'manual') : '';
    this.save();
  }

  haltedReason() {
    return this.state.haltedReason;
  }

  // ---- 執行期覆寫 ----
  getOverride(key) {
    return this.state.overrides ? this.state.overrides[key] : undefined;
  }

  setOverride(key, value) {
    if (!this.state.overrides) this.state.overrides = {};
    if (value === null || value === undefined) delete this.state.overrides[key];
    else this.state.overrides[key] = value;
    this.save();
  }

  haltedSource() {
    return this.state.haltedSource || (this.state.halted ? 'manual' : '');
  }

  /**
   * 解除由特定來源設下的停止。回傳有沒有真的解除。
   * 人手動停的絕不會被程式解開 —— 那是使用者的決定，不是系統的。
   */
  clearHaltIfFrom(source) {
    if (!this.state.halted) return false;
    if (this.haltedSource() !== source) return false;
    this.setHalted(false);
    return true;
  }
}

module.exports = { Store };
