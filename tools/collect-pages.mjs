/* 逐页采集生意参谋「市场排行」当前榜单。
 *
 * 设计原则（重要）：**只走页面交互**——翻页用的是页面自己的翻页按钮，
 * 请求都是页面自己发的。绝不自己拼接口直连（直连会触发全站限流，页面会变「稍后再试」）。
 *
 * 用法：
 *   node tools/collect-pages.mjs --tab market_rank --pages 10 \
 *        --out "data/采集-实时-交易总量.jsonl" --tag "交易总量" [--reset] [--wait 1600]
 *
 * 参数：
 *   --tab    标签页匹配关键字（id / id 前缀 / url 片段 / 标题片段），默认 market_rank
 *   --pages  采集页数，默认 10；**硬上限 10 页**（--allow-more 才放开，防限流）
 *   --reset  先回到第 1 页再开始
 *   --wait   每次翻页后的等待毫秒，默认 1600（不要低于 1500）
 *
 * 产出：<out>.jsonl —— 每行一个商品
 */
import fs from 'node:fs';
import path from 'node:path';
import { listTargets, pickPage, connect, evalInPage, sleep } from './cdp.mjs';
import { ROW_EXPR } from './sycm-rows.mjs';

const args = process.argv.slice(2);
const get = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const TAB = get('tab', 'market_rank');
let PAGES = Number(get('pages', 10));
const OUT = get('out', 'data/collect.jsonl');
const TAG = get('tag', '');
const WAIT_MS = Math.max(1500, Number(get('wait', 1600)));

const MAX_PAGES = 10;
if (PAGES > MAX_PAGES && !args.includes('--allow-more')) {
  console.error(`[风控] 单榜最多 ${MAX_PAGES} 页，已把 ${PAGES} 压到 ${MAX_PAGES}（要用更多页请显式加 --allow-more）`);
  PAGES = MAX_PAGES;
}

const NEXT_EXPR = `(() => {
  const li = document.querySelector('li.ant-pagination-next');
  if (!li) return JSON.stringify({ ok: false, why: 'no-next' });
  const disabled = String(li.className).includes('disabled');
  const a = li.querySelector('a') || li;
  const r = a.getBoundingClientRect();
  return JSON.stringify({ ok: true, disabled, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
})()`;

/* 这个页面的分页控件对合成鼠标事件不响应（实测），JS 点击才生效
 * ——但翻页请求仍然是页面自己发的，不是我们直连接口 */
const NEXT_JS_EXPR = `(() => {
  const li = document.querySelector('li.ant-pagination-next');
  if (!li) return 'no-next';
  if (String(li.className).includes('disabled')) return 'disabled';
  const a = li.querySelector('a') || li;
  a.click();
  return 'clicked';
})()`;

const ACTIVE_EXPR = `(() => { const e = document.querySelector('li.ant-pagination-item-active'); return e ? (e.innerText || '').trim() : ''; })()`;
const GOTO_FIRST_EXPR = `(() => { const e = document.querySelector('li.ant-pagination-item-1'); if (!e) return 'no'; (e.querySelector('a') || e).click(); return 'ok'; })()`;
const FIRST_TITLE_EXPR = `(() => {
  const tr = document.querySelector('div.oui-table-wrapper tbody tr') || document.querySelector('tbody tr');
  return tr ? (tr.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : '';
})()`;

async function main() {
  const t = pickPage(await listTargets(), TAB);
  if (!t) throw new Error('找不到标签页：' + TAB + '（先用 scripts/open-rank.ps1 打开榜单页）');
  const c = await connect(t.webSocketDebuggerUrl);
  const rows = [];
  try {
    // 页面刚打开时会先显示「加载中」，表格是异步出数的；等它真的出数再开始，否则会误判成「没找到表格」
    const readyMs = Number(get('wait-ready', 90000));
    let ready = false;
    for (let waited = 0; waited < readyMs; waited += 2000) {
      const probe = JSON.parse(await evalInPage(c, ROW_EXPR));
      if (probe.ok && probe.rows.length > 0) { ready = true; break; }
      if (waited % 10000 === 0) console.error(`  等页面出数…（已等 ${Math.round(waited / 1000)}s，页面还在“加载中”或榜单为空）`);
      await sleep(2000);
    }
    if (!ready) throw new Error(
      '等了 ' + Math.round(readyMs / 1000) + ' 秒表格还是空的。\n' +
      '  常见原因：① 页面卡在「加载中」——把那个标签页切到前台看一眼；' +
      '② 被限流（页面显示「稍后再试」）——等 30 分钟以上；' +
      '③ 榜单页没选对（统计时间 / 店铺类型 / 类目）。');

    if (args.includes('--reset')) {
      await evalInPage(c, 'window.scrollTo(0, document.body.scrollHeight); "ok"');
      await sleep(400);
      const r0 = await evalInPage(c, GOTO_FIRST_EXPR);
      console.error('回到第 1 页：' + r0);
      await sleep(2500);
    }
    for (let p = 1; p <= PAGES; p++) {
      const data = JSON.parse(await evalInPage(c, ROW_EXPR));
      if (!data.ok) throw new Error('取数失败：' + data.reason);
      const activePage = await evalInPage(c, ACTIVE_EXPR);
      for (const r of data.rows) rows.push({ 页: p, 标签: TAG, ...r });
      console.error(`第 ${p} 页（控件显示第 ${activePage} 页）：${data.rows.length} 条（累计 ${rows.length}）首条：${(data.rows[0] && data.rows[0].title || '').slice(0, 26)}`);
      if (p === PAGES) break;

      // 翻页按钮在表格底部，先滚到底再量坐标，然后真鼠标点击
      await evalInPage(c, 'window.scrollTo(0, document.body.scrollHeight); "ok"');
      await sleep(350);
      const before = await evalInPage(c, FIRST_TITLE_EXPR);
      const nb = JSON.parse(await evalInPage(c, NEXT_EXPR));
      if (!nb.ok || nb.disabled) throw new Error('下一页按钮不可用（ok=' + nb.ok + ' disabled=' + nb.disabled + '）');
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nb.x, y: nb.y, buttons: 0 });
      await sleep(80);
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nb.x, y: nb.y, button: 'left', buttons: 1, clickCount: 1 });
      await sleep(60);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nb.x, y: nb.y, button: 'left', buttons: 0, clickCount: 1 });

      let changed = false;
      for (let i = 0; i < 5; i++) {
        await sleep(500);
        if ((await evalInPage(c, ACTIVE_EXPR)) !== activePage) { changed = true; break; }
      }
      if (!changed) {
        const jsr = await evalInPage(c, NEXT_JS_EXPR);
        console.error(`  真实点击没翻页（active 仍为 ${activePage}），改用 JS 点击：${jsr}`);
      }
      // 等表格真的换页（分页 active 变化 或 首条标题变化）
      for (let i = 0; i < 20; i++) {
        await sleep(WAIT_MS / 3);
        const ap = await evalInPage(c, ACTIVE_EXPR);
        const now = await evalInPage(c, FIRST_TITLE_EXPR);
        if (ap !== activePage || (now && now !== before)) { changed = true; break; }
      }
      if (!changed) throw new Error(`第 ${p} 页翻不动，已停止（避免把同一页数据当多页重复采集）`);
      await sleep(600); // 页面自己的请求间隔，别太急
    }
  } finally {
    c.close();
  }
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const uniq = new Set(rows.map((r) => r.itemLink || r.title)).size;
  process.stdout.write(JSON.stringify({ 标签: TAG, 页数: PAGES, 条数: rows.length, 去重后: uniq, 输出: OUT }, null, 1) + '\n');
}

await main();
