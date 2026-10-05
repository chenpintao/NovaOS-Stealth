# -*- coding: utf-8 -*-
"""刺猬猫（ciweimao.com）—— 由 go-novel-dl internal/site/ciweimao.go 移植。
正文为 AES-CBC 双层解密，纯 Python 实现（pycryptodome 已在目标运行时内置）。
Loshop & Cpt
"""
import base64
import imghdr
import json
import re
import time
from urllib.parse import quote, urlencode, urlsplit

from bs4 import Comment, NavigableString, Tag
from Crypto.Cipher import AES

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, clean_text, find_first, has_ancestor_class,
                        has_ancestor_tag, node_text, normalize_path, parse_html)

BOOK_RE = re.compile(r"^/book/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/chapter/(\d+)/?$")
CHAPTER_WITH_BOOK_RE = re.compile(r"^/chapter/(\d+)/(\d+)/?$")
BOOK_ID_SCRIPT_RE = re.compile(r"HB\.book\s*=\s*\{[^}]*\bbook_id\s*:\s*(\d+)", re.S)
BOOK_HREF_RE = re.compile(r"/book/(\d+)")
TITLE_CLEAN_RE = re.compile(r"\s+")

BASE = "https://www.ciweimao.com"
WAP_BASE = "https://wap.ciweimao.com"
CHAPTER_LIST_URL = BASE + "/chapter/get_chapter_list_in_chapter_detail"
SESSION_URL = BASE + "/chapter/ajax_get_session_code"
DETAIL_URL = BASE + "/chapter/get_book_chapter_detail_info"
IMAGE_SESSION_URL = BASE + "/chapter/ajax_get_image_session_code"
VIP_IMAGE_URL = BASE + "/chapter/book_chapter_image"


@register
class CiweimaoSite(Site):
    key = "ciweimao"
    display_name = "刺猬猫"
    tags = ["简体中文", "二次元", "同人二创", "原创"]
    hosts = ["ciweimao.com", "wap.ciweimao.com", "mip.ciweimao.com"]

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        raw_url = (raw_url or "").strip()
        if not raw_url:
            return None
        if not raw_url.startswith("http://") and not raw_url.startswith("https://"):
            raw_url = "https://" + raw_url
        parts = urlsplit(raw_url)
        if not _is_ciweimao_host(parts.hostname):
            return None
        path = parts.path
        m = CHAPTER_WITH_BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "chapter_id": m.group(2),
                    "canonical": BASE + "/chapter/" + m.group(2)}
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": BASE + path}
        m = CHAPTER_RE.match(path)
        if m:
            canonical = BASE + path
            book_id = self._resolve_chapter_book_id(m.group(1), canonical)
            if not book_id:
                return None
            return {"site": self.key, "book_id": book_id, "chapter_id": m.group(1),
                    "canonical": canonical}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        book_url = BASE + "/book/" + book_id
        markup = self.http.get(book_url)
        list_markup = self._fetch_chapter_list(book_id)
        info_doc = parse_html(markup)
        list_doc = parse_html(list_markup)

        book = {
            "site": self.key, "id": book_id,
            "title": _fallback(_meta_property(info_doc, "og:novel:book_name"),
                               clean_text(node_text(find_first(info_doc, "h1", class_="title")))),
            "author": _fallback(_meta_property(info_doc, "og:novel:author"),
                                clean_text(node_text(_find_author_link(info_doc)))),
            "description": _fallback(_meta_property(info_doc, "og:description"),
                                     clean_text(node_text(find_first(info_doc, "div", class_="book-desc")))),
            "source_url": book_url,
            "cover_url": _fallback(_meta_property(info_doc, "og:image"),
                                   attr(_first_pred(info_doc, lambda n: (
                                       n.name == "img" and has_ancestor_class(n, "cover"))), "src")),
        }
        if not (book["description"] or "").strip() and (book["title"] or "").strip():
            try:
                results = self.search(book["title"], 10)
                _fill_book_from_search(book, results)
            except Exception:
                pass

        chapters = _parse_chapters(list_doc, BASE, True)
        if not chapters:
            try:
                wap_markup = self.http.get(WAP_BASE + "/book/" + book_id)
                chapters = _parse_chapters(parse_html(wap_markup), WAP_BASE, True)
            except Exception:
                pass
        book["chapters"] = apply_chapter_range(chapters)
        return book

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        _ = book_id
        chapter_id = (chapter.get("id") or "").strip()
        if not chapter_id:
            raise ValueError("ciweimao chapter id is required")
        chapter_url = BASE + "/chapter/" + chapter_id
        markup = self.http.get(chapter_url, headers={"Referer": chapter_url})

        result = dict(chapter)
        title = _extract_title(markup)
        if title:
            result["title"] = title
        if "J_ImgRead" in markup:
            return self._fetch_image_chapter(result, chapter_url)

        last = None
        for attempt in range(3):
            try:
                return self._fetch_text_chapter(result)
            except Exception as exc:  # noqa: BLE001 - 与 Go 一致的有限重试
                last = exc
                time.sleep(0.18 * (attempt + 1))
        raise last

    def _fetch_text_chapter(self, chapter):
        session = self._fetch_session(chapter["id"])
        detail = self._fetch_detail(chapter["id"], session["chapter_access_key"])
        plain = _decrypt_ciweimao(detail["chapter_content"], detail["encryt_keys"],
                                  session["chapter_access_key"])
        doc = parse_html(plain)
        for span in doc.find_all("span"):
            span.decompose()
        paragraphs = []
        for p in doc.find_all("p"):
            text = _clean_text_go(_node_text_breaks(p))
            if text:
                paragraphs.append(text)
        if not paragraphs:
            raise ValueError("ciweimao chapter content not found")
        chapter["content"] = "\n".join(paragraphs)
        chapter["downloaded"] = True
        return chapter

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        if limit <= 0:
            limit = 30
        results = []
        page = 1
        while len(results) < limit:
            page_results, has_next = self._search_page(keyword, page)
            if not page_results:
                break
            remaining = limit - len(results)
            results.extend(page_results[:remaining])
            if not has_next:
                break
            page += 1
        return results

    def _search_page(self, keyword, page):
        url = BASE + "/get-search-book-list/0-0-0-0-0-0/%s/%s/%d" % (
            quote("全部", safe=""), quote(keyword, safe=""), max(1, page))
        markup = self.http.get(url)
        return _parse_search_results(markup)

    # ------------------------------------------------------------------
    def _fetch_chapter_list(self, book_id):
        headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": BASE,
            "Referer": BASE + "/book/" + book_id,
        }
        return self.http.post_form(CHAPTER_LIST_URL,
                                   {"book_id": book_id, "chapter_id": "0", "orderby": "0"},
                                   headers=headers)

    def _fetch_session(self, chapter_id):
        headers = _xhr_headers(chapter_id)
        payload = json.loads(self.http.post_form(SESSION_URL, {"chapter_id": chapter_id},
                                                 headers=headers))
        key = (payload.get("chapter_access_key") or "").strip()
        if not key:
            raise ValueError("ciweimao chapter_access_key missing")
        return payload

    def _fetch_detail(self, chapter_id, access_key):
        headers = _xhr_headers(chapter_id)
        payload = json.loads(self.http.post_form(
            DETAIL_URL, {"chapter_id": chapter_id, "chapter_access_key": access_key},
            headers=headers))
        if not payload.get("chapter_content") or not payload.get("encryt_keys"):
            raise ValueError("ciweimao encrypted chapter payload missing")
        return payload

    # ------------------------------------------------------------------
    def _fetch_image_chapter(self, chapter, chapter_url):
        session = self._fetch_image_session(chapter["id"], chapter_url)
        image_code = _decrypt_ciweimao(session["image_code"], session["encryt_keys"],
                                       session["access_key"])
        data, media = self._fetch_vip_image(chapter["id"], chapter_url, image_code)
        if not data:
            raise ValueError("ciweimao image chapter payload is empty")
        alt = _markdown_alt(chapter.get("title"))
        if not alt:
            alt = "图片"
        chapter["content"] = "![%s](data:%s;base64,%s)" % (
            alt, media, base64.b64encode(data).decode("ascii"))
        chapter["downloaded"] = True
        return chapter

    def _fetch_image_session(self, chapter_id, referer):
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": BASE,
            "Referer": referer,
        }
        payload = json.loads(self.http.post_form(IMAGE_SESSION_URL, {}, headers=headers))
        code = payload.get("code")
        if code is not None and code not in (0, 100000):
            raise ValueError("ciweimao image session failed: %s"
                             % (payload.get("error_message") or code))
        if not payload.get("image_code") or not payload.get("encryt_keys") or not payload.get("access_key"):
            raise ValueError("ciweimao image session payload missing for chapter %s" % chapter_id)
        return payload

    def _fetch_vip_image(self, chapter_id, referer, image_code):
        query = urlencode({
            "chapter_id": chapter_id, "area_width": "871", "font": "undefined",
            "font_size": "18", "image_code": image_code,
            "bg_color_name": "white", "text_color_name": "white",
        })
        headers = {
            "Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": BASE,
            "Referer": referer,
        }
        resp = self.http.session.request("GET", VIP_IMAGE_URL + "?" + query,
                                         headers=headers, timeout=self.http.timeout)
        if resp.status_code < 200 or resp.status_code >= 300:
            raise ValueError("ciweimao image http %d" % resp.status_code)
        data = resp.content
        media = (resp.headers.get("Content-Type", "") or "").split(";")[0].strip().lower()
        if not media.startswith("image/"):
            kind = imghdr.what(None, h=data)
            if kind:
                media = "image/" + ("jpeg" if kind == "jpg" else kind)
        if not media.startswith("image/"):
            raise ValueError("ciweimao image payload is not an image: %s" % media)
        return data, media

    # ------------------------------------------------------------------
    def _resolve_chapter_book_id(self, chapter_id, canonical):
        chapter_id = (chapter_id or "").strip()
        if not chapter_id:
            return ""
        candidates = [canonical, BASE + "/chapter/" + chapter_id,
                      WAP_BASE + "/chapter/" + chapter_id]
        seen = set()
        for url in candidates:
            if not url or url in seen:
                continue
            seen.add(url)
            try:
                markup = self.http.get(url)
            except Exception:
                continue
            book_id = _extract_chapter_book_id(markup)
            if book_id:
                return book_id
        return ""


# ---------------------------------------------------------------------------
# 解析与工具
# ---------------------------------------------------------------------------
def _is_ciweimao_host(host):
    host = (host or "").lower().strip().rstrip(".")
    return host == "ciweimao.com" or host.endswith(".ciweimao.com")


def _first_pred(node, pred):
    return node.find(pred) if node is not None else None


def _has_class_contains(node, part):
    if node is None:
        return False
    return any(part in c for c in (node.get("class") or []))


def _meta_property(doc, prop):
    for node in doc.find_all("meta"):
        if attr(node, "property") == prop:
            content = attr(node, "content").strip()
            if content:
                return content
    return ""


def _fallback(value, other):
    return value.strip() if (value or "").strip() else (other or "").strip()


def _find_author_link(doc):
    for a in doc.find_all("a"):
        if not has_ancestor_tag(a, "span"):
            continue
        grand = a.parent.parent if a.parent is not None else None
        if grand is None:
            continue
        if has_ancestor_tag(grand, "h1"):
            return a
    return None


def _xhr_headers(chapter_id):
    return {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": BASE,
        "Referer": BASE + "/chapter/" + chapter_id,
    }


def _node_text_breaks(node):
    if node is None:
        return ""
    parts = []

    def walk(n):
        if isinstance(n, NavigableString):
            if not isinstance(n, Comment):
                parts.append(str(n))
            return
        if n.name == "br":
            parts.append("\n")
        for child in n.children:
            walk(child)

    walk(node)
    return "".join(parts)


def _clean_text_go(value):
    value = (value or "").replace("\u00a0", " ").replace("\r", "")
    lines = []
    for line in value.split("\n"):
        line = " ".join(line.split())
        if line:
            lines.append(line)
    return "\n".join(lines)


def _pkcs7_unpad(data, size):
    if not data or len(data) % size != 0:
        raise ValueError("invalid padding size")
    pad = data[-1]
    if pad == 0 or pad > size or pad > len(data):
        raise ValueError("invalid padding")
    if any(b != pad for b in data[len(data) - pad:]):
        raise ValueError("invalid padding")
    return data[:len(data) - pad]


def _decrypt_ciweimao(content, keys, access_key):
    if not keys or not access_key:
        raise ValueError("ciweimao decrypt input missing")
    selected = [keys[ord(access_key[-1]) % len(keys)], keys[ord(access_key[0]) % len(keys)]]
    current = content.encode("utf-8")
    for key_b64 in selected:
        raw = base64.b64decode(current)
        key = base64.b64decode(key_b64)
        if len(raw) < 16:
            raise ValueError("ciweimao ciphertext too short")
        iv, ciphertext = raw[:16], raw[16:]
        if len(ciphertext) % 16 != 0:
            raise ValueError("ciweimao ciphertext size invalid")
        plain = AES.new(key, AES.MODE_CBC, iv).decrypt(ciphertext)
        current = _pkcs7_unpad(plain, 16)
    return current.decode("utf-8")


def _extract_title(markup):
    doc = parse_html(markup)
    return clean_text(node_text(find_first(doc, "h1", class_="chapter")))


def _ciweimao_path(raw):
    raw = (raw or "").strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        return normalize_path(raw)
    return raw


def _parse_chapters(doc, base_url, include_locked):
    if doc is None:
        return []
    chapters = _parse_desktop_chapters(doc, base_url, include_locked)
    if chapters:
        return chapters
    return _parse_mobile_chapters(doc, base_url, include_locked)


def _parse_desktop_chapters(doc, base_url, include_locked):
    chapters = []
    seen = set()
    volume = "正文"
    for box in doc.find_all("div", class_="book-chapter-box"):
        title = clean_text(node_text(find_first(box, "h4", class_="sub-tit")))
        if title:
            volume = title
        for a in box.find_all("a"):
            if not has_ancestor_class(a, "book-chapter-list"):
                continue
            _append_chapter(chapters, seen, a, base_url, volume, include_locked)
    return chapters


def _parse_mobile_chapters(doc, base_url, include_locked):
    root = _first_pred(doc, lambda n: (
        n.name == "div" and _has_class_contains(n, "cnt-box") and _has_class_contains(n, "catalogue")))
    if root is None:
        root = doc
    chapters = []
    seen = set()
    volume = "正文"

    def walk(n):
        nonlocal volume
        if isinstance(n, Tag):
            if n.name == "h2":
                title = clean_text(node_text(n))
                if title:
                    volume = title
            if n.name == "a":
                _append_chapter(chapters, seen, n, base_url, volume, include_locked)
        for child in n.children:
            walk(child)

    walk(root)
    return chapters


def _append_chapter(chapters, seen, a, base_url, volume, include_locked):
    href = attr(a, "href").strip()
    m = CHAPTER_RE.match(_ciweimao_path(href))
    if not m:
        return
    chapter_id = m.group(1)
    if chapter_id in seen:
        return
    locked = _first_pred(a, lambda n: n.name == "i" and _has_class_contains(n, "icon-lock")) is not None
    if locked and not include_locked:
        return
    seen.add(chapter_id)
    chapters.append({
        "id": chapter_id, "title": clean_text(node_text(a)),
        "url": absolutize(base_url, href), "volume": volume,
        "order": len(chapters) + 1,
    })


def _parse_search_results(markup):
    doc = parse_html(markup)
    results = []
    for item in doc.find_all("li"):
        book_id = attr(item, "data-book-id").strip()
        if not book_id:
            continue
        title_link = _first_pred(item, lambda n: n.name == "a" and has_ancestor_class(n, "tit"))
        if title_link is None:
            title_link = _first_pred(item, lambda n: n.name == "a" and "cover" in (n.get("class") or []))
        if title_link is None:
            continue

        author = ""
        latest = ""
        for p in item.find_all("p"):
            text = clean_text(node_text(p))
            if text.startswith("小说作者："):
                author = text[len("小说作者："):].strip()
            elif text.startswith("最近更新："):
                text = text[len("最近更新："):].strip()
                idx = text.find("/")
                if idx >= 0:
                    text = text[idx + 1:].strip()
                latest = text

        desc_node = find_first(item, "div", class_="desc")
        cover = _first_pred(item, lambda n: n.name == "img" and has_ancestor_class(n, "cover"))
        results.append({
            "site": "ciweimao", "book_id": book_id,
            "title": _fallback(attr(title_link, "title"), clean_text(node_text(title_link))),
            "author": author,
            "description": _clean_text_go(_node_text_breaks(desc_node)),
            "url": absolutize(BASE, attr(title_link, "href")),
            "latest_chapter": latest,
            "cover_url": absolutize(BASE, attr(cover, "src")),
        })
    has_next = _first_pred(doc, lambda n: (
        n.name == "a" and attr(n, "rel").strip().lower() == "next")) is not None
    return results, has_next


def _fill_book_from_search(book, results):
    if not results:
        return
    match = None
    for item in results:
        if item.get("book_id") == book.get("id"):
            match = item
            break
    if match is None:
        book_title = _normalize_fallback(book.get("title"))
        book_author = _normalize_fallback(book.get("author"))
        for item in results:
            if book_title and _normalize_fallback(item.get("title")) != book_title:
                continue
            if book_author and _normalize_fallback(item.get("author")) != book_author:
                continue
            match = item
            break
    if match is None:
        return
    for key in ("title", "author", "description", "cover_url", "url"):
        if not (book.get(key) or "").strip() and (match.get(key) or "").strip():
            book[key] = match[key]


def _normalize_fallback(value):
    return TITLE_CLEAN_RE.sub("", (value or "").strip())


def _markdown_alt(value):
    value = (value or "").strip()
    for ch in ("[", "]", "\r", "\n"):
        value = value.replace(ch, " ")
    return value.strip()


def _extract_chapter_book_id(markup):
    m = BOOK_ID_SCRIPT_RE.search(markup)
    if m:
        return m.group(1).strip()
    m = BOOK_HREF_RE.search(markup)
    if m:
        return m.group(1).strip()
    return ""