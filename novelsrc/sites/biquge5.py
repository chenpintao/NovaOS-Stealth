# -*- coding: utf-8 -*-
"""笔趣阁（biquge5.com）—— 由 go-novel-dl internal/site/biquge_common.go 移植。

对应 NewBiqugePagedSite("biquge5", "Biquge5", "https://www.biquge5.com", "", cfg)，
即无路径前缀的分页目录模板站点。
Loshop & Cpt
"""
from ..base import register
from ._biquge_common import BiqugePagedSite


@register
class Biquge5Site(BiqugePagedSite):
    key = "biquge5"
    display_name = "笔趣阁"
    tags = ["简体中文", "转载站", "笔趣阁"]
    hosts = ["biquge5.com"]

    base_url = "https://www.biquge5.com"
    book_prefix = ""
    search_enrich = True