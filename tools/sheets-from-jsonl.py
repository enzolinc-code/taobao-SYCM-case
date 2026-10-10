# -*- coding: utf-8 -*-
"""把采集到的榜单 JSONL 做成「按当天支付买家数排序」的带编号大缩略图 + 清单 CSV。

用法：
  python tools/sheets-from-jsonl.py --jsonl "<采集.jsonl>" --out-dir "<输出目录>" --tag "交易总量"
    [--cols 10] [--tile 300] [--rows-per-sheet 8]

产出：
  <输出目录>/images/*.jpg      主图（按采序号命名，已存在就不重复下载，可断点续跑）
  <输出目录>/汇总-<tag>-NN.jpg  带编号的大缩略图
  <输出目录>/清单-<tag>.csv     排序 / 序号 / 支付买家数档 / 访客数档 / 标题 / 店铺 / 链接 / 图片文件
  <输出目录>/清单-<tag>-缺图.csv 主图没下下来的，需要手工看
"""
import argparse
import csv
import json
from pathlib import Path

from PIL import Image, ImageDraw

from sheetlib import bucket, download, fit, load_font, pick_image_url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jsonl", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--cols", type=int, default=10)
    ap.add_argument("--tile", type=int, default=300)
    ap.add_argument("--rows-per-sheet", type=int, default=8)
    args = ap.parse_args()

    out = Path(args.out_dir)
    img_dir = out / "images"
    img_dir.mkdir(parents=True, exist_ok=True)

    rows = [json.loads(l) for l in Path(args.jsonl).read_text(encoding="utf-8").splitlines() if l.strip()]
    # 按链接去重，保留第一次出现
    seen, uniq = set(), []
    for r in rows:
        k = r.get("itemLink") or r.get("title")
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)

    items, failed = [], []
    for i, r in enumerate(uniq, 1):
        f = img_dir / ("%03d.jpg" % i)
        if not download(pick_image_url(r.get("imgs")), str(f)):
            failed.append({
                "序号": i, "支付买家数档": str(r.get("buyers") or ""),
                "商品标题": r.get("title", ""), "店铺": r.get("shop", ""),
                "商品链接": r.get("itemLink", ""), "原图地址": pick_image_url(r.get("imgs")) or "",
            })
            continue
        items.append({
            "序号": i, "买家数档": str(r.get("buyers") or ""), "访客数档": str(r.get("visitors") or ""),
            "标题": r.get("title", ""), "店铺": r.get("shop", ""), "链接": r.get("itemLink", ""),
            "file": str(f), "b": bucket(r.get("buyers")), "v": bucket(r.get("visitors")),
        })
    # 支付买家数从高到低；同档用访客数档做二次排序
    items.sort(key=lambda x: (-x["b"][0], -x["b"][1], -x["v"][0], x["序号"]))

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
            d.text((cx + 8, cy + tile + int(label_h * 0.60)), "访 " + it["访客数档"], fill=(120, 230, 255), font=font_s)
            d.rectangle([cx, cy, cx + tile, cy + tile + label_h], outline=(205, 205, 205))
        p = out / ("汇总-%s-%02d.jpg" % (args.tag, si // per_sheet + 1))
        sheet.save(p, "JPEG", quality=86, optimize=True)
        made.append({"文件": str(p), "张数": len(chunk), "尺寸": "%dx%d" % sheet.size,
                     "MB": round(p.stat().st_size / 1048576, 2)})

    csv_path = out / ("清单-%s.csv" % args.tag)
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["排序", "序号", "支付买家数档", "访客数档", "商品标题", "店铺", "商品链接", "图片文件"])
        for k, it in enumerate(items, 1):
            w.writerow([k, it["序号"], it["买家数档"], it["访客数档"], it["标题"], it["店铺"], it["链接"], it["file"]])

    if failed:
        fp = out / ("清单-%s-缺图.csv" % args.tag)
        with open(fp, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["序号", "支付买家数档", "商品标题", "店铺", "商品链接", "原图地址"])
            w.writeheader()
            w.writerows(failed)

    print(json.dumps({"标签": args.tag, "去重后": len(uniq), "出图": len(items), "缺图": len(failed),
                      "汇总图": made, "清单": str(csv_path)}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
