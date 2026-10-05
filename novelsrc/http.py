# -*- coding: utf-8 -*-
"""novelsrc.http —— 带重试与字符集嗅探的 HTTP 客户端。

对应 go-novel-dl 的 site/httpclient.go + htmlutil.go 的抓取部分：
统一 UA / Accept-Language、可重试错误判定、退避重试、GBK 等中文站字符集嗅探。
Loshop & Cpt
"""
import re
import time

import requests

DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36")

DEFAULT_HEADERS = {
    "User-Agent": DEFAULT_UA,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1",
}

_RETRYABLE = (
    "http 403", "http 408", "http 425", "http 429", "http 500", "http 502",
    "http 503", "http 504", "timeout", "timed out", "connection reset",
    "connection aborted", "connectionrefused", "refused", "unexpected eof",
    "eof occurred", "forcibly closed", "max retries", "read timed out",
    "chunkedencodingerror",
)

_META_CHARSET = re.compile(br"<meta[^>]+charset\s*=\s*[\"']?\s*([a-zA-Z0-9_\-]+)", re.I)
_HEADER_CHARSET = re.compile(r"charset\s*=\s*[\"']?\s*([a-zA-Z0-9_\-]+)", re.I)

DEFAULT_ATTEMPTS = 4


class HttpError(Exception):
    pass


def should_retry(err):
    msg = str(err).lower()
    for token in _RETRYABLE:
        if token in msg:
            return True
    return False


def detect_encoding(content, content_type=""):
    if content_type:
        m = _HEADER_CHARSET.search(content_type)
        if m:
            return m.group(1)
    head = content[:4096]
    m = _META_CHARSET.search(head)
    if m:
        return m.group(1).decode("ascii", "ignore")
    try:
        from charset_normalizer import from_bytes
        best = from_bytes(content).best()
        if best and best.encoding:
            return best.encoding
    except Exception:
        pass
    return "utf-8"


def decode_bytes(content, content_type=""):
    enc = detect_encoding(content, content_type)
    for candidate in (enc, "utf-8", "gb18030", "big5", "latin-1"):
        if not candidate:
            continue
        try:
            return content.decode(candidate)
        except (UnicodeDecodeError, LookupError):
            continue
    return content.decode("utf-8", "replace")


class HttpClient(object):
    def __init__(self, timeout=20.0, attempts=DEFAULT_ATTEMPTS):
        self.timeout = timeout
        self.attempts = attempts
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)

    def close(self):
        try:
            self.session.close()
        except Exception:
            pass

    # ------------------------------------------------------------------
    def request(self, method, url, headers=None, data=None, json_body=None,
                allow_404=False):
        last = None
        for attempt in range(self.attempts):
            try:
                resp = self.session.request(
                    method, url, headers=headers or None, data=data,
                    json=json_body, timeout=self.timeout, allow_redirects=True)
                if allow_404 and resp.status_code == 404:
                    return resp
                if resp.status_code < 200 or resp.status_code >= 300:
                    raise HttpError("http %d for %s" % (resp.status_code, url))
                return resp
            except Exception as exc:  # noqa: BLE001 - 统一转成可判定错误
                last = exc
                if not should_retry(exc) or attempt == self.attempts - 1:
                    break
                time.sleep(self._backoff(exc, attempt))
        raise last if isinstance(last, Exception) else HttpError(str(last))

    @staticmethod
    def _backoff(err, attempt):
        if "http 429" in str(err).lower():
            return float(2 ** (attempt + 1)) + 0.5
        return float(attempt + 1)

    # ------------------------------------------------------------------
    def get(self, url, headers=None, allow_404=False):
        resp = self.request("GET", url, headers=headers, allow_404=allow_404)
        return decode_bytes(resp.content, resp.headers.get("Content-Type", ""))

    def post_form(self, url, form, headers=None):
        resp = self.request("POST", url, headers=headers, data=form)
        return decode_bytes(resp.content, resp.headers.get("Content-Type", ""))

    def get_bytes(self, url, headers=None):
        resp = self.request("GET", url, headers=headers)
        return resp.content