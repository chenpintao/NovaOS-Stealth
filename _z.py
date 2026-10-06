# -*- coding: utf-8 -*-
"""追踪 subscriber/cache/browser/backup 路径含义。跑完即删。"""
import json
import requests

BASE = "http://127.0.0.1:8899"


def ex(code, timeout=15):
    try:
        r = requests.post(BASE + "/api/dev/exec",
                          json={"cmd": "eval", "args": {"code": "(function(){"
                                + code + "})()"}, "timeout": timeout},
                          timeout=timeout + 8)
        return r.json()
    except Exception as e:
        return {"ok": False, "error": repr(e)}


def show(t, r):
    d = r.get("data") if isinstance(r, dict) else None
    print("\n### " + t)
    print(json.dumps(d if d is not None else r, ensure_ascii=False, indent=1)[:1500])


show("1. 当前页面 URL 与 pathname", ex(
    "return {href: location.href, pathname: location.pathname,"
    " origin: location.origin, host: location.host};"))

show("2. CacheStorage / ServiceWorker", ex(
    "var out = {sw: typeof navigator.serviceWorker, caches: typeof caches};"
    "if (typeof caches !== 'undefined') {"
    "  return caches.keys().then(function(k){ out.cacheNames = k; return out; })"
    "    .catch(function(e){ out.err = String(e); return out; });"
    "}"
    "return out;"))

show("3. location.search / hash / referrer", ex(
    "return {search: location.search, hash: location.hash,"
    " referrer: document.referrer};"))

show("4. 枚举 localStorage 全部键值（找 subscriber 线索）", ex(
    "var o = {};"
    "for (var i = 0; i < localStorage.length; i++) {"
    "  var k = localStorage.key(i); var v = localStorage.getItem(k);"
    "  o[k] = v && v.length > 80 ? v.slice(0,80) + '…(' + v.length + ')' : v;"
    "}"
    "return o;"))
