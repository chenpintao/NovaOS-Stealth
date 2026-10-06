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
    递归扫描全部 .html（含 apps/、lib/ 等子目录内的页面），引用按该 HTML
    所在目录解析；跳过 dist/archive/logs/node_modules 等非运行目录。
    返回 (changed:list[str], errors:list[str])。"""
    root = novaos_dir()
    changed = []
    errors = []
    # 支持 相对路径（apps/x.js）、根相对（/apps/x.js）两种写法；
    # 排除 http(s):// 等带协议的绝对外链与 data: 内联。
    pat = re.compile(r'((?:src|href)=")(/?(?!https?:|data:|#)[^"?]+)\?v=\d+(")')
    skip_dirs = {"dist", "archive", "logs", "node_modules", "__pycache__", ".git"}

    def bump_html(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            html = f.read()
        base_dir = os.path.dirname(html_path)

        def repl(m):
            rel = m.group(2)
            if rel.startswith("/"):                 # 根相对 → 以 novaos2 根为基准
                fp = os.path.join(root, rel.lstrip("/").replace("/", os.sep))
            else:                                   # 普通相对 → 以该 HTML 所在目录为基准
                fp = os.path.normpath(os.path.join(base_dir, rel.replace("/", os.sep)))
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
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in skip_dirs]
            for name in filenames:
                if name.endswith(".html"):
                    try:
                        bump_html(os.path.join(dirpath, name))
                    except Exception as e:
                        errors.append("%s: %s" % (name, e))
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
        add_dir(os.path.join(HERE, "novelsrc"), "novelsrc",
                skip_dirs=("__pycache__",))
        add_dir(os.path.join(HERE, "tools"), "tools",
                skip_dirs=("__pycache__",))
        for name in ("config.json", "loader.js", "boot-stub.js", "bridge.js",
                     "novaosd.py", "server.py", "novel_server.py",
                     "requirements.txt", "README.md", "BUILD.md",
                     "install.bat", "start.bat", "stop-hotspot.bat",
                     "build_all.bat", "build_runtime.ps1",
                     "enable-hotspot.ps1", "disable-hotspot.ps1",
                     "set-hotspot-credentials.ps1"):
            fp = os.path.join(HERE, name)
            if os.path.isfile(fp):
                z.write(fp, name)
    return mem.getvalue()


def backup_filename():
    return "novaos-backup-%s.zip" % time.strftime("%Y%m%d-%H%M%S")


# ----------------------------- 平板文件备份到电脑 -----------------------------
TABLET_BACKUP_DIR = os.path.join(HERE, "backups", "tablet")
TABLET_KEEP = 10                    # 最多保留 10 次平板备份
PUSH_MAX_BYTES = 1024 * 1024 * 1024  # 单文件 1GB 上限

_backup_sessions = {}
_backup_lock = __import__("threading").Lock()


def _safe_rel(vpath):
    """把平板虚拟路径规整为相对路径，禁止任何盘符/绝对路径/越界写法。"""
    p = str(vpath or "").replace("\\", "/").lstrip("/")
    parts = []
    for seg in p.split("/"):
        if seg in ("", "."):
            continue
        if seg == ".." or ":" in seg or ord(seg[0]) == 0:
            raise ValueError("非法路径")
        parts.append(seg)
    if not parts:
        raise ValueError("空路径")
    return os.path.join(*parts)


def tablet_backup_begin(manifest):
    """开一次平板备份会话。manifest: {device, scope, files:[{path,name,size,mime,mtime}]}
    scope="music" 为音乐歌单单独备份，会话目录/zip 名带 music- 前缀。"""
    # 白名单前缀，防止 manifest 注入非法文件名
    prefix = "music-" if str((manifest or {}).get("scope", "")) == "music" else ""
    sid = prefix + time.strftime("%Y%m%d-%H%M%S")
    # 同一秒重复开始：追加序号。除活动会话外，还要避开上一次备份已落盘的
    # 同名目录/zip（会话 commit 后即从内存移除），否则两次备份会互相覆盖。
    with _backup_lock:
        base = sid
        n = 1
        while sid in _backup_sessions:
            n += 1
            sid = "%s-%d" % (base, n)
        d = os.path.join(TABLET_BACKUP_DIR, sid)
        n = 1
        while os.path.exists(d) or os.path.exists(d + ".zip"):
            n += 1
            sid = "%s-%d" % (base, n)
            d = os.path.join(TABLET_BACKUP_DIR, sid)
        os.makedirs(os.path.join(d, "vfs"), exist_ok=True)
        _backup_sessions[sid] = {
            "dir": d, "manifest": manifest or {}, "got": 0,
            "bytes": 0, "started": time.time()}
    try:
        from novacore.paths import slog
        slog("info", "backup", "开始备份会话 %s scope=%s 文件数=%d" % (
            sid, (manifest or {}).get("scope", "all"),
            len((manifest or {}).get("files") or [])))
    except Exception:
        pass
    return sid


def tablet_backup_push(sid, vpath, stream):
    """接收一个文件，流式写入会话目录（避免大文件打爆内存）。"""
    with _backup_lock:
        sess = _backup_sessions.get(sid)
    if not sess:
        raise KeyError("备份会话不存在或已过期，请重新开始")
    rel = _safe_rel(vpath)
    dst = os.path.join(sess["dir"], "vfs", rel)
    real_dir = os.path.dirname(dst)
    os.makedirs(real_dir, exist_ok=True)
    # 最终落盘路径必须仍在会话目录内
    if os.path.commonpath([os.path.abspath(dst),
                           os.path.abspath(sess["dir"])]) != os.path.abspath(sess["dir"]):
        raise ValueError("非法路径")
    total = 0
    with open(dst, "wb") as f:
        while True:
            chunk = stream.read(1024 * 256)
            if not chunk:
                break
            total += len(chunk)
            if total > PUSH_MAX_BYTES:
                f.close()
                try:
                    os.remove(dst)
                except OSError:
                    pass
                raise ValueError("单文件超过 1GB 上限")
            f.write(chunk)
    with _backup_lock:
        sess["got"] += 1
        sess["bytes"] += total
    return {"rel": rel.replace(os.sep, "/"), "size": total}


def tablet_backup_commit(sid):
    """收尾：写清单与 localStorage 快照，打包 zip，清理旧会话。"""
    import json
    with _backup_lock:
        sess = _backup_sessions.pop(sid, None)
    if not sess:
        raise KeyError("备份会话不存在")
    d = sess["dir"]
    with open(os.path.join(d, "_manifest.json"), "w", encoding="utf-8") as f:
        json.dump(sess.get("manifest", {}), f, ensure_ascii=False, indent=1)
    # 统计实际落盘文件
    file_count = 0
    for _, _, files in os.walk(os.path.join(d, "vfs")):
        file_count += len(files)
    zip_path = d + ".zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dp, _, fns in os.walk(d):
            for fn in fns:
                fp = os.path.join(dp, fn)
                z.write(fp, os.path.join(sid, os.path.relpath(fp, d)))
    # 清理最旧的若干次
    try:
        entries = []
        for name in os.listdir(TABLET_BACKUP_DIR):
            p = os.path.join(TABLET_BACKUP_DIR, name)
            if os.path.isdir(p):
                entries.append((os.path.getmtime(p), p))
        entries.sort()
        for _, p in entries[:-TABLET_KEEP] if len(entries) > TABLET_KEEP else []:
            import shutil
            shutil.rmtree(p, ignore_errors=True)
    except Exception:
        pass
    return {"name": sid + ".zip", "files": file_count,
            "bytes": sess.get("bytes", 0), "zip": os.path.getsize(zip_path)}


# ----------------------------- 平板调试日志 -----------------------------
def append_tablet_log(remote, lines, ua=""):
    """调试模式下平板回传的 console/异常日志，按天落 logs/tablet-YYYYMMDD.log。"""
    log_dir = os.path.join(HERE, "logs")
    os.makedirs(log_dir, exist_ok=True)
    fp = os.path.join(log_dir, "tablet-%s.log" % time.strftime("%Y%m%d"))
    ts = time.strftime("%H:%M:%S")
    rows = []
    for ln in (lines or [])[:500]:
        s = str(ln).replace("\r", " ").replace("\n", " ")[:4000]
        rows.append("[%s] %s UA=%s | %s\n" % (ts, remote or "-", (ua or "")[:80], s))
    with open(fp, "a", encoding="utf-8") as f:
        f.write("".join(rows))
    try:
        from novacore.paths import slog
        if lines:
            slog("debug", "tablog", "%s 回传 %d 条 -> %s | 首条: %s" % (
                remote or "-", len(lines), os.path.basename(fp),
                str(lines[0]).replace("\n", " ")[:160]))
    except Exception:
        pass
    return len(rows)


# ----------------------------- Tzy 应用仓库（.tzyp） -----------------------------
# 电脑端把制作好的应用包放进 apps_repo/ 即对外成仓，平板在「应用商店」安装/更新。
APP_REPO_DIR = os.path.join(HERE, "apps_repo")
APP_PKG_MAX = 64 * 1024 * 1024
_APP_ID_RE = __import__("re").compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def _ver_key(v):
    out = []
    for seg in str(v or "0").split("."):
        num = ""
        for ch in seg:
            if ch.isdigit():
                num += ch
            else:
                break
        out.append(int(num) if num else 0)
    return out


def read_app_manifest(fp):
    """读取 .tzyp 内 app.json 并做基础校验，返回清单 dict。非法抛 ValueError。"""
    import json
    try:
        with zipfile.ZipFile(fp) as z:
            for n in z.namelist():
                if n.startswith("/") or n.startswith("\\") or ".." in n.split("/") \
                        or ":" in n:
                    raise ValueError("包内非法路径: %s" % n)
            info = z.getinfo("app.json")
            if info.file_size > 64 * 1024:
                raise ValueError("app.json 过大")
            meta = json.loads(z.read("app.json").decode("utf-8"))
    except ValueError:
        raise
    except Exception as e:
        raise ValueError("无法读取应用包: %s" % e)
    if not isinstance(meta, dict) or not meta.get("id") or not meta.get("name"):
        raise ValueError("清单缺少 id/name")
    if not _APP_ID_RE.match(str(meta["id"])):
        raise ValueError("id 非法")
    return meta


def app_repo_catalog():
    """扫描 apps_repo/*.tzyp，同一 id 取版本号最高者，返回清单列表。"""
    if not os.path.isdir(APP_REPO_DIR):
        return []
    best = {}   # id -> (ver_key, item)
    for name in os.listdir(APP_REPO_DIR):
        if not name.lower().endswith(".tzyp"):
            continue
        fp = os.path.join(APP_REPO_DIR, name)
        if not os.path.isfile(fp) or os.path.getsize(fp) > APP_PKG_MAX:
            continue
        try:
            meta = read_app_manifest(fp)
        except Exception:
            continue
        item = {
            "id": str(meta["id"]),
            "name": str(meta.get("name") or meta["id"]),
            "version": str(meta.get("version") or "1.0.0"),
            "main": str(meta.get("main") or "main.js"),
            "icon": str(meta.get("icon") or "📦"),
            "tone": str(meta.get("tone") or "tone-blue"),
            "maximize": bool(meta.get("maximize")),
            "desktop": meta.get("desktop", True) is not False,
            "preinstall": bool(meta.get("preinstall")),
            "desc": str(meta.get("desc") or ""),
            "author": str(meta.get("author") or ""),
            "file": name,
            "size": os.path.getsize(fp),
        }
        cur = best.get(item["id"])
        if not cur or _ver_key(item["version"]) > _ver_key(cur["version"]):
            best[item["id"]] = item
    return [best[k] for k in sorted(best.keys())]


def app_repo_package(name):
    """安全定位仓库内包文件；越界/不存在返回 None。"""
    name = os.path.basename(str(name or ""))
    if not name.lower().endswith(".tzyp"):
        return None
    fp = os.path.abspath(os.path.join(APP_REPO_DIR, name))
    try:
        if os.path.commonpath([fp, os.path.abspath(APP_REPO_DIR)]) != \
                os.path.abspath(APP_REPO_DIR):
            return None
    except ValueError:
        return None
    return fp if os.path.isfile(fp) else None
