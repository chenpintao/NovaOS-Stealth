# -*- coding: utf-8 -*-
"""Tzy OS 音乐聚合 API：参考 UGOnlineMusicPlayer 各源官方算法重写，
播放链接官方算法拿不到时统一退 Meting 双实例兜底。
路由（sources.serve_nova_api 分发）：
  GET /__nova__/api/music/search?src=netease|qq|kuwo|kugou|joox&kw=...
  GET /__nova__/api/music/url?src=...&id=...          默认 302 到真实音频（audio 标签用）
  GET /__nova__/api/music/url?src=...&id=...&dl=1     电脑流式转发音频字节（下载/兜底用）
  GET /__nova__/api/music/lyric?src=...&id=...        {ok, lyric}
Loshop & Cpt"""
import base64
import json
import random
import re
import time

import requests
from flask import Response, redirect, request

from novacore.paths import slog
from novacore.sources import _api_json

requests.packages.urllib3.disable_warnings()

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36")

# Meting 第三方代理双实例（UGOnlineMusicPlayer 同款主备：qijieya 支持 VIP 解析）
METING = ("https://api.qijieya.cn/meting/", "https://api.injahow.cn/meting/")

SOURCES = ("netease", "qq", "kuwo", "kugou", "joox")

# JOOX 第三方接口（现状可用，保留）
JOOX_API = "https://apicx.asia/api/joox_music"
JOOX_TOKEN = "f84ao9lMF_q7husBWRfgUw"
JOOX_BR = 4


def _get(url, **kw):
    kw.setdefault("timeout", 12)
    kw.setdefault("verify", False)
    h = {"User-Agent": _UA}
    h.update(kw.pop("headers", {}) or {})
    t0 = time.time()
    try:
        r = requests.get(url, headers=h, **kw)
    except Exception as e:
        slog("debug", "music", "外呼失败 %dms %s | %s: %s" %
             (int((time.time() - t0) * 1000), url, type(e).__name__, e))
        raise
    slog("debug", "music", "外呼 %dms HTTP%s %s" %
         (int((time.time() - t0) * 1000), r.status_code, url))
    return r


def _j(url, **kw):
    return _get(url, **kw).json()


def _err(msg, status=502):
    return _api_json({"ok": False, "error": msg}, status)


# ============================== 搜索 ==============================

def _search_netease(kw, limit):
    """网易云老 API（weapi 在边缘 IP 易被风控，老接口直 GET 即可）。"""
    n = 1884815360 + random.randint(0, 1884890111 - 1884815360)
    rip = ".".join(str((n >> s) & 255) for s in (24, 16, 8, 0))
    j = _j("https://music.163.com/api/search/get",
           params={"s": kw, "type": 1, "limit": limit, "offset": 0},
           headers={"Referer": "https://music.163.com/",
                    "Cookie": "appver=8.2.30; os=iPhone OS; osver=15.0; EVNSM=1.0.0; "
                              "buildver=2206; channel=distribution; machineid=iPhone13.3",
                    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) "
                                  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
                                  "CloudMusic/0.1.1 NeteaseMusic/8.2.30",
                    "X-Real-IP": rip})
    out = []
    for s in ((j.get("result") or {}).get("songs") or [])[:limit]:
        artists = s.get("artists") or s.get("ar") or []
        out.append({"id": str(s.get("id") or ""), "title": s.get("name") or "",
                    "artist": "/".join(a.get("name", "") for a in artists),
                    "album": (s.get("album") or s.get("al") or {}).get("name", ""),
                    "duration": int((s.get("duration") or 0) / 1000), "vip": False})
    return [x for x in out if x["id"] and x["title"]]


def _search_qq(kw, limit):
    """QQ 官方 client_search_cp（new_json 字段：mid/name/singer[].name）。"""
    j = _j("https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
           params={"format": "json", "p": 1, "n": limit, "w": kw,
                   "aggr": 1, "lossless": 1, "cr": 1, "new_json": 1},
           headers={"Referer": "https://y.qq.com/"})
    out = []
    for s in ((((j.get("data") or {}).get("song") or {}).get("list")) or [])[:limit]:
        mid = s.get("mid") or ""
        if not mid:
            continue
        al = s.get("album") or {}
        out.append({"id": mid, "title": s.get("name") or s.get("title") or "",
                    "artist": "/".join(x.get("name", "") for x in (s.get("singer") or [])),
                    "album": al.get("name") or al.get("title") or "",
                    "duration": int(s.get("interval") or 0),
                    "vip": bool((s.get("pay") or {}).get("pay_play"))})
    return [x for x in out if x["title"]]


_KW_HEADERS = {"User-Agent": "okhttp/3.10.0"}


def _split_top_objects(arr_text):
    """把 r.s abslist 区域的顶层 {...} 对象逐个切出（值里含嵌套 {}，需引号感知的深度扫描）。"""
    objs, depth, start, in_q, esc = [], 0, -1, False, False
    for i, ch in enumerate(arr_text):
        if in_q:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == "'":
                in_q = False
            continue
        if ch == "'":
            in_q = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                objs.append(arr_text[start:i + 1])
                start = -1
    return objs


def _search_kuwo_rs(kw, limit):
    """酷我 search.kuwo.cn/r.s 兜底：返回单引号伪 JSON，切出顶层歌曲对象后逐字段提取。"""
    r = _get("http://search.kuwo.cn/r.s",
             params={"all": kw, "ft": "music", "newsearch": 1, "itemencoding": "utf8",
                     "cluster": 0, "pn": 0, "rn": limit, "rformat": "json",
                     "encoding": "utf8", "show_copyright_off": 1,
                     "ver": "mbox2", "vip_ver": "11"},
             headers=_KW_HEADERS)
    m = re.search(r"'abslist':\[(.*)\]", r.text, re.S)
    if not m:
        return []
    import html as _html

    def field(block, name):
        fm = re.search(r"'%s':'((?:[^'\\]|\\.)*)'" % name, block)
        return _html.unescape(fm.group(1)) if fm else ""

    out = []
    for block in _split_top_objects(m.group(1))[:limit]:
        rid = field(block, "MUSICRID")          # 形如 MUSIC_474678847
        name = field(block, "NAME")
        if not rid or not name:
            continue
        try:
            dur = int(field(block, "DURATION") or 0)
        except ValueError:
            dur = 0
        out.append({"id": rid, "title": name, "artist": field(block, "ARTIST"),
                    "album": field(block, "ALBUM"), "duration": dur, "vip": False})
    return out


def _search_kuwo(kw, limit):
    """酷我官网接口优先（需先拿动态 kw_token，固定 token 已失效），失败退 r.s。"""
    try:
        s = requests.Session()
        s.headers.update({"User-Agent": _UA, "Referer": "https://www.kuwo.cn/"})
        s.get("https://www.kuwo.cn/", timeout=8, verify=False)
        token = s.cookies.get("kw_token", "")
        if token:
            j = s.get("https://www.kuwo.cn/api/www/search/searchMusicBykeyWord",
                      params={"key": kw, "pn": 1, "rn": limit, "httpsStatus": 1},
                      headers={"csrf": token}, timeout=10, verify=False).json()
            lst = (j.get("data") or {}).get("list")
            if isinstance(lst, list) and lst:
                out = []
                for it in lst[:limit]:
                    rid = it.get("rid")
                    if rid is None:
                        continue
                    out.append({"id": "MUSIC_%s" % rid, "title": it.get("name") or "",
                                "artist": it.get("artist") or "",
                                "album": it.get("album") or "",
                                "duration": int(it.get("duration") or 0),
                                "vip": bool(it.get("isListenFee"))})
                if out:
                    return [x for x in out if x["title"]]
        slog("debug", "music", "酷我官网搜索未取到 token/列表，退 r.s 兜底")
    except Exception as e:
        slog("debug", "music", "酷我官网搜索异常，退 r.s 兜底：%s: %s" %
             (type(e).__name__, e))
    return _search_kuwo_rs(kw, limit)


def _search_kugou(kw, limit):
    """酷狗官方 mobilecdn 搜索。"""
    j = _j("http://mobilecdn.kugou.com/api/v3/search/song",
           params={"api_ver": 1, "area_code": 1, "correct": 1, "pagesize": limit,
                   "plat": 2, "tag": 1, "sver": 5, "showtype": 10, "page": 1,
                   "keyword": kw, "version": 8990},
           headers={"User-Agent": "IPhone-8990-searchSong",
                    "UNI-UserAgent": "iOS11.4-Phone8990-1009-0-WiFi"})
    out = []
    for it in (((j.get("data") or {}).get("info")) or [])[:limit]:
        h = it.get("hash") or ""
        if not h:
            continue
        out.append({"id": h, "title": it.get("songname") or it.get("filename") or "",
                    "artist": it.get("singername") or "",
                    "album": it.get("album_name") or "",
                    "duration": int(it.get("duration") or 0), "vip": False})
    return [x for x in out if x["title"]]


def _search_joox(kw, limit):
    """JOOX 第三方接口（含歌词，一并带出）。"""
    j = _j(JOOX_API, params={"msg": kw, "token": JOOX_TOKEN, "br": JOOX_BR})
    songs = []
    if j.get("code") == 200:
        songs = ((j.get("data") or {}).get("songs")) or []
    out = []
    for it in songs[:limit]:
        mid = it.get("songmid") or str(it.get("歌曲ID") or "")
        if not mid:
            continue
        out.append({"id": mid, "title": it.get("歌曲名称") or "",
                    "artist": it.get("歌手") or "", "album": it.get("专辑") or "",
                    "duration": 0, "vip": False,
                    "lyric": it.get("歌词内容") or ""})
    return [x for x in out if x["title"]]


_SEARCHERS = {"netease": _search_netease, "qq": _search_qq, "kuwo": _search_kuwo,
              "kugou": _search_kugou, "joox": _search_joox}


def music_search():
    src = (request.args.get("src") or "").strip().lower()
    kw = (request.args.get("kw") or "").strip()
    try:
        limit = min(50, max(1, int(request.args.get("limit") or 10)))
    except ValueError:
        limit = 10
    if src not in _SEARCHERS:
        slog("warn", "music", "search 未知源 src=%s kw=%s" % (src, kw))
        return _err("未知音乐源", 400)
    if not kw:
        return _err("缺少关键词", 400)
    t0 = time.time()
    try:
        lst = _SEARCHERS[src](kw, limit)
    except Exception as e:
        slog("warn", "music", "search src=%s kw=%s 失败(%dms)：%s: %s" %
             (src, kw, int((time.time() - t0) * 1000), type(e).__name__, e))
        return _err("%s 搜索失败：%s" % (src, e))
    slog("info", "music", "search src=%s kw=%s -> %d 条 (%dms)" %
         (src, kw, len(lst), int((time.time() - t0) * 1000)))
    return _api_json({"ok": True, "src": src, "list": lst})


# ============================== 播放链接 ==============================

def _url_netease(sid):
    # 本地 weapi 加密依赖重，且边缘 IP 易风控；Meting 两实例实测直接吐音频流。
    for base in METING:
        yield "%s?server=netease&type=url&id=%s" % (base, sid)


def _url_qq(mid):
    # 官方 vkey 两步匿名已拿不到 purl（2026-10 实测），直接 Meting tencent。
    for base in METING:
        yield "%s?server=tencent&type=url&id=%s" % (base, mid)


def _url_kuwo(musicrid):
    # antiserver convert_url 实测直出真实 CDN 链接（mp3；flac 匿名被拒）。
    try:
        r = _get("http://antiserver.kuwo.cn/anti.s",
                 params={"type": "convert_url", "rid": musicrid,
                         "format": "mp3", "response": "url"},
                 headers=_KW_HEADERS)
        u = r.text.strip()
        if re.match(r"^https?://", u):
            yield u
    except Exception as e:
        slog("debug", "music", "酷我 antiserver 取链异常：%s: %s" % (type(e).__name__, e))
    rid = musicrid.replace("MUSIC_", "")
    for base in METING:
        yield "%s?server=kuwo&type=url&id=%s" % (base, rid)


def _url_kugou(h):
    # 官方 trackercdn 已不返回 url（status:2），Meting kugou 兜底。
    for base in METING:
        yield "%s?server=kugou&type=url&id=%s" % (base, h)


_JOOX_ORDER = ("无损FLAC", "Hi-Res无损", "母带无损", "OGG 320", "MP3 320",
               "AAC 192", "OGG 192", "MP3 128", "AAC 96", "AAC 48")


def _url_joox(msg, n):
    """JOOX 详情接口按「关键词+序号」取播放链接（songmid 直查不给链接）。"""
    try:
        j = _j(JOOX_API, params={"msg": msg, "n": n, "token": JOOX_TOKEN, "br": JOOX_BR})
        d = (j.get("data") or {}) if j.get("code") == 200 else {}
        links = d.get("播放链接") or {}
        for q in _JOOX_ORDER:
            if links.get(q):
                yield links[q]
        for v in links.values():
            if v:
                yield v
    except Exception as e:
        slog("warn", "music", "JOOX 取链异常 msg=%s n=%s：%s: %s" %
             (msg, n, type(e).__name__, e))
        return


def _resolve_candidates(src, sid, kw, n):
    """生成候选真实 URL 列表。"""
    if src == "netease":
        return list(_url_netease(sid))
    if src == "qq":
        return list(_url_qq(sid))
    if src == "kuwo":
        return list(_url_kuwo(sid))
    if src == "kugou":
        return list(_url_kugou(sid))
    if src == "joox":
        return list(_url_joox(kw, n))
    return []


def _pick_url(src, sid, kw, n):
    for u in _resolve_candidates(src, sid, kw, n):
        if u:
            return u
    return None


def _stream(url):
    """dl=1：电脑代取音频并流式回给平板（断劫持/直连失败时仍能下载）。"""
    t0 = time.time()
    try:
        up = requests.get(url, timeout=(10, 90), headers={"User-Agent": _UA},
                          stream=True, allow_redirects=True, verify=False)
    except Exception as e:
        slog("error", "music", "dl 代取连接失败 %s | %s: %s" %
             (url, type(e).__name__, e))
        return _err("电脑代取失败：%s" % e)
    if up.status_code >= 400:
        up.close()
        slog("warn", "music", "dl 上游 HTTP%s（最终URL=%s）" % (up.status_code, up.url))
        return _err("远程服务器返回 HTTP %d" % up.status_code, 502)
    ctype = (up.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
    clen = up.headers.get("Content-Length") or "?"
    slog("info", "music", "dl 开始流式转发 ctype=%s len=%s（%dms，最终URL=%s）" %
         (ctype, clen, int((time.time() - t0) * 1000), up.url))
    total = [0]

    def gen():
        try:
            for chunk in up.iter_content(65536):
                if chunk:
                    total[0] += len(chunk)
                    yield chunk
            slog("info", "music", "dl 转发完成 %d 字节" % total[0])
        except Exception as e:
            slog("error", "music", "dl 流式传输中断（已发 %d 字节）：%s: %s" %
                 (total[0], type(e).__name__, e))
        finally:
            up.close()

    resp = Response(gen(), status=200)
    resp.headers["Content-Type"] = ctype
    if up.headers.get("Content-Length"):
        resp.headers["Content-Length"] = up.headers["Content-Length"]
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


def music_url():
    src = (request.args.get("src") or "").strip().lower()
    sid = (request.args.get("id") or "").strip()
    kw = (request.args.get("kw") or "").strip()          # joox 详情按关键词+序号
    try:
        n = max(1, int(request.args.get("n") or 1))
    except ValueError:
        n = 1
    dl = request.args.get("dl") == "1"
    if src not in SOURCES or not sid:
        slog("warn", "music", "url 参数错误 src=%s id=%s kw=%s" % (src, sid, kw))
        return _err("参数错误", 400)
    url = _pick_url(src, sid, kw, n)
    if not url:
        slog("warn", "music", "url 无可用链接 src=%s id=%s kw=%s n=%s dl=%s" %
             (src, sid, kw, n, int(dl)))
        return _err("没有可用的播放链接", 404)
    host = re.sub(r"^(https?://[^/]+).*$", r"\1", url)
    slog("info", "music", "url src=%s id=%s dl=%s -> %s" % (src, sid, int(dl), host))
    if dl:
        return _stream(url)
    return redirect(url, code=302)


# ============================== 歌词 ==============================

def _clean_lrc(t):
    """裁掉 lrc 正文之前的杂质（Meting 酷我接口偶发把 PHP Warning 混进响应）。"""
    t = (t or "").strip()
    m = re.search(r"\[(?:\d{2}:|ti:)", t)
    return t[m.start():] if m else ""


def _lyric_netease(sid):
    for base in METING:
        try:
            r = _get(base, params={"server": "netease", "type": "lrc", "id": sid}, timeout=8)
            t = _clean_lrc(r.text)
            if t:
                return t
        except Exception:
            continue
    return ""


def _lyric_qq(mid):
    r = _get("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
             params={"songmid": mid, "g_tk": 5381, "format": "json"},
             headers={"Referer": "https://y.qq.com/"})
    t = r.text
    # 兼容 JSONP 包装
    i, k = t.find("("), t.rfind(")")
    if 0 < i < k:
        t = t[i + 1:k]
    try:
        d = json.loads(t)
    except ValueError:
        return ""
    b64 = (d.get("lyric") or "").strip()
    if not b64:
        return ""
    try:
        return base64.b64decode(re.sub(r"\s", "", b64)).decode("utf-8", "replace")
    except Exception:
        return ""


def _lyric_meting(server, sid):
    for base in METING:
        try:
            r = _get(base, params={"server": server, "type": "lrc", "id": sid}, timeout=8)
            t = _clean_lrc(r.text)
            if t:
                return t
        except Exception:
            continue
    return ""


def music_lyric():
    src = (request.args.get("src") or "").strip().lower()
    sid = (request.args.get("id") or "").strip()
    if src not in SOURCES or not sid:
        slog("warn", "music", "lyric 参数错误 src=%s id=%s" % (src, sid))
        return _err("参数错误", 400)
    t0 = time.time()
    try:
        if src == "netease":
            lrc = _lyric_netease(sid)
        elif src == "qq":
            lrc = _lyric_qq(sid)
        elif src == "kuwo":
            lrc = _lyric_meting("kuwo", sid.replace("MUSIC_", ""))
        elif src == "kugou":
            lrc = _lyric_meting("kugou", sid)
        else:  # joox 歌词搜索时自带，前端无需再调
            lrc = ""
    except Exception as e:
        slog("warn", "music", "lyric src=%s id=%s 异常：%s: %s" %
             (src, sid, type(e).__name__, e))
        lrc = ""
    slog("info", "music", "lyric src=%s id=%s -> %d 字 (%dms)" %
         (src, sid, len(lrc), int((time.time() - t0) * 1000)))
    return _api_json({"ok": bool(lrc), "lyric": lrc})


def music_api(op):
    """api/music/* 路由分发。"""
    if op == "search":
        return music_search()
    if op == "url":
        return music_url()
    if op == "lyric":
        return music_lyric()
    slog("warn", "music", "未知端点 op=%s query=%s" %
         (op, request.query_string.decode("latin1", "ignore")[:200]))
    return _err("未知端点", 404)
