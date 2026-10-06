# -*- coding: utf-8 -*-
"""开发模式（DevLink）：平板 ↔ 电脑 双向命令通道。

协议（全部 HTTP POST + no-store，不占浏览器缓存，零新依赖）：
  平板 → POST <挂载点>sys/dev-hello    上线握手 {ver,ua,url,apps[,token]} → {ok,token,poll}
  平板 → POST <挂载点>sys/dev-poll     长轮询 {token,wait} → 服务端挂住至多 poll 秒
                                        有命令立即返回 → {ok,cmds:[{cid,cmd,args}]}
  平板 → POST <挂载点>sys/dev-result   回传结果 {token,cid,res} → 唤醒等待中的 exec
  电脑 → POST 127.0.0.1:admin/api/dev/exec    {token?,cmd,args?,timeout?} → 阻塞等结果
  电脑 → GET  127.0.0.1:admin/api/dev/status  → 设备/会话/最近结果一览

命令在平板 os.js 内以全权限执行（devExec 命令路由：eval 任意 JS、
vfs/localStorage/应用/锁屏/重载等，详见 os.js 开发模式段）。
延迟 = 内网一个 RTT（命令入队即唤醒挂起的长轮询），稳态无轮询风暴。
"""
import json
import threading
import time
import uuid

from flask import Response, request

from novacore.configutil import cfg
from novacore.paths import slog

POLL_SECONDS = 25.0      # 长轮询单次挂起上限（秒）
EXEC_TIMEOUT = 30.0      # exec 默认等待结果上限（秒）
SESSION_TTL = 900.0      # 会话闲置回收（15 分钟）
RESULT_KEEP = 300        # 最近完成结果保留条数
LOG_KEEP = 400           # 服务端事件日志上限


def _json(data, status=200):
    resp = Response(json.dumps(data, ensure_ascii=False), status=status)
    resp.headers["Content-Type"] = "application/json; charset=utf-8"
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


class _Session(object):
    def __init__(self, token):
        self.token = token
        self.info = {}            # ua / url / apps / addr
        self.created = time.time()
        self.last_seen = time.time()
        self.polls = 0            # 累计长轮询次数
        self.cmds_out = 0         # 累计下发命令数
        self.cmds_in = 0          # 累计收到结果数
        self.polling = 0          # 当前挂起的长轮询数（并发计数）
        self.seq = 0
        self.queue = []           # 待下发 [{cid,cmd,args,ts}]
        self.waiters = {}         # cid -> {event,cmd,result}
        self.recent = []          # 最近完成 [{cid,cmd,ok,ms,t,err}]
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)


class DevHub(object):
    """命令队列 + 会话表。一台平板一个会话（token），电脑端 exec 定向投递。"""

    def __init__(self):
        self.sessions = {}        # token -> _Session
        self.glock = threading.Lock()
        self.log = []             # 服务端事件 [{t,tag,msg}]
        self.started = time.time()

    # ---------------- 基础 ----------------
    def note(self, tag, msg):
        self.log.append({"t": time.strftime("%H:%M:%S"), "tag": tag,
                         "msg": str(msg)[:300]})
        if len(self.log) > LOG_KEEP:
            del self.log[:len(self.log) - LOG_KEEP]
        try:
            slog("info", "dev", msg)
        except Exception:
            pass

    def enabled(self):
        return bool(cfg("dev_mode", True))

    def gc(self):
        """回收闲置会话（调用方需持 glock）。"""
        now = time.time()
        dead = [t for t, s in self.sessions.items()
                if now - s.last_seen > SESSION_TTL]
        for t in dead:
            s = self.sessions.pop(t)
            self.note("session", "回收闲置会话 %s（%s）" % (
                t, (s.info or {}).get("ua", "")[:40]))

    def _get(self, token):
        with self.glock:
            return self.sessions.get(token)

    def _pick(self, token=""):
        """选目标设备：指定 token 直接用；否则取最近活跃（60s 内）的会话。"""
        with self.glock:
            self.gc()
            if token:
                s = self.sessions.get(token)
                return s.token if s else None
            best = None
            for s in self.sessions.values():
                if time.time() - s.last_seen <= 60 and (
                        best is None or s.last_seen > best.last_seen):
                    best = s
            return best.token if best else None

    # ---------------- 平板侧 ----------------
    def hello(self, body):
        if not self.enabled():
            return {"ok": False, "devoff": True}
        tok = str(body.get("token") or "")
        with self.glock:
            self.gc()
            sess = self.sessions.get(tok) if tok else None
            fresh = sess is None
            if fresh:
                tok = uuid.uuid4().hex[:12]
                sess = _Session(tok)
                self.sessions[tok] = sess
        sess.info = {
            "ua": str(body.get("ua") or "")[:200],
            "url": str(body.get("url") or "")[:300],
            "apps": body.get("apps") if isinstance(body.get("apps"), list) else [],
            "addr": (request.remote_addr if request else "") or "",
        }
        sess.last_seen = time.time()
        if fresh:
            self.note("hello", "设备接入 %s token=%s UA=%s" % (
                sess.info["addr"], tok, sess.info["ua"][:60]))
        return {"ok": True, "token": tok, "poll": POLL_SECONDS, "ver": 1}

    def poll(self, body):
        tok = str(body.get("token") or "")
        sess = self._get(tok)
        if sess is None:
            return {"ok": False, "invalid": True, "error": "会话失效，请重新握手"}
        if not self.enabled():
            return {"ok": False, "devoff": True}
        wait = POLL_SECONDS
        try:
            wait = min(POLL_SECONDS, max(0.0, float(body.get("wait", POLL_SECONDS))))
        except (TypeError, ValueError):
            pass
        deadline = time.time() + wait
        sess.polling += 1
        sess.polls += 1
        try:
            with sess.cond:
                while not sess.queue:
                    left = deadline - time.time()
                    if left <= 0 or not self.enabled():
                        break
                    sess.cond.wait(left)
                cmds = sess.queue[:]
                del sess.queue[:]
        finally:
            sess.polling -= 1
            sess.last_seen = time.time()
        if cmds:
            sess.cmds_out += len(cmds)
            self.note("poll", "下发 %d 条：%s" % (
                len(cmds), ", ".join(str(c.get("cmd")) for c in cmds)[:160]))
        return {"ok": True, "cmds": cmds}

    def result(self, body):
        tok = str(body.get("token") or "")
        sess = self._get(tok)
        if sess is None:
            return {"ok": False, "invalid": True}
        cid = str(body.get("cid") or "")
        res = body.get("res")
        if not isinstance(res, dict):
            res = {"ok": False, "error": "结果格式错误"}
        sess.last_seen = time.time()
        sess.cmds_in += 1
        with sess.cond:
            w = sess.waiters.pop(cid, None)
            sess.recent.append({
                "cid": cid,
                "cmd": (w or {}).get("cmd", "?"),
                "ok": bool(res.get("ok")),
                "ms": int(res.get("ms") or 0),
                "t": time.strftime("%H:%M:%S"),
                "err": str(res.get("error") or "")[:200],
            })
            if len(sess.recent) > RESULT_KEEP:
                del sess.recent[:len(sess.recent) - RESULT_KEEP]
            if w is not None:
                w["result"] = res
                w["event"].set()
            sess.cond.notify_all()
        return {"ok": True}

    # ---------------- 电脑侧 ----------------
    def exec(self, cmd, args=None, token="", timeout=None):
        if not self.enabled():
            return {"ok": False, "error": "开发模式已关闭（config.json dev_mode=false）"}
        tok = self._pick(token)
        if tok is None:
            return {"ok": False, "error": "没有在线的平板设备（平板先打开 Tzy OS）"}
        sess = self.sessions[tok]
        try:
            timeout = EXEC_TIMEOUT if timeout is None else min(300.0, max(0.5, float(timeout)))
        except (TypeError, ValueError):
            timeout = EXEC_TIMEOUT
        with sess.cond:
            sess.seq += 1
            cid = "%d-%d" % (int(time.time() * 1000) % 100000000, sess.seq)
            ev = threading.Event()
            waiter = {"event": ev, "cmd": cmd, "ts0": time.time()}
            sess.waiters[cid] = waiter
            sess.queue.append({"cid": cid, "cmd": str(cmd),
                               "args": args if args is not None else {}})
            sess.cond.notify_all()
        got = ev.wait(timeout)
        with sess.cond:
            sess.waiters.pop(cid, None)      # 超时清理（结果已到时 result() 已摘除）
        if not got or "result" not in waiter:
            self.note("exec", "超时未回 %s cmd=%s（%.0fs）" % (tok, cmd, timeout))
            return {"ok": False, "timeout": True,
                    "error": "等待平板执行结果超时（%.0fs）" % timeout}
        return waiter["result"]

    def status(self):
        with self.glock:
            self.gc()
            now = time.time()
            devs = []
            for s in sorted(self.sessions.values(), key=lambda x: -x.last_seen):
                devs.append({
                    "token": s.token,
                    "online": (now - s.last_seen) < 40,
                    "last_seen": int(now - s.last_seen),
                    "polling": s.polling > 0,
                    "queued": len(s.queue),
                    "polls": s.polls,
                    "cmds_out": s.cmds_out,
                    "cmds_in": s.cmds_in,
                    "info": s.info,
                    "recent": list(s.recent[-20:]),
                })
            return {"ok": True, "enabled": self.enabled(),
                    "uptime": int(now - self.started),
                    "devices": devs, "log": self.log[-40:]}


HUB = DevHub()


# ---------------- 挂载点端点（proxy_app 调用，request 上下文内） ----------------
def handle_sys(kind):
    body = request.get_json(force=True, silent=True) or {}
    if kind == "hello":
        return _json(HUB.hello(body))
    if kind == "poll":
        return _json(HUB.poll(body))
    if kind == "result":
        return _json(HUB.result(body))
    return _json({"ok": False, "error": "未知端点 dev/%s" % kind}, 404)


# ---------------- 管理端口端点（admin_app 调用） ----------------
def admin_status():
    return _json(HUB.status())


def admin_exec():
    body = request.get_json(force=True, silent=True) or {}
    cmd = str(body.get("cmd") or "").strip()
    if not cmd:
        return _json({"ok": False, "error": "缺少 cmd"}, 400)
    timeout = body.get("timeout")
    try:
        timeout = None if timeout is None else float(timeout)
    except (TypeError, ValueError):
        timeout = None
    res = HUB.exec(cmd, body.get("args"), str(body.get("token") or ""), timeout)
    return _json(res)
