# 上傳 GitHub 之前的最後檢查
#
# 【為什麼需要這支】
# Git 的歷史是永久的。密鑰一旦 commit 進去，之後刪掉檔案也沒用 ——
# 它還在歷史裡，而私有 repo 哪天轉公開，整段歷史跟著公開。
#
# VS Code 的原始檔控制面板看得到「哪些檔案會上傳」，但看不到
# 「檔案裡面有沒有密鑰」。這支補的是後者。
#
# 用法：在專案資料夾按右鍵 →「在終端機中開啟」，然後貼上：
#   powershell -ExecutionPolicy Bypass -File tools\check-before-push.ps1

$ErrorActionPreference = 'Stop'
$problems = @()

Write-Host ""
Write-Host "=== 1. 檢查危險檔案有沒有被追蹤 ===" -ForegroundColor Cyan

# git ls-files 列出「已被 git 追蹤」的檔案。這與「資料夾裡有什麼」不同 ——
# .gitignore 只擋新檔案，已經被追蹤的檔案加進 ignore 也不會自動移除。
$tracked = @(git ls-files 2>$null)
if (-not $tracked) {
    Write-Host "  （還沒 git init，或沒有任何已追蹤的檔案）" -ForegroundColor Yellow
    $tracked = @()
}

$danger = @('.env', 'data/state.json', 'tools/requests.http')
foreach ($d in $danger) {
    if ($tracked -contains $d) {
        $problems += "已追蹤危險檔案：$d"
        Write-Host "  X $d 會被上傳" -ForegroundColor Red
    } else {
        Write-Host "  OK $d 沒有被追蹤" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "=== 2. 掃描已追蹤檔案裡的疑似密鑰 ===" -ForegroundColor Cyan

# 找「像密鑰」的字串：連續 24 個以上的英數字，且前面有 key/secret/token 之類的字。
# 會有誤判（雜湊值、測試用的假金鑰），所以印出來由人判斷，不自動擋。
$pattern = '(?i)(api[_-]?key|secret|passphrase|token|password)\s*[:=]\s*["'']?[A-Za-z0-9/+=_-]{24,}'
$hits = 0
foreach ($f in $tracked) {
    if (-not (Test-Path $f)) { continue }
    if ($f -match '\.(png|jpg|jpeg|gif|zip|ico)$') { continue }
    $m = Select-String -Path $f -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
    foreach ($line in $m) {
        # process.env.XXX 是讀取，不是硬編碼，跳過
        if ($line.Line -match 'process\.env') { continue }
        $hits++
        Write-Host ("  ? {0}:{1}" -f $f, $line.LineNumber) -ForegroundColor Yellow
        Write-Host ("     " + $line.Line.Trim().Substring(0, [Math]::Min(80, $line.Line.Trim().Length)))
    }
}
if ($hits -eq 0) {
    Write-Host "  OK 沒有發現疑似硬編碼的密鑰" -ForegroundColor Green
} else {
    $problems += "有 $hits 行疑似密鑰，請逐一確認"
}

Write-Host ""
Write-Host "=== 3. 這次會上傳幾個檔案 ===" -ForegroundColor Cyan
Write-Host ("  共 {0} 個" -f $tracked.Count)

Write-Host ""
if ($problems.Count -eq 0) {
    Write-Host "全部通過，可以 commit。" -ForegroundColor Green
} else {
    Write-Host "發現 $($problems.Count) 個問題，先處理再 commit：" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
    Write-Host ""
    Write-Host "若是「已追蹤危險檔案」，用這個指令把它從追蹤移除（檔案本身會留著）：" -ForegroundColor Yellow
    Write-Host "  git rm --cached <檔名>" -ForegroundColor Yellow
}
Write-Host ""
