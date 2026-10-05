# -*- coding: utf-8 -*-
"""布谷小说网（buguxs.com）—— 由 go-novel-dl internal/site/buguxs.go +
buguxs_decrypt.go 移植。var c 的 php_decrypt_js 解密用纯 Python 复刻。
Loshop & Cpt
"""
import base64
import re
from urllib.parse import urlencode, urlsplit, urlunsplit

from bs4 import Comment, NavigableString

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, find_by_id, has_ancestor_class,
                        node_text, parse_html)


def _bs_kwargs(class_, attrs):
    kw = {}
    if class_ is not None:
        kw["class_"] = class_
    if attrs is not None:
        kw["attrs"] = attrs
    return kw


def find_all(node, name=None, class_=None, attrs=None):
    """覆盖 htmlutil.find_all：bs4 4.15 会把 class_=None 当成过滤器。"""
    if node is None:
        return []
    return node.find_all(name, **_bs_kwargs(class_, attrs))


def find_first(node, name=None, class_=None, attrs=None):
    if node is None:
        return None
    return node.find(name, **_bs_kwargs(class_, attrs))

BOOK_RE = re.compile(r"^/book/(\d+)/(\d+)(?:/(\d+))?/$")
CHAPTER_RE = re.compile(r"^/book/(\d+)/(\d+)/(\d+)(?:_(\d+))?\.html$")
ONCLICK_RE = re.compile(r"location\.href='([^']+)'")
PAGE_PATH_RE = re.compile(r"^/book/(\d+)/(\d+)/(\d+)/$")
VAR_C_RE = re.compile(r'var c="([^"]+)"')

BASE = "https://www.buguxs.com"
MOBILE_UA = ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")

_SKIP_MARKERS = (
    "章节内容加载失败", "更多内容加载中", "关闭浏览器的阅读模式", "先注册个会员",
    "此章节正在努力更新", "最新章节遇到防盗章节", "手机访问的帅哥美女读者",
)


def _parse_url(raw):
    raw = (raw or "").strip()
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "https://" + raw
    return urlsplit(raw)


def _norm_path(raw):
    """对齐 Go normalizeESJPath。"""
    raw = (raw or "").strip()
    if not raw:
        return ""
    parsed = _parse_url(raw)
    if parsed.netloc:
        return parsed.path
    return raw


def _compact(value):
    return " ".join((value or "").split())


def _clean_text_multi(value):
    """对齐 Go cleanText：按行折叠空白但保留换行。"""
    if not value:
        return ""
    value = value.replace("\xa0", " ").replace("\r", "")
    lines = []
    for line in value.split("\n"):
        line = " ".join(line.split())
        if line:
            lines.append(line)
    return "\n".join(lines)


def _text_with_breaks(node):
    """对齐 Go nodeTextPreserveLineBreaks：拼接文本节点，<br> 记作换行。"""
    if node is None:
        return ""
    parts = []

    def walk(n):
        if isinstance(n, Comment):
            return
        if isinstance(n, NavigableString):
            parts.append(str(n))
            return
        if getattr(n, "name", None) == "br":
            parts.append("\n")
            return
        for child in getattr(n, "children", []):
            walk(child)

    walk(node)
    return "".join(parts)


def _has_class(node, class_name):
    return class_name in (node.get("class") or [])


def _first_tag_class(node, name, class_name):
    for item in find_all(node, name):
        if _has_class(item, class_name):
            return item
    return None


def _is_clearance(markup):
    markup = markup or ""
    return "__sc_clearance" in markup and "正在检查您的浏览器" in markup


def _skip_paragraph(text):
    text = (text or "").strip()
    if not text:
        return True
    lower = text.lower()
    if lower.startswith("布谷小说网") and "第一时间更新" in lower:
        return True
    for marker in _SKIP_MARKERS:
        if marker in lower:
            return True
    return False


def _clean_chapter_title(title):
    title = (title or "").lstrip("\ufeff").strip()
    idx = title.find("(第")
    if idx > 0 and "页)" in title[idx:]:
        title = title[:idx].strip()
    return title


@register
class BuguxsSite(Site):
    key = "buguxs"
    display_name = "布谷小说网"
    tags = ["简体中文", "转载站"]
    hosts = ["buguxs.com"]

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        parsed = _parse_url(raw_url)
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host != "buguxs.com":
            return None
        path = parsed.path
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1) + "/" + m.group(2),
                    "chapter_id": m.group(3), "canonical": "https://www.buguxs.com" + path}
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1) + "/" + m.group(2),
                    "canonical": "https://www.buguxs.com" + path}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        cat, bid = _split_book_id(book_id)
        catalog_url = BASE + "/book/%s/%s/" % (cat, bid)
        markup = self._get_mobile(catalog_url)
        doc = parse_html(markup)

        title = _meta_property(doc, "og:novel:book_name")
        if not title:
            title = _meta_property(doc, "og:title")
        author = _meta_property(doc, "og:novel:author")
        if not author:
            author = _compact(node_text(_first_tag_class(doc, "p", "author")))
        description = _meta_property(doc, "og:description")
        if not description:
            description = _clean_text_multi(_text_with_breaks(find_by_id(doc, "bookIntro")))

        chapters = self._collect_chapters(cat, bid, catalog_url)
        if not chapters:
            raise ValueError("buguxs chapter list not found")
        return {
            "site": self.key, "id": (book_id or "").strip(), "title": title.strip(),
            "author": author.strip(), "description": description.strip(),
            "source_url": catalog_url, "cover_url": _meta_property(doc, "og:image").strip(),
            "chapters": apply_chapter_range(chapters),
        }

    def _collect_chapters(self, cat, bid, first_url):
        chapter_map = {}
        order = []

        def add_chapters(doc):
            for a in find_all(doc, "a"):
                href = _norm_path(_anchor_url(a))
                m = CHAPTER_RE.match(href)
                if not m or m.group(1) != cat or m.group(2) != bid:
                    continue
                title = _compact(node_text(a))
                if title == "" or title == "下一章" or title == "上一章":
                    continue
                cid = m.group(3)
                if cid in chapter_map:
                    continue
                chapter_map[cid] = {
                    "id": cid, "title": title,
                    "url": absolutize(BASE, href), "volume": "正文",
                    "order": len(order) + 1,
                }
                order.append(cid)

        def collect_pages(doc):
            pages = []
            seen = set()

            def add_page_url(raw):
                href = _norm_path(raw)
                m = PAGE_PATH_RE.match(href)
                if not m or m.group(1) != cat or m.group(2) != bid:
                    return
                page_url = BASE + "/book/%s/%s/%s/" % (cat, bid, m.group(3))
                if page_url not in seen:
                    seen.add(page_url)
                    pages.append(page_url)

            for a in find_all(doc, "a"):
                add_page_url(_anchor_url(a))
                add_page_url(attr(a, "href"))
            for option in find_all(doc, "option"):
                add_page_url(attr(option, "value"))
            return pages

        first_doc = self._catalog_doc(first_url)
        add_chapters(first_doc)
        visited = {first_url: True}
        queue = collect_pages(first_doc)
        while queue:
            page_url = queue.pop(0)
            if page_url in visited:
                continue
            visited[page_url] = True
            try:
                doc = self._catalog_doc(page_url)
            except Exception:
                continue
            add_chapters(doc)
            queue.extend(collect_pages(doc))

        chapters = [chapter_map[cid] for cid in order]
        chapters.sort(key=lambda ch: _int_or_zero(ch["id"]))
        return chapters

    def _catalog_doc(self, url):
        return parse_html(self._get_mobile(url))

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        cat, bid = _split_book_id(book_id)
        chapter_id = (chapter.get("id") or "").strip()
        if not chapter_id:
            raise ValueError("buguxs chapter id is required")

        result = dict(chapter)
        paragraphs = []
        current_url = _chapter_page_url(cat, bid, chapter_id, 1)
        visited = set()
        page = 1
        while True:
            if current_url in visited:
                break
            visited.add(current_url)
            try:
                markup = self._get_mobile(current_url)
            except Exception:
                if page == 1:
                    raise
                break
            doc = parse_html(markup)
            if page == 1:
                h1 = _compact(node_text(find_first(doc, "h1")))
                if h1 and "布谷" not in h1:
                    result["title"] = _clean_chapter_title(h1)
                if not result.get("title"):
                    h = _compact(node_text(find_by_id(doc, "bookname")))
                    if h:
                        result["title"] = _clean_chapter_title(h)

            paragraphs.extend(_parse_content(doc))

            enc = _extract_var_c(markup)
            if enc:
                decrypted = _decrypt_var_c(enc)
                if decrypted:
                    paragraphs.extend(_parse_decrypted(decrypted))

            next_url = _next_chapter_page_url(markup, doc, current_url, cat, bid,
                                              chapter_id, page)
            if not next_url:
                break
            current_url = next_url
            page += 1

        if not paragraphs:
            raise ValueError("buguxs chapter content not found")
        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        if limit <= 0:
            limit = 30
        search_url = BASE + "/search/?" + urlencode({"searchkey": keyword})
        markup = self._get_mobile(search_url)
        return _parse_search(markup, limit)

    # ------------------------------------------------------------------
    def _get_mobile(self, url, referer=None):
        headers = {"User-Agent": MOBILE_UA}
        if referer:
            headers["Referer"] = referer
        markup = self.http.get(url, headers=headers)
        if _is_clearance(markup):
            try:
                self.http.session.cookies.set("__sc_clearance", "1")
            except Exception:
                pass
            markup = self.http.get(url, headers=headers)
        return markup


# ---------------------------------------------------------------------------
# 变量与解析辅助
# ---------------------------------------------------------------------------
def _split_book_id(book_id):
    parts = (book_id or "").strip().split("/", 1)
    if len(parts) != 2:
        return "0", (book_id or "").strip()
    return parts[0], parts[1]


def _int_or_zero(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _meta_property(doc, prop):
    for node in find_all(doc, "meta"):
        if attr(node, "property") == prop:
            content = attr(node, "content").strip()
            if content:
                return content
    return ""


def _anchor_url(a):
    href = attr(a, "href").strip()
    if not href.lower().startswith("javascript:"):
        return href
    m = ONCLICK_RE.search(attr(a, "onclick"))
    return m.group(1) if m else ""


def _chapter_page_url(cat, bid, chapter_id, page):
    base = BASE + "/book/%s/%s/%s.html" % (cat, bid, chapter_id)
    if page <= 1:
        return base
    return BASE + "/book/%s/%s/%s_%d.html" % (cat, bid, chapter_id, page)


def _next_chapter_page_url(markup, doc, current_url, cat, bid, chapter_id, current_page):
    next_node = find_by_id(doc, "next_url")
    if next_node is None:
        return ""
    next_raw = attr(next_node, "onclick")
    m = ONCLICK_RE.search(next_raw)
    if not m:
        return ""
    next_raw = m.group(1)
    resolved = absolutize(current_url, next_raw)
    parsed = _parse_url(resolved)
    m = CHAPTER_RE.match(parsed.path)
    if not m or m.group(1) != cat or m.group(2) != bid or m.group(3) != chapter_id:
        return ""
    page = 1
    if m.group(4):
        try:
            page = int(m.group(4))
        except ValueError:
            page = 1
    if page != current_page + 1:
        return ""
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _parse_content(doc):
    container = find_by_id(doc, "chaptercontent")
    if container is None:
        return []
    paragraphs = []
    for child in container.children:
        if isinstance(child, Comment):
            continue
        if isinstance(child, NavigableString):
            text = _clean_text_multi(str(child))
            if text:
                paragraphs.append(text)
            continue
        name = getattr(child, "name", None)
        if name == "p":
            text = _clean_text_multi(_text_with_breaks(child))
            if text.startswith("\ufeff"):
                text = text[1:]
            if _skip_paragraph(text):
                continue
            paragraphs.append(text)
        elif name == "div":
            if attr(child, "id") == "morecontent":
                continue
            text = _clean_text_multi(_text_with_breaks(child))
            if text and not _skip_paragraph(text):
                paragraphs.append(text)
    return paragraphs


def _parse_decrypted(decrypted):
    doc = parse_html(decrypted)
    paragraphs = []
    for p in find_all(doc, "p"):
        text = _clean_text_multi(_text_with_breaks(p))
        if text.startswith("\ufeff"):
            text = text[1:]
        if not _skip_paragraph(text):
            paragraphs.append(text)
    if paragraphs:
        return paragraphs
    out = []
    for line in (decrypted or "").split("\n"):
        line = line.strip()
        if line and not _skip_paragraph(line):
            out.append(line)
    return out


def _extract_var_c(markup):
    m = VAR_C_RE.search(markup or "")
    return m.group(1) if m else ""


def _b64_pad(value):
    return value + "=" * (-len(value) % 4)


def _decrypt_var_c(value):
    """复刻 resources/buguxs_get.js 的 php_decrypt_js。

    1) base64 解码；2) 取第 8..11 位字符作 key(100..999)；
    3) 截取 substring(11+key, len-key)；4) 去掉 '-'、把 '_' 换回 '/'
    5) base64 解码后按 UTF-8 还原。
    """
    value = (value or "").strip()
    if not value:
        return ""
    try:
        raw = base64.b64decode(_b64_pad(value))
    except Exception:
        return ""
    binary = raw.decode("latin-1")
    if len(binary) < 11:
        return ""
    try:
        key = int(binary[8:11])
    except ValueError:
        return ""
    if key < 100 or key > 999:
        return ""
    start = 11 + key
    end = len(binary) - key
    if end <= start:
        return ""
    mid = binary[start:end].replace("-", "").replace("_", "/")
    try:
        data = base64.b64decode(_b64_pad(mid))
    except Exception:
        return ""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", "replace")


def _parse_search(markup, limit):
    doc = parse_html(markup)
    results = []
    for box in find_all(doc, "div"):
        if not _has_class(box, "book-coverlist"):
            continue
        title_link = None
        for a in find_all(box, "a"):
            if has_ancestor_class(a, "name"):
                title_link = a
                break
        if title_link is None:
            for a in find_all(box, "a"):
                if _has_class(a, "cover"):
                    title_link = a
                    break
        m = BOOK_RE.match(_norm_path(attr(title_link, "href")))
        if not m:
            continue
        title = _compact(node_text(title_link))
        if not title:
            continue

        img = find_first(box, "img")
        cover = attr(img, "data-src").strip() or attr(img, "src").strip()
        results.append({
            "site": "buguxs", "book_id": m.group(1) + "/" + m.group(2),
            "title": title,
            "author": _compact(node_text(_first_tag_class(box, "div", "author"))),
            "description": _clean_text_multi(_text_with_breaks(
                _first_tag_class(box, "div", "intro"))),
            "url": BASE + "/book/%s/%s/" % (m.group(1), m.group(2)),
            "cover_url": absolutize(BASE, cover),
        })
        if limit > 0 and len(results) >= limit:
            break
    return results