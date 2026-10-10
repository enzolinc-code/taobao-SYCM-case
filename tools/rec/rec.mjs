/* 生意参谋「找款」技能 · 录制控制器
 *
 * 用法（Chrome 需带 --remote-debugging-port=9222）：
 *   node tools/rec/rec.mjs tabs
 *   node tools/rec/rec.mjs install  sycm.taobao.com          # 注入录制器（新文档自动重装）
 *   node tools/rec/rec.mjs status   sycm.taobao.com
 *   node tools/rec/rec.mjs mark     sycm.taobao.com "点开市场排行"
 *   node tools/rec/rec.mjs click    sycm.taobao.com 812 63   # 真鼠标点击（页面里的真实事件，会被录下来）
 *   node tools/rec/rec.mjs type     sycm.taobao.com "手机壳"
 *   node tools/rec/rec.mjs key      sycm.taobao.com Enter
 *   node tools/rec/rec.mjs nav      sycm.taobao.com https://sycm.taobao.com/market/...
 *   node tools/rec/rec.mjs dump     sycm.taobao.com "录制/操作记录-20261008" --md
 *   node tools/rec/rec.mjs follow   sycm.taobao.com "录制/操作记录-20261008" 3600
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderMd, writeOut, mergeDumps } from './rec-md.mjs';

const CDP_HTTP = 'http://127.0.0.1:9222';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const INJECT = path.join(HERE, 'rec-inject.js');

async function listTargets() {
  const r = await fetch(`${CDP_HTTP}/json/list`);
  return await r.json();
}

function pickTarget(targets, key) {
  const pages = targets.filter((t) => t.type === 'page');
  let hit = pages.find((t) => t.id === key);
  if (!hit) hit = pages.find((t) => t.id.startsWith(key));
  if (!hit) hit = pages.find((t) => (t.url || '').includes(key));
  if (!hit) hit = pages.find((t) => (t.title || '').includes(key));
  if (!hit) throw new Error(`找不到标签页：${key}`);
  return hit;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(fn) { listeners.push(fn); },
      close() { try { ws.close(); } catch { /* ignore */ } },
    });
    ws.onerror = () => reject(new Error('CDP ws error（9222 通吗？）'));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    };
  });
}

async function withTarget(key, fn) {
  const targets = await listTargets();
  const t = pickTarget(targets, key);
  const c = await connect(t.webSocketDebuggerUrl);
  try { return await fn(c, t); } finally { c.close(); }
}

// 把标签页切到前台：后台标签页（visibilityState=hidden）收不到 CDP 派发的鼠标/键盘事件
async function activate(key) {
  const ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const c = await connect(ver.webSocketDebuggerUrl);
  try {
    const t = pickTarget(await listTargets(), key);
    await c.send('Target.activateTarget', { targetId: t.id });
  } finally { c.close(); }
  await new Promise((r) => setTimeout(r, 400));
}

async function evaluate(c, expression, opts = {}) {
  const res = await c.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true, ...opts,
  });
  if (res.exceptionDetails) {
    throw new Error('页面内报错：' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result?.value;
}

// 主文档 + 所有子 iframe（生意参谋的市场模块有一层 iframe）都执行一遍，返回能解析出结果的那些
async function evalAllFrames(c, expression) {
  const contexts = [];
  c.on((msg) => {
    if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
  });
  await c.send('Runtime.enable', {});
  await new Promise((r) => setTimeout(r, 500));
  const seen = new Set();
  const results = [];
  for (const ctx of contexts) {
    const frameId = (ctx.auxData && ctx.auxData.frameId) || 'ctx' + ctx.id;
    if (seen.has(frameId) || !ctx.id) continue;
    seen.add(frameId);
    try {
      const res = await c.send('Runtime.evaluate', {
        expression, contextId: ctx.id, returnByValue: true, awaitPromise: true, userGesture: true,
      });
      if (!res.exceptionDetails && res.result) results.push({ frameId, value: res.result.value });
    } catch (e) { /* 上下文已销毁，跳过 */ }
  }
  return results;
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
function parseCombo(s) {
  const parts = String(s).split('+');
  const keyName = parts.pop();
  let mod = 0;
  for (const p of parts) mod |= (MOD[p.toLowerCase()] || 0);
  return { mod, keyName };
}

const KEYMAP = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { code: 'Escape', keyCode: 27, text: '' },
  Backspace: { code: 'Backspace', keyCode: 8, text: '' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40, text: '' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38, text: '' },
  Delete: { code: 'Delete', keyCode: 46, text: '' },
};

async function realClick(c, x, y, { double = false, right = false, mark = null } = {}) {
  const button = right ? 'right' : 'left';
  const buttons = right ? 2 : 1;
  if (mark) await evaluate(c, `window.__REC__ && window.__REC__.mark(${JSON.stringify(mark)})`);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await new Promise((r) => setTimeout(r, 60));
  for (let i = 0; i < (double ? 2 : 1); i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 40));
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 40));
  }
}

// 在页面里按文字找可见元素（优先最小的那个，也就是真正承载文字的节点）
function findTextExpr(kw, exact) {
  return `(() => {
  const kw = ${JSON.stringify(kw)};
  const exact = ${exact ? 'true' : 'false'};
  const out = [];
  const nodes = document.querySelectorAll('a,button,span,div,li,label,i,em,strong,input,td,th,p');
  for (const el of nodes) {
    const t = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    if (!t || t.length > 40) continue;
    if (exact ? t !== kw : !t.includes(kw)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    out.push({ t, tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className.slice(0, 80) : null,
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), area: Math.round(r.width * r.height),
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
  }
  out.sort((a, b) => a.area - b.area);
  const seen = new Set();
  const uniq = [];
  for (const o of out) {
    const k = o.tag + '|' + o.x + ',' + o.y;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(o);
  }
  return JSON.stringify(uniq.slice(0, 12));
})()`;
}

// ---------- 命令 ----------
const [, , cmd, tabKey, ...rest] = process.argv;
const out = (v) => process.stdout.write(typeof v === 'string' ? v + '\n' : JSON.stringify(v, null, 1) + '\n');

if (cmd === 'tabs') {
  const t = await listTargets();
  out(t.filter((x) => x.type === 'page').map((x) => ({ id: x.id, title: x.title, url: x.url })));
} else if (cmd === 'install') {
  const src = fs.readFileSync(INJECT, 'utf8');
  const r = await withTarget(tabKey, async (c) => {
    await c.send('Page.enable', {});
    const added = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    const frames = await evalAllFrames(c, src);
    return {
      scriptId: added.identifier,
      frames: frames.length,
      install: frames.map((f) => f.value),
    };
  });
  out(r);
} else if (cmd === 'status') {
  const r = await withTarget(tabKey, async (c) => {
    const frames = await evalAllFrames(c, 'window.__REC__ && window.__REC__.installed ? window.__REC__.stats() : null');
    const stats = frames.map((f) => f.value).filter(Boolean).map((s) => JSON.parse(s));
    if (!stats.length) return { installed: false, frames: frames.length };
    const by = {};
    let total = 0, lastSeq = 0, session = null;
    for (const s of stats) {
      total += s.total;
      lastSeq = Math.max(lastSeq, s.lastSeq || 0);
      session = session || s.session;
      for (const k of Object.keys(s.byKind || {})) by[k] = (by[k] || 0) + s.byKind[k];
    }
    return { installed: true, session, total, byKind: by, lastSeq, framesWithRecorder: stats.length };
  });
  out(r);
} else if (cmd === 'mark') {
  const label = rest.join(' ');
  const r = await withTarget(tabKey, (c) => evaluate(c, `window.__REC__ ? window.__REC__.mark(${JSON.stringify(label)}) : 'no-recorder'`));
  out(r);
} else if (cmd === 'click') {
  const x = Number(rest[0]), y = Number(rest[1]);
  const flags = rest.slice(2);
  const markAt = flags.indexOf('--mark');
  await activate(tabKey);
  const r = await withTarget(tabKey, async (c) => {
    const before = await evaluate(c, 'location.href');
    await realClick(c, x, y, {
      double: flags.includes('--double'),
      right: flags.includes('--right'),
      mark: markAt >= 0 ? flags[markAt + 1] : null,
    });
    await new Promise((res) => setTimeout(res, 800));
    const after = await evaluate(c, 'location.href');
    return { clicked: [x, y], urlBefore: before, urlAfter: after, changed: before !== after };
  });
  out(r);
} else if (cmd === 'move') {
  const x = Number(rest[0]), y = Number(rest[1]);
  await withTarget(tabKey, (c) => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }));
  out({ moved: [x, y] });
} else if (cmd === 'findtext') {
  // 只找不点：按文字找可见元素，返回身份 + 中心坐标
  const kw = rest.join(' ');
  const r = await withTarget(tabKey, (c) => evaluate(c, findTextExpr(kw, true)));
  out(JSON.parse(r));
} else if (cmd === 'clicktext') {
  // 按文字找到元素 → 用真鼠标点它的中心（页面里就是真实点击，会被录下来）
  const nthIdx = rest.indexOf('--nth');
  const nth = nthIdx >= 0 ? Number(rest[nthIdx + 1]) : 1;
  const markIdx = rest.indexOf('--mark');
  const label = markIdx >= 0 ? rest[markIdx + 1] : null;
  const exact = rest.includes('--exact');
  const drop = new Set();
  if (nthIdx >= 0) { drop.add(nthIdx); drop.add(nthIdx + 1); }
  if (markIdx >= 0) { drop.add(markIdx); drop.add(markIdx + 1); }
  const kw = rest.filter((x, i) => !x.startsWith('--') && !drop.has(i)).join(' ');
  await activate(tabKey);
  const r = await withTarget(tabKey, async (c) => {
    const cands = JSON.parse(await evaluate(c, findTextExpr(kw, exact)));
    if (!cands.length) throw new Error(`页面上找不到文字「${kw}」`);
    const t = cands[Math.min(nth, cands.length) - 1];
    const before = await evaluate(c, 'location.href');
    await realClick(c, t.x, t.y, { mark: label || `点击「${t.t}」` });
    await new Promise((res) => setTimeout(res, 900));
    const after = await evaluate(c, 'location.href');
    return { hit: t, candidates: cands.slice(0, 5), urlBefore: before, urlAfter: after, changed: before !== after };
  });
  out(r);
} else if (cmd === 'type') {
  const text = rest.join(' ');
  await activate(tabKey);
  await withTarget(tabKey, async (c) => {
    for (const ch of text) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  out({ typed: text });
} else if (cmd === 'key') {
  const { mod, keyName } = parseCombo(rest.join(' '));
  const k = KEYMAP[keyName] || { code: 'Key' + keyName.toUpperCase(), keyCode: keyName.toUpperCase().charCodeAt(0), text: keyName.length === 1 ? keyName : '' };
  await activate(tabKey);
  await withTarget(tabKey, async (c) => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: mod, text: k.text });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: mod });
  });
  out({ key: keyName, modifiers: mod });
} else if (cmd === 'nav') {
  const url = rest[0];
  await activate(tabKey);
  await withTarget(tabKey, async (c) => {
    await c.send('Page.enable', {});
    await c.send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 3500));
  });
  out({ navigated: url });
} else if (cmd === 'shot') {
  const file = rest[0];
  const r = await withTarget(tabKey, (c) => c.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  out({ file, bytes: fs.statSync(file).size });
} else if (cmd === 'dump') {
  const outBase = rest.filter((x) => x !== '--md')[0];
  const sinceIdx = rest.indexOf('--since');
  const since = sinceIdx >= 0 ? Number(rest[sinceIdx + 1]) : 0;
  const frames = await withTarget(tabKey, (c) => evalAllFrames(c, `window.__REC__ ? window.__REC__.dump(${since}) : null`));
  const parsed = frames.map((f) => f.value).filter((v) => typeof v === 'string' && v.startsWith('{')).map((v) => JSON.parse(v));
  if (!parsed.length) { out({ error: '录制器没装（先跑 install）' }); process.exit(1); }
  const payload = mergeDumps(parsed);
  const r = writeOut(outBase, payload, since ? `仅增量（n > ${since}）` : '全量');
  out({ ...r, session: payload.meta.session, total: payload.total });
} else if (cmd === 'follow') {
  const outBase = rest[0];
  const seconds = Number(rest[1] || 600);
  const interval = Number(rest[2] || 5000);
  const deadline = Date.now() + seconds * 1000;
  const jsonl = outBase + '.jsonl';
  const md = outBase + '.md';
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  let lastN = 0;
  let all = [];
  let meta0 = null;
  while (Date.now() < deadline) {
    try {
      const frames = await withTarget(tabKey, (c) => evalAllFrames(c, 'window.__REC__ ? window.__REC__.dump(0) : null'));
      const parsed = frames.map((f) => f.value).filter((v) => typeof v === 'string' && v.startsWith('{')).map((v) => JSON.parse(v));
      if (parsed.length) {
        const payload = mergeDumps(parsed);
        if (!meta0) meta0 = payload.meta;
        if (payload.events.length !== lastN) {
          all = payload.events;
          lastN = all.length;
          fs.writeFileSync(jsonl, all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''), 'utf8');
          fs.writeFileSync(md, renderMd({ meta: payload.meta, events: all }, '持续跟随（自动刷新）'), 'utf8');
          out(`[follow] ${new Date().toLocaleTimeString()} 事件 ${all.length} 条 → ${md}`);
        }
      }
    } catch (e) {
      out(`[follow] 出错：${e.message}（重试中）`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  out({ done: true, events: all.length, md, jsonl });
} else {
  out(`未知命令：${cmd}\n可用：tabs | install | status | mark | click | move | type | key | nav | shot | dump | follow`);
}
