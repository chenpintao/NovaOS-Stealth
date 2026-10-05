# -*- coding: utf-8 -*-
"""次元姬（ciyuanji.com）—— 由 go-novel-dl internal/site/ciyuanji.go 移植。
章节正文为单 DES-ECB 解密；移动端搜索接口使用 DES+MD5 签名。
Loshop & Cpt
"""
import base64
import hashlib
import json
import os
import re
import time
from urllib.parse import quote, urlencode, urlsplit

from bs4 import Comment, NavigableString, Tag
from Crypto.Cipher import DES

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, clean_text, find_first, has_ancestor_class,
                        node_text, normalize_path, parse_html)

BOOK_RE = re.compile(r"^/b_d_(\d+)\.html$")
CHAPTER_RE = re.compile(r"^/chapter/(\d+)_(\d+)\.html$")
NEXT_RE = re.compile(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
RENDERED_HREF_RE = re.compile(r"/chapter/(\d+)_(\d+)\.html")

DESKTOP_BASE = "https://www.ciyuanji.com"
MOBILE_BASE = "https://m.ciyuanji.com"
SIGN_KEY = ("NpkTYvpvhJjEog8Y051gQDHmReY54z5t3F0zSd9QEFuxWGqfC8g8Y4GPu"
            "abq0KPdxArlji4dSnnHCARHnkqYBLu7iIw55ibTo18")
DES_KEY = b"ZUreQN0E"
REQUEST_INTERVAL = 1.0
DEFAULT_PAGE_SIZE = 10


@register
class CiyuanjiSite(Site):
    key = "ciyuanji"
    display_name = "次元姬"
    tags = ["简体中文", "二次元", "轻小说", "原创"]
    hosts = ["ciyuanji.com"]

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        raw_url = (raw_url or "").strip()
        if not raw_url:
            return None
        if not raw_url.startswith("http://") and not raw_url.startswith("https://"):
            raw_url = "https://" + raw_url
        parts = urlsplit(raw_url)
        host = (parts.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host != "ciyuanji.com":
            return None
        path = parts.path
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "chapter_id": m.group(2),
                    "canonical": DESKTOP_BASE + path}
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": DESKTOP_BASE + path}
        if path == "/bookDetails":
            book_id = _query_value(parts.query, "bookId")
            if book_id:
                return {"site": self.key, "book_id": book_id,
                        "canonical": _mobile_book_url(book_id)}
        if path == "/chapter":
            book_id = _query_value(parts.query, "bookId")
            chapter_id = _query_value(parts.query, "chapterId")
            if book_id and chapter_id:
                return {"site": self.key, "book_id": book_id, "chapter_id": chapter_id,
                        "canonical": _mobile_chapter_url(book_id, chapter_id)}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        book_url = _mobile_book_url(book_id)
        markup = self._get_page(book_url, MOBILE_BASE + "/")

        data = _extract_json_script(markup)
        page_props = _map_path(data, "props", "pageProps")
        book_data = _map_value(page_props.get("book")) if page_props else None
        if book_data is None:
            raise ValueError("ciyuanji book data not found")

        book = {
            "site": self.key, "id": book_id,
            "title": _string_value(book_data.get("bookName")),
            "author": _string_value(book_data.get("authorName")),
            "description": _string_value(book_data.get("notes")),
            "source_url": book_url,
            "cover_url": _string_value(book_data.get("imgUrl")),
            "tags": _parse_tags(book_data.get("tagList")),
        }
        if not book["title"]:
            book["title"] = _extract_html_title(markup)

        try:
            catalog_markup = self._get_page(_mobile_catalog_url(book_id), book_url)
            catalog_data = _extract_json_script(catalog_markup)
            catalog_props = _map_path(catalog_data, "props", "pageProps")
            if catalog_props:
                page_props = catalog_props
                markup = catalog_markup
        except Exception:
            pass

        chapters = self._build_chapters(page_props, markup, book_id)
        book["chapters"] = apply_chapter_range(chapters)
        return book

    def _build_chapters(self, page_props, markup, book_id):
        book_chapter = _map_value(page_props.get("bookChapter")) if page_props else None
        raw_list = _slice_value(book_chapter.get("chapterList")) if book_chapter else []
        if not raw_list:
            return _build_rendered_chapters(markup, book_id)

        items = []
        for item in raw_list:
            chapter_data = _map_value(item)
            if chapter_data is None:
                continue
            chapter_id = _string_value(chapter_data.get("chapterId"))
            if not chapter_id:
                continue
            accessible = (_string_value(chapter_data.get("isFee")) == "0"
                          or _string_value(chapter_data.get("isBuy")) == "1")
            if not accessible:
                continue
            items.append({
                "chapterID": chapter_id,
                "title": _string_value(chapter_data.get("chapterName")),
                "volume": _fallback(_string_value(chapter_data.get("title")), "正文"),
                "volumeSortNum": _int64_value(chapter_data.get("volumeSortNum")),
                "sortNum": _int64_value(chapter_data.get("sortNum")),
            })

        items.sort(key=lambda it: (it["volumeSortNum"], it["sortNum"], it["chapterID"]))
        chapters = []
        for item in items:
            chapters.append({
                "id": item["chapterID"], "title": item["title"],
                "url": _mobile_chapter_url(book_id, item["chapterID"]),
                "volume": item["volume"], "order": len(chapters) + 1,
            })
        if not chapters:
            return _build_rendered_chapters(markup, book_id)
        return chapters

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        book_id = (book_id or "").strip()
        chapter_id = (chapter.get("id") or "").strip()
        if not chapter_id:
            raise ValueError("ciyuanji chapter id is required")
        time.sleep(REQUEST_INTERVAL)

        book_url = _mobile_book_url(book_id)
        chapter_url = _mobile_chapter_url(book_id, chapter_id)
        markup = self._get_chapter_page(chapter_url, book_url)

        try:
            data = _extract_json_script(markup)
            page_props = _map_path(data, "props", "pageProps")
            chapter_content = _map_value(page_props.get("chapterContent")) if page_props else None
            enc = _string_value(chapter_content.get("content")) if chapter_content else ""
        except Exception:
            enc = ""
        if enc:
            try:
                plain = _decrypt_ciyuanji(enc)
                result = dict(chapter)
                title = _string_value(chapter_content.get("chapterName"))
                if title:
                    result["title"] = title
                result["content"] = plain.strip()
                result["downloaded"] = True
                return result
            except Exception:
                pass

        doc = parse_html(markup)
        article = None
        for node in doc.find_all("article"):
            if _has_class_contains(node, "chapter_article"):
                article = node
                break
        if article is None:
            raise ValueError("ciyuanji chapter content not found")
        paragraphs = []
        for p in article.find_all("p"):
            text = _clean_text_go(_node_text_breaks(p))
            if text:
                paragraphs.append(text)
        if not paragraphs:
            raise ValueError("ciyuanji chapter content not found")
        result = dict(chapter)
        title = _extract_chapter_title(doc)
        if title:
            result["title"] = title
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
        try:
            return self._search_mobile(keyword, limit)
        except Exception:
            pass
        return self._search_web(keyword, limit)

    def _search_mobile(self, keyword, limit):
        page_size = limit if limit > 0 else DEFAULT_PAGE_SIZE
        if page_size > 30:
            page_size = 30
        data = self._mobile_api_get("/mciyuanji/m/book/searchBookList", {
            "keyword": keyword, "pageNo": 1, "pageSize": page_size,
        })
        books = _slice_value(_map_value(data).get("esBookList")) if _map_value(data) else []
        results = []
        seen = set()
        for book in books:
            book = _map_value(book)
            if book is None:
                continue
            book_id = _string_value(book.get("bookId"))
            if not book_id or book_id in seen:
                continue
            seen.add(book_id)
            results.append({
                "site": self.key, "book_id": book_id,
                "title": clean_text(_string_value(book.get("bookName"))),
                "author": clean_text(_string_value(book.get("authorName"))),
                "description": clean_text(_string_value(book.get("notes"))),
                "url": _mobile_book_url(book_id),
                "latest_chapter": clean_text(_string_value(book.get("latestChapterName"))),
                "cover_url": absolutize(MOBILE_BASE, _string_value(book.get("imgUrl"))),
            })
            if limit > 0 and len(results) >= limit:
                break
        return results

    def _search_web(self, keyword, limit):
        markup = self._get_page(_search_page_url(keyword), MOBILE_BASE + "/")
        page_results, has_next, build_id = _parse_search_first_page(markup)

        results = []
        seen = set()

        def append(items):
            for item in items:
                book_id = item.get("book_id") or ""
                if not book_id or book_id in seen:
                    continue
                seen.add(book_id)
                results.append(item)
                if len(results) >= limit:
                    return

        append(page_results)
        if len(results) >= limit or not has_next or not build_id:
            return results[:limit] if limit > 0 else results

        page = 2
        while len(results) < limit:
            page_results, total_count = self._search_json_page(build_id, keyword, page)
            if not page_results:
                break
            append(page_results)
            if page * 10 >= total_count:
                break
            page += 1
        return results[:limit] if limit > 0 else results

    def _search_json_page(self, build_id, keyword, page):
        url = "%s/_next/data/%s/library/card/0_0_0_0_1_%d_10.json?search=%s" % (
            DESKTOP_BASE, quote(build_id.strip(), safe=""), page, quote(keyword, safe=""))
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Referer": _search_page_url(keyword),
        }
        markup = self.http.get(url, headers=headers)
        payload = json.loads(markup)
        page_props = _map_path(payload, "pageProps")
        if not page_props:
            raise ValueError("ciyuanji search pageProps not found")
        list_data = _map_value(page_props.get("libraryListData"))
        if list_data is None:
            return [], 0
        total_count = _int64_value(list_data.get("totalCount"))
        results = []
        for item in _slice_value(list_data.get("list")):
            book = _map_value(item)
            if book is None:
                continue
            book_id = _string_value(book.get("bookId"))
            if not book_id:
                continue
            results.append({
                "site": self.key, "book_id": book_id,
                "title": clean_text(_string_value(book.get("bookName"))),
                "author": clean_text(_string_value(book.get("authorName"))),
                "description": clean_text(_string_value(book.get("notes"))),
                "url": _mobile_book_url(book_id),
                "latest_chapter": clean_text(_string_value(book.get("latestChapterName"))),
                "cover_url": absolutize(MOBILE_BASE, _string_value(book.get("imgUrl"))),
            })
        return results, total_count

    # ------------------------------------------------------------------
    def _get_page(self, url, referer):
        headers = {}
        if (referer or "").strip():
            headers["Referer"] = referer
        return self.http.get(url, headers=headers)

    def _get_chapter_page(self, url, referer):
        last_markup = ""
        for attempt in range(3):
            markup = self._get_page(url, referer)
            last_markup = markup
            if not _is_fallback_page(markup):
                return markup
            if attempt == 2:
                break
            time.sleep((attempt + 1) * REQUEST_INTERVAL)
        return last_markup

    def _mobile_api_get(self, endpoint, payload):
        values = _mobile_api_values(payload)
        url = MOBILE_BASE + "/api" + endpoint + "?" + urlencode(values)
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Referer": MOBILE_BASE + "/",
        }
        wrapper = json.loads(self.http.get(url, headers=headers))
        code = wrapper.get("code")
        if code is not None and code != "" and code != "200":
            raise ValueError("ciyuanji mobile api %s: %s" % (code, wrapper.get("msg")))
        data = wrapper.get("data")
        if not data:
            return None
        return data


# ---------------------------------------------------------------------------
# 加密 / 签名
# ---------------------------------------------------------------------------
def _pkcs5_pad(data, size):
    pad = size - len(data) % size
    if pad == 0:
        pad = size
    return data + bytes([pad]) * pad


def _pkcs5_unpad(data, size):
    if not data or len(data) % size != 0:
        raise ValueError("invalid padding size")
    pad = data[-1]
    if pad == 0 or pad > size or pad > len(data):
        raise ValueError("invalid padding")
    if any(b != pad for b in data[len(data) - pad:]):
        raise ValueError("invalid padding")
    return data[:len(data) - pad]


def _encrypt_ciyuanji(content):
    raw = _pkcs5_pad(content.encode("utf-8"), 8)
    return base64.b64encode(DES.new(DES_KEY, DES.MODE_ECB).encrypt(raw)).decode("ascii")


def _decrypt_ciyuanji(content):
    raw = base64.b64decode(content.replace("\n", ""))
    out = DES.new(DES_KEY, DES.MODE_ECB).decrypt(raw)
    return _pkcs5_unpad(out, 8).decode("utf-8")


def _request_id():
    raw = bytearray(os.urandom(16))
    raw[6] = (raw[6] & 0x0f) | 0x40
    raw[8] = (raw[8] & 0x3f) | 0x80
    h = raw.hex()
    return "%s-%s-%s-%s-%s" % (h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])


def _mobile_api_values(payload):
    request_id = _request_id()
    timestamp = int(time.time() * 1000)
    signed = dict(payload)
    signed["timestamp"] = timestamp
    raw_payload = json.dumps(signed, ensure_ascii=False, sort_keys=True,
                             separators=(",", ":")).encode("utf-8")
    param = _encrypt_ciyuanji(raw_payload.decode("utf-8"))
    sign_source = "param=%s&requestId=%s&timestamp=%d&key=%s" % (
        param, request_id, timestamp, SIGN_KEY)
    sign_input = base64.b64encode(sign_source.encode("utf-8"))
    sign = hashlib.md5(sign_input).hexdigest().upper()
    return {"requestId": request_id, "timestamp": timestamp, "param": param, "sign": sign}


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def _query_value(query, key):
    for pair in (query or "").split("&"):
        if "=" in pair:
            name, value = pair.split("=", 1)
            if name == key:
                return value
    return ""


def _mobile_book_url(book_id):
    return MOBILE_BASE + "/bookDetails?bookId=" + quote((book_id or "").strip(), safe="")


def _mobile_catalog_url(book_id):
    return MOBILE_BASE + "/bookDetails/catalog?bookId=" + quote((book_id or "").strip(), safe="")


def _mobile_chapter_url(book_id, chapter_id):
    return MOBILE_BASE + "/chapter?" + urlencode({
        "bookId": (book_id or "").strip(), "chapterId": (chapter_id or "").strip()})


def _search_page_url(keyword):
    return MOBILE_BASE + "/search/list?keyword=" + quote(keyword, safe="")


def _extract_json_script(markup):
    m = NEXT_RE.search(markup)
    if not m:
        raise ValueError("embedded JSON script not found")
    return json.loads(m.group(1))


def _map_path(root, *keys):
    current = root
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current if isinstance(current, dict) else None


def _map_value(value):
    return value if isinstance(value, dict) else None


def _slice_value(value):
    return value if isinstance(value, list) else []


def _string_value(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value))
    return str(value).strip()


def _int64_value(value):
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


def _fallback(value, other):
    return value.strip() if (value or "").strip() else (other or "").strip()


def _has_class_contains(node, part):
    if node is None:
        return False
    return any(part in c for c in (node.get("class") or []))


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


def _parse_tags(value):
    items = _slice_value(value)
    seen = set()
    tags = []
    for item in items:
        tag_data = _map_value(item)
        if tag_data is None:
            continue
        tag = _string_value(tag_data.get("tagName"))
        if not tag or tag in seen:
            continue
        seen.add(tag)
        tags.append(tag)
    return tags


def _extract_html_title(markup):
    doc = parse_html(markup)
    title = clean_text(node_text(find_first(doc, "title")))
    if not title:
        return ""
    idx = title.find("(")
    if idx > 0:
        title = title[:idx].strip()
    idx = title.find("在线阅读")
    if idx > 0:
        title = title[:idx].strip()
    return title


def _extract_chapter_title(doc):
    node = None
    for h1 in doc.find_all("h1"):
        if _has_class_contains(h1, "chapter_title"):
            node = h1
            break
    if node is None:
        node = find_first(doc, "h1")
    return clean_text(node_text(node))


def _is_fallback_page(markup):
    return '"pageProps":{}' in markup or "b_d_undefined.html" in markup


def _build_rendered_chapters(markup, book_id):
    doc = parse_html(markup)
    nodes = []
    for node in doc.find_all("div"):
        if _has_class_contains(node, "book_detail_title") or _has_class_contains(node, "book_detail_content"):
            nodes.append(node)
    seen = set()
    chapters = []
    volume = "正文"
    for node in nodes:
        if _has_class_contains(node, "book_detail_title"):
            text = clean_text(node_text(node))
            if text and "章节目录" not in text:
                volume = text
            continue
        for a in node.find_all("a"):
            href = attr(a, "href")
            m = RENDERED_HREF_RE.search(href)
            if not m or m.group(1) != book_id:
                continue
            if m.group(2) in seen:
                continue
            seen.add(m.group(2))
            chapters.append({
                "id": m.group(2), "title": clean_text(node_text(a)),
                "url": _mobile_chapter_url(book_id, m.group(2)),
                "volume": volume, "order": len(chapters) + 1,
            })
    return chapters


def _parse_search_first_page(markup):
    doc = parse_html(markup)
    results = []
    seen = set()
    for item in doc.find_all("li"):
        if not _has_class_contains(item, "card_item__"):
            continue
        title_link = None
        for a in item.find_all("a"):
            href = attr(a, "href").strip()
            if BOOK_RE.match(href):
                title_link = a
                break
        if title_link is None:
            continue
        m = BOOK_RE.match(attr(title_link, "href").strip())
        if not m:
            continue
        book_id = m.group(1)
        if book_id in seen:
            continue
        seen.add(book_id)

        author_line = None
        chapter_line = None
        title_line = None
        desc_line = None
        for p in item.find_all("p"):
            if _has_class_contains(p, "BookCard_author__"):
                author_line = p
            elif _has_class_contains(p, "BookCard_chapter__"):
                chapter_line = p
            elif _has_class_contains(p, "BookCard_title__"):
                title_line = p
            elif _has_class_contains(p, "BookCard_desc__"):
                desc_line = p

        latest = ""
        if chapter_line is not None:
            latest = clean_text(node_text(find_first(chapter_line, "a")))
            if latest.startswith("最新："):
                latest = latest[len("最新："):].strip()

        cover = find_first(item, "img")
        results.append({
            "site": self.key, "book_id": book_id,
            "title": clean_text(node_text(title_line)),
            "author": clean_text(node_text(find_first(author_line, "a"))),
            "description": _clean_text_go(_node_text_breaks(desc_line)),
            "url": absolutize(DESKTOP_BASE, attr(title_link, "href")),
            "latest_chapter": latest,
            "cover_url": absolutize(DESKTOP_BASE, _fallback(attr(cover, "data-src"),
                                                           attr(cover, "src"))),
        })

    build_id = ""
    try:
        build_id = _string_value(_extract_json_script(markup).get("buildId"))
    except Exception:
        build_id = ""

    has_next = False
    for a in doc.find_all("a"):
        if attr(a, "aria-label").strip().lower() == "go to next page":
            has_next = True
            break
    return results, has_next, build_id