# -*- coding: utf-8 -*-
"""总控：DNS + HTTP 透明代理 + 本机管理界面 三线程编排。"""
import signal
import socket
import sys
import threading

import requests
from werkzeug.serving import make_server

from novacore.configutil import CONFIG, load_config, validate, cfg, mount_prefix
from novacore.dns_service import DNSThread
from novacore.proxy_app import create_proxy_app
from novacore.admin_app import create_admin_app
from novacore.proxy_engine import PROXY
from novacore.netutil import local_ip, answer_ip
from novacore.paths import set_slog_debug, slog_debug, slog
from novacore import tray as tray_mod

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
    set_slog_debug(bool(cfg("debug", False)))
    slog("info", "boot", "服务启动，调试模式=%s，python=%s" %
         (slog_debug() and "开" or "关", sys.version.split()[0]))
    errs = validate(CONFIG)
    if errs:
        slog("warn", "boot", "config.json 校验未通过：%s" % "; ".join(
            "%s=%s" % (k, v) for k, v in errs.items()))
        print("config.json 校验未通过，请在管理界面修正：")
        for k, v in errs.items():
            print("  - %s: %s" % (k, v))

    lan_mode = bool(cfg("lan_mode", False))
    # DNS 应答与运行模式解耦：局域网模式也默认开启（平板 Wi-Fi DNS 指向本机，
    # 只解析 hijack_domains 里的平台域名，其余域名照常转发）。
    dns = DNSThread() if cfg("dns_enable", True) else None
    if dns:
        dns.start()
        slog("info", "dns", "DNS 劫持线程已启动")

    proxy = ServerThread(create_proxy_app(), "0.0.0.0", int(cfg("http_port", 80)), "HTTP")
    proxy.start()
    # 内置正向代理：为网页代理提供出站通道（HTTP 转发 + HTTPS CONNECT 隧道）
    if cfg("webproxy_enable", True):
        PROXY.start("127.0.0.1", int(cfg("webproxy_port", 18087)))
    admin = ServerThread(create_admin_app(), "127.0.0.1", int(cfg("admin_port", 8899)), "ADMIN")
    admin.start()
    slog("info", "boot", "HTTP :%s / ADMIN 127.0.0.1:%s 已监听（lan_mode=%s）" %
         (int(cfg("http_port", 80)), int(cfg("admin_port", 8899)), lan_mode))

    print("=" * 60)
    print(" Tzy OS stealth 注入服务已启动")
    print(" 配置界面      : http://127.0.0.1:%d/" % int(cfg("admin_port", 8899)))
    print(" Tzy OS 挂载点 : %s://%s%s" % (cfg("serve_scheme", "http"), cfg("serve_host"), mount_prefix()))
    if lan_mode:
        if dns:
            print(" 运行模式      : 局域网模式（DNS 应答已开启）")
            print(" 平板 DNS      : 把平板 Wi-Fi 的 DNS 手动设为 %s" % answer_ip())
            print(" 平板接入      : DNS 指到本机后，照常打开“在线专栏”即可（无需输网址）")
        else:
            print(" 运行模式      : 局域网模式（DNS 应答已关闭）")
            print(" 平板接入      : 浏览器直接打开下方局域网地址")
        print(" 局域网访问    : http://%s%s" % (local_ip(), mount_prefix()))
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

    # 启动托盘：成功后隐藏控制台窗口，仅右键菜单「打开管理界面 / 查看日志 / 退出」。
    # 非 Windows 或初始化失败时保持控制台可见，便于排查。
    tray = tray_mod.start(int(cfg("admin_port", 8899)), stop_event.set)

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

    if tray:
        tray.stop()
    print("正在停止...")
    PROXY.stop()
    if dns:
        dns.stop()
    proxy.stop()
    admin.stop()


if __name__ == "__main__":
    main()