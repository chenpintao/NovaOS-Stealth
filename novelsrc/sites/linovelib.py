# -*- coding: utf-8 -*-
"""哔哩轻小说（linovelib.com）—— 由 go-novel-dl internal/site/linovelib.go 移植。

注意：本机对 linovelib.com 返回 403，未做联网实测；字符替换表内嵌自
internal/site/resources/linovelib.json（仅 yuedu() 混淆页需要）。
Loshop & Cpt
"""
import re
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit, urlunsplit

from ..base import Site, apply_chapter_range, register
from ..htmlutil import (absolutize, attr, clean_text, find_all, find_by_id,
                        find_first, has_ancestor_class, node_text,
                        node_text_lines, parse_html)
from ._biquge_common import fallback, meta_property

BOOK_RE = re.compile(r"^/novel/(\d+)\.html$")
BOOK_ID_RE = re.compile(r"/novel/(\d+)")
VOL_RE = re.compile(r"/novel/\d+/(vol_\d+)\.html")
CHAPTER_RE = re.compile(r"^/novel/(\d+)/(\d+)(?:_\d+)?\.html$")
CHAPTER_PAGE_RE = re.compile(r"^/novel/(\d+)/(\d+)(?:_(\d+))?\.html$")
STORE_RE = re.compile(r"_(\d+)_0\.html$")
SEARCH_JS_RE = re.compile(r'jieqiSearchJs=([^;"]+)')
SPACE_RE = re.compile(r"\s+")

BASE = "https://www.linovelib.com"
IMAGE_BASE = "https://www.linovelib.com"
COVER_BASE = "https://www.bilinovel.com"
CHROME_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

DEFAULT_STORE_PATH = "/wenku/lastupdate_0_0_0_0_0_0_0_1_0.html"

# internal/site/resources/linovelib.json（U+E800..U+E865 -> 汉字）
SUBST_MAP = {
    "\ue800": "只", "\ue801": "呻", "\ue802": "就", "\ue803": "去",
    "\ue804": "之", "\ue805": "里", "\ue806": "唇", "\ue807": "性",
    "\ue808": "多", "\ue809": "在", "\ue80a": "一", "\ue80b": "你",
    "\ue80c": "对", "\ue80d": "那", "\ue80e": "她", "\ue80f": "没",
    "\ue810": "样", "\ue811": "于", "\ue812": "和", "\ue813": "年",
    "\ue814": "液", "\ue815": "还", "\ue816": "以", "\ue817": "肉",
    "\ue818": "看", "\ue819": "家", "\ue81a": "穴", "\ue81b": "事",
    "\ue81c": "乳", "\ue81d": "天", "\ue81e": "可", "\ue81f": "我",
    "\ue820": "道", "\ue821": "会", "\ue822": "为", "\ue823": "自",
    "\ue824": "能", "\ue825": "起", "\ue826": "到", "\ue827": "阴",
    "\ue828": "茎", "\ue829": "生", "\ue82a": "么", "\ue82b": "脱",
    "\ue82c": "了", "\ue82d": "出", "\ue82e": "如", "\ue82f": "欲",
    "\ue830": "学", "\ue831": "着", "\ue832": "好", "\ue833": "国",
    "\ue834": "淫", "\ue835": "中", "\ue836": "是", "\ue837": "发",
    "\ue838": "子", "\ue839": "小", "\ue83a": "私", "\ue83b": "不",
    "\ue83c": "的", "\ue83d": "后", "\ue83e": "第", "\ue83f": "来",
    "\ue840": "种", "\ue841": "上", "\ue842": "个", "\ue843": "然",
    "\ue844": "舔", "\ue845": "胸", "\ue846": "而", "\ue847": "他",
    "\ue848": "开", "\ue849": "也", "\ue84a": "地", "\ue84b": "过",
    "\ue84c": "把", "\ue84d": "美", "\ue84e": "成", "\ue84f": "这",
    "\ue850": "说", "\ue851": "要", "\ue852": "下", "\ue853": "得",
    "\ue854": "小", "\ue855": "着", "\ue856": "想", "\ue857": "到",
    "\ue858": "们", "\ue859": "时", "\ue85a": "大", "\ue85b": "地",
    "\ue85c": "里", "\ue85d": "说", "\ue85e": "就", "\ue85f": "去",
    "\ue860": "子", "\ue861": "会", "\ue862": "着", "\ue863": "和",
    "\ue864": "是", "\ue865": "她",
}


def _go_path(raw):
    """对齐 Go normalizeESJPath：有主机时取 path，否则返回原值。"""
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


def _first_class(node, tag, class_name):
    for item in find_all(node, tag):
        if class_name in (item.get("class") or []):
            return item
    return None


def _first_ancestor_class(node, tag, class_name):
    for item in find_all(node, tag):
        if has_ancestor_class(item, class_name):
            return item
    return None


def _meta_name(doc, name):
    for node in find_all(doc, "meta"):
        if attr(node, "name") == name:
            content = attr(node, "content").strip()
            if content:
                return content
    return ""


def _apply_subst(text):
    out = []
    for ch in text:
        out.append(SUBST_MAP.get(ch, ch))
    return "".join(out)


def _chapter_page_url(book_id, chapter_id, page):
    if page <= 1:
        return "%s/novel/%s/%s.html" % (BASE, book_id, chapter_id)
    return "%s/novel/%s/%s_%d.html" % (BASE, book_id, chapter_id, page)


def _collect_volume_ids(markup):
    volumes = []
    seen = set()
    for vol_id in VOL_RE.findall(markup or ""):
        vol_id = vol_id.strip()
        if not vol_id or vol_id in seen:
            continue
        seen.add(vol_id)
        volumes.append(vol_id)
    return volumes


def _chapterlog_order(n, cid):
    if n <= 0:
        return []
    if n <= 20:
        return list(range(n))
    fixed = list(range(20))
    rest = list(range(20, n))
    m, a, c = 233280, 9302, 49397
    s = cid * 127 + 235
    for i in range(len(rest) - 1, 0, -1):
        s = (s * a + c) % m
        j = (s * (i + 1)) // m
        rest[i], rest[j] = rest[j], rest[i]
    return fixed + rest


def _reorder_nodes(nodes, chapter_id):
    n = len(nodes)
    if n <= 20 or chapter_id == 0:
        return nodes
    order = _chapterlog_order(n, chapter_id)
    reordered = [None] * n
    for idx, node in enumerate(nodes):
        reordered[order[idx]] = node
    return reordered


def _chapterlog_paragraph(node):
    if node is None or node.name != "p":
        return False
    inner = "".join(str(child) for child in node.children)
    return SPACE_RE.sub("", inner) != ""


def _paragraph_text(node):
    if node is None:
        return ""
    return node.get_text("")


def _resolve_chapter_page_url(base_url, raw_url, book_id, chapter_id, page):
    raw_url = (raw_url or "").strip()
    if not raw_url or raw_url.lower().startswith("javascript:"):
        return ""
    resolved = absolutize(base_url, raw_url)
    candidate = resolved
    if not (candidate.startswith("http://") or candidate.startswith("https://")):
        candidate = "https://" + candidate
    try:
        parts = urlsplit(candidate)
    except ValueError:
        return ""
    match = CHAPTER_PAGE_RE.match(parts.path)
    if not match or match.group(1) != book_id or match.group(2) != chapter_id:
        return ""
    target = 1
    if match.group(3):
        try:
            target = int(match.group(3))
        except ValueError:
            target = 1
    if target != page:
        return ""
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _next_page_url(markup, doc, current_url, book_id, chapter_id, current_page):
    target = current_page + 1
    for a in find_all(doc, "a"):
        resolved = _resolve_chapter_page_url(
            current_url, attr(a, "href"), book_id, chapter_id, target)
        if resolved:
            return resolved
    expected_path = "/novel/%s/%s_%d.html" % (book_id, chapter_id, target)
    if expected_path in markup:
        return absolutize(BASE, expected_path)
    expected_relative = "%s_%d.html" % (chapter_id, target)
    if expected_relative in markup:
        return absolutize(current_url, expected_relative)
    return ""


# ---------------------------------------------------------------------------
# 索引搜索（searchFromIndex 回退路径）用到的打分工具
# ---------------------------------------------------------------------------
def _normalize_search_text(value):
    value = (value or "").replace("妳", "你").replace("祢", "你").strip()
    if not value:
        return ""
    value = value.lower()
    return "".join(ch for ch in value if ch.isalnum())


def _search_score(item, keyword):
    title = _normalize_search_text(item.get("title"))
    author = _normalize_search_text(item.get("author"))
    description = _normalize_search_text(item.get("description"))
    latest = _normalize_search_text(item.get("latest_chapter"))

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
    keyword_norm = _normalize_search_text(keyword)
    if not keyword_norm:
        return []
    scored = []
    for item in items:
        score = _search_score(item, keyword_norm)
        if score <= 0:
            continue
        scored.append((score, item))
    scored.sort(key=lambda pair: (
        -pair[0],
        -len(pair[1].get("description") or ""),
        pair[1].get("book_id") or "",
    ))
    if limit > 0 and len(scored) > limit:
        scored = scored[:limit]
    return [item for _, item in scored]


def _dedupe_results(items):
    if not items:
        return []
    seen = set()
    out = []
    for item in items:
        book_id = item.get("book_id")
        if not book_id:
            continue
        key = (item.get("site") or "") + "|" + book_id
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# 搜索结果页解析
# ---------------------------------------------------------------------------
def _parse_s6_results(markup, limit):
    doc = parse_html(markup)
    results = []
    for item in find_all(doc, "div"):
        if "search-result-list" not in (item.get("class") or []):
            continue
        title_node = _first_class(item, "h2", "tit")
        title_link = find_first(title_node, "a") if title_node is not None else None
        match = BOOK_ID_RE.search(_go_path(attr(title_link, "href")))
        if not match:
            continue
        title = clean_text(node_text(title_node))
        if not title:
            continue
        author = ""
        info = _first_class(item, "div", "bookinfo")
        if info is not None:
            link = find_first(info, "a")
            if link is not None:
                author = clean_text(node_text(link))
        description = clean_text(_preserve_lines(find_first(item, "p")))
        cover = ""
        box = _first_class(item, "div", "se-result-book")
        if box is not None:
            img = find_first(box, "img")
            if img is not None:
                cover = attr(img, "data-original").strip() or attr(img, "src").strip()
        results.append({
            "site": "linovelib", "book_id": match.group(1), "title": title,
            "author": author, "description": description,
            "url": "%s/novel/%s.html" % (BASE, match.group(1)),
            "cover_url": absolutize(BASE, cover),
        })
        if limit > 0 and len(results) >= limit:
            break
    return results


def _parse_search_results(markup, limit):
    doc = parse_html(markup)
    results = []
    for li in find_all(doc, "li"):
        if "book-li" not in (li.get("class") or []):
            continue
        link = find_first(li, "a")
        match = BOOK_RE.match(_go_path(attr(link, "href")))
        if not match:
            continue
        title = clean_text(node_text(_first_class(li, "h4", "book-title")))
        if not title:
            continue
        cover = ""
        img = _first_ancestor_class(li, "img", "book-cover")
        if img is not None:
            cover = attr(img, "data-src").strip() or attr(img, "src").strip()
        author = clean_text(node_text(_first_class(li, "span", "book-author")))
        if author.startswith("作者"):
            author = author[len("作者"):].strip()
        description = clean_text(_preserve_lines(_first_class(li, "p", "book-desc")))
        results.append({
            "site": "linovelib", "book_id": match.group(1), "title": title,
            "author": author, "description": description,
            "url": "%s/novel/%s.html" % (BASE, match.group(1)),
            "cover_url": absolutize(COVER_BASE, cover),
        })
        if limit > 0 and len(results) >= limit:
            break
    return results


def _single_book_id(doc):
    for prop in ("og:url", "og:novel:read_url", "og:novel:latest_chapter_url"):
        raw = meta_property(doc, prop)
        if raw:
            match = BOOK_ID_RE.search(_go_path(raw))
            if match:
                return match.group(1)
    raw = _meta_name(doc, "url")
    if raw:
        match = BOOK_ID_RE.search(_go_path(raw))
        if match:
            return match.group(1)
    for a in find_all(doc, "a"):
        match = BOOK_ID_RE.search(_go_path(attr(a, "href")))
        if match:
            return match.group(1)
    return ""


def _parse_single_book(markup):
    doc = parse_html(markup)
    title = meta_property(doc, "og:novel:book_name") or meta_property(doc, "og:title")
    if not title:
        return None
    book_id = _single_book_id(doc)
    if not book_id:
        return None
    description = meta_property(doc, "og:description")
    if not description:
        description = clean_text(_preserve_lines(_first_class(doc, "div", "book-dec")))
    return {
        "site": "linovelib", "book_id": book_id, "title": clean_text(title),
        "author": clean_text(meta_property(doc, "og:novel:author")),
        "description": description,
        "url": "%s/novel/%s.html" % (BASE, book_id),
        "cover_url": meta_property(doc, "og:image"),
    }


def _parse_store_page(markup):
    doc = parse_html(markup)
    results = []
    for box in find_all(doc, "div"):
        if "bookbox" not in (box.get("class") or []):
            continue
        title_link = _first_ancestor_class(box, "a", "bookname")
        match = BOOK_RE.match(_go_path(attr(title_link, "href")))
        if not match:
            continue
        info_line = _first_class(box, "div", "bookilnk")
        spans = find_all(info_line, "span")
        author = clean_text(node_text(spans[0])) if spans else ""
        cover_node = _first_ancestor_class(box, "img", "bookimg")
        cover = attr(cover_node, "data-original").strip()
        if not cover:
            cover = attr(cover_node, "src").strip()
        results.append({
            "site": "linovelib", "book_id": match.group(1),
            "title": clean_text(node_text(title_link)), "author": author,
            "description": clean_text(_preserve_lines(_first_class(box, "div", "bookintro"))),
            "url": absolutize(BASE, attr(title_link, "href")),
            "cover_url": absolutize(BASE, cover),
        })
    total, template = _parse_store_pagination(doc)
    return results, total, template


def _parse_store_pagination(doc):
    total = 1
    stats = clean_text(node_text(find_by_id(doc, "pagestats")))
    if stats:
        match = re.search(r"(\d+)/(\d+)", stats)
        if match:
            try:
                total = int(match.group(2))
            except ValueError:
                pass
    last_path = attr(find_first(doc, "a", class_="last"), "href").strip()
    if not last_path:
        last_path = attr(find_first(doc, "a", class_="next"), "href").strip()
    if not last_path:
        last_path = DEFAULT_STORE_PATH
    if total < 1:
        total = _page_number(last_path)
    if total < 1:
        total = 1
    return total, last_path


def _page_number(path):
    match = STORE_RE.search(path or "")
    if not match:
        return 0
    try:
        return int(match.group(1))
    except ValueError:
        return 0


def _store_page_url(path, page):
    if page <= 1:
        return BASE + "/wenku/"
    if not (path or "").strip():
        path = DEFAULT_STORE_PATH
    if STORE_RE.search(path):
        path = STORE_RE.sub("_%d_0.html" % page, path)
    return absolutize(BASE, path)


@register
class LinovelibSite(Site):
    key = "linovelib"
    display_name = "哔哩轻小说"
    tags = ["简体中文", "轻小说", "转载站"]
    hosts = ["linovelib.com"]

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
        if host != "linovelib.com":
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
        info_markup = self._get_with_retry("%s/novel/%s.html" % (BASE, book_id))
        volumes = []
        catalog_markup = None
        catalog_err = None
        try:
            catalog_markup = self._get_with_retry("%s/novel/%s/catalog" % (BASE, book_id))
        except Exception as exc:
            catalog_err = exc
        if catalog_markup is not None:
            volumes = _collect_volume_ids(catalog_markup)
        if not volumes:
            volumes = _collect_volume_ids(info_markup)
            # 详情页通常「最新章节」的卷在最前，导出需要从第一卷开始的阅读顺序
            volumes.reverse()
        if not volumes and catalog_err is not None:
            raise catalog_err

        info_doc = parse_html(info_markup)
        book_name = fallback(meta_property(info_doc, "og:novel:book_name"),
                             meta_property(info_doc, "og:title"))
        book = {
            "site": self.key, "id": book_id, "title": book_name,
            "author": fallback(meta_property(info_doc, "og:novel:author"),
                               clean_text(node_text(_first_ancestor_class(info_doc, "a", "au-name")))),
            "description": fallback(meta_property(info_doc, "og:description"),
                                    clean_text(node_text(_first_class(info_doc, "div", "book-dec")))),
            "source_url": "%s/novel/%s.html" % (BASE, book_id),
            "cover_url": fallback(meta_property(info_doc, "og:image"),
                                  attr(_first_ancestor_class(info_doc, "img", "book-img"), "src")),
        }
        chapters = []
        for vol_id in volumes:
            vol_markup = self._get_with_retry(
                "%s/novel/%s/%s.html" % (BASE, book_id, vol_id))
            vol_doc = parse_html(vol_markup)
            volume_name = fallback(meta_property(vol_doc, "og:title"),
                                   clean_text(node_text(_first_class(vol_doc, "h1", "book-name"))))
            if book_name and volume_name.startswith(book_name):
                volume_name = volume_name[len(book_name):].lstrip(" ：:·-—")
            for a in find_all(vol_doc, "a"):
                if not has_ancestor_class(a, "book-new-chapter"):
                    continue
                href = attr(a, "href")
                match = CHAPTER_RE.match(_go_path(href))
                if not match:
                    continue
                chapters.append({
                    "id": match.group(2), "title": clean_text(node_text(a)),
                    "url": absolutize(BASE, href), "volume": volume_name,
                    "order": len(chapters) + 1,
                })
        book["chapters"] = apply_chapter_range(chapters)
        return book

    # ------------------------------------------------------------------
    def fetch_chapter(self, book_id, chapter):
        result = dict(chapter)
        chapter_id = (result.get("id") or "").strip()
        if not book_id or not chapter_id:
            raise ValueError("linovelib book id and chapter id are required")

        paragraphs = []
        current_url = _chapter_page_url(book_id, chapter_id, 1)
        visited = set()
        idx = 1
        while True:
            if current_url in visited:
                break
            visited.add(current_url)
            try:
                markup = self._get_with_retry(current_url)
            except Exception:
                if idx == 1:
                    raise
                break
            doc = parse_html(markup)
            container = find_by_id(doc, "mlfy_main_text")
            if container is not None and clean_text(node_text(container)):
                h1 = find_first(container, "h1")
                if h1 is not None:
                    result["title"] = clean_text(node_text(h1))
            paragraphs.extend(self._parse_chapter_page(markup, doc, chapter_id))
            next_url = _next_page_url(markup, doc, current_url, book_id, chapter_id, idx)
            if not next_url:
                break
            current_url = next_url
            idx += 1

        if not paragraphs:
            raise ValueError("linovelib chapter content not found")
        result["content"] = "\n".join(paragraphs)
        result["downloaded"] = True
        return result

    def _parse_chapter_page(self, markup, doc, chapter_id):
        container = find_by_id(doc, "TextContent")
        if container is None:
            return []
        use_subst = ("yuedu()" in markup
                     and "/themes/zhpc/js/pctheme.js" in markup)
        use_shuffle = "/scripts/chapterlog.js" in markup

        children = [child for child in container.children
                    if getattr(child, "name", None) is not None]
        if use_shuffle:
            try:
                cid = int(chapter_id)
            except (TypeError, ValueError):
                cid = 0
            slots = []
            nodes = []
            for index, child in enumerate(children):
                if _chapterlog_paragraph(child):
                    slots.append(index)
                    nodes.append(child)
            nodes = _reorder_nodes(nodes, cid)
            for index, slot in enumerate(slots):
                children[slot] = nodes[index]

        paragraphs = []
        for child in children:
            if child.name == "p":
                text = _paragraph_text(child)
                if use_subst:
                    text = _apply_subst(text)
                text = clean_text(text)
                if text:
                    paragraphs.append(text)
            elif child.name == "img":
                src = attr(child, "data-src").strip() or attr(child, "src").strip()
                if src:
                    paragraphs.append("[图片] " + absolutize(IMAGE_BASE, src))
        return paragraphs

    # ------------------------------------------------------------------
    def search(self, keyword, limit=0):
        keyword = (keyword or "").strip()
        if not keyword:
            return []
        if limit <= 0:
            limit = 30

        # PC 主站 /S6/：先过 search_guard 反爬，再 POST 搜索
        self._search_guard()
        markup = self._search_post(keyword)
        results = _parse_s6_results(markup, limit)
        if results:
            return results
        results = _parse_search_results(markup, limit)
        if results:
            return results
        single = _parse_single_book(markup)
        if single is not None:
            return [single]
        return self._search_from_index(keyword, limit)

    def _search_guard(self):
        def get(url):
            return self.http.get(url, headers={"User-Agent": CHROME_UA})

        get(BASE + "/S6/")
        get(BASE + "/S6/?search_guard=css")
        js = get(BASE + "/S6/?search_guard=js")
        match = SEARCH_JS_RE.search(js or "")
        if match:
            try:
                self.http.session.cookies.set(
                    "jieqiSearchJs", match.group(1),
                    domain="linovelib.com", path="/")
            except Exception:
                pass
        for i in range(3):
            r = str(int(time.time() * 1000)) + str(i)
            get(BASE + "/S6/?search_guard=redeem&r=" + r)

    def _search_post(self, keyword):
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": BASE + "/S6/",
            "Origin": BASE,
            "User-Agent": CHROME_UA,
        }
        return self.http.post_form(BASE + "/S6/", {"searchkey": keyword},
                                   headers=headers)

    def _search_from_index(self, keyword, limit):
        items = self._build_search_index()
        results = _search_cached_results(items, keyword, limit)
        self._enrich(results)
        return results

    def _build_search_index(self):
        first_page = self._get_with_retry(BASE + "/wenku/")
        page_items, total_pages, page_template = _parse_store_page(first_page)
        if total_pages <= 1:
            return _dedupe_results(page_items)

        results = list(page_items)
        pages = range(2, total_pages + 1)
        workers = min(8, max(1, total_pages - 1))

        def fetch(page):
            return self._get_with_retry(_store_page_url(page_template, page))

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(fetch, page) for page in pages]
            for future in futures:
                markup = future.result()
                items, _, _ = _parse_store_page(markup)
                results.extend(items)
        return _dedupe_results(results)

    def _enrich(self, results):
        targets = [item for item in results[:6] if item.get("book_id")]
        if not targets:
            return
        with ThreadPoolExecutor(max_workers=min(6, len(targets))) as pool:
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
        book_id = item["book_id"]
        markup = self._get_with_retry("%s/novel/%s.html" % (BASE, book_id))
        doc = parse_html(markup)
        title = fallback(meta_property(doc, "og:title"),
                         clean_text(node_text(_first_class(doc, "h1", "book-name"))))
        if title:
            item["title"] = title
        author = fallback(meta_property(doc, "og:novel:author"),
                          clean_text(node_text(_first_ancestor_class(doc, "a", "au-name"))))
        if author:
            item["author"] = author
        description = fallback(meta_property(doc, "og:description"),
                               clean_text(node_text(_first_class(doc, "div", "book-dec"))))
        if description:
            item["description"] = description
        cover = fallback(meta_property(doc, "og:image"),
                         attr(_first_ancestor_class(doc, "img", "book-img"), "src"))
        if cover:
            item["cover_url"] = cover
        latest = fallback(
            meta_property(doc, "og:novel:latest_chapter_name"),
            clean_text(node_text(_first_ancestor_class(doc, "a", "book-new-chapter"))))
        if latest:
            item["latest_chapter"] = latest
        item["url"] = "%s/novel/%s.html" % (BASE, book_id)

    # ------------------------------------------------------------------
    def _get_with_retry(self, url):
        return self.http.get(url)