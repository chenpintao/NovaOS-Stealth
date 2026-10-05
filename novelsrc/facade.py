# -*- coding: utf-8 -*-
"""novelsrc.facade —— 小说后端的 HTTP 门面。

提供一个 Flask 应用所需的 /novel/api/* 路由（接口形态沿用 go-novel-dl，
供 OS「小说下载」应用直接使用），聚合 novelsrc 移植的全部中文书源。
纯 Python 3.8（Windows 7 可用）。
Loshop & Cpt
"""
import io
import os
import re
import threading
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FutureTimeout

from flask import jsonify, request, send_file

from .base import get_site, site_keys

API_VERSION = "py-1.0.0"

# 聚合搜索的总时限（秒）：超时即返回已到结果，避免个别站点不可达拖死整次请求
SEARCH_DEADLINE = 25.0

_TITLE_WS = re.compile(r"[\s\u3000·・:：,，.。!！?？\-—_()（）\[\]【】]+")

_EXPORT_DIR = None
_TASKS = {}
_TASKS_LOCK = threading.Lock()


def export_dir():
    global _EXPORT_DIR
    if _EXPORT_DIR is None:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        _EXPORT_DIR = os.environ.get("NOVEL_EXPORT_DIR") or os.path.join(root, "novel_exports")
        os.makedirs(_EXPORT_DIR, exist_ok=True)
    return _EXPORT_DIR


def norm_title(value):
    return _TITLE_WS.sub("", (value or "").strip().lower())


# ---------------------------------------------------------------------------
# 书源清单
# ---------------------------------------------------------------------------
def default_sources():
    items = []
    for key in site_keys():
        site = get_site(key)
        if site is None or not site.searchable or not site.downloadable:
            continue
        items.append(site.descriptor())
    return items


# ---------------------------------------------------------------------------
# 聚合搜索
# ---------------------------------------------------------------------------
def _search_one(site_key_, keyword, limit):
    site = get_site(site_key_)
    if site is None:
        return site_key_, []
    try:
        return site_key_, site.search(keyword, limit=limit)
    except Exception:
        return site_key_, []


def hybrid_search(keyword, keys, per_site_limit, overall_limit):
    rows = []
    hit_keys = []
    if keys:
        pool = ThreadPoolExecutor(max_workers=min(8, max(1, len(keys))))
        try:
            futures = {pool.submit(_search_one, k, keyword, per_site_limit): k for k in keys}
            # 硬性总时限：个别站点长时间不可达时不拖死整次搜索，先返回已到的结果
            try:
                for fut in as_completed(futures, timeout=SEARCH_DEADLINE):
                    try:
                        key, items = fut.result()
                    except Exception:
                        continue
                    if items:
                        hit_keys.append(key)
                        rows.extend(items)
            except FutureTimeout:
                pass
        finally:
            pool.shutdown(wait=False)

    # 按标题归并（同书多源 -> variants）
    groups = {}
    order = []
    for row in rows:
        nk = norm_title(row.get("title"))
        if not nk:
            continue
        if nk not in groups:
            groups[nk] = []
            order.append(nk)
        groups[nk].append(row)

    results = []
    for nk in order:
        variants = groups[nk]
        primary = variants[0]
        author = ""
        latest = ""
        desc = ""
        for v in variants:
            if not author and v.get("author"):
                author = v["author"]
            if not latest and v.get("latest_chapter"):
                latest = v["latest_chapter"]
            if not desc and v.get("description"):
                desc = v["description"]
        results.append({
            "title": primary.get("title", ""),
            "author": author,
            "description": desc,
            "latest_chapter": latest,
            "source_count": len(variants),
            "primary": primary,
            "variants": variants,
        })
    if overall_limit > 0:
        results = results[:overall_limit]
    return results, sorted(set(hit_keys))


def paginate(results, page, page_size):
    total = len(results)
    start = max(0, (page - 1) * page_size)
    return {
        "results": results[start:start + page_size],
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_exact": True,
        "has_prev": page > 1,
        "has_next": start + page_size < total,
    }


# ---------------------------------------------------------------------------
# 导出任务
# ---------------------------------------------------------------------------
def _new_task(site_key_, book_id, title, formats):
    task = {
        "id": uuid.uuid4().hex[:12],
        "site": site_key_,
        "book_id": book_id,
        "title": title or book_id,
        "status": "queued",
        "formats": formats or ["txt"],
        "total_chapters": 0,
        "completed_chapters": 0,
        "phase": "",
        "current_chapter": "",
        "eta": "",
        "speed": "",
        "messages": [],
        "exported": [],
    }
    with _TASKS_LOCK:
        _TASKS[task["id"]] = task
    return task


def _update(task_id, **fields):
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
        if task:
            task.update(fields)


def _append_msg(task_id, message):
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
        if task:
            task.setdefault("messages", []).append(message)


def _safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", name or "novel").strip(" .")
    return name[:80] or "novel"


def _build_txt(book):
    out = io.StringIO()
    out.write(book.get("title") or "")
    out.write("\n")
    if book.get("author"):
        out.write("作者：%s\n" % book["author"])
    if book.get("source_url"):
        out.write("来源：%s\n" % book["source_url"])
    out.write("\n")
    for i, ch in enumerate(book.get("chapters") or []):
        out.write("\n%s\n\n" % (ch.get("title") or ("第 %d 章" % (i + 1))))
        out.write((ch.get("content") or "") + "\n")
    return out.getvalue()


def _build_epub(book):
    from ebooklib import epub  # noqa: WPS433
    import html as _html

    eb = epub.EpubBook()
    eb.set_identifier(book.get("source_url") or book.get("id") or "novel")
    eb.set_title(book.get("title") or "Novel")
    eb.set_language("zh")
    if book.get("author"):
        eb.add_author(book["author"])
    chapters = book.get("chapters") or []
    spine = ["nav"]
    toc = []
    for i, ch in enumerate(chapters):
        item = epub.EpubHtml(title=ch.get("title") or ("第 %d 章" % (i + 1)),
                             file_name="chap_%04d.xhtml" % i, lang="zh")
        body = "".join("<p>%s</p>" % _html.escape(line)
                       for line in (ch.get("content") or "").split("\n") if line.strip())
        item.content = "<h2>%s</h2>%s" % (
            _html.escape(ch.get("title") or ""), body or "<p></p>")
        eb.add_item(item)
        spine.append(item)
        toc.append(item)
    eb.toc = toc
    eb.spine = spine
    eb.add_item(epub.EpubNcx())
    eb.add_item(epub.EpubNav())
    buf = io.BytesIO()
    epub.write_epub(buf, eb, {})
    return buf.getvalue()


def _run_export(task_id, site_key_, book_id, formats, title_hint=""):
    _update(task_id, status="running", phase="获取书目")
    try:
        site = get_site(site_key_)
        if site is None:
            raise ValueError("未知书源：%s" % site_key_)
        book = site.download_plan(book_id)
        chapters = book.get("chapters") or []
        if title_hint and not book.get("title"):
            book["title"] = title_hint
        _update(task_id, title=book.get("title") or book.get("id") or book_id,
                total_chapters=len(chapters), phase="抓取正文")

        for i, ch in enumerate(chapters):
            try:
                loaded = site.fetch_chapter(book_id, ch)
            except Exception:
                loaded = dict(ch)
            loaded["order"] = i + 1
            chapters[i] = loaded
            _update(task_id, completed_chapters=i + 1,
                    current_chapter=loaded.get("title") or ch.get("title") or "")
        book["chapters"] = chapters

        _update(task_id, phase="写入文件")
        exported = []
        base = _safe_name(book.get("title") or book_id)
        for fmt in (formats or ["txt"]):
            fmt = (fmt or "").lower()
            if fmt == "epub":
                path = os.path.join(export_dir(), "%s.epub" % base)
                with open(path, "wb") as fp:
                    fp.write(_build_epub(book))
            else:
                path = os.path.join(export_dir(), "%s.txt" % base)
                with open(path, "w", encoding="utf-8") as fp:
                    fp.write(_build_txt(book))
            exported.append(path)
        _update(task_id, status="completed", phase="完成", exported=exported,
                completed_chapters=len(chapters))
    except Exception as exc:
        _append_msg(task_id, str(exc))
        _update(task_id, status="failed", phase="失败")
        traceback.print_exc()


# ---------------------------------------------------------------------------
# 路由注册
# ---------------------------------------------------------------------------
def register_routes(app):
    @app.route("/novel/api/healthz")
    def _novel_healthz():
        return jsonify({"status": "ok"})

    @app.route("/novel/api/meta")
    def _novel_meta():
        try:
            sources = default_sources()
        except Exception:
            sources = []
        return jsonify({
            "default_sources": sources,
            "all_sources": sources,
            "site_warnings": [],
            "site_stats": [],
            "general_config": {},
            "version": {"current": API_VERSION},
        })

    @app.route("/novel/api/version")
    def _novel_version():
        return jsonify({"current": API_VERSION})

    @app.route("/novel/api/search", methods=["POST"])
    def _novel_search():
        body = request.get_json(silent=True) or {}
        keyword = (body.get("keyword") or "").strip()
        if not keyword:
            return jsonify({"error": "keyword is required"}), 400
        page = int(body.get("page") or 1)
        page_size = int(body.get("page_size") or 20)
        limit = int(body.get("limit") or 0)
        site_limit = int(body.get("site_limit") or 0)
        keys = [k for k in (body.get("sites") or []) if k]
        if not keys:
            keys = [s["key"] for s in default_sources()]
        fetch_limit = page * page_size + 1
        per_site = site_limit if site_limit >= fetch_limit else fetch_limit
        overall = limit if limit > fetch_limit else fetch_limit
        try:
            results, hits = hybrid_search(keyword, keys, per_site, overall)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400
        payload = paginate(results, page, page_size)
        payload["sites"] = hits
        return jsonify(payload)

    @app.route("/novel/api/books/detail")
    def _novel_detail():
        site_key_ = (request.args.get("site") or "").strip()
        book_id = (request.args.get("book_id") or "").strip()
        if not site_key_ or not book_id:
            return jsonify({"error": "site and book_id are required"}), 400
        site = get_site(site_key_)
        if site is None:
            return jsonify({"error": "unknown site: %s" % site_key_}), 400
        try:
            book = site.download_plan(book_id)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400

        chapters = book.get("chapters") or []
        try:
            page = int(request.args.get("chapter_page") or 1)
            page_size = int(request.args.get("chapter_page_size") or 200)
        except ValueError:
            page, page_size = 1, 200
        page = max(1, page)
        page_size = max(1, min(page_size, 1000))
        start = (page - 1) * page_size
        total = len(chapters)
        slim = [{"id": c.get("id"), "title": c.get("title"), "url": c.get("url", ""),
                 "volume": c.get("volume", ""), "order": c.get("order", i + 1)}
                for i, c in enumerate(chapters[start:start + page_size])]
        out = dict(book)
        out["chapters"] = slim
        return jsonify({
            "book": out,
            "chapter_page": {
                "page": page, "page_size": page_size, "total": total,
                "has_prev": page > 1, "has_next": start + page_size < total,
            },
        })

    @app.route("/novel/api/chapter-content")
    def _novel_chapter():
        site_key_ = (request.args.get("site") or "").strip()
        book_id = (request.args.get("book_id") or "").strip()
        chapter_id = (request.args.get("chapter_id") or "").strip()
        title = (request.args.get("title") or "").strip()
        url = (request.args.get("url") or "").strip()
        if not site_key_ or not book_id or not (chapter_id or title or url):
            return jsonify({"error": "site, book_id, and chapter identity are required"}), 400
        site = get_site(site_key_)
        if site is None:
            return jsonify({"error": "unknown site: %s" % site_key_}), 400
        chapter = {"id": chapter_id, "title": title, "url": url or chapter_id}
        try:
            got = site.fetch_chapter(book_id, chapter)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify({"chapter": got})

    @app.route("/novel/api/download-tasks", methods=["POST"])
    def _novel_task_create():
        body = request.get_json(silent=True) or {}
        site_key_ = (body.get("site") or "").strip()
        book_id = (body.get("book_id") or "").strip()
        if not site_key_ or not book_id:
            return jsonify({"error": "site and book_id are required"}), 400
        formats = body.get("formats") or ["txt"]
        task = _new_task(site_key_, book_id, body.get("title") or "", formats)
        thread = threading.Thread(
            target=_run_export,
            args=(task["id"], site_key_, book_id, formats, body.get("title") or ""),
            daemon=True)
        thread.start()
        return jsonify({"task": task}), 202

    @app.route("/novel/api/download-tasks", methods=["GET"])
    def _novel_task_list():
        with _TASKS_LOCK:
            tasks = list(_TASKS.values())
        return jsonify({"tasks": tasks})

    @app.route("/novel/api/download-tasks/<task_id>", methods=["GET"])
    def _novel_task_get(task_id):
        with _TASKS_LOCK:
            task = _TASKS.get(task_id)
        if not task:
            return jsonify({"error": "task not found"}), 404
        return jsonify({"task": task})

    @app.route("/novel/api/download-tasks/<task_id>", methods=["DELETE"])
    def _novel_task_delete(task_id):
        with _TASKS_LOCK:
            existed = _TASKS.pop(task_id, None)
        if not existed:
            return jsonify({"error": "task not found"}), 404
        return jsonify({"deleted": task_id})

    @app.route("/novel/api/download-file")
    def _novel_download_file():
        path = (request.args.get("path") or "").strip()
        if not path:
            return jsonify({"error": "path is required"}), 400
        abs_path = os.path.abspath(path)
        root = os.path.abspath(export_dir())
        if not abs_path.startswith(root):
            return jsonify({"error": "path is not allowed"}), 403
        if not os.path.isfile(abs_path):
            return jsonify({"error": "file not found"}), 404
        return send_file(abs_path, as_attachment=True,
                         download_name=os.path.basename(abs_path))

    return app