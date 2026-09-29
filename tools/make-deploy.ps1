# ================================================================
# 產生可直接上傳雲端的乾淨資料夾
#
# 用法：在專案根目錄執行
#     powershell -ExecutionPolicy Bypass -File tools\make-deploy.ps1
#
# 為什麼需要這支：
#   .env 裡有交易所金鑰與 Telegram token。它絕不能跟著上傳 ——
#   不只是外洩風險，還有一個更陰險的問題：
#
#   config.js 的讀取順序是「平台環境變數優先，.env 只填補空缺」。
#   若 .env 跟著上去，某個環境變數你漏填了，它會「安靜地」用舊值補上。
#   你以為平台是唯一設定來源，實際上是兩邊合併 —— 這種錯在交易系統上很貴。
#
#   每次都手動挑檔案遲早會挑錯，所以寫成腳本。
# ================================================================

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSScriptRoot
$dst = Join-Path (Split-Path -Parent $src) 'vegas-executor-deploy'

Write-Host '來源：' $src
Write-Host '輸出：' $dst
Write-Host ''

if (Test-Path $dst) {
    Remove-Item $dst -Recurse -Force
}
New-Item -ItemType Directory -Path $dst | Out-Null

# 白名單而非黑名單：要帶什麼是明確列出來的。
# 用排除法的話，哪天多了一個含密鑰的檔案就會默默跟著上去。
$include = @('src', 'test', 'tools')
foreach ($dir in $include) {
    Copy-Item (Join-Path $src $dir) $dst -Recurse
}
foreach ($file in @('package.json', 'README.md', '.env.example', '.gitignore')) {
    $path = Join-Path $src $file
    if (Test-Path $path) { Copy-Item $path $dst }
}

# 最後一道檢查：確認沒有任何 .env 或狀態檔混進去
$leaked = Get-ChildItem $dst -Recurse -Force -Include '.env', 'state.json' -ErrorAction SilentlyContinue
if ($leaked) {
    Write-Host ''
    Write-Host '✗ 偵測到不該上傳的檔案，已中止：' -ForegroundColor Red
    $leaked | ForEach-Object { Write-Host ('   ' + $_.FullName) -ForegroundColor Red }
    Remove-Item $dst -Recurse -Force
    exit 1
}

$count = (Get-ChildItem $dst -Recurse -File).Count
Write-Host ('✓ 完成，共 ' + $count + ' 個檔案，不含 .env 與 data/') -ForegroundColor Green
Write-Host ''
Write-Host '接著把這個資料夾拖到 Zeabur 的 Local Project 上傳區：'
Write-Host ('   ' + $dst)
Write-Host ''
Write-Host '提醒：環境變數要在 Zeabur 的「環境變數」分頁設定，'
Write-Host '      而且 DATA_DIR 必須指向「硬碟」分頁掛載的目錄（例如 /data）。'
