# -*- coding: utf-8 -*-
"""出图公共组件：中文字体解析、买家数档解析、方图裁切、主图下载。

被 sheets-from-jsonl.py / merge-ranks.py / sheet-slices.py 共用。
"""
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageFont

# 榜单主图的防盗链要求带上 Referer；UA 用常见 Chrome UA 即可
REFERER = "https://sycm.taobao.com/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36")

# 中文字体：优先环境变量 SYCM_FONT，其次 Windows 微软雅黑，再退到 mac / Linux 常见中文字体
FONT_CANDIDATES = [
    os.environ.get("SYCM_FONT", ""),
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]


def load_font(size):
    """拿到能画中文的字体；都找不到就退回 PIL 内置位图字体（中文会变方框，但不报错）。"""
    for p in FONT_CANDIDATES:
        if p and Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    sys.stderr.write("[warn] 没找到中文字体，汇总图上的中文会显示成方框；"
                     "可用环境变量 SYCM_FONT 指定字体文件。\n")
    return ImageFont.load_default()


def pick_image_url(imgs):
    """从采集到的 img 列表里挑出「原图」地址。

    - 跳过 svg 图标（榜单第一张常是 24x24 的 svg）
    - 修掉拼歪的重复前缀（imgextrahttps://img.alicdn.com/...）
    - 去掉 _36x36.jpg 这类缩略后缀，换成原图
    """
    for u in (imgs or []):
        if not u or ".svg" in u.lower():
            continue
        if "https://" in u[8:]:
            u = "https://" + u.split("https://", 1)[1]
        u = re.sub(r"_\d+x\d+\.(jpg|png|webp)$", "", u, flags=re.I)
        return u
    return None


def download(url, dest, retries=3):
    """下载主图到 dest；dest 已存在且大于 800 字节就跳过（可断点续跑）。"""
    if not url:
        return False
    if Path(dest).is_file() and Path(dest).stat().st_size > 800:
        return True
    url2 = url + ("&" if "?" in url else "?") + "_.webp=0"
    for i in range(retries):
        try:
            req = urllib.request.Request(url2, headers={"Referer": REFERER, "User-Agent": UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                data = r.read()
            if len(data) < 800:
                raise ValueError("too small")
            Path(dest).write_bytes(data)
            return True
        except Exception as e:
            if i == retries - 1:
                sys.stderr.write("[warn] 下载失败 %s (%s)\n" % (os.path.basename(str(dest)), e))
            time.sleep(1.2 * (i + 1))
    return False


def bucket(v):
    """把 '100 ~ 250' / '12' / '' 统一成 (下限, 上限)，用于排序。"""
    s = str(v or "")
    m = re.search(r"(\d[\d,]*)\s*[~～\-–—至]\s*(\d[\d,]*)", s)
    if m:
        return int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))
    n = re.search(r"\d[\d,]*", s)
    if n:
        x = int(n.group(0).replace(",", ""))
        return x, x
    return -1, -1


def fit(img, size):
    """等比缩到能盖住 size×size，再居中裁成正方形（只缩不放，避免放大糊图）。"""
    img = img.convert("RGB")
    w, h = img.size
    s = size / float(min(w, h))
    if s < 1:
        img = img.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    w, h = img.size
    left, top = (w - size) // 2, max(0, (h - size) // 2)
    return img.crop((left, top, left + size, top + size))
