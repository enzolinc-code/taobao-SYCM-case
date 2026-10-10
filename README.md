# 生意参谋 · 手机壳找款器

把「生意参谋 → 市场排行」的找款流程，变成本地几条命令：

**打开榜单 → 逐页采集 → 出带编号的大缩略图汇总 → 按当天支付买家数分档 → 切出能直接看的看图切片。**

不用手工截图、不用一页页复制粘贴，也不用写接口调用。全程只走**页面交互**（翻页用的是页面自己的按钮），
请求都是浏览器自己发的，风控风险最低。

---

## 它产出什么

一次运行（默认：手机保护套/壳 · 实时榜 · 淘宝 · 不限价格 · 交易总量 + 交易增速 各 10 页）：

| 产出 | 说明 |
|---|---|
| `汇总图-交易总量/` | 该榜 100 条，按当天支付买家数从高到低排，带编号的大缩略图 + 清单 CSV |
| `汇总图-交易增速/` | 同上，增速榜 |
| `汇总图-合并-<标签>/` | 两榜合并去重，每个商品标明出现在哪个榜 |
| `…/250以上/` `…/100-250/` `…/50-100/` `…/10-50/` `…/1-9件/` | 按你要的档位分开出图，每档一份清单 |
| `…/<档>/_看图/` | 每档再切一版「聊天窗口里能直接看清」的切片，每片 5×5、宽 1280 |

每个格子下面标三行信息：

```
┌──────────────┐
│              │   ① 商品主图
│   商品主图    │
│              │
├──────────────┤
│ 12    50 ~ 100 │   ② 白色 = 编号   黄色 = 当天支付买家数档
│ 访 1万 ~ 2.5万 总量 │   ③ 青色 = 访客数档 + 来自哪个榜
└──────────────┘
```

编号对得上 CSV 清单里的「序号 / 商品链接 / 店铺」，看图挑中哪一格，直接去清单里查链接。

---

## 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 22** | 用到内置的 `fetch` / `WebSocket`，无需 npm install |
| Python | ≥ 3.9 | 只出图用，需要装 Pillow |
| Chrome | 任意近期版本 | 要用「带远程调试端口」的方式启动 |
| 账号 | 生意参谋（免费版即可） | 市场排行是免费模块 |

Windows / macOS / Linux 都能跑。一键脚本目前只写了 PowerShell（Windows）；
macOS / Linux 直接敲下面的命令即可，路径换成单引号。

---

## 安装

```powershell
git clone <你的仓库地址> sycm-phonecase-finder
cd sycm-phonecase-finder

# 1) Python 依赖
python -m pip install -r requirements.txt

# 2) 环境体检（会告诉你缺什么）
pwsh -File scripts\check-env.ps1

# 3) 启动一个带调试端口的 Chrome（独立数据目录，和你平时用的浏览器互不干扰）
pwsh -File scripts\start-chrome.ps1
#    第一次要在这个窗口里手动登录一次生意参谋，登录态会保留

# 4) 后台打开榜单页
pwsh -File scripts\open-rank.ps1
```

---

## 快速开始

页面准备好之后，一条命令跑完全流程：

```powershell
pwsh -File scripts\run-daily.ps1
```

跑完在 `data\<日期>\` 下拿结果。

也可以分步跑（想自己控制节奏时用这个）：

```powershell
# 采集交易总量榜 10 页
node tools/collect-pages.mjs --tab market_rank --pages 10 --reset --tag 交易总量 --out "data/采集-交易总量.jsonl"

# 出这个大缩略图 + 清单
python tools/sheets-from-jsonl.py --jsonl "data/采集-交易总量.jsonl" --out-dir "data/汇总图-交易总量" --tag 交易总量

# 两榜合并 + 只看某一档
python tools/merge-ranks.py --csv "data/汇总图-交易总量/清单-交易总量.csv" "data/汇总图-交易增速/清单-交易增速.csv" `
    --out-dir "data/合并" --tag "100-250" --band "100 ~ 250"

# 切成能直接看的看图切片
python tools/sheet-slices.py --csv "data/合并/清单-100-250.csv" --out-dir "data/合并" --tag "100-250"
```

切片的文件名是 `<档>_看图_01.jpg`，直接贴进聊天窗口就能看清每格图案。

---

## 命令速查

### 页面准备

| 命令 | 作用 |
|---|---|
| `pwsh -File scripts\check-env.ps1` | 环境体检（Node / Python / Pillow / 字体 / 调试端口） |
| `pwsh -File scripts\start-chrome.ps1` | 启动带 `--remote-debugging-port=9222` 的 Chrome |
| `pwsh -File scripts\open-rank.ps1` | 后台打开生意参谋榜单页 |
| `node tools/cdp.mjs tabs` | 列出当前所有标签页（确认页面在不在、网址对不对） |
| `node tools/cdp.mjs clicktext market_rank 淘宝` | 按可见文字点一下（切店铺类型 / 切榜单都能用） |

### 采集

| 命令 | 作用 |
|---|---|
| `node tools/sycm-table.mjs market_rank data/快照` | 只抓当前这一屏，出 json / csv / md（看一眼用） |
| `node tools/collect-pages.mjs --tab market_rank --pages 10 --out <文件.jsonl> --tag <标签>` | 逐页采集整榜 |

`collect-pages.mjs` 的参数：`--reset` 先回第 1 页；`--wait` 翻页间隔（最低 1500ms）；
单榜最多 10 页是**硬上限**，要更多得显式加 `--allow-more`。

### 出图与筛选

| 命令 | 作用 |
|---|---|
| `python tools/sheets-from-jsonl.py --jsonl <采集.jsonl> --out-dir <目录> --tag <标签>` | 下主图 + 按买家数排序出带编号大图 + 清单 |
| `python tools/merge-ranks.py --csv <清单.csv ...> --out-dir <目录> --tag <标签> [--band/--min/--max]` | 合并去重 + 按档出图 |
| `python tools/sheet-slices.py --csv <清单.csv> --out-dir <目录> --tag <标签>` | 切成看图切片 |
| `node tools/filter-feilin.mjs <采集.jsonl> <输出前缀>` | 按规则（图案词/排除词/买家数档）过一遍标题，出候选清单 |

分档四刀的写法：

```
--min 250            只看 250 以上
--band "100 ~ 250"   只看 100-250
--band "50 ~ 100"    只看 50-100
--band "10 ~ 50"     只看 10-50
--max 9              只看 1-9 件
```

---

## 配置

两个配置文件，改完直接重跑，不用碰代码。

**`config/collect.json`** —— 采集口径：榜单页地址、类目、店铺类型、价格带、页数、榜单列表、
分档出图的档位、风控上限。

**`config/filter.json`** —— 规则筛选口径：硬条件（当天支付买家数）、买家数分档、
图案特征词 / 排除词、菲林壳不适配的工艺词。

换类目只要改 `config/collect.json` 里的 `榜单页` 和 `类目` 的 `cateId / parentCateId`。

---

## 操作录制（可选模块）

`tools/rec/` 是一套「记录鼠标键盘 + 页面请求」的小工具，用来把一个手工操作流程录下来、
再整理成能复现的步骤（早期就是用这个把找款流程一步步录下来的）。

```powershell
node tools/rec/rec.mjs tabs                          # 有哪些标签页
node tools/rec/rec.mjs install sycm.taobao.com       # 注入录制器
node tools/rec/rec.mjs mark sycm.taobao.com "点开市场排行"
node tools/rec/rec.mjs click sycm.taobao.com 812 63  # 真鼠标点击（会被录下来）
node tools/rec/rec.mjs dump sycm.taobao.com "录制/操作记录-20261008" --md
node tools/rec/analyze-rec.mjs "录制/操作记录-20261008/全部事件.jsonl"
```

不用录制功能的话，这一整个目录可以删掉，不影响主流程。

---

## 常见问题

**Q：`连不上 Chrome 调试端口 9222`**
先跑 `scripts\start-chrome.ps1`。如果报「起来了但端口没通」，通常是你本来就有别的 Chrome
用着同一个数据目录 —— 把它全部关掉再启动。

**Q：页面显示「稍后再试」/ 榜单空白**
被限流了。**不要直链榜单接口**（这样会把整个会话限流几十分钟）。
等 30-45 分钟，之后只用 `collect-pages.mjs` 走页面翻页。

**Q：标签页找不到 `market_rank`**
用 `node tools/cdp.mjs tabs` 看实际网址。`--tab` 支持按标题/id/网址片段匹配，
也可以直接传 `sycm.taobao.com`。

**Q：汇总图上中文是方框**
没找到中文字体。设环境变量 `SYCM_FONT` 指向任意中文 ttf/ttc，
例如 `$env:SYCM_FONT="C:\Windows\Fonts\msyh.ttc"`。

**Q：有几张主图没下下来**
会单独写一份 `清单-<标签>-缺图.csv`，里面带原图地址，可以手工补看。
重跑脚本会跳过已下载的图，只补缺的。

**Q：想抓昨天的而不是当天**
在页面上把「统计时间」切成「日」并选日期，再跑
`node tools/collect-pages.mjs ...`（加 `--reset` 从第一页开始）。
采集脚本只读当前页面显示的内容，不关心你选的是哪一天。

---

## 使用纪律与风险提示

1. **只走页面交互。** 不要绕开页面直接请求榜单接口 —— 会触发全站限流。
2. **别贪快。** 单榜 ≤10 页、翻页间隔 ≥1.5 秒、单次运行 ≤4 个榜；这些上限代码里已经强制生效。
3. **数据自己在本地。** `data/` 已在 `.gitignore` 里，采集结果不会进仓库。
   但**注意不要把自己店铺的经营数据截图/导出文件提交上去**。
4. **登录态。** 脚本接管的是你自己已登录的 Chrome，不保存、不上传任何 Cookie 或密码。
   换电脑要重新登录一次。
5. **合规使用。** 请遵守生意参谋/淘宝的用户协议与 robots 约定，仅用于自己店铺的选品参考，
   不要高频抓取、不要对外分发抓来的数据。风险自负。
6. **图片版权。** 榜单里是别家店铺的商品图，只用于选品参考；
   拿去做菲林壳图案前请自行确认版权与授权。

---

## 目录结构

```
sycm-phonecase-finder/
├─ config/
│  ├─ collect.json          采集口径（榜单页 / 类目 / 页数 / 分档）
│  └─ filter.json           规则筛选口径（图案词 / 买家数分档）
├─ tools/
│  ├─ cdp.mjs               Chrome CDP 连接层 + 命令行小工具
│  ├─ sycm-rows.mjs         榜单行提取（纯读 DOM）
│  ├─ collect-pages.mjs     逐页采集
│  ├─ sycm-table.mjs        当前屏快照
│  ├─ filter-feilin.mjs     按规则筛标题
│  ├─ sheets-from-jsonl.py  主图下载 + 带编号大缩略图 + 清单
│  ├─ merge-ranks.py        多榜合并去重 + 按档出图
│  ├─ sheet-slices.py       看图切片
│  ├─ sheetlib.py           出图公共组件（字体 / 裁切 / 下载）
│  └─ rec/                  操作录制回放（可选）
├─ scripts/
│  ├─ check-env.ps1         环境体检
│  ├─ start-chrome.ps1      启动带调试端口的 Chrome
│  ├─ open-rank.ps1         打开榜单页
│  └─ run-daily.ps1         一键全流程
├─ docs/
│  ├─ 使用手册.md           逐步操作说明
│  ├─ 风控与纪律.md         限流怎么来的、怎么避
│  └─ 优化路线.md           还没做但值得做的功能
└─ data/                    采集与出图输出（已 gitignore）
```

---

## License

MIT
