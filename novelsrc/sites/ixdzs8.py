# -*- coding: utf-8 -*-
"""爱下电子书（ixdzs8.com）—— 由 go-novel-dl internal/site/ixdzs8.go 移植。
Loshop & Cpt
"""
import json
import re
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup

from ..base import Site, apply_chapter_range, dedup_chapters, register
from ..htmlutil import (attr, clean_text, has_ancestor_class, has_ancestor_tag,
                        node_text, node_text_lines)


def _parse(markup):
    """ixdzs8 页面存在畸形嵌套，lxml 会丢弃列表，改用容错的 html.parser。"""
    if not markup:
        return BeautifulSoup("", "html.parser")
    return BeautifulSoup(markup, "html.parser")


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

BOOK_RE = re.compile(r"^/read/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/read/(\d+)/(p\d+)\.html$")
TOKEN_RE = re.compile(r"(?i)(?:let|var|const)\s+token\s*=\s*[\"']([^\"']+)[\"']")

BASE = "https://ixdzs8.com"
CATALOG_URL = BASE + "/novel/clist/"

_CHALLENGE_MARKERS = ("challenge=", "正在进行安全验证", "正在進行安全驗證",
                      "请稍等", "請稍等")


def _parse_url(raw):
    """对齐 Go normalizeURL：无 scheme 时补 https://。"""
    raw = (raw or "").strip()
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "https://" + raw
    return urlsplit(raw)


def _compact(value):
    return " ".join((value or "").split())


def _meta_property(doc, prop):
    for node in find_all(doc, "meta"):
        if attr(node, "property") == prop:
            content = attr(node, "content").strip()
            if content:
                return content
    return ""


def _clean_summary(value):
    if not value:
        return ""
    value = value.replace("&nbsp;", "").replace("\xa0", "")
    value = value.replace("<br />", "\n").replace("<br/>", "\n").replace("<br>", "\n")
    return "\n".join(_compact(line) for line in value.split("\n")).strip()


def _is_ad(text):
    text = text.strip()
    return text == "" or "ixdzs" in text


def _is_challenge(markup):
    markup = markup or ""
    if not TOKEN_RE.search(markup):
        return False
    for marker in _CHALLENGE_MARKERS:
        if marker in markup:
            return True
    return False


def _search_book_id(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.startswith("//"):
        raw = "https:" + raw
    if raw.startswith("http://") or raw.startswith("https://"):
        raw = urlsplit(raw).path
    m = BOOK_RE.match(raw)
    return m.group(1) if m else ""


def _first_tag_class(node, name, class_name):
    for item in find_all(node, name):
        if class_name in (item.get("class") or []):
            return item
    return None


def _first_ancestor_class(node, name, class_name):
    for item in find_all(node, name):
        if has_ancestor_class(item, class_name):
            return item
    return None


@register
class Ixdzs8Site(Site):
    key = "ixdzs8"
    display_name = "爱下电子书"
    tags = ["简体中文", "转载站"]
    hosts = ["ixdzs8.com"]

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        parsed = _parse_url(raw_url)
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host != "ixdzs8.com":
            return None
        path = parsed.path
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "chapter_id": m.group(2),
                    "canonical": BASE + path}
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "canonical": BASE + path}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        info_markup = self._fetch_verified(self._book_info_url(book_id))
        catalog = self._post_catalog(book_id)
        doc = _parse(info_markup)

        title = _meta_property(doc, "og:novel:book_name").strip()
        if not title:
            for h1 in find_all(doc, "h1"):
                if has_ancestor_class(h1, "n-text"):
                    title = _compact(node_text(h1))
                    break
        author = _meta_property(doc, "og:novel:author").strip()
        if not author:
            for a in find_all(doc, "a"):
                if "bauthor" in (a.get("class") or []):
                    author = _compact(node_text(a))
                    break
        description = _clean_summary(_meta_property(doc, "og:description"))
        cover = _meta_property(doc, "og:image").strip()
        if not cover:
            for img in find_all(doc, "img"):
                if has_ancestor_class(img, "n-img"):
                    cover = attr(img, "src").strip()
                    break

        chapters = []
        try:
            payload = json.loads(catalog)
        except ValueError:
            payload = {}
        for item in (payload.get("data") or []):
            if not isinstance(item, dict):
                continue
            order_value = item.get("ordernum")
            if order_value is None:
                continue
            order_text = str(order_value).strip()
            if not order_text or order_text == "<nil>":
                continue
            cid = "p" + order_text
            chapters.append({
                "id": cid, "title": _compact(str(item.get("title") or "")),
                "url": self._chapter_url(book_id, cid), "order": len(chapters) + 1,
            })
        if not chapters:
            raise ValueError("ixdzs8 chapter list not found")

        return {
            "site": self.key, "id": book_id, "title": title, "author": author,
            "description": description, "source_url": self._book_info_url(book_id),
            "cover_url": cover,
            "chapters": apply_chapter_range(dedup_chapters(chapters)),
        }

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        book_id = (book_id or "").strip()
        chapter_id = (chapter.get("id") or "").strip()
        if not book_id or not chapter_id:
            raise ValueError("ixdzs8 book id and chapter id are required")
        markup = self._fetch_verified(self._chapter_url(book_id, chapter_id))
        if "og:novel:book_name" in markup and "page-content" not in markup:
            raise ValueError(
                "ixdzs8 redirected to book landing page instead of chapter page")
        doc = _parse(markup)

        result = dict(chapter)
        title = ""
        for h1 in find_all(doc, "h1"):
            if has_ancestor_class(h1, "page-d-top"):
                title = _compact(node_text(h1))
                break
        if title:
            result["title"] = title
        if not result.get("title"):
            for h3 in find_all(doc, "h3"):
                if has_ancestor_class(h3, "page-content"):
                    result["title"] = _compact(node_text(h3))
                    break

        paragraphs = []
        for p in find_all(doc, "p"):
            if not has_ancestor_tag(p, "section") or not has_ancestor_class(p, "page-content"):
                continue
            if "abg" in attr(p, "class"):
                continue
            text = _compact(node_text(p))
            if not text or _is_ad(text):
                continue
            paragraphs.append(text)
        if not paragraphs:
            for div in find_all(doc, "div"):
                if "page-content" in (div.get("class") or []):
                    for line in node_text_lines(div):
                        line = _compact(line)
                        if line and not _is_ad(line):
                            paragraphs.append(line)
                    break
        if not paragraphs:
            for p in find_all(doc, "p"):
                text = _compact(node_text(p))
                if text and not _is_ad(text):
                    paragraphs.append(text)

        if paragraphs:
            chapter_title = result.get("title") or ""
            if chapter_title:
                first = paragraphs[0].replace(chapter_title, "")
                first = first.replace(chapter_title.replace(" ", ""), "").strip()
                if first == "":
                    paragraphs = paragraphs[1:]
                else:
                    paragraphs[0] = first
        if paragraphs and "本章完" in paragraphs[-1]:
            paragraphs = paragraphs[:-1]
        if not paragraphs:
            raise ValueError("ixdzs8 chapter content not found")

        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        markup = self._fetch_verified(BASE + "/bsearch?q=" + quote(keyword, safe=""))
        results = self._parse_search(markup)
        if limit > 0:
            results = results[:limit]
        return results

    def _parse_search(self, markup):
        doc = _parse(markup)
        results = []
        seen = set()
        for item in find_all(doc, "li"):
            if "burl" not in (item.get("class") or []):
                continue
            title_link = _first_ancestor_class(item, "a", "bname")
            book_id = _search_book_id(attr(title_link, "href"))
            if not book_id:
                book_id = _search_book_id(attr(item, "data-url"))
            if not book_id or book_id in seen:
                continue
            seen.add(book_id)
            description = _clean_summary(clean_text(node_text(
                _first_tag_class(item, "p", "l-p2"))))
            results.append({
                "site": self.key, "book_id": book_id,
                "title": clean_text(node_text(title_link)),
                "author": clean_text(node_text(
                    _first_ancestor_class(item, "a", "bauthor"))),
                "description": description,
                "url": BASE + "/read/" + book_id + "/",
                "latest_chapter": clean_text(node_text(
                    _first_tag_class(item, "span", "l-chapter"))),
                "cover_url": attr(find_first(item, "img"), "src").strip(),
            })
        return results

    # ------------------------------------------------------------------
    def _book_info_url(self, book_id):
        return BASE + "/read/" + str(book_id).strip() + "/"

    def _chapter_url(self, book_id, chapter_id):
        return (BASE + "/read/" + str(book_id).strip() + "/"
                + str(chapter_id).strip() + ".html")

    def _fetch_verified(self, url):
        for _ in range(3):
            markup = self._get(url)
            if not _is_challenge(markup):
                return markup
            self._complete_challenge(url, markup)
        raise ValueError("ixdzs8 challenge not bypassed")

    def _complete_challenge(self, raw_url, markup):
        m = TOKEN_RE.search(markup or "")
        if not m:
            raise ValueError("ixdzs8 challenge token not found")
        parts = _parse_url(raw_url)
        query = dict(parse_qsl(parts.query, keep_blank_values=True))
        query["challenge"] = m.group(1)
        challenge_url = urlunsplit(
            (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
        self.http.get(challenge_url, headers={"Referer": raw_url})

    def _post_catalog(self, book_id):
        for _ in range(3):
            payload = self._post_catalog_once(book_id)
            if not _is_challenge(payload):
                return payload
            self._complete_challenge(CATALOG_URL, payload)
        raise ValueError("ixdzs8 catalog challenge not bypassed")

    def _post_catalog_once(self, book_id):
        headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Accept": "application/json, text/plain, */*",
            "Origin": BASE,
            "Referer": self._book_info_url(book_id),
            "X-Requested-With": "XMLHttpRequest",
        }
        return self.http.post_form(CATALOG_URL, {"bid": book_id}, headers=headers)

    def _get(self, url):
        return self.http.get(url)