# -*- coding: utf-8 -*-
"""天涯书库（tianyabooks.com）—— 由 go-novel-dl internal/site/tianyabooks.go 移植。
本机不可达，未实测。
"""
import re
from urllib.parse import urlsplit

from bs4 import NavigableString, Tag

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_by_id,
                        find_first, has_ancestor_class, has_ancestor_tag,
                        parse_html)

BASE = "https://www.tianyabooks.com"

CHAPTER_RE = re.compile(r"^/([^/]+)/([^/]+)/(\d+)\.html$")
WRITER_PAGE_RE = re.compile(r"^/writer\d+\.html$")
AUTHOR_PAGE_RE = re.compile(r"^/author/[^/]+\.html$")

DEFAULT_WRITER_PATHS = [
    "/writer01.html", "/writer02.html", "/writer03.html", "/writer04.html",
    "/writer05.html", "/writer06.html", "/writer07.html", "/writer08.html",
    "/writer10.html", "/writer11.html",
]


# ---------------------------------------------------------------------------
# 与 Go 版 htmlutil 对齐的文本工具（不修改共用 htmlutil.py，故在此本地实现）
# ---------------------------------------------------------------------------
def _clean_go(value):
    """对齐 Go cleanText：按行压缩空白，但保留行分隔。"""
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
    """对齐 Go nodeTextPreserveLineBreaks：仅 <br> 产生换行。"""
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


def _loose_lines(node):
    if node is None:
        return []
    parts = []
    for line in _clean_go(_node_text_lb(node)).split("\n"):
        line = line.strip()
        if line:
            parts.append(line)
    return parts


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


def _book_id_from_path(path):
    path = (path or "").strip()
    if not path.endswith("/"):
        return None
    parts = path.strip("/").split("/")
    if len(parts) != 2:
        return None
    for part in parts:
        part = part.strip()
        if not part or "." in part:
            return None
    return parts[0] + "/" + parts[1]


def _resolve_tianyabooks(raw_url, base_url):
    parsed = _parse_url(raw_url)
    if parsed is None:
        return None
    host = _host_of(parsed)
    if host != "tianyabooks.com":
        base_parsed = _parse_url(base_url)
        if base_parsed is None or _host_of(base_parsed) != host:
            return None
    canonical_base = "https://www.tianyabooks.com"
    m = CHAPTER_RE.match(parsed.path)
    if m:
        return {"site": "tianyabooks", "book_id": m.group(1) + "/" + m.group(2),
                "chapter_id": m.group(3), "canonical": canonical_base + parsed.path}
    book_id = _book_id_from_path(parsed.path)
    if book_id:
        return {"site": "tianyabooks", "book_id": book_id,
                "canonical": canonical_base + parsed.path}
    return None


def _clean_book_title(value):
    value = _clean_go(value)
    value = value.strip("《》")
    return value.strip()


def _clean_author(value):
    value = _clean_go(value)
    if value.startswith("作者："):
        value = value[len("作者："):]
    value = value.strip()
    if value.startswith("作者:"):
        value = value[len("作者:"):]
    value = value.strip()
    if value.endswith("作品全集"):
        value = value[:-len("作品全集")]
    return value.strip()


def _clean_description(value):
    value = _clean_go(value)
    if value.startswith("内容简介："):
        value = value[len("内容简介："):].strip()
    if value.startswith("内容简介:"):
        value = value[len("内容简介:"):].strip()
    return value.strip()


def _normalize_chapter_title(title, book_title):
    title = _clean_go(title)
    book_title = _clean_book_title(book_title)
    if book_title and title.startswith(book_title):
        title = title[len(book_title):].strip()
    for prefix in ("正文", "正文卷"):
        if title.startswith(prefix):
            title = title[len(prefix):].strip()
    return title.strip()


def _first_with_ancestor_class(nodes, class_name):
    for node in nodes:
        if has_ancestor_class(node, class_name):
            return node
    return None


@register
class TianyabooksSite(Site):
    key = "tianyabooks"
    display_name = "天涯书库"
    tags = ["简体中文", "经典图书", "转载站"]
    hosts = ["tianyabooks.com"]

    # ------------------------------------------------------------------
    def resolve_url(self, raw_url):
        return _resolve_tianyabooks(raw_url, BASE)

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        markup = self._get(self._book_url(book_id))
        doc = parse_html(markup)
        book_root = find_first(doc, "div", "book")

        title_node = _first_with_ancestor_class(find_all(doc, "h1"), "catalog")
        title = _clean_book_title(_clean_go(_node_text_raw(title_node)))
        if not title:
            title = _clean_book_title(_clean_go(_node_text_raw(find_first(book_root, "h1"))))
        if not title:
            title = _clean_book_title(_clean_go(_node_text_raw(find_first(doc, "h1"))))

        author_node = _first_with_ancestor_class(find_all(doc, "div", "info"), "catalog")
        author = _clean_author(_clean_go(_node_text_raw(author_node)))
        if not author:
            author = _clean_author(_clean_go(_node_text_raw(find_first(book_root, "h2"))))

        description = _clean_description(_clean_go(_node_text_lb(find_first(doc, "div", "intro"))))
        if not description:
            p = _first_with_ancestor_class(find_all(book_root, "p"), "description")
            description = _clean_description(_clean_go(_node_text_lb(p)))
        if not description:
            description = _clean_description(
                _clean_go(_node_text_lb(find_first(book_root, "div", "description"))))

        book_base = BASE + "/" + book_id.strip("/") + "/"
        chapters = self._parse_chapters(doc, book_root, book_base, book_id)
        if not chapters:
            raise ValueError("tianyabooks chapter list not found")

        cover = absolutize(BASE, attr(
            _first_with_ancestor_class(find_all(doc, "img"), "catalog"), "src"))

        return {
            "site": self.key, "id": book_id, "title": title, "author": author,
            "description": description, "source_url": self._book_url(book_id),
            "cover_url": cover,
            "chapters": apply_chapter_range(chapters),
        }

    def _parse_chapters(self, doc, book_root, book_base, book_id):
        chapters = []
        seen = set()
        for a in find_all(doc, "a"):
            if not (has_ancestor_class(a, "idx-list") or has_ancestor_class(a, "mulu-list")):
                continue
            self._append_chapter(chapters, seen, a, book_base, book_id, "正文")
        if chapters:
            return chapters
        for dl in find_all(book_root, "dl"):
            volume = "正文"
            for child in dl.find_all(recursive=False):
                if child.name == "dt":
                    value = _clean_go(_node_text_raw(child))
                    if value:
                        volume = value
                elif child.name == "dd":
                    link = find_first(child, "a")
                    self._append_chapter(chapters, seen, link, book_base, book_id, volume)
        return chapters

    @staticmethod
    def _append_chapter(chapters, seen, link, book_base, book_id, volume):
        if link is None:
            return
        href = attr(link, "href").strip()
        if not href:
            return
        raw_url = absolutize(book_base, href)
        resolved = _resolve_tianyabooks(raw_url, BASE)
        if not resolved or resolved.get("book_id") != book_id:
            return
        chapter_id = (resolved.get("chapter_id") or "").strip()
        if not chapter_id or chapter_id in seen:
            return
        chapter_title = _clean_go(_node_text_raw(link))
        if not chapter_title:
            return
        seen.add(chapter_id)
        chapters.append({
            "id": chapter_id, "title": chapter_title, "url": raw_url,
            "volume": (volume.strip() if volume else "") or "正文",
            "order": len(chapters) + 1,
        })

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        book_id = (book_id or "").strip()
        chapter_id = (chapter.get("id") or "").strip()
        if not book_id or not chapter_id:
            raise ValueError("book id and chapter id are required")

        markup = self._get(self._chapter_url(book_id, chapter_id))
        doc = parse_html(markup)

        page_title = clean_text(_node_text_raw(
            _first_with_ancestor_class(find_all(doc, "h2"), "article")))
        if not page_title:
            h1 = _first_with_ancestor_id(find_all(doc, "h1"), "main")
            page_title = clean_text(_node_text_raw(h1))
        book_title = clean_text(_node_text_raw(
            _first_with_ancestor_class(find_all(doc, "a"), "meta")))
        title = _normalize_chapter_title(page_title, book_title)

        article = find_first(doc, "div", "article")
        paragraphs = []
        for p in find_all(article, "p"):
            paragraphs.extend(_loose_lines(p))
        if not paragraphs:
            paragraphs = self._legacy_paragraphs(find_by_id(doc, "main"))
        normalized = []
        for line in paragraphs:
            line = _clean_go(line)
            if line:
                normalized.append(line)
        if not normalized:
            raise ValueError("tianyabooks chapter content not found")

        result = dict(chapter)
        if title:
            result["title"] = title
        result["content"] = "\n".join(normalized)
        result["downloaded"] = True
        return result

    @staticmethod
    def _legacy_paragraphs(main):
        if main is None:
            return []
        best = []
        best_len = 0
        for child in main.find_all(recursive=False):
            if child.name != "p":
                continue
            lines = _loose_lines(child)
            total = len("".join(lines))
            if total > best_len:
                best = lines
                best_len = total
        if best:
            return best
        for p in find_all(main, "p"):
            if has_ancestor_tag(p, "table"):
                continue
            lines = _loose_lines(p)
            total = len("".join(lines))
            if total > best_len:
                best = lines
                best_len = total
        return best

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        if limit <= 0:
            limit = 30
        items = self._build_search_index()
        return _search_cached_results(items, keyword, limit)

    def _build_search_index(self):
        writer_paths = self._load_writer_paths()
        author_paths = self._load_author_paths(writer_paths)
        if not author_paths:
            raise ValueError("tianyabooks author index not found")
        all_items = []
        for path in author_paths:
            try:
                markup = self._get(BASE.rstrip("/") + path)
            except Exception:
                continue
            try:
                all_items.extend(_parse_author_page(markup, BASE))
            except Exception:
                continue
        return _dedupe_search_results(all_items)

    def _load_writer_paths(self):
        try:
            markup = self._get(BASE.rstrip("/") + "/author.html")
        except Exception:
            return list(DEFAULT_WRITER_PATHS)
        paths = _parse_writer_paths(markup, BASE)
        return paths or list(DEFAULT_WRITER_PATHS)

    def _load_author_paths(self, writer_paths):
        seen = set()
        paths = []
        for writer_path in writer_paths:
            try:
                markup = self._get(BASE.rstrip("/") + writer_path)
            except Exception:
                continue
            for item in _parse_author_paths(markup, BASE):
                if item in seen:
                    continue
                seen.add(item)
                paths.append(item)
        paths.sort()
        return paths

    # ------------------------------------------------------------------
    def _book_url(self, book_id):
        return BASE.rstrip("/") + "/" + book_id.strip("/") + "/"

    def _chapter_url(self, book_id, chapter_id):
        return (BASE.rstrip("/") + "/" + book_id.strip("/") + "/"
                + chapter_id.strip() + ".html")

    def _get(self, url):
        return self.http.get(url)


def _first_with_ancestor_id(nodes, elem_id):
    from ..htmlutil import has_ancestor_id
    for node in nodes:
        if has_ancestor_id(node, elem_id):
            return node
    return None


def _internal_path(raw_url, base_url):
    raw_url = (raw_url or "").strip()
    if not raw_url:
        return ""
    if raw_url.startswith("/"):
        return raw_url
    parsed = _parse_url(absolutize(base_url, raw_url))
    if parsed is None:
        return ""
    if _host_of(parsed) != "tianyabooks.com":
        base_parsed = _parse_url(base_url)
        if base_parsed is None or _host_of(base_parsed) != _host_of(parsed):
            return ""
    return parsed.path


def _parse_writer_paths(markup, base_url):
    doc = parse_html(markup)
    seen = set()
    paths = []
    for a in find_all(doc, "a"):
        path = _internal_path(attr(a, "href"), base_url)
        if not WRITER_PAGE_RE.match(path):
            continue
        if path in seen:
            continue
        seen.add(path)
        paths.append(path)
    paths.sort()
    return paths


def _parse_author_paths(markup, base_url):
    doc = parse_html(markup)
    seen = set()
    paths = []
    for a in find_all(doc, "a"):
        path = _internal_path(attr(a, "href"), base_url)
        if not AUTHOR_PAGE_RE.match(path):
            continue
        if path in seen:
            continue
        seen.add(path)
        paths.append(path)
    paths.sort()
    return paths


def _parse_author_page(markup, base_url):
    doc = parse_html(markup)
    author = _clean_author(_clean_go(_node_text_raw(find_first(doc, "h1"))))
    seen = set()
    results = []
    for row in find_all(doc, "tr"):
        title_link = find_first(row, "a")
        if title_link is None:
            continue
        raw_url = absolutize(base_url, attr(title_link, "href"))
        resolved = _resolve_tianyabooks(raw_url, base_url)
        if not resolved or not (resolved.get("book_id") or "").strip():
            continue
        book_id = resolved["book_id"]
        if book_id in seen:
            continue
        seen.add(book_id)

        title = _clean_book_title(_clean_go(_node_text_raw(title_link)))
        if not title:
            continue

        description = ""
        fonts = find_all(row, "font")
        for idx in range(len(fonts) - 1, -1, -1):
            text = _clean_description(_clean_go(_node_text_lb(fonts[idx])))
            if text and text != title:
                description = text
                break
        if not description:
            description = _clean_description(_clean_go(_node_text_lb(row)))
            title_text = _clean_go(_node_text_raw(title_link))
            if description.startswith(title_text):
                description = description[len(title_text):].strip()
            if description.startswith(title):
                description = description[len(title):].strip()
            description = description.strip()

        results.append({
            "site": "tianyabooks", "book_id": book_id, "title": title,
            "author": author, "description": description, "url": raw_url,
        })
    return results


# ---------------------------------------------------------------------------
# 搜索缓存索引的匹配/排序（对齐 search_cache.go 的 searchCachedResults）
# ---------------------------------------------------------------------------
_VARIANT_MAP = (("妳", "你"), ("祢", "你"))


def _norm_search_text(value):
    if not value:
        return ""
    for src, dst in _VARIANT_MAP:
        value = value.replace(src, dst)
    value = value.strip().lower()
    return "".join(ch for ch in value if ch.isalnum())


def _dedupe_search_results(items):
    seen = set()
    out = []
    for item in items:
        book_id = item.get("book_id") or ""
        if not book_id:
            continue
        key = item.get("site", "") + "|" + book_id
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _cached_search_score(item, keyword):
    title = _norm_search_text(item.get("title"))
    author = _norm_search_text(item.get("author"))
    description = _norm_search_text(item.get("description"))
    latest = _norm_search_text(item.get("latest_chapter"))
    score = 0
    if title == keyword:
        score += 1200
    elif title.startswith(keyword):
        score += 950
    elif keyword in title:
        score += 820
    if author == keyword:
        score += 620
    elif author.startswith(keyword):
        score += 500
    elif keyword in author:
        score += 360
    if keyword in description:
        score += 220
    if keyword in latest:
        score += 120
    if score == 0:
        return 0
    if item.get("cover_url"):
        score += 20
    if item.get("description"):
        score += 15
    return score


def _search_cached_results(items, keyword, limit):
    keyword_norm = _norm_search_text(keyword)
    if not keyword_norm:
        return []
    scored = []
    for item in items:
        score = _cached_search_score(item, keyword_norm)
        if score <= 0:
            continue
        scored.append((score, item))
    scored.sort(key=lambda pair: (-pair[0],
                                  -len(pair[1].get("description") or ""),
                                  pair[1].get("book_id") or ""))
    if limit > 0:
        scored = scored[:limit]
    return [item for _score, item in scored]