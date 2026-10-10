/* 生意参谋榜单页的行提取（纯读 DOM，不额外发请求）。
 * 兼容两种表：
 *   1) 生意参谋原生表   —— 表头：排名 / 商品 / 店铺 / 支付买家数 / 访客数
 *   2) 店透视「一键分析」表 —— 表头：行业排名 / 趋势 / 类目名称 / 商品名称 / 店铺名称 / 支付买家数 / 访客数
 *
 * 注意：支付买家数在「大表」里是**区间档**（如 "10 ~ 50"），原生小表里是精确数字。
 */
export { withPage, evalInPage, listTargets, pickPage, connect } from './cdp.mjs';

export const ROW_EXPR = `(() => {
  const txt = (e) => (e.innerText || e.textContent || '').replace(/\\s+/g, ' ').trim();
  const abs = (h) => { try { return h ? new URL(h, location.href).href : null; } catch { return h; } };
  const idxOf = (heads, res) => heads.findIndex((h) => res.some((r) => h.includes(r)));
  let best = null, bestScore = -1;
  for (const t of document.querySelectorAll('table, div.el-table, div.oui-table-wrapper')) {
    const trs = t.querySelectorAll('tbody tr, .el-table__body tr, .oui-table-tbody tr');
    if (trs.length < 3) continue;
    const heads = Array.from(t.querySelectorAll('thead th')).map(txt).filter(Boolean);
    const h = heads.join('|');
    const score = (/排名/.test(h) ? 3 : 0) + (/商品/.test(h) ? 3 : 0) + (/店铺/.test(h) ? 2 : 0)
      + (/买家/.test(h) ? 2 : 0) + (/访客/.test(h) ? 2 : 0) + (trs.length > 10 ? 2 : 0);
    if (score > bestScore) { bestScore = score; best = { t, trs, heads }; }
  }
  if (!best || bestScore < 5) return JSON.stringify({ ok: false, reason: '没找到榜单表格', bodyHead: (document.body.innerText || '').slice(0, 200) });
  const heads = best.heads;
  const iTitle = idxOf(heads, ['商品名称', '商品']);
  const iShop = idxOf(heads, ['店铺名称', '店铺']);
  const iBuy = idxOf(heads, ['支付买家', '买家']);
  const iUv = idxOf(heads, ['访客']);
  const iRank = idxOf(heads, ['行业排名', '排名']);
  const rows = [];
  for (const tr of best.trs) {
    const tds = Array.from(tr.querySelectorAll('td'));
    if (tds.length < 3) continue;
    const cells = tds.map(txt);
    const links = Array.from(tr.querySelectorAll('a[href]')).map((a) => abs(a.getAttribute('href'))).filter(Boolean);
    const imgs = Array.from(tr.querySelectorAll('img')).map((i) => abs(i.currentSrc || i.src)).filter(Boolean);
    const itemLink = links.find((l) => /item\\.taobao\\.com|detail\\.tmall\\.com|itemId=|id=/.test(l)) || links[0] || null;
    rows.push({
      cells, links, imgs, itemLink,
      rank: iRank >= 0 ? cells[iRank] : cells[0],
      title: iTitle >= 0 ? cells[iTitle] : '',
      shop: iShop >= 0 ? cells[iShop] : '',
      buyers: iBuy >= 0 ? cells[iBuy] : '',
      visitors: iUv >= 0 ? cells[iUv] : '',
    });
  }
  return JSON.stringify({
    ok: true, url: location.href, heads, rows,
    pageText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200),
  });
})()`;
