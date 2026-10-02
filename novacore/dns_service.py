# -*- coding: utf-8 -*-
"""UDP 53 劫持服务（热点网卡精确绑定，压过 Windows ICS 通配占用）。"""
import socket
import threading
import time

from novacore.configutil import cfg
from novacore.netutil import hotspot_ip, answer_ip

# ----------------------------- DNS 服务 -----------------------------
class DNSQuery:
    def __init__(self, data):
        self.data = data
        self.domain = ""
        if (data[2] >> 3) & 15 == 0:
            ini, lon = 12, data[12]
            while lon != 0:
                self.domain += data[ini + 1:ini + lon + 1].decode("utf-8", errors="ignore") + "."
                ini += lon + 1
                lon = data[ini]

    def build_response(self, ip):
        pkt = self.data[:2] + b"\x85\x80"
        pkt += self.data[4:6] + self.data[4:6] + b"\x00\x00\x00\x00" + self.data[12:]
        pkt += b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x05\x00\x04"
        pkt += bytes(int(x) for x in ip.split("."))
        return pkt


class DNSThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.running = False
        self.sock = None

    def run(self):
        # 热点模式：必须精确绑定热点网卡 IP。
        # Windows 移动热点的 ICS 服务会占住 0.0.0.0:53，
        # 只有更具体的地址（192.168.137.1）才能优先截获设备发来的查询。
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        except OSError:
            pass
        bound_ip = None
        # 热点开启后网卡 IP（192.168.137.1）要几秒才就绪。
        # 先等它并精确绑定（唯一能稳定压过 ICS 通配绑定的方式）；
        # 12 秒内热点网卡没出现（/nohotspot 或纯局域网模式）再退回通配。
        for _ in range(6):
            hip = hotspot_ip()
            if hip:
                try:
                    sock.bind((hip, 53))
                    bound_ip = hip
                    break
                except OSError:
                    break
            time.sleep(2)
        if not bound_ip:
            try:
                sock.bind(("0.0.0.0", 53))
                bound_ip = "0.0.0.0"
            except OSError:
                pass
        if not bound_ip:
            print("[DNS] 绑定 53 端口失败（被占用或无可用网卡，需管理员权限）")
            sock.close()
            return
        self.sock = sock
        self.sock.settimeout(2)
        self.running = True
        print("[DNS] 已启动 %s:53，劫持域名 -> %s" % (bound_ip, answer_ip()))
        while self.running:
            try:
                data, addr = self.sock.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                q = DNSQuery(data)
                domain = q.domain.strip(".").lower()
                if domain in [d.lower() for d in cfg("hijack_domains", [])]:
                    self.sock.sendto(q.build_response(answer_ip()), addr)
                else:
                    for up in cfg("dns_upstreams", ["223.5.5.5"]):
                        try:
                            f = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                            f.settimeout(1.5)
                            f.sendto(data, (up, 53))
                            resp, _ = f.recvfrom(2048)
                            self.sock.sendto(resp, addr)
                            f.close()
                            break
                        except Exception:
                            continue
            except Exception as e:
                print("[DNS] 处理异常：%s" % e)

    def stop(self):
        self.running = False
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass