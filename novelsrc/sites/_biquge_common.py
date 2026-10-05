# -*- coding: utf-8 -*-
"""笔趣阁系（biquge 模板）书源的公共实现。

由 go-novel-dl 的 internal/site/biquge_common.go 与 fsshu.go 移植：
  * BiqugePagedSite —— 通用「index_N.html 分页目录」模板，biquge5 / fsshu 共用
  * 其余为 HTML / 文本 / URL 工具函数

注意：本模块文件名以下划线开头，不会被 novelsrc/sites/__init__.py 自动注册。
纯 Python 3.8 兼容（不得使用 3.9+ 语法）。
Loshop & Cpt
"""
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote, urlsplit

from ..base import Site, apply_chapter_range, dedup_chapters
from ..htmlutil import (absolutize, attr, clean_text, find_by_id,
                        has_ancestor_class, has_ancestor_tag, node_text,
                        node_text_lines, parse_html)

PAGED_INDEX_RE = re.compile(r"""href=["'][^"']*index_(\d+)\.html""")


# ---------------------------------------------------------------------------
# 基础 HTML / 文本工具（对齐 go domutil / esjzone 中的同名函数）
# ---------------------------------------------------------------------------
def has_class(node, class_name):
    if node is None:
        return False
    classes = node.get("class") or []
    return class_name in classes


def find_first_pred(node, tag, pred):
    """返回第一个满足 pred 的 tag 后代（不含 node 自身，语义与调用点一致）。"""
    if node is None:
        return None
    for item in node.find_all(tag):
        if pred(item):
            return item
    return None


def find_all_pred(node, tag, pred):
    if node is None:
        return []
    return [item for item in node.find_all(tag) if pred(item)]


def node_find_all(node, name=None):
    """按标签名查找（不传 class_ 过滤，避免 bs4 把 class_=None 当成 class 条件）。"""
    if node is None:
        return []
    return node.find_all(name)


def node_find_first(node, name=None):
    if node is None:
        return None
    return node.find(name)


def meta_property(doc, prop):
    for meta in doc.find_all("meta"):
        if attr(meta, "property") == prop:
            content = attr(meta, "content").strip()
            if content:
                return content
    return ""


def fallback(value, other):
    value = (value or "").strip()
    if value:
        return value
    return (other or "").strip()


def normalize_maybe_protocol(url):
    url = (url or "").strip()
    if url.startswith("//"):
        return "https:" + url
    return url


def strip_nested_html(markup):
    """去掉嵌套的 html/body 包裹与 head 段（对齐 go 的 stripNestedHTML）。"""
    markup = markup.replace("<html>", "").replace("</html>", "")
    markup = markup.replace("<body>", "").replace("</body>", "")
    lowered = markup.lower()
    while True:
        start = lowered.find("<head>")
        end = lowered.find("</head>")
        if start < 0 or end < 0 or end < start:
            break
        markup = markup[:start] + markup[end + 7:]
        lowered = markup.lower()
    return markup


def normalize_url_parts(raw_url):
    raw_url = (raw_url or "").strip()
    if not (raw_url.startswith("http://") or raw_url.startswith("https://")):
        raw_url = "https://" + raw_url
    return urlsplit(raw_url)


def is_biquge_ad_line(line):
    for marker in ("笔趣阁小说网", "biquge", "第(", "页"):
        if marker in line:
            return True
    return False


def trim_search_category_prefix(title):
    title = (title or "").strip()
    if title.startswith("["):
        idx = title.find("]")
        if idx >= 0:
            return title[idx + 1:].strip()
    return title


def biquge_search_field(node, prefix):
    if node is None:
        return ""
    for item in find_all_pred(node, "dd", lambda n: has_class(n, "book_other")):
        text = clean_text(node_text(item))
        if not text.startswith(prefix):
            continue
        text = text[len(prefix):].strip()
        span = node_find_first(item, "span")
        if span is not None:
            value = clean_text(node_text(span))
            if value:
                return value
        return text
    return ""


def max_paged_index(markup):
    max_page = 1
    for match in PAGED_INDEX_RE.findall(markup or ""):
        try:
            page = int(match)
        except (TypeError, ValueError):
            continue
        if page > max_page:
            max_page = page
    return max_page


def parse_biquge_paged_search_results(markup, base_url, site_key, resolve_func):
    doc = parse_html(markup)
    results = []
    seen = set()
    for card in find_all_pred(doc, "dl", lambda n: node_find_first(n, "dt") is not None):
        title_link = find_first_pred(card, "a", lambda n: (
            has_ancestor_tag(n, "h3") and _resolves(resolve_func, base_url, n)))
        if title_link is None:
            continue
        href = attr(title_link, "href").strip()
        raw_url = absolutize(base_url, href)
        resolved = resolve_func(raw_url)
        if not resolved or not resolved.get("book_id"):
            continue
        book_id = resolved["book_id"]
        if book_id in seen:
            continue
        seen.add(book_id)

        latest = ""
        for item in find_all_pred(card, "dd", lambda n: has_class(n, "book_other")):
            text = clean_text(node_text(item))
            if not text.startswith("最新章节："):
                continue
            latest = text[len("最新章节："):].strip()
            latest_link = node_find_first(item, "a")
            if latest_link is not None:
                latest = clean_text(node_text(latest_link))
            break

        cover = ""
        img = node_find_first(card, "img")
        if img is not None:
            cover = absolutize(base_url, attr(img, "src"))

        results.append({
            "site": site_key,
            "book_id": book_id,
            "title": trim_search_category_prefix(clean_text(node_text(title_link))),
            "author": biquge_search_field(card, "作者："),
            "url": raw_url,
            "latest_chapter": latest,
            "cover_url": cover,
        })
    return results


def _resolves(resolve_func, base_url, node):
    href = attr(node, "href").strip()
    if not href:
        return False
    resolved = resolve_func(absolutize(base_url, href))
    return bool(resolved and resolved.get("book_id"))


# ---------------------------------------------------------------------------
# 分页模板站点基类（对应 go 的 BiqugePagedSite / FsshuSite）
# ---------------------------------------------------------------------------
class BiqugePagedSite(Site):
    """「/bookPath/index_N.html」目录分页模板的公共实现。"""

    base_url = ""
    book_prefix = ""
    search_enrich = True
    require_chapters = False

    # ---- URL 反向解析 ----
    def _host_allowed(self, host):
        base_host = self.base_url
        for scheme in ("https://", "http://"):
            if base_host.startswith(scheme):
                base_host = base_host[len(scheme):]
                break
        if base_host.startswith("www."):
            base_host = base_host[4:]
        return base_host in host

    def resolve_url(self, raw_url):
        parsed = normalize_url_parts(raw_url)
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if not self._host_allowed(host):
            return None
        path = parsed.path or ""
        parts = path.strip("/").split("/")
        if not parts or parts[0] == "":
            return None
        book_parts = list(parts)
        if self.book_prefix and book_parts[0] == self.book_prefix:
            book_parts = book_parts[1:]
        if not book_parts:
            return None
        if len(parts) == 1 or (len(parts) == 2 and self.book_prefix and parts[0] == self.book_prefix):
            return {"site": self.key, "book_id": "_".join(book_parts), "canonical": raw_url}
        book_id = "_".join(book_parts[:-1])
        last = parts[-1]
        if last.endswith(".html"):
            cid = last.split("_")[0]
            if cid.endswith(".html"):
                cid = cid[:-5]
            return {"site": self.key, "book_id": book_id, "chapter_id": cid,
                    "canonical": raw_url}
        return {"site": self.key, "book_id": "_".join(book_parts), "canonical": raw_url}

    # ---- 可覆盖点 ----
    def _chapter_id_from_href(self, href):
        last = href.strip("/").split("/")[-1]
        cid = last.split("_")[0]
        if cid.endswith(".html"):
            cid = cid[:-5]
        return cid

    def _description(self, doc):
        return fallback(meta_property(doc, "og:description"),
                        clean_text(node_text(find_by_id(doc, "intro_pc"))))

    def _is_page_indicator(self, line):
        return ("页" in line and "第(" in line)

    def _next_page_marker(self, book_path, chapter_id, idx):
        return "_%d.html" % (idx + 2)

    # ---- HTTP ----
    def _get(self, url):
        return self.http.get(url)

    def _book_url(self, book_id):
        if self.book_prefix:
            return "%s/%s/%s/" % (self.base_url, self.book_prefix, book_id)
        return "%s/%s/" % (self.base_url, book_id)

    def _book_index_url(self, book_path, page):
        if self.book_prefix:
            base = "%s/%s/%s/" % (self.base_url, self.book_prefix, book_path)
        else:
            base = "%s/%s/" % (self.base_url, book_path)
        if page <= 1:
            return base
        return base.rstrip("/") + "/index_%d.html" % page

    # ---- 目录 ----
    def _fetch_book_index_pages(self, book_path):
        first = self._get(self._book_index_url(book_path, 1))
        max_page = max_paged_index(first)
        pages = [None] * max_page
        pages[0] = first
        if max_page <= 1:
            return pages

        def fetch(page):
            return self._get(self._book_index_url(book_path, page))

        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = [pool.submit(fetch, page) for page in range(2, max_page + 1)]
            for idx, future in enumerate(futures):
                pages[idx + 1] = future.result()
        return pages

    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        pages = self._fetch_book_index_pages(book_id)
        if not pages:
            raise ValueError("book page not found")
        doc = parse_html(pages[0])
        chapters = []
        for page in pages:
            pdoc = parse_html(page)
            for a in find_all_pred(pdoc, "a", lambda n: has_ancestor_class(n, "book_list2")):
                href = attr(a, "href").strip()
                if not href:
                    continue
                chapters.append({
                    "id": self._chapter_id_from_href(href),
                    "title": clean_text(node_text(a)),
                    "url": absolutize(self.base_url, href),
                    "order": len(chapters) + 1,
                })
        chapters = apply_chapter_range(dedup_chapters(chapters))
        if self.require_chapters and not chapters:
            raise ValueError("no chapters found")
        return {
            "site": self.key, "id": book_id,
            "title": meta_property(doc, "og:novel:book_name"),
            "author": meta_property(doc, "og:novel:author"),
            "description": self._description(doc),
            "source_url": "%s/%s/%s/" % (self.base_url, self.book_prefix, book_id),
            "cover_url": normalize_maybe_protocol(meta_property(doc, "og:image")),
            "chapters": chapters,
        }

    # ---- 正文 ----
    def _chapter_url(self, book_path, chapter_id, idx):
        if self.book_prefix:
            url = "%s/%s/%s/%s.html" % (self.base_url, self.book_prefix, book_path, chapter_id)
        else:
            url = "%s/%s/%s.html" % (self.base_url, book_path, chapter_id)
        if idx > 0:
            url = url[:-5] + "_%d.html" % (idx + 1)
        return url

    def fetch_chapter(self, book_id, chapter):
        book_path = book_id
        result = dict(chapter)
        chapter_id = (result.get("id") or "").strip()
        blocks = []
        idx = 0
        while True:
            url = self._chapter_url(book_path, chapter_id, idx)
            try:
                markup = self._get(url)
            except Exception:
                if idx == 0:
                    raise
                break
            markup = strip_nested_html(markup)
            doc = parse_html(markup)
            if not result.get("title"):
                node = node_find_first(doc, "h1")
                if node is not None:
                    title = clean_text(node_text(node))
                    pos = title.find("《")
                    if pos >= 0:
                        title = title[:pos].strip()
                    result["title"] = title.rstrip(" -—")
            for article in node_find_all(doc, "article"):
                texts = []
                for txt in node_text_lines(article):
                    txt = txt.strip()
                    if not txt or is_biquge_ad_line(txt) or self._is_page_indicator(txt):
                        continue
                    texts.append(txt)
                if texts:
                    blocks.append("\n".join(texts))
            if self._next_page_marker(book_path, chapter_id, idx) not in markup:
                break
            idx += 1
        if not blocks:
            raise ValueError("chapter content not found")
        result["content"] = "\n".join(blocks)
        result["downloaded"] = True
        return result

    # ---- 搜索 ----
    def _search_url(self, keyword):
        return "%s/search.php?q=%s&p=1" % (self.base_url, quote(keyword))

    def _search_headers(self):
        return {"Referer": self.base_url.rstrip("/") + "/"}

    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        markup = self._get_with_headers(self._search_url(keyword), self._search_headers())
        results = parse_biquge_paged_search_results(
            markup, self.base_url, self.key, self.resolve_url)
        if limit > 0:
            results = results[:limit]
        if self.search_enrich:
            self._enrich(results)
        return results

    def _get_with_headers(self, url, headers=None):
        return self.http.get(url, headers=headers)

    def _enrich(self, results):
        for item in results[:6]:
            if not item.get("book_id"):
                continue
            try:
                self._populate_search_detail(item)
            except Exception:
                continue

    def _populate_search_detail(self, item):
        url = self._book_url(item["book_id"])
        doc = parse_html(self._get(url))
        title = fallback(meta_property(doc, "og:novel:book_name"),
                         meta_property(doc, "og:title"))
        if title:
            item["title"] = trim_search_category_prefix(title)
        author = fallback(meta_property(doc, "og:novel:author"),
                          biquge_search_field(doc, "作者："))
        if author:
            item["author"] = author
        description = self._description(doc)
        if description:
            item["description"] = description
        cover = normalize_maybe_protocol(meta_property(doc, "og:image"))
        if cover:
            item["cover_url"] = cover
        item["url"] = url


def clean_fsshu_description(value):
    value = (value or "").strip()
    if not value:
        return ""
    value = value.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    return clean_text(value)