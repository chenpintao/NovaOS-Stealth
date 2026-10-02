# -*- coding: utf-8 -*-
"""本机网络探测、上游 DNS 解析（防回环）、外网可达性。"""
import random
import re
import socket
import struct
import subprocess
import threading
import time

from novacore.configutil import cfg

_dns_cache = {}          # host -> (ips:list[str], expire_ts)
_dns_cache_lock = threading.Lock()

# ----------------------------- 本机网络 -----------------------------
def local_ip():
    ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 53))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    return ip


HOTSPOT_PREFIXES = ("192.168.137.", "192.168.43.", "172.20.10.")
_hotspot_cache = {"ip": None, "ts": 0}


def hotspot_ip():
    """检测 Windows 移动热点虚拟网卡（192.168.137.x / 43.x / 172.20.10.x）。
    设备连电脑热点后，该地址就是它们的网关 + DNS，必须用它应答劫持域名。"""
    now = time.time()
    if now - _hotspot_cache["ts"] < 1:
        return _hotspot_cache["ip"]
    ip = None
    try:
        out = subprocess.run(["ipconfig"], capture_output=True, timeout=5,
                             text=True, errors="ignore").stdout
        for m in re.findall(r"(?:IPv4|IPv4 地址)[^\d:]*:\s*(\d+\.\d+\.\d+\.\d+)", out):
            if m.startswith(HOTSPOT_PREFIXES):
                ip = m
                break
    except Exception:
        pass
    _hotspot_cache.update(ip=ip, ts=now)
    return ip


def answer_ip():
    v = str(cfg("answer_ip", "auto"))
    if v and v != "auto":
        return v
    # 热点模式优先：哪怕电脑默认出口走 WLAN，也要应答热点网关
    hip = hotspot_ip()
    if hip:
        return hip
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("223.5.5.5", 53))
        ip = s.getsockname()[0]
        s.close()
        if ip.startswith(HOTSPOT_PREFIXES):
            return ip
    except Exception:
        pass
    return local_ip()


# ----------------------------- 外部 DNS 解析（防回环） -----------------------------
def _build_dns_query(domain):
    tid = struct.pack("!H", random.randint(0, 65535))
    header = tid + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00"
    q = b"".join(bytes([len(p)]) + p.encode() for p in domain.strip(".").split(".")) + b"\x00"
    return header + q + b"\x00\x01\x00\x01"


def _parse_a_answers(data):
    try:
        # 头部 12 字节
        ancount = struct.unpack("!H", data[6:8])[0]
        pos = 12
        # 跳过 Question
        while data[pos] != 0:
            pos += data[pos] + 1
        pos += 5  # 零字节 + QTYPE(2) + QCLASS(2)
        ips = []
        for _ in range(ancount):
            if data[pos] & 0xC0 == 0xC0:
                pos += 2
            else:
                while data[pos] != 0:
                    pos += data[pos] + 1
                pos += 1
            rtype, _rclass, _ttl, rdlen = struct.unpack("!HHIH", data[pos:pos + 10])
            pos += 10
            rdata = data[pos:pos + rdlen]
            pos += rdlen
            if rtype == 1 and rdlen == 4:
                ips.append(".".join(str(b) for b in rdata))
        return ips
    except Exception:
        return []


def resolve_external(host):
    """直接向上游 DNS 发 A 查询，绕开本机 DNS 配置，防止代理请求回到自己。"""
    host = host.lower()
    with _dns_cache_lock:
        hit = _dns_cache.get(host)
        if hit and hit[1] > time.time():
            return list(hit[0])
    last_err = None
    for up in cfg("dns_upstreams", ["223.5.5.5"]):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(2.5)
            s.sendto(_build_dns_query(host), (up, 53))
            data, _ = s.recvfrom(4096)
            s.close()
            ips = _parse_a_answers(data)
            if ips:
                with _dns_cache_lock:
                    _dns_cache[host] = (ips, time.time() + 300)
                return ips
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError("外部 DNS 解析 %s 失败：%s" % (host, last_err))