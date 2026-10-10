<#
环境体检。首次部署后先跑这个，确认缺什么。
用法：pwsh -File scripts\check-env.ps1
      powershell -ExecutionPolicy Bypass -File scripts\check-env.ps1
#>
[CmdletBinding()]
param(
    [string]$Python = ""
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$ok = 0; $bad = 0
function Say([string]$mark, [string]$text, [string]$hint = "") {
    $color = if ($mark -eq 'OK') { 'Green' } elseif ($mark -eq 'WARN') { 'Yellow' } else { 'Red' }
    Write-Host ("[{0}] {1}" -f $mark, $text) -ForegroundColor $color
    if ($hint) { Write-Host ("      → " + $hint) -ForegroundColor DarkGray }
}

Write-Host "== 生意参谋手机壳找款器 · 环境体检 ==" -ForegroundColor Cyan
Write-Host ("项目目录：" + $root)

# 1) Node
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $nv = (& node --version) -replace '^v', ''
    $major = [int]($nv.Split('.')[0])
    if ($major -ge 22) { Say OK ("Node " + $nv); $ok++ }
    else { Say BAD ("Node " + $nv + " 太旧") "本项目用到 Node 内置的 fetch / WebSocket，需要 Node 22 以上：https://nodejs.org"; $bad++ }
} else {
    Say BAD "没装 Node" "去 https://nodejs.org 装 LTS（22 或更新），装完重开一个终端再跑这个脚本"; $bad++
}

# 2) Python + Pillow
$pyCmd = $null
if ($Python) { $pyCmd = $Python }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $pyCmd = 'python' }
elseif (Get-Command py -ErrorAction SilentlyContinue) { $pyCmd = 'py' }
if ($pyCmd) {
    $ver = (& $pyCmd -c "import sys;print(sys.version.split()[0])" 2>&1) | Select-Object -First 1
    if ($LASTEXITCODE -eq 0) { Say OK ("Python " + $ver + "（" + $pyCmd + "）"); $ok++ }
    else { Say BAD ("Python 跑不起来：" + $ver) "装 Python 3.9+，或用 -Python 参数指定解释器路径"; $bad++ }
    $pil = (& $pyCmd -c "import PIL;print(PIL.__version__)" 2>&1) | Select-Object -First 1
    if ($LASTEXITCODE -eq 0) { Say OK ("Pillow " + $pil); $ok++ }
    else { Say BAD "没装 Pillow（出图要用）" ("跑：" + $pyCmd + " -m pip install -r requirements.txt"); $bad++ }
} else {
    Say BAD "没找到 python" "装 Python 3.9+ 并勾选 Add to PATH；或用 -Python 参数指定解释器路径"; $bad++
}

# 3) 中文字体（汇总图上的中文标签）
$font = @("$env:SYCM_FONT", "C:\Windows\Fonts\msyh.ttc", "C:\Windows\Fonts\simhei.ttf",
          "/System/Library/Fonts/PingFang.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc") |
        Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if ($font) { Say OK ("中文字体：" + $font); $ok++ }
else { Say WARN "没找到中文字体，汇总图上的中文会变方框" "设环境变量 SYCM_FONT 指向任意中文 ttf/ttc 即可" }

# 4) Chrome 调试端口
$cfg = Join-Path $root 'config\collect.json'
$port = 9222
if (Test-Path $cfg) {
    try { $port = (Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json).'cdp端口' } catch { }
}
try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 3
    Say OK ("Chrome 调试端口 $port 已开（" + $v.Browser + "）"); $ok++
    $tabs = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3
    $hit = $tabs | Where-Object { $_.url -like '*sycm.taobao.com*' }
    if ($hit) { Say OK ("已登录的生意参谋标签页：" + $hit.Count + " 个") }
    else { Say WARN "没看到生意参谋的标签页" "跑 scripts\open-rank.ps1 打开榜单页，并确认已登录" }
} catch {
    Say WARN ("Chrome 调试端口 $port 没开") "跑 scripts\start-chrome.ps1 启动 Chrome（带调试端口）"; 
}

Write-Host ""
Write-Host ("体检结束：OK " + $ok + " 项，待处理 " + $bad + " 项") -ForegroundColor Cyan
