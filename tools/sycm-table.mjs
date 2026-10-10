/* 把榜单页「当前这一屏」抓成结构化快照（纯读 DOM，不额外发请求）。
 * 想要整榜多页用 collect-pages.mjs；这个只用于「看一眼现在页面上是什么」。
 *
 * 用法：node tools/sycm-table.mjs <标签页关键字> <输出前缀>
 * 产出：<输出前缀>.json / .csv / .md
 */
import fs from 'node:fs';
import path from 'node:path';
import { withPage, evalInPage } from './cdp.mjs';
import { ROW_EXPR } from './sycm-rows.mjs';

const [, , tabKey, outBase] = process.argv;
if (!tabKey || !outBase) {
  console.error('用法：node tools/sycm-table.mjs <标签页关键字> <输出前缀>');
  process.exit(1);
}

const raw = await withPage(tabKey, (c) => evalInPage(c, ROW_EXPR));
const data = JSON.parse(raw);
if (!data.ok) {
  const loading = /加载中/.test(data.bodyHead || '');
  console.error('抓取失败：' + data.reason + '｜页面文字：' + (data.bodyHead || ''));
  if (loading) console.error('提示：页面还停在「加载中」，表格是异步出数的，等几秒再试一次。');
  process.exit(2);
}

fs.mkdirSync(path.dirname(path.resolve(outBase)), { recursive: true });
fs.writeFileSync(outBase + '.json', JSON.stringify(data, null, 1), 'utf8');

const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
const csv = [data.heads.map(esc).join(','), ...data.rows.map((r) => r.cells.map(esc).join(','))].join('\r\n');
fs.writeFileSync(outBase + '.csv', '\ufeff' + csv + '\r\n', 'utf8');

const md = ['# 生意参谋榜单快照', '', `- 页面：${data.url}`, `- 行数：${data.rows.length}`, `- 表头：${data.heads.join(' / ')}`, '',
  '| 排名 | 商品 | 店铺 | 支付买家数 | 访客数 |', '|---|---|---|---|---|',
  ...data.rows.map((r) => `| ${r.rank || ''} | ${String(r.title || '').replace(/\|/g, '/')} | ${r.shop || ''} | ${r.buyers || ''} | ${r.visitors || ''} |`),
  ''].join('\n');
fs.writeFileSync(outBase + '.md', md, 'utf8');

process.stdout.write(JSON.stringify({ out: outBase, rows: data.rows.length, heads: data.heads, url: data.url }, null, 1) + '\n');
