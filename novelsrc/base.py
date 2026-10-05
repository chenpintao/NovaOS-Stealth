# -*- coding: utf-8 -*-
"""novelsrc.base —— 站点基类与注册表。

由 go-novel-dl（internal/site）的 Site 接口移植而来，保持同样的能力划分：
  search        关键词搜索 -> [SearchResult]
  download_plan 书目 + 章节目录（不抓正文）
  fetch_chapter 抓单章正文
  download      download_plan + 逐章抓正文
  resolve_url   把站内 URL 反解成 {site, book_id, chapter_id}
纯 Python 3.8 兼容（不得使用 3.9+ 语法）。
Loshop & Cpt
"""
from .http import HttpClient


class Site(object):
    """所有书源的基类。子类设置类属性并实现对应方法。"""

    key = ""
    display_name = ""
    tags = []
    hosts = []
    searchable = True
    downloadable = True
    login_required = False
    timeout = 20.0
    use_mirrors = False

    def __init__(self, cfg=None):
        self.cfg = cfg or {}
        self.http = HttpClient(timeout=self._timeout())

    # ---- 可覆盖点：允许子类按配置调整超时/镜像 ----
    def _timeout(self):
        value = self.cfg.get("timeout") if isinstance(self.cfg, dict) else None
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = 0.0
        return value if value > self.timeout else self.timeout

    def descriptor(self):
        return {
            "key": self.key,
            "display_name": self.display_name or self.key,
            "tags": list(self.tags or []),
            "capabilities": {
                "search": bool(self.searchable),
                "download": bool(self.downloadable),
                "login": bool(self.login_required),
            },
            "default_available": True,
        }

    # ---- 子类实现 ----
    def search(self, keyword, limit=0):
        return []

    def download_plan(self, book_id):
        raise NotImplementedError(self.key + ".download_plan")

    def fetch_chapter(self, book_id, chapter):
        raise NotImplementedError(self.key + ".fetch_chapter")

    def resolve_url(self, raw_url):
        return None

    # ---- 通用实现 ----
    def download(self, book_id, start_id=None, end_id=None, ignore_ids=None):
        book = self.download_plan(book_id)
        chapters = book.get("chapters") or []
        for idx, chapter in enumerate(chapters):
            loaded = self.fetch_chapter(book_id, chapter)
            loaded["order"] = idx + 1
            chapters[idx] = loaded
        book["chapters"] = chapters
        return book


# ---------------------------------------------------------------------------
# 注册表
# ---------------------------------------------------------------------------
SITES = {}


def register(cls):
    """类装饰器：把站点类登记进全局表。"""
    key = (cls.key or "").strip()
    if not key:
        raise ValueError("site class %r has no key" % cls)
    if key in SITES:
        raise ValueError("duplicate site key: %s" % key)
    SITES[key] = cls
    return cls


def site_keys():
    return sorted(SITES.keys())


def get_site(key, cfg=None):
    cls = SITES.get((key or "").strip())
    return cls(cfg) if cls else None


def all_sites(cfg_map=None):
    cfg_map = cfg_map or {}
    return [SITES[k](cfg_map.get(k)) for k in site_keys()]


# ---------------------------------------------------------------------------
# 章节列表通用处理（对应 go-novel-dl 的 dedupChapters / applyChapterRange）
# ---------------------------------------------------------------------------
def dedup_chapters(chapters):
    seen = set()
    out = []
    for ch in chapters or []:
        key = ch.get("id") or ch.get("url") or ch.get("title")
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(ch)
    return out


def apply_chapter_range(chapters, start_id=None, end_id=None, ignore_ids=None):
    """按起止章节 ID 截取；ID 未命中时保留全部（与 Go 版一致）。"""
    items = list(chapters or [])
    ignore = set(ignore_ids or [])
    start_id = (start_id or "").strip()
    end_id = (end_id or "").strip()

    def index_of(target):
        for i, ch in enumerate(items):
            if ch.get("id") == target:
                return i
        return -1

    if start_id:
        i = index_of(start_id)
        if i >= 0:
            items = items[i:]
    if end_id:
        j = index_of(end_id)
        if j >= 0:
            items = items[:j + 1]
    if ignore:
        items = [ch for ch in items if ch.get("id") not in ignore]
    return items