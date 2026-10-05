# -*- coding: utf-8 -*-
"""novelsrc.lncrawl_bridge —— lightnovel-crawler 3.x（3.10.1）适配桥。

目标：Windows 7 只能用 Python 3.8，故只能用 lncrawl 3.10.1（4.x 需要更高
版本 Python）。但 3.10.1 与 4.x 的 API 完全不同：

  4.x：  from lncrawl.context import ctx
         ctx.sources.ensure_load() / ctx.sources.list()
         ctx.sources.init_crawler(url, timeout=, probe=)
         crawler.search(q) / crawler.read_novel(Novel) / crawler.download_chapter(Chapter)

  3.10.1（本模块适配）：
         from lncrawl.core.sources import load_sources, crawler_list, prepare_crawler
         load_sources()            # 递归加载内置 sources/ 下全部 crawler 类
         prepare_crawler(url)      # 按源 url 实例化 crawler（等价 init_crawler）
         crawler.search_novel(q)   # -> List[SearchResult(title/url/info)]
         crawler.read_novel_info() # 填充 crawler.novel_title/novel_author/novel_cover/
                                   #      novel_synopsis/novel_tags/volumes/chapters
         crawler.download_chapter_body(chapter) -> str

本模块把上述差异包装成与 novelsrc.facade.LncrawlBridge 完全一致的鸭子接口
（source_count / search / novel / chapter），供 facade 优先选用；若环境实为
lncrawl 4.x（不存在 lncrawl.core.sources）则导入即失败，facade 自动回退旧路径。

注意：3.10.1 的源索引是「随包内置 + 可联网更新」的模型，联网同步/下载源在
Win7 离线环境既慢又易失败，故强制 dev 模式（只读内置 sources/）。
Loshop & Cpt
"""
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as _FutureTimeout
from urllib.parse import urlparse

# 必须在 import lncrawl 之前设置：dev 模式跳过联网同步/下载源
os.environ.setdefault("LNCRAWL_MODE", "dev")

_KEY = "lncrawl"

_LOCK = threading.Lock()
_SOURCES = None  # 缓存 _Source 列表


class _Source(object):
    """与 4.x Source 对象对齐的鸭子类型（供 facade / server 使用）。"""

    __slots__ = ("url", "domain", "language", "can_search", "is_disabled")

    def __init__(self, url, crawler_cls):
        self.url = url
        self.language = (getattr(crawler_cls, "language", "") or "").lower()
        self.domain = urlparse(url).hostname or url
        self.can_search = bool(getattr(crawler_cls, "can_search", False))
        self.is_disabled = bool(getattr(crawler_cls, "is_disabled", False))


def bound_timeout(crawler, timeout):
    """给 crawler 注入统一的 (连接, 读取) 超时。

    3.10.1 的 Scraper 默认读取超时高达 301 秒，且 post/head 等路径完全不传
    timeout，个别源被墙时会长久挂起。这里在底层 session.request 上兜底，
    覆盖 get / post / head 全部请求。
    """
    connect = float(timeout) if timeout else 15.0
    read = max(connect, 20.0)
    scraper = getattr(crawler, "scraper", None)
    if scraper is not None and not getattr(scraper, "_lncrawl_bounded", False):
        try:
            orig_request = scraper.request

            def _request(method, url, **kwargs):
                kwargs.setdefault("timeout", (connect, read))
                return orig_request(method, url, **kwargs)

            scraper.request = _request
            scraper._lncrawl_bounded = True
        except Exception:
            pass
    # 兜底：get_response 也注入默认超时
    try:
        orig = crawler.get_response

        def _get_response(url, timeout=(connect, read), **kwargs):
            return orig(url, timeout=timeout, **kwargs)

        crawler.get_response = _get_response
    except Exception:
        pass


def _fget(obj, key, default=None):
    """兼容 3.10.1 中 chapter/volume 既可能是对象也可能是 dict。"""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _load_sources():
    """加载全部内置源，返回去重后的 _Source 列表。"""
    from lncrawl.core.sources import crawler_list, load_sources

    load_sources()
    seen = set()
    out = []
    for cls in crawler_list.values():
        if id(cls) in seen:
            continue
        seen.add(id(cls))
        base = getattr(cls, "base_url", [])
        if isinstance(base, str):
            base = [base]
        for url in base:
            out.append(_Source(url, cls))
    return out


class LncrawlBridge(object):
    """3.10.1 版 lncrawl 适配（鸭子接口与 facade.LncrawlBridge 一致）。"""

    key = _KEY
    display_name = "lncrawl 多语源"
    tags = ["多语言", "446 源"]

    def __init__(self):
        self._sources = None

    def _ensure(self):
        global _SOURCES
        if self._sources is not None:
            return self._sources
        with _LOCK:
            if self._sources is not None:
                return self._sources
            if _SOURCES is None:
                _SOURCES = _load_sources()
            self._sources = _SOURCES
            return self._sources

    def source_count(self):
        try:
            return len(self._ensure())
        except Exception:
            return 0

    def search(self, keyword, limit=0, lang="zh", timeout=15.0, concurrency=8):
        sources = self._ensure()
        urls = [s.url for s in sources
                if (not lang or s.language == lang) and s.can_search and not s.is_disabled]
        if not urls:
            return []

        from lncrawl.core.sources import prepare_crawler

        def one(src_url):
            crawler = None
            try:
                crawler = prepare_crawler(src_url)
                bound_timeout(crawler, timeout)
                rows = []
                for r in (crawler.search_novel(keyword) or []):
                    rows.append({
                        "site": _KEY,
                        "book_id": r.get("url", ""),
                        "url": r.get("url", ""),
                        "title": r.get("title", ""),
                        "author": r.get("author", "") or "",
                        "description": r.get("info", "") or "",
                        "cover_url": r.get("cover_url", "") or "",
                        "latest_chapter": "",
                    })
                return rows
            except Exception:
                return []
            finally:
                if crawler is not None:
                    try:
                        crawler.close()
                    except Exception:
                        pass

        results = []
        pool = ThreadPoolExecutor(max_workers=concurrency)
        futures = [pool.submit(one, u) for u in urls]
        try:
            from concurrent.futures import as_completed
            for fut in as_completed(futures, timeout=timeout + 8):
                try:
                    results.extend(fut.result())
                except Exception:
                    continue
        except _FutureTimeout:
            pass
        except Exception:
            pass
        finally:
            pool.shutdown(wait=False)
        if limit > 0:
            results = results[:limit]
        return results

    def novel(self, url):
        self._ensure()
        from lncrawl.core.sources import prepare_crawler

        crawler = prepare_crawler(url)
        bound_timeout(crawler, 20)
        try:
            crawler.read_novel_info()
            chapters = []
            for i, c in enumerate(crawler.chapters or []):
                chapters.append({
                    "id": _fget(c, "url", "") or str(_fget(c, "id", "") or ""),
                    "url": _fget(c, "url", "") or "",
                    "title": _fget(c, "title", "") or "",
                    "volume": _fget(c, "volume", None) or "",
                    "order": i + 1,
                })
            return {
                "site": _KEY,
                "id": url,
                "title": getattr(crawler, "novel_title", "") or "",
                "author": getattr(crawler, "novel_author", "") or "",
                "description": getattr(crawler, "novel_synopsis", "") or "",
                "cover_url": getattr(crawler, "novel_cover", "") or "",
                "source_url": url,
                "tags": list(getattr(crawler, "novel_tags", []) or []),
                "chapters": chapters,
            }
        finally:
            try:
                crawler.close()
            except Exception:
                pass

    def chapter(self, url):
        self._ensure()
        from lncrawl.core.sources import prepare_crawler
        from lncrawl.models import Chapter

        crawler = prepare_crawler(url)
        bound_timeout(crawler, 20)
        try:
            ch = Chapter(id=0, url=url)
            body = crawler.download_chapter_body(ch) or ""
            return {"id": url, "url": url,
                    "title": getattr(ch, "title", "") or "",
                    "content": body}
        finally:
            try:
                crawler.close()
            except Exception:
                pass