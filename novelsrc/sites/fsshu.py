# -*- coding: utf-8 -*-
"""笔趣阁（fsshu.com）—— 由 go-novel-dl internal/site/fsshu.go 移植。

复用 biquge 分页目录模板，但目录前缀为 biquge、目录页数量靠试探（最多 50 页），
正文分页标记与广告行判定与 biquge5 略有差异。
Loshop & Cpt
"""
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from ..base import register
from ._biquge_common import (BiqugePagedSite, clean_fsshu_description,
                             meta_property, parse_biquge_paged_search_results)

BOOK_PREFIX = "biquge"
MAX_TEST_PAGES = 50


@register
class FsshuSite(BiqugePagedSite):
    key = "fsshu"
    display_name = "笔趣阁"
    tags = ["简体中文", "转载站", "笔趣阁"]
    hosts = ["fsshu.com"]

    base_url = "https://www.fsshu.com"
    book_prefix = BOOK_PREFIX
    search_enrich = False
    require_chapters = True

    def _host_allowed(self, host):
        return "fsshu.com" in host

    def _chapter_id_from_href(self, href):
        last = href.strip("/").split("/")[-1]
        if last.endswith(".html"):
            last = last[:-5]
        return last

    def _description(self, doc):
        return clean_fsshu_description(meta_property(doc, "og:description"))

    def _is_page_indicator(self, line):
        line = (line or "").strip()
        return line.startswith("第(") and "/" in line and line.endswith(")页")

    def _next_page_marker(self, book_path, chapter_id, idx):
        return "/%s/%s/%s_%d.html" % (self.book_prefix, book_path, chapter_id, idx + 2)

    def _fetch_book_index_pages(self, book_path):
        first = self._get("%s/%s/%s/" % (self.base_url, self.book_prefix, book_path))
        max_test = MAX_TEST_PAGES if ("book_list2" in first and "index_" in first) else 1
        pages = [""] * max_test
        pages[0] = first
        if max_test > 1:
            def fetch(page_idx):
                url = "%s/%s/%s/index_%d.html" % (
                    self.base_url, self.book_prefix, book_path, page_idx + 1)
                return page_idx, self._get(url)

            with ThreadPoolExecutor(max_workers=5) as pool:
                futures = [pool.submit(fetch, idx) for idx in range(1, max_test)]
                for future in futures:
                    try:
                        page_idx, markup = future.result()
                    except Exception:
                        continue
                    if markup and "book_list2" in markup:
                        pages[page_idx] = markup
        return [page for page in pages if page]

    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        markup = self._get("%s/search.php?q=%s" % (self.base_url, quote(keyword)))
        results = parse_biquge_paged_search_results(
            markup, self.base_url, self.key, self.resolve_url)
        if limit > 0:
            results = results[:limit]
        return results