#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 GeoGebra 官方 Web 应用镜像到本地，供 OS 离线加载。

为什么需要：GeoGebra 的应用由 GWT 编译，入口 web3d.nocache.js 会按需
拉取大量 deferredjs 模块，首屏要几十秒（实测 >60s 超时）。镜像到本地后
由电脑端直接提供，局域网内基本瞬时打开，且断网可用。

用法：python3 verify/geo_mirror.py [输出目录]
"""
import os
import sys
import time
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

VERSION = "5.4.933.1"
MODULE = "29EB0586CD5B749E221F6BB019F1B206"
BASE = "https://www.geogebra.org/apps/%s/" % VERSION

# (相对路径, 是否必需)
STATIC = [
    ("web3d/web3d.nocache.js", True),
    ("web3d/%s.cache.js" % MODULE, True),
    ("web3d/clear.cache.gif", True),
    ("css/fonts.css", False),
    ("css/greek-font.css", False),
]

# 语言包：界面文本，缺了会显示英文键名
LANGS = ["zh-CN", "en"]

MAX_DEFERRED = 60          # 探测上限（实际按 404 停止）


def fetch(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def save(root, rel, data):
    path = os.path.join(root, rel.replace("/", os.sep))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "novaos2/lib/geogebra"
    os.makedirs(out, exist_ok=True)

    ok = fail = 0
    total = 0

    def get(rel, required=True):
        nonlocal ok, fail, total
        url = BASE + rel
        try:
            st, data = fetch(url)
            if st != 200:
                if required:
                    print("  ✗ %s -> HTTP %s" % (rel, st))
                    fail += 1
                return False
            n = save(out, rel, data)
            total += n
            ok += 1
            print("  ✓ %-56s %8.1f KB" % (rel, n / 1024))
            return True
        except Exception as e:
            if required:
                print("  ✗ %s -> %s" % (rel, e))
                fail += 1
            return False

    print("镜像版本 %s" % VERSION)
    for rel, req in STATIC:
        get(rel, req)

    for lang in LANGS:
        get("web3d/js/properties_keys_%s.js" % lang, False)

    print("探测 deferredjs 模块 ...")
    miss = 0
    for i in range(1, MAX_DEFERRED + 1):
        rel = "web3d/deferredjs/%s/%d.cache.js" % (MODULE, i)
        url = BASE + rel
        try:
            st, data = fetch(url, timeout=120)
            if st != 200:
                miss += 1
                if miss >= 3:
                    break
                continue
            miss = 0
            n = save(out, rel, data)
            total += n
            ok += 1
            print("  ✓ %-56s %8.1f KB" % (rel, n / 1024))
        except Exception:
            miss += 1
            if miss >= 3:
                break

    print("\n完成：成功 %d 个，失败 %d 个，共 %.1f MB" % (ok, fail, total / 1048576))
    print("输出目录：%s" % os.path.abspath(out))
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
