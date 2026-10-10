/* 生意参谋「找款」技能 · 操作录制器（注入到页面内运行）
 * 记录：真实鼠标事件、键盘事件、输入值、SPA 路由跳转、以及每次点击背后的 XHR/fetch。
 * 只在本机、只在当前标签页内记录，不向外发任何数据。
 * 由 rec.mjs install 注入（Page.addScriptToEvaluateOnNewDocument + 立即执行）。
 */
(() => {
  if (window.__REC__ && window.__REC__.installed) return 'already-installed';

  const SS_LOG = 'sycmrec_log_v1';
  const SS_META = 'sycmrec_meta_v1';
  const MAX_EVENTS = 20000;
  const NET_RE = /(sycm\.taobao\.com\/(api|portal|market|common|report)|mtop|h5api|\/api\/|\.json)/i;

  let meta = null;
  try { meta = JSON.parse(sessionStorage.getItem(SS_META) || 'null'); } catch (e) { meta = null; }
  if (!meta || !meta.session) {
    meta = {
      session: 'S' + Date.now().toString(36),
      startedAt: new Date().toISOString(),
      startHost: location.host,
      startUrl: location.href,
      seq: 0,
    };
  }

  const events = [];
  const t0 = Date.now();
  let lastPersist = 0;

  function persist(force) {
    const now = Date.now();
    if (!force && now - lastPersist < 1500) return;
    lastPersist = now;
    try {
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      sessionStorage.setItem(SS_LOG, JSON.stringify(events));
      sessionStorage.setItem(SS_META, JSON.stringify(meta));
    } catch (e) { /* 配额满了就先放弃落盘，内存里还在 */ }
  }

  // 恢复本标签页之前记录过的事件（同一 origin 内换页不丢）
  try {
    const prev = sessionStorage.getItem(SS_LOG);
    if (prev) {
      const arr = JSON.parse(prev);
      if (Array.isArray(arr)) for (const e of arr) events.push(e);
    }
  } catch (e) { /* ignore */ }

  function cssPath(el) {
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let p = cur.tagName.toLowerCase();
      const id = cur.getAttribute && cur.getAttribute('id');
      if (id && /^[A-Za-z][\w-]*$/.test(id)) { parts.unshift(p + '#' + id); break; }
      const cn = typeof cur.className === 'string' ? cur.className.trim() : '';
      const cls = cn ? cn.split(/\s+/).filter((c) => c && !/^\d/.test(c)).slice(0, 2) : [];
      if (cls.length) p += '.' + cls.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(p);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function xpath(el) {
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 12) {
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(cur.tagName.toLowerCase() + '[' + idx + ']');
      cur = cur.parentElement;
      depth++;
    }
    return '/' + parts.join('/');
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    let rect = { x: 0, y: 0, w: 0, h: 0 };
    try {
      const r = el.getBoundingClientRect();
      rect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) { /* ignore */ }
    const label = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'));
    let txt = (label || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: typeof el.className === 'string' ? el.className.trim().slice(0, 120) : null,
      role: el.getAttribute && el.getAttribute('role'),
      type: el.getAttribute && el.getAttribute('type'),
      name: el.getAttribute && el.getAttribute('name'),
      text: txt || null,
      sel: cssPath(el),
      xp: xpath(el),
      box: rect,
      cx: rect.x + Math.round(rect.w / 2),
      cy: rect.y + Math.round(rect.h / 2),
    };
  }

  function valOf(el) {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const ty = (el.getAttribute('type') || '').toLowerCase();
      if (ty === 'password') return '***';
      if (ty === 'checkbox' || ty === 'radio') return el.checked;
      return String(el.value || '').slice(0, 200);
    }
    if (tag === 'textarea') return String(el.value || '').slice(0, 200);
    if (tag === 'select') return String(el.value || '').slice(0, 120);
    return null;
  }

  function push(ev) {
    const rec = Object.assign({
      n: ++meta.seq,
      ms: Date.now() - t0,
      ts: new Date().toISOString(),
      url: location.href,
      title: document.title,
    }, ev);
    events.push(rec);
    persist(false);
    paintHud();
    return rec;
  }

  // ---- HUD：右下角一个小角标，只提示「正在录制」，不拦事件 ----
  let hud = null, hudOn = true;
  function paintHud() {
    if (!hudOn) return;
    try {
      if (!hud || !hud.isConnected) {
        hud = document.createElement('div');
        hud.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;pointer-events:none;' +
          'background:rgba(20,20,20,.72);color:#7CFC9A;font:11px/1.4 Consolas,monospace;padding:2px 6px;border-radius:4px';
        (document.body || document.documentElement).appendChild(hud);
      }
      hud.textContent = 'REC ' + events.length;
    } catch (e) { /* ignore */ }
  }

  // ---- 鼠标 ----
  const MOUSE = ['pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel'];
  for (const type of MOUSE) {
    document.addEventListener(type, (e) => {
      const d = describe(e.target);
      push({
        kind: 'mouse', type,
        button: e.button === undefined ? null : e.button,
        buttons: e.buttons === undefined ? null : e.buttons,
        x: Math.round(e.clientX || 0),
        y: Math.round(e.clientY || 0),
        docX: Math.round((e.clientX || 0) + window.scrollX),
        docY: Math.round((e.clientY || 0) + window.scrollY),
        ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey,
        deltaY: e.deltaY ? Math.round(e.deltaY) : null,
        scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY),
        target: d,
      });
    }, true);
  }

  // ---- 键盘 ----
  document.addEventListener('keydown', (e) => {
    push({
      kind: 'key', type: 'keydown',
      key: e.key, code: e.code,
      ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey,
      isComposing: !!e.isComposing,
      target: describe(e.target),
      valueBefore: valOf(e.target),
    });
  }, true);

  // ---- 输入 / 选择 ----
  document.addEventListener('input', (e) => {
    push({ kind: 'input', type: 'input', target: describe(e.target), value: valOf(e.target) });
  }, true);
  document.addEventListener('change', (e) => {
    push({ kind: 'input', type: 'change', target: describe(e.target), value: valOf(e.target) });
  }, true);

  // ---- SPA 路由 / 页面跳转 ----
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    if (typeof orig === 'function') {
      history[m] = function (...a) {
        const r = orig.apply(this, a);
        try { push({ kind: 'nav', type: 'spa:' + m, to: String(a[2] || location.href) }); } catch (e) { /* ignore */ }
        return r;
      };
    }
  }
  window.addEventListener('popstate', () => push({ kind: 'nav', type: 'popstate' }));
  window.addEventListener('hashchange', () => push({ kind: 'nav', type: 'hashchange' }));
  window.addEventListener('pagehide', () => persist(true));
  window.addEventListener('beforeunload', () => persist(true));

  // ---- 网络：记下每次操作真正调了什么接口 ----
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__rec = { method: String(method).toUpperCase(), url: String(url), t: Date.now() };
    return XO.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__rec;
    if (info && NET_RE.test(info.url)) {
      const rec = push({
        kind: 'net', type: 'xhr', method: info.method, reqUrl: info.url,
        reqBody: body ? String(body).slice(0, 500) : null,
      });
      this.addEventListener('loadend', () => {
        rec.status = this.status;
        rec.durMs = Date.now() - info.t;
      });
    }
    return XS.call(this, body);
  };
  if (window.fetch) {
    const OF = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const body = init && init.body ? String(init.body).slice(0, 500) : null;
      const start = Date.now();
      let rec = null;
      if (NET_RE.test(url)) rec = push({ kind: 'net', type: 'fetch', method, reqUrl: url, reqBody: body });
      return OF.apply(this, arguments).then(
        (res) => { if (rec) { rec.status = res.status; rec.durMs = Date.now() - start; } return res; },
        (err) => { if (rec) { rec.status = 'ERR:' + err; rec.durMs = Date.now() - start; } throw err; },
      );
    };
  }

  window.__REC__ = {
    installed: true,
    events,
    meta,
    t0,
    mark(label, extra) {
      return push({ kind: 'mark', label: String(label || ''), extra: extra || null });
    },
    dump(sinceN) {
      const from = Number(sinceN || 0);
      return JSON.stringify({ meta, total: events.length, events: events.filter((e) => e.n > from) });
    },
    stats() {
      const by = {};
      for (const e of events) by[e.kind] = (by[e.kind] || 0) + 1;
      return JSON.stringify({ session: meta.session, total: events.length, byKind: by, lastSeq: meta.seq, hud: hudOn });
    },
    clear() { events.length = 0; meta.seq = 0; persist(true); paintHud(); return 'cleared'; },
    hud(on) { hudOn = !!on; if (hud && hud.isConnected) hud.remove(); hud = null; paintHud(); return hudOn; },
    flush() { persist(true); return events.length; },
  };

  paintHud();
  return 'installed:' + meta.session;
})();
