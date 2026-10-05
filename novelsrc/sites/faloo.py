# -*- coding: utf-8 -*-
"""飞卢小说网（b.faloo.com）—— 由 go-novel-dl internal/site/faloo.go 移植。
Loshop & Cpt
"""
import html as _html
import re
import time
from urllib.parse import urlsplit

from ..base import Site, apply_chapter_range, dedup_chapters, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_by_id,
                        find_first, has_ancestor_class, has_ancestor_id,
                        node_text, parse_html)
from ._biquge_common import fallback, meta_property

BOOK_RE = re.compile(r"^/(\d+)\.html$")
CHAPTER_RE = re.compile(r"^/(\d+)_(\d+)\.html$")
COOKIE_GATE_RE = re.compile(r'cookie\s*=\s*"([^=]+)=([^";]+)')
VIP_IMAGE_RE = re.compile(r"image_do3\s*\(")
P_TAG_RE = re.compile(r"(?is)<p[^>]*>(.*?)</p>")
TAG_RE = re.compile(r"(?is)<[^>]+>")
PROMO_RE = re.compile(r"(?i)VIP|充值|点券|立即抢充|手机客户端|飞卢小说网")

LOCKED_TEXTS = ("您还没有订阅本章节", "您还没有登录，请登录后在继续阅读本部小说")

BASE = "https://b.faloo.com"
MIN_REQUEST_INTERVAL = 3.0

_SAFE_RUNES = set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*+-./@_")


def _faloo_path(raw):
    """对齐 Go falooPath：去掉主机，只留 path。"""
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.startswith("//"):
        raw = "https:" + raw
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


def _escape_keyword(keyword):
    out = []
    for ch in keyword:
        code = ord(ch)
        if ch in _SAFE_RUNES:
            out.append(ch)
        elif code < 256:
            out.append("%%%02X" % code)
        else:
            out.append("%%u%04X" % code)
    return "".join(out)


def _search_url(keyword):
    return BASE + "/l/0/1.html?t=1&k=" + _escape_keyword(keyword)


def _first_class(node, tag, class_name):
    for item in find_all(node, tag):
        if class_name in (item.get("class") or []):
            return item
    return None


def _all_ancestor_class(node, tag, class_name):
    return [item for item in find_all(node, tag)
            if has_ancestor_class(item, class_name)]


def _first_ancestor_class(node, tag, class_name):
    for item in find_all(node, tag):
        if has_ancestor_class(item, class_name):
            return item
    return None


def _any_marker(text, markers):
    for marker in markers:
        if marker in text:
            return True
    return False


def _extract_chapters(root, volume):
    """对齐 Go extractFalooChapters：只保留 falooChapterRe 命中的链接。"""
    chapters = []
    for a in find_all(root, "a"):
        href = attr(a, "href").strip()
        match = CHAPTER_RE.match(_faloo_path(href))
        if not match:
            continue
        chapters.append({
            "id": match.group(2),
            "title": fallback(attr(a, "title"), clean_text(node_text(a))),
            "url": absolutize(BASE, href),
            "volume": volume,
            "order": len(chapters) + 1,
        })
    return chapters


def _extract_main_chapters(main):
    """对齐 Go extractFalooMainChapters：遇到 DivVip 后跳过后续（VIP）章节。"""
    chapters = []
    in_vip_section = False
    for child in main.children:
        if getattr(child, "name", None) is None:
            continue
        if "DivVip" in (child.get("class") or []):
            in_vip_section = True
        # cfg.General.FetchInaccessible 默认 false：VIP 段整段跳过
        if in_vip_section:
            continue
        chapters.extend(_extract_chapters(child, "正文"))
    return chapters


def _parse_search_results(markup):
    doc = parse_html(markup)
    results = []
    seen = set()
    for item in find_all(doc, "div"):
        if "TwoBox02_02" not in (item.get("class") or []):
            continue
        if not has_ancestor_id(item, "BookContent"):
            continue
        title_link = _first_ancestor_class(item, "a", "TwoBox02_08")
        if title_link is None:
            title_link = _first_ancestor_class(item, "a", "TwoBox02_03")
        match = BOOK_RE.match(_faloo_path(attr(title_link, "href")))
        if not match:
            continue
        book_id = match.group(1)
        if book_id in seen:
            continue
        seen.add(book_id)
        img = _first_ancestor_class(item, "img", "TwoBox02_03")
        results.append({
            "site": "faloo",
            "book_id": book_id,
            "title": fallback(attr(title_link, "title"), clean_text(node_text(title_link))),
            "author": clean_text(node_text(_first_ancestor_class(item, "a", "TwoBox02_09"))),
            "description": clean_text(node_text(_first_ancestor_class(item, "a", "TwoBox02_06"))),
            "url": BASE + "/" + book_id + ".html",
            "latest_chapter": clean_text(node_text(_first_class(item, "a", "fontSize14andChen"))),
            "cover_url": fallback(attr(img, "data-original"), attr(img, "src")),
        })

    next_path = ""
    for a in find_all(doc, "a"):
        if not has_ancestor_class(a, "pageliste_body"):
            continue
        if clean_text(node_text(a)) == "下一页":
            next_path = attr(a, "href").strip()
            break
    return results, next_path


@register
class FalooSite(Site):
    key = "faloo"
    display_name = "飞卢小说网"
    tags = ["简体中文", "原创", "男性向"]
    hosts = ["b.faloo.com"]

    def __init__(self, cfg=None):
        Site.__init__(self, cfg)
        self._gate_cookies = set()
        self._last_request = 0.0

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
        if host != "b.faloo.com":
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
        markup = self._fetch_page(BASE + "/" + book_id + ".html")
        doc = parse_html(markup)

        title = fallback(meta_property(doc, "og:novel:book_name"),
                         clean_text(node_text(find_by_id(doc, "novelName"))))
        author = fallback(meta_property(doc, "og:novel:author"),
                          clean_text(node_text(_first_class(doc, "a", "colorQianHui"))))
        description = fallback(
            clean_text(node_text(find_first(doc, "div", class_="T-L-T-C-Box1"))),
            meta_property(doc, "og:description"))
        cover = fallback(
            meta_property(doc, "og:image"),
            attr(_first_ancestor_class(doc, "img", "T-L-T-Img"), "src"))

        chapters = []
        related = find_first(doc, "div", class_="C-Fo-Z-Zuoping")
        if related is not None:
            chapters.extend(_extract_chapters(related, "作品相关"))
        main = find_by_id(doc, "mulu")
        if main is not None:
            chapters.extend(_extract_main_chapters(main))

        return {
            "site": self.key, "id": book_id, "title": title, "author": author,
            "description": description,
            "source_url": BASE + "/" + book_id + ".html",
            "cover_url": cover,
            "chapters": apply_chapter_range(dedup_chapters(chapters)),
        }

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        book_id = (book_id or "").strip()
        result = dict(chapter)
        chapter_id = (result.get("id") or "").strip()
        if not book_id or not chapter_id:
            raise ValueError("faloo book id and chapter id are required")

        self._wait_request_interval()
        chapter_url = "%s/%s_%s.html" % (BASE, book_id, chapter_id)
        last_markup = ""
        for attempt in range(2):
            markup = self._fetch_page(chapter_url)
            last_markup = markup
            if _any_marker(markup, LOCKED_TEXTS) or VIP_IMAGE_RE.search(markup):
                raise ValueError("faloo chapter %s is VIP or requires login" % chapter_id)
            doc = parse_html(markup)
            title = clean_text(node_text(_first_ancestor_class(doc, "h1", "c_l_title")))
            if title:
                result["title"] = title

            paragraphs = []
            for p in _all_ancestor_class(doc, "p", "noveContent"):
                text = clean_text(node_text(p))
                if text:
                    paragraphs.append(text)
            if not paragraphs:
                for raw in P_TAG_RE.findall(markup):
                    text = _html.unescape(TAG_RE.sub("", raw))
                    text = clean_text(text)
                    if not text or PROMO_RE.search(text):
                        continue
                    paragraphs.append(text)
            if paragraphs:
                result["content"] = "\n".join(paragraphs)
                result["downloaded"] = True
                return result
            if attempt == 0:
                self._wait_request_interval()
        raise ValueError(
            "faloo chapter content not found (has_noveContent=%s p_tags=%d)"
            % ("noveContent" in last_markup, len(P_TAG_RE.findall(last_markup))))

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        if limit <= 0:
            limit = 30
        results = []
        seen = set()
        next_url = _search_url(keyword)
        while next_url and len(results) < limit:
            markup = self._fetch_page(next_url)
            page_results, next_path = _parse_search_results(markup)
            for item in page_results:
                if not item.get("book_id"):
                    continue
                if item["book_id"] in seen:
                    continue
                seen.add(item["book_id"])
                results.append(item)
                if len(results) >= limit:
                    break
            if not next_path or len(results) >= limit:
                break
            next_url = absolutize(BASE, next_path)
        return results

    # ------------------------------------------------------------------
    def _fetch_page(self, url):
        markup = self._get(url)
        match = COOKIE_GATE_RE.search(markup or "")
        if not match:
            return markup
        for name in list(self._gate_cookies):
            try:
                self.http.session.cookies.clear(
                    domain=".faloo.com", path="/", name=name)
            except Exception:
                pass
            self._gate_cookies.discard(name)
        name = match.group(1)
        value = match.group(2)
        self._gate_cookies.add(name)
        try:
            self.http.session.cookies.set(name, value, domain=".faloo.com", path="/")
        except Exception:
            pass
        return self._get(url)

    def _wait_request_interval(self):
        elapsed = time.time() - self._last_request
        if elapsed < MIN_REQUEST_INTERVAL:
            time.sleep(MIN_REQUEST_INTERVAL - elapsed)
        self._last_request = time.time()

    def _get(self, url):
        return self.http.get(url)