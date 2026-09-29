'use strict';
/**
 * 上傳 GitHub 之前的最後檢查。
 *
 * 【為什麼需要這支】
 * Git 的歷史是永久的。密鑰一旦 commit 進去，之後刪掉檔案也沒用 ——
 * 它還在歷史裡，而私有 repo 哪天轉公開，整段歷史跟著公開。
 *
 * VS Code 的原始檔控制面板看得到「哪些檔案會上傳」，但看不到
 * 「檔案裡面有沒有密鑰」。這支補的是後者。
 *
 * 【為什麼是 Node 不是 PowerShell】
 * Windows PowerShell 5.1 用系統字碼頁（繁中是 Big5）讀 .ps1，
 * 中文註解會變成亂碼，而亂碼裡剛好出現引號就會讓整份腳本語法錯誤。
 * Node 一律以 UTF-8 讀檔，不看系統字碼頁 —— 少掉一整類問題。
 *
 * 用法（在專案資料夾）：
 *   node tools/check-before-push.js
 */

const { execSync } = require('child_process');
const fs = require('fs');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const OFF = '\x1b[0m';

const problems = [];

function tracked() {
  try {
    return execSync('git ls-files', { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return null;
  }
}

const files = tracked();
if (files === null) {
  console.log(`${YELLOW}還沒有 git 存放庫。先在 VS Code 按「初始化存放庫」再跑這支。${OFF}`);
  process.exit(1);
}
if (!files.length) {
  console.log(`${YELLOW}沒有任何已追蹤的檔案。先在 VS Code 把變更加入暫存區。${OFF}`);
  process.exit(1);
}

console.log(`\n${CYAN}=== 1. 危險檔案有沒有被追蹤 ===${OFF}`);
// git ls-files 列的是「已被 git 追蹤」的檔案，與「資料夾裡有什麼」不同。
// .gitignore 只擋新檔案 —— 已經被追蹤的檔案加進 ignore 也不會自動移除。
const danger = ['.env', 'data/state.json', 'tools/requests.http'];
for (const d of danger) {
  if (files.includes(d)) {
    problems.push(`已追蹤危險檔案：${d}`);
    console.log(`  ${RED}X ${d} 會被上傳${OFF}`);
  } else {
    console.log(`  ${GREEN}OK ${d} 沒有被追蹤${OFF}`);
  }
}

console.log(`\n${CYAN}=== 2. 掃描檔案內容裡的疑似密鑰 ===${OFF}`);
// 前面有 key/secret/token 之類的字，後面接 24 個以上的英數字。
// 會有誤判（雜湊、測試用假值），所以印出來由人判斷，不自動擋。
const re = /(api[_-]?key|secret|passphrase|token|password)\s*[:=]\s*["']?[A-Za-z0-9/+=_-]{24,}/i;

/**
 * 明顯是假值就跳過。
 *
 * 【為什麼要做這件事】
 * 一個會對測試檔裡的 'aaaaaaaa...' 叫的工具，會訓練人忽略它的警告 ——
 * 而那正是它存在的理由失效的那一刻。誤判比漏判更容易毀掉一個檢查工具。
 *
 * 判準刻意保守：只跳過「單一字元重複」與常見的佔位字眼。
 * 真的密鑰不會長這樣。
 */
function isPlaceholder(line) {
  const words = /(example|placeholder|your[_-]?|xxx+|change[_-]?me|todo|dummy|sample|換成|填入|請改)/i;
  if (words.test(line)) return true;
  // 取出引號裡的值，看是不是同一個字元重複
  const q = /["']([A-Za-z0-9/+=_-]{24,})["']/.exec(line);
  if (q && new Set(q[1]).size <= 2) return true;
  return false;
}

let hits = 0;
for (const f of files) {
  if (/\.(png|jpe?g|gif|zip|ico|pdf)$/i.test(f)) continue;
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  text.split('\n').forEach((line, i) => {
    const m = re.exec(line);
    if (!m) return;
    if (line.includes('process.env')) return;   // 讀環境變數，不是硬編碼
    if (isPlaceholder(line)) return;            // 明顯的假值
    hits += 1;
    console.log(`  ${YELLOW}? ${f}:${i + 1}${OFF}`);
    console.log(`     ${line.trim().slice(0, 80)}`);
  });
}
if (hits === 0) {
  console.log(`  ${GREEN}OK 沒有發現疑似硬編碼的密鑰${OFF}`);
} else {
  problems.push(`有 ${hits} 行疑似密鑰，請逐一確認`);
}

console.log(`\n${CYAN}=== 3. 這次會上傳幾個檔案 ===${OFF}`);
console.log(`  共 ${files.length} 個`);

console.log('');
if (problems.length === 0) {
  console.log(`${GREEN}全部通過，可以 commit。${OFF}\n`);
  process.exit(0);
}
console.log(`${RED}發現 ${problems.length} 個問題，先處理再 commit：${OFF}`);
for (const p of problems) console.log(`  ${RED}- ${p}${OFF}`);
console.log('');
console.log(`${YELLOW}若是「已追蹤危險檔案」，把它從追蹤移除（檔案本身會留著）：${OFF}`);
console.log(`${YELLOW}  git rm --cached 那個檔名${OFF}\n`);
process.exit(1);
