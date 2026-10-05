# -*- coding: utf-8 -*-
"""SF轻小说（sfacg.com）—— 由 go-novel-dl internal/site/sfacg.go 移植。
Loshop & Cpt
"""
import re
from urllib.parse import urlsplit

from bs4 import Comment, NavigableString, Tag

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, clean_text, find_first,
                        has_ancestor_class, node_text, normalize_path, parse_html)

BOOK_RE = re.compile(r"^/b/(\d+)/?$")
CATALOG_RE = re.compile(r"^/i/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/c/(\d+)/?$")
NOVEL_RE = re.compile(r"^/Novel/(\d+)/?$")

M_BASE = "https://m.sfacg.com"
BOOK_BASE = "https://book.sfacg.com"
SEARCH_BASE = "https://s.sfacg.com"


@register
class SfacgSite(Site):
    key = "sfacg"
    display_name = "SF轻小说"
    tags = ["简体中文", "轻小说", "原创"]
    hosts = ["sfacg.com", "m.sfacg.com", "book.sfacg.com"]

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
        if host not in ("m.sfacg.com", "sfacg.com", "book.sfacg.com"):
            return None
        path = parts.path
        if host == "book.sfacg.com":
            m = NOVEL_RE.match(path)
            if m:
                return {"site": self.key, "book_id": m.group(1),
                        "canonical": BOOK_BASE + path}
            return None
        m = CHAPTER_RE.match(path)
        if m:
            return {"site": self.key, "chapter_id": m.group(1),
                    "canonical": M_BASE + path}
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": M_BASE + path}
        m = CATALOG_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": M_BASE + path}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        info_markup = self._get(M_BASE + "/b/" + book_id + "/")
        catalog_markup = self._get(M_BASE + "/i/" + book_id + "/")
        info_doc = parse_html(info_markup)
        catalog_doc = parse_html(catalog_markup)

        book_info2 = _clean_loose(find_first(info_doc, "div", class_="book_info2"))
        book_info3 = _clean_loose(find_first(info_doc, "span", class_="book_info3"))

        title = clean_text(node_text(find_first(info_doc, "span", class_="book_newtitle")))
        author = _first_slash_field(book_info3, 0)
        description = clean_text(node_text(find_first(info_doc, "li", class_="book_bk_qs1")))
        cover = absolutize(M_BASE, attr(_first_pred(
            info_doc, lambda n: n.name == "img" and has_ancestor_class(n, "book_info")), "src"))

        chapters = self._parse_chapters(catalog_doc)
        if not chapters:
            raise ValueError("sfacg chapter list not found")

        book = {
            "site": self.key, "id": book_id, "title": title, "author": author,
            "description": description, "source_url": M_BASE + "/b/" + book_id + "/",
            "cover_url": cover, "tags": ([book_info2[0]] if book_info2 else []),
            "chapters": apply_chapter_range(chapters),
        }
        return book

    def _parse_chapters(self, catalog_doc):
        chapters = []
        current_volume = "正文"
        for div in catalog_doc.find_all("div", class_="mulu"):
            text = clean_text(node_text(div))
            if text:
                current_volume = text
            box = _next_element_sibling(div)
            if box is None:
                continue
            for a in box.find_all("a"):
                if not has_ancestor_class(a, "mulu_list"):
                    continue
                href = attr(a, "href").strip()
                m = CHAPTER_RE.match(normalize_path(href))
                if not m:
                    continue
                a_text = node_text(a)
                if "VIP" in a_text:
                    continue
                chapters.append({
                    "id": m.group(1), "title": clean_text(a_text),
                    "url": absolutize(M_BASE, href), "volume": current_volume,
                    "order": len(chapters) + 1,
                })
        return chapters

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        _ = book_id
        chapter_id = (chapter.get("id") or "").strip()
        if not chapter_id:
            raise ValueError("sfacg chapter id is required")
        markup = self._get(M_BASE + "/c/" + chapter_id + "/")
        if "本章为VIP章节" in markup:
            raise ValueError("sfacg vip chapter is not accessible")
        doc = parse_html(markup)

        result = dict(chapter)
        title_node = _first_pred(
            doc, lambda n: n.name == "li" and has_ancestor_class(n, "book_view_top"))
        if clean_text(node_text(title_node)):
            parts = _clean_loose(_first_pred(
                doc, lambda n: n.name == "ul" and _has_class(n, "book_view_top")))
            if len(parts) >= 2:
                result["title"] = parts[1]

        container = _first_pred(doc, lambda n: (
            n.name == "div" and _has_class(n, "yuedu") and _has_class(n, "Content_Frame")))
        if container is None:
            raise ValueError("sfacg chapter content not found")
        paragraphs = _compact_paragraphs(_parse_chapter_paragraphs(container))
        if not paragraphs:
            raise ValueError("sfacg chapter content not found")
        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        from urllib.parse import quote
        url = SEARCH_BASE + "/?Key=" + quote(keyword, safe="") + "&S=1&SS=0"
        markup = self._get(url)
        results = _parse_search_results(markup)
        if limit > 0:
            results = results[:limit]
        for item in results[:5]:
            try:
                book = self.download_plan(item["book_id"])
            except Exception:
                continue
            _fill_from_book(item, book)
        return results

    # ------------------------------------------------------------------
    def _get(self, url):
        return self.http.get(url)


# ---------------------------------------------------------------------------
# 解析工具
# ---------------------------------------------------------------------------
def _first_pred(node, pred):
    return node.find(pred) if node is not None else None


def _has_class(node, class_name):
    return class_name in (node.get("class") or []) if node is not None else False


def _next_element_sibling(node):
    for sib in node.next_siblings:
        if isinstance(sib, Tag):
            return sib
    return None


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


def _clean_loose(node):
    if node is None:
        return []
    text = _clean_text_go(_node_text_breaks(node))
    return [line.strip() for line in text.split("\n") if line.strip()]


def _compact_paragraphs(items):
    out = []
    for item in items:
        item = clean_text(item)
        if item:
            out.append(item)
    return out


def _first_slash_field(items, idx):
    if not items:
        return ""
    parts = items[0].split("/")
    return parts[idx].strip() if idx < len(parts) else ""


def _parse_chapter_paragraphs(container):
    paragraphs = []
    for child in container.children:
        if isinstance(child, NavigableString):
            if isinstance(child, Comment):
                continue
            text = clean_text(str(child))
            if text and not _is_nav_line(text):
                paragraphs.append(text)
            continue
        if not isinstance(child, Tag):
            continue
        if _has_class(child, "yuedu_menu") or _has_class(child, "Tips") \
                or child.name in ("script", "style"):
            continue
        for line in _collect_text_lines(child):
            if _is_nav_line(line):
                continue
            paragraphs.append(line)
    return paragraphs


def _collect_text_lines(node):
    lines = []
    current = []

    def flush():
        text = clean_text("".join(current))
        if text:
            lines.append(text)
        del current[:]

    def walk(n):
        if isinstance(n, NavigableString):
            if not isinstance(n, Comment):
                current.append(str(n))
            return
        if _has_class(n, "yuedu_menu") or _has_class(n, "Tips") \
                or n.name in ("script", "style"):
            return
        if n.name == "br":
            flush()
            return
        is_block = n.name in ("p", "div")
        if is_block:
            flush()
        for child in n.children:
            walk(child)
        if is_block:
            flush()

    walk(node)
    flush()
    return lines


def _is_nav_line(line):
    return line.strip() in ("上一章", "目录", "下一章")


def _search_book_id(raw):
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.startswith("//"):
        raw = "https:" + raw
    if raw.startswith("http://") or raw.startswith("https://"):
        raw = normalize_path(raw)
    m = NOVEL_RE.match(raw)
    return m.group(1) if m else ""


def _parse_search_author(value):
    value = (value or "").strip()
    if value.startswith("综合信息："):
        value = value[len("综合信息："):].strip()
    idx = value.find("/")
    if idx >= 0:
        value = value[:idx]
    return value.strip()


def _parse_search_results(markup):
    doc = parse_html(markup)
    results = []
    seen = set()
    for item in doc.find_all("ul"):
        if "width:100%" not in attr(item, "style"):
            continue
        title_link = None
        for a in item.find_all("a"):
            if _search_book_id(attr(a, "href")):
                title_link = a
                break
        if title_link is None:
            continue
        book_id = _search_book_id(attr(title_link, "href"))
        if not book_id or book_id in seen:
            continue

        info_node = None
        for li in item.find_all("li"):
            if li.parent is item and "Conjunction" not in (li.get("class") or []):
                info_node = li
                break
        lines = _clean_loose(info_node)
        author = _parse_search_author(lines[1]) if len(lines) > 1 else ""
        description = "\n".join(lines[2:]) if len(lines) > 2 else ""

        cover = _first_pred(
            item, lambda n: n.name == "img" and has_ancestor_class(n, "Conjunction"))
        seen.add(book_id)
        results.append({
            "site": "sfacg", "book_id": book_id,
            "title": clean_text(node_text(title_link)),
            "author": author, "description": description,
            "url": absolutize(BOOK_BASE, attr(title_link, "href")),
            "cover_url": absolutize(BOOK_BASE, attr(cover, "src")),
        })
    return results


def _fill_from_book(item, book):
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
    for chapter in reversed(chapters):
        title = (chapter.get("title") or "").strip()
        if title:
            item["latest_chapter"] = title
            break