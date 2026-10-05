# -*- coding: utf-8 -*-
"""联天书屋（m.ltxswu.me / m.ltxswu.net）—— 由 go-novel-dl internal/site/mobile17.go 移植。
17mb 手机模板站，必须使用手机 UA；搜索关键字按 GBK 提交。本机 SSL 错误，未实测。
"""
import re
from urllib.parse import quote_from_bytes, urlsplit

from bs4 import NavigableString, Tag

from ..base import Site, apply_chapter_range, dedup_chapters, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_by_id,
                        find_first, has_ancestor_class, has_ancestor_tag,
                        normalize_path, parse_html)

BASE = "http://m.ltxswu.me"
MOBILE_UA = ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")

BOOK_RE = re.compile(r"^/book/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/book/(\d+)/([A-Za-z0-9]+)(?:_\d+)?\.html$")
TITLE_PAGE_RE = re.compile(r"^(.*?)\s*\(第\s*[0-9]+\s*/\s*[0-9]+\s*页\)\s*$")
LIST_PAGE_RE = re.compile(r"^/book/\d+_\d+/$")
DIGITS_RE = re.compile(r"^\d+$")

AD_MARKERS = ("地址发布", "请截图保存", "请记住本站", "请收藏本站",
              "点击下一页", "本章未完", "手机访问", "加入书签", "返回目录")


# ---------------------------------------------------------------------------
# 文本工具（对齐 Go htmlutil）
# ---------------------------------------------------------------------------
def _clean_go(value):
    if not value:
        return ""
    value = value.replace("\u00a0", " ").replace("\r", "")
    out = []
    for line in value.split("\n"):
        line = " ".join(line.split())
        if line:
            out.append(line)
    return "\n".join(out)


def _node_text_raw(node):
    if node is None:
        return ""
    parts = []
    _walk_raw(node, parts)
    return "".join(parts)


def _walk_raw(node, out):
    for child in node.children:
        if isinstance(child, NavigableString):
            out.append(str(child))
        elif isinstance(child, Tag):
            _walk_raw(child, out)


def _node_text_lb(node):
    if node is None:
        return ""
    parts = []
    _walk_lb(node, parts)
    return "".join(parts)


def _walk_lb(node, out):
    for child in node.children:
        if isinstance(child, NavigableString):
            out.append(str(child))
        elif isinstance(child, Tag):
            if child.name == "br":
                out.append("\n")
            else:
                _walk_lb(child, out)


def _meta_property(doc, name):
    for node in find_all(doc, "meta"):
        if attr(node, "property") == name:
            content = attr(node, "content").strip()
            if content:
                return content
    return ""


def _normalize_maybe_protocol(url):
    url = (url or "").strip()
    if url.startswith("//"):
        return "https:" + url
    return url


def _parse_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "https://" + raw
    return urlsplit(raw)


def _host_of(parsed):
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def _previous_element_sibling(node):
    for sibling in node.previous_siblings:
        if isinstance(sibling, Tag):
            return sibling
    return None


@register
class LtxswuSite(Site):
    key = "ltxswu"
    display_name = "联天书屋"
    tags = ["简体中文", "转载站", "成人向", "NSFW"]
    hosts = ["m.ltxswu.net", "m.ltxswu.me"]
    timeout = 25.0

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        parsed = _parse_url(raw_url)
        if parsed is None:
            return None
        host = _host_of(parsed)
        if host not in ("m.ltxswu.net", "m.ltxswu.me"):
            return None
        path = parsed.path
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "chapter_id": m.group(2),
                    "canonical": self._chapter_url(m.group(1), m.group(2))}
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": self._book_url(m.group(1))}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("%s book id is required" % self.key)
        if not DIGITS_RE.match(book_id):
            raise ValueError("%s 仅支持纯数字书号，收到 %r" % (self.display_name, book_id))

        markup = self._get(self._book_url(book_id))
        doc = parse_html(markup)

        title = _meta_property(doc, "og:novel:book_name") or _meta_property(doc, "og:title")
        if not title:
            title = clean_text(_node_text_raw(find_first(doc, "h1")))

        author = _meta_property(doc, "og:novel:author")
        if not author:
            for a in find_all(doc, "a"):
                if attr(a, "href").startswith("/author/"):
                    author = clean_text(_node_text_raw(a))
                    break

        description = clean_text(_meta_property(doc, "og:description"))
        cover = _normalize_maybe_protocol(_meta_property(doc, "og:image"))
        if not cover:
            img = None
            for node in find_all(doc, "img"):
                if has_ancestor_class(node, "block_img2"):
                    img = node
                    break
            cover = _normalize_maybe_protocol(attr(img, "src"))

        chapters = self._collect_chapters(markup, doc, book_id)
        if not chapters:
            raise ValueError("%s chapter list not found" % self.key)

        return {
            "site": self.key, "id": book_id, "title": title, "author": author,
            "description": description, "source_url": self._book_url(book_id),
            "cover_url": cover,
            "chapters": apply_chapter_range(dedup_chapters(chapters)),
        }

    def _collect_chapters(self, first_markup, first_doc, book_id):
        base_page = self._book_url(book_id)
        page_urls = [base_page]
        for opt in find_all(first_doc, "option"):
            if not has_ancestor_tag(opt, "select"):
                continue
            href = attr(opt, "value").strip()
            if not LIST_PAGE_RE.match(href):
                continue
            page_urls.append(absolutize(BASE, href))
        page_urls = _dedupe_strings(page_urls)

        chapters = []
        seen = set()
        for page_url in page_urls:
            markup = first_markup
            if page_url != base_page:
                markup = self._get(page_url)
            page_doc = parse_html(markup)
            for ul in _catalog_uls(page_doc):
                for a in find_all(ul, "a"):
                    m = CHAPTER_RE.match(normalize_path(attr(a, "href")))
                    if not m:
                        continue
                    chapter_id = m.group(2)
                    if chapter_id in seen:
                        continue
                    seen.add(chapter_id)
                    chapters.append({
                        "id": chapter_id,
                        "title": clean_text(_node_text_raw(a)),
                        "url": self._chapter_url(book_id, chapter_id),
                        "volume": "正文",
                        "order": len(chapters) + 1,
                    })
        return chapters

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        book_id = (book_id or "").strip()
        chapter_id = (chapter.get("id") or "").strip()
        if not book_id or not chapter_id:
            raise ValueError("%s book id and chapter id are required" % self.key)

        paragraphs = []
        page_url = self._chapter_url(book_id, chapter_id)
        seen_pages = set()
        result = dict(chapter)
        for page in range(1, 51):
            try:
                markup = self._get(page_url)
            except Exception:
                if page == 1:
                    raise
                break
            if page_url in seen_pages:
                break
            seen_pages.add(page_url)
            try:
                doc = parse_html(markup)
            except Exception:
                if page == 1:
                    raise
                break
            if not result.get("title"):
                result["title"] = _chapter_title_text(doc)
            paragraphs.extend(_chapter_paragraphs(doc))
            nxt = _next_page_url(doc)
            if not nxt:
                break
            page_url = absolutize(BASE, nxt)

        if not paragraphs:
            raise ValueError("%s chapter content not found" % self.key)
        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            raise ValueError("%s 搜索关键字不能为空" % self.display_name)
        try:
            gbk_keyword = keyword.encode("gbk")
        except Exception as exc:
            raise ValueError("%s 搜索关键字编码失败：%s" % (self.display_name, exc))

        body = "s=%s&type=articlename&submit=" % quote_from_bytes(gbk_keyword)
        headers = {
            "User-Agent": MOBILE_UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": self._search_url(),
            "Origin": BASE,
        }
        cookie = self.cfg.get("cookie") if isinstance(self.cfg, dict) else None
        if cookie and cookie.strip():
            headers["Cookie"] = cookie.strip()
        markup = self.http.post_form(self._search_url(), body, headers=headers)
        return self._parse_search_results(markup, limit)

    def _parse_search_results(self, markup, limit):
        doc = parse_html(markup)
        results = []
        for item in find_all(doc, "p", "line"):
            book_id = ""
            title = ""
            author = ""
            for a in find_all(item, "a"):
                href = normalize_path(attr(a, "href"))
                if not book_id:
                    m = BOOK_RE.match(href)
                    if m:
                        book_id = m.group(1)
                        title = clean_text(_node_text_raw(a))
                        continue
                if not author and href.startswith("/author/"):
                    author = clean_text(_node_text_raw(a))
            if not book_id:
                continue
            results.append({
                "site": self.key, "book_id": book_id, "title": title,
                "author": author, "url": self._book_url(book_id),
            })
            if limit > 0 and len(results) >= limit:
                break
        return results

    # ------------------------------------------------------------------
    def _book_url(self, book_id):
        return BASE + "/book/" + (book_id or "").strip() + "/"

    def _chapter_url(self, book_id, chapter_id):
        return BASE + "/book/" + (book_id or "").strip() + "/" + (chapter_id or "").strip() + ".html"

    def _search_url(self):
        return BASE + "/s.php"

    def _get(self, url):
        headers = {"User-Agent": MOBILE_UA}
        cookie = self.cfg.get("cookie") if isinstance(self.cfg, dict) else None
        if cookie and cookie.strip():
            headers["Cookie"] = cookie.strip()
        return self.http.get(url, headers=headers)


# ---------------------------------------------------------------------------
# 解析辅助
# ---------------------------------------------------------------------------
def _dedupe_strings(items):
    seen = set()
    out = []
    for item in items:
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _catalog_uls(doc):
    uls = []
    for ul in find_all(doc, "ul", "chapter"):
        prev = _previous_element_sibling(ul)
        if (prev is not None and prev.name == "div"
                and "intro" in (prev.get("class") or [])
                and "最新章节预览" in clean_text(_node_text_raw(prev))):
            continue
        uls.append(ul)
    return uls


def _chapter_title_text(doc):
    title = clean_text(_node_text_raw(find_first(doc, "div", "nr_title")))
    m = TITLE_PAGE_RE.match(title)
    if m:
        title = m.group(1).strip()
    return title


def _chapter_paragraphs(doc):
    container = find_by_id(doc, "nr1")
    if container is None:
        return []
    lines = []
    for line in _node_text_lb(container).split("\n"):
        line = line.replace("\u00a0", " ").strip()
        line = " ".join(line.split())
        if not line or _is_ad_line(line):
            continue
        lines.append(line)
    return lines


def _is_ad_line(line):
    lower = line.lower()
    for marker in AD_MARKERS:
        if marker in lower:
            return True
    return ("http://" in lower or "https://" in lower or "www." in lower)


def _next_page_url(doc):
    for a in find_all(doc, "a"):
        if clean_text(_node_text_raw(a)) == "下一页":
            return attr(a, "href")
    return ""