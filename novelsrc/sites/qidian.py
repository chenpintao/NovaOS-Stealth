# -*- coding: utf-8 -*-
"""起点中文网（qidian.com）—— 由 go-novel-dl internal/site/qidian.go 移植。
Loshop & Cpt
"""
import json
import re
from urllib.parse import quote, urlsplit

from ..base import Site, apply_chapter_range, dedup_chapters, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_first,
                        has_ancestor_class, normalize_path, node_text,
                        node_text_lines, parse_html)

BOOK_RE = re.compile(r"^/book/(\d+)/?$")
INFO_RE = re.compile(r"^/info/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/chapter/(\d+)/(\d+)/?$")
CHAPTER_PATH_RE = re.compile(r"/chapter/(\d+)/(\d+)/?")
NUMERIC_RE = re.compile(r"^\d+$")

MOBILE_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
             "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
             "Mobile/15E148 Safari/604.1")

BASE_HEADERS = {
    "Accept": ("text/html,application/xhtml+xml,application/xml;q=0.9,"
               "image/avif,image/webp,*/*;q=0.8"),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Upgrade-Insecure-Requests": "1",
}

_CARD_CLASS_PARTS = ("res-book-item", "book-img-text", "book-mid-info",
                     "list__item")


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _classes(node):
    value = node.get("class") or []
    if isinstance(value, str):
        value = value.split()
    return value


def _has_class(node, cls):
    return cls in _classes(node)


def _has_class_part(node, part):
    part = (part or "").strip().lower()
    if not part:
        return False
    for item in _classes(node):
        if part in item.lower():
            return True
    return False


def _has_class_contains(node, part):
    for item in _classes(node):
        if part in item:
            return True
    return False


def _is_tag(node, name):
    return getattr(node, "name", None) == name


def _all(root, pred):
    if root is None:
        return []
    return [n for n in root.find_all(True) if pred(n)]


def _first(root, pred):
    if root is None:
        return None
    for n in root.find_all(True):
        if pred(n):
            return n
    return None


def _meta_property(doc, prop):
    for node in doc.find_all("meta"):
        if (node.get("property") or "").strip() == prop:
            content = (node.get("content") or "").strip()
            if content:
                return content
    return ""


def _by_class(cls):
    return lambda n: _has_class(n, cls)


def _by_class_part(part):
    return lambda n: _has_class_part(n, part)


def _by_tag(tag):
    return lambda n: _is_tag(n, tag)


def _by_id(elem_id):
    return lambda n: (n.get("id") or "") == elem_id


def _first_text(root, preds):
    for pred in preds:
        node = _first(root, pred)
        text = clean_text(node_text(node))
        if text:
            return text
    return ""


def _paragraph_text(node):
    return "\n".join(node_text_lines(node))


def _has_descendant_class_contains(node, part):
    if node is None:
        return False
    for child in node.find_all(True):
        if _has_class_contains(child, part):
            return True
    return False


# ---------------------------------------------------------------------------
# 站点
# ---------------------------------------------------------------------------
@register
class QidianSite(Site):
    key = "qidian"
    display_name = "起点中文网"
    tags = ["简体中文", "原创", "男性向", "阅文"]
    hosts = ["qidian.com", "book.qidian.com", "m.qidian.com"]
    timeout = 15.0

    def __init__(self, cfg=None):
        Site.__init__(self, cfg)
        self._inject_cookie(self._cfg_cookie())

    def _cfg_cookie(self):
        if isinstance(self.cfg, dict):
            return (self.cfg.get("cookie") or "").strip()
        return ""

    def _inject_cookie(self, raw):
        raw = (raw or "").strip()
        if raw.lower().startswith("cookie:"):
            raw = raw[len("cookie:"):].strip()
        if not raw:
            return
        for part in raw.split(";"):
            part = part.strip()
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            name = name.strip()
            value = value.strip()
            if not name:
                continue
            for host in ("www.qidian.com", "book.qidian.com", "m.qidian.com"):
                try:
                    self.http.session.cookies.set(name, value, domain=host, path="/")
                except Exception:
                    pass

    def _csrf_token(self):
        try:
            jar = self.http.session.cookies
        except Exception:
            return ""
        for domain in (".qidian.com", "www.qidian.com", "book.qidian.com",
                       "m.qidian.com"):
            try:
                for cookie in jar:
                    if cookie.name == "_csrfToken" and cookie.value.strip():
                        return cookie.value
            except Exception:
                continue
        return ""

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        raw = (raw_url or "").strip()
        if not raw:
            return None
        if not raw.startswith("http://") and not raw.startswith("https://"):
            raw = "https://" + raw
        parts = urlsplit(raw)
        host = (parts.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host not in ("qidian.com", "book.qidian.com", "m.qidian.com"):
            return None
        path = parts.path
        if host == "book.qidian.com":
            base = "https://book.qidian.com"
        elif host == "m.qidian.com":
            base = "https://m.qidian.com"
        else:
            base = "https://www.qidian.com"
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "chapter_id": m.group(2), "canonical": base + path}
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": base + path}
        m = INFO_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": base + path}
        return None

    # ------------------------------------------------------------------
    def _fetch_html(self, url, headers=None):
        merged = dict(BASE_HEADERS)
        if headers:
            for key, value in headers.items():
                if (value or "").strip():
                    merged[key] = value.strip()
        return self.http.get(url, headers=merged)

    @staticmethod
    def _mobile_headers(referer):
        return {"User-Agent": MOBILE_UA, "Referer": referer}

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("qidian book id is required")

        source_url = "https://m.qidian.com/book/%s/" % book_id
        doc = None
        chapters = []
        content, source_url, detail_err = self._fetch_book_page(book_id)
        if detail_err is None:
            doc = parse_html(content)
            chapters = self._parse_static_catalog(doc, book_id)
        else:
            source_url = "https://m.qidian.com/book/%s/" % book_id

        if doc is None:
            book = {"site": self.key, "id": book_id,
                    "title": "qidian-" + book_id, "author": "",
                    "description": "", "source_url": source_url,
                    "cover_url": ""}
        else:
            book = self._book_from_document(doc, book_id, source_url)

        try:
            from_mobile = self._fetch_mobile_catalog(book_id)
        except Exception:
            from_mobile = []
        if len(from_mobile) > len(chapters):
            chapters = from_mobile

        try:
            from_api = self._fetch_ajax_catalog(book_id, source_url)
        except Exception:
            from_api = []
        if len(from_api) > len(chapters):
            chapters = from_api

        if not chapters:
            if detail_err is not None:
                raise ValueError("qidian book %s chapter catalog not available: "
                                 "detail page: %s" % (book_id, detail_err))
            raise ValueError("qidian chapter catalog not found")

        book["chapters"] = apply_chapter_range(dedup_chapters(chapters))
        return book

    def _fetch_book_page(self, book_id):
        targets = [
            ("https://m.qidian.com/book/%s/" % book_id,
             self._mobile_headers("https://m.qidian.com/")),
            ("https://www.qidian.com/book/%s/" % book_id,
             {"Referer": "https://www.qidian.com/"}),
            ("https://book.qidian.com/info/%s/" % book_id,
             {"Referer": "https://www.qidian.com/"}),
        ]
        last_err = None
        probe_err = None
        for url, headers in targets:
            try:
                markup = self._fetch_html(url, headers)
            except Exception as exc:
                last_err = exc
                continue
            if self._is_probe_page(markup):
                probe_err = ValueError("qidian anti-bot probe page for %s" % url)
                last_err = probe_err
                continue
            return markup, url, None
        if probe_err is not None and last_err is probe_err:
            return "", "", last_err
        return "", "", last_err

    def _book_from_document(self, doc, book_id, source_url):
        title = _meta_property(doc, "og:novel:book_name")
        if not title:
            title = _first_text(doc, [
                _by_id("bookName"), _by_class("book-name"),
                _by_class_part("bookName"), _by_class("book-title"),
                _by_class_part("book-title"), _by_class("title"),
            ])
        author = _meta_property(doc, "og:novel:author") or self._author(doc)
        description = _meta_property(doc, "og:description")
        if not description:
            description = _first_text(doc, [
                _by_id("book-intro-detail"), _by_class("book-intro"),
                _by_class_part("bookDesc"), _by_class("intro"),
            ])
        cover = _meta_property(doc, "og:image")
        if not cover:
            img = _first(doc, lambda n: _is_tag(n, "img") and (
                has_ancestor_class(n, "book-img") or _has_class_part(n, "bookCover")))
            cover = attr(img, "src")
        cover = absolutize(source_url, cover) if cover else ""
        if not title:
            title = "qidian-" + book_id
        return {"site": self.key, "id": book_id, "title": title,
                "author": author, "description": description,
                "source_url": source_url, "cover_url": cover}

    def _author(self, doc):
        for pred in (
            lambda n: _is_tag(n, "a") and (n.get("id") or "") == "authorId",
            lambda n: _is_tag(n, "a") and has_ancestor_class(n, "writer"),
            _by_class("author"),
        ):
            text = clean_text(node_text(_first(doc, pred)))
            if text:
                if text.startswith("作者："):
                    text = text[len("作者："):].strip()
                if text.endswith("著"):
                    text = text[:-len("著")].strip()
                return text
        return ""

    # ------------------------------------------------------------------
    def _parse_static_catalog(self, doc, book_id):
        chapters = []
        for volume in _all(doc, lambda n: _is_tag(n, "div") and _has_class(n, "catalog-volume")):
            vname = _first_text(volume, [_by_class("volume-name")]) or "正文"
            header = _first(volume, _by_class("volume-header"))
            vvip = "VIP" in node_text(header).upper()
            for li in _all(volume, lambda n: _is_tag(n, "li") and has_ancestor_class(n, "volume-chapters")):
                chapter = self._chapter_from_link(
                    _first(li, lambda n: _is_tag(n, "a") and self._chapter_id_from_url(attr(n, "href"))),
                    book_id, vname, len(chapters) + 1)
                if not chapter:
                    continue
                if vvip and not self._include_locked():
                    continue
                if _first(li, lambda n: _is_tag(n, "div") and _has_class_contains(n, "lock")) and not self._include_locked():
                    continue
                chapters.append(chapter)
        for volume in _all(doc, lambda n: _is_tag(n, "div") and _has_class(n, "volume")
                           and _has_ancestor_id(n, "j-catalogWrap")):
            vname = _first_text(volume, [_by_tag("h3")]) or "正文"
            vvip = "VIP" in vname.upper()
            for li in _all(volume, lambda n: _is_tag(n, "li") and has_ancestor_class(n, "cf")):
                chapter = self._chapter_from_link(
                    _first(li, lambda n: _is_tag(n, "a") and self._chapter_id_from_url(attr(n, "href"))),
                    book_id, vname, len(chapters) + 1)
                if not chapter:
                    continue
                if vvip and not self._include_locked():
                    continue
                if _first(li, lambda n: _is_tag(n, "div") and _has_class_contains(n, "lock")) and not self._include_locked():
                    continue
                chapters.append(chapter)
        return chapters

    @staticmethod
    def _include_locked():
        return False

    def _chapter_from_link(self, a, book_id, volume, order):
        if a is None:
            return None
        chapter_id = self._chapter_id_from_url(attr(a, "href"))
        if not chapter_id:
            return None
        return {"id": chapter_id, "title": clean_text(node_text(a)),
                "url": self._mobile_chapter_url(book_id, chapter_id),
                "volume": volume, "order": order}

    def _fetch_mobile_catalog(self, book_id):
        url = "https://m.qidian.com/book/%s/catalog/" % book_id
        markup = self._fetch_html(
            url, self._mobile_headers("https://m.qidian.com/book/%s/" % book_id))
        if self._is_probe_page(markup):
            raise ValueError("qidian anti-bot probe page for %s" % url)
        doc = parse_html(markup)
        chapters = self._parse_mobile_catalog(doc, book_id)
        if not chapters:
            raise ValueError("qidian mobile chapter catalog not found")
        return chapters

    def _parse_mobile_catalog(self, doc, book_id):
        chapters = []
        volume = "正文"

        def match(n):
            if _is_tag(n, "div") and _has_class_part(n, "chapterBar"):
                return True
            return (_is_tag(n, "a") and _has_class_part(n, "chapterItem")
                    and bool(self._chapter_id_from_url(attr(n, "href"))))

        for node in _all(doc, match):
            if _is_tag(node, "div"):
                text = clean_text(node_text(node))
                if text:
                    volume = text
                continue
            text = clean_text(node_text(node))
            locked = _has_class_part(node, "unPay") or "订阅" in text or "VIP" in text
            if locked:
                continue
            chapter_id = self._chapter_id_from_url(attr(node, "href"))
            title = _first_text(node, [_by_tag("h2"), _by_tag("h3")])
            if not title:
                title = attr(node, "title")
                if title.endswith("在线阅读"):
                    title = title[:-len("在线阅读")].strip()
            if not title:
                title = text
                if title.endswith("免费"):
                    title = title[:-len("免费")]
                if title.endswith("订阅"):
                    title = title[:-len("订阅")]
                title = title.strip()
            if not chapter_id or not title:
                continue
            chapters.append({
                "id": chapter_id, "title": title,
                "url": absolutize("https://m.qidian.com", attr(node, "href")),
                "volume": volume, "order": len(chapters) + 1})
        return chapters

    def _fetch_ajax_catalog(self, book_id, referer):
        endpoint = ("https://book.qidian.com/ajax/book/category?bookId="
                    + quote(book_id))
        token = self._csrf_token()
        if token:
            endpoint += "&_csrfToken=" + quote(token)
        headers = {
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/136.0.0.0 Safari/537.36"),
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "X-Requested-With": "XMLHttpRequest",
        }
        if referer:
            headers["Referer"] = referer
        text = self.http.get(endpoint, headers=headers)
        payload = json.loads(text)
        code = _int_value(payload.get("code"))
        if code != 0:
            message = _str_value(payload.get("msg")) or ("code %d" % code)
            raise ValueError("qidian catalog api failed: %s" % message)
        chapters = self._parse_catalog_payload(payload, book_id)
        if not chapters:
            raise ValueError("qidian ajax chapter catalog not found")
        return chapters

    def _parse_catalog_payload(self, payload, book_id):
        data = payload.get("data")
        if not isinstance(data, dict):
            return []
        chapters = []
        volumes = data.get("vs")
        if not isinstance(volumes, list):
            return []
        for idx, raw_volume in enumerate(volumes):
            if not isinstance(raw_volume, dict):
                continue
            volume_name = _str_value(raw_volume.get("vN")) or ("卷 %d" % (idx + 1))
            volume_vip = "VIP" in volume_name.upper() or _bool_value(raw_volume.get("isVip"))
            for raw_chapter in (raw_volume.get("cs") or []):
                if not isinstance(raw_chapter, dict):
                    continue
                chapter_id = self._catalog_chapter_id(raw_chapter)
                if not chapter_id:
                    continue
                locked = (volume_vip or _bool_value(raw_chapter.get("isVip"))
                          or _bool_value(raw_chapter.get("needSubscribe")))
                if locked:
                    continue
                chapters.append({
                    "id": chapter_id, "title": _str_value(raw_chapter.get("cN")),
                    "url": self._mobile_chapter_url(book_id, chapter_id),
                    "volume": volume_name, "order": len(chapters) + 1})
        return chapters

    def _catalog_chapter_id(self, item):
        for key in ("id", "chapterId", "cId", "uuid"):
            value = _str_value(item.get(key))
            if value:
                return value
        return self._chapter_id_from_url(_str_value(item.get("cU")))

    @staticmethod
    def _mobile_chapter_url(book_id, chapter_id):
        return "https://m.qidian.com/chapter/%s/%s/" % (
            (book_id or "").strip(), (chapter_id or "").strip())

    def _chapter_id_from_url(self, raw):
        raw = (raw or "").strip()
        if not raw:
            return ""
        if raw.startswith("//"):
            raw = "https:" + raw
        if raw.startswith("http://") or raw.startswith("https://"):
            raw = normalize_path(raw)
        m = CHAPTER_PATH_RE.search(raw)
        if m:
            return m.group(2)
        parts = [p for p in raw.strip("/").split("/") if p]
        if parts and NUMERIC_RE.match(parts[-1]):
            return parts[-1]
        return ""

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        book_id = (book_id or "").strip()
        chapter = dict(chapter or {})
        chapter_id = (chapter.get("id") or "").strip()
        chapter_url = (chapter.get("url") or "").strip()
        if not chapter_url:
            chapter_url = self._mobile_chapter_url(book_id, chapter_id)
        headers = {"Referer": "https://www.qidian.com/book/%s/" % book_id}
        if "m.qidian.com" in chapter_url.lower():
            headers = self._mobile_headers("https://m.qidian.com/book/%s/" % book_id)
        markup = self._fetch_html(chapter_url, headers)
        if (self._is_probe_page(markup) and "m.qidian.com" not in chapter_url.lower()
                and chapter_id):
            chapter_url = self._mobile_chapter_url(book_id, chapter_id)
            markup = self._fetch_html(
                chapter_url, self._mobile_headers("https://m.qidian.com/book/%s/" % book_id))
            chapter["url"] = chapter_url
        if self._is_locked_chapter(markup):
            raise ValueError("qidian chapter %s requires login/subscription or "
                             "browser rendering" % chapter_id)
        doc = parse_html(markup)
        title = clean_text(node_text(_first(doc, lambda n: (
            _is_tag(n, "h1") or _is_tag(n, "h2")) and (
            _has_class(n, "title") or _has_class(n, "chapter-title")
            or has_ancestor_class(n, "chapter-control")))))
        if title:
            chapter["title"] = title
        container = self._chapter_container(doc)
        paragraphs = self._chapter_paragraphs(container)
        if not paragraphs:
            raise ValueError("qidian chapter content not found")
        chapter["content"] = "\n".join(paragraphs)
        chapter["downloaded"] = True
        return chapter

    def _chapter_container(self, doc):
        for pred in (
            _by_tag("main"), _by_class("content-text"),
            _by_class("read-content"), _by_class("chapter-content"),
        ):
            node = _first(doc, pred)
            if node is not None:
                return node
        return doc

    def _chapter_paragraphs(self, container):
        paragraphs = []
        pred = lambda n: (_is_tag(n, "p") and not _has_class_contains(n, "review")
                          and not _has_descendant_class_contains(n, "review")
                          and not has_ancestor_class(n, "review")
                          and not has_ancestor_class(n, "author-say"))
        for p in _all(container, pred):
            text = _paragraph_text(p)
            if not text or self._is_ad_line(text):
                continue
            paragraphs.append(text)
        if paragraphs:
            return [clean_text(p) for p in paragraphs if clean_text(p)]
        out = []
        for line in node_text_lines(container):
            if not self._is_ad_line(line):
                out.append(line)
        return out

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        targets = [
            ("https://m.qidian.com/search?kw=" + quote(keyword),
             self._mobile_headers("https://m.qidian.com/")),
            ("https://www.qidian.com/so/" + quote(keyword, safe="") + ".html",
             {"Referer": "https://www.qidian.com/"}),
            ("https://www.qidian.com/search?kw=" + quote(keyword),
             {"Referer": "https://www.qidian.com/"}),
        ]
        last_err = None
        for url, headers in targets:
            try:
                markup = self._fetch_html(url, headers)
                results = self._parse_search(markup)
            except Exception as exc:
                last_err = exc
                continue
            if not results:
                continue
            if limit > 0 and len(results) > limit:
                results = results[:limit]
            return results
        if last_err is not None:
            raise last_err
        return []

    def _parse_search(self, markup):
        doc = parse_html(markup)
        results = []
        seen = set()
        for a in doc.find_all("a"):
            book_id = self._search_book_id(attr(a, "href"))
            if not book_id or book_id in seen:
                continue
            seen.add(book_id)
            card = self._search_card(a) or a
            title = _first_text(card, [
                _by_class_part("searchBookName"), _by_class_part("bookName"),
                _by_class_part("book-title"),
                lambda n: _is_tag(n, "h2") and _has_class(n, "book-title"),
                _by_tag("h2"), _by_tag("h3"),
            ])
            if not title:
                title = clean_text(node_text(a))
            result = {
                "site": self.key, "book_id": book_id, "title": title,
                "author": self._search_author(card, a),
                "description": self._search_description(card),
                "url": "https://www.qidian.com/book/%s/" % book_id,
                "latest_chapter": clean_text(node_text(_first(card, lambda n: (
                    _is_tag(n, "a") and (has_ancestor_class(n, "update")
                                         or has_ancestor_class(n, "update-info")))))),
                "cover_url": "",
            }
            img = _first(card, _by_tag("img"))
            cover = attr(img, "data-src") or attr(img, "src")
            if cover:
                result["cover_url"] = absolutize("https://www.qidian.com", cover)
            if result["title"]:
                results.append(result)
        return results

    def _search_card(self, a):
        current = a.parent
        while current is not None:
            name = getattr(current, "name", None)
            if name == "li":
                return current
            if name == "div":
                for part in _CARD_CLASS_PARTS:
                    if _has_class_part(current, part):
                        return current
            current = getattr(current, "parent", None)
        return None

    def _search_book_id(self, raw):
        raw = (raw or "").strip()
        if not raw:
            return ""
        if raw.startswith("//"):
            raw = "https:" + raw
        if raw.startswith("http://") or raw.startswith("https://"):
            raw = normalize_path(raw)
        m = BOOK_RE.match(raw)
        if m:
            return m.group(1)
        m = INFO_RE.match(raw)
        if m:
            return m.group(1)
        m = CHAPTER_PATH_RE.search(raw)
        if m and m.group(2) == "0":
            return m.group(1)
        return ""

    def _search_author(self, card, title_link):
        for a in card.find_all("a"):
            if a is title_link:
                continue
            href = (attr(a, "href") or "").lower()
            if ("/author/" in href or _has_class(a, "name")
                    or _has_class_part(a, "author")
                    or has_ancestor_class(a, "author")):
                text = clean_text(node_text(a))
                if text:
                    if text.startswith("作者："):
                        text = text[len("作者："):].strip()
                    return text
        text = clean_text(node_text(_first(card, lambda n: (
            _has_class(n, "author") or _has_class_part(n, "author")))))
        if text.startswith("作者："):
            text = text[len("作者："):].strip()
        return text

    def _search_description(self, card):
        return _first_text(card, [
            _by_class_part("searchBookDesc"), _by_class_part("bookDesc"),
            _by_class("intro"), _by_class("desc"), _by_class("book-intro"),
            lambda n: _is_tag(n, "p") and _has_class(n, "intro"),
        ])

    # ------------------------------------------------------------------
    @staticmethod
    def _is_locked_chapter(markup):
        for marker in ("vip-limit-wrap", "需要订阅", "订阅本章", "请登录后",
                       "登录后阅读", "本章为VIP章节"):
            if marker in markup:
                return True
        return False

    @staticmethod
    def _is_probe_page(markup):
        return ("/C2WF946J0/probe.js" in markup
                or 'var buid = "ffffffff' in markup)

    @staticmethod
    def _is_ad_line(text):
        for marker in ("起点中文网", "www.qidian.com", "手机用户请到",
                       "推荐票", "月票"):
            if marker in text:
                return True
        return False


def _has_ancestor_id(node, elem_id):
    parent = node.parent if node is not None else None
    while parent is not None:
        if (parent.get("id") or "") == elem_id:
            return True
        parent = parent.parent
    return False


def _str_value(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def _int_value(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return 0


def _bool_value(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value in ("true", "1")
    if isinstance(value, (int, float)):
        return value != 0
    return False