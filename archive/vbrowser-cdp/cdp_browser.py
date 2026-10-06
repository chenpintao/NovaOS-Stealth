# -*- coding: utf-8 -*-
"""CDP 远程浏览器：headless Chrome 画面推流（SSE）+ 输入注入。"""
import json
import os
import subprocess
import threading
import time

import requests
from flask import Response, jsonify, request

from novacore.configutil import cfg
from novacore.paths import HERE
from novacore.sources import api_preflight, _api_json, _api_body

try:
    import websocket  # websocket-client
except Exception:
    websocket = None

# ----------------------------- CDP 远程浏览器 -----------------------------
# 电脑上跑一个 headless Chrome，画面经 CDP Page.startScreencast 以 JPEG 帧
# 推回（SSE），平板的触摸/键盘经 Input.dispatch* 注入，实现「借电脑网络上网」。
# 分辨率/画质可在 config.json（管理界面）自定义；改后需重启远程浏览器生效。
CDP_DEFAULT_WIDTH = 1280
CDP_DEFAULT_HEIGHT = 800
CDP_DEFAULT_QUALITY = 55
# 推流帧率上限：headless Chrome 合成器原生约 60fps，热点链路下 60 张全屏 JPEG
# 会把带宽打满导致排队延迟滚雪球（越看越卡）。节拍器统一限到 20fps，
# 既明显流畅跟手，又把码率压到约 1/3。可在 config.json 用 cdp_fps 调整。
CDP_DEFAULT_FPS = 20
CDP_SOURCE_FPS = 60


def cdp_dim(name, default, lo, hi):
    try:
        v = int(cfg(name, default))
        return max(lo, min(hi, v))
    except Exception:
        return default


def cdp_width():
    return cdp_dim("cdp_width", CDP_DEFAULT_WIDTH, 640, 3840)


def cdp_height():
    return cdp_dim("cdp_height", CDP_DEFAULT_HEIGHT, 480, 2160)


def cdp_quality():
    return cdp_dim("cdp_quality", CDP_DEFAULT_QUALITY, 10, 100)


def cdp_fps():
    return cdp_dim("cdp_fps", CDP_DEFAULT_FPS, 5, 30)

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def _chrome_major_version(exe):
    """直接读 PE 文件版本（Win32 API），绝不启动浏览器进程。
    早期用 `chrome.exe --version` 探测：Windows 上当默认配置 Chrome 已在运行时，
    该命令会唤起一个可见的真实浏览器窗口（且 stdout 可能为空）。"""
    try:
        import ctypes
        size = ctypes.windll.version.GetFileVersionInfoSizeW(exe, None)
        if not size:
            return 0
        buf = ctypes.create_string_buffer(size)
        dummy = ctypes.c_void_p()
        if not ctypes.windll.version.GetFileVersionInfoW(exe, 0, size, buf):
            return 0
        ptr = ctypes.c_void_p()
        ln = ctypes.c_uint()
        # 根块 "\\" 即 VS_FIXEDFILEINFO
        if not ctypes.windll.version.VerQueryValueW(
                buf, "\\", ctypes.byref(ptr), ctypes.byref(ln)) or not ln.value:
            return 0
        # VS_FIXEDFILEINFO.dwFileVersionMS 在偏移 8
        ms = ctypes.c_uint.from_address(ptr.value + 8).value
        return (ms >> 16) & 0xFFFF
    except Exception:
        return 0


def _headless_flag(exe):
    """Chrome >=112 支持 --headless=new，更早版本须用旧式 --headless，
    否则参数被忽略而弹出可见窗口。版本读文件属性，不启动进程。"""
    major = _chrome_major_version(exe)
    return "--headless=new" if major and major >= 112 else "--headless"


class CDPSession(object):
    """单个 headless Chrome 会话：后台线程读 screencast 帧并广播给订阅者。"""

    def __init__(self):
        self.proc = None
        self.ws = None
        self.running = False
        self.url = "about:blank"
        self._id = 0
        self._send_lock = threading.Lock()
        self._subs = []           # list[queue.Queue]，有界丢旧帧
        self._subs_lock = threading.Lock()
        self._start_lock = threading.Lock()   # 防止 nav/stream 并发时启动两个 Chrome
        self._reader = None
        self._pacer = None
        self.W = CDP_DEFAULT_WIDTH
        self.H = CDP_DEFAULT_HEIGHT
        self.FPS = CDP_DEFAULT_FPS
        # 最新帧（读线程写、节拍线程/订阅者读）+ 序号去重，静态页面不重复推
        self._latest = None
        self._latest_seq = 0
        self._frame_lock = threading.Lock()

    # ---------- 生命周期 ----------
    def start(self):
        if self.running:
            return True, "已在运行"
        # nav 与 stream 会在平板打开应用瞬间同时触发 start：加锁 + 锁内复查，
        # 避免两个线程用同一 user-data-dir 各启一个 Chrome 互抢 profile/端口。
        with self._start_lock:
            if self.running:
                return True, "已在运行"
            return self._start_locked()

    def _start_locked(self):
        if websocket is None:
            return False, "缺少 websocket-client（pip install websocket-client）"
        exe = None
        for p in CHROME_CANDIDATES:
            if os.path.isfile(p):
                exe = p
                break
        if not exe:
            return False, "未找到 Chrome/Edge"
        profile = os.path.join(HERE, "logs", "cdp-profile")
        os.makedirs(profile, exist_ok=True)
        # 服务器崩溃/被强杀后，旧 Chrome 可能还活着并锁住 profile：新实例会唤醒
        # 旧实例后立刻退出（表现为「Chrome 进程已退出」）。启动前扫一遍，
        # 只结束命令行里带本 profile 路径的 chrome，绝不碰用户的日常浏览器。
        self._kill_profile_holders(profile)
        # 上次异常退出可能留下 SingletonLock，导致新进程唤醒旧实例后直接退出
        for lk in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            try:
                os.remove(os.path.join(profile, lk))
            except Exception:
                pass
        self.W = w = cdp_width()
        self.H = h = cdp_height()
        self.FPS = fps = cdp_fps()
        q = cdp_quality()
        # 源头限帧：合成器约 60fps，按目标帧率抽帧（20fps→每 3 帧取 1），
        # 降低 Chrome 编码与 CDP WebSocket 收大 JSON 的 CPU/带宽压力；
        # 节拍器再兜一层，保证最终出帧节奏均匀。
        nth = max(1, int(round(float(CDP_SOURCE_FPS) / fps)))
        argv = [exe, "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--remote-allow-origins=*",
                "--user-data-dir=" + profile,
                "--no-first-run", "--no-default-browser-check",
                "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
                "--window-size=%d,%d" % (w, h),
                # 无头：画面只经 CDP 推流到平板，电脑上绝不开窗。
                # --headless=new 需 Chrome 112+；老版本忽略该参数会弹窗，自动回退旧式 --headless。
                _headless_flag(exe), "about:blank"]
        try:
            self.proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL)
        except Exception as e:
            return False, "启动失败：%s" % e
        # port=0 时 Chrome 把实际端口写进 profile/DevToolsActivePort。
        # 先删残留：上次被强杀会留下旧端口文件，循环里第一次读到的会是
        # 上个实例的死端口，导致死等 3 分钟后才报「连接 CDP 失败」。
        port = None
        port_file = os.path.join(profile, "DevToolsActivePort")
        try:
            os.remove(port_file)
        except Exception:
            pass
        # 统一等待：反复「读端口文件 → 探活 /json/list」，端口可能在启动早期
        # 被重写（极少数情况浏览器进程自重启），每次重读就不会死盯旧端口。
        targets = None
        last_err = None
        dead_ticks = 0
        deadline = time.time() + 25
        while time.time() < deadline:
            # 进程退出后给约 3 秒宽限：若新进程已接管并重写端口文件仍可连上
            if self.proc.poll() is not None:
                dead_ticks += 1
                if dead_ticks > 15:
                    self.stop()
                    return False, "Chrome 进程已退出"
            try:
                with open(port_file, "r") as f:
                    port = int(f.readline().strip())
                # DevToolsActivePort 先于 HTTP 调试服务就绪写入，须探活
                targets = requests.get(
                    "http://127.0.0.1:%d/json/list" % port, timeout=1).json()
                page = next(t for t in targets if t.get("type") == "page")
                break
            except Exception as e:
                last_err = e
                targets = None
                time.sleep(0.2)
        if targets is None:
            self.stop()
            return False, "连接 CDP 失败：%s" % (last_err or "调试服务未就绪")
        try:
            self.ws = websocket.create_connection(
                page["webSocketDebuggerUrl"], timeout=15,
                max_size=64 * 1024 * 1024)
            # 建连超时用 15s；连上后 recv 必须永久阻塞——否则页面静止超过超时
            # 秒数会抛 timeout 让读线程误判断线（旧值 30s，看静态页面必断）。
            # 退出路径由 stop() 里的 ws.close() 打断本阻塞。
            self.ws.settimeout(None)
        except Exception as e:
            self.stop()
            return False, "连接 CDP 失败：%s" % e
        self.running = True
        self.url = "about:blank"
        self._send("Page.enable")
        self._send("Emulation.setDeviceMetricsOverride",
                   {"width": w, "height": h,
                    "deviceScaleFactor": 1, "mobile": False})
        self._send("Page.startScreencast",
                   {"format": "jpeg", "quality": q,
                    "maxWidth": w, "maxHeight": h,
                    "everyNthFrame": nth})
        self._reader = threading.Thread(target=self._read_loop)
        self._reader.daemon = True
        self._reader.start()
        self._pacer = threading.Thread(target=self._pacer_loop)
        self._pacer.daemon = True
        self._pacer.start()
        return True, "已启动"

    def stop(self):
        self.running = False
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        self.ws = None
        self._kill_proc_tree()
        self.proc = None
        self.url = "about:blank"
        with self._frame_lock:
            self._latest = None
            self._latest_seq = 0

    def _kill_proc_tree(self):
        """结束整个 Chrome 进程树。Windows 下 proc.terminate() 只杀启动器，
        真正持锁的浏览器是其孙进程，会变成占用 profile 的僵尸。"""
        p = self.proc
        if not p:
            return
        try:
            if p.poll() is not None:
                return
        except Exception:
            return
        if os.name == "nt":
            try:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)],
                               stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=8)
                return
            except Exception:
                pass
        try:
            p.terminate()
            try:
                p.wait(timeout=3)
            except Exception:
                p.kill()
        except Exception:
            pass

    def _kill_profile_holders(self, profile):
        """杀掉命令行中带有指定 profile 路径的残留 chrome 进程树（按树结束，
        GPU/渲染/网络子进程一并清掉）。仅 Windows，启动时尽力而为。"""
        if os.name != "nt":
            return
        safe = profile.replace("'", "''")
        ps = (
            "$ErrorActionPreference='SilentlyContinue';"
            "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
            "Where-Object { $_.CommandLine -like '*" + safe + "*' } | "
            "ForEach-Object { taskkill /T /F /PID $_.ProcessId }"
        )
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-Command", ps],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=15)
        except Exception:
            pass
        # 给系统一点时间真正释放 profile 锁
        time.sleep(0.5)

    # ---------- CDP 收发 ----------
    def _send(self, method, params=None):
        try:
            with self._send_lock:
                self._id += 1
                if self.ws:
                    self.ws.send(json.dumps(
                        {"id": self._id, "method": method,
                         "params": params or {}}))
        except Exception:
            pass

    def _read_loop(self):
        while self.running and self.ws:
            try:
                msg = json.loads(self.ws.recv())
            except Exception:
                break
            m = msg.get("method")
            if m == "Page.screencastFrame":
                p = msg.get("params", {})
                data = p.get("data")
                if data:
                    # 只暂存最新帧并立即 ack（让 Chrome 继续出帧），
                    # 广播交给节拍线程按固定 FPS 做，源帧率再高也不会冲爆链路。
                    with self._frame_lock:
                        self._latest = data
                        self._latest_seq += 1
                self._send("Page.screencastFrameAck",
                           {"sessionId": p.get("sessionId")})
            elif m == "Page.frameNavigated":
                fr = msg.get("params", {}).get("frame", {})
                if not fr.get("parentId") and fr.get("url"):
                    self.url = fr["url"]
        self.running = False

    def _pacer_loop(self):
        """按目标 FPS 把「最新帧」扇出给订阅者：无订阅者时不做任何广播，
        画面静止（序号未变）不重复发，节奏均匀不平突发。"""
        last_sent = 0
        while self.running:
            time.sleep(1.0 / max(1, self.FPS))
            with self._subs_lock:
                subs = list(self._subs)
            if not subs:
                # 没人看：不推进 last_sent，下次有人订阅时 subscribe() 会补最新帧
                continue
            with self._frame_lock:
                seq = self._latest_seq
                data = self._latest
            if data and seq != last_sent:
                self._broadcast(data)
                last_sent = seq

    def _broadcast(self, data):
        with self._subs_lock:
            subs = list(self._subs)
        for q in subs:
            try:
                if q.full():
                    q.get_nowait()     # 丢旧帧保最新
                q.put_nowait(data)
            except Exception:
                pass

    def subscribe(self):
        import queue
        q = queue.Queue(maxsize=2)
        with self._frame_lock:
            latest = self._latest
        if latest:
            try:
                q.put_nowait(latest)   # 补发最新帧，新订阅者立刻有画面
            except Exception:
                pass
        with self._subs_lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q):
        with self._subs_lock:
            if q in self._subs:
                self._subs.remove(q)

    # ---------- 操作 ----------
    def nav(self, url):
        url = str(url or "").strip()
        if not url:
            return
        if url.startswith(("http://", "https://", "about:")):
            pass
        elif " " in url or "." not in url:
            url = "https://www.bing.com/search?q=" + requests.utils.quote(url)
        else:
            url = "https://" + url
        self.url = url
        self._send("Page.navigate", {"url": url})

    def cmd(self, op):
        if op == "back":
            self._send("Runtime.evaluate", {"expression": "history.back()"})
        elif op == "forward":
            self._send("Runtime.evaluate", {"expression": "history.forward()"})
        elif op == "reload":
            self._send("Page.reload", {"ignoreCache": False})

    def input(self, d):
        if not self.running:
            return
        kind = d.get("kind")
        if kind == "click":
            x, y = float(d.get("x", 0)), float(d.get("y", 0))
            for t in ("mousePressed", "mouseReleased"):
                ev = {"type": t, "x": x, "y": y,
                      "button": "left", "clickCount": 1}
                if t == "mousePressed":
                    ev["buttons"] = 1   # 按键位掩码，部分页面靠它判定按下
                self._send("Input.dispatchMouseEvent", ev)
        elif kind == "scroll":
            self._send("Input.dispatchMouseEvent",
                       {"type": "mouseWheel",
                        "x": float(d.get("x", self.W / 2)),
                        "y": float(d.get("y", self.H / 2)),
                        "deltaX": float(d.get("dx", 0)),
                        "deltaY": float(d.get("dy", 0))})
        elif kind == "text":
            self._send("Input.insertText", {"text": str(d.get("text", ""))})
        elif kind == "key":
            key = d.get("key")
            codes = {"Backspace": 8, "Enter": 13}
            if key in codes:
                for t in ("keyDown", "keyUp"):
                    p = {"type": t, "key": key, "windowsVirtualKeyCode": codes[key]}
                    if key == "Enter" and t == "keyDown":
                        p["text"] = "\r"
                    self._send("Input.dispatchKeyEvent", p)


CDP = CDPSession()


def serve_nova_cdp(rel, method):
    """挂载点 cdp/ 路由：stream(SSE 帧) / state / nav / input / cmd。"""
    if method == "OPTIONS":
        return api_preflight()
    if rel == "stream" and method == "GET":
        if not CDP.running:
            ok, _msg = CDP.start()
            if not ok:
                return _api_json({"ok": False, "error": _msg}, 500)
        q = CDP.subscribe()

        def gen():
            import queue as _queue
            try:
                while True:
                    try:
                        # 20 秒无帧则发 SSE 注释心跳，防热点/中间代理掐空闲连接
                        data = q.get(timeout=20)
                    except _queue.Empty:
                        yield ": hb\n\n"
                        continue
                    yield "data: " + data + "\n\n"
            except (GeneratorExit, BrokenPipeError, ConnectionError):
                pass
            finally:
                CDP.unsubscribe(q)

        resp = Response(gen(), mimetype="text/event-stream")
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["X-Accel-Buffering"] = "no"
        return resp
    if rel == "state" and method == "GET":
        return _api_json({"ok": True, "running": CDP.running,
                          "url": CDP.url, "w": CDP.W, "h": CDP.H,
                          "fps": CDP.FPS, "quality": cdp_quality()})
    if rel == "nav" and method == "POST":
        if not CDP.running:
            ok, msg = CDP.start()
            if not ok:
                return _api_json({"ok": False, "error": msg}, 500)
        CDP.nav(_api_body().get("url"))
        return _api_json({"ok": True})
    if rel == "input" and method == "POST":
        CDP.input(_api_body())
        return _api_json({"ok": True})
    if rel == "cmd" and method == "POST":
        body = _api_body()
        op = body.get("op")
        if op == "start":
            ok, msg = CDP.start()
            return _api_json({"ok": ok, "error": None if ok else msg})
        if op == "stop":
            CDP.stop()
            return _api_json({"ok": True})
        CDP.cmd(op)
        return _api_json({"ok": True})
    return _api_json({"ok": False, "error": "未知端点"}, 404)