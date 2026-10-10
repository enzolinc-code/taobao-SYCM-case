/* 生意参谋找款器 · Chrome CDP 连接层（无第三方依赖，Node 22+ 自带 fetch / WebSocket）
 *
 * 用法前提：Chrome 带 --remote-debugging-port=9222 启动，并已登录生意参谋。
 * 端口可用环境变量 CDP_PORT 覆盖。
 */

import { pathToFileURL } from 'node:url';

export const CDP_PORT = Number(process.env.CDP_PORT || 9222);
export const CDP_HTTP = `http://127.0.0.1:${CDP_PORT}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listTargets() {
  let r;
  try {
    r = await fetch(`${CDP_HTTP}/json/list`);
  } catch (e) {
    throw new Error(`连不上 Chrome 调试端口 ${CDP_PORT}（用 scripts/start-chrome.ps1 启动 Chrome 了吗？）`);
  }
  return await r.json();
}

/* 按「标签页 id → id 前缀 → url 含关键字 → 标题含关键字」依次匹配 */
export function pickPage(list, key) {
  const pages = list.filter((t) => t.type === 'page');
  return pages.find((x) => x.id === key)
    || pages.find((x) => x.id.startsWith(key))
    || pages.find((x) => (x.url || '').includes(key))
    || pages.find((x) => (x.title || '').includes(key));
}

export function connect(wsUrl) {
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
    ws.onerror = () => reject(new Error(`CDP 连不上（${CDP_PORT} 通吗？）`));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      } else {
        for (const fn of listeners) { try { fn(m); } catch { /* ignore */ } }
      }
    };
  });
}

export async function withPage(key, fn) {
  const t = pickPage(await listTargets(), key);
  if (!t) throw new Error('找不到标签页：' + key);
  const c = await connect(t.webSocketDebuggerUrl);
  try { return await fn(c, t); } finally { c.close(); }
}

export async function evalInPage(c, expr) {
  const r = await c.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('页面内报错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result?.value;
}

/* 在页面里按可见文字点一下（页面自身的事件，等同于真人点） */
export async function clickText(c, text, { exact = false } = {}) {
  const expr = `(() => {
    const want = ${JSON.stringify(text)};
    const els = Array.from(document.querySelectorAll('a,button,li,span,div,label,td,em,i'));
    const hit = els.filter((e) => {
      const t = (e.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!t) return false;
      if (${exact} ? t !== want : !t.includes(want)) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    })[0];
    if (!hit) return JSON.stringify({ ok: false, why: 'no-match' });
    hit.click();
    return JSON.stringify({ ok: true, text: (hit.innerText || '').trim().slice(0, 40),
      cls: typeof hit.className === 'string' ? hit.className.slice(0, 60) : '' });
  })()`;
  return JSON.parse(await evalInPage(c, expr));
}

/* 在「浏览器」层面开一个新标签页（放在后台，不抢用户的焦点）。 */
export async function openTab(url, background = true) {
  const ver = await (await fetch(`${CDP_HTTP}/json/version`)).json();
  const c = await connect(ver.webSocketDebuggerUrl);
  try {
    return await c.send('Target.createTarget', { url, background });
  } finally {
    c.close();
  }
}

/* 命令行小工具：
 *   node tools/cdp.mjs tabs                      列出所有标签页
 *   node tools/cdp.mjs url <关键字>              看某个标签页当前网址
 *   node tools/cdp.mjs clicktext <标签> <文字>   按可见文字点一下
 *   node tools/cdp.mjs newtab <网址>             后台开一个新标签页
 *   node tools/cdp.mjs newtabfg <网址>           前台开一个新标签页
 */
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'tabs') {
    const list = await listTargets();
    const pages = list.filter((x) => x.type === 'page');
    if (!pages.length) console.log('（当前没有打开的网页标签页）');
    for (const t of pages) {
      console.log(`${t.id.slice(0, 8)}  ${(t.title || '').slice(0, 40)}\n          ${t.url}`);
    }
    const others = list.filter((x) => x.type !== 'page').map((x) => x.type);
    if (others.length) console.log(`（另有 ${others.length} 个非网页目标：${[...new Set(others)].join(', ')}）`);
  } else if (cmd === 'url') {
    const t = pickPage(await listTargets(), a);
    console.log(t ? t.url : '找不到标签页：' + a);
  } else if (cmd === 'clicktext') {
    const r = await withPage(a, (c) => clickText(c, b));
    console.log(JSON.stringify(r, null, 1));
  } else if (cmd === 'newtab' || cmd === 'newtabfg') {
    const r = await openTab(a, cmd === 'newtab');
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.log('用法：node tools/cdp.mjs tabs | url <关键字> | clicktext <标签> <文字> | newtab <网址>');
  }
}
