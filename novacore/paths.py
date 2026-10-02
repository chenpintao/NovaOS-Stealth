# -*- coding: utf-8 -*-
"""部署路径常量与访问日志。
Nuitka onefile 编译后 __file__ 位于临时解压目录，必须以 exe 所在目录为 APP_DIR。"""
import os
import sys
import threading


def app_dir():
    try:
        import __compiled__  # noqa: F401  仅 Nuitka 编译产物存在
        d = os.path.dirname(os.path.abspath(sys.argv[0]))
        # 工具 exe 可能从 dist/ 拷出单独运行：exe 旁没有 config.json 时退回当前工作目录
        if not os.path.isfile(os.path.join(d, "config.json")) and os.path.isfile(
                os.path.join(os.getcwd(), "config.json")):
            return os.getcwd()
        return d
    except Exception:
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