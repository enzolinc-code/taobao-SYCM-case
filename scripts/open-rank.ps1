<#
在已经带调试端口的 Chrome 里，后台打开生意参谋「市场排行」榜单页。

用法：pwsh -File scripts\open-rank.ps1
      pwsh -File scripts\open-rank.ps1 -Url "https://sycm.taobao.com/mc/free/market_rank?..."
      pwsh -File scripts\open-rank.ps1 -Foreground
#>
[CmdletBinding()]
param(
    [string]$Url = "",
    [string]$TabKey = "market_rank",
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Url) {
    $cfgPath = Join-Path $root 'config\collect.json'
    if (-not (Test-Path $cfgPath)) { throw "找不到 config\collect.json" }
    $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Url = $cfg.'榜单页'
    if (-not $Url) { throw "config\collect.json 里的「榜单页」是空的" }
}

Write-Host "打开：" $Url -ForegroundColor Cyan
$cmd = if ($Foreground) { 'newtabfg' } else { 'newtab' }
& node tools/cdp.mjs $cmd $Url | Out-Null

for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 800
    $tabs = & node tools/cdp.mjs tabs
    if ($tabs -match [regex]::Escape($TabKey)) { break }
}
Write-Host "[OK] 当前标签页：" -ForegroundColor Green
& node tools/cdp.mjs tabs
Write-Host ""
Write-Host "如果页面还停在登录页，请在那个 Chrome 里手动登录一次。" -ForegroundColor Yellow
