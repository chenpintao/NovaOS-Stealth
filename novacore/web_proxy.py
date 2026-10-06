# -*- coding: utf-8 -*-
"""同源改写代理：把任意 http/https 站点经本机代理后套上挂载点同源外壳。

URL 映射：<mount>wp/<scheme>/<host>/<path>?<query>
路径结构原样保留，因此站内相对 URL 天然可用；只改写“根相对 / 绝对 / 协议相对”引用。
出站统一走内置代理 PROXY（HTTPS 经 CONNECT 隧道），因此目标站点全程加密。
"""
import re
import time
import random
import threading

import requests
from flask import Response, request

from novacore.configutil import cfg, mount_prefix
from novacore.sources import lan_hosts
from novacore.paths import slog
from novacore.proxy_engine import PROXY

PREFIX_TAIL = "wp/"

WP_TEXT_MAX = 8 * 1024 * 1024      # 需改写的页面/样式上限 8MB
WP_MAX_BYTES = 200 * 1024 * 1024   # 二进制下载上限 200MB（对齐 api/web 外网代取）

WEB_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36")

# 剥离：压缩/长度由 Flask 重算；CSP/XFO 会阻断 iframe 与内联改写；
# 连接类头属逐跳；HSTS/report-to/NEL 与本代理语义冲突（同源外壳是 http 或另一域）；
# ETag/Last-Modified/Expires/Age/Vary 属缓存协商——配合下方强制 no-store，
# 确保平板/浏览器磁盘缓存零残留（不落痕），每次请求都真正出站。
# 注意：不再剥离 set-cookie —— 站点登录态依赖它，改由 _rewrite_set_cookie
# 把作用域改写到挂载点（见下），既保住登录又不破坏同源外壳。
_DROP_HEADERS = {
    "content-encoding", "content-length", "transfer-encoding", "connection",
    "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "upgrade", "content-security-policy", "content-security-policy-report-only",
    "x-frame-options", "report-to", "nel", "strict-transport-security",
    "etag", "last-modified", "expires", "age", "vary",
}

# 不改写的引用协议：浏览器自身协议、数据、脚本、邮件、电话、blob、WebSocket
_SKIP_SCHEMES = ("data:", "javascript:", "mailto:", "tel:", "blob:", "about:",
                 "chrome:", "file:", "ws:", "wss:", "magnet:", "#")

# 透传给上游的请求头白名单：还原浏览器原始指纹，降低被风控站点判定为
# 自动化流量（429）的概率。Content-Type/Referer/Cookie 另行按站处理，不在此列。
_PASS_THRU_HEADERS = (
    "User-Agent", "Accept", "Accept-Language", "Accept-Encoding",
    "Content-Type", "Referer", "Origin",
    "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-full-version",
    "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
    "upgrade-insecure-requests", "dnt", "priority",
)

_HTML_ATTR_RE = re.compile(
    r"""(?P<pre>\b(?:href|src|action|poster|formaction|data-src|data-original|background)\s*=\s*)(?P<q>["'])(?P<url>[^"']*)(?P=q)""",
    re.I)
_CSS_URL_RE = re.compile(r"""url\(\s*(?P<q>["']?)(?P<url>[^"')]*)(?P=q)\s*\)""", re.I)
_CSS_IMPORT_RE = re.compile(r"""(@import\s+)(?P<q>["'])(?P<url>[^"']*)(?P=q)""", re.I)
_META_CHARSET_RE = re.compile(r"""(<meta[^>]+charset\s*=\s*["']?)[A-Za-z0-9_\-]+""", re.I)
_HEAD_OPEN_RE = re.compile(r"<head[^>]*>", re.I)

# 运行时拦截脚本：注入到每个 HTML 页面最前面。
# 作用：静态改写只能处理 HTML 里的 href/src；页面 JS 运行时动态发出的请求
# （fetch/XHR/Worker/importScripts/动态 import/EventSource）拿到的是“裸相对路径”，
# 会直接打到挂载点根（如 /rp/x.gz.js、/web/xlsc.aspx）→ 404/405。
# 这段脚本劫持这些 API，把指向“本页同源”的 URL 重写为 wp/<scheme>/<host>/<path>，
# 从而让懒加载分包、SPA 接口、Web Worker 脚本都能走代理取回。
_RUNTIME_SHIM = r"""<script>(function(){
try{
  /* 从当前页面地址解析出被代理站点的 scheme/host */
  var P="__NOVA_WP_PREFIX__";
  var m=location.pathname.indexOf(P);
  if(m<0)return;
  var rest=location.pathname.slice(m+P.length);   /* https/example.com/... */
  var i=rest.indexOf("/"), sch=rest.slice(0,i), hp=rest.slice(i+1);
  var j=hp.indexOf("/"), host=j<0?hp:hp.slice(0,j);
  if(!sch||!host)return;
  var BASE=P+sch+"/"+host;   /* 用于把裸路径映射回代理 */

  function map(u){
    if(u==null)return u;
    if(typeof u!=="string"){ try{ if(u&&u.url)u=u.url; else return u; }catch(e){ return u; } }
    var s=u.trim();
    if(!s)return u;
    var low=s.toLowerCase();
    /* 已是代理链接 / 外链协议 / 数据类 → 原样 */
    if(low.indexOf("data:")===0||low.indexOf("blob:")===0||low.indexOf("javascript:")===0||
       low.indexOf("mailto:")===0||low.indexOf("about:")===0)return u;
    if(s.indexOf(P)===0||low.indexOf("//"+location.host.toLowerCase()+P)>=0)return u;
    /* 根相对（/rp/x.js）或页面相对：统一按当前站点基准解析 */
    try{
      var abs=new URL(s, location.href);
      /* 仅当解析后仍指向本挂载点 origin 时才需改写（否则是真正的跨站外链） */
      if(abs.origin!==location.origin)return u;
      if(abs.pathname.indexOf(P)===0)return u;     /* 已在代理路径下 */
      return BASE+abs.pathname+abs.search+abs.hash;
    }catch(e){ return u; }
  }

  var _fetch=window.fetch;
  if(_fetch){ window.fetch=function(input,init){
    try{ if(typeof input==="string"){ input=map(input); }
         else if(input&&input.url){ var old=input.url; var nu=map(old);
           if(nu!==old){ input=new Request(nu,input); } } }catch(e){}
    return _fetch.call(this,input,init);
  }; }

  var XO=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    try{ arguments[1]=map(u); }catch(e){}
    return XO.apply(this,arguments);
  };

  if(window.Worker){ var _W=window.Worker; window.Worker=function(u,o){
    try{ u=map(u); }catch(e){}
    return new _W(u,o);
  }; window.Worker.prototype=_W.prototype; }

  if(window.importScripts){ var _IS=window.importScripts;
    window.importScripts=function(){ var a=[].slice.call(arguments);
      for(var k=0;k<a.length;k++){ try{ a[k]=map(a[k]); }catch(e){} }
      return _IS.apply(this,a); }; }

  if(window.EventSource){ var _ES=window.EventSource; window.EventSource=function(u,o){
    try{ u=map(u); }catch(e){}
    return new _ES(u,o);
  }; }

  /* 动态 import() 与 Worker 内相对解析：改写 <script type=module> 的 import
     由浏览器按页面基准解析，路径结构已保留故天然可用，这里只补裸根路径。 */
}catch(e){ try{ console.warn("[nova-shim]",e); }catch(_){} }
})();</script>"""


def _inject_runtime_shim(text):
    """把运行时拦截脚本插到 <head> 后（无 head 则插到文档最前）。"""
    shim = _RUNTIME_SHIM.replace("__NOVA_WP_PREFIX__", _prefix())
    m = _HEAD_OPEN_RE.search(text)
    if m:
        return text[:m.end()] + shim + text[m.end():]
    return shim + text


SESSION = requests.Session()
# 大连接池：站点首页常并发几十个资源（图片/JS/CSS），requests 默认
# pool_maxsize=10 会导致后续请求排队等待空闲连接，等待时间计入超时预算，
# 表现为大批 502（read timeout）。放大池 + 抬高 block 上限，避免排队。
try:
    from requests.adapters import HTTPAdapter

    _ADAPTER = HTTPAdapter(pool_connections=64, pool_maxsize=128,
                           max_retries=0, pool_block=False)
    SESSION.mount("http://", _ADAPTER)
    SESSION.mount("https://", _ADAPTER)
except Exception:
    pass

# 出站超时（秒）。注意：requests 经 HTTP 代理（本项目所有出站都走内置
# CONNECT 隧道）时，urllib3 会把「读超时」实际按「连接超时」值生效——
# 传元组 (15, 120) 时读超时塌成 15s，重站点/风控慢响应（AI 对话首包）会
# 被误判超时 502。故这里改用单值超时，使连接与读取都拿到同一充足预算；
# 连接被拒/无路由会由 TCP RST 立即返回，不会真的白等满。
UP_TIMEOUT = 120

# 出站节流/错峰：所有出站共用同一出口 IP，站点（DeepSeek 等）会按"单一出口 +
# 高频并发"判定为自动化流量。这里按 host 限制并发数并在请求前加随机抖动，
# 让节奏更接近真人，降低被 429 风控的概率。
WP_MAX_CONCURRENCY = 4         # 同一 host 同时最多 4 个在途请求
WP_JITTER = (0.05, 0.25)       # 请求前随机抖动秒数区间（错峰）
WP_COOLDOWN_429 = 20           # 命中 429 后该 host 冷却秒数（熔断，不再打）
WP_COOLDOWN_MAX = 120          # 冷却上限（连续 429 时指数增长到此封顶）

_SEMAPHORES = {}               # host -> threading.Semaphore
_SEM_LOCK = threading.Lock()
# host -> [冷却结束时间戳, 连续 429 次数]
_COOLDOWN = {}
_COOLDOWN_LOCK = threading.Lock()


def _sem_for(host):
    with _SEM_LOCK:
        sem = _SEMAPHORES.get(host)
        if sem is None:
            sem = threading.BoundedSemaphore(WP_MAX_CONCURRENCY)
            _SEMAPHORES[host] = sem
        return sem


def _cooldown_remaining(host):
    with _COOLDOWN_LOCK:
        end = _COOLDOWN.get(host)
        if not end:
            return 0
        left = end[0] - time.time()
        if left <= 0:
            _COOLDOWN.pop(host, None)
            return 0
        return left


def _note_429(host, retry_after=None):
    """记录一次 429：连续次数 +1，冷却时间指数增长（尊重 Retry-After）。"""
    with _COOLDOWN_LOCK:
        n = (_COOLDOWN.get(host) or [0, 0])[1] + 1
        wait = WP_COOLDOWN_429 * (2 ** (n - 1))
        if retry_after:
            try:
                wait = max(wait, min(int(retry_after), WP_COOLDOWN_MAX))
            except (TypeError, ValueError):
                pass
        wait = min(wait, WP_COOLDOWN_MAX)
        _COOLDOWN[host] = [time.time() + wait, n]
    return wait


def _note_ok(host):
    """成功一次即清零连续 429 计数，让冷却不再累加。"""
    with _COOLDOWN_LOCK:
        _COOLDOWN.pop(host, None)


class _SemSlot(object):
    """并发名额的一次性释放包装。

    streaming 标志用于区分"响应会以生成器方式延后消费"的场景：流式分支下，
    serve_web_proxy 的 finally 不释放，改由 _stream_up 收尾时释放，避免生成器
    尚未开始就把名额提前归还、令并发限制失效。release 幂等，只真正归还一次。
    """

    __slots__ = ("_sem", "_done", "streaming")

    def __init__(self, sem):
        self._sem = sem
        self._done = False
        self.streaming = False

    def release(self):
        if self._done:
            return
        self._done = True
        try:
            self._sem.release()
        except ValueError:
            pass


def _sem_slot(sem):
    return _SemSlot(sem)


def _rate_limit_page(wait):
    """本地熔断页：上游 429 冷却期间直接返回，避免继续出站加剧封禁。"""
    return ("<!DOCTYPE html><html lang=\"zh\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<title>\u8bf7\u7a0d\u540e\u91cd\u8bd5</title></head>"
            "<body style=\"font-family:sans-serif;text-align:center;padding:48px;color:#333\">"
            "<h2>\u7ad9\u70b9\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41</h2>"
            "<p>\u4e0a\u6e38\u5df2\u9650\u6d41\uff0c\u672c\u5730\u5df2\u6682\u505c\u8bf7\u6c42\u3002"
            "\u8bf7\u7b49\u5f85\u7ea6 <b>%d</b> \u79d2\u540e\u5237\u65b0\u91cd\u8bd5\u3002</p>"
            "</body></html>" % max(1, int(wait)))


def _prefix():
    return mount_prefix() + PREFIX_TAIL


def _cookie_b64(v):
    """Cookie 值可能含非 latin1 字符；Base64 化并加前缀标记，便于出站还原。"""
    try:
        import base64
        return "B64." + base64.b64encode(v.encode("utf-8")).decode("ascii")
    except Exception:
        return v


def _cookie_unb64(v):
    if v.startswith("B64."):
        try:
            import base64
            return base64.b64decode(v[4:]).decode("utf-8")
        except Exception:
            return ""
    return v


def _rewrite_set_cookie(raw, scheme, host):
    """把上游 Set-Cookie 改写成“挂在挂载点作用域下”的 Cookie。

    同源外壳下浏览器的 Cookie 域是挂载点主机（web-alicdn.zyai.cc），而站点
    下发的是自己的 Domain=example.com —— 直接透传浏览器会拒收，登录态就丢了。
    这里：① 去掉 Domain（默认即当前挂载点主机，全域可见）；
    ② 把 Path 前缀成 <mount>wp/<scheme>/<host>/，使浏览器只在经代理访问该站点
    时携带；③ Secure 去掉（挂载点常为 http，保留会拒收）。名称/值/有效期不动。
    """
    parts = [p.strip() for p in raw.split(";")]
    if not parts or not parts[0]:
        return None
    segs = [parts[0]]
    for p in parts[1:]:
        low = p.lower()
        if low.startswith("domain="):
            continue                      # 去域，收敛到挂载点主机
        if low.startswith("secure"):
            continue                      # 同源外壳可能是 http
        if low.startswith("path="):
            v = p.split("=", 1)[1].strip() or "/"
            if not v.startswith("/"):
                v = "/" + v
            segs.append("Path=" + _prefix() + scheme + "/" + host + v)
            continue
        if low.startswith("samesite="):
            v = "lax"                     # 同源 iframe 内 lax 足够，避免 None 需 Secure
            segs.append("SameSite=" + v)
            continue
        if low.startswith("expires=") or low.startswith("max-age="):
            segs.append(p)
            continue
        if low.startswith("httponly"):
            segs.append(p)
            continue
        segs.append(p)
    if not any(s.lower().startswith("path=") for s in segs):
        segs.append("Path=" + _prefix() + scheme + "/" + host + "/")
    return "; ".join(segs)


def _cookie_header(scheme, host):
    """把浏览器发来的 wp/ 作用域 Cookie 还原成站点原始 Cookie 头。"""
    jar = getattr(request, "cookies", None)
    if not jar:
        return ""
    base = "/" + _prefix() + scheme + "/" + host + "/"
    out = []
    for name in jar.keys():
        try:
            val = jar.get(name)
        except Exception:
            continue
        if val is None:
            continue
        val = _cookie_unb64(str(val))
        out.append("%s=%s" % (name, val))
    _ = base  # 浏览器已按 Path 过滤，这里直接用全部
    return "; ".join(out)


def _to_proxy(abs_url):
    """把绝对 URL 映射为同源代理 URL；非 http(s) 原样返回。"""
    m = re.match(r"^(https?)://(.+)$", abs_url, re.I)
    if not m:
        return abs_url
    return _prefix() + m.group(1).lower() + "/" + m.group(2)


def _own_hosts():
    """识别“本机挂载点自身”的域名集合（劫持域名 + 局域网 IP）。"""
    hosts = set()
    sh = str(cfg("serve_host", "")).lower()
    if sh:
        hosts.add(sh)
    try:
        hosts |= set(x.lower() for x in lan_hosts())
    except Exception:
        pass
    return hosts


def _is_already_proxied(u):
    """判断 URL 是否已指向本代理（含绝对形式的 http://<挂载点域名>/__nova__/wp/...）。

    这类 URL 若再被 _to_proxy 包裹，会变成
    wp/http/<挂载点域名>/__nova__/wp/... （双重包裹）→ 403。
    """
    low = u.lower()
    pref = _prefix().lower()                     # "/__nova__/wp/"
    if pref == "/":
        return False
    if low.startswith(pref):                     # 根相对已代理
        return True
    if low.startswith("//"):
        rest = low[2:]
        return rest.startswith(tuple(h + pref for h in _own_hosts())) or ("/" + pref.lstrip("/")) in rest
    m = re.match(r"^https?://([^/]+)(/.*)?$", low)
    if m:
        host_part = m.group(1).split(":")[0]
        path_part = m.group(2) or "/"
        # 指向挂载点自身域名，且路径落在挂载点前缀下 → 已代理
        if host_part in _own_hosts() and path_part.startswith(pref):
            return True
        # 任意域名但路径已含挂载点前缀（异常但需防二次包裹）
        if pref in path_part:
            return True
    return False


def _map_ref(url, scheme, host):
    """按当前页面上下文改写单个引用。"""
    u = (url or "").strip()
    if not u:
        return url
    low = u.lower()
    for s in _SKIP_SCHEMES:
        if low.startswith(s):
            return url
    if _is_already_proxied(u):
        return url  # 已是代理链接，避免二次包裹
    if low.startswith("//"):
        return _prefix() + "https/" + u[2:]
    if u.startswith("/"):
        return _prefix() + scheme + "/" + host + u
    if re.match(r"^https?://", u, re.I):
        return _to_proxy(u)
    return url  # 相对路径：路径结构已保留，浏览器自然解析


def _dewrap_ref(ref, scheme, host):
    """把浏览器发来的本地挂载地址 Referer/Origin 反解回真实上游 URL。

    输入形如 http://192.168.137.1/__nova__/wp/https/example.com/a/b，
    输出 http://example.com/a/b；非本挂载点地址原样返回 None（交由调用方兜底）。
    """
    if not ref:
        return None
    u = ref.strip()
    p = _prefix()  # 形如 /__nova__/wp/
    m = u.find(p)
    if m < 0:
        return None
    rest = u[m + len(p):]                 # https/example.com/a/b
    i = rest.find("/")
    if i < 0:
        return None
    sch, hp = rest[:i], rest[i + 1:]
    j = hp.find("/")
    up_host = hp if j < 0 else hp[:j]
    up_path = "" if j < 0 else hp[j:]
    if not sch or not up_host:
        return None
    return "%s://%s%s" % (sch, up_host, up_path)


def _rewrite_html(text, scheme, host):
    def repl(m):
        return m.group("pre") + m.group("q") + _map_ref(m.group("url"), scheme, host) + m.group("q")
    text = _HTML_ATTR_RE.sub(repl, text)
    # 注入运行时拦截脚本：处理 JS 动态发出的相对请求（fetch/XHR/Worker/import）
    text = _inject_runtime_shim(text)
    return text


def _rewrite_css(text, scheme, host):
    def repl(m):
        return "url(" + m.group("q") + _map_ref(m.group("url"), scheme, host) + m.group("q") + ")"
    text = _CSS_URL_RE.sub(repl, text)
    text = _CSS_IMPORT_RE.sub(
        lambda m: m.group(1) + m.group("q") + _map_ref(m.group("url"), scheme, host) + m.group("q"),
        text)
    return text


_CHARSET_RE = re.compile(r"charset\s*=\s*[\"']?([A-Za-z0-9_\-]+)", re.I)


def _charset_of(ctype):
    m = _CHARSET_RE.search(ctype or "")
    return m.group(1) if m else ""


def _decode(body, ctype):
    for e in (_charset_of(ctype), "utf-8", "gb18030", "latin1"):
        if not e:
            continue
        try:
            return body.decode(e), e
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("latin1", "replace"), "latin1"


def _blocked(host):
    """SSRF 防护：禁止借代理访问本机/内网域名。"""
    h = host.split(":")[0].strip().lower()
    if h in ("localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"):
        return True
    if h == str(cfg("serve_host", "")).lower():
        return True
    return h in set(x.lower() for x in lan_hosts())


def serve_web_proxy(tail, method):
    """tail 形如 "https/example.com/a/b"（不含 wp/ 前缀）。"""
    scheme, _, rem = tail.partition("/")
    scheme = scheme.lower()
    host, _, path = rem.partition("/")
    if scheme not in ("http", "https") or not host:
        return Response("bad proxy url", status=400, mimetype="text/plain")
    if _blocked(host):
        return Response("blocked host", status=403, mimetype="text/plain")

    url = "%s://%s/%s" % (scheme, host, path)
    qs = request.query_string.decode("latin1", errors="ignore")
    if qs:
        url += "?" + qs

    # 尽量还原浏览器原始请求指纹后透传上游：风控站点（如 chat.deepseek.com）
    # 会依据残缺头（缺 sec-ch-ua / sec-fetch-* / Accept-Encoding 等）+ 单一出口
    # 判定为自动化流量而返回 429 限流页。这里按白名单逐项透传，缺失才补默认。
    fwd = {}
    for _h in _PASS_THRU_HEADERS:
        _v = request.headers.get(_h)
        if _v:
            fwd[_h] = _v
    fwd.setdefault("User-Agent", WEB_UA)
    fwd.setdefault("Accept", "*/*")
    fwd.setdefault("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
    # Referer/Origin 归一：浏览器发来的是含挂载点的本地地址（泄露代理结构且异常），
    # 这里反解回真实上游 URL；同站请求默认补首页 Referer，避免裸奔被风控盯上。
    fwd["Referer"] = _dewrap_ref(fwd.get("Referer"), scheme, host) or (scheme + "://" + host + "/")
    if fwd.get("Origin"):
        fwd["Origin"] = _dewrap_ref(fwd["Origin"] + "/", scheme, host) or fwd["Origin"]
    ck = _cookie_header(scheme, host)      # 还原站点 Cookie，保住登录态
    if ck:
        fwd["Cookie"] = ck

    body = request.get_data() if method in ("POST", "PUT", "PATCH", "DELETE") else None

    # 熔断：该 host 处于 429 冷却窗口内时直接拒绝，不再出站，避免越打越封。
    host_key = host.split(":")[0].lower()
    left = _cooldown_remaining(host_key)
    if left > 0:
        slog("warn", "wproxy", "冷却中（%ds）拒发 %s %s" % (int(left), method, url[:120]))
        return Response(_rate_limit_page(left), status=429,
                        mimetype="text/html; charset=utf-8")

    _t0 = time.time()
    sem = _sem_for(host_key)
    got_sem = sem.acquire(timeout=UP_TIMEOUT)
    if not got_sem:
        return Response("proxy busy (concurrency limit)", status=503, mimetype="text/plain")
    # 并发名额必须"恰好释放一次"：同步分支读完即放；流式分支交给 _stream_up
    # 收尾时放。用闭包做一次性释放，避免两条路径重复 release 抛异常。
    slot = _sem_slot(sem)
    try:
        # 错峰：请求前抖动，避免同 host 并发请求扎堆形成机器特征。
        time.sleep(random.uniform(*WP_JITTER))
        up = SESSION.request(
            method, url, headers=fwd, data=body,
            proxies=PROXY.proxies(),           # http 直转 + https CONNECT 隧道
            timeout=UP_TIMEOUT,
            allow_redirects=False, verify=False, stream=True)
        up_headers = up.headers
        status = up.status_code
        if status == 429:
            wait = _note_429(host_key, up_headers.get("Retry-After"))
            slog("warn", "wproxy", "上游 429，%s 冷却 %ds：%s" % (host_key, wait, url[:120]))
        else:
            _note_ok(host_key)
        ctype_full = up_headers.get("Content-Type") or ""
        kind = ctype_full.split(";")[0].strip().lower()

        # 需改写的页面/样式：必须整段读出后再改写（有界 8MB）。
        if kind in ("text/html", "text/css"):
            parts, total = [], 0
            for chunk in up.iter_content(65536):
                parts.append(chunk)
                total += len(chunk)
                if total > WP_TEXT_MAX:
                    up.close()
                    slog("warn", "wproxy", "响应超限 %s（>%dMB）：%s"
                         % (method, WP_TEXT_MAX // 1048576, url[:160]))
                    return Response("proxy upstream too large (>%dMB)" % (WP_TEXT_MAX // 1048576),
                                    status=413, mimetype="text/plain")
            raw = b"".join(parts)
            up.close()
            if kind == "text/html":
                text, _ = _decode(raw, ctype_full)
                text = _META_CHARSET_RE.sub(r"\1utf-8", text)
                out, out_ctype = _rewrite_html(text, scheme, host), "text/html; charset=utf-8"
            else:
                text, _ = _decode(raw, ctype_full)
                out, out_ctype = _rewrite_css(text, scheme, host), "text/css; charset=utf-8"

            resp = Response(out, status=status)
            for k, v in up_headers.items():
                if k.lower() not in _DROP_HEADERS and k.lower() != "set-cookie":
                    resp.headers[k] = v
            _apply_set_cookie(resp, up_headers, scheme, host)
            resp.headers["Content-Type"] = out_ctype
            loc = up_headers.get("Location")
            if loc:
                from urllib.parse import urljoin
                resp.headers["Location"] = _map_ref(urljoin(url, loc), scheme, host)
            resp.headers["Cache-Control"] = "no-store"
            resp.headers["X-Content-Type-Options"] = "nosniff"
            return resp

        # 其余类型（SSE 流式对话、JSON、二进制、音视频、下载）：原样流式转发，
        # 边收边发——AI 打字机、视频拖动、大文件下载都不再被整体缓冲阻塞。
        # 流式响应的上游连接在生成器里才关闭，故名额交由 _stream_up 收尾时释放；
        # 这里不再 finally 释放，避免生成器尚未开始就把名额提前归还。
        slot.streaming = True
        resp = Response(_stream_up(up, url, slot), status=status)
        for k, v in up_headers.items():
            if k.lower() not in _DROP_HEADERS and k.lower() != "set-cookie":
                resp.headers[k] = v
        _apply_set_cookie(resp, up_headers, scheme, host)
        if ctype_full:
            resp.headers["Content-Type"] = ctype_full
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Accel-Buffering"] = "no"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp
    except requests.RequestException as exc:
        slog("warn", "wproxy", "取回失败 %s %s（%.1fs，超时 %ds）：%s" % (
            method, url[:160], time.time() - _t0, UP_TIMEOUT, exc))
        return Response("proxy upstream error: %s" % exc, status=502, mimetype="text/plain")
    finally:
        # 同步分支（含异常）返回时，响应体已读完，在 finally 归还名额；
        # 流式分支生成器尚未消费，此时释放会让并发限制失效——故用 slot 的
        # "仅流式分支消费"标志位跳过（见下方 stream 分支设置 slot.pending）。
        if not slot.streaming:
            slot.release()


def _apply_set_cookie(resp, up_headers, scheme, host):
    """逐条改写上游 Set-Cookie 并挂到响应（用原始头，避免 requests 合并丢项）。"""
    try:
        raw = up_headers.getlist("Set-Cookie")
    except Exception:
        raw = [up_headers["Set-Cookie"]] if up_headers.get("Set-Cookie") else []
    for item in raw:
        fixed = _rewrite_set_cookie(item, scheme, host)
        if fixed:
            resp.headers.add("Set-Cookie", fixed)


def _stream_up(up, url, slot=None):
    """逐块搬出站响应；累计超 WP_MAX_BYTES 即中止（防超大下载打满）。

    上游连接中断（IncompleteRead / ChunkedEncodingError / ConnectionError）时，
    iter_content 会抛异常且**丢弃本次已读到的字节**。这里改用 raw.stream 逐块读，
    把异常前已拿到的数据照常 yield 给浏览器；否则大 JS/CSS 分包被截断，
    SPA 解不出会报"页面资源加载异常"。

    slot：并发名额，在本生成器结束（响应体搬完/中断）时归还，确保名额覆盖
    整个上游连接的存活期。
    """
    total = 0
    it = up.raw.stream(65536, decode_content=True)
    try:
        for chunk in it:
            if not chunk:
                continue
            total += len(chunk)
            if total > WP_MAX_BYTES:
                slog("warn", "wproxy", "下载超限（>%dMB）：%s" % (WP_MAX_BYTES // 1048576, url[:160]))
                break
            yield chunk
    except Exception as exc:
        slog("warn", "wproxy", "流式传输中断（已转发 %d 字节）：%s" % (total, str(exc)[:120]))
    finally:
        up.close()
        if slot is not None:
            slot.release()
