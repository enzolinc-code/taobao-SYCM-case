/* 手机壳找款筛选（v3）：从榜单数据里挑出「能印菲林壳 + 明显图案 + 当天有支付买家数」的链接，
 * 并按支付买家数分档排序（100~250 / 50~100 / 10~50 / 0~10 备选）。
 *
 * 说明：生意参谋大表里的「支付买家数」是**区间档**（"10 ~ 50" 这种），原生小表里是精确数字，两种都支持。
 *      档位判断用区间下限（"50 ~ 100" 归到 50-100 档）；硬条件「当天有支付买家数」用区间上限判断。
 *
 * 用法：
 *   node tools/filter-feilin.mjs <输入.json|.jsonl|.csv> <输出前缀> [--min-buyers 1] [--with-备选]
 * 规则在 config/filter.json。
 * 产出：<输出前缀>-候选.csv / -候选.md / -待看图.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, '..', 'config', 'filter.json');

const args = process.argv.slice(2);
const input = args[0];
const outBase = args[1];
if (!input || !outBase) {
  console.error('用法：node tools/filter-feilin.mjs <输入> <输出前缀> [--min-buyers 1] [--with-备选]');
  process.exit(1);
}
const minIdx = args.indexOf('--min-buyers');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const minBuyers = minIdx >= 0 ? Number(args[minIdx + 1]) : (cfg['硬条件']['支付买家数最少'] || 1);
const bands = cfg['支付买家数分档'] || [];
const patternWords = cfg['图案特征']['图案词'] || [];
const patternExcl = cfg['图案特征']['排除词'] || [];
const mustPattern = !!cfg['图案特征']['必须命中图案词'];
const craftExcl = cfg['菲林壳适配']['排除词'] || [];

function loadRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  const norm = (o, cells, fallbackImgs) => ({
    cells: cells || [],
    title: o.title || cells?.[1] || '',
    itemLink: o.itemLink || null,
    shop: o.shop || cells?.[2] || '',
    buyers: o.buyers ?? cells?.[3],
    visitors: o.visitors ?? cells?.[4],
    imgs: o.imgs || fallbackImgs || [],
  });
  if (file.endsWith('.csv')) {
    const lines = text.replace(/^\ufeff/, '').split(/\r?\n/).filter(Boolean);
    return lines.slice(1).map((l) => {
      const cells = (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
      return norm({ title: cells[1], shop: cells[2], buyers: cells[3], visitors: cells[4] }, cells);
    });
  }
  if (file.endsWith('.jsonl')) {
    return text.split(/\r?\n/).filter(Boolean).map((l) => {
      const o = JSON.parse(l);
      return norm(o, o.cells || []);
    });
  }
  const j = JSON.parse(text);
  const rows = j.rows || j;
  return rows.map((r) => norm({ ...r, itemLink: r.itemLink || (r.links && r.links[0]) || null }, r.cells || []));
}

// "10 ~ 50" / "100-250" / 12 / "1,234" 都解析成 {min,max,exact}
const rangeOf = (v) => {
  if (typeof v === 'number') return { min: v, max: v, exact: true };
  const s = String(v == null ? '' : v);
  const m = s.match(/(\d[\d,]*)\s*[~～\-–—至]\s*(\d[\d,]*)/);
  if (m) return { min: Number(m[1].replace(/,/g, '')), max: Number(m[2].replace(/,/g, '')), exact: false };
  const n = s.match(/(\d[\d,]*)/);
  return n ? { min: Number(n[1].replace(/,/g, '')), max: Number(n[1].replace(/,/g, '')), exact: true } : null;
};
const bandOf = (min) => bands.find((b) => min >= b['最小'] && min <= b['最大']) || null;

const rows = loadRows(input).filter((r) => r.title || r.itemLink);
const rowsOut = [];
const needLook = [];
let skippedNoBuyers = 0, skippedCraft = 0, skippedNoPattern = 0;
for (const r of rows) {
  const title = String(r.title || '');
  const b = rangeOf(r.buyers);
  if (!b || b.max < minBuyers) { skippedNoBuyers++; continue; }
  const band = bandOf(b.min);
  if (!band) { skippedNoBuyers++; continue; }
  if (band['档'] === '备选' && !args.includes('--with-备选')) continue;
  const hitCraft = craftExcl.filter((w) => title.includes(w));
  if (hitCraft.length) { skippedCraft++; continue; }
  const hitPatternExcl = patternExcl.filter((w) => title.includes(w));
  if (hitPatternExcl.length) { skippedNoPattern++; continue; }
  const hitPattern = patternWords.filter((w) => title.includes(w));
  if (mustPattern && !hitPattern.length) continue;
  const signal = hitPattern.length ? '标题有图案词' : '标题没说图案（要靠主图判断）';
  const rec = {
    档: band['档'], 支付买家数档: String(r.buyers), 支付买家数下限: b.min,
    访客数: String(r.visitors ?? ''), 商品标题: title,
    商品链接: r.itemLink || '', 店铺: r.shop || '',
    图案信号: signal, 命中图案词: hitPattern.join('/'), 主图: (r.imgs || [])[0] || '',
  };
  rowsOut.push(rec);
  if (!hitPattern.length) needLook.push({ 商品标题: title, 商品链接: rec.商品链接, 主图: rec.主图, 支付买家数档: rec.支付买家数档, 档: band['档'] });
}

const bandOrder = {};
bands.forEach((b, i) => { bandOrder[b['档']] = i; });
const sigOrder = (s) => (s === '标题有图案词' ? 0 : 1);
rowsOut.sort((a, b) => (bandOrder[a.档] - bandOrder[b.档]) || (sigOrder(a.图案信号) - sigOrder(b.图案信号)) || (b.支付买家数下限 - a.支付买家数下限));

fs.mkdirSync(path.dirname(outBase), { recursive: true });
const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
const cols = ['档', '支付买家数档', '访客数', '商品标题', '商品链接', '店铺', '图案信号', '命中图案词'];
fs.writeFileSync(outBase + '-候选.csv', '\ufeff' + [cols.map(esc).join(','), ...rowsOut.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n', 'utf8');

const count = (k) => rowsOut.filter((r) => r.档 === k).length;
const section = (k, title) => [
  `## ${title}：${count(k)} 条`, '',
  '| 支付买家数 | 商品 | 店铺 | 图案信号 |', '|---|---|---|---|',
  ...rowsOut.filter((r) => r.档 === k).map((r) => `| ${r.支付买家数档} | ${r.商品标题.replace(/\|/g, '/')} | ${r.店铺} | ${r.图案信号} |`),
  '',
];
const md = [
  '# 手机壳找款 · 菲林壳候选', '',
  `- 输入：${input}（共 ${rows.length} 条）`,
  `- 入选：${rowsOut.length} 条 —— 第一优先(100~250) ${count('第一优先')} ｜ 第二优先(50~100) ${count('第二优先')} ｜ 第三优先(10~50) ${count('第三优先')} ｜ 备选(0~10) ${count('备选')}`,
  `- 被挡掉：买家数不达标/无买家数 ${skippedNoBuyers} 条 ｜ 非平面工艺 ${skippedCraft} 条 ｜ 纯色/无图案 ${skippedNoPattern} 条`,
  '', ...section('第一优先', '第一优先（支付买家数 100 ~ 250）'),
  ...section('第二优先', '第二优先（50 ~ 100）'),
  ...section('第三优先', '第三优先（10 ~ 50）'),
  ...section('备选', '备选（0 ~ 10）'),
  `## 需要看图确认的（标题没写图案）：${needLook.length} 条`, '',
  ...needLook.slice(0, 60).map((r) => `- ${r.支付买家数档} ｜ ${r.商品标题.slice(0, 60)} ｜ ${r.商品链接}`),
  '',
].join('\n');
fs.writeFileSync(outBase + '-候选.md', md, 'utf8');
fs.writeFileSync(outBase + '-待看图.json', JSON.stringify(needLook, null, 1), 'utf8');
fs.writeFileSync(outBase + '-候选.json', JSON.stringify({ 输入: input, 规则: { 硬条件支付买家数最少: minBuyers, 分档: bands }, 条数: rowsOut.length, 候选: rowsOut }, null, 1), 'utf8');

process.stdout.write(JSON.stringify({ 输入条数: rows.length, 入选: rowsOut.length, 第一优先: count('第一优先'), 第二优先: count('第二优先'), 第三优先: count('第三优先'), 备选: count('备选'), 待看图: needLook.length, 输出: outBase }, null, 1) + '\n');
