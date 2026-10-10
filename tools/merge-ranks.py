# -*- coding: utf-8 -*-
"""把多个榜单的清单合并去重（同一商品只留一条，标注出现在哪个榜），
按当天支付买家数排序出汇总图；可选只看某一个买家数档。

用法：
  python tools/merge-ranks.py --csv "清单-交易总量.csv" "清单-交易增速.csv" \
      --out-dir "<输出目录>" --tag "合并" [--band "100 ~ 250"] [--min 250] [--max 9] [--cols 10] [--tile 300]

分档出图的常用四刀（和人工筛选口径一致）：
  --min 250          只看 250 以上
  --band "100 ~ 250" 只看第一优先档
  --band "50 ~ 100"  只看第二优先档
  --band "10 ~ 50"   只看第三优先档
  --max 9            只看 1-9 件
"""
import argparse
import csv
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw

from sheetlib import bucket, fit, load_font


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, nargs="+")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--band", default="")
    ap.add_argument("--min", type=int, default=None, help="只看买家数下限不小于这个值的档（如 250）")
    ap.add_argument("--max", type=int, default=None, help="只看买家数上限不大于这个值的档（如 9）")
    ap.add_argument("--cols", type=int, default=10)
    ap.add_argument("--tile", type=int, default=300)
    ap.add_argument("--rows-per-sheet", type=int, default=8)
    args = ap.parse_args()

    merged, order = {}, []
    for f in args.csv:
        src = re.search(r"清单-(.+)\.csv$", Path(f).name)
        src = src.group(1) if src else Path(f).stem
        with open(f, "r", encoding="utf-8-sig", newline="") as fh:
            for r in csv.DictReader(fh):
                if args.band and r.get("支付买家数档", "").strip() != args.band:
                    continue
                if args.min is not None or args.max is not None:
                    lo, hi = bucket(r.get("支付买家数档"))
                    if lo < 0:
                        continue
                    # 用区间下限判定，避免 100 ~ 250 这种跨界档被算进 250 以上
                    if args.min is not None and lo < args.min:
                        continue
                    if args.max is not None and hi > args.max:
                        continue
                key = r.get("商品链接") or r.get("商品标题")
                if key not in merged:
                    merged[key] = dict(r)
                    merged[key]["来源"] = src
                    order.append(key)
                else:
                    s = merged[key]["来源"]
                    if src not in s:
                        merged[key]["来源"] = s + "+" + src

    items = []
    for k in order:
        r = merged[k]
        img = r.get("图片文件", "")
        if not img or not Path(img).is_file():
            continue
        items.append({
            "标题": r.get("商品标题", ""), "店铺": r.get("店铺", ""), "链接": r.get("商品链接", ""),
            "买家数档": r.get("支付买家数档", ""), "访客数档": r.get("访客数档", ""),
            "来源": r.get("来源", ""), "file": img,
            "b": bucket(r.get("支付买家数档")), "v": bucket(r.get("访客数档")),
        })
    items.sort(key=lambda x: (-x["b"][0], -x["b"][1], -x["v"][0]))
    for i, it in enumerate(items, 1):
        it["序号"] = i

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    cols, tile = args.cols, args.tile
    label_h = int(tile * 0.30)
    per_sheet = cols * args.rows_per_sheet
    font = load_font(int(tile * 0.15))
    font_s = load_font(int(tile * 0.088))

    made = []
    for si in range(0, len(items), per_sheet):
        chunk = items[si:si + per_sheet]
        rows_n = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * tile, rows_n * (tile + label_h)), (255, 255, 255))
        d = ImageDraw.Draw(sheet)
        for i, it in enumerate(chunk):
            cx, cy = (i % cols) * tile, (i // cols) * (tile + label_h)
            try:
                sheet.paste(fit(Image.open(it["file"]), tile), (cx, cy))
            except Exception:
                d.rectangle([cx, cy, cx + tile, cy + tile], fill=(238, 238, 238))
            d.rectangle([cx, cy + tile, cx + tile, cy + tile + label_h], fill=(24, 24, 28))
            d.text((cx + 8, cy + tile + 1), str(it["序号"]), fill=(255, 255, 255), font=font)
            d.text((cx + 8 + int(tile * 0.42), cy + tile + 3), it["买家数档"], fill=(255, 214, 102), font=font_s)
            d.text((cx + 8, cy + tile + int(label_h * 0.60)),
                   "访 " + it["访客数档"] + "  " + it["来源"].replace("交易", ""),
                   fill=(120, 230, 255), font=font_s)
            d.rectangle([cx, cy, cx + tile, cy + tile + label_h], outline=(205, 205, 205))
        p = out / ("汇总-%s-%02d.jpg" % (args.tag, si // per_sheet + 1))
        sheet.save(p, "JPEG", quality=86, optimize=True)
        made.append({"文件": str(p), "张数": len(chunk), "尺寸": "%dx%d" % sheet.size,
                     "MB": round(p.stat().st_size / 1048576, 2)})

    csv_path = out / ("清单-%s.csv" % args.tag)
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["排序", "来源", "支付买家数档", "访客数档", "商品标题", "店铺", "商品链接", "图片文件"])
        for k, it in enumerate(items, 1):
            w.writerow([k, it["来源"], it["买家数档"], it["访客数档"], it["标题"], it["店铺"], it["链接"], it["file"]])

    print(json.dumps({"标签": args.tag, "条数": len(items), "来源清单": [Path(c).name for c in args.csv],
                      "汇总图": made, "清单": str(csv_path)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
