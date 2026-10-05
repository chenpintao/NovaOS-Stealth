# -*- coding: utf-8 -*-
"""部署路径常量与访问日志。
本项目直接分发源码（不编译），部署根目录即本文件的上上级目录。"""
import os
import threading
import time


def app_dir():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


APP_DIR = HERE = app_dir()
CONFIG_PATH = os.path.join(HERE, "config.json")
LOADER_PATH = os.path.join(HERE, "loader.js")
BRIDGE_PATH = os.path.join(HERE, "bridge.js")
BOOT_STUB_PATH = os.path.join(HERE, "boot-stub.js")
BOOT_NAME = "__boot__.js"            # no-cache：最新 loader+配置，随时可更新
BOOT_SNAPSHOT = "__boot__.snapshot.js"  # 一年长缓存：断劫持离线兜底
ADMIN_DIR = os.path.join(HERE, "admin")
LOG_DIR = os.path.join(HERE, "logs")
ACCESS_LOG = os.path.join(LOG_DIR, "access.log")
_log_lock = threading.Lock()


def write_access(line):
    """平板等设备访问日志，用于定位 iframe/资源加载失败。"""
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with _log_lock:
            if os.path.isfile(ACCESS_LOG) and os.path.getsize(ACCESS_LOG) > 2 * 1024 * 1024:
                try:
                    if os.path.isfile(ACCESS_LOG + ".1"):
                        os.remove(ACCESS_LOG + ".1")
                    os.rename(ACCESS_LOG, ACCESS_LOG + ".1")
                except OSError:
                    pass
            with open(ACCESS_LOG, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError:
        pass


# ----------------------------- 统一服务端日志 -----------------------------
# logs/server-YYYYMMDD.log（按天 + 1MB 轮转 .1），所有模块共用，不另建日志体系。
# 调试开关（config.json "debug"）关闭时只落 WARN/ERROR；开启后 DEBUG/INFO 全落盘。
_slog_lock = threading.Lock()
_slog_state = {"debug": False}
SLOG_MAX = 1024 * 1024
_LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}


def set_slog_debug(on):
    _slog_state["debug"] = bool(on)


def slog_debug():
    return _slog_state["debug"]


def slog(level, tag, msg=""):
    """level: debug/info/warn/error；tag: 模块短名（如 music/net/cdp）。"""
    lv = str(level or "info").lower()
    if lv not in _LEVELS:
        lv = "info"
    # 非调试模式：debug/info 不落盘（error/warn 始终保留，故障可追溯）
    if _LEVELS[lv] < _LEVELS["warn"] and not _slog_state["debug"]:
        return
    line = "%s %-5s [%-6s] %s" % (
        time.strftime("%Y-%m-%d %H:%M:%S"), lv.upper(), str(tag)[:6], msg)
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        fp = os.path.join(LOG_DIR, "server-%s.log" % time.strftime("%Y%m%d"))
        with _slog_lock:
            if os.path.isfile(fp) and os.path.getsize(fp) > SLOG_MAX:
                try:
                    if os.path.isfile(fp + ".1"):
                        os.remove(fp + ".1")
                    os.rename(fp, fp + ".1")
                except OSError:
                    pass
            with open(fp, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError:
        pass