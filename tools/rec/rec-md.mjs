/* 把录制到的事件渲染成人看的 Markdown / JSONL。rec.mjs 和 rec-session.mjs 共用。 */
import fs from 'node:fs';
import path from 'node:path';

export function sec(ms) { return (ms / 1000).toFixed(1) + 's'; }

export function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname + (x.search ? '?…' : '');
  } catch { return String(u || '').slice(0, 90); }
}

export function elemLine(t) {
  if (!t) return '?';
  const id = t.id ? '#' + t.id : '';
  const cls = t.cls ? '.' + String(t.cls).split(/\s+/).slice(0, 2).join('.') : '';
  const txt = t.text ? ` 「${String(t.text).replace(/[|\n]/g, ' ').slice(0, 40)}」` : '';
  return `<${t.tag}${id}${cls}>${txt}`;
}

export function renderMd(payload, sourceNote) {
  const { meta, events } = payload;
  const by = {};
  for (const e of events) by[e.kind] = (by[e.kind] || 0) + 1;
  const lines = [];
  lines.push('# 生意参谋找款 · 操作记录');
  lines.push('');
  lines.push(`- 会话：\`${meta && meta.session ? meta.session : 'unknown'}\``);
  if (meta && meta.startedAt) lines.push(`- 起始：${meta.startedAt}（${meta.startHost || ''}）`);
  lines.push(`- 事件数：${events.length}（鼠标 ${by.mouse || 0} / 键盘 ${by.key || 0} / 输入 ${by.input || 0} / 网络 ${by.net || 0} / 跳转 ${by.nav || 0} / 标记 ${by.mark || 0}）`);
  if (sourceNote) lines.push(`- 说明：${sourceNote}`);
  lines.push('');
  lines.push('## 操作步骤（按时间）');
  lines.push('');

  const clicked = [];
  const tabs = new Map();
  let lastTab = null;
  for (const e of events) {
    const at = `[${sec(e.ms || 0)}]`;
    const key = (e.url || '').split('?')[0] + '|' + (e.title || '');
    if (e.kind === 'nav' || key !== lastTab) {
      if (key !== lastTab) {
        lastTab = key;
        if (!tabs.has(key)) tabs.set(key, { url: e.url, title: e.title, first: e.ts });
      }
    }
    if (e.kind === 'mark') {
      lines.push(`- ${at} **标记**：${e.label}`);
    } else if (e.kind === 'nav') {
      lines.push(`- ${at} 页面跳转（${e.type}）→ \`${shortUrl(e.to || e.url)}\``);
    } else if (e.kind === 'mouse') {
      if (e.type === 'pointerdown') {
        const t = e.target || {};
        clicked.push(t);
        lines.push(`- ${at} 点击 (${e.x},${e.y}) → ${elemLine(t)}`);
        lines.push(`    - sel: \`${t.sel || '?'}\``);
        if (t.xp) lines.push(`    - xpath: \`${t.xp}\``);
      } else if (e.type === 'wheel') {
        lines.push(`- ${at} 滚动 Δy=${e.deltaY}（滚动位置 ${e.scrollY}）`);
      } else if (e.type === 'dblclick') {
        lines.push(`- ${at} 双击 (${e.x},${e.y}) → ${elemLine(e.target)}`);
      } else if (e.type === 'contextmenu') {
        lines.push(`- ${at} 右键 (${e.x},${e.y}) → ${elemLine(e.target)}`);
      }
    } else if (e.kind === 'key') {
      const mods = [e.ctrl && 'Ctrl', e.shift && 'Shift', e.alt && 'Alt'].filter(Boolean).join('+');
      lines.push(`- ${at} 按键 \`${mods ? mods + '+' : ''}${e.key}\`（聚焦 ${elemLine(e.target)}${e.valueBefore ? `，原值「${e.valueBefore}」` : ''}）`);
    } else if (e.kind === 'input') {
      lines.push(`- ${at} ${e.type === 'change' ? '选择/失焦变更' : '输入'} → ${elemLine(e.target)} 值 = \`${String(e.value).slice(0, 80)}\``);
    } else if (e.kind === 'net') {
      lines.push(`- ${at} 接口 ${e.method} \`${shortUrl(e.reqUrl)}\`${e.status ? ` → ${e.status}` : ''}${e.reqBody ? `\n    - body: \`${String(e.reqBody).replace(/`/g, "'").slice(0, 300)}\`` : ''}`);
    }
  }

  lines.push('');
  lines.push('## 涉及过的页面');
  lines.push('');
  for (const [, v] of tabs) lines.push(`- ${v.title || '(无标题)'} — \`${shortUrl(v.url)}\``);

  lines.push('');
  lines.push('## 点过的元素清单（去重）');
  lines.push('');
  const seen = new Set();
  for (const t of clicked) {
    const k = (t.sel || '') + '|' + (t.text || '');
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`- ${elemLine(t)}`);
    lines.push(`    - sel: \`${t.sel || '?'}\``);
    if (t.box) lines.push(`    - 位置: (${t.cx},${t.cy}) 尺寸 ${t.box.w}×${t.box.h}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function writeOut(outBase, payload, sourceNote) {
  const jsonl = outBase + '.jsonl';
  const md = outBase + '.md';
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const body = payload.events.map((e) => JSON.stringify(e)).join('\n') + (payload.events.length ? '\n' : '');
  fs.writeFileSync(jsonl, body, 'utf8');
  fs.writeFileSync(md, renderMd(payload, sourceNote), 'utf8');
  return { jsonl, md, count: payload.events.length };
}

export function mergeDumps(parsedList) {
  const events = [];
  let meta = null;
  for (const p of parsedList) {
    if (!meta && p.meta) meta = p.meta;
    for (const e of p.events || []) events.push(e);
  }
  events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || (a.ms || 0) - (b.ms || 0));
  events.forEach((e, i) => { e.n = i + 1; });
  return { meta: meta || { session: 'unknown', startedAt: new Date().toISOString() }, events };
}

export const INJECT_PATH = (here) => path.join(here, 'rec-inject.js');
