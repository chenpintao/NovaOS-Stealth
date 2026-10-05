# -*- coding: utf-8 -*-
"""笔趣阁（xbiquge345.com）—— 由 go-novel-dl internal/site/biquge345.go 移植。
Loshop & Cpt
"""
import re
import time

from ..base import Site, apply_chapter_range, dedup_chapters, register
from ..htmlutil import (absolutize, attr, clean_text, find_by_id,
                        has_ancestor_class, has_ancestor_id, node_text,
                        node_text_lines, normalize_path, parse_html)
from ._biquge_common import (find_all_pred, find_first_pred, has_class,
                             normalize_url_parts)

BOOK_RE = re.compile(r"^/book/(\d+)/?$")
SHU_RE = re.compile(r"^/shu/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/chapter/(\d+)/(\d+)\.html$")
PAGE_MARK_RE = re.compile(r"[（(]\s*第\s*\d+\s*/\s*\d+\s*页\s*[)）]")
SPACE_RE = re.compile(r"\s+")

BASE = "https://www.xbiquge345.com"

# 搜索重试计划（类型 + 本轮之前的等待秒数）。站点对 /s.php 有软限流：
# 连续搜索会静默返回空结果页，只能间隔一段时间后重试把请求等回来。
SEARCH_PLAN = (
    ("articlename", 0),
    ("articlename", 6),
    ("author", 12),
    ("articlename", 17),
)

CONTENT_NOISE = (
    "（本章未完，请点击下一页继续阅读）",
    "(本章未完，请点击下一页继续阅读)",
    "本章未完，请点击下一页继续阅读",
)


@register
class Biquge345Site(Site):
    key = "biquge345"
    display_name = "笔趣阁"
    tags = ["简体中文", "转载站", "笔趣阁"]
    hosts = ["xbiquge345.com"]

    # ---- URL 反向解析 ----
    def resolve_url(self, raw_url):
        parsed = normalize_url_parts(raw_url)
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host.startswith("m."):
            host = host[2:]
        if host != "xbiquge345.com":
            return None
        path = parsed.path or ""
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "chapter_id": m.group(2),
                    "canonical": BASE + path}
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "canonical": BASE + path}
        m = SHU_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": BASE + "/book/" + m.group(1) + "/"}
        return None

    # ---- 目录 ----
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        doc = parse_html(self._get(BASE + "/book/" + book_id + "/"))

        title = clean_text(node_text(find_first_pred(
            doc, "h1", lambda n: has_ancestor_class(n, "right_border"))))
        author = clean_text(node_text(find_first_pred(
            doc, "a", lambda n: has_ancestor_class(n, "x1"))))
        description = clean_text(node_text(find_first_pred(
            doc, "div", lambda n: has_class(n, "x3"))))
        cover = absolutize(BASE, attr(find_first_pred(
            doc, "img", lambda n: has_ancestor_class(n, "zhutu")), "src"))

        chapters = []
        for a in find_all_pred(doc, "a", lambda n: has_ancestor_class(n, "info")):
            m = CHAPTER_RE.match(normalize_path(attr(a, "href")))
            if not m:
                continue
            chapters.append({"id": m.group(2), "title": clean_text(node_text(a)),
                             "url": absolutize(BASE, attr(a, "href")),
                             "order": len(chapters) + 1})
        if not chapters:
            raise ValueError("biquge345 chapter list not found for book %s" % book_id)

        return {
            "site": self.key, "id": book_id, "title": title, "author": author,
            "description": description, "source_url": BASE + "/book/" + book_id + "/",
            "cover_url": cover,
            "chapters": apply_chapter_range(dedup_chapters(chapters)),
        }

    # ---- 正文 ----
    def fetch_chapter(self, book_id, chapter):
        result = dict(chapter)
        chapter_id = (result.get("id") or "").strip()
        doc = parse_html(self._get(
            BASE + "/chapter/" + book_id + "/" + chapter_id + ".html"))

        title = clean_text(node_text(find_first_pred(
            doc, "h1", lambda n: has_ancestor_id(n, "neirong"))))
        if title:
            result["title"] = title

        container = find_by_id(doc, "txt")
        if container is None:
            container = find_first_pred(doc, "div", lambda n: has_class(n, "txt"))
        paragraphs = []
        for line in node_text_lines(container):
            cleaned = _clean_content_line(line)
            if not cleaned or _is_ad(cleaned):
                continue
            if _same_title(cleaned, result.get("title") or ""):
                continue
            paragraphs.append(cleaned)
        if not paragraphs:
            raise ValueError("biquge345 chapter content not found: %s" % chapter_id)
        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    # ---- 搜索 ----
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        results = []
        seen = set()
        last_err = None
        for search_type, delay in SEARCH_PLAN:
            if delay > 0:
                time.sleep(delay)
            try:
                items = self._search_by_type(search_type, keyword)
            except Exception as exc:
                last_err = exc
                continue
            for item in items:
                book_id = item.get("book_id")
                if not book_id or book_id in seen:
                    continue
                seen.add(book_id)
                results.append(item)
            if results:
                break
        if not results:
            if last_err is not None:
                raise last_err
            return []
        if limit > 0:
            results = results[:limit]
        for item in results[:6]:
            try:
                self._populate_search_detail(item)
            except Exception:
                continue
        return results

    def _search_by_type(self, search_type, keyword):
        form = {"type": search_type, "s": keyword, "submit": ""}
        markup = self.http.post_form(BASE + "/s.php", form,
                                     headers={"Referer": BASE + "/"})
        return _parse_search(markup)

    def _populate_search_detail(self, item):
        book_id = item.get("book_id")
        if not book_id:
            return
        doc = parse_html(self._get(BASE + "/book/" + book_id + "/"))
        title = clean_text(node_text(find_first_pred(
            doc, "h1", lambda n: has_ancestor_class(n, "right_border"))))
        if title:
            item["title"] = title
        author = clean_text(node_text(find_first_pred(
            doc, "a", lambda n: has_ancestor_class(n, "x1"))))
        if author:
            item["author"] = author
        description = clean_text(node_text(find_first_pred(
            doc, "div", lambda n: has_class(n, "x3"))))
        if description:
            item["description"] = description
        cover = absolutize(BASE, attr(find_first_pred(
            doc, "img", lambda n: has_ancestor_class(n, "zhutu")), "src"))
        if cover:
            item["cover_url"] = cover
        item["url"] = BASE + "/book/" + book_id + "/"

    # ---- HTTP ----
    def _get(self, url):
        return self.http.get(url)


def _parse_search(markup):
    doc = parse_html(markup)
    results = []
    seen = set()
    for lst in find_all_pred(doc, "ul", lambda n: has_class(n, "search")):
        for item in lst.find_all("li", recursive=False):
            if has_class(item, "fen"):
                continue
            title_link = find_first_pred(item, "a", lambda n: has_ancestor_class(n, "name"))
            if title_link is None:
                continue
            m = BOOK_RE.match(normalize_path(attr(title_link, "href")))
            if not m:
                continue
            book_id = m.group(1)
            if book_id in seen:
                continue
            seen.add(book_id)
            author = clean_text(node_text(find_first_pred(
                item, "a", lambda n: has_ancestor_class(n, "zuo"))))
            latest = clean_text(node_text(find_first_pred(
                item, "a", lambda n: has_ancestor_class(n, "jie"))))
            results.append({
                "site": "biquge345",
                "book_id": book_id,
                "title": clean_text(node_text(title_link)),
                "author": author,
                "url": BASE + "/book/" + book_id + "/",
                "latest_chapter": latest,
            })
    return results


def _clean_content_line(line):
    cleaned = line
    for noise in CONTENT_NOISE:
        cleaned = cleaned.replace(noise, "")
    cleaned = PAGE_MARK_RE.sub("", cleaned)
    return cleaned.strip()


def _same_title(line, title):
    title = (title or "").strip()
    if not title:
        return False
    return SPACE_RE.sub("", line) == SPACE_RE.sub("", title)


def _is_ad(line):
    line = (line or "").strip()
    if not line:
        return True
    lower = line.lower()
    if "xbiquge345.com" in lower or "biquge345.com" in lower:
        return True
    if line.startswith("一秒记住"):
        return True
    if len(line) <= 40 and "笔趣阁" in line:
        return True
    return False