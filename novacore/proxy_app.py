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
    LOADER_PATH, BOOT_STUB_PATH, BOOT_NAME, BOOT_SNAPSHOT, write_access,
)
from novacore.htmlkit import (
    FILELIST_NAME, HOP_BY_HOP, CACHEABLE_EXT,
    apply_long_cache, is_api_path, transform_nova_html, nova_origin_base,
)
from novacore.netutil import resolve_external
from novacore.sources import lan_hosts, serve_nova_api, api_preflight
from novacore.cdp_browser import serve_nova_cdp
from novacore import toolkit

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
        if snapshot and cfg("cache_poison", True):
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
            resp.headers["Cache-Control"] = "no-cache"
        else:
            resp = send_file(fp, mimetype=ctype, conditional=False)
            # 看门狗重试的 index.html?t=..&r=.. 不投毒：它只是一次性绕缓存副本，
            # 若也缓存一年，会与干净键的正式副本长期并存、浪费分区空间。
            is_retry_url = is_top_index and bool(request.query_string)
            if cfg("cache_poison", True) and not is_retry_url:
                apply_long_cache(resp)
            else:
                resp.headers["Cache-Control"] = "no-cache"
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
        if host in valid_hosts and ("/" + path).startswith(prefix):
            rel = ("/" + path)[len(prefix):]
            # CDP 远程浏览器：SSE 帧流 + 控制（需在 api/ 之前，stream 不是 JSON）
            if rel.startswith("cdp/"):
                return serve_nova_cdp(rel[4:], request.method)
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
                abort(404)
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
        # 剥除 CSP/XFO：我们注入了引导脚本并在跨源 iframe 中挂载 Tzy OS，
        # 平台一旦下发 script-src/frame-ancestors 限制会直接掐断整个链路。
        out_headers = [(k, v) for k, v in resp.raw.headers.items()
                       if k.lower() not in HOP_BY_HOP
                       and k.lower() not in ("content-security-policy",
                                             "content-security-policy-report-only",
                                             "x-frame-options")]

        injected = False
        full_path = "/" + path
        if (cfg("inject_enable", True)
                and full_path.startswith(str(cfg("inject_path_pattern", "/static/js/manifest.build.")))
                and "javascript" in resp.headers.get("content-type", "").lower()):
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