# -*- coding: utf-8 -*-
"""总控：DNS + HTTP 透明代理 + 本机管理界面 三线程编排。"""
import signal
import socket
import threading

import requests
from werkzeug.serving import make_server

from novacore.configutil import CONFIG, load_config, validate, cfg, mount_prefix
from novacore.dns_service import DNSThread
from novacore.proxy_app import create_proxy_app
from novacore.admin_app import create_admin_app
from novacore.cdp_browser import CDP
from novacore.netutil import local_ip, answer_ip

class ServerThread(threading.Thread):
    def __init__(self, app, host, port, name):
        super().__init__(daemon=True)
        # HTTPServer.server_bind 会调用 socket.getfqdn() 做反向 DNS 解析，
        # 热点/DNS 切换期间可能长时间阻塞导致端口起不来，这里直接短路。
        socket.getfqdn = lambda name="": name or "localhost"
        self.server = make_server(host, port, app, threaded=True)
        self.label = name

    def run(self):
        print("[%s] 监听 %s" % (self.label, self.server.server_address))
        self.server.serve_forever()

    def stop(self):
        self.server.shutdown()


def main():
    requests.packages.urllib3.disable_warnings()
    load_config()
    errs = validate(CONFIG)
    if errs:
        print("config.json 校验未通过，请在管理界面修正：")
        for k, v in errs.items():
            print("  - %s: %s" % (k, v))

    lan_mode = bool(cfg("lan_mode", False))
    dns = DNSThread() if (cfg("dns_enable", True) and not lan_mode) else None
    if dns:
        dns.start()

    proxy = ServerThread(create_proxy_app(), "0.0.0.0", int(cfg("http_port", 80)), "HTTP")
    proxy.start()
    admin = ServerThread(create_admin_app(), "127.0.0.1", int(cfg("admin_port", 8899)), "ADMIN")
    admin.start()

    print("=" * 60)
    print(" Tzy OS stealth 注入服务已启动")
    print(" 配置界面      : http://127.0.0.1:%d/" % int(cfg("admin_port", 8899)))
    print(" Tzy OS 挂载点 : %s://%s%s" % (cfg("serve_scheme", "http"), cfg("serve_host"), mount_prefix()))
    if lan_mode:
        print(" 运行模式      : 局域网代理（无热点 / 无 DNS 劫持）")
        print(" 局域网访问    : http://%s%s" % (local_ip(), mount_prefix()))
        print(" 平板接入      : 与电脑同一局域网，浏览器直接打开上方地址")
    else:
        print(" 运行模式      : 热点 DNS 劫持")
        if str(cfg("answer_ip", "auto")) == "auto":
            print(" 劫持应答 IP   : 自动（热点模式优先应答热点网关，如 192.168.137.1）")
        else:
            print(" 劫持应答 IP   : %s" % answer_ip())
        print(" 平板接入      : DNS 指向本机后，正常打开“在线专栏”")
    sk = str(cfg("trigger_search_keyword", "")) if cfg("trigger_search_enable", True) else ""
    print(" 隐蔽唤起      : 搜索框输入 %s / 角落连点 / Ctrl+Shift+Y / 网址暗参 _o=1" % (sk or "(未启用)"))
    print(" Ctrl+C 退出")
    print("=" * 60)

    stop_event = threading.Event()
    try:
        signal.signal(signal.SIGINT, lambda *_: stop_event.set())
        signal.signal(signal.SIGTERM, lambda *_: stop_event.set())
    except Exception:
        pass
    try:
        while not stop_event.wait(1):
            pass
    except KeyboardInterrupt:
        pass

    print("正在停止...")
    CDP.stop()
    if dns:
        dns.stop()
    proxy.stop()
    admin.stop()


if __name__ == "__main__":
    main()