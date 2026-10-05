# -*- coding: utf-8 -*-
"""番茄小说（fanqienovel.com）—— 由 go-novel-dl internal/site/fanqienovel.go 移植。
Loshop & Cpt
"""
import functools
import json
import re
import time
from urllib.parse import quote, urlsplit

from ..base import Site, apply_chapter_range, register
from ..htmlutil import node_text, parse_html
from ..http import HttpError, decode_bytes

BOOK_RE = re.compile(r"^/page/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/reader/(\d+)/?$")

INITIAL_STATE_KEY = "window.__INITIAL_STATE__"
SEARCH_URL = "http://101.35.133.34:5000/api/search"
CHAPTER_API = "http://101.35.133.34:5000/api/raw_full"

VOICE_MARKER_RE = re.compile(r"\{!--\s*PGC_VOICE:.*?--\}")


# ---------------------------------------------------------------------------
# window.__INITIAL_STATE__ 内的 JS 对象解析
# ---------------------------------------------------------------------------
def _extract_initial_state(markup):
    m = re.search(r"window\.__INITIAL_STATE__\s*=\s*", markup)
    if not m:
        raise ValueError("fanqienovel initial state not found")
    start = m.end()
    if start >= len(markup) or markup[start] != "{":
        raise ValueError("fanqienovel initial state is not an object")
    depth = 0
    quote_char = None
    escaped = False
    i = start
    while i < len(markup):
        ch = markup[i]
        if quote_char:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote_char:
                quote_char = None
        else:
            if ch == '"' or ch == "'":
                quote_char = ch
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    break
        i += 1
    if depth != 0:
        raise ValueError("unterminated fanqienovel initial state")
    tokens = _tokenize_js_object(markup[start:i + 1])
    value, _next, err = _parse_js_value(tokens, 0)
    if err is not None:
        raise ValueError(str(err))
    if not isinstance(value, dict):
        raise ValueError("fanqienovel initial state is not an object")
    return value


def _tokenize_js_object(src):
    toks = []
    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        if ch in " \t\r\n":
            i += 1
            continue
        if ch == "'" or ch == '"':
            j = i + 1
            esc = False
            while j < n:
                c = src[j]
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == ch:
                    j += 1
                    break
                j += 1
            toks.append(src[i:j])
            i = j
            continue
        if ch == "/" and i + 1 < n and src[i + 1] in "/*":
            if src[i + 1] == "/":
                i += 2
                while i < n and src[i] not in "\n\r":
                    i += 1
            else:
                i += 2
                while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                    i += 1
                i += 2
            continue
        if ch in "{}[]:,":
            toks.append(ch)
            i += 1
            continue
        j = i
        while j < n and src[j] not in " \t\r\n{}[]:,":
            j += 1
        toks.append(src[i:j])
        i = j
    return toks


def _parse_js_value(tokens, idx):
    if idx >= len(tokens):
        return None, idx, ValueError("unexpected end of tokens")
    tok = tokens[idx]
    if tok == "{":
        obj = {}
        idx += 1
        while idx < len(tokens) and tokens[idx] != "}":
            key = tokens[idx]
            if key[:1] in ('"', "'"):
                key, _e = _parse_js_string(key)
            idx += 1
            if idx >= len(tokens) or tokens[idx] != ":":
                return None, idx, ValueError("expected colon in object")
            idx += 1
            value, nxt, err = _parse_js_value(tokens, idx)
            if err is not None:
                return None, nxt, err
            obj[key] = value
            idx = nxt
            if idx < len(tokens) and tokens[idx] == ",":
                idx += 1
        if idx >= len(tokens) or tokens[idx] != "}":
            return None, idx, ValueError("unterminated object")
        return obj, idx + 1, None
    if tok == "[":
        arr = []
        idx += 1
        while idx < len(tokens) and tokens[idx] != "]":
            value, nxt, err = _parse_js_value(tokens, idx)
            if err is not None:
                return None, nxt, err
            arr.append(value)
            idx = nxt
            if idx < len(tokens) and tokens[idx] == ",":
                idx += 1
        if idx >= len(tokens) or tokens[idx] != "]":
            return None, idx, ValueError("unterminated array")
        return arr, idx + 1, None
    value, err = _parse_js_token(tok)
    return value, idx + 1, err


def _parse_js_token(tok):
    tok = tok.strip()
    if tok in ("null", "undefined"):
        return None, None
    if tok == "true":
        return True, None
    if tok == "false":
        return False, None
    if tok[:1] in ('"', "'"):
        return _parse_js_string(tok)
    try:
        return int(tok), None
    except ValueError:
        pass
    try:
        return float(tok), None
    except ValueError:
        pass
    return tok, None


def _parse_js_string(s):
    if len(s) < 2 or s[0] != s[-1]:
        return "", ValueError("invalid JS string literal")
    body = s[1:-1]
    if "\\" not in body:
        return body, None
    out = []
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch != "\\":
            out.append(ch)
            i += 1
            continue
        i += 1
        if i >= n:
            break
        c = body[i]
        if c in ("'", '"', "\\"):
            out.append(c)
        elif c == "n":
            out.append("\n")
        elif c == "r":
            out.append("\r")
        elif c == "t":
            out.append("\t")
        elif c == "b":
            out.append("\b")
        elif c == "f":
            out.append("\f")
        elif c == "v":
            out.append("\v")
        elif c == "0":
            out.append("\0")
        elif c == "x":
            if i + 2 >= n:
                return "", ValueError("invalid hex escape")
            try:
                out.append(chr(int(body[i + 1:i + 3], 16)))
            except ValueError:
                return "", ValueError("invalid hex escape")
            i += 2
        elif c == "u":
            if i + 4 >= n:
                return "", ValueError("invalid unicode escape")
            try:
                out.append(chr(int(body[i + 1:i + 5], 16)))
            except ValueError:
                return "", ValueError("invalid unicode escape")
            i += 4
        else:
            out.append(c)
        i += 1
    return "".join(out), None


# ---------------------------------------------------------------------------
# 值转换工具
# ---------------------------------------------------------------------------
def _str_value(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip()


def _bool_value(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value in ("true", "1")
    if isinstance(value, (int, float)):
        return value != 0
    return False


def _fanqie_chapter_number(raw):
    raw = _str_value(raw)
    if not raw:
        return 0
    try:
        return int(raw)
    except ValueError:
        return 0


def _category_tags(raw):
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    tags = []
    for item in data:
        if isinstance(item, dict):
            name = _str_value(item.get("Name"))
            if name:
                tags.append(name)
    return tags


# ---------------------------------------------------------------------------
# 站点
# ---------------------------------------------------------------------------
@register
class FanqieNovelSite(Site):
    key = "fanqienovel"
    display_name = "番茄小说网"
    tags = ["简体中文", "原创", "免费", "男性向", "女性向", "抖音"]
    hosts = ["fanqienovel.com"]
    timeout = 15.0

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
        if host != "fanqienovel.com":
            return None
        m = CHAPTER_RE.match(parts.path)
        if m:
            return {"site": self.key, "chapter_id": m.group(1),
                    "canonical": "https://fanqienovel.com" + parts.path}
        m = BOOK_RE.match(parts.path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": "https://fanqienovel.com" + parts.path}
        return None

    # ------------------------------------------------------------------
    def _request_text(self, url, referer, accept, attempts=3):
        last = None
        backoff = 0.4
        for _attempt in range(attempts):
            headers = {"Accept": accept, "Accept-Language": "zh-CN,zh;q=0.9"}
            if referer:
                headers["Referer"] = referer
            try:
                resp = self.http.session.request(
                    "GET", url, headers=headers, timeout=self.timeout)
            except Exception as exc:
                last = exc
                time.sleep(backoff)
                backoff *= 2
                continue
            status = resp.status_code
            content = resp.content
            ctype = resp.headers.get("Content-Type", "")
            if status == 403 and referer:
                try:
                    self.http.get(referer)
                except Exception:
                    pass
                last = HttpError("http 403 for %s" % url)
                time.sleep(backoff)
                backoff *= 2
                continue
            if status < 200 or status >= 300:
                raise HttpError("http %d for %s" % (status, url))
            return decode_bytes(content, ctype)
        if last is not None:
            raise last
        raise HttpError("request failed: %s" % url)

    def _get_json(self, url, referer):
        text = self._request_text(
            url, referer, "application/json, text/plain, */*", attempts=3)
        return json.loads(text.lstrip("\ufeff"))

    def _get_html(self, url, referer):
        return self._request_text(
            url, referer,
            "text/html,application/xhtml+xml,application/xml;q=0.9,"
            "image/avif,image/webp,*/*;q=0.8", attempts=4)

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("fanqienovel book id is required")
        page_url = "https://fanqienovel.com/page/%s" % book_id
        markup = self._get_html(page_url, "")
        state = _extract_initial_state(markup)
        page = state.get("page")
        if not isinstance(page, dict):
            raise ValueError("fanqienovel page state not found")
        book = {
            "site": self.key, "id": book_id,
            "title": _str_value(page.get("bookName")),
            "author": (_str_value(page.get("authorName"))
                       or _str_value(page.get("author"))),
            "description": (_str_value(page.get("abstract"))
                            or _str_value(page.get("description"))),
            "source_url": page_url,
            "cover_url": (_str_value(page.get("thumbUrl"))
                          or _str_value(page.get("thumbUri"))),
        }
        dir_body = self._get_json(
            "https://fanqienovel.com/api/reader/directory/detail?bookId=" + book_id,
            page_url)
        chapters = self._parse_directory(dir_body)
        book["chapters"] = apply_chapter_range(chapters)
        return book

    def _parse_directory(self, body):
        if not isinstance(body, dict):
            raise ValueError("fanqienovel directory api: invalid payload")
        if body.get("code") != 0:
            raise ValueError("fanqienovel directory api: %s"
                             % _str_value(body.get("message")))
        data = body.get("data")
        if not isinstance(data, dict):
            raise ValueError("fanqienovel directory api: empty data")
        volume_names = data.get("volumeNameList") or []
        groups = data.get("chapterListWithVolume") or []
        chapters = []
        for vol_idx, group in enumerate(groups):
            volume_name = "第%d卷" % (vol_idx + 1)
            if vol_idx < len(volume_names) and _str_value(volume_names[vol_idx]):
                volume_name = _str_value(volume_names[vol_idx])
            for item in (group or []):
                if not isinstance(item, dict):
                    continue
                item_id = _str_value(item.get("itemId"))
                if not item_id:
                    continue
                chapters.append({
                    "id": item_id, "title": _str_value(item.get("title")),
                    "url": "https://fanqienovel.com/reader/%s" % item_id,
                    "volume": volume_name,
                    "order": _fanqie_chapter_number(item.get("realChapterOrder")),
                })
        indexed = list(enumerate(chapters))

        def compare(a, b):
            i, ca = a
            j, cb = b
            oi = ca["order"]
            oj = cb["order"]
            if oi == 0 or oj == 0:
                return -1 if i < j else (1 if i > j else 0)
            if oi < oj:
                return -1
            if oi > oj:
                return 1
            return 0

        indexed.sort(key=functools.cmp_to_key(compare))
        return [ch for _i, ch in indexed]

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        chapter = dict(chapter or {})
        chapter_id = (chapter.get("id") or "").strip()
        if not chapter_id:
            raise ValueError("fanqienovel chapter id is required")
        payload = self._get_json(CHAPTER_API + "?item_id=" + quote(chapter_id), "")
        if not isinstance(payload, dict):
            raise ValueError("fanqienovel chapter api: invalid payload")
        if payload.get("code") != 200:
            raise ValueError("fanqienovel chapter api: %s"
                             % _str_value(payload.get("message")))
        data = payload.get("data")
        raw_content = _str_value(data.get("content")) if isinstance(data, dict) else ""
        if not raw_content.strip():
            raise ValueError("fanqienovel chapter content not found")
        doc = parse_html(raw_content)
        paragraphs = []
        for p in doc.find_all("p"):
            text = VOICE_MARKER_RE.sub("", node_text(p)).strip()
            if text:
                paragraphs.append(text)
        if not paragraphs:
            raise ValueError("fanqienovel parsed paragraph content is empty")
        chapter["content"] = "\n".join(paragraphs)
        chapter["downloaded"] = True
        return chapter

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            raise ValueError("fanqienovel search keyword is empty")
        if limit <= 0:
            limit = 10
        results = []
        seen = set()
        page_size = 10
        max_pages = 12
        page = 1
        while page <= max_pages and len(results) < limit:
            offset = (page - 1) * page_size
            endpoint = (SEARCH_URL + "?key=" + quote(keyword)
                        + "&offset=" + str(offset))
            try:
                payload = self._get_json(endpoint, "")
            except Exception:
                if results:
                    break
                raise
            if not isinstance(payload, dict):
                if results:
                    break
                raise ValueError("fanqienovel search api: invalid payload")
            if int(payload.get("code") or 0) != 200:
                if results:
                    break
                raise ValueError("fanqienovel search api: %s"
                                 % _str_value(payload.get("message")))
            data = payload.get("data")
            if not isinstance(data, dict):
                break
            before = len(results)
            has_more = False
            for tab_raw in (data.get("search_tabs") or []):
                if not isinstance(tab_raw, dict):
                    continue
                tab_data = tab_raw.get("data")
                if not isinstance(tab_data, list) or not tab_data:
                    continue
                if isinstance(tab_raw.get("has_more"), bool):
                    has_more = tab_raw.get("has_more")
                for item_raw in tab_data:
                    if not isinstance(item_raw, dict):
                        continue
                    books = item_raw.get("book_data")
                    if not isinstance(books, list) or not books:
                        continue
                    book = books[0]
                    if not isinstance(book, dict):
                        continue
                    book_id = _str_value(book.get("book_id"))
                    title = _str_value(book.get("book_name")) or _str_value(book.get("raw_book_name"))
                    if not book_id or not title or book_id in seen:
                        continue
                    seen.add(book_id)
                    description = (_str_value(book.get("abstract"))
                                   or _str_value(book.get("book_abstract_v2")))
                    cover = (_str_value(book.get("thumb_url"))
                             or _str_value(book.get("horiz_thumb_url")))
                    results.append({
                        "site": self.key, "book_id": book_id, "title": title,
                        "author": _str_value(book.get("author")),
                        "description": description,
                        "url": "https://fanqienovel.com/page/%s" % book_id,
                        "latest_chapter": _str_value(book.get("last_chapter_title")),
                        "cover_url": cover,
                    })
                    if len(results) >= limit:
                        return results
                break
            if len(results) == before or not has_more:
                break
            page += 1
        return results