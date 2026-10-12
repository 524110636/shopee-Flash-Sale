# 启动本地隔离后端，供浏览器手测管理网站使用。
# 只使用 .agent-tmp 下的隔离数据库，不连生产库、不访问虾皮。
#
# 用法（在仓库根目录执行）：
#   powershell -ExecutionPolicy Bypass -File artifacts/agent/standalone-admin-site/start-iso-backend.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$isoDir = Join-Path $repoRoot '.agent-tmp\standalone-admin-site'
$dataDir = Join-Path $isoDir 'data'
$dbPath = Join-Path $dataDir 'sale.db'

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$env:PORT = '5725'
$env:JWT_SECRET = 'isolated-acceptance-secret-not-for-production-0123456789'
$env:DB_PATH = $dbPath

$port = Get-NetTCPConnection -LocalPort 5725 -State Listen -ErrorAction SilentlyContinue
if ($port) {
  Write-Host "端口 5725 已被占用（PID $($port.OwningProcess)）。请先停掉它再运行本脚本。" -ForegroundColor Yellow
  exit 1
}

Write-Host "隔离数据库：$dbPath"
Write-Host "管理网站入口：http://localhost:5725/admin/"
Write-Host "按 Ctrl+C 停止。" -ForegroundColor Cyan
Write-Host ''

Set-Location (Join-Path $repoRoot 'backend')
npx tsx src/index.ts
