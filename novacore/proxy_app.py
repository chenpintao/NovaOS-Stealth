# -*- coding: utf-8 -*-
"""HTTP 透明代理 Flask 应用：平台流量透传 + 注入 + Tzy OS 挂载点。"""
import base64
import hashlib
import json
import mimetypes
import os
import re
import time

import requests
from flask import Flask, Response, abort, jsonify, request, send_file

from novacore.configutil import (
    cfg, CONFIG, novaos_dir, mount_prefix, BROWSER_KEYS,
)
from novacore.paths import (
    LOADER_PATH, BOOT_STUB_PATH, BOOT_NAME, BOOT_SNAPSHOT, write_access, slog,
)
from novacore.htmlkit import (
    FILELIST_NAME, HOP_BY_HOP, CACHEABLE_EXT,
    apply_long_cache, is_api_path, transform_nova_html, nova_origin_base,
)
from novacore.netutil import resolve_external
from novacore.sources import lan_hosts, serve_nova_api, api_preflight
from novacore.web_proxy import serve_web_proxy
from novacore.novel_dl import proxy_novel
from novacore import toolkit
from novacore.lan_chat import handle_lan_request

def create_proxy_app():
    app = Flask("nova-proxy", static_folder=None)  # 禁用默认 /static 路由，避免截胡 CDN 路径

    @app.after_request
    def _access_log(resp):
        try:
            qs = request.query_string.decode("latin1", errors="ignore")
            path = request.path + (("?" + qs) if qs else "")
            ua = (request.headers.get("User-Agent", "") or "")[:160]
            write_access("%s %s host=%s %s %s -> %s UA=%s" % (
                time.strftime("%Y-%m-%d %H:%M:%S"), request.remote_addr,
                request.host, request.method, path, resp.status_code, ua))
            # 挂载点下 API/系统/网页代理 请求的 4xx/5xx 单独进服务端诊断日志（故障第一现场）
            if resp.status_code >= 400 and ("/api/" in request.path or
                                           "/sys/" in request.path or
                                           "/wp/" in request.path):
                slog("warn", "http", "%s %s -> %s（UA=%s）" % (
                    request.method, path[:300], resp.status_code, ua[:80]))
        except Exception:
            pass
        # 统一 CORS：断劫持后平板用 http://<电脑IP>/__nova__/ 直连，属于跨域。
        # 此前只有 api/*（_api_json）与 novel/* 带了 ACAO，导致 sys/backup、
        # sys/update、sys/app-catalog、api/search/stream 在 IP 直连下被浏览器
        # 拦截——表现为“备份不能用、应用列表空白、AI failed to fetch”，
        # 而文件/小说/音乐正常。这里在出口统一补齐，避免逐处遗漏。
        try:
            mount = mount_prefix()
            if request.path.startswith(mount):
                if not resp.headers.get("Access-Control-Allow-Origin"):
                    resp.headers["Access-Control-Allow-Origin"] = "*"
                if request.method == "OPTIONS":
                    resp.headers.setdefault(
                        "Access-Control-Allow-Methods",
                        "GET,POST,HEAD,OPTIONS")
                    resp.headers.setdefault(
                        "Access-Control-Allow-Headers",
                        request.headers.get("Access-Control-Request-Headers")
                        or "Content-Type")
                    resp.headers.setdefault("Access-Control-Max-Age", "86400")
                # 让前端能读到文件名等自定义头
                existing = resp.headers.get("Access-Control-Expose-Headers")
                need = "X-File-Name,Content-Disposition,Content-Type"
                if existing:
                    if "X-File-Name" not in existing:
                        need = existing + "," + need
                    else:
                        need = None
                if need:
                    resp.headers["Access-Control-Expose-Headers"] = need
        except Exception:
            pass
        return resp

    def route_base(host):
        routes = cfg("host_routes", {}) or {}
        return routes.get(host, "http://" + host).rstrip("/")

    _PIXEL_GIF = base64.b64decode(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")

    def serve_diag_beacon():
        """收集平板回传的探针：纯 img 打点(p=) 与 JS 诊断(d=)。"""
        d = request.args.get("d")
        if d:
            try:
                line = json.dumps(json.loads(d[:6000]), ensure_ascii=False)
            except Exception:
                line = d[:800]
        else:
            line = request.query_string.decode("latin1", "ignore")[:6000] or "(empty)"
        write_access("[DIAG] %s %s" % (request.remote_addr, line[:4500]))
        resp = Response(_PIXEL_GIF, status=200)
        resp.headers["Content-Type"] = "image/gif"
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp

    def serve_filelist():
        root = novaos_dir()
        files = []
        latest = 0
        for dirpath, dirnames, filenames in os.walk(root):
            for name in filenames:
                if name in ("sw.js", FILELIST_NAME):
                    continue
                fp = os.path.join(dirpath, name)
                rel = os.path.relpath(fp, root).replace(os.sep, "/")
                files.append(rel)
                try:
                    latest = max(latest, int(os.path.getmtime(fp)))
                except Exception:
                    pass
        files.sort()
        payload = {"version": "%d-%d" % (latest, len(files)), "files": files}
        resp = Response(json.dumps(payload, ensure_ascii=False), status=200)
        resp.headers["Content-Type"] = "application/json; charset=utf-8"
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    def serve_boot(snapshot):
        """下发 loader 本体 + 最新配置。
        __boot__.js：no-cache 且支持 ETag/304 —— loader 或配置一改，
        设备下次打开页面立即拿到新版（永不需要手动清缓存）。
        __boot__.snapshot.js：一年长缓存快照 —— 断劫持后真实 CDN 不可用时，
        浏览器直接读新鲜期内的磁盘缓存，不发任何请求。"""
        with open(LOADER_PATH, "r", encoding="utf-8") as f:
            loader = f.read()
        browser_cfg = {k: cfg(k) for k in BROWSER_KEYS if k in CONFIG}
        body = ("window.__STEALTH_CFG__=%s;\n%s\n" % (
            json.dumps(browser_cfg, ensure_ascii=False), loader)).encode("utf-8")
        etag = '"%s"' % hashlib.md5(body).hexdigest()
        if not snapshot and request.headers.get("If-None-Match") == etag:
            resp = Response(status=304)
        else:
            resp = Response(body, status=200)
            resp.headers["Content-Length"] = str(len(body))
        resp.headers["Content-Type"] = "application/javascript; charset=utf-8"
        resp.headers["ETag"] = etag
        if snapshot:
            # 快照是断劫持/离线唤起唯一的兜底：必须始终长缓存，不能跟随
            # cache_poison 开关（该开关控制的是“平台静态资源投毒”）。否则
            # 关闭投毒时快照变 no-cache，离线唤起直接失效。
            apply_long_cache(resp)
        else:
            # boot.js：每次使用前向服务器校验（未变 304，零正文流量）
            resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    def serve_nova(rel):
        root = novaos_dir()
        if rel == "__err__.gif":
            return serve_diag_beacon()
        if rel == BOOT_NAME:
            return serve_boot(snapshot=False)
        if rel == BOOT_SNAPSHOT:
            return serve_boot(snapshot=True)
        if rel == FILELIST_NAME:
            return serve_filelist()
        raw_rel = rel
        if rel == "" or rel.endswith("/"):
            rel += "index.html"
        fp = os.path.abspath(os.path.join(root, rel.replace("/", os.sep)))
        if not fp.startswith(root + os.sep) and fp != root:
            abort(403)
        if not os.path.isfile(fp):
            abort(404)

        # 顶层入口（index.html / os.html / nova.html）才注入 bridge：否则不握手，看门狗空转重试
        entry_name = rel.replace("\\", "/").lstrip("/")
        is_top_index = (entry_name in ("index.html", "os.html", "nova.html")
                        and raw_rel in ("", "index.html", "/", "os.html", "nova.html"))
        ctype = (mimetypes.guess_type(fp)[0] or "application/octet-stream").split(";")[0].strip()
        if ctype in ("text/html", "application/xhtml+xml"):
            with open(fp, "rb") as f:
                body = transform_nova_html(f.read(), is_top_index=is_top_index)
            # 入口 HTML 不投毒：no-cache + ETag/304。改了文件（或经 /api/update
            # 升了引用版本号）后设备下一次打开立即拿到新入口，无需清缓存；
            # 正文仅 2KB 级，304 回源成本可忽略。内部的 js/css 仍靠 ?v= 一年长缓存。
            etag = '"%s"' % hashlib.md5(body).hexdigest()
            if request.headers.get("If-None-Match") == etag:
                resp = Response(status=304)
            else:
                resp = Response(body, status=200)
                resp.headers["Content-Length"] = str(len(body))
            resp.headers["Content-Type"] = "text/html; charset=utf-8"
            resp.headers["ETag"] = etag
            if is_top_index:
                # 顶层入口：短 max-age（60 秒内直接用磁盘副本，断网也能启动），
                # 过期后必须回源校验（max-age 本身已含此语义）。
                #
                # 注意不能用 "no-cache, max-age=60"：no-cache 的优先级高于
                # max-age，浏览器会忽略 max-age、每次强制回源，等于完全没有
                # 离线兜底。实测断网后 reload 直接 ERR_CONNECTION_REFUSED。
                resp.headers["Cache-Control"] = "public, max-age=60"
            else:
                # 应用内部页面（lib/mojuan、lib/quickdraw、lib/phigros 等）。
                #
                # 这里曾经是 public, max-age=31536000（一年不回源），踩过坑：
                # 这些页面内部还有自己写死的模块引用，例如 phi 的
                #     script-1.5.9.2.js: import "./utils/interact.js?v=<手写串>"
                # 版本号永不变化 → 浏览器把那个确切 URL 的坏副本钉死一年，
                # 应用永久白屏，只能清缓存（或重装系统）才能救。墨卷也踩过。
                #
                # 现在与顶层入口一致：短 max-age + ETag 校验。60 秒内直接用
                # 磁盘副本（离线也能打开），过期后回源拿新内容；坏一次也不
                # 会被钉死一年。页面内的 js/css 仍按 apply_long_cache 长缓存。
                # 同样不能用 "no-cache, max-age=60"：no-cache 会让 max-age 失效。
                resp.headers["Cache-Control"] = "public, max-age=60"
        else:
            resp = send_file(fp, mimetype=ctype, conditional=False)
            # 看门狗重试的 index.html?t=..&r=.. 不投毒：它只是一次性绕缓存副本，
            # 若也缓存一年，会与干净键的正式副本长期并存、浪费分区空间。
            is_retry_url = is_top_index and bool(request.query_string)
            # 挂载点下的 OS 自身静态资源（os.js/css、apps/*.js、lib/**）是离线
            # 可用的根基：必须始终长缓存，否则一旦断网，浏览器直接加载失败。
            # cache_poison 只控制“平台(CDN)静态资源”是否缓存一年，不应影响我们
            # 自己的运行时代码。
            if is_retry_url:
                resp.headers["Cache-Control"] = "no-cache"
            elif entry_name.startswith("lib/"):
                # lib/ 下是随系统分发的第三方应用静态站（phigros / geogebra /
                # mojuan / quickdraw）。它们的内部引用 URL 由上游写死（文件名
                # hash 或手写 ?v=），长期不变；若沿用一年不回源 + 删 ETag，
                # 一旦某次返回了坏副本/半截响应，就会在磁盘缓存里被永久钉死，
                # 表现为白屏或样式/组件丢失，重装应用也救不回（应用包不含
                # 这些静态资源，重装不清浏览器缓存）。
                #
                # 改为真正的条件请求 + 受控 max-age：
                #   · 每个文件保留 Flask 生成的 ETag，文件一变 ETag 即变；
                #   · 入口 HTML 用 60 秒（改动后尽快生效）；
                #   · 其余静态资源用 1 天（离线可用），过期后带 If-None-Match
                #     回源校验：命中回 304（不重传正文），坏副本最迟一天后被
                #     新副本替换，不再像过去那样被钉死一年。
                # 注意：不能用自定义 ETag 覆盖 Flask 生成的那个——协商是拿
                # 它自己的 ETag 做的，覆盖后反而不一致（永远 200）。
                resp = send_file(fp, mimetype=ctype, conditional=True)
                is_html = ctype in ("text/html", "application/xhtml+xml")
                resp.headers["Cache-Control"] = ("public, max-age=60" if is_html
                                                 else "public, max-age=86400")
            else:
                apply_long_cache(resp)
        # blob 应用（origin=null）内 @font-face / fetch 与外层预取均依赖跨域许可
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    @app.route("/", defaults={"path": ""},
               methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
    @app.route("/<path:path>",
               methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
    def proxy_all(path):
        host = (request.host or "").split(":")[0].lower()
        prefix = mount_prefix()

        # 浏览器自动请求的 favicon 直接空响应，避免落入透传产生 404 噪音
        if "/" + path == "/favicon.ico":
            return Response(b"", status=204)

        # 1) Tzy OS 挂载点
        #    a) 劫持域名访问（serve_host）；
        #    b) 断劫持后平板直连热点/本机 IP（192.168.137.1 等），无需域名解析。
        valid_hosts = set([str(cfg("serve_host", "")).lower()]) | lan_hosts()
        # 挂载点路径本身已足够定位本服务：只要请求落在 mount 前缀下就按本机
        # 服务处理，不再强依赖 Host 是否命中白名单。Host 白名单只用于决定
        # “哪些域名是劫持域名”，否则换网卡/多网段直连时会被误判成外部流量。
        on_mount = ("/" + path).startswith(prefix)
        if on_mount:
            rel = ("/" + path)[len(prefix):]
            # 网页代理：同源改写任意站点（含 HTTPS），供内置浏览器使用
            if rel.startswith("wp/"):
                # Some older toolbox builds prepend the mount twice when
                # rewriting an already proxied image/PDF URL. Normalize it at
                # the backend boundary so those resources remain reachable.
                while rel.startswith("wp/__nova__/wp/"):
                    rel = "wp/" + rel[len("wp/__nova__/wp/"):]
                return serve_web_proxy(rel[3:], request.method)
            # 应用磁盘文件：apps_data/<应用id>/<包内相对路径>
            # 平板安装时已把包内文件同步到电脑磁盘，这里以普通静态文件提供，
            # 应用页面可直接以 HTTP 地址引用（可被浏览器长期缓存、可 iframe 加载）。
            if rel.startswith("apps-data/"):
                if request.method == "OPTIONS":
                    return api_preflight()
                if request.method not in ("GET", "HEAD"):
                    abort(405)
                rest = rel[len("apps-data/"):]
                app_id, _, sub_rel = rest.partition("/")
                fp = toolkit.app_data_file(app_id, sub_rel)
                if not fp:
                    abort(404)
                ctype = (mimetypes.guess_type(fp)[0] or
                         "application/octet-stream").split(";")[0].strip()
                resp = send_file(fp, mimetype=ctype, conditional=True)
                # 应用落库文件同样是离线可用的根基。用“受控 max-age + ETag
                # 条件校验”而非一年不回源：入口 HTML 60 秒、其余资源 1 天。
                # 离线期内直接读磁盘副本；联网过期后带 If-None-Match 回源，
                # 命中 304、文件变则 200 新副本。过去用一年（31536000）时，
                # 一旦某次返回 404/半截内容，坏副本会被长期沿用，应用（如
                # phi）样式/组件丢失且重建也无法恢复；现在最迟一天后自愈。
                is_html = ctype in ("text/html", "application/xhtml+xml")
                resp.headers["Cache-Control"] = ("public, max-age=60" if is_html
                                                 else "public, max-age=86400")
                resp.headers["X-Content-Type-Options"] = "nosniff"
                # IP 直连时平板跨域引用这些文件（iframe/图片/fetch），需放行。
                resp.headers["Access-Control-Allow-Origin"] = "*"
                return resp
            # 平板同源系统操作：更新缓存版本号、下载备份 zip（管理端口仅本机可达，故挂这里）
            if rel.startswith("sys/"):
                if request.method == "OPTIONS":
                    return api_preflight()
                sub = rel[4:]
                if sub == "update" and request.method == "POST":
                    changed, errors = toolkit.bump_entry_versions()
                    if errors:
                        return jsonify({"ok": False, "errors": errors}), 500
                    return jsonify({"ok": True, "changed": len(changed), "files": changed})
                if sub == "backup" and request.method in ("GET", "HEAD"):
                    data = toolkit.build_backup_zip()
                    resp = Response(data, status=200)
                    resp.headers["Content-Type"] = "application/zip"
                    resp.headers["Content-Disposition"] = (
                        'attachment; filename="%s"' % toolkit.backup_filename())
                    resp.headers["Cache-Control"] = "no-store"
                    return resp
                # 平板离线空间（IndexedDB VFS）备份到电脑：begin → push* → commit
                if sub == "vfs-begin" and request.method == "POST":
                    try:
                        body = request.get_json(force=True, silent=True) or {}
                        sid = toolkit.tablet_backup_begin(body)
                        return jsonify({"ok": True, "sid": sid})
                    except Exception as e:
                        return jsonify({"ok": False, "error": str(e)}), 500
                if sub == "vfs-push" and request.method == "POST":
                    try:
                        info = toolkit.tablet_backup_push(
                            request.args.get("sid", ""),
                            request.args.get("p", ""),
                            request.stream)
                        return jsonify({"ok": True, "saved": info})
                    except KeyError as e:
                        return jsonify({"ok": False, "error": str(e)}), 404
                    except ValueError as e:
                        return jsonify({"ok": False, "error": str(e)}), 400
                    except Exception as e:
                        return jsonify({"ok": False, "error": str(e)}), 500
                if sub == "vfs-commit" and request.method == "POST":
                    try:
                        sid = (request.get_json(force=True, silent=True) or {}).get("sid", "")
                        return jsonify({"ok": True, "result": toolkit.tablet_backup_commit(sid)})
                    except KeyError as e:
                        return jsonify({"ok": False, "error": str(e)}), 404
                    except Exception as e:
                        return jsonify({"ok": False, "error": str(e)}), 500
                if sub == "restore-catalog" and request.method in ("GET", "HEAD", "POST"):
                    try:
                        return jsonify({"ok": True, "backups": toolkit.tablet_backup_catalog()})
                    except Exception as e:
                        return jsonify({"ok": False, "error": str(e)}), 500
                if sub == "restore-package" and request.method in ("GET", "HEAD"):
                    fp = toolkit.tablet_backup_package(request.args.get("f", ""))
                    if not fp:
                        abort(404)
                    resp = send_file(fp, mimetype="application/zip",
                                     as_attachment=False, conditional=True)
                    resp.headers["Cache-Control"] = "no-store"
                    return resp
                # 调试模式：平板 console/异常日志回传，按天落 logs/tablet-*.log
                if sub == "log" and request.method == "POST":
                    body = request.get_json(force=True, silent=True) or {}
                    n = toolkit.append_tablet_log(
                        request.remote_addr, body.get("logs", []),
                        request.headers.get("User-Agent", ""))
                    return jsonify({"ok": True, "received": n})
                # 开发模式：平板 ↔ 电脑 双向命令通道（hello/poll/result，
                # 长轮询挂起由 werkzeug threaded 支持，逻辑见 novacore.devmode）
                if sub.startswith("dev-") and request.method == "POST":
                    from novacore import devmode
                    return devmode.handle_sys(sub[4:])
                # Tzy 应用仓库：目录清单 + 包文件下载（.tzyp）
                if sub == "app-catalog" and request.method in ("GET", "HEAD", "POST"):
                    return jsonify({"ok": True, "apps": toolkit.app_repo_catalog()})
                if sub == "app-package" and request.method in ("GET", "HEAD"):
                    fp = toolkit.app_repo_package(request.args.get("f", ""))
                    if not fp:
                        abort(404)
                    resp = send_file(fp, mimetype="application/zip",
                                     as_attachment=False, conditional=True)
                    resp.headers["Cache-Control"] = "no-store"
                    return resp
                # 应用文件落盘：平板安装 .tzyp 时把包内文件同步到电脑磁盘
                # apps_data/<id>/，此后页面/脚本直接用 HTTP 地址加载真实文件，
                # 不再每次运行从 IndexedDB 生成 blob URL。
                if sub == "app-data-begin" and request.method == "POST":
                    body = request.get_json(force=True, silent=True) or {}
                    data, status = toolkit.app_data_begin(body.get("id", ""))
                    return jsonify(data), status
                if sub == "app-data-put" and request.method == "POST":
                    data, status = toolkit.app_data_put(
                        request.args.get("id", ""), request.args.get("p", ""),
                        request.stream)
                    return jsonify(data), status
                if sub == "app-data-remove" and request.method == "POST":
                    body = request.get_json(force=True, silent=True) or {}
                    data, status = toolkit.app_data_remove(body.get("id", ""))
                    return jsonify(data), status
                if sub == "app-data-ensure" and request.method in ("POST", "GET"):
                    body = request.get_json(force=True, silent=True) or {}
                    app_id = body.get("id") or request.args.get("id", "")
                    data, status = toolkit.app_data_ensure(app_id)
                    return jsonify(data), status
                abort(404)
            # 小说下载后端：本机 novelsrc 聚合服务（按需拉起 + 流式反代），
            # 平板端小说应用通过 /__nova__/novel/api/* 调用。
            if rel.startswith("novel/"):
                if request.method == "OPTIONS":
                    return api_preflight()
                return proxy_novel(rel)
            # LAN Chat rendezvous/signaling/relay endpoints.
            if rel.startswith("lan/"):
                return handle_lan_request(rel[4:], request)
            # 应用 API：GET/POST + 跨域预检（api/web 用 GET 走电脑网络代取外网）
            if rel.startswith("api/"):
                if request.method == "OPTIONS":
                    return api_preflight()
                if request.method not in ("GET", "HEAD", "POST"):
                    abort(405)
                return serve_nova_api(rel[4:], request.method)
            if request.method not in ("GET", "HEAD"):
                abort(405)
            return serve_nova(rel)

        # 2) 其余流量透传（解析真实 IP，防 DNS 回环）
        base = route_base(host)
        url = base + "/" + path
        if request.query_string:
            url += "?" + request.query_string.decode("latin1")

        fwd_headers = {k: v for k, v in request.headers.items()
                       if k.lower() not in ("host", "if-none-match", "if-modified-since")}
        try:
            ips = resolve_external(host)
        except Exception as e:
            return Response("dns resolve error: %s" % e, status=502)

        fwd_headers["Host"] = host
        # CDN 多 IP 故障转移：单个 IP 连接失败自动尝试后续 IP
        resp = None
        last_err = None
        for ip in (ips[:3] or [ips[0]]):
            candidate = re.sub(r"^(https?://)[^/]+",
                               lambda m: m.group(1) + ip, url, count=1)
            try:
                resp = requests.request(method=request.method, url=candidate, headers=fwd_headers,
                                        data=request.get_data(), cookies=request.cookies,
                                        allow_redirects=False, timeout=(10, 25), stream=True, verify=False)
                last_err = None
                break
            except Exception as e:
                last_err = e
                continue
        if resp is None:
            print("[HTTP] 上游全部 IP 不可达 %s：%s" % (host, last_err))
            return Response("proxy error: %s" % last_err, status=502)

        body = resp.content
        resp.close()
        # 剥除 CSP/XFO：我们注入了引导脚本并在跨源 iframe 中挂载 Tzy OS，
        # 平台一旦下发 script-src/frame-ancestors 限制会直接掐断整个链路。
        out_headers = [(k, v) for k, v in resp.raw.headers.items()
                       if k.lower() not in HOP_BY_HOP
                       and k.lower() not in ("content-security-policy",
                                             "content-security-policy-report-only",
                                             "x-frame-options")]

        injected = False
        full_path = "/" + path
        should_inject = (cfg("inject_enable", True)
                and full_path.startswith(str(cfg("inject_path_pattern", "/static/js/manifest.build.")))
                and "javascript" in resp.headers.get("content-type", "").lower())
        if should_inject:
            try:
                # 只注入内容恒定的引导器（~1.5KB）：真正的 loader 与配置由
                # 挂载点 __boot__.js 动态下发（no-cache，可随时更新），
                # 这样修改 loader/配置后设备无需手动清除已被投毒一年的 manifest。
                with open(BOOT_STUB_PATH, "r", encoding="utf-8") as f:
                    stub = f.read()
                stub = stub.replace("__BOOT_BASE__", nova_origin_base())
                body = (stub + "\n;\n" + body.decode("utf-8", errors="replace")).encode("utf-8")
                out_headers = [(k, v) for k, v in out_headers
                               if k.lower() not in ("content-length", "cache-control", "etag", "last-modified")]
                injected = True
            except Exception as e:
                print("[HTTP] 注入失败，已透传原文件：%s" % e)

        response = Response(body, status=resp.status_code, headers=out_headers)
        if injected:
            response.headers["Content-Type"] = "application/javascript; charset=utf-8"

        # 缓存投毒：仅缓存成功响应；静态资源（含注入后的 manifest）缓存一年；业务 API 不缓存
        if (cfg("cache_poison", True) and 200 <= resp.status_code < 300
                and not is_api_path(path)):
            ext = os.path.splitext(path.lower().split("?", 1)[0])[1]
            if injected or ext in CACHEABLE_EXT:
                apply_long_cache(response)
        return response

    return app
