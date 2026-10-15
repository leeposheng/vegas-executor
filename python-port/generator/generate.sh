#!/usr/bin/env bash
# 重新產生黃金向量。用法：./generate.sh <node 版 vegas-executor 的 src 目錄> <輸出目錄>
# 例：./generate.sh ../../src ../vectors      （Node 18+，不需 npm install）
set -euo pipefail
SRC="$(cd "$1" && pwd)"; OUT="$2"; HERE="$(cd "$(dirname "$0")" && pwd)"
node "$HERE/gen.js" "$SRC" "$OUT"
node "$HERE/gen_pipeline.js" "$SRC" "$OUT"
node "$HERE/gen_config.js" "$SRC" "$OUT"
node "$HERE/gen_reconcile.js" "$SRC" "$OUT"
node "$HERE/gen_okx_net.js" "$SRC" "$OUT"
node "$HERE/gen_fuzz.js" "$SRC" "$OUT"
# 模組 A：在假 GAS 環境執行原版 Code.gs（generator/gas/Code.gs）
node "$HERE/gen_intake.js" "$HERE/gas/Code.gs" "$OUT"
# 模組 B：Executor.gs（轉送／卡片／補送）
node "$HERE/gen_bot.js" "$HERE/gas/Code.gs" "$HERE/gas/Executor.gs" "$OUT"
# 模組 C：按鈕回呼
node "$HERE/gen_cb.js" "$HERE/gas/Code.gs" "$HERE/gas/Executor.gs" "$OUT"
# 模組 D：文字指令與問答
node "$HERE/gen_dm.js" "$HERE/gas/Code.gs" "$HERE/gas/Executor.gs" "$OUT"
# 模組 E：CHART-IMG 圖表與 sendPhoto
node "$HERE/gen_chart.js" "$HERE/gas/Code.gs" "$HERE/gas/Executor.gs" "$OUT"
# 模組 F：系統日誌欄位規則
node "$HERE/gen_syslog.js" "$HERE/gas/Code.gs" "$HERE/gas/Executor.gs" "$OUT"
# 模組 G：Webhook 管理
node "$HERE/gen_wh.js" "$HERE/gas/Code.gs" "$HERE/gas/Executor.gs" "$OUT"
