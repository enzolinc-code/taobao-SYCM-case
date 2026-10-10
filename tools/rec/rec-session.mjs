/* 生意参谋找款 · 全程录制守护进程（用户操作，程序记录）
 *
 * 作用：
 *   1) 自动把录制器注入到 9222 那个 Chrome 里**每一个**标签页（含之后新开的）；
 *   2) 每 N 秒把各标签页记录到的事件落盘（即使某个标签页被关掉也不丢）；
 *   3) 合并出一份按时间排序的《操作总表》。
 *
 * 用法：
 *   node tools/rec/rec-session.mjs --out "录制/会话-20261008-2230" --interval 5 --duration 10800
 * 结束时 Ctrl+C 或到点自动退出，都会做最后一次落盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMd, writeOut, mergeDumps } from './rec-md.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECT_SRC = fs.readFileSync(path.join(HERE, 'rec-inject.js'), 'utf8');
const CDP_HTTP = 'http://127.0.0.1:9222';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const OUT = getArg('out', path.join(HERE, '..', '录制', '会话-' + Date.now()));
const INTERVAL = Math.max(2, Number(getArg('interval', 5))) * 1000;
const DURATION = Number(getArg('duration', 10800)) * 1000;

const TABS_DIR = path.join(OUT, 'tabs');
fs.mkdirSync(TABS_DIR, { recursive: true });
const LOG = path.join(OUT, '会话日志.txt');

function log(line) {
  const s = `[${new Date().toLocaleString('zh-CN')}] ${line}`;
  try { fs.appendFileSync(LOG, s + '\n', 'utf8'); } catch { /* ignore */ }
  process.stdout.write(s + '\n');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const listeners = [];
    const api = {
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { rej(e); }
        });
      },
      on(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
      close() { try { ws.close(); } catch { /* ignore */ } },
      get open() { return ws.readyState === 1; },
    };
    ws.onopen = () => resolve(api);
    ws.onerror = () => reject(new Error('CDP 连接失败：' + wsUrl));
    ws.onclose = () => { for (const fn of listeners) fn({ method: 'WS_CLOSED' }); };
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

const SKIP_RE = /^(chrome|devtools|chrome-extension|edge|about:blank|data):/i;
const tabs = new Map(); // targetId -> { conn, contexts: Map, url, title, id8, host }

function id8(id) { return String(id || 'unknown').slice(0, 8); }
function hostOf(url) {
  try { return new URL(url).host.replace(/[^a-z0-9.-]/gi, '_'); } catch { return 'unknown'; }
}

async function attach(targetInfo) {
  const id = targetInfo.targetId || targetInfo.id; // /json/list 用 id，Target 事件用 targetId
  if (!id) return;
  if (tabs.has(id)) return;
  const url = targetInfo.url || '';
  if (SKIP_RE.test(url)) return;
  const rec = { conn: null, contexts: new Map(), url, title: targetInfo.title || '', id8: id8(id), host: hostOf(url), attachedAt: Date.now() };
  tabs.set(id, rec);
  try {
    const conn = await connect(`ws://127.0.0.1:9222/devtools/page/${id}`);
    rec.conn = conn;
    // 先挂监听再开 Runtime，否则 Runtime.enable 立刻回吐的现有执行上下文会漏掉
    conn.on((msg) => {
      if (msg.method === 'Runtime.executionContextCreated') {
        const ctx = msg.params.context;
        rec.contexts.set(ctx.id, { frameId: (ctx.auxData && ctx.auxData.frameId) || String(ctx.id) });
      } else if (msg.method === 'Runtime.executionContextDestroyed') {
        rec.contexts.delete(msg.params.executionContextId);
      } else if (msg.method === 'Runtime.executionContextsCleared') {
        rec.contexts.clear();
      } else if (msg.method === 'WS_CLOSED') {
        rec.closed = true;
      }
    });
    await conn.send('Page.enable', {});
    await conn.send('Runtime.enable', {});
    await conn.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SRC });
    await new Promise((r) => setTimeout(r, 300));
    await evalAll(rec, INJECT_SRC);
    await evalAll(rec, `window.__REC__ ? window.__REC__.mark('开始录制：' + location.href) : null`);
    log(`接入标签页 ${rec.id8} ${rec.host}｜${(targetInfo.title || '').slice(0, 30)}`);
  } catch (e) {
    log(`接入失败 ${rec.id8} ${rec.host}：${e.message}`);
    tabs.delete(id);
  }
}

async function evalAll(rec, expression) {
  const out = [];
  const ids = Array.from(rec.contexts.keys());
  for (const ctxId of ids) {
    try {
      const res = await rec.conn.send('Runtime.evaluate', {
        expression, contextId: ctxId, returnByValue: true, awaitPromise: true, userGesture: true,
      });
      if (!res.exceptionDetails && res.result) out.push(res.result.value);
    } catch (e) { /* 上下文没了就跳过 */ }
  }
  return out;
}

let lastWrite = 0;
async function harvest(cycle) {
  const parsedByTab = [];
  for (const [id, rec] of Array.from(tabs.entries())) {
    if (rec.closed || !rec.conn || !rec.conn.open) { tabs.delete(id); continue; }
    let dumps = [];
    try {
      dumps = (await evalAll(rec, 'window.__REC__ ? window.__REC__.dump(0) : null'))
        .filter((v) => typeof v === 'string' && v.startsWith('{'));
    } catch (e) {
      log(`取数失败 ${rec.id8}：${e.message}`);
    }
    const parsed = dumps.map((v) => JSON.parse(v));
    if (!parsed.length) continue;
    const perTab = mergeDumps(parsed);
    parsedByTab.push(perTab);
    if (perTab.events.length) {
      writeOut(path.join(TABS_DIR, `${rec.id8}-${rec.host}`), perTab, `标签页 ${rec.id8} ${rec.host}`);
    }
  }
  if (parsedByTab.length) {
    const all = mergeDumps(parsedByTab);
    fs.writeFileSync(path.join(OUT, '全部事件.jsonl'), all.events.map((e) => JSON.stringify(e)).join('\n') + (all.events.length ? '\n' : ''), 'utf8');
    fs.writeFileSync(path.join(OUT, '操作总表.md'), renderMd(all, `第 ${cycle} 轮快照 · ${tabs.size} 个标签页 · ${new Date().toLocaleString('zh-CN')}`), 'utf8');
    lastWrite = Date.now();
    const by = {};
    for (const e of all.events) by[e.kind] = (by[e.kind] || 0) + 1;
    log(`第 ${cycle} 轮：事件 ${all.events.length}（鼠标 ${by.mouse || 0}/键盘 ${by.key || 0}/输入 ${by.input || 0}/网络 ${by.net || 0}）标签页 ${tabs.size}`);
  } else {
    log(`第 ${cycle} 轮：暂无事件（标签页 ${tabs.size}）`);
  }
}

// ---- 主体 ----
log(`录制开始，输出目录：${OUT}`);
const ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
const browser = await connect(ver.webSocketDebuggerUrl);
browser.on(async (msg) => {
  try {
    if (msg.method === 'Target.targetCreated') await attach(msg.params.targetInfo);
    else if (msg.method === 'Target.targetDestroyed') tabs.delete(msg.params.targetId);
    else if (msg.method === 'Target.targetInfoChanged') {
      const ti = msg.params.targetInfo;
      const rec = tabs.get(ti.targetId);
      if (rec) { rec.url = ti.url; rec.title = ti.title; }
    }
  } catch (e) { log('目标事件出错：' + e.message); }
});
await browser.send('Target.setDiscoverTargets', { discover: true });
const existing = await (await fetch(`${CDP_HTTP}/json/list`)).json();
for (const t of existing) if (t.type === 'page') await attach({ targetId: t.id, url: t.url, title: t.title });
log(`已接入 ${tabs.size} 个标签页，开始每 ${INTERVAL / 1000} 秒落盘一次`);

const deadline = Date.now() + DURATION;
let cycle = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, INTERVAL));
  cycle++;
  try { await harvest(cycle); } catch (e) { log('本轮出错：' + e.message); }
}
await harvest(cycle + 1);
log('录制结束');
process.exit(0);
