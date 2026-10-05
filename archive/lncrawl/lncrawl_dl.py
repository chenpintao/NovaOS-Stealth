# -*- coding: utf-8 -*-
"""lightnovel-crawler 后端进程管理 + 反向代理。

lightnovel-crawler（lncrawl）是 Python 多源小说抓取库，内置 446 个 crawler
（含 17 个中文源、300+ 外文源）。这里把 lncrawl_server.py 作为子进程按需拉起，
再把它代理到 Tzy OS 挂载点下，供平板端小说应用调用（电脑代取外网）。

依赖：pip install lightnovel-crawler（已在 requirements 中）。
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

_SCRIPT = os.path.join(HERE, "lncrawl_server.py")
_WORKDIR = HERE
_LOCK = threading.Lock()
_PROC = {"p": None}
_HOP = ("content-encoding", "content-length", "transfer-encoding", "connection")
_UP_TIMEOUT = (10, 120)


def _python_exe():
    """定位运行 lncrawl_server.py 的 Python 解释器。

    优先级：
      1. 环境变量 LNCRAWL_PYTHON 显式指定
      2. 内嵌便携运行时 runtime\\python\\python.exe（目标机零依赖方案）
      3. 系统 PATH 里的 python / python3（开发机）
      4. 常见安装路径兜底
    返回空串表示未找到可用解释器。
    """
    env = (os.environ.get("LNCRAWL_PYTHON") or "").strip()
    if env and os.path.isfile(env):
        return env
    bundled = os.path.join(HERE, "runtime", "python", "python.exe")
    if os.path.isfile(bundled):
        return bundled
    if not getattr(sys, "frozen", False):
        return sys.executable
    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            return found
    # 兜底：常见安装路径
    for cand in (
        r"C:\Program Files\Python313\python.exe",
        r"C:\Program Files\Python312\python.exe",
        r"C:\Python313\python.exe",
    ):
        if os.path.isfile(cand):
            return cand
    return ""


def lncrawl_enabled():
    return bool(cfg("lncrawl_enable", True))


def lncrawl_port():
    try:
        return int(cfg("lncrawl_port", 18099))
    except (TypeError, ValueError):
        return 18099


def upstream(rel):
    """rel 形如 'lncrawl/healthz' → http://127.0.0.1:PORT/healthz

    lncrawl_server 的路由不带 lncrawl/ 前缀，故转发前剥除。
    """
    path = str(rel).lstrip("/")
    if path.startswith("lncrawl/"):
        path = path[len("lncrawl/"):]
    return "http://127.0.0.1:%d/%s" % (lncrawl_port(), path)


def _healthy(timeout=1.5):
    try:
        return requests.get(upstream("healthz"), timeout=timeout).status_code == 200
    except Exception:
        return False


def _spawn():
    if not os.path.isfile(_SCRIPT):
        msg = "未找到 lncrawl_server.py：%s" % _SCRIPT
        slog("error", "lncrawl", msg)
        return False, msg
    py = _python_exe()
    if not py:
        msg = ("未找到 Python 解释器：轻小说下载需内嵌运行时 runtime\\python"
               "（运行 build_lncrawl_runtime.bat 生成）或系统 Python3 + pip install lightnovel-crawler")
        slog("error", "lncrawl", msg)
        return False, msg
    data_dir = os.path.join(HERE, "lncrawl_data")
    env = dict(os.environ)
    env["LNCRAWL_DATA_PATH"] = data_dir
    env["LNCRAWL_PORT"] = str(lncrawl_port())
    env["PYTHONIOENCODING"] = "utf-8"
    flags = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        logf = open(os.path.join(LOG_DIR, "lncrawl.log"), "a",
                    encoding="utf-8", buffering=1)
        p = subprocess.Popen(
            [py, "-X", "utf8", _SCRIPT],
            cwd=_WORKDIR, env=env, stdout=logf, stderr=logf,
            creationflags=flags)
    except Exception as e:
        slog("error", "lncrawl", "启动 lncrawl_server 失败：%s" % e)
        return False, "启动 lncrawl 后端失败：%s" % e
    _PROC["p"] = p
    slog("info", "lncrawl", "已拉起 lncrawl_server(%s) pid=%s port=%s"
         % (py, p.pid, lncrawl_port()))
    return True, ""


def ensure_running(wait=30.0):
    """确保 lncrawl_server 可用；并发请求只拉起一次。返回 (ok, err)。"""
    if not lncrawl_enabled():
        return False, "lncrawl 后端已禁用（config.json lncrawl_enable=false）"
    if _healthy():
        return True, ""
    with _LOCK:
        if _healthy():
            return True, ""
        p = _PROC.get("p")
        if p is None or p.poll() is not None:
            ok, err = _spawn()
            if not ok:
                return False, err
        t0 = time.time()
        while time.time() - t0 < wait:
            if _healthy():
                slog("info", "lncrawl", "lncrawl_server 就绪，用时 %.1fs"
                     % (time.time() - t0))
                return True, ""
            p = _PROC.get("p")
            if p is not None and p.poll() is not None:
                msg = "lncrawl_server 启动后立即退出（码 %s），详见 logs/lncrawl.log" % p.returncode
                slog("error", "lncrawl", msg)
                return False, msg
            time.sleep(0.5)
        msg = "lncrawl_server 启动超时（%ds），详见 logs/lncrawl.log" % int(wait)
        slog("error", "lncrawl", msg)
        return False, msg


def stop_lncrawl():
    p = _PROC.get("p")
    if p is not None and p.poll() is None:
        try:
            p.terminate()
            p.wait(timeout=5)
            slog("info", "lncrawl", "已停止 lncrawl_server pid=%s" % p.pid)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    _PROC["p"] = None


atexit.register(stop_lncrawl)


def proxy_lncrawl(rel):
    """把 /__nova__/<rel>（rel 以 lncrawl/ 开头）代理到本机 lncrawl_server。"""
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
        slog("error", "lncrawl", "代理 %s 失败：%s" % (rel, e))
        return jsonify({"ok": False, "error": "连接 lncrawl 后端失败：%s" % e}), 502
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
        slog("warn", "lncrawl", "%s %s -> %s"
             % (request.method, rel[:200], up.status_code))
    return resp
