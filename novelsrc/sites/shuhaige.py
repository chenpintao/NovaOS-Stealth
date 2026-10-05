# -*- coding: utf-8 -*-
"""书海阁小说网（shuhaige.net）—— 由 go-novel-dl internal/site/shuhaige.go 移植。
Loshop & Cpt
"""
import re
from urllib.parse import urlsplit

from ..base import Site, apply_chapter_range, dedup_chapters, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_by_id,
                        find_first, has_ancestor_class, has_ancestor_id,
                        node_text, node_text_lines, normalize_path, parse_html)

BOOK_RE = re.compile(r"^/(\d+)/?$")
CHAPTER_RE = re.compile(r"^/(\d+)/(\d+)(?:_(\d+))?\.html$")

BASE = "https://www.shuhaige.net"


@register
class ShuhaigeSite(Site):
    key = "shuhaige"
    display_name = "书海阁小说网"
    tags = ["简体中文", "转载站", "笔趣阁"]
    hosts = ["shuhaige.net"]

    def resolve_url(self, raw_url):
        path = normalize_path(raw_url)
        host = (urlsplit(raw_url).hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if host != "shuhaige.net":
            return None
        m = CHAPTER_RE.match(path)
        if m:
            return {
                "site": self.key, "book_id": m.group(1), "chapter_id": m.group(2),
                "canonical": "%s/%s/%s.html" % (BASE, m.group(1), m.group(2)),
            }
        m = BOOK_RE.match(path)
        if m:
            return {"site": self.key, "book_id": m.group(1),
                    "canonical": "%s/%s/" % (BASE, m.group(1))}
        return None

    # ------------------------------------------------------------------
    def download_plan(self, book_id):
        book_id = (book_id or "").strip()
        if not book_id:
            raise ValueError("book id is required")
        markup = self._get(BASE + "/" + book_id + "/")
        doc = parse_html(markup)

        info = find_by_id(doc, "info")
        title = node_text(info)
        h1 = find_first(info, "h1")
        if h1 is not None:
            title = node_text(h1)

        author = ""
        for p in find_all(info, "p"):
            line = node_text(p)
            if "作" in line and "者" in line:
                author = line.replace("作者：", "").replace("作者:", "").strip()
                a = find_first(p, "a")
                if a is not None:
                    author = node_text(a)
                break

        intro = find_by_id(doc, "intro")
        desc = node_text(find_first(intro, "p"))
        fmimg = find_by_id(doc, "fmimg")
        cover = absolutize(BASE, attr(find_first(fmimg, "img"), "src"))

        chapters = self._parse_chapters(doc)
        if not chapters:
            raise ValueError("shuhaige chapter list not found")

        return {
            "site": self.key, "id": book_id, "title": title, "author": author,
            "description": desc, "source_url": "%s/%s/" % (BASE, book_id),
            "cover_url": cover, "chapters": apply_chapter_range(dedup_chapters(chapters)),
        }

    def _parse_chapters(self, doc):
        list_node = find_by_id(doc, "list")
        if list_node is None:
            return []
        chapters = []
        collect = False
        for node in list_node.find_all(recursive=False):
            if node.name != "dl":
                continue
            for child in node.find_all(recursive=False):
                if child.name == "dt":
                    if "正文" in node_text(child):
                        collect = True
                elif child.name == "dd":
                    if not collect:
                        continue
                    a = find_first(child, "a")
                    if a is None:
                        continue
                    href = attr(a, "href").strip()
                    m = CHAPTER_RE.match(normalize_path(href))
                    if not m:
                        continue
                    chapters.append({"id": m.group(2), "title": node_text(a),
                                     "url": absolutize(BASE, href),
                                     "order": len(chapters) + 1})
        if chapters:
            return chapters
        for a in find_all(list_node, "a"):
            href = attr(a, "href").strip()
            m = CHAPTER_RE.match(normalize_path(href))
            if not m:
                continue
            chapters.append({"id": m.group(2), "title": node_text(a),
                             "url": absolutize(BASE, href),
                             "order": len(chapters) + 1})
        return chapters

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        book_id = (book_id or "").strip()
        chapter_id = (chapter.get("id") or "").strip()
        if not book_id or not chapter_id:
            raise ValueError("shuhaige book id and chapter id are required")

        pages = []
        idx = 1
        while True:
            if idx == 1:
                url = "%s/%s/%s.html" % (BASE, book_id, chapter_id)
            else:
                url = "%s/%s/%s_%d.html" % (BASE, book_id, chapter_id, idx)
            try:
                markup = self._get(url)
            except Exception:
                if idx == 1:
                    raise
                break
            pages.append(markup)
            if ("%s_%d.html" % (chapter_id, idx + 1)) not in markup:
                break
            idx += 1

        title, paragraphs = self._parse_content(pages)
        result = dict(chapter)
        if not result.get("title"):
            result["title"] = title
        if not paragraphs:
            raise ValueError("shuhaige chapter content not found")
        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    @staticmethod
    def _parse_content(raw_pages):
        title = ""
        paragraphs = []
        for raw in raw_pages:
            doc = parse_html(raw)
            if not title:
                for h1 in doc.find_all("h1"):
                    if has_ancestor_class(h1, "bookname"):
                        title = node_text(h1)
                        break
            content = find_by_id(doc, "content")
            if content is None:
                continue
            for p in find_all(content, "p"):
                for line in node_text_lines(p):
                    if _is_ad_line(line):
                        continue
                    line = line.strip()
                    if line.endswith("(本章完)"):
                        line = line[:-len("(本章完)")].strip()
                    if line:
                        paragraphs.append(line)
        return title, paragraphs

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        import time as _time
        now = int(_time.time())
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": BASE,
            "Referer": BASE + "/",
            "Cookie": ("Hm_lpvt_3094b20ed277f38e8f9ac2b2b29d6263=%d; "
                       "Hm_lpvt_c3da01855456ad902664af23cc3254cb=%d" % (now, now)),
        }
        markup = self.http.post_form(BASE + "/search.html",
                                     {"searchtype": "all", "searchkey": keyword},
                                     headers=headers)
        results = self._parse_search(markup)
        if limit > 0:
            results = results[:limit]
        return results

    def _parse_search(self, markup):
        doc = parse_html(markup)
        results = []
        seen = set()
        for row in find_all(doc, "dl"):
            if not has_ancestor_id(row, "sitembox"):
                continue
            link = None
            for a in find_all(row, "a"):
                if a.find_parent("h3") is not None:
                    link = a
                    break
            if link is None:
                for a in find_all(row, "a"):
                    if a.find_parent("dt") is not None:
                        link = a
                        break
            if link is None:
                continue
            href = absolutize(BASE, attr(link, "href"))
            m = BOOK_RE.match(normalize_path(href))
            if not m:
                continue
            book_id = m.group(1)
            if book_id in seen:
                continue
            seen.add(book_id)

            title = node_text(link)
            if not title:
                title = attr(find_first(row, "img"), "alt").strip()
            if not title:
                continue

            author = "-"
            for span in find_all(row, "span"):
                if has_ancestor_class(span, "book_other"):
                    author = node_text(span) or "-"
                    break
            latest = "-"
            for a in find_all(row, "a"):
                if has_ancestor_class(a, "book_other"):
                    latest = node_text(a) or "-"
                    break
            cover = absolutize(BASE, attr(find_first(row, "img"), "src"))

            results.append({
                "site": self.key, "book_id": book_id, "title": title,
                "author": author, "latest_chapter": latest, "url": href,
                "cover_url": cover,
            })
        return results

    # ------------------------------------------------------------------
    def _get(self, url):
        return self.http.get(url, headers={"Referer": BASE + "/"})


def _is_ad_line(line):
    normalized = clean_text(line).lower()
    if not normalized:
        return True
    if "shuhaige.net" in normalized or "书海阁" in normalized:
        return True
    if "点击下一页" in normalized or "最新网址" in normalized:
        return True
    return False