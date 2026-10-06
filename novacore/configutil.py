# -*- coding: utf-8 -*-
"""配置加载/保存/校验与目录约定。"""
import json
import os
import re
import threading

from novacore.paths import HERE, CONFIG_PATH

BROWSER_KEYS = [
    "debug", "serve_scheme", "serve_host", "mount",
    "trigger_hotkey_enable", "trigger_hotkey_key", "trigger_hotkey_ctrl",
    "trigger_hotkey_shift", "trigger_hotkey_alt",
    "trigger_tap_enable", "trigger_tap_corner", "trigger_tap_count",
    "trigger_tap_radius", "trigger_tap_interval_ms",
    "trigger_urlparam_enable", "trigger_urlparam_name", "trigger_urlparam_value",
    "trigger_search_enable", "trigger_search_keyword",
    "exit_action",
]

_cfglock = threading.Lock()
CONFIG = {}


def load_config():
    # 必须原地更新：其他模块用 `from configutil import CONFIG` 绑定的是同一个 dict
    # 对象，重绑定会让它们永远拿着启动前的空字典。
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    with _cfglock:
        CONFIG.clear()
        CONFIG.update(data)
    return CONFIG


def cfg(key, default=None):
    with _cfglock:
        return CONFIG.get(key, default)


def save_config(new_cfg):
    global CONFIG
    with _cfglock:
        CONFIG.clear()
        CONFIG.update(new_cfg)
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(CONFIG, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_PATH)


def novaos_dir():
    return os.path.abspath(os.path.join(HERE, str(cfg("novaos_dir", "./novaos"))))


def fs_root():
    """本地文件系统应用的根目录（防逃逸边界）。"""
    r = str(cfg("fs_root", "") or "").strip()
    if not r:
        r = os.path.expanduser("~")
    return os.path.abspath(r)


def mount_prefix():
    m = str(cfg("mount", "/__nova__/"))
    if not m.startswith("/"):
        m = "/" + m
    if not m.endswith("/"):
        m += "/"
    return m


# ----------------------------- 校验 -----------------------------
def validate(c):
    errors = {}

    def need(cond, key, msg):
        if not cond:
            errors[key] = msg

    def as_int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    need(isinstance(c.get("serve_host"), str) and re.match(r"^[a-z0-9.\-]+$", c.get("serve_host", "")),
         "serve_host", "域名格式不正确（必填）")
    need(re.match(r"^/[A-Za-z0-9_\-./]+/$", str(c.get("mount", ""))),
         "mount", "必须形如 /__nova__/（斜杠包裹，仅字母数字-_/，必填）")
    nd = os.path.abspath(os.path.join(HERE, str(c.get("novaos_dir", ""))))
    need(os.path.isfile(os.path.join(nd, "index.html")), "novaos_dir",
         "目录下缺少 index.html：%s" % nd)

    for k, lo, hi in (("http_port", 1, 65535), ("admin_port", 1, 65535)):
        v = as_int(c.get(k))
        need(v is not None and lo <= v <= hi, k, "需为 %d-%d 的整数" % (lo, hi))
    need(int(as_int(c.get("http_port")) or 0) != int(as_int(c.get("admin_port")) or -1),
         "admin_port", "管理端口不能与 HTTP 端口相同")

    # 内置正向代理（网页代理出站通道）监听端口
    if c.get("webproxy_port") is not None:
        v = as_int(c.get("webproxy_port"))
        need(v is not None and 1 <= v <= 65535, "webproxy_port", "需为 1-65535 的整数")

    # 小说下载后端（本机 novelsrc 聚合服务）监听端口
    if c.get("novel_port") is not None:
        v = as_int(c.get("novel_port"))
        need(v is not None and 1 <= v <= 65535, "novel_port", "需为 1-65535 的整数")

    if c.get("inject_enable"):
        need(bool(str(c.get("inject_path_pattern", "")).strip()), "inject_path_pattern", "启用注入时为必填")

    # DNS 应答（热点劫持 / 局域网代理两种模式下都可能启用）
    if c.get("dns_enable"):
        doms = c.get("hijack_domains")
        need(isinstance(doms, list) and all(isinstance(d, str) and d.strip() for d in doms),
             "hijack_domains", "启用 DNS 时至少填一个域名")
        ups = c.get("dns_upstreams")
        need(isinstance(ups, list) and len(ups) >= 1, "dns_upstreams", "至少配置一个上游 DNS")

    if c.get("trigger_hotkey_enable"):
        need(len(str(c.get("trigger_hotkey_key", "")).strip()) >= 1, "trigger_hotkey_key",
             "启用热键时为必填，如 y / o / F2")

    if c.get("trigger_tap_enable"):
        cnt = as_int(c.get("trigger_tap_count"))
        need(cnt is not None and 1 <= cnt <= 9, "trigger_tap_count", "范围 1-9")
        rad = as_int(c.get("trigger_tap_radius"))
        need(rad is not None and 8 <= rad <= 64, "trigger_tap_radius", "范围 8-64 px")
        iv = as_int(c.get("trigger_tap_interval_ms"))
        need(iv is not None and 300 <= iv <= 5000, "trigger_tap_interval_ms", "范围 300-5000 ms")
        need(c.get("trigger_tap_corner") in ("top-left", "top-right", "bottom-left", "bottom-right"),
             "trigger_tap_corner", "必须是四个角之一")

    if c.get("trigger_urlparam_enable"):
        need(bool(str(c.get("trigger_urlparam_name", "")).strip()), "trigger_urlparam_name", "启用暗参时参数名必填")

    if c.get("trigger_search_enable"):
        kw = str(c.get("trigger_search_keyword", "")).strip()
        need(2 <= len(kw) <= 32 and re.match(r"^[A-Za-z0-9\-_]+$", kw),
             "trigger_search_keyword", "口令需为 2-32 位字母/数字/-/_")

    return errors