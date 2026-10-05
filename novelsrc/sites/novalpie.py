# -*- coding: utf-8 -*-
"""Novalpie（novalpie.cc / novalpie.jp / novalpia.cc）
由 go-novel-dl internal/site/novalpie.go 移植。

本机 403 不可达，未能实测；逻辑逐行对照 Go 版。AES-GCM 解密使用 PyCryptodome。
textconv.ToSimplified / NormalizeBookLocale 在 Go 里依赖 OpenCC 数据，缺失时为原样
返回；Python 侧无 opencc，统一按原样返回（英文站点影响极小）。
Loshop & Cpt
"""
import base64
import hashlib
import hmac
import json
import random
import re
import threading
import time
from urllib.parse import quote, unquote, urlencode, urlsplit

from bs4 import Comment, NavigableString
from Crypto.Cipher import AES

from ..base import Site, apply_chapter_range, register
from ..htmlutil import absolutize, clean_text, node_text, parse_html
from ..http import decode_bytes


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


NOVEL_RE = re.compile(r"^/(?:novel|book|works|work|novels)/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/book/(\d+)/(\d+)/?$")
VIEWER_RE = re.compile(r"^/viewer/(\d+)/?$")
API_CHAPTER_RE = re.compile(r"^/api/chapters/(\d+)/content/?$")

DEFAULT_BASE = "https://novalpie.cc"
IMAGE_BASE = "https://novalpie.cc"
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36")

SEARCH_PAGE_SIZE = 60
SEARCH_MAX_PAGES = 20

_CONSTS = [
    "X9f2m8Q5zL1p4R7t",
    "0Y3u6W2s5V8x1B4n",
    "7M0k3J6h9G2d5F8c",
    "1A4b7E0r3T6y9U2i",
    "M9N8B7V6C5X4Z3L2K1J0HGFDSAPOIUYTREWQmnbvcxzlkjhgfdsaqwertyuiop+/",
]

_PAGE_KEYS = (
    "total", "total_count", "totalCount", "count", "page", "current_page",
    "currentPage", "per_page", "perPage", "limit", "page_size", "pageSize",
    "total_pages", "totalPages", "last_page", "lastPage", "next_page", "nextPage",
)


def _parse_url(raw):
    raw = (raw or "").strip()
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "https://" + raw
    return urlsplit(raw)


def _compact(value):
    return " ".join((value or "").split())


def _clean_text_multi(value):
    if not value:
        return ""
    value = value.replace("\xa0", " ").replace("\r", "")
    lines = []
    for line in value.split("\n"):
        line = " ".join(line.split())
        if line:
            lines.append(line)
    return "\n".join(lines)


def _fallback(value, other):
    value = (value or "").strip()
    if value:
        return value
    return (other or "").strip()


def _first_non_empty(*values):
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _first_positive(*values):
    for value in values:
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return 0


def _decode_const(index):
    if 0 <= index < len(_CONSTS):
        return _CONSTS[index]
    return ""


def _q1():
    return (_decode_const(0) + _decode_const(1) + _decode_const(2)
            + _decode_const(3))


def _md5_hex(value):
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def _sha256_hex(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _rotated_timestamp_hex(timestamp):
    try:
        value = int(str(timestamp).strip())
    except (TypeError, ValueError):
        value = 0
    if value < 0 or value > 0xffffffff:
        value = 0
    rotated = ((value << 3) | (value >> 29)) & 0xffffffff
    return format(rotated, "x")


def _custom_base64(data):
    alphabet = _decode_const(4)
    if len(alphabet) < 64:
        return base64.b64encode(data).decode("ascii")
    out = []
    for i in range(0, len(data), 3):
        remain = len(data) - i
        b0 = data[i]
        b1 = data[i + 1] if remain > 1 else 0
        b2 = data[i + 2] if remain > 2 else 0
        combined = (b0 << 16) | (b1 << 8) | b2
        out.append(alphabet[(combined >> 18) & 0x3F])
        out.append(alphabet[(combined >> 12) & 0x3F])
        out.append(alphabet[(combined >> 6) & 0x3F] if remain > 1 else "=")
        out.append(alphabet[combined & 0x3F] if remain > 2 else "=")
    return "".join(out)


def _b64_decode(value):
    value = (value or "").strip()
    if not value:
        raise ValueError("empty base64 value")
    normalized = value.replace("-", "+").replace("_", "/")
    normalized = normalized + "=" * (-len(normalized) % 4)
    return base64.b64decode(normalized)


def _strip_bearer(value):
    value = (value or "").strip()
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return value


def _bearer_token(value):
    value = (value or "").strip()
    if not value:
        return ""
    lowered = value.lower()
    if lowered.startswith("bearer "):
        return _strip_bearer(value)
    if lowered.startswith("authorization:"):
        return _strip_bearer(value[len("authorization:"):].strip())
    for part in value.split(";"):
        part = part.strip()
        if not part:
            continue
        if part.lower().startswith("bearer "):
            return _strip_bearer(part)
        if "=" not in part:
            continue
        key, _, raw_value = part.partition("=")
        key = key.strip().lower()
        raw_value = unquote(raw_value.strip())
        if key in ("authorization", "token", "access_token", "jwt", "bearer"):
            return _strip_bearer(raw_value)
    if value.count(".") == 2:
        return value
    return ""


def _stringify_data(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and isinstance(value.get("content"), str):
        return value["content"]
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def _extract_plain_content(text):
    text = (text or "").strip()
    if not text:
        return ""
    try:
        parsed = json.loads(text)
    except ValueError:
        return text
    content = _stringify_data(parsed)
    if content and content != text:
        return content
    return text


def _random_nonce(n):
    if n <= 0:
        n = 8
    letters = "abcdefghijklmnopqrstuvwxyz0123456789"
    rng = random.SystemRandom()
    return "".join(rng.choice(letters) for _ in range(n))


# ---------------------------------------------------------------------------
# 正文 HTML -> 段落文本（对齐 collectNovalpieParagraphs）
# ---------------------------------------------------------------------------
def _has_block_child(node):
    for child in getattr(node, "children", []):
        if getattr(child, "name", None) in ("p", "div", "section", "article",
                                            "blockquote", "li"):
            return True
    return False


def _first_non_empty_attr(node, *keys):
    for key in keys:
        value = (node.get(key) or "").strip()
        if value:
            return value
    return ""


def _first_url_from_srcset(value):
    value = (value or "").strip()
    if not value:
        return ""
    first = value.split(",", 1)[0].strip()
    parts = first.split()
    return parts[0] if parts else ""


def _image_url(node):
    src = _first_non_empty_attr(node, "data-original", "data-src",
                                "data-lazy-src", "data-echo", "src")
    if not src:
        src = _first_url_from_srcset(
            _first_non_empty_attr(node, "srcset", "data-srcset"))
    return absolutize(IMAGE_BASE, src)


def _image_placeholder(raw_url):
    raw_url = (raw_url or "").strip()
    if not raw_url:
        return "[图片]"
    return "[图片] " + raw_url


def _append_text(out, raw):
    for line in _clean_text_multi(raw).split("\n"):
        line = line.strip()
        if line:
            out.append(line)


def _collect_inline(node, out):
    parts = []

    def flush():
        if parts:
            _append_text(out, "".join(parts))
            del parts[:]

    def walk(current):
        if current is None:
            return
        if isinstance(current, Comment):
            return
        if isinstance(current, NavigableString):
            parts.append(str(current))
            return
        name = current.name
        if name in ("head", "script", "style"):
            return
        if name == "br":
            parts.append("\n")
            return
        if name == "img":
            flush()
            src = _image_url(current)
            if src:
                out.append(_image_placeholder(src))
            return
        for child in current.children:
            walk(child)

    walk(node)
    flush()


def _collect_paragraphs(node, out):
    if node is None:
        return
    if isinstance(node, Comment):
        return
    if isinstance(node, NavigableString):
        _append_text(out, str(node))
        return
    name = node.name
    if name in ("head", "script", "style"):
        return
    if name == "img":
        src = _image_url(node)
        if src:
            out.append(_image_placeholder(src))
        return
    if name in ("p", "div", "section", "article", "blockquote", "li"):
        if _has_block_child(node):
            for child in node.children:
                _collect_paragraphs(child, out)
            return
        _collect_inline(node, out)
        return
    for child in node.children:
        _collect_paragraphs(child, out)


def _normalize_chapter_text(text):
    text = (text or "").strip()
    if not text or "<" not in text or ">" not in text:
        return text
    doc = parse_html(text)
    body = find_first(doc, "body")
    if body is None:
        body = doc
    paragraphs = []
    _collect_paragraphs(body, paragraphs)
    if paragraphs:
        return "\n".join(paragraphs)
    lines = [line for line in (clean_text(node_text(body)) or "").split("\n") if line]
    return "\n".join(lines) if lines else text


@register
class NovalpieSite(Site):
    key = "novalpie"
    display_name = "Novalpie"
    tags = ["英文", "原创", "免费", "轻小说", "成人向", "NSFW"]
    hosts = ["novalpie.cc", "novalpie.jp", "novalpia.cc"]
    login_required = True

    def __init__(self, cfg=None):
        Site.__init__(self, cfg)
        self.token = ""
        self.session = None
        self._session_lock = threading.Lock()
        self.base_url = DEFAULT_BASE
        mirrors = self.cfg.get("mirror_hosts") or self.cfg.get("mirrorHosts") or []
        if isinstance(mirrors, str):
            mirrors = [mirrors]
        if mirrors:
            base = str(mirrors[0]).strip().rstrip("/")
            if base:
                self.base_url = base

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        parsed = _parse_url(raw_url)
        if not self._accepts_host(parsed.hostname or ""):
            return None
        path = parsed.path
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "chapter_id": m.group(2),
                    "canonical": self.base_url + path}
        m = VIEWER_RE.match(path)
        if m:
            return {"site": self.key, "chapter_id": m.group(1),
                    "canonical": self.base_url + path}
        m = API_CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "chapter_id": m.group(1),
                    "canonical": self.base_url + path}
        m = NOVEL_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": self.novel_url(m.group(1))}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        self._ensure_login()
        detail = self._get_novel_detail(book_id)
        chapters_resp = self._get_novel_chapters(book_id)

        entries = chapters_resp.get("data") or chapters_resp.get("results") or []
        chapters = []
        for item in entries:
            if not isinstance(item, dict):
                continue
            number = item.get("chapterNumber")
            if not number:
                number = item.get("chapter_number")
            cid = str(item.get("id"))
            chapters.append({
                "id": cid, "title": item.get("title") or "",
                "url": self.chapter_url(book_id, cid),
                "order": number if number else 0, "volume": "正文",
            })
        return {
            "site": self.key, "id": book_id,
            "title": _first_non_empty(detail.get("title"), detail.get("true_name"),
                                      detail.get("trueName")),
            "author": _fallback(detail.get("author_name"), detail.get("authorName")),
            "description": detail.get("description") or "",
            "source_url": self.novel_url(book_id),
            "cover_url": _fallback(detail.get("photo_url"), detail.get("photoUrl")),
            "chapters": apply_chapter_range(chapters),
        }

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        self._ensure_login()
        chapter_id = self._resolve_chapter_id(chapter)
        if not chapter_id:
            raise ValueError("novalpie chapter id is required")
        session = self._get_reader_session()
        payload = self._get_chapter_content(chapter_id, session["session_id"])
        text = self._decode_chapter_payload(payload, session["session_key"])

        result = dict(chapter)
        if payload.get("title"):
            result["title"] = payload["title"]
        result["id"] = chapter_id
        result["content"] = _normalize_chapter_text(text)
        result["downloaded"] = True
        return result

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        if self._has_auth_config():
            self._ensure_login()

        results = []
        seen = set()
        for page in range(1, SEARCH_MAX_PAGES + 1):
            payload, items = self._search_page(keyword, page, SEARCH_PAGE_SIZE)
            if not items:
                if page == 1 and not payload.get("success"):
                    raise ValueError(payload.get("message") or "novalpie search failed")
                break
            before = len(results)
            for item in items:
                key = self._search_item_key(item)
                if key in seen:
                    continue
                seen.add(key)
                results.append(self._search_result(item))
                if limit > 0 and len(results) >= limit:
                    return results
            if len(results) == before:
                break
            if not _has_page_info(payload) and len(items) < SEARCH_PAGE_SIZE:
                break
            if not _search_has_next(payload, page, len(results)):
                break
        return results

    def _search_page(self, keyword, page, page_size):
        params = {
            "q": keyword, "page": str(page), "limit": str(page_size),
            "scope": "all", "match_type": "fuzzy_strict", "sort_by": "relevance",
            "sort_order": "desc", "adult_filter": "all",
            "max_word_count": "10000000",
        }
        url = self.api_url("/api/search") + "?" + urlencode(params)
        body = self._json_get(url, auth=self.token != "")
        try:
            payload = json.loads(body)
        except ValueError:
            raise ValueError("novalpie search response is not JSON")
        items = _payload_items(payload)
        if not payload.get("success") and not items and payload.get("message"):
            raise ValueError(payload["message"])
        return payload, items

    def _search_result(self, item):
        book_id = str(item.get("id"))
        return {
            "site": self.key, "book_id": book_id,
            "title": _first_non_empty(item.get("title"), item.get("true_name"),
                                      item.get("trueName")),
            "author": _fallback(item.get("author_name"), item.get("authorName")),
            "description": item.get("description") or "",
            "url": self.novel_url(book_id),
            "cover_url": _fallback(item.get("photo_url"), item.get("photoUrl")),
        }

    @staticmethod
    def _search_item_key(item):
        if item.get("id"):
            return str(item.get("id"))
        title = _first_non_empty(item.get("title"), item.get("true_name"),
                                 item.get("trueName"))
        author = _fallback(item.get("author_name"), item.get("authorName"))
        return title + "\x00" + author

    # ------------------------------------------------------------------
    def _ensure_login(self):
        if self.token:
            return
        token = _bearer_token(self.cfg.get("cookie"))
        if token:
            self.token = token
            return
        username = (self.cfg.get("username") or "").strip()
        if not username:
            username = (self.cfg.get("email") or "").strip()
        password = (self.cfg.get("password") or "")
        if not username or not password.strip():
            raise ValueError("novalpie login requires Bearer token in cookie config "
                             "or email/username and password")
        body = {"username": username, "password": password}
        response_body = self._json_post(self.api_url("/api/sessions"), body, auth=False)
        try:
            login = json.loads(response_body)
        except ValueError:
            raise ValueError("novalpie login response is not JSON")
        data = login.get("data") or {}
        token = _first_non_empty(login.get("token"), login.get("access_token"),
                                 data.get("token"), data.get("access_token"))
        if not login.get("success") or not token:
            raise ValueError(login.get("message") or "novalpie login failed")
        self.token = _strip_bearer(token)

    def _get_novel_detail(self, book_id):
        body = self._json_get(self.api_url("/api/novels/%s/detail" % book_id), auth=True)
        try:
            detail = json.loads(body)
        except ValueError:
            raise ValueError("novalpie novel detail response is not JSON")
        if not detail.get("success") and not detail.get("id") and not detail.get("title"):
            raise ValueError(detail.get("message") or "novalpie novel detail failed")
        return detail

    def _get_novel_chapters(self, book_id):
        body = self._json_get(self.api_url("/api/novels/%s/chapters" % book_id), auth=True)
        try:
            out = json.loads(body)
        except ValueError:
            raise ValueError("novalpie chapters response is not JSON")
        if not out.get("success") and not out.get("data") and not out.get("results"):
            raise ValueError(out.get("message") or "novalpie chapters failed")
        return out

    def _get_reader_session(self):
        with self._session_lock:
            session = self.session
            if session and time.time() < (session.get("expires") or 0) - 30:
                return session
            nonce = _random_nonce(8)
            timestamp = str(int(time.time()))
            headers = self._build_reader_headers(nonce, timestamp)
            body = self._json_get(self.api_url("/api/reader/session-key"),
                                  headers=headers)
            try:
                session = json.loads(body)
            except ValueError:
                raise ValueError("novalpie session-key response is not JSON")
            session_id = session.get("session_id") or session.get("sessionId")
            session_key = session.get("session_key") or session.get("sessionKey")
            if not session.get("success") or not session_id or not session_key:
                raise ValueError("novalpie session-key response incomplete: " + body)
            session["session_id"] = session_id
            session["session_key"] = session_key
            self.session = session
            return session

    def _get_chapter_content(self, chapter_id, session_id):
        include_picture = bool(self.cfg.get("include_picture")
                               or self.cfg.get("includePicture"))
        params = {
            "session": session_id, "replace_mode": "india",
            "show_images": "1" if include_picture else "0",
        }
        url = self.api_url("/api/chapters/%s/content" % chapter_id) + "?" + urlencode(params)
        body = self._json_get(url, auth=True, extra={"Accept": "*/*"})
        try:
            payload = json.loads(body)
        except ValueError:
            raise ValueError("novalpie chapter content response is not JSON")
        if (not payload.get("success") and not payload.get("content")
                and payload.get("data") is None):
            raise ValueError(payload.get("message") or "novalpie chapter content failed")
        return payload

    def _decode_chapter_payload(self, payload, session_key):
        if payload is None:
            raise ValueError("novalpie payload is nil")
        if not payload.get("encrypted"):
            content = payload.get("content")
            if content:
                return content
            if payload.get("data") is not None:
                return _stringify_data(payload["data"])
            raise ValueError("novalpie chapter payload is empty")
        key = hashlib.sha256(_b64_decode(session_key)).digest()
        iv = _b64_decode(payload.get("iv") or "")
        content = _b64_decode(payload.get("content") or "")
        tag = _b64_decode(payload.get("tag") or "")
        if not tag:
            raise ValueError("novalpie chapter tag is empty")
        try:
            cipher = AES.new(key, AES.MODE_GCM, nonce=iv, mac_len=len(tag))
            plain = cipher.decrypt_and_verify(content, tag)
        except Exception as exc:
            raise ValueError("novalpie decrypt failed: %s" % exc)
        return _extract_plain_content(plain.decode("utf-8", "replace"))

    # ------------------------------------------------------------------
    def _build_reader_headers(self, nonce, timestamp):
        signature = self._build_client_signature(BROWSER_UA, timestamp, nonce)
        return self._json_headers(True, {
            "User-Agent": BROWSER_UA,
            "Authorization": "Bearer " + self.token,
            "X-Client-Nonce": nonce,
            "X-Client-Timestamp": timestamp,
            "X-Client-Signature": signature,
        }, reader=True)

    def _json_headers(self, auth, extra=None, reader=False):
        base = self.base_url.rstrip("/")
        headers = {
            "User-Agent": BROWSER_UA,
            "Accept": "application/json",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Content-Type": "application/json",
            "Origin": base,
            "Referer": base + "/",
            "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
        }
        if auth and self.token:
            headers["Authorization"] = "Bearer " + self.token
        if extra:
            headers.update(extra)
        return headers

    def _build_client_signature(self, user_agent, timestamp, nonce):
        first = _md5_hex(user_agent + timestamp + nonce)
        rotated = _rotated_timestamp_hex(timestamp)
        body = _sha256_hex(first + _q1() + rotated)
        key = _md5_hex(_q1())
        mac = hmac.new(key.encode("utf-8"), body.encode("utf-8"), hashlib.sha1)
        return _custom_base64(mac.digest())

    def _json_get(self, url, auth=True, extra=None, headers=None):
        if headers is None:
            headers = self._json_headers(auth, extra)
        return self.http.get(url, headers=headers)

    def _json_post(self, url, body, auth=True, extra=None):
        headers = self._json_headers(auth, extra)
        resp = self.http.request("POST", url, headers=headers, json_body=body)
        return decode_bytes(resp.content, resp.headers.get("Content-Type", ""))

    # ------------------------------------------------------------------
    def _accepts_host(self, host):
        host = (host or "").strip().lower()
        if host.startswith("www."):
            host = host[4:]
        if host in ("novalpie.cc", "novalpie.jp", "novalpia.cc"):
            return True
        base_host = (_parse_url(self.base_url).hostname or "").lower()
        if base_host.startswith("www."):
            base_host = base_host[4:]
        return host == base_host

    def _api_url(self, path):
        return self.base_url.rstrip("/") + path

    api_url = _api_url

    def novel_url(self, book_id):
        return self._api_url("/book/" + str(book_id).strip())

    def chapter_url(self, book_id, chapter_id):
        return (self._api_url("/book/" + str(book_id).strip() + "/"
                              + str(chapter_id).strip()))

    def _has_auth_config(self):
        if self.token or _bearer_token(self.cfg.get("cookie")):
            return True
        username = (self.cfg.get("username") or "").strip()
        if not username:
            username = (self.cfg.get("email") or "").strip()
        return bool(username and (self.cfg.get("password") or "").strip())

    def _resolve_chapter_id(self, chapter):
        chapter_id = (chapter.get("id") or "").strip()
        if chapter_id:
            return chapter_id
        raw_url = (chapter.get("url") or "").strip()
        if raw_url:
            resolved = self.resolve_url(raw_url)
            if resolved and resolved.get("chapter_id"):
                return resolved["chapter_id"]
        return ""


# ---------------------------------------------------------------------------
# 分页与 payload 解析（对齐 Go 的大小写/嵌套兜底）
# ---------------------------------------------------------------------------
def _payload_items(payload):
    if payload.get("results"):
        return payload["results"]
    if payload.get("items"):
        return payload["items"]
    if payload.get("novels"):
        return payload["novels"]
    data = payload.get("data")
    if data is None:
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("results", "items", "novels", "data"):
            if data.get(key):
                return data[key]
    return []


def _page_info(payload):
    info = {}
    for key in _PAGE_KEYS:
        info[key] = payload.get(key)
    info["has_more"] = payload.get("has_more")
    info["hasMore"] = payload.get("hasMore")
    info = _merge_page(info, payload.get("pagination") or {})
    info = _merge_page(info, payload.get("meta") or {})
    data = payload.get("data")
    if isinstance(data, dict):
        info = _merge_page(info, data)
        info = _merge_page(info, data.get("pagination") or {})
        info = _merge_page(info, data.get("meta") or {})
    return info


def _merge_page(base, next_page):
    if not isinstance(next_page, dict):
        return base
    for key in _PAGE_KEYS:
        if not base.get(key):
            base[key] = next_page.get(key)
    if base.get("has_more") is None:
        base["has_more"] = next_page.get("has_more")
    if base.get("hasMore") is None:
        base["hasMore"] = next_page.get("hasMore")
    return base


def _has_page_info(payload):
    info = _page_info(payload)
    if info.get("has_more") is not None or info.get("hasMore") is not None:
        return True
    if _first_positive(info.get("next_page"), info.get("nextPage")) > 0:
        return True
    if _first_positive(info.get("total_pages"), info.get("totalPages"),
                       info.get("last_page"), info.get("lastPage")) > 0:
        return True
    if _first_positive(info.get("total"), info.get("total_count"),
                       info.get("totalCount"), info.get("count")) > 0:
        return True
    return False


def _search_has_next(payload, page, count):
    info = _page_info(payload)
    if info.get("has_more") is not None:
        return bool(info["has_more"])
    if info.get("hasMore") is not None:
        return bool(info["hasMore"])
    next_page = _first_positive(info.get("next_page"), info.get("nextPage"))
    if next_page > 0:
        return next_page > page
    pages = _first_positive(info.get("total_pages"), info.get("totalPages"),
                            info.get("last_page"), info.get("lastPage"))
    if pages > 0:
        return page < pages
    total = _first_positive(info.get("total"), info.get("total_count"),
                            info.get("totalCount"), info.get("count"))
    if total > 0:
        return count < total
    return True