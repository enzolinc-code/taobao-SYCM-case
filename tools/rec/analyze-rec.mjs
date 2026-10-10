/* 把录制出的 jsonl 汇总成「能看的东西」：
 *   1) 时间范围 + 各类型计数
 *   2) 操作步骤序列（点击 / 滚动 / 按键 / 输入 / 跳转），带元素文字与选择器
 *   3) 接口清单（按 method+path 去重，带次数、示例入参）
 * 用法：node tools/rec/analyze-rec.mjs <全部事件.jsonl> [--since "2026-10-08T14:30:00"] [--full]
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const since = flag('since', null);
const full = args.includes('--full');

const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
let evs = raw.filter((e) => !since || String(e.ts) >= since);

// 前置去噪：把开始时守护进程打的「开始录制」标记之前的都算噪声（除非给了 --since）
if (!since) {
  const firstReal = evs.findIndex((e) => e.kind === 'mark' && /正式开始|开始操作/.test(String(e.label || '')));
  if (firstReal > 0) evs = evs.slice(firstReal);
}

const t0 = new Date(evs[0]?.ts || Date.now()).getTime();
const rel = (e) => '+' + ((new Date(e.ts).getTime() - t0) / 1000).toFixed(0) + 's';
const by = {};
for (const e of evs) by[e.kind] = (by[e.kind] || 0) + 1;

const out = [];
out.push(`# 录制分析：${file.split('\\').pop()}`);
out.push('');
out.push(`- 原始事件 ${raw.length} 条，本报告用 ${evs.length} 条`);
out.push(`- 时间范围：${evs[0]?.ts} → ${evs[evs.length - 1]?.ts}（约 ${(((new Date(evs[evs.length - 1]?.ts) - t0) / 60000) || 0).toFixed(1)} 分钟）`);
out.push(`- 计数：鼠标 ${by.mouse || 0} / 键盘 ${by.key || 0} / 输入 ${by.input || 0} / 接口 ${by.net || 0} / 跳转 ${by.nav || 0} / 标记 ${by.mark || 0}`);
out.push('');
out.push('## 一、操作步骤');
out.push('');

const clicks = [];
let lastClick = null;
for (const e of evs) {
  if (e.kind === 'mark') {
    out.push(`- **${rel(e)} 标记**：${e.label}`);
  } else if (e.kind === 'nav') {
    out.push(`- ${rel(e)} 跳转（${e.type}）→ ${short(e.to || e.url)}`);
  } else if (e.kind === 'mouse' && e.type === 'pointerdown') {
    const t = e.target || {};
    const label = (t.text || '').replace(/\s+/g, ' ').slice(0, 60);
    const key = `${e.x},${e.y}|${label}`;
    if (key === lastClick) continue; // 同一位置连点合并
    lastClick = key;
    clicks.push(t);
    out.push(`- ${rel(e)} 点击 (${e.x},${e.y}) ${t.tag || '?'}「${label}」  sel=\`${t.sel || '?'}\``);
  } else if (e.kind === 'mouse' && e.type === 'wheel') {
    if (full || Math.abs(e.deltaY) > 200) out.push(`- ${rel(e)} 滚动 Δy=${e.deltaY}`);
  } else if (e.kind === 'key') {
    out.push(`- ${rel(e)} 按键 ${e.key}（焦点：${(e.target && e.target.text) || ''}）`);
  } else if (e.kind === 'input') {
    out.push(`- ${rel(e)} 输入 → ${(e.target && e.target.text) || ''} 值=\`${String(e.value).slice(0, 60)}\``);
  } else if (e.kind === 'net' && full) {
    out.push(`- ${rel(e)} 接口 ${e.method} ${short(e.reqUrl)} → ${e.status ?? ''}`);
  }
}

out.push('');
out.push('## 二、点过的元素（去重，按出现顺序）');
out.push('');
const seen = new Set();
let idx = 0;
for (const t of clicks) {
  const k = `${t.sel}|${t.text}`;
  if (seen.has(k)) continue;
  seen.add(k);
  idx++;
  out.push(`${idx}. <${t.tag}> 「${(t.text || '').replace(/\s+/g, ' ').slice(0, 60)}」  (${t.cx},${t.cy})`);
  out.push(`   sel: \`${t.sel}\``);
}

out.push('');
out.push('## 三、调过的接口（去重）');
out.push('');
const api = new Map();
for (const e of evs) {
  if (e.kind !== 'net') continue;
  let path = e.reqUrl; let host = '';
  try { const u = new URL(e.reqUrl, 'https://sycm.taobao.com'); host = u.host; path = u.pathname; } catch { /* ignore */ }
  const key = `${e.method} ${host}${path}`;
  if (!api.has(key)) api.set(key, { n: 0, statuses: new Set(), body: e.reqBody ? String(e.reqBody).slice(0, 200) : null, samples: new Set() });
  const a = api.get(key);
  a.n++;
  if (e.status) a.statuses.add(e.status);
  if (!a.body && e.reqBody) a.body = String(e.reqBody).slice(0, 200);
  if (a.samples.size < 4) a.samples.add(String(e.reqUrl).slice(0, 260));
}
for (const [k, v] of Array.from(api.entries()).sort((a, b) => b[1].n - a[1].n)) {
  out.push(`- ${v.n}× ${k}  [${Array.from(v.statuses).join(',')}]`);
  if (v.body) out.push(`    body: \`${v.body.replace(/`/g, "'")}\``);
  for (const s of v.samples) out.push(`    例: \`${s}\``);
}

function short(u) {
  try { const x = new URL(u); return x.host + x.pathname; } catch { return String(u || '').slice(0, 80); }
}

process.stdout.write(out.join('\n') + '\n');
