# -*- coding: utf-8 -*-
"""novelsrc.htmlutil —— DOM 查询与文本清洗工具（对齐 go-novel-dl 的 domutil/substutil）。

底层用 BeautifulSoup（解析器优先 lxml，缺失时回退 html.parser），
函数语义尽量与 Go 版一致，方便逐站移植。
Loshop & Cpt
"""
import re
from urllib.parse import urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup

_WS = re.compile(r"\s+")
_BLOCK_TAGS = ("p", "div", "br", "li", "dd", "dt", "h1", "h2", "h3", "h4",
               "tr", "section", "article", "blockquote")


def parse_html(markup):
    if not markup:
        return BeautifulSoup("", "html.parser")
    try:
        return BeautifulSoup(markup, "lxml")
    except Exception:
        return BeautifulSoup(markup, "html.parser")


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------
def find_by_id(node, elem_id):
    return node.find(id=elem_id) if node is not None else None


def _filter_kwargs(class_, attrs):
    """bs4 4.15 会把 class_=None 当成「必须存在 class 属性」的过滤条件，
    因此只有非 None 时才传入。attrs 同理逐个合并。"""
    kwargs = {}
    if class_ is not None:
        kwargs["class_"] = class_
    if attrs:
        kwargs.update(attrs)
    return kwargs


def find_all(node, name=None, class_=None, attrs=None):
    if node is None:
        return []
    return node.find_all(name, **_filter_kwargs(class_, attrs))


def find_first(node, name=None, class_=None, attrs=None):
    if node is None:
        return None
    return node.find(name, **_filter_kwargs(class_, attrs))


def attr(node, name, default=""):
    if node is None:
        return default
    value = node.get(name)
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        return " ".join(value)
    return value


def has_ancestor_id(node, elem_id):
    parent = node.parent if node is not None else None
    while parent is not None:
        if parent.get("id") == elem_id:
            return True
        parent = parent.parent
    return False


def has_ancestor_class(node, class_name):
    parent = node.parent if node is not None else None
    while parent is not None:
        classes = parent.get("class") or []
        if class_name in classes:
            return True
        parent = parent.parent
    return False


def has_ancestor_tag(node, tag):
    parent = node.parent if node is not None else None
    while parent is not None:
        if parent.name == tag:
            return True
        parent = parent.parent
    return False


# ---------------------------------------------------------------------------
# 文本
# ---------------------------------------------------------------------------
def clean_text(value):
    if not value:
        return ""
    return _WS.sub(" ", value).strip()


def node_text(node):
    if node is None:
        return ""
    return clean_text(node.get_text("", strip=False))


def node_text_lines(node):
    """保留换行的文本：块级元素之间补 \\n，再逐行清理。"""
    if node is None:
        return []
    for br in node.find_all("br"):
        br.replace_with("\n")
    raw = node.get_text("\n", strip=False)
    lines = [clean_text(line) for line in raw.split("\n")]
    return [line for line in lines if line]


def texts(nodes):
    return [t for t in (node_text(n) for n in nodes) if t]


# ---------------------------------------------------------------------------
# URL
# ---------------------------------------------------------------------------
def absolutize(base, href):
    href = (href or "").strip()
    if not href:
        return ""
    return urljoin(base, href)


def normalize_path(href):
    """从 href（可能是完整 URL 或相对路径）里取出 path 部分。"""
    href = (href or "").strip()
    if not href:
        return ""
    if href.startswith("http://") or href.startswith("https://"):
        parts = urlsplit(href)
        return parts.path
    parts = urlsplit(href)
    path = parts.path or href.split("?")[0].split("#")[0]
    return path


def strip_fragment(url):
    parts = urlsplit(url or "")
    return urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, ""))