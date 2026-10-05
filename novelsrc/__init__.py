# -*- coding: utf-8 -*-
"""novelsrc —— go-novel-dl 书源的 Python 移植框架。

对外统一入口：
    from novelsrc import get_site, site_keys, all_sites
    site = get_site("shuhaige")
    site.search("斗破苍穹")
    site.download_plan("123")
    site.fetch_chapter("123", {"id": "456"})

纯 Python 3.8 兼容（Windows 7 可用），依赖 requests + beautifulsoup4 + lxml
（加密站点另需 pycryptodome / cryptography，EPUB 导出需 ebooklib）。
Loshop & Cpt
"""
from .base import (SITES, Site, all_sites, apply_chapter_range, dedup_chapters,
                   get_site, register, site_keys)
from .http import HttpClient, HttpError, decode_bytes
from .htmlutil import parse_html
from . import sites  # noqa: F401  触发站点注册

__all__ = [
    "SITES", "Site", "register", "get_site", "site_keys", "all_sites",
    "dedup_chapters", "apply_chapter_range", "HttpClient", "HttpError",
    "decode_bytes", "parse_html",
]