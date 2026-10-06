# -*- coding: utf-8 -*-
"""内置纯 Python 正向代理（HTTP 转发 + CONNECT 隧道，HTTPS 必需）。

只监听回环地址，供本机后端（web_proxy 等模块）出站使用，不对外网暴露。
不依赖任何第三方库，纯标准库实现，兼容 Python 3.8 / Windows 7。
"""
import select
import socket
import socketserver
import threading

from novacore.paths import slog

BUFSIZE = 65536
HEAD_MAX = 65536          # 请求头上限，防超大头部拖垮内存
CONNECT_TIMEOUT = 15      # 连接上下游/上游超时
RELAY_IDLE = 300          # 隧道空闲秒数，超时断开（长连接页面也够用）


def _close(sock):
    try:
        sock.close()
    except Exception:
        pass


def _relay(a, b):
    """在 a、b 之间双向搬运字节，直到两个方向都EOF或空闲超时。

    与旧实现的关键差异：
    1. 单方向 EOF 不再立刻断开——把该方向对端“已在途”的数据搬完后才收尾，
       避免 HTTP/1.0（按连接读到 EOF 收尾）的大响应被截断。
    2. 非阻塞 send 改为“待发缓冲 + 可写事件驱动”：send 返回 EAGAIN 或部分写
       时暂存剩余字节，等 select 报告可写再续发，杜绝半包丢字节。
    """
    try:
        a.setblocking(False)
        b.setblocking(False)
    except Exception:
        pass
    live = {a: b, b: a}
    wbuf = {a: b"", b: b""}     # 每个源 sock 待转发给其 peer 的积压字节
    eof = set()                 # 已读到 EOF 的源 sock
    try:
        while True:
            if len(eof) >= 2:
                break           # 两个方向都读完，且积压已清空
            want_r = [s for s in live if s not in eof]
            # 有积压的方向才需要监听可写；且对端未 EOF（EOF 表示对端不再接收）
            want_w = [s for s in live if wbuf[s] and live[s] not in eof]
            if not want_r and not want_w:
                break
            try:
                r, w, x = select.select(want_r, want_w, list(live.keys()), RELAY_IDLE)
            except (OSError, ValueError):
                break
            if not r and not w and not x:
                break           # 空闲超时
            if x:
                break
            # 优先把积压写出去
            for s in w:
                peer = live.get(s)
                if peer is None:
                    return
                if wbuf[s]:
                    try:
                        n = peer.send(wbuf[s])
                        wbuf[s] = wbuf[s][n:]
                    except (BlockingIOError, InterruptedError):
                        pass
                    except OSError:
                        return
            for s in r:
                peer = live.get(s)
                if peer is None:
                    return
                try:
                    data = s.recv(BUFSIZE)
                except (BlockingIOError, InterruptedError):
                    continue
                except OSError:
                    eof.add(s)  # 读方向出错等同 EOF，但不要立刻砍断对端
                    continue
                if not data:
                    eof.add(s)
                    continue
                # 立即尝试直发；发不完的部分进积压，交给可写事件续发
                try:
                    n = peer.send(data)
                    if n < len(data):
                        wbuf[s] += data[n:]
                except (BlockingIOError, InterruptedError):
                    wbuf[s] += data
                except OSError:
                    return
    finally:
        _close(a)
        _close(b)


class _ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        cli = self.request
        try:
            cli.settimeout(CONNECT_TIMEOUT)
        except Exception:
            pass
        head = b""
        while b"\r\n\r\n" not in head:
            try:
                chunk = cli.recv(BUFSIZE)
            except OSError:
                return
            if not chunk:
                return
            head += chunk
            if len(head) > HEAD_MAX:
                return
        sep = head.find(b"\r\n\r\n")
        header, rest = head[:sep], head[sep + 4:]
        lines = header.split(b"\r\n")
        try:
            parts = lines[0].split()
            method, target = parts[0].upper(), parts[1]
            version = parts[2] if len(parts) > 2 else b"HTTP/1.1"
        except IndexError:
            return
        headers = []
        for ln in lines[1:]:
            if b":" in ln:
                headers.append(ln)

        if method == b"CONNECT":
            self._tunnel(target, rest)
        else:
            self._forward(method, target, version, headers, rest)

    # --------------------------------------------------------------- CONNECT
    def _tunnel(self, target, rest):
        cli = self.request
        text = target.decode("latin1")
        host, _, port = text.rpartition(":")
        if not host:
            host, port = text, "443"
        try:
            up = socket.create_connection((host, int(port)), CONNECT_TIMEOUT)
        except (OSError, ValueError):
            try:
                cli.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            except OSError:
                pass
            return
        try:
            cli.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            if rest:
                up.sendall(rest)
        except OSError:
            _close(up)
            return
        slog("debug", "proxy", "CONNECT %s:%s" % (host, port))
        _relay(cli, up)

    # ----------------------------------------------------------- HTTP 转发
    def _forward(self, method, target, version, headers, rest):
        cli = self.request
        text = target.decode("latin1")
        if not text.lower().startswith("http://"):
            # 非绝对 URL（https 请求本应走 CONNECT）无法转发
            try:
                cli.sendall(b"HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            return
        rest_url = text[7:]
        hostport, slash, path = rest_url.partition("/")
        path = "/" + path if slash else "/"
        host, _, port = hostport.partition(":")
        try:
            up = socket.create_connection((host, int(port or "80")), CONNECT_TIMEOUT)
        except (OSError, ValueError):
            try:
                cli.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
            return
        try:
            out = [b"%s %s %s" % (method, path.encode("latin1"), version)]
            content_length = None
            for ln in headers:
                name = ln.split(b":", 1)[0].strip().lower()
                if name in (b"proxy-connection", b"connection", b"keep-alive"):
                    continue
                if name == b"content-length":
                    try:
                        content_length = int(ln.split(b":", 1)[1].strip())
                    except ValueError:
                        content_length = None
                out.append(ln)
            out.append(b"Connection: keep-alive")
            up.sendall(b"\r\n".join(out) + b"\r\n\r\n")
            if rest:
                up.sendall(rest)
            if content_length is not None:
                got = len(rest)
                while got < content_length:
                    try:
                        chunk = cli.recv(min(BUFSIZE, content_length - got))
                    except OSError:
                        return
                    if not chunk:
                        break
                    up.sendall(chunk)
                    got += len(chunk)
            slog("debug", "proxy", "%s %s" % (method.decode("latin1"), text))
            # 复用带积压缓冲的 _relay 搬回响应体，避免非阻塞半包丢字节。
            # 此处仍须保留"请求体已定向读完"的语义：_relay 的 cli→up 方向读到的
            # 只是本请求可能残留的管线字节，属正常回环，无副作用。
            _relay(cli, up)
        except OSError:
            _close(up)
        finally:
            _close(up)


class _ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class ProxyEngine(object):
    """单例式内置代理，start/stop 可重复调用。"""

    def __init__(self):
        self._srv = None
        self._thread = None
        self.host = "127.0.0.1"
        self.port = 0
        self.running = False
        self._lock = threading.Lock()

    def start(self, host="127.0.0.1", port=18087):
        with self._lock:
            if self.running:
                return True, "ok"
            last = ""
            for p in (int(port), 0):
                try:
                    srv = _ThreadingServer((host, p), _ProxyHandler, bind_and_activate=False)
                    srv.server_bind()
                    srv.server_activate()
                except OSError as exc:
                    last = "%s:%s %s" % (host, p, exc)
                    continue
                # HTTPServer.server_bind 会做反向 DNS，热点切换时可能阻塞，直接短路
                socket.getfqdn = lambda name="": name or "localhost"
                self._srv = srv
                self.host, self.port = srv.server_address[0], srv.server_address[1]
                self._thread = threading.Thread(target=srv.serve_forever,
                                                kwargs={"poll_interval": 0.5}, daemon=True)
                self._thread.start()
                self.running = True
                slog("info", "proxy", "内置代理已监听 %s（HTTP + CONNECT/HTTPS）" % self.url())
                return True, "ok"
            slog("error", "proxy", "内置代理启动失败：%s" % last)
            return False, last

    def stop(self):
        with self._lock:
            if not self.running:
                return
            self.running = False
            try:
                self._srv.shutdown()
            except Exception:
                pass
            try:
                self._srv.server_close()
            except Exception:
                pass
            self._srv = None
            self._thread = None
            slog("info", "proxy", "内置代理已停止")

    def url(self):
        return "http://%s:%d" % (self.host or "127.0.0.1", self.port)

    def proxies(self):
        """requests 用的 proxies 参数（http/https 均走本代理，HTTPS 经 CONNECT）。"""
        u = self.url()
        return {"http": u, "https": u}


PROXY = ProxyEngine()
