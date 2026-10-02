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


def install_deps():
    print("[*] Installing python dependencies ...")
    rc = subprocess.call([sys.executable, "-m", "pip", "install", "-r", REQUIREMENTS])
    if rc != 0:
        print("[!] pip install failed (need internet on first run).")
        return False
    return True


def check_modules():
    missing = []
    for mod in ("flask", "requests"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    optional = []
    try:
        import websocket  # noqa: F401
    except ImportError:
        optional.append("websocket-client (needed by CDP remote browser)")
    return missing, optional


def preflight():
    ok = True
    print("== Tzy OS preflight ==")
    print("[*] Running as administrator :", "YES" if is_admin() else "NO (needed for port 53/80)")
    if not is_admin():
        ok = False
    missing, optional = check_modules()
    if missing:
        print("[!] Missing core modules   :", ", ".join(missing))
        ok = False
    else:
        print("[*] Core python modules     : OK (flask, requests)")
    for m in optional:
        print("[i] Optional missing        :", m)
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
        cfg["lan_mode"] = False
        cfg["dns_enable"] = True
    else:
        cfg["lan_mode"] = True
        cfg["dns_enable"] = False
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
        print(" [2] LAN Proxy Mode")
        print("     (same LAN; open http://PC_IP/__nova__/ directly)")
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
