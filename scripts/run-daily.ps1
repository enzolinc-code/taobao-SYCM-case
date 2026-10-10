<#
一键跑完「当天实时榜」找款全流程：
  1) 确认 Chrome 调试端口 / 打开榜单页 / 选中「淘宝」
  2) 逐页采集 交易总量榜 + 交易增速榜
  3) 每个榜出带编号的大缩略图 + 清单 CSV
  4) 两榜合并去重，并按支付买家数分档出图（250以上 / 100-250 / 50-100 / 10-50 / 1-9件）
  5) 每档再切一版「聊天窗口能直接看清」的看图切片

用法：
  pwsh -File scripts\run-daily.ps1
  pwsh -File scripts\run-daily.ps1 -Pages 10 -SkipBrowser      # 页面已经准备好了
  pwsh -File scripts\run-daily.ps1 -Python "C:\Python312\python.exe"
#>
[CmdletBinding()]
param(
    [int]$Pages = 10,
    [string]$Python = "",
    [string]$Tag = "实时淘宝",
    [switch]$SkipBrowser,
    [switch]$OnlySheet          # 跳过采集，只用现有 jsonl 重新出图
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$cfg = Get-Content (Join-Path $root 'config\collect.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$port = if ($cfg.'cdp端口') { $cfg.'cdp端口' } else { 9222 }
$env:CDP_PORT = "$port"

if (-not $Python) {
    if (Get-Command python -ErrorAction SilentlyContinue) { $Python = 'python' }
    elseif (Get-Command py -ErrorAction SilentlyContinue) { $Python = 'py' }
    else { throw "没找到 python，请用 -Python 参数指定解释器路径" }
}

# 分档定义统一从 config/collect.json 读，改配置不用改脚本
$bands = @($cfg.'分档出图')
if (-not $bands -or $bands.Count -eq 0) {
    $bands = @(
        [pscustomobject]@{ '标签' = '250以上'; '参数' = @('--min', '250') },
        [pscustomobject]@{ '标签' = '100-250'; '参数' = @('--band', '100 ~ 250') },
        [pscustomobject]@{ '标签' = '50-100';  '参数' = @('--band', '50 ~ 100') },
        [pscustomobject]@{ '标签' = '10-50';   '参数' = @('--band', '10 ~ 50') },
        [pscustomobject]@{ '标签' = '1-9件';   '参数' = @('--max', '9') }
    )
}

$date = Get-Date -Format 'yyyyMMdd'
$dayDir = Join-Path $root ("data\" + $date)
New-Item -ItemType Directory -Force -Path $dayDir | Out-Null
Write-Host ("== 找款 " + $date + " ｜ 输出目录：" + $dayDir + " ==") -ForegroundColor Cyan

# ---------- 1. 页面准备 ----------
if (-not $SkipBrowser -and -not $OnlySheet) {
    $alive = $false
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 3 | Out-Null; $alive = $true } catch { }
    if (-not $alive) {
        Write-Host "调试端口没开，先启动 Chrome..." -ForegroundColor Yellow
        & (Join-Path $PSScriptRoot 'start-chrome.ps1') -Port $port
    }

    $tabs = (& node tools/cdp.mjs tabs) -join "`n"
    if ($tabs -notmatch 'market_rank') {
        & (Join-Path $PSScriptRoot 'open-rank.ps1')
        Write-Host "等页面加载..." -ForegroundColor DarkGray
        Start-Sleep -Seconds 10
    }

    # 店铺类型选「淘宝」（页面默认可能是「全部店铺」）；页面刚打开时控件可能还没渲染，重试几次
    Write-Host "选中店铺类型：淘宝" -ForegroundColor DarkGray
    for ($try = 1; $try -le 5; $try++) {
        $r = (& node tools/cdp.mjs clicktext market_rank "淘宝") -join ' '
        if ($r -match '"ok":\s*true') { break }
        Write-Host ("  控件还没出来，等 3 秒再试（第 " + $try + " 次）") -ForegroundColor DarkGray
        Start-Sleep -Seconds 3
    }
    Start-Sleep -Seconds 3
}

# ---------- 2 & 3. 逐榜采集 + 出图 ----------
$lists = @()
$rankNo = 0
foreach ($rank in @($cfg.'榜单')) {
    $rankNo++
    $name = $rank.'名称'
    if (-not $name) { continue }

    if (-not $OnlySheet) {
        if ($rankNo -gt 1) {
            Write-Host ("切换到榜单：" + $name) -ForegroundColor DarkGray
            & node tools/cdp.mjs clicktext market_rank $name
            Start-Sleep -Seconds 5
        }
        $jsonl = Join-Path $dayDir ("采集-" + $name + ".jsonl")
        Write-Host ("--- 采集「" + $name + "」" + $Pages + " 页 ---") -ForegroundColor Cyan
        & node tools/collect-pages.mjs --tab market_rank --pages $Pages --reset --tag $name --out $jsonl
    } else {
        $jsonl = Join-Path $dayDir ("采集-" + $name + ".jsonl")
    }
    if (-not (Test-Path $jsonl)) { throw ("没找到采集结果：" + $jsonl) }

    Write-Host ("--- 出图「" + $name + "」 ---") -ForegroundColor Cyan
    $sheetDir = Join-Path $dayDir ("汇总图-" + $name)
    & $Python -X utf8 tools/sheets-from-jsonl.py --jsonl $jsonl --out-dir $sheetDir --tag $name
    $lists += (Join-Path $sheetDir ("清单-" + $name + ".csv"))
}

# ---------- 4. 合并去重 + 分档 ----------
$mergeDir = Join-Path $dayDir ("汇总图-合并-" + $Tag)
New-Item -ItemType Directory -Force -Path $mergeDir | Out-Null
Write-Host "--- 合并两榜 ---" -ForegroundColor Cyan
& $Python -X utf8 tools/merge-ranks.py --csv @lists --out-dir $mergeDir --tag ("合并-" + $Tag)

$bandCsv = @()
foreach ($band in $bands) {
    $label = $band.'标签'
    $extra = @($band.'参数')
    $outDir = Join-Path $mergeDir $label
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    Write-Host ("--- 分档出图：" + $label + " ---") -ForegroundColor Cyan
    & $Python -X utf8 tools/merge-ranks.py --csv @lists --out-dir $outDir --tag $label @extra
    $bandCsv += (Join-Path $outDir ("清单-" + $label + ".csv"))
}

# ---------- 5. 看图切片 ----------
Write-Host "--- 生成看图切片 ---" -ForegroundColor Cyan
foreach ($csv in $bandCsv) {
    if (-not (Test-Path $csv)) { continue }
    $label = (Split-Path $csv -Leaf) -replace '^清单-', '' -replace '\.csv$', ''
    $outDir = Split-Path $csv -Parent
    & $Python -X utf8 tools/sheet-slices.py --csv $csv --out-dir $outDir --tag $label
}

# ---------- 汇总 ----------
Write-Host ""
Write-Host "== 完成。产出清单 ==" -ForegroundColor Green
Write-Host ("逐榜大图    ：" + (Join-Path $dayDir "汇总图-交易总量") + " / 汇总图-交易增速")
Write-Host ("合并大图    ：" + $mergeDir)
foreach ($band in $bands) {
    $d = Join-Path $mergeDir ($band.'标签')
    $n = 0
    if (Test-Path $d) { $n = (Get-ChildItem $d -Filter '*.jpg' -File).Count }
    Write-Host ("  · " + $band.'标签'.PadRight(8) + " 汇总图 $n 张  → $d")
}
Write-Host ""
Write-Host "看图切片（可直接贴进对话）：" -ForegroundColor Cyan
Get-ChildItem $mergeDir -Recurse -Directory -Filter '_看图' | ForEach-Object {
    Write-Host ("  " + $_.FullName)
    Get-ChildItem $_.FullName -Filter '*.jpg' | ForEach-Object { Write-Host ("    " + $_.Name) }
}
