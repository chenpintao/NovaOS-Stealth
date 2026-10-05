# -*- coding: utf-8 -*-
"""ESJ Zone（esjzone.one / esjzone.cc）—— 由 go-novel-dl internal/site/esjzone.go 移植。
本机超时不可达，未实测。登录/密码解锁章节的 Cookie 与密码库流程未移植（框架无对应设施），
仅保留公开章节与转义/登录页检测。
"""
import re
from urllib.parse import quote, urlsplit

from bs4 import NavigableString, Tag

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_by_id,
                        find_first, has_ancestor_class, has_ancestor_tag,
                        normalize_path, parse_html)

PRIMARY = "https://www.esjzone.one"

BOOK_RE = re.compile(r"^/detail/(\d+)\.html$")
CHAPTER_RE = re.compile(r"^/forum/(\d+)/(\d+)\.html$")
REDIRECT_RE = re.compile(r"https?://[^'\"\s<]+")


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


def _first_node_text(node):
    if node is None:
        return ""
    for child in node.children:
        if isinstance(child, NavigableString):
            return str(child)
        if isinstance(child, Tag):
            text = _first_node_text(child)
            if text:
                return text
    return ""


def _node_text_for_chapter(node):
    if node is None:
        return ""
    out = []
    _walk_chapter(node, out)
    return "".join(out)


def _walk_chapter(node, out):
    skip_tags = ("script", "style", "meta", "link", "img", "noscript")
    block_tags = ("p", "div", "section", "article", "blockquote", "li",
                  "h1", "h2", "h3", "h4", "h5", "h6")
    for child in node.children:
        if isinstance(child, NavigableString):
            out.append(str(child))
            continue
        if not isinstance(child, Tag):
            continue
        if child.name in skip_tags:
            continue
        if child.name == "br":
            out.append("\n")
            continue
        _walk_chapter(child, out)
        if child.name in block_tags:
            out.append("\n")


def _join_paragraphs(node):
    if node is None:
        return ""
    parts = []
    for child in node.find_all(recursive=False):
        if child.name == "p":
            text = _clean_go(_node_text_raw(child))
            if text:
                parts.append(text)
    return "\n".join(parts)


def _strip_leading_chapter_title(content, title):
    content = (content or "").strip()
    title = (title or "").strip()
    if not content or not title:
        return content
    lines = content.split("\n")
    while lines:
        if not lines[0].strip():
            lines = lines[1:]
            continue
        if clean_text(lines[0]).lower() == clean_text(title).lower():
            lines = lines[1:]
        break
    return "\n".join(lines).strip()


def _parse_url(raw):
    raw = (raw or "").strip()
    if not raw:
        return None
    if not raw.startswith("http://") and not raw.startswith("https://"):
        raw = "https://" + raw
    return urlsplit(raw)


def _is_esj_host(host):
    host = (host or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host in ("esjzone.cc", "esjzone.one")


def _extract_mirror_redirect(markup):
    if "click here to enter" not in (markup or "").lower():
        return ""
    m = REDIRECT_RE.search(markup)
    return m.group(0).strip() if m else ""


def _is_login_page(markup):
    markers = ('class="login-box"', 'data-send="mem_login"',
               '<h4 class="margin-bottom-1x">會員登入</h4>')
    for marker in markers:
        if marker in markup:
            return True
    return False


def _is_encrypted_chapter(markup):
    for marker in ("btn-send-pw", "oops_art.jpg", "forum_pw.php"):
        if marker in markup:
            return True
    return False


@register
class ESJZoneSite(Site):
    key = "esjzone"
    display_name = "ESJ Zone"
    tags = ["简体中文", "轻小说", "转载站", "翻译", "NSFW"]
    hosts = ["esjzone.cc", "esjzone.one"]
    login_required = True
    timeout = 50.0

    def __init__(self, cfg=None):
        Site.__init__(self, cfg)
        self.primary_host = PRIMARY
        aliases = [PRIMARY]
        mirrors = self.cfg.get("mirrors") if isinstance(self.cfg, dict) else None
        for mirror in (mirrors or []):
            mirror = str(mirror).strip().rstrip("/")
            if mirror and mirror not in aliases:
                aliases.append(mirror)
        self.book_aliases = list(aliases)
        self.search_aliases = list(aliases)

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        parsed = _parse_url(raw_url)
        if parsed is None:
            return None
        host = (parsed.hostname or "").lower()
        if not _is_esj_host(host):
            return None
        path = parsed.path
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": self.primary_host + path}
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1), "chapter_id": m.group(2),
                    "canonical": self.primary_host + path}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        if not book_id:
            raise ValueError("book id is required")
        book_page, book_url = self._fetch_book_page(book_id)
        book, chapters = _parse_book_page(book_page, book_url, book_id, self.key)
        book["chapters"] = apply_chapter_range(chapters)
        return book

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        content = self._fetch_chapter_content(book_id, chapter.get("id") or "")
        result = dict(chapter)
        result["content"] = content
        result["downloaded"] = True
        return result

    def _fetch_chapter_content(self, book_id, chapter_id):
        last_err = None
        for host in self.book_aliases:
            page_url = host + "/forum/" + book_id + "/" + chapter_id + ".html"
            try:
                markup = self._get(page_url)
                redirected = _extract_mirror_redirect(markup)
                if redirected:
                    markup = self._get(redirected)
                    page_url = redirected
                return _parse_chapter_content(markup, page_url, False)
            except Exception as exc:
                last_err = exc
        raise last_err if last_err is not None else ValueError(
            "chapter not found: %s/%s" % (book_id, chapter_id))

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        encoded = quote(keyword, safe="")
        results = self._fetch_search(encoded)
        if limit > 0 and len(results) > limit:
            results = results[:limit]
        if _should_enrich(limit, len(results)):
            self._enrich(results)
        return results

    def _fetch_search(self, encoded_keyword):
        last_err = None
        for host in self.search_aliases:
            page_url = host + "/tags/" + encoded_keyword + "/"
            try:
                markup = self._get(page_url, referer=host + "/")
                return _parse_search_page(markup, host, self.key)
            except Exception as exc:
                last_err = exc
        raise last_err if last_err is not None else ValueError("search failed")

    def _enrich(self, results):
        for item in results[:2]:
            book_id = item.get("book_id") or ""
            if not book_id:
                continue
            if item.get("description") and item.get("author") and item.get("cover_url"):
                continue
            try:
                markup, page_url = self._fetch_book_page(book_id)
                detail = _parse_search_detail(markup, page_url, book_id, self.key)
            except Exception:
                continue
            if not item.get("description"):
                item["description"] = detail.get("description", "")
            if not item.get("cover_url"):
                item["cover_url"] = detail.get("cover_url", "")
            if not item.get("url"):
                item["url"] = detail.get("source_url", "")

    # ------------------------------------------------------------------
    def _fetch_book_page(self, book_id):
        last_err = None
        for host in self.book_aliases:
            page_url = host + "/detail/" + book_id + ".html"
            try:
                markup = self._get(page_url, referer=host + "/")
                redirected = _extract_mirror_redirect(markup)
                if redirected:
                    markup = self._get(redirected)
                    page_url = redirected
                if '<div id="chapterList"' not in markup and '<div id="chapterList">' not in markup:
                    last_err = ValueError("book page not found on %s" % host)
                    continue
                return markup, page_url
            except Exception as exc:
                last_err = exc
        raise last_err if last_err is not None else ValueError(
            "book page not found for %s" % book_id)

    # ------------------------------------------------------------------
    def _get(self, url, referer=None):
        headers = {"Referer": referer or (PRIMARY + "/")}
        cookie = self.cfg.get("cookie") if isinstance(self.cfg, dict) else None
        if cookie and cookie.strip():
            headers["Cookie"] = cookie.strip()
        return self.http.get(url, headers=headers)


# ---------------------------------------------------------------------------
# 解析辅助
# ---------------------------------------------------------------------------
def _parse_book_page(markup, book_url, book_id, site_key):
    doc = parse_html(markup)
    title = _first_node_text(find_first(doc, "h2", "text-normal")).strip()
    author = _extract_detail_author(doc)
    description = _join_paragraphs(find_first(doc, None, "description")).strip()
    cover = ""
    for node in find_all(doc, "img"):
        if has_ancestor_class(node, "product-gallery"):
            cover = attr(node, "src").strip()
            break
    tags = _collect_tags(doc)
    chapters = _parse_chapter_list(find_by_id(doc, "chapterList"))
    if not title:
        title = book_id
    if not author:
        author = "Unknown"
    book = {
        "site": site_key, "id": book_id, "title": title, "author": author,
        "description": description, "source_url": book_url,
        "cover_url": absolutize(PRIMARY, cover),
    }
    return book, chapters


def _parse_search_detail(markup, book_url, book_id, site_key):
    doc = parse_html(markup)
    title = _first_node_text(find_first(doc, "h2", "text-normal")).strip()
    if not title:
        title = book_id
    author = _extract_detail_author(doc) or "Unknown"
    cover = ""
    for node in find_all(doc, "img"):
        if has_ancestor_class(node, "product-gallery"):
            cover = attr(node, "src").strip()
            break
    return {
        "site": site_key, "id": book_id, "title": title, "author": author,
        "description": _join_paragraphs(find_first(doc, None, "description")).strip(),
        "source_url": book_url, "cover_url": absolutize(book_url, cover),
    }


def _parse_chapter_list(container):
    if container is None:
        raise ValueError("chapter list not found")
    chapters = []
    volume = [""]
    order = [1]

    def append_chapter(node):
        href = attr(node, "href")
        m = CHAPTER_RE.match(normalize_path(href).strip())
        if not m:
            return
        title = clean_text(attr(node, "data-title"))
        if not title:
            title = clean_text(_node_text_raw(node))
        if not title:
            return
        chapters.append({
            "id": m.group(2), "title": title,
            "url": absolutize(PRIMARY, href),
            "volume": volume[0], "order": order[0],
        })
        order[0] += 1

    def walk(node):
        name = node.name
        if name == "details":
            name_text = clean_text(_node_text_raw(find_first(node, "summary")))
            prev = volume[0]
            if name_text:
                volume[0] = name_text
            for grand in node.children:
                if isinstance(grand, Tag):
                    if grand.name == "summary":
                        continue
                    walk(grand)
            volume[0] = prev
            return
        if name == "a":
            append_chapter(node)
            return
        if name == "p":
            if has_ancestor_tag(node, "a"):
                return
            text = clean_text(_node_text_raw(node))
            if text and not chapters:
                volume[0] = text
        elif name in ("h1", "h2", "h3", "h4", "h5", "h6", "summary"):
            text = clean_text(_node_text_raw(node))
            if text:
                volume[0] = text
        for child in node.children:
            if isinstance(child, Tag):
                walk(child)

    walk(container)
    if not chapters:
        raise ValueError("no chapters found")
    return chapters


def _parse_chapter_content(markup, page_url, include_images):
    if _is_login_page(markup):
        raise ValueError("login required for chapter")
    if _is_encrypted_chapter(markup):
        raise ValueError("chapter is password protected")

    doc = parse_html(markup)
    container = find_first(doc, None, "forum-content")
    if container is None:
        body = _extract_forum_content_fragment(markup)
        if body:
            return _parse_chapter_content(body, page_url, include_images)
        raise ValueError("chapter content container not found")

    title = clean_text(_first_node_text(find_first(doc, "h2")))
    text = clean_text(_strip_leading_chapter_title(_node_text_for_chapter(container), title))
    paragraphs = []
    if text:
        paragraphs.append(text)
    if not paragraphs:
        raise ValueError("no readable chapter content found")
    return "\n\n".join(paragraphs)


def _extract_forum_content_fragment(markup):
    idx = markup.find("forum-content")
    if idx == -1:
        return ""
    start = markup.rfind("<", 0, idx)
    if start == -1:
        return ""
    fragment = markup[start:]
    end = fragment.find("</section>")
    end_marker = "</section>"
    if end == -1:
        end = fragment.find("</div>")
        end_marker = "</div>"
        if end == -1:
            return ""
    return fragment[:end + len(end_marker)]


def _parse_search_page(markup, base_url, site_key):
    doc = parse_html(markup)
    results = []
    seen = set()
    for card in find_all(doc, "div", "card-body"):
        title_link = None
        for a in find_all(card, "a"):
            if has_ancestor_class(a, "card-title"):
                title_link = a
                break
        if title_link is None:
            continue
        href = attr(title_link, "href")
        m = BOOK_RE.match(href.strip())
        if not m:
            continue
        book_id = m.group(1)
        if book_id in seen:
            continue
        seen.add(book_id)

        cover = ""
        parent = card.parent
        if parent is not None:
            lazy = find_first(parent, "div", "lazyload")
            cover = attr(lazy, "data-src")

        results.append({
            "site": site_key, "book_id": book_id,
            "title": clean_text(_node_text_raw(title_link)),
            "author": _extract_search_author(card),
            "latest_chapter": clean_text(_first_node_text(find_first(card, None, "card-ep"))),
            "url": absolutize(base_url, href),
            "cover_url": absolutize(base_url, cover),
        })
    return results


def _should_enrich(limit, size):
    if size == 0 or size > 8:
        return False
    if limit > 0 and limit > 8:
        return False
    return True


def _extract_detail_author(doc):
    for li in find_all(doc, "li"):
        text = clean_text(_node_text_raw(li))
        if "作者" not in text:
            continue
        for child in li.find_all(recursive=False):
            if child.name == "a":
                value = clean_text(_node_text_raw(child))
                if value:
                    return value
        if text.startswith("作者:"):
            text = text[len("作者:"):].strip()
        if text.startswith("作者"):
            text = text[len("作者"):].strip()
        if text:
            return text
    return ""


def _extract_search_author(card):
    text = clean_text(_node_text_raw(find_first(card, None, "card-author")))
    if text.startswith("作者:"):
        text = text[len("作者:"):].strip()
    if text.startswith("作者"):
        text = text[len("作者"):].strip()
    return text


def _collect_tags(doc):
    seen = set()
    result = []
    for node in find_all(doc, "a"):
        if not (has_ancestor_class(node, "widget-tags") or has_ancestor_class(node, "show-tag")):
            continue
        text = clean_text(_node_text_raw(node))
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result