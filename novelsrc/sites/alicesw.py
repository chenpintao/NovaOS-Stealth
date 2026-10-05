# -*- coding: utf-8 -*-
"""爱丽丝书屋（alicesw1.homes）—— 由 go-novel-dl internal/site/alicesw.go 移植。
本机超时不可达，未实测；加密章节依赖 cryptography（RSA-OAEP 私钥 + AES-CBC）。
"""
import base64
import hashlib
import re
import threading
import time
from urllib.parse import urlencode, urlsplit

from bs4 import NavigableString, Tag

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_first,
                        has_ancestor_class, has_ancestor_id, has_ancestor_tag,
                        normalize_path, parse_html)

BASE = "https://www.alicesw1.homes"

BOOK_RE = re.compile(r"^/novel/(\d+)\.html$")
CATALOG_RE = re.compile(r"^/other/chapters/id/(\d+)\.html$")
CHAPTER_RE = re.compile(r"^/book/(\d+)/([^/.]+)\.html$")
SEARCH_RANK_RE = re.compile(r"^\d+\.\s*")
BOOK_ID_JSON_RE = re.compile(r'"Id"\s*:\s*(\d+)')
BOOK_ID_DATA_RE = re.compile(r"/novel/(\d+)\.html")
SOURCE_ID_RE = re.compile(r"source_id:\s*(\d+)")
CHAPTER_ID_RE = re.compile(r"chapter_id:\s*['\"]([^'\"]+)['\"]")
INITIAL_TIME_RE = re.compile(r"\bt:\s*['\"]([^'\"]+)['\"]")
SIGN_RE = re.compile(r"sign:\s*['\"]([^'\"]+)['\"]")
HOST_RE = re.compile(r"^alicesw(\d+)?\.(?:com|homes)$")

TOKEN_PREFIX = "B3wlP9Tzo$0RIdlvX&^sg30^0&feAox%"
TOKEN_SUFFIX = "Rs4qM7mGrQ6aTMr8HHvv3WikTcY&kW8R"

PRIVATE_KEY_PEM = """-----BEGIN RSA PRIVATE KEY-----
MIIEogIBAAKCAQEAnOUiABBEw9zzOqivp4uJxTd3D5Givmwx2i+JLVdyj9iO2S1E
crWOaO5k6lD4fbL0MnMH+luJhO3ySm1xDZy22ruzvPHhd+Sh3nH56+hOcj1jfpBx
lDPlwyo2nDshY0VFr/3fonFjepp5PP+eZKYt9YWtxrVMWOc0yNH6HuRA+zwUX28W
RlP/4vMWi6vEYt0XLt+lTBGqyvwxPYJBYivIehGz4exC7K1bpvX8LJWVARkvEIuf
Y3sQHtC/BTeYoEsipfZYafTgQHJ+KAOZSq/CET0USeTt+Evfn6YcbWX577DrRyGt
siJjojMEG5TKdDQWmGKTQb4E2+EpTrQYaCcaowIDAQABAoIBAC8L9noWZshkxPre
Am43RYTB8Q3WGfsH7psCjhvukQfZZFxzWocbMiz8733j8d+ffeJy4/2K3V3jDDiN
QM1YJOzKREdwMLAG+xL9EnhPHNbc2azmG2jZdxhi3CVVBdoCt7biZeEMJ0xobdqA
vDpqKnXpNAbV7qLqEcX2UQ5aW7H6BdCgGk9HRBKXs/ll65NZmxORXLoAVg+w7Vzi
XaLP6+43KNXUPLz0EPndDH9VkGlMcyu6q7pWLoz6eN0fNiP4Jfl9PbV4KFlye2xo
4FI+Go8luM0onDL1+bKE5RJHXqfS+ow9hYzBJSz39jyNpiH7j8Hg8mMDPm0VIYtM
sOF/RgECgYEAzuuziQzrT74ZW27AQqMFQFLvqMmnrhR4CPg0mRq/PMHSzh+Bs+nS
Gib2d1ulkKIDHPOG9EWKXBOUvHOBmGro+sOS9fnfoJYeNhLmX5K1xcDJpsBOMdZv
euEit2i7yy+KAc26fP+SoCQEHm1mlgZG1vcfJlPDofqwRyBeKHPAkGMCgYEAwhvb
Fw3udE0hws92+9GYmjES8jNauBaP3hlu3lmxcnjlVqlkHbc9PkvddmCsSB/5TUCH
7qJRgYLo+uov40zNNavXv8cTqWvDrJxTuDFn0OSjeIvqS9kXeVHjpBP6d4CCLAZM
b6owfM8JtBFx9ef9ll5mwBekZDrspEXOgoCQwMECgYBujaILvFpQ7alQn5ibQcxB
dM5VKQCs0oTbjflUP+UjCg+eT1kWDfxSOrT+SnnoD5eINVjKVAk7br7N/QylqaE2
sZ1oTIu9mdckXu6064aw1HMo46AjooVHatgIlC2ZvpmGoytbM5VceEG3HA5uY4Yf
vkLnUGO6vFzIc7O6+zVMLwKBgFmIab0vkt6YOUtXUIWEvwPYQOnwoBaraX7Dcm0j
KAMqGnanuWMvgxM6ARO6MZ0vCloEuu5qdnfrfzVFUgNhCIKKGgD+fWY3K9FxZfhe
6Yjj/Tb8Kn0DzJ0MFZk4Ed6PKvvNh/I1qRnYkZw6M7t+X2y9bF2MSiplN4PqIv/0
90/BAoGAQXzOzA3q+vcA9mwKvwXrPiSscmZMekV6RBUxf1riRzTnds9uWSTKz8QM
LpEoNB3tKSB+4raK6xJGJ914b+jc/B7ayHDksStOLeJLV6t5+bmoKjk6qBrUjTQX
y8x2rsHReaJw0SbZy+4x55nYTi/0mdzomR7N27EzYtzM7iWk5w0=
-----END RSA PRIVATE KEY-----"""

_private_key_lock = threading.Lock()
_private_key_cache = [None]


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


def _clean_paragraphs(nodes):
    paragraphs = []
    for node in nodes:
        text = _clean_go(_node_text_lb(node))
        if text:
            paragraphs.append(text)
    return paragraphs


def _meta_property(doc, name):
    for node in find_all(doc, "meta"):
        if attr(node, "property") == name:
            content = attr(node, "content").strip()
            if content:
                return content
    return ""


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


def _first_sub(regex, value):
    m = regex.search(value or "")
    return m.group(1).strip() if m else ""


def _direct_children(node, tag):
    if node is None:
        return []
    return [child for child in node.find_all(recursive=False) if child.name == tag]


def _first_with_ancestor_class(nodes, class_name):
    for node in nodes:
        if has_ancestor_class(node, class_name):
            return node
    return None


# ---------------------------------------------------------------------------
# 加密章节
# ---------------------------------------------------------------------------
def _load_private_key():
    if _private_key_cache[0] is not None:
        return _private_key_cache[0]
    with _private_key_lock:
        if _private_key_cache[0] is not None:
            return _private_key_cache[0]
        from cryptography.hazmat.primitives import serialization
        key = serialization.load_pem_private_key(
            PRIVATE_KEY_PEM.encode("ascii"), password=None)
        _private_key_cache[0] = key
        return key


def _pkcs7_unpad(data, block_size):
    if not data or len(data) % block_size != 0:
        raise ValueError("invalid pkcs7 data length")
    padding = data[-1]
    if padding == 0 or padding > block_size or padding > len(data):
        raise ValueError("invalid pkcs7 padding")
    for value in data[len(data) - padding:]:
        if value != padding:
            raise ValueError("invalid pkcs7 padding")
    return data[:len(data) - padding]


def _decode_b64_or_raw(value):
    value = (value or "").strip()
    try:
        return base64.b64decode(value)
    except Exception:
        if value == "":
            raise
        return value.encode("utf-8")


def _decrypt_chapter(payload):
    content_encrypt = (payload.get("content_encrypt") or "").strip()
    if not content_encrypt:
        content = (payload.get("content") or "").strip()
        if content:
            return content
        raise ValueError("alicesw encrypted content is empty")

    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    private_key = _load_private_key()
    key_encrypt = base64.b64decode((payload.get("aes_key_encrypt") or "").strip())
    aes_key_encoded = private_key.decrypt(key_encrypt, padding.PKCS1v15())
    aes_key = _decode_b64_or_raw(aes_key_encoded.decode("utf-8", "ignore"))
    iv = _decode_b64_or_raw(payload.get("iv"))
    if len(iv) != 16:
        raise ValueError("alicesw encrypted chapter iv length is %d" % len(iv))
    ciphertext = base64.b64decode(content_encrypt)
    if not ciphertext or len(ciphertext) % 16 != 0:
        raise ValueError("alicesw encrypted chapter ciphertext has invalid length")
    decryptor = Cipher(algorithms.AES(aes_key), modes.CBC(iv)).decryptor()
    plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    plaintext = _pkcs7_unpad(plaintext, 16)
    return plaintext.decode("utf-8", "replace")


def _parse_decrypted_content(content):
    content = (content or "")
    for src, dst in (("\r\n", "\n"), ("\r", "\n"), ("<br>", "\n"),
                     ("<br/>", "\n"), ("<br />", "\n")):
        content = content.replace(src, dst)
    content = content.strip()
    if not content:
        return []
    if "<" in content and ">" in content:
        try:
            doc = parse_html(content)
            paragraphs = _clean_paragraphs(find_all(doc, "p"))
            if paragraphs:
                return paragraphs
            text = _clean_go(_node_text_lb(doc)).strip()
            if text:
                content = text
        except Exception:
            pass
    paragraphs = []
    for line in content.split("\n"):
        text = _clean_go(line)
        if text:
            paragraphs.append(text)
    return paragraphs


def _request_token(timestamp, source_id, chapter_id):
    raw = TOKEN_PREFIX + timestamp + source_id + chapter_id + TOKEN_SUFFIX
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _is_blocked_page(markup):
    return "访问异常" in markup and "请稍后再试" in markup


@register
class AliceswSite(Site):
    key = "alicesw"
    display_name = "爱丽丝书屋"
    tags = ["简体中文", "转载站", "成人向", "NSFW"]
    hosts = ["alicesw.com", "alicesw1.homes"]

    CHAPTER_MIN_INTERVAL = 3.0

    def __init__(self, cfg=None):
        Site.__init__(self, cfg)
        self._chapter_lock = threading.Lock()
        self._last_chapter_at = 0.0

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        parsed = _parse_url(raw_url)
        if parsed is None:
            return None
        host = _host_of(parsed)
        if not HOST_RE.match(host):
            return None
        path = parsed.path
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": BASE + path}
        m = CATALOG_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": BASE + path}
        m = CHAPTER_RE.match(path)
        if m:
            canonical = BASE + path
            book_id = self._resolve_chapter_book_id(canonical)
            if not book_id:
                return None
            return {"site": self.key, "book_id": book_id,
                    "chapter_id": m.group(1) + "-" + m.group(2),
                    "canonical": canonical}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        info_markup = self._get(self._book_url(book_id))
        info_doc = parse_html(info_markup)

        book = self._parse_book_detail(info_doc, book_id)
        chapters = _parse_catalog_chapters(info_doc, BASE)
        if not chapters:
            catalog_doc = parse_html(self._get(self._catalog_url(book_id)))
            chapters = _parse_catalog_chapters(catalog_doc, BASE)
        if not chapters:
            raise ValueError("alicesw chapter list not found")
        book["chapters"] = apply_chapter_range(chapters)
        return book

    def _parse_book_detail(self, doc, book_id):
        return {
            "site": self.key, "id": book_id,
            "title": _extract_book_title(doc),
            "author": _extract_book_author(doc),
            "description": _extract_book_summary(doc),
            "source_url": self._book_url(book_id),
            "cover_url": _extract_book_cover(doc, BASE),
        }

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        raw_url = (chapter.get("url") or "").strip()
        if not raw_url:
            raw_url = _chapter_url(BASE, chapter.get("id") or "")
        if not raw_url:
            raise ValueError("alicesw chapter url is empty")

        self._wait_chapter_slot()
        markup = self._get(raw_url)
        if _is_blocked_page(markup):
            raise ValueError("alicesw 章节页被风控拦截（访问异常），请放慢下载速度并稍后重试")

        title, paragraphs = _parse_chapter_page(markup)
        if title is None and paragraphs is None:
            try:
                encrypted = self._fetch_encrypted_chapter(raw_url, markup)
            except Exception:
                if not _extract_encrypted_initial(markup):
                    raise ValueError("alicesw chapter content not found")
                raise
            result = dict(chapter)
            if encrypted.get("title"):
                result["title"] = encrypted["title"]
            result["content"] = "\n".join(encrypted["paragraphs"])
            result["downloaded"] = True
            return result

        result = dict(chapter)
        if title:
            result["title"] = title
        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    def _fetch_encrypted_chapter(self, referer, markup):
        initial = _extract_encrypted_initial(markup)
        if not initial:
            raise ValueError("alicesw encrypted chapter metadata not found")
        payload = self._request_chapter_info(initial, referer)
        content = _decrypt_chapter(payload)
        paragraphs = _parse_decrypted_content(content)
        if not paragraphs:
            raise ValueError("alicesw encrypted chapter content not found")
        return {"title": clean_text(payload.get("title")), "paragraphs": paragraphs}

    def _request_chapter_info(self, initial, referer):
        self._wait_chapter_slot()
        params = {"id": initial["source_id"], "key": initial["chapter_id"],
                  "t": initial["timestamp"], "sign": initial["sign"]}
        raw_url = BASE.rstrip("/") + "/home/chapter/info?" + urlencode(params)
        timestamp = str(int(time.time()))
        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            "X-Requested-With": "XMLHttpRequest",
            "x-request-timestamp": timestamp,
            "x-request-token": _request_token(timestamp, initial["source_id"],
                                              initial["chapter_id"]),
        }
        if referer.strip():
            headers["Referer"] = referer
        resp = self.http.request("GET", raw_url, headers=headers)
        decoded = resp.json()
        if decoded.get("code") != 1:
            message = (decoded.get("msg") or "").strip()
            if message:
                raise ValueError("alicesw chapter api: %s" % message)
            raise ValueError("alicesw chapter api returned code %s" % decoded.get("code"))
        return (decoded.get("data") or {}).get("chapter") or {}

    def _wait_chapter_slot(self):
        interval = float(self.cfg.get("request_interval") or 0) if isinstance(self.cfg, dict) else 0.0
        if interval < self.CHAPTER_MIN_INTERVAL:
            interval = self.CHAPTER_MIN_INTERVAL
        with self._chapter_lock:
            wait = interval - (time.time() - self._last_chapter_at)
            if wait > 0:
                time.sleep(wait)
            self._last_chapter_at = time.time()

    def _resolve_chapter_book_id(self, raw_url):
        try:
            self._wait_chapter_slot()
            markup = self._get(raw_url)
        except Exception:
            return ""
        return _extract_book_id_from_chapter(markup)

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        target = limit if limit > 0 else 10
        results = []
        seen = set()
        page = 1
        while True:
            markup = self._get(self._search_page_url(keyword, page))
            page_results, has_next = _parse_search_results(markup)
            for item in page_results:
                book_id = item["book_id"]
                if book_id in seen:
                    continue
                seen.add(book_id)
                results.append(item)
                if len(results) >= target:
                    break
            if len(results) >= target or not has_next or not page_results:
                break
            page += 1
        results = results[:target]
        for item in results[:6]:
            self._populate_detail(item)
        return results

    def _populate_detail(self, item):
        book_id = (item.get("book_id") or "").strip()
        if not book_id:
            return
        try:
            doc = parse_html(self._get(self._book_url(book_id)))
        except Exception:
            return
        book = self._parse_book_detail(doc, book_id)
        if book["title"]:
            item["title"] = book["title"]
        if book["author"]:
            item["author"] = book["author"]
        if book["description"]:
            item["description"] = book["description"]
        if book["cover_url"]:
            item["cover_url"] = book["cover_url"]
        latest = _extract_latest_chapter(doc)
        if latest:
            item["latest_chapter"] = latest
        item["url"] = book["source_url"]

    # ------------------------------------------------------------------
    def _search_page_url(self, keyword, page):
        params = {"q": keyword, "f": "_all", "sort": "relevance"}
        if page > 1:
            params["p"] = str(page)
        return BASE + "/search.html?" + urlencode(params)

    def _book_url(self, book_id):
        return "%s/novel/%s.html" % (BASE, (book_id or "").strip())

    def _catalog_url(self, book_id):
        return "%s/other/chapters/id/%s.html" % (BASE, (book_id or "").strip())

    def _get(self, url):
        return self.http.get(url, headers={"Referer": BASE + "/"})


# ---------------------------------------------------------------------------
# 解析辅助
# ---------------------------------------------------------------------------
def _extract_encrypted_initial(markup):
    initial = {
        "source_id": _first_sub(SOURCE_ID_RE, markup),
        "chapter_id": _first_sub(CHAPTER_ID_RE, markup),
        "timestamp": _first_sub(INITIAL_TIME_RE, markup),
        "sign": _first_sub(SIGN_RE, markup),
    }
    if not (initial["source_id"] and initial["chapter_id"]
            and initial["timestamp"] and initial["sign"]):
        return None
    return initial


def _parse_search_results(markup):
    doc = parse_html(markup)
    results = []
    for row in find_all(doc, "div", "list-group-item"):
        title_link = _first_with_ancestor_tag(find_all(row, "a"), "h5")
        if title_link is None:
            continue
        m = BOOK_RE.match(normalize_path(attr(title_link, "href")))
        if not m:
            continue
        book_id = m.group(1)
        title = clean_text(_node_text_raw(title_link))
        title = SEARCH_RANK_RE.sub("", title)
        author = ""
        for a in find_all(row, "a"):
            if has_ancestor_class(a, "text-muted"):
                author = clean_text(_node_text_raw(a))
                break
        description = clean_text(_node_text_raw(find_first(row, "p", "content-txt")))
        results.append({
            "site": "alicesw", "book_id": book_id, "title": title,
            "author": author, "description": description,
            "url": BASE + "/novel/" + book_id + ".html",
        })
    has_next = False
    for a in find_all(doc, "a"):
        if "layui-laypage-next" in (attr(a, "class") or ""):
            has_next = True
            break
    return results, has_next


def _first_with_ancestor_tag(nodes, tag):
    for node in nodes:
        if has_ancestor_tag(node, tag):
            return node
    return None


def _parse_catalog_chapters(doc, base):
    chapters = []
    for a in find_all(doc, "a"):
        if not has_ancestor_class(a, "mulu_list"):
            continue
        href = attr(a, "href").strip()
        m = CHAPTER_RE.match(normalize_path(href))
        if not m:
            continue
        chapters.append({
            "id": m.group(1) + "-" + m.group(2),
            "title": clean_text(_node_text_raw(a)),
            "url": absolutize(base, href),
            "order": len(chapters) + 1,
        })
    return chapters


def _parse_chapter_page(markup):
    doc = parse_html(markup)
    title = clean_text(_node_text_raw(find_first(doc, "h3", "j_chapterName")))
    content = find_first(doc, "div", "read-content")
    paragraphs = _clean_paragraphs(find_all(content, "p"))
    if not paragraphs or _is_loading_placeholder(paragraphs):
        return None, None
    return title, paragraphs


def _is_loading_placeholder(paragraphs):
    if len(paragraphs) != 1:
        return False
    text = paragraphs[0].strip(".。…").strip()
    return text == "章节加载中" or text == "加载中"


def _extract_book_id_from_chapter(markup):
    doc = parse_html(markup)
    if doc is not None:
        body = find_first(doc, "body")
        if body is not None:
            m = BOOK_ID_DATA_RE.search(attr(body, "data-bid"))
            if m:
                return m.group(1)
        for a in find_all(doc, "a"):
            m = BOOK_RE.match(normalize_path(attr(a, "href")))
            if m:
                return m.group(1)
    m = BOOK_ID_JSON_RE.search(markup or "")
    return m.group(1) if m else ""


def _extract_book_title(doc):
    if doc is None:
        return ""
    node = find_first(doc, "div", "novel_title")
    if node is not None:
        return clean_text(_node_text_raw(node))
    h1 = _first_with_ancestor_id(find_all(doc, "h1"), "detail-box")
    return clean_text(_node_text_raw(h1))


def _first_with_ancestor_id(nodes, elem_id):
    for node in nodes:
        if has_ancestor_id(node, elem_id):
            return node
    return None


def _extract_book_author(doc):
    for p in find_all(doc, "p"):
        if not has_ancestor_class(p, "novel_info"):
            continue
        line = clean_text(_node_text_raw(p))
        if "作" not in line or "者" not in line:
            continue
        a = find_first(p, "a")
        if a is not None:
            author = clean_text(_node_text_raw(a))
            if author:
                return author
        for token in ("作 者：", "作 者:", "作者：", "作者:"):
            if line.startswith(token):
                line = line[len(token):]
        line = line.strip()
        if line:
            return line
    return ""


def _extract_book_summary(doc):
    if doc is None:
        return ""
    node = find_first(doc, "div", "jianjie")
    if node is not None:
        for p in _direct_children(node, "p"):
            text = clean_text(_node_text_raw(p))
            if text and "注意：" not in text:
                return text
    return _meta_property(doc, "og:description").strip()


def _extract_book_cover(doc, base):
    if doc is None:
        return ""
    node = find_first(doc, "img", "fengmian2")
    return absolutize(base, attr(node, "src"))


def _extract_latest_chapter(doc):
    for p in find_all(doc, "p"):
        if not has_ancestor_class(p, "novel_info"):
            continue
        line = clean_text(_node_text_raw(p))
        if "最" not in line or "新" not in line:
            continue
        a = find_first(p, "a")
        if a is not None:
            latest = clean_text(_node_text_raw(a))
            if latest:
                return latest
    a = _first_with_ancestor_class(find_all(doc, "a"), "book_newchap")
    if a is not None:
        return clean_text(_node_text_raw(a))
    return ""


def _chapter_url(base, chapter_id):
    parts = (chapter_id or "").strip().split("-", 1)
    if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
        return ""
    return "%s/book/%s/%s.html" % (base.rstrip("/"), parts[0].strip(), parts[1].strip())