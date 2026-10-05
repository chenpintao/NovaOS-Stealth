# -*- coding: utf-8 -*-
"""Tzy OS installer / preflight.
Usage:
    python nova_setup.py             interactive menu
    python nova_setup.py --mode 1    hotspot DNS hijack mode
    python nova_setup.py --mode 2    LAN proxy mode
    python nova_setup.py --check     preflight checks only
    python nova_setup.py --deps      install python dependencies only
Loshop & Cpt"""
import argparse
import ctypes
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

CONFIG_PATH = os.path.join(ROOT, "config.json")
REQUIREMENTS = os.path.join(ROOT, "requirements.txt")

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def find_chrome():
    for p in CHROME_CANDIDATES:
        if os.path.isfile(p):
            return p
    return None


def runtime_python():
    """内嵌便携运行时解释器（随包分发，目标机免装 Python）。"""
    p = os.path.join(ROOT, "runtime", "python", "python.exe")
    return p if os.path.isfile(p) else None


def is_win7():
    try:
        return sys.platform == "win32" and sys.getwindowsversion()[:2] == (6, 1)
    except Exception:
        return False


def ucrt_ok():
    """Win7 上 Python 3.8 依赖 UCRT（KB2999226 提供）。"""
    try:
        ctypes.WinDLL("api-ms-win-crt-runtime-l1-1-0.dll")
        return True
    except Exception:
        return False


def install_deps():
    if runtime_python():
        print("[*] Embedded runtime found - dependencies are bundled, skipping pip.")
        return True
    print("[*] Installing python dependencies ...")
    rc = subprocess.call([sys.executable, "-m", "pip", "install", "-r", REQUIREMENTS])
    if rc != 0:
        print("[!] pip install failed (need internet on first run).")
        return False
    return True


def check_modules():
    missing = []
    for mod in ("flask", "requests", "websocket"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    optional = []
    for mod in ("bs4", "lxml", "Crypto", "cryptography", "ebooklib", "charset_normalizer"):
        try:
            __import__(mod)
        except ImportError:
            optional.append(mod)
    if optional:
        print("[i] Missing (novel backend needs these) :", ", ".join(optional))
    return missing, optional


def preflight():
    ok = True
    print("== Tzy OS preflight ==")
    print("[*] Python interpreter      :", sys.executable)
    rt = runtime_python()
    print("[*] Embedded runtime        :", rt or "NOT FOUND (using system Python)")
    if is_win7():
        print("[i] Windows 7 detected      : requires UCRT update KB2999226 (see BUILD.md)")
        print("[i] UCRT present            :", "YES" if ucrt_ok() else "NO - install KB2999226")
    print("[*] Running as administrator :", "YES" if is_admin() else "NO (needed for port 53/80)")
    if not is_admin():
        ok = False
    missing, optional = check_modules()
    if missing:
        print("[!] Missing core modules   :", ", ".join(missing))
        ok = False
    else:
        print("[*] Core python modules     : OK (flask, requests, websocket)")
    chrome = find_chrome()
    print("[*] Chrome/Edge for CDP      :", chrome or "NOT FOUND (remote browser disabled)")
    print("[*] config.json              :", "OK" if os.path.isfile(CONFIG_PATH) else "MISSING")
    print("[*] novaos2/index.html       :",
          "OK" if os.path.isfile(os.path.join(ROOT, "novaos2", "index.html")) else "MISSING")
    return ok


def set_mode(mode):
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if mode == 1:
        # 模式 1：热点 DNS 劫持（缓存投毒默认开，断劫持后仍可离线唤起）
        cfg["lan_mode"] = False
        cfg["dns_enable"] = True
        cfg["cache_poison"] = True
    else:
        # 模式 2：局域网模式。DNS 应答默认开启（平板 Wi-Fi 的 DNS 手动指向本机，
        # 只解析 hijack_domains 里的平台域名，其余域名照常转发），
        # 但缓存投毒默认关闭，避免污染平板对其它站点的缓存；需要时可在管理界面开。
        cfg["lan_mode"] = True
        cfg["dns_enable"] = True
        cfg["cache_poison"] = False
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)
    print("[*] Mode %d written to config.json." % mode)


def main():
    ap = argparse.ArgumentParser(description="Tzy OS stealth installer")
    ap.add_argument("--mode", type=int, choices=(1, 2),
                    help="1=hotspot DNS hijack, 2=LAN proxy")
    ap.add_argument("--check", action="store_true", help="preflight checks only")
    ap.add_argument("--deps", action="store_true", help="install dependencies only")
    args = ap.parse_args()

    if args.check:
        sys.exit(0 if preflight() else 1)
    if args.deps:
        sys.exit(0 if install_deps() else 1)

    mode = args.mode
    if mode is None:
        print("================================")
        print(" Tzy OS Stealth Installer")
        print("================================")
        print(" [1] Hotspot DNS Hijack Mode")
        print("     (tablet connects to PC hotspot; DNS hijack + cache poison)")
        print(" [2] LAN Mode")
        print("     (no hotspot; set tablet Wi-Fi DNS to this PC's LAN IP,")
        print("      then open the column page as usual - no custom URL needed)")
        sel = input("Select mode [1/2]: ").strip()
        if sel not in ("1", "2"):
            print("Invalid selection.")
            sys.exit(1)
        mode = int(sel)

    missing, _ = check_modules()
    if missing:
        if not install_deps():
            sys.exit(1)
    set_mode(mode)
    preflight()
    print("[*] Starting service ... (mode %d)" % mode)
    subprocess.call([sys.executable, os.path.join(ROOT, "novaosd.py")], cwd=ROOT)


if __name__ == "__main__":
    main()
