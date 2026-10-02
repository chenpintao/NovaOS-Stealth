# -*- coding: utf-8 -*-
"""Tzy OS HTML 注入改造、缓存策略与 HTTP 常量。"""
import json
import os
import re
import time
from email.utils import formatdate as http_date

from novacore.paths import BRIDGE_PATH
from novacore.configutil import cfg, CONFIG, mount_prefix, BROWSER_KEYS
from novacore.netutil import hotspot_ip, answer_ip, local_ip

HOP_BY_HOP = {"content-encoding", "content-length", "transfer-encoding", "connection",
              "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "upgrade"}


# ----------------------------- Tzy OS HTML 改造 -----------------------------
_GA_PATTERNS = [
    re.compile(r'<script\s+async\s+src="https://www\.googletagmanager\.com/[^"]*"></script>', re.I),
    re.compile(r"<script>\s*window\.dataLayer[\s\S]*?gtag\('config'[\s\S]*?</script>", re.I),
]


def nova_origin_base():
    """挂载点绝对根 URL，如 http://web-alicdn.zyai.cc/__nova__/"""
    return "%s://%s%s" % (str(cfg("serve_scheme", "http")), cfg("serve_host"), mount_prefix())


def transform_nova_html(html_bytes, is_top_index=False):
    html = html_bytes.decode("utf-8", errors="replace")

    # 本地化占位符 -> 挂载点绝对 URL（app 内容运行在 blob 文档，必须绝对地址）
    html = html.replace("__NOVA_ORIGIN__", nova_origin_base())

    # bridge（手势关闭 / SW 封禁）只注入顶层 index.html，app 子页面不注入
    if not is_top_index:
        return html.encode("utf-8")

    if cfg("strip_ga", True):
        for p in _GA_PATTERNS:
            html = p.sub("", html)

    with open(BRIDGE_PATH, "r", encoding="utf-8") as f:
        bridge = f.read()
    bridge_cfg = {k: cfg(k) for k in BROWSER_KEYS
                  if k in CONFIG and k.startswith("trigger_")}
    # 纯 <img> 打点：不依赖 JS。解析到就回传，用于判定“平板到底有没有解析这份 HTML”。
    def _beacon(tag):
        return ('<img src="__err__.gif?p=%s" width="1" height="1" alt="" '
                'style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">' % tag)

    # 直连候选 IP：断 DNS 劫持后，平板用这些地址直连本机 API（不经过域名）
    lan_cfg = {"hotspot": hotspot_ip(), "answer": answer_ip(), "local": local_ip(),
               "mount": mount_prefix()}
    inject = ('<meta name="referrer" content="no-referrer">'
              + _beacon("h")
              + '<script>window.__NOVA_LAN__=%s;</script>'
              '<script>window.__BRIDGE_CFG__=%s;</script>'
              '<script>%s</script>' % (
                  json.dumps(lan_cfg, ensure_ascii=False),
                  json.dumps(bridge_cfg, ensure_ascii=False), bridge))
    if re.search(r"<head[^>]*>", html, re.I):
        html = re.sub(r"(<head[^>]*>)", r"\1" + inject, html, count=1, flags=re.I)
    else:
        html = inject + html
    if re.search(r"</body[^>]*>", html, re.I):
        html = re.sub(r"(</body[^>]*>)", _beacon("e") + r"\1", html, count=1, flags=re.I)
    else:
        html += _beacon("e")
    return html.encode("utf-8")


# ----------------------------- HTTP 透明代理 -----------------------------
YEAR_SECONDS = 31536000
FILELIST_NAME = "__filelist__.json"

# 透传时可安全长期缓存的静态资源扩展名。
# 注意：不放 .html/.htm/.json/.webmanifest —— 平台入口 HTML 与数据接口的缓存
# 策略应遵从源站（通常是 no-cache/ETag），强制一年会导致平台自身更新不可见。
# 我们自己的挂载点（serve_nova）与注入后的 manifest 不受此表限制。
CACHEABLE_EXT = {
    ".js", ".css",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".wasm", ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".zip",
}


def apply_long_cache(resp):
    """缓存投毒：让浏览器把响应在磁盘缓存保留一年（断劫持后离线可用的核心）。"""
    resp.headers["Cache-Control"] = "public, max-age=%d" % YEAR_SECONDS
    resp.headers["Expires"] = http_date(time.time() + YEAR_SECONDS, usegmt=True)
    # 去掉校验相关头，确保新鲜期内浏览器绝不回源
    resp.headers.pop("ETag", None)
    resp.headers.pop("Last-Modified", None)
    if resp.headers.get("Pragma"):
        resp.headers.pop("Pragma", None)


def is_api_path(path):
    p = "/" + path.lower()
    return "/api/" in p or p.endswith("/api")