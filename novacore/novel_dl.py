# -*- coding: utf-8 -*-
"""小说下载后端进程管理 + 反向代理。

后端是纯 Python 的 novel_server.py：novelsrc 移植的全部中文书源，
接口形态与 go-novel-dl 保持一致（路由前缀 /novel）。这里按需把它拉起为
子进程，再代理到 Tzy OS 挂载点下，供平板端小说应用调用（电脑代取外网）。

解释器优先使用随包分发的内嵌便携运行时 runtime\\python\\python.exe，
目标机因此无需安装 Python；开发机上自动回退当前解释器。
Loshop & Cpt
"""
import atexit
import os
import shutil
import subprocess
import sys
import threading
import time

import requests
from flask import Response, jsonify, request

from novacore.configutil import cfg
from novacore.paths import HERE, LOG_DIR, slog

_SCRIPT = os.path.join(HERE, "novel_server.py")
_LOCK = threading.Lock()
_PROC = {"p": None}
# 转发时剥掉的逐跳头：长度/编码由 Flask 重新计算，连接语义不跨代理
_HOP = ("content-encoding", "content-length", "transfer-encoding", "connection")
_UP_TIMEOUT = (10, 600)   # (连接, 读取)：导出/下载可能耗时较长


def novel_enabled():
    return bool(cfg("novel_enable", True))


def novel_port():
    try:
        return int(cfg("novel_port", 18089))
    except (TypeError, ValueError):
        return 18089


def python_exe():
    """定位运行 novel_server.py 的解释器。

    优先级：
      1. 环境变量 NOVEL_PYTHON 显式指定
      2. 内嵌便携运行时 runtime\\python\\python.exe（目标机零依赖方案）
      3. 当前解释器（开发机源码运行）
      4. 系统 PATH 里的 python / python3
    返回空串表示未找到。
    """
    env = (os.environ.get("NOVEL_PYTHON") or "").strip()
    if env and os.path.isfile(env):
        return env
    bundled = os.path.join(HERE, "runtime", "python", "python.exe")
    if os.path.isfile(bundled):
        return bundled
    if not getattr(sys, "frozen", False) and sys.executable:
        return sys.executable
    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def upstream(rel):
    """rel 形如 'novel/api/meta' → http://127.0.0.1:PORT/novel/api/meta"""
    return "http://127.0.0.1:%d/%s" % (novel_port(), str(rel).lstrip("/"))


def _healthy(timeout=1.5):
    try:
        resp = requests.get(upstream("novel/api/healthz"), timeout=timeout)
        return resp.status_code == 200
    except Exception:
        return False


def _spawn():
    if not os.path.isfile(_SCRIPT):
        msg = "未找到 novel_server.py：%s" % _SCRIPT
        slog("error", "novel", msg)
        return False, msg
    py = python_exe()
    if not py:
        msg = ("未找到 Python 解释器：小说后端需内嵌运行时 runtime\\python"
               "（用 build_runtime.ps1 生成）或系统 Python3")
        slog("error", "novel", msg)
        return False, msg
    env = dict(os.environ)
    env["NOVEL_PORT"] = str(novel_port())
    env["PYTHONIOENCODING"] = "utf-8"
    flags = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        logf = open(os.path.join(LOG_DIR, "novel.log"), "a",
                    encoding="utf-8", buffering=1)
        p = subprocess.Popen(
            [py, "-X", "utf8", _SCRIPT, "--port", str(novel_port())],
            cwd=HERE, env=env, stdout=logf, stderr=logf,
            creationflags=flags)
    except Exception as e:
        slog("error", "novel", "启动 novel_server 失败：%s" % e)
        return False, "启动小说后端失败：%s" % e
    _PROC["p"] = p
    slog("info", "novel", "已拉起 novel_server(%s) pid=%s port=%s"
         % (py, p.pid, novel_port()))
    return True, ""


def ensure_running(wait=30.0):
    """确保后端可用；并发请求只拉起一次。返回 (ok, err)。"""
    if not novel_enabled():
        return False, "小说后端已禁用（config.json novel_enable=false）"
    if _healthy():
        return True, ""
    with _LOCK:
        if _healthy():           # 等锁期间可能已被其它请求拉起
            return True, ""
        p = _PROC.get("p")
        if p is None or p.poll() is not None:
            ok, err = _spawn()
            if not ok:
                return False, err
        t0 = time.time()
        while time.time() - t0 < wait:
            if _healthy():
                slog("info", "novel", "小说后端就绪，用时 %.1fs" % (time.time() - t0))
                return True, ""
            p = _PROC.get("p")
            if p is not None and p.poll() is not None:
                msg = "小说后端启动后立即退出（码 %s），详见 logs/novel.log" % p.returncode
                slog("error", "novel", msg)
                return False, msg
            time.sleep(0.5)
        msg = "小说后端启动超时（%ds），详见 logs/novel.log" % int(wait)
        slog("error", "novel", msg)
        return False, msg


def stop_novel():
    p = _PROC.get("p")
    if p is not None and p.poll() is None:
        try:
            p.terminate()
            p.wait(timeout=5)
            slog("info", "novel", "已停止小说后端 pid=%s" % p.pid)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    _PROC["p"] = None


atexit.register(stop_novel)


def proxy_novel(rel):
    """把 /__nova__/<rel>（rel 以 novel/ 开头）代理到本机小说后端。

    支持任意方法；响应以流式回传（导出/下载可能几十 MB），逐跳头剥离。
    """
    ok, err = ensure_running()
    if not ok:
        return jsonify({"ok": False, "error": err}), 503
    url = upstream(rel)
    qs = request.query_string.decode("latin1", errors="ignore")
    if qs:
        url += "?" + qs
    fwd = {k: v for k, v in request.headers.items()
           if k.lower() not in ("host", "connection", "content-length",
                                "accept-encoding", "if-none-match",
                                "if-modified-since")}
    try:
        up = requests.request(request.method, url, data=request.get_data(),
                              headers=fwd, timeout=_UP_TIMEOUT, stream=True,
                              allow_redirects=True)
    except Exception as e:
        slog("error", "novel", "代理 %s 失败：%s" % (rel, e))
        return jsonify({"ok": False, "error": "连接小说后端失败：%s" % e}), 502
    headers = {k: v for k, v in up.headers.items() if k.lower() not in _HOP}

    def gen():
        try:
            for chunk in up.iter_content(65536):
                if chunk:
                    yield chunk
        finally:
            up.close()

    resp = Response(gen(), status=up.status_code)
    for k, v in headers.items():
        resp.headers[k] = v
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Cache-Control"] = "no-store"
    if up.status_code >= 400:
        slog("warn", "novel", "%s %s -> %s" % (request.method, rel[:200], up.status_code))
    return resp