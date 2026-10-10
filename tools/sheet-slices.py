# -*- coding: utf-8 -*-
"""把清单切成「能在聊天窗口里直接看清」的连续大图切片。

为什么要切：一张 80 格的大图缩到可显示宽度后，每格只剩 100 像素看不出图案；
切成每片 5 列 x 5 行、再缩到宽 1280，每格约 256 像素，肉眼能分辨，单片约 0.25MB。

用法：
  python tools/sheet-slices.py --csv "<清单.csv>" --out-dir "<目录>" --tag "1-9件"
    [--cols 5] [--rows 5] [--tile 300] [--width 1280]

产出：<目录>/_看图/<tag>_看图_01.jpg ...
"""
import argparse
import csv
import json
from pathlib import Path

from PIL import Image, ImageDraw

from sheetlib import fit, load_font


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--cols", type=int, default=5)
    ap.add_argument("--rows", type=int, default=5)
    ap.add_argument("--tile", type=int, default=300)
    ap.add_argument("--width", type=int, default=1280)
    args = ap.parse_args()

    with open(args.csv, encoding="utf-8-sig", newline="") as fh:
        rows = [r for r in csv.DictReader(fh) if Path(r.get("图片文件", "")).is_file()]
    if not rows:
        raise SystemExit("清单里没有可用图片")

    out = Path(args.out_dir) / "_看图"
    out.mkdir(parents=True, exist_ok=True)
    tile, cols, rows_per = args.tile, args.cols, args.rows
    label_h = int(tile * 0.30)
    per = cols * rows_per
    f = load_font(int(tile * 0.15))
    fs = load_font(int(tile * 0.088))

    made = []
    for si in range(0, len(rows), per):
        chunk = rows[si:si + per]
        n = (len(chunk) + cols - 1) // cols
        sheet = Image.new("RGB", (cols * tile, n * (tile + label_h)), (255, 255, 255))
        d = ImageDraw.Draw(sheet)
        for i, r in enumerate(chunk):
            cx, cy = (i % cols) * tile, (i // cols) * (tile + label_h)
            try:
                sheet.paste(fit(Image.open(r["图片文件"]), tile), (cx, cy))
            except Exception:
                d.rectangle([cx, cy, cx + tile, cy + tile], fill=(238, 238, 238))
            d.rectangle([cx, cy + tile, cx + tile, cy + tile + label_h], fill=(24, 24, 28))
            d.text((cx + 8, cy + tile + 1), str(r.get("排序", "")), fill=(255, 255, 255), font=f)
            d.text((cx + 8 + int(tile * 0.42), cy + tile + 3), r.get("支付买家数档", ""), fill=(255, 214, 102), font=fs)
            d.text((cx + 8, cy + tile + int(label_h * 0.60)),
                   "访 " + r.get("访客数档", "") + "  " + r.get("来源", "").replace("交易", ""),
                   fill=(120, 230, 255), font=fs)
            d.rectangle([cx, cy, cx + tile, cy + tile + label_h], outline=(205, 205, 205))
        w = args.width
        sheet = sheet.resize((w, int(w * sheet.height / sheet.width)), Image.LANCZOS)
        p = out / ("%s_看图_%02d.jpg" % (args.tag, si // per + 1))
        sheet.save(p, "JPEG", quality=84, optimize=True)
        made.append({"文件": str(p), "张数": len(chunk), "尺寸": "%dx%d" % sheet.size,
                     "KB": round(p.stat().st_size / 1024)})

    print(json.dumps({"标签": args.tag, "总条数": len(rows), "切片数": len(made), "切片": made},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
