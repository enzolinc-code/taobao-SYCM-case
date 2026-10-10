<#
启动一个「带远程调试端口」的 Chrome，供采集脚本接管。
这个 Chrome 用一个独立的数据目录，和你平时用的浏览器互不干扰；第一次要手动登录一次生意参谋，之后登录态会保留。

用法：pwsh -File scripts\start-chrome.ps1
      pwsh -File scripts\start-chrome.ps1 -Port 9222 -ProfileDir "D:\chrome-sycm"
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [string]$ProfileDir = "$env:USERPROFILE\taobao-automation-profile",
    [string]$Chrome = "",
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

function Test-Port([int]$p) {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$p/json/version" -TimeoutSec 3 | Out-Null; return $true }
    catch { return $false }
}

if (Test-Port $Port) {
    Write-Host "[OK] 调试端口 $Port 已经在运行，不用重复启动。" -ForegroundColor Green
    Write-Host "     看标签页：node tools/cdp.mjs tabs" -ForegroundColor DarkGray
    exit 0
}

if (-not $Chrome) {
    $cands = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $Chrome = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Chrome -or -not (Test-Path $Chrome)) {
    throw "没找到 chrome.exe，请用 -Chrome 参数指定完整路径。"
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$chromeArgs = @(
    "--remote-debugging-port=$Port",
    "--remote-allow-origins=*",
    "--user-data-dir=`"$ProfileDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "https://sycm.taobao.com/"
)

Write-Host "启动：" $Chrome
Write-Host "调试端口：" $Port
Write-Host "数据目录：" $ProfileDir
if ($Foreground) {
    & $Chrome @chromeArgs
} else {
    Start-Process -FilePath $Chrome -ArgumentList $chromeArgs | Out-Null
}

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 700
    if (Test-Port $Port) {
        Write-Host "[OK] 调试端口已就绪。" -ForegroundColor Green
        Write-Host "     第一次使用请在这个窗口里手动登录一次生意参谋，然后跑 scripts\open-rank.ps1。" -ForegroundColor Yellow
        exit 0
    }
}
throw "Chrome 起来了但调试端口 $Port 没通。可能已经有另一个 Chrome 用着同一个数据目录，先把它全部关掉再试。"
