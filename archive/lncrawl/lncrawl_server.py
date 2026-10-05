# -*- coding: utf-8 -*-
"""lightnovel-crawler 轻量 HTTP 包装服务。

把 lncrawl 的程序化 API（搜索 / 详情 / 章节）包装成 REST 接口，
供 Tzy OS 挂载点反代调用。作为子进程由 novacore/lncrawl_dl.py 按需拉起。

注意：
- LNCRAWL_DATA_PATH 指向本地数据目录（SQLite 等），由启动脚本注入
- sync_remote_index=False：不联网同步源索引，只用打包内置的 446 个 crawler
- 中文源在官方 _index.json 里 can_search 全为 False（索引滞后），但实际
  实现了 search_novel，故搜索时按语言枚举全部源并发尝试，忽略该标记
Loshop & Cpt
"""
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeout
from urllib.parse import urlparse

# embed 版 Python（runtime38）不带项目根到 sys.path，需显式补入以 import novelsrc
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, jsonify, request

# 数据目录必须在 import lncrawl 之前设定
_DATA = os.environ.get("LNCRAWL_DATA_PATH") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "lncrawl_data")
os.environ.setdefault("LNCRAWL_DATA_PATH", os.path.abspath(_DATA))
os.makedirs(os.environ["LNCRAWL_DATA_PATH"], exist_ok=True)

# ---------------------------------------------------------------------------
# lncrawl 版本兼容分流
#   4.x   ：有 lncrawl.context，走 ctx.sources API（原有逻辑）
#   3.10.1：Win7 / Python 3.8 专用，只有 lncrawl.core.sources
# ---------------------------------------------------------------------------
_IS_LNCRAWL4 = False
try:
    from lncrawl.context import ctx  # noqa: F401,E402
    from lncrawl.core import Chapter, Novel  # noqa: F401,E402
    _IS_LNCRAWL4 = True
except ImportError:
    # 3.10.1 源索引支持联网同步/下载，Win7 离线场景须强制 dev 模式（只读内置源）
    os.environ.setdefault("LNCRAWL_MODE", "dev")
    from lncrawl.core.sources import crawler_list, load_sources, prepare_crawler  # noqa: E402
    from lncrawl.models import Chapter  # noqa: E402

    ctx = None
    Novel = None

app = Flask(__name__)
_READY = {"ok": False, "err": ""}

# 注册统一小说后端门面（go-novel-dl 兼容的 /novel/api/*，聚合 novelsrc + lncrawl）
try:
    from novelsrc.facade import register_routes as _register_novel_routes
    _register_novel_routes(app)
except Exception as _e:  # noqa: BLE001
    sys.stderr.write("[novel] facade 注册失败：%s\n" % _e)


# ---------------------------------------------------------------------------
# 3.10.1 适配：源清单 / crawler 构造 / 超时收窄
# ---------------------------------------------------------------------------
_SOURCES3 = None
_SOURCES3_LOCK = threading.Lock()


class _Source3(object):
    """把 3.10.1 的 crawler 类包装成与 4.x Source 对象一致的鸭子类型。"""

    __slots__ = ("url", "domain", "language", "can_search", "is_disabled")

    def __init__(self, url, crawler_cls):
        self.url = url
        self.language = (getattr(crawler_cls, "language", "") or "").lower()
        self.domain = urlparse(url).hostname or url
        self.can_search = bool(getattr(crawler_cls, "can_search", False))
        self.is_disabled = bool(getattr(crawler_cls, "is_disabled", False))


def _ensure_sources3():
    """加载全部内置源（3.10.1），返回去重后的 _Source3 列表（缓存）。"""
    global _SOURCES3
    with _SOURCES3_LOCK:
        if _SOURCES3 is not None:
            return _SOURCES3
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
                out.append(_Source3(url, cls))
        _SOURCES3 = out
        return out


def _bound_timeout(crawler, timeout):
    """复用 novelsrc.lncrawl_bridge 的超时收窄逻辑（覆盖 get/post/head）。"""
    try:
        from novelsrc.lncrawl_bridge import bound_timeout as _bt
    except Exception:
        return
    _bt(crawler, timeout)


def _init_crawler(url, timeout=20, probe=True):
    """统一构造 crawler：4.x 用 ctx.sources.init_crawler，3.x 用 prepare_crawler。"""
    if _IS_LNCRAWL4:
        return ctx.sources.init_crawler(url, timeout=timeout, probe=probe)
    crawler = prepare_crawler(url)
    _bound_timeout(crawler, timeout)
    return crawler


def _setup():
    if _READY["ok"]:
        return
    try:
        if _IS_LNCRAWL4:
            ctx.setup(sync_remote_index=False)
            ctx.sources.ensure_load()
        else:
            _ensure_sources3()
        _READY["ok"] = True
    except Exception as e:
        _READY["err"] = str(e)
        raise


def _fget(obj, key, default=None):
    """兼容 3.10.1 中 chapter/volume 既可能是对象也可能是 dict。"""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


@app.route("/healthz")
def healthz():
    if not _READY["ok"]:
        try:
            _setup()
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True})


@app.route("/sources")
def list_sources():
    _setup()
    lang = (request.args.get("lang") or "").strip().lower()
    items = ctx.sources.list() if _IS_LNCRAWL4 else _ensure_sources3()
    out = []
    for s in items:
        if lang and s.language != lang:
            continue
        out.append({
            "url": s.url,
            "domain": s.domain,
            "language": s.language,
            "name": s.domain,
            "can_search": s.can_search,
            "is_disabled": s.is_disabled,
        })
    out.sort(key=lambda x: (x["language"], x["domain"]))
    return jsonify({"ok": True, "count": len(out), "sources": out})


def _search_one(source_url, query, timeout, probe):
    """对单个源执行搜索，返回 (source_url, [results]) 或异常。

    probe=True 走轻量探测会话（快，不解 Cloudflare 挑战）；
    probe=False 走抓取会话（慢，启用浏览器求解器应对 Cloudflare）。
    前端默认 probe，遇到被 CF 拦截的源可单源改用 crawl 模式重试。
    """
    crawler = None
    try:
        crawler = _init_crawler(source_url, timeout=timeout, probe=probe)
        # 4.x: crawler.search(q)；3.10.1: crawler.search_novel(q)
        found = crawler.search(query) if _IS_LNCRAWL4 else crawler.search_novel(query)
        rows = []
        for r in (found or []):
            d = r.to_dict() if hasattr(r, "to_dict") else dict(r)
            # 补全可能的封面字段
            extra = r.get_extras() if hasattr(r, "get_extras") else {}
            if "cover_url" not in d and extra.get("cover_url"):
                d["cover_url"] = extra["cover_url"]
            rows.append({
                "title": d.get("title", ""),
                "url": d.get("url", ""),
                "info": d.get("info", ""),
                "cover_url": d.get("cover_url") or "",
            })
        return source_url, rows, None
    except Exception as e:
        return source_url, [], str(e)
    finally:
        if crawler is not None:
            try:
                crawler.close()
            except Exception:
                pass


@app.route("/search")
def search():
    _setup()
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify({"ok": False, "error": "搜索词至少 2 个字符"}), 400
    lang = (request.args.get("lang") or "zh").strip().lower()
    sources_arg = (request.args.get("sources") or "").strip()
    limit = int(request.args.get("limit") or 30)
    timeout = float(request.args.get("timeout") or 15)
    # 3.10.1 单语言源动辄两三百个，默认并发须更高才能在时限内覆盖到源
    _default_cc = 8 if _IS_LNCRAWL4 else 32
    concurrency = int(request.args.get("concurrency") or _default_cc)
    # crawl=1 时用抓取会话（浏览器求解 Cloudflare），默认探测会话（快）
    probe = request.args.get("crawl", "0") != "1"

    # 选定源：若指定了 sources 则只用这些，否则取该语言全部源
    if sources_arg:
        urls = [u.strip() for u in sources_arg.split(",") if u.strip()]
    elif _IS_LNCRAWL4:
        urls = [s.url for s in ctx.sources.list()
                if not lang or s.language == lang]
    else:
        # 3.10.1 只挑实现了 search_novel 且未禁用的源，减少无效请求
        urls = [s.url for s in _ensure_sources3()
                if (not lang or s.language == lang)
                and s.can_search and not s.is_disabled]
    if not urls:
        return jsonify({"ok": True, "results": [], "searched": 0})

    results = []
    errors = {}
    ex = ThreadPoolExecutor(max_workers=concurrency)
    futs = {ex.submit(_search_one, u, q, timeout, probe): u for u in urls}
    try:
        for fut in as_completed(futs, timeout=timeout + 5):
            src, rows, err = fut.result()
            if err:
                errors[src] = err
                continue
            for row in rows:
                row["source"] = src
                results.append(row)
    except FuturesTimeout:
        # 部分源超时未完成，已完成的结果照常返回
        for fut, src in futs.items():
            if fut.done() and not fut.cancelled():
                try:
                    src2, rows, err = fut.result()
                    if err:
                        errors[src2] = err
                        continue
                    for row in rows:
                        row["source"] = src2
                        results.append(row)
                except Exception:
                    pass
    finally:
        # 3.x 个别源可能仍在阻塞，不等待以免拖死响应；4.x 保持原语义
        ex.shutdown(wait=_IS_LNCRAWL4)

    # 去重（同 url 只保留一条）
    seen = set()
    uniq = []
    for r in results:
        if r["url"] in seen:
            continue
        seen.add(r["url"])
        uniq.append(r)
    uniq = uniq[:limit]
    return jsonify({
        "ok": True,
        "results": uniq,
        "searched": len(urls),
        "returned": len(uniq),
        "errors": errors,
    })


@app.route("/novel")
def novel_detail():
    _setup()
    url = (request.args.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "缺少 url 参数"}), 400
    crawler = None
    try:
        # probe=True 走轻量会话（无 warmup、无浏览器求解），响应快；
        # 遇到 Cloudflare 拦截的源可在前端提示改用 crawl=1 重试。
        crawler = _init_crawler(url, timeout=20, probe=True)
        if _IS_LNCRAWL4:
            novel = Novel(url=url)
            crawler.read_novel(novel)
            data = {
                "title": novel.title or "",
                "author": novel.author or "",
                "cover_url": novel.cover_url or "",
                "synopsis": novel.synopsis or "",
                "language": novel.language or "",
                "tags": list(getattr(novel, "tags", []) or []),
                "volumes": [
                    {"id": v.id, "title": v.title, "chapters": v.chapters}
                    for v in (novel.volumes or [])
                ],
                "chapters": [
                    {"id": c.id, "url": c.url, "title": c.title, "volume": c.volume}
                    for c in (novel.chapters or [])
                ],
            }
        else:
            # 3.10.1：read_novel_info() 直接填充 crawler 属性
            crawler.read_novel_info()
            chapters = crawler.chapters or []
            data = {
                "title": getattr(crawler, "novel_title", "") or "",
                "author": getattr(crawler, "novel_author", "") or "",
                "cover_url": getattr(crawler, "novel_cover", "") or "",
                "synopsis": getattr(crawler, "novel_synopsis", "") or "",
                "language": getattr(crawler, "language", "") or "",
                "tags": list(getattr(crawler, "novel_tags", []) or []),
                "volumes": [
                    {"id": _fget(v, "id"), "title": _fget(v, "title", ""),
                     "chapters": [_fget(c, "url", "") for c in chapters
                                  if _fget(c, "volume", None) == _fget(v, "id")]}
                    for v in (getattr(crawler, "volumes", []) or [])
                ],
                "chapters": [
                    {"id": _fget(c, "id"), "url": _fget(c, "url", ""),
                     "title": _fget(c, "title", ""), "volume": _fget(c, "volume", None)}
                    for c in chapters
                ],
            }
        return jsonify({"ok": True, "novel": data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e),
                        "trace": traceback.format_exc()}), 500
    finally:
        if crawler is not None:
            try:
                crawler.close()
            except Exception:
                pass


@app.route("/chapter")
def chapter_body():
    _setup()
    url = (request.args.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "缺少 url 参数"}), 400
    crawler = None
    try:
        crawler = _init_crawler(url, timeout=20, probe=True)
        ch = Chapter(id=0, url=url)
        if _IS_LNCRAWL4:
            crawler.download_chapter(ch)
        else:
            # 3.10.1：download_chapter_body() 返回正文字符串
            ch.body = crawler.download_chapter_body(ch) or ""
        body = getattr(ch, "body", "") or ""
        return jsonify({"ok": True, "body": body})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e),
                        "trace": traceback.format_exc()}), 500
    finally:
        if crawler is not None:
            try:
                crawler.close()
            except Exception:
                pass


def main():
    port = int(os.environ.get("LNCRAWL_PORT", "18099"))
    host = os.environ.get("LNCRAWL_HOST", "127.0.0.1")
    # 启动时预先 setup，让首次请求不等待
    try:
        _setup()
        sys.stderr.write("[lncrawl] ctx ready, sources loaded\n")
    except Exception as e:
        sys.stderr.write("[lncrawl] setup failed: %s\n" % e)
    app.run(host=host, port=port, threaded=True, debug=False, use_reloader=False)


if __name__ == "__main__":
    main()
