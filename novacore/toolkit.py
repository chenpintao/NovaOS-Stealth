# -*- coding: utf-8 -*-
"""升级（入口 HTML 引用版本号刷新）与备份打包，HTTP 接口与 CLI 共用。"""
import io
import os
import re
import time
import zipfile

from novacore.configutil import novaos_dir
from novacore.paths import HERE, CONFIG_PATH, LOADER_PATH, BOOT_STUB_PATH, BRIDGE_PATH


def bump_entry_versions():
    """把 novaos2 下所有入口 HTML 中本地引用的 ?v=N 重写为文件 mtime。
    返回 (changed:list[str], errors:list[str])。"""
    root = novaos_dir()
    changed = []
    errors = []
    pat = re.compile(r'((?:src|href)=")([^":/#][^"?]*)\?v=\d+(")')

    def bump_html(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()

        def repl(m):
            rel = m.group(2)
            fp = os.path.join(root, rel.replace("/", os.sep))
            if not os.path.isfile(fp):
                return m.group(0)
            v = str(int(os.path.getmtime(fp)))
            old = m.group(0)
            new = m.group(1) + rel + "?v=" + v + m.group(3)
            if new != old and rel not in changed:
                changed.append(rel)
            return new

        new_html = pat.sub(repl, html)
        if new_html != html:
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(new_html)

    try:
        for name in os.listdir(root):
            if name.endswith(".html"):
                bump_html(os.path.join(root, name))
    except Exception as e:
        errors.append(str(e))
    return changed, errors


def build_backup_zip():
    """打包 novaos2 全量 + 引导/配置/服务端源码与脚本，返回 zip 字节。
    不含 logs、dist、archive（体积大或与运行无关）。"""
    mem = io.BytesIO()
    root = novaos_dir()

    def add_dir(src_dir, arc_prefix, skip_dirs=()):
        if not os.path.isdir(src_dir):
            return
        for dirpath, dirnames, filenames in os.walk(src_dir):
            dirnames[:] = [d for d in dirnames if d not in skip_dirs]
            for name in filenames:
                if name.endswith((".pyc", ".pyo")):
                    continue
                fp = os.path.join(dirpath, name)
                arc = os.path.join(arc_prefix, os.path.relpath(fp, src_dir))
                z.write(fp, arc.replace(os.sep, "/"))

    with zipfile.ZipFile(mem, "w", zipfile.ZIP_DEFLATED) as z:
        add_dir(root, os.path.basename(root))
        add_dir(os.path.join(HERE, "novacore"), "novacore",
                skip_dirs=("__pycache__",))
        add_dir(os.path.join(HERE, "tools"), "tools",
                skip_dirs=("__pycache__",))
        for name in ("config.json", "loader.js", "boot-stub.js", "bridge.js",
                     "novaosd.py", "server.py", "requirements.txt", "README.md",
                     "install.bat", "start.bat", "stop-hotspot.bat",
                     "build_all.bat",
                     "enable-hotspot.ps1", "disable-hotspot.ps1",
                     "set-hotspot-credentials.ps1"):
            fp = os.path.join(HERE, name)
            if os.path.isfile(fp):
                z.write(fp, name)
    return mem.getvalue()


def backup_filename():
    return "novaos-backup-%s.zip" % time.strftime("%Y%m%d-%H%M%S")
