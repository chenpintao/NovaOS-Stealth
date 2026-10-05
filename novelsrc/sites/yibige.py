# -*- coding: utf-8 -*-
"""一笔阁（yibige.org）—— 由 go-novel-dl internal/site/yibige.go 移植。
Loshop & Cpt
"""
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote_plus, urlsplit

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_by_id,
                        find_first, has_ancestor_class, has_ancestor_id,
                        has_ancestor_tag, node_text, node_text_lines,
                        parse_html)
from ._biquge_common import fallback, meta_property

BOOK_RE = re.compile(r"^/(\d+)/$")
CHAPTER_RE = re.compile(r"^/(\d+)/(\d+)\.html$")
SOVOTE_RE = re.compile(r"javascript:sovote\((\d+),'([^']+)'\)")
ENCRYPTED_RE = re.compile(r'encryptedCookieValue\s*=\s*"([^"]+)"')

BASE = "https://www.yibige.org"
MIRROR_HOSTS = ("https://www.yibige.org", "https://tw.yibige.org",
                "https://sg.yibige.org", "https://hk.yibige.org")
ALLOWED_HOSTS = ("yibige.org", "tw.yibige.org", "sg.yibige.org", "hk.yibige.org")

AD_MARKERS = ("首发无广告", "请分享", "读之阁", "小说网", "首发地址",
              "手机阅读", "一笔阁", "site_con_ad", "chapter_content")


def _go_path(raw):
    """对齐 Go normalizeESJPath：有主机时取 path，否则原样返回。"""
    raw = (raw or "").strip()
    if not raw:
        return ""
    candidate = raw
    if not (candidate.startswith("http://") or candidate.startswith("https://")):
        candidate = "https://" + candidate
    try:
        parts = urlsplit(candidate)
    except ValueError:
        return raw
    if parts.netloc:
        return parts.path
    return raw


def _preserve_lines(node):
    return "\n".join(node_text_lines(node))


def _first_ancestor_class(node, tag, class_name):
    for item in find_all(node, tag):
        if has_ancestor_class(item, class_name):
            return item
    return None


def _first_ancestor_id(node, tag, elem_id):
    for item in find_all(node, tag):
        if has_ancestor_id(item, elem_id):
            return item
    return None


def _is_challenge(markup):
    markup = markup or ""
    return bool(ENCRYPTED_RE.search(markup)) \
        or "encryptedCookieValue" in markup \
        or 'id="verifyBtn"' in markup \
        or "访问验证" in markup


def _unquote_js(value):
    if not value:
        return ""
    out = []
    i = 0
    length = len(value)
    while i < length:
        ch = value[i]
        if ch == "\\" and i + 1 < length:
            i += 1
            nxt = value[i]
            if nxt == "\\":
                out.append("\\")
            elif nxt == '"':
                out.append('"')
            elif nxt == "/":
                out.append("/")
            elif nxt == "n":
                out.append("\n")
            elif nxt == "r":
                out.append("\r")
            elif nxt == "t":
                out.append("\t")
            else:
                out.append(nxt)
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _is_ad(text):
    compact = text.replace(" ", "")
    for marker in AD_MARKERS:
        if marker in text or marker in compact:
            return True
    return False


def _clean_paragraphs(nodes, is_ad):
    paragraphs = []
    for node in nodes:
        text = clean_text(_preserve_lines(node))
        if not text:
            continue
        if is_ad is not None and is_ad(text):
            continue
        paragraphs.append(text)
    return paragraphs


def _parse_search_results(markup):
    doc = parse_html(markup)
    results = []
    seen = set()
    for row in find_all(doc, "tr"):
        if attr(row, "id") != "nr":
            continue
        title_link = find_first(row, "a")
        if title_link is None:
            continue
        sovote = SOVOTE_RE.search(attr(title_link, "href"))
        if not sovote:
            continue
        book_id = sovote.group(1)
        title = clean_text(node_text(title_link))
        if not title:
            continue
        if book_id in seen:
            continue
        seen.add(book_id)
        cells = find_all(row, "td")
        author = clean_text(node_text(cells[1])) if len(cells) >= 2 else ""
        results.append({
            "site": "yibige", "book_id": book_id, "title": title,
            "author": author, "url": BASE + "/" + book_id + "/",
        })
    return results


@register
class YibigeSite(Site):
    key = "yibige"
    display_name = "一笔阁"
    tags = ["简体中文", "繁体中文", "转载站", "笔趣阁"]
    hosts = list(ALLOWED_HOSTS)

    def __init__(self, cfg=None):
        Site.__init__(self, cfg)
        self.base_url = BASE

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        raw_url = (raw_url or "").strip()
        if not raw_url:
            return None
        candidate = raw_url
        if not (candidate.startswith("http://") or candidate.startswith("https://")):
            candidate = "https://" + candidate
        try:
            parts = urlsplit(candidate)
        except ValueError:
            return None
        host = (parts.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host not in ALLOWED_HOSTS:
            return None
        path = parts.path
        match = CHAPTER_RE.match(path)
        if match:
            return {"site": self.key, "book_id": match.group(1),
                    "chapter_id": match.group(2), "canonical": BASE + path}
        match = BOOK_RE.match(path)
        if match:
            return {"site": self.key, "book_id": match.group(1),
                    "canonical": BASE + path}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        info_markup = self._get_with_mirrors("/%s/" % book_id)
        catalog_markup = self._get_with_mirrors("/%s/index.html" % book_id)
        info_doc = parse_html(info_markup)
        catalog_doc = parse_html(catalog_markup)

        title = fallback(meta_property(info_doc, "og:novel:book_name"),
                         clean_text(node_text(find_by_id(info_doc, "info"))))
        author = fallback(meta_property(info_doc, "og:novel:author"),
                          clean_text(node_text(_first_ancestor_id(info_doc, "a", "info"))))
        description = clean_text(node_text(find_by_id(info_doc, "intro")))
        cover = fallback(meta_property(info_doc, "og:image"),
                         attr(_first_ancestor_id(info_doc, "img", "fmimg"), "src"))

        chapters = []
        links = [a for a in find_all(catalog_doc, "a")
                 if has_ancestor_tag(a, "dd") and has_ancestor_id(a, "list")]
        for idx, a in enumerate(links):
            href = attr(a, "href")
            match = CHAPTER_RE.match(_go_path(href))
            if not match:
                continue
            chapters.append({
                "id": match.group(2),
                "title": clean_text(node_text(a)),
                "url": absolutize(self.base_url, href),
                "order": idx + 1,
            })

        return {
            "site": self.key, "id": book_id, "title": title, "author": author,
            "description": description,
            "source_url": "%s/%s/" % (self.base_url, book_id),
            "cover_url": cover,
            "chapters": apply_chapter_range(chapters),
        }

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        book_id = (book_id or "").strip()
        result = dict(chapter)
        chapter_id = (result.get("id") or "").strip()
        if not book_id or not chapter_id:
            raise ValueError("yibige book id and chapter id are required")

        markup = self._get_with_mirrors("/%s/%s.html" % (book_id, chapter_id))
        doc = parse_html(markup)

        title = clean_text(node_text(_first_ancestor_class(doc, "h1", "bookname")))
        if title:
            result["title"] = title

        nodes = [p for p in find_all(doc, "p") if has_ancestor_id(p, "content")]
        paragraphs = _clean_paragraphs(nodes, _is_ad)
        if not paragraphs:
            raise ValueError("yibige chapter content not found")
        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        markup = self._search_markup(keyword)
        results = _parse_search_results(markup)
        if limit > 0 and len(results) > limit:
            results = results[:limit]
        self._enrich(results)
        return results

    def _enrich(self, results):
        targets = [item for item in results[:6] if item.get("book_id")]
        if not targets:
            return
        workers = min(6, len(targets))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(self._populate_search_detail, item)
                       for item in targets]
            for future in futures:
                try:
                    future.result()
                except Exception:
                    continue

    def _populate_search_detail(self, item):
        if not item or not item.get("book_id"):
            return
        book = self.download_plan(item["book_id"])
        if book.get("id"):
            item["book_id"] = book["id"]
        if book.get("title"):
            item["title"] = book["title"]
        if book.get("author"):
            item["author"] = book["author"]
        if book.get("description"):
            item["description"] = book["description"]
        if book.get("source_url"):
            item["url"] = book["source_url"]
        if book.get("cover_url"):
            item["cover_url"] = book["cover_url"]
        chapters = book.get("chapters") or []
        for idx in range(len(chapters) - 1, -1, -1):
            title = (chapters[idx].get("title") or "").strip()
            if title:
                item["latest_chapter"] = title
                break

    # ------------------------------------------------------------------
    def _search_markup(self, keyword):
        last = None
        for host in MIRROR_HOSTS:
            try:
                markup, ok = self._request_search(host, keyword)
            except Exception as exc:
                last = exc
                continue
            if not ok:
                last = ValueError("yibige search challenge not bypassed on %s" % host)
                continue
            return markup
        if last is not None:
            raise last
        raise ValueError("yibige search request failed")

    def _request_search(self, host, keyword):
        search_url = (host + "/modules/article/search.php?searchkey="
                      + quote_plus(keyword) + "&searchtype=articlename")
        markup = self._get(search_url)
        if not _is_challenge(markup):
            return markup, True

        match = ENCRYPTED_RE.search(markup)
        if not match:
            raise ValueError("yibige search challenge token not found")
        cookie_value = quote_plus(_unquote_js(match.group(1)))
        parts = urlsplit(search_url)
        self.http.session.cookies.set(
            "is_human", cookie_value, domain=parts.hostname, path="/")

        retry = self._get(search_url)
        if _is_challenge(retry):
            raise ValueError("yibige search challenge not bypassed")
        return retry, True

    def _get_with_mirrors(self, path):
        last = None
        for host in MIRROR_HOSTS:
            try:
                markup = self._get(host + path)
            except Exception as exc:
                last = exc
                continue
            if "Just a moment..." in markup or "cf-browser-verification" in markup:
                last = ValueError("yibige is currently protected by Cloudflare challenge")
                continue
            self.base_url = host
            return markup
        if last is not None:
            raise last
        raise ValueError("yibige request failed")

    def _get(self, url):
        return self.http.get(url)