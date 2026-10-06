/* ============================================================
 * Tzy OS · 核心 os.js
 * 锁屏 → 桌面图标网格 + Dock → WinBox 窗口 → 应用注册 → 存储
 *
 * 约束：Chrome 99（华为平板）、HTTP 非安全源；
 *      仅用 ES6（不使用 2022+ 语法）；存储只用 localStorage 明文。
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  /* ---------------- 存储封装（localStorage 明文） ---------------- */
  var Store = {
    get: function (key, def) {
      try {
        var v = localStorage.getItem(key);
        return v === null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set: function (key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { }
    },
    remove: function (key) {
      try { localStorage.removeItem(key); } catch (e) { }
    }
  };

  /* ---------------- 极简事件总线（应用间联动，如 文件→编辑器） ---------------- */
  var listeners = {};
  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
  }
  function emit(evt, data) {
    var arr = listeners[evt] || [];
    for (var i = 0; i < arr.length; i++) {
      try { arr[i](data); } catch (e) { }
    }
  }

  /* ---------------- 轻提示 ---------------- */
  var toastTimer = 0;
  function toast(msg, ms) {
    var el = document.getElementById("nv-toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("nv-hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add("nv-hidden"); }, ms || 2200);
  }

  /* ---------------- DOM 辅助 ---------------- */
  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  /* ---------------- 模态对话框（替代原生 alert/confirm/prompt） ----------------
   * 原生弹框在华为平板上样式突兀且会阻塞渲染；统一为纸风对话框，Promise 回传结果。
   * 挂在 body 最外层（z-index 高于 WinBox 窗口）。 */
  function dlgOpen(o) {
    return new Promise(function (resolve) {
      var mask = h("div", "nv-mask nv-modal-top");
      var dlg = h("div", "nv-dialog");
      if (o.title) dlg.appendChild(h("h3", "", o.title));
      if (o.msg) {
        var lines = String(o.msg).split("\n");
        var box = h("div", "nv-dialog-msg");
        lines.forEach(function (ln, i) {
          if (i) box.appendChild(document.createElement("br"));
          box.appendChild(document.createTextNode(ln));
        });
        dlg.appendChild(box);
      }
      var inp = null;
      if (o.kind === "prompt") {
        inp = document.createElement("input");
        inp.className = "nv-input nv-dialog-input";
        inp.value = o.value || "";
        if (o.placeholder) inp.placeholder = o.placeholder;
        dlg.appendChild(inp);
      }
      var actions = h("div", "nv-dialog-actions");
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(v);
      }
      if (o.kind !== "alert") {
        var bCancel = h("button", "nv-btn ghost", o.cancelText || "取消");
        bCancel.addEventListener("click", function () { finish(o.kind === "confirm" ? false : null); });
        actions.appendChild(bCancel);
      }
      var bOk = h("button", "nv-btn primary", o.okText || "确定");
      bOk.addEventListener("click", function () {
        finish(o.kind === "alert" ? true : (o.kind === "confirm" ? true : inp.value));
      });
      actions.appendChild(bOk);
      dlg.appendChild(actions);
      mask.appendChild(dlg);
      mask.addEventListener("click", function (e) {
        if (e.target === mask) finish(o.kind === "confirm" ? false : null);
      });
      document.body.appendChild(mask);
      if (inp) {
        setTimeout(function () {
          try { inp.focus(); inp.select(); } catch (e) { }
        }, 60);
        inp.addEventListener("keydown", function (e) {
          if (e.keyCode === 13 || e.key === "Enter") { e.preventDefault(); finish(inp.value); }
          else if (e.keyCode === 27 || e.key === "Escape") { e.preventDefault(); finish(null); }
        });
      } else {
        mask.addEventListener("keydown", function (e) {
          if (e.keyCode === 27 || e.key === "Escape") {
            finish(o.kind === "confirm" ? false : null);
          }
        });
      }
    });
  }
  var dlg = {
    alert: function (msg, title) { return dlgOpen({ kind: "alert", msg: msg, title: title }); },
    confirm: function (msg, title) { return dlgOpen({ kind: "confirm", msg: msg, title: title }); },
    prompt: function (msg, value, title) {
      return dlgOpen({ kind: "prompt", msg: msg, value: value, title: title });
    }
  };

  /* ---------------- 界面设置（壁纸等，明文 localStorage） ---------------- */
  var UI_KEY = "nova2.ui";
  var WALLPAPERS = [
    { id: 0, name: "墨" },
    { id: 1, name: "青黛" },
    { id: 2, name: "绛紫" },
    { id: 3, name: "玄铁" }
  ];
  function uiGet() { return Store.get(UI_KEY, { wp: 0 }) || { wp: 0 }; }
  function applyWallpaper(idx) {
    var lock = document.getElementById("nv-lock");
    var desk = document.getElementById("nv-desktop");
    WALLPAPERS.forEach(function (w) {
      if (lock) lock.classList.remove("nv-wp-" + w.id);
      if (desk) desk.classList.remove("nv-wp-" + w.id);
    });
    if (lock) lock.classList.add("nv-wp-" + idx);
    if (desk) desk.classList.add("nv-wp-" + idx);
  }
  var ui = {
    wallpapers: function () { return WALLPAPERS.slice(); },
    wallpaper: function () {
      var n = uiGet().wp;
      return WALLPAPERS[n] ? n : 0;
    },
    setWallpaper: function (idx) {
      if (!WALLPAPERS[idx]) return;
      var s = uiGet(); s.wp = idx; Store.set(UI_KEY, s);
      applyWallpaper(idx);
    }
  };

  /* ---------------- 网络层：同源 → 直连热点 IP，自动探测与故障转移 ----------------
   * 劫持在：同源相对路径 api/... 即达 server.py。
   * 断劫持：域名失效，但平板仍连着电脑热点 → 直连 http://192.168.137.1 挂载点
   *         （跨域，服务端已开 CORS + 预检），FTP/SMB/外网代取全部继续可用。
   * 完全离线（无热点/无服务）：探测失败返回 offline，界面降级到离线空间。 */
  var MOUNT_PATH = (function () {
    // 本页形如 /__nova__/nova.html，取最后一个斜杠前（含斜杠）作为挂载前缀
    var p = location.pathname;
    var i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(0, i + 1) : "/";
  })();
  var BASE_KEY = "nova2.apiBase";
  var NET = { base: "", info: null, online: false, probing: null, waiters: [] };

  function lanCandidates() {
    var cfg = window.__NOVA_LAN__ || {};
    var ips = [], seen = {};
    function add(ip) {
      ip = String(ip || "").trim();
      if (ip && !seen[ip]) { seen[ip] = 1; ips.push(ip); }
    }
    add(cfg.hotspot);          // 热点网关（最优先）
    add("192.168.137.1");      // Windows 移动热点固定网关
    add(cfg.answer);
    add(cfg.local);
    var mount = cfg.mount || MOUNT_PATH;
    return ips.map(function (ip) { return "http://" + ip + mount; });
  }

  function pingAt(base) {
    return new Promise(function (resolve) {
      var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { } } }, 2500);
      fetch(base + "api/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) { return r.json(); }).then(function (j) {
        clearTimeout(timer);
        resolve(j && j.ok ? { base: base, info: j } : null);
      }).catch(function (e) {
        clearTimeout(timer);
        try { nvLog("debug", "net", "ping 失败 " + (base || "(同源)") + " | " + (e && e.message)); }
        catch (_) { }
        resolve(null);
      });
    });
  }

  function netProbe(force) {
    if (NET.base && !force) return Promise.resolve({ base: NET.base, info: NET.info });
    if (NET.probing) return NET.probing;
    NET.probing = (function () {
      // 候选顺序：同源（劫持在）→ 上次成功的直连 → 注入 IP → 固定热点网段
      var list = [""];
      var saved = Store.get(BASE_KEY, "");
      if (saved && list.indexOf(saved) < 0) list.push(saved);
      lanCandidates().forEach(function (b) { if (list.indexOf(b) < 0) list.push(b); });
      try { nvLog("debug", "net", "开始探测电脑服务，候选 " + list.length + " 个：" +
        list.map(function (b) { return b || "(同源)"; }).join(", ")); } catch (_) { }

      function next(i) {
        if (i >= list.length) return Promise.resolve(null);
        return pingAt(list[i]).then(function (res) { return res || next(i + 1); });
      }
      return next(0).then(function (res) {
        NET.online = !!res;
        if (res) {
          NET.base = res.base;
          NET.info = res.info;
          Store.set(BASE_KEY, res.base);
          try { nvLog("info", "net", "电脑服务就绪：" + (res.base || "(同源)") +
            " wan=" + (res.info.wan ? 1 : 0) + " answer=" + res.info.answer); } catch (_) { }
        } else {
          try { nvLog("warn", "net", "全部候选不可达，进入离线模式"); } catch (_) { }
        }
        NET.probing = null;
        var ws = NET.waiters; NET.waiters = [];
        ws.forEach(function (fn) { fn(res); });
        netChanged();
        return res;
      });
    })();
    return NET.probing;
  }

  var OFFLINE = { ok: false, offline: true, error: "电脑服务不可用（离线模式）" };

  // 探测结果变化时：刷新桌面网络灯，并通知应用（设置/文件管理可即时更新状态）
  function netChanged() {
    var dot = document.getElementById("nv-sb-net");
    if (dot) {
      var on = NET.online;
      dot.className = "nv-sb-dot " + (on ? "online" : "offline");
      var info = NET.info || {};
      var where = on ? (NET.base === "" ? "同源（劫持通道）" : "热点直连 " + NET.base.replace(/^https?:\/\//, "").replace(/\/.*$/, "")) : "离线";
      var wan = typeof info.wan === "boolean" ? (" · 电脑外网：" + (info.wan ? "通畅" : "不通")) : "";
      dot.title = "电脑服务：" + where + wan;
      dot.textContent = "";
    }
    try { emit("net-change", { base: NET.base, info: NET.info, offline: !NET.base }); } catch (e) { }
  }

  function rawCall(base, rel, body) {
    return fetch(base + rel, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      // 业务成功/失败都返回 JSON；拿不到 JSON 说明打到的不是本机服务（劫持已断、
      // 域名指向了真实服务器/网关拦截页），触发换地址重探。
      return r.json().catch(function () { return null; });
    }).catch(function () { return null; });
  }

  function netCall(rel, body, tries) {
    var base = NET.base || "";
    return rawCall(base, rel, body).then(function (j) {
      if (j) return j;
      if ((tries || 0) < 1) {
        return netProbe(true).then(function (res) {
          if (!res) return OFFLINE;
          return netCall(rel, body, (tries || 0) + 1);
        });
      }
      return OFFLINE;
    });
  }

  // 走电脑网络代取外网（GET，返回原始 Blob）；断劫持直连 IP 时同样可用
  function netGetWeb(url) {
    function attempt(base, tries) {
      return fetch(base + "api/web?u=" + encodeURIComponent(url)).then(function (r) {
        if (r.status === 200) {
          return Promise.all([r.blob(), r.headers.get("X-File-Name")]).then(function (a) {
            return { ok: true, blob: a[0], name: a[1] };
          });
        }
        return r.json().catch(function () { return null; }).then(function (j) {
          if (j && j.error) return j;
          return null;
        });
      }).catch(function () { return null; }).then(function (res) {
        if (res) return res;
        if (tries < 1) {
          return netProbe(true).then(function (p) {
            if (!p) return { ok: false, offline: true, error: "电脑服务不可用（离线模式）" };
            return attempt(p.base, tries + 1);
          });
        }
        return { ok: false, offline: true, error: "电脑服务不可用（离线模式）" };
      });
    }
    var base = NET.base || "";
    if (NET.base) return attempt(base, 0);
    return netProbe(false).then(function (p) {
      if (!p) return { ok: false, offline: true, error: "电脑服务不可用（离线模式）" };
      return attempt(p.base, 0);
    });
  }

  /* ---------------- 应用动态基址助手 ----------------
   * 应用若用裸相对路径（如 "novel/api/meta"），其基准是 nova.html 的挂载点；
   * 一旦域名劫持失效、OS 改用直连 IP，裸相对路径就会打到真实服务器（404/405）。
   * 以下助手统一把相对挂载路径拼到「当前电脑基址」上，并在命中非本机服务时
   * 自动重探新地址后重试 —— 换局域网/换设备后即可自动跟随电脑新 IP。 */
  function normRel(rel) {
    return String(rel == null ? "" : rel).replace(/^\/+/, "");
  }
  // 同步拼接：拿当前已知基址（探测未完成时可能为同源相对路径）
  function netUrl(rel) {
    return (NET.base || "") + normRel(rel);
  }
  // 异步拼接：确保探测完成后再给地址（用于 iframe.src 等必须在挂载后写死的场景）
  function netResolve(rel) {
    var r = normRel(rel);
    if (NET.base) return Promise.resolve(NET.base + r);
    return netProbe(false).then(function (p) {
      return (p ? p.base : (NET.base || "")) + r;
    });
  }
  // 带自动重探重试的动态基址 fetch：返回原生 Response，可直接 .json()/.text()/.blob()
  function netFetch(rel, init) {
    var r = normRel(rel);
    function attempt(base, tries) {
      return fetch(base + r, init).then(function (resp) {
        if (resp && resp.ok) return resp;
        // 判定「打到的不是本机服务」：错误响应不是 JSON（本机端点一律回 JSON，
        // 劫持失效时会落到真实服务器的 HTML/网关页）。是 JSON 就当成正常业务错误返回。
        var ct = (resp && resp.headers && resp.headers.get("content-type")) || "";
        var foreign = ct.toLowerCase().indexOf("json") < 0;
        if (foreign && tries < 1) {
          return netProbe(true).then(function (p) {
            if (!p || p.base === base) return resp;
            return attempt(p.base, tries + 1);
          });
        }
        return resp;
      }).catch(function (err) {
        if (tries < 1) {
          return netProbe(true).then(function (p) {
            if (!p) throw err;
            return attempt(p.base, tries + 1);
          });
        }
        throw err;
      });
    }
    if (NET.base) return attempt(NET.base, 0);
    return netProbe(false).then(function (p) { return attempt(p ? p.base : "", 0); });
  }

  var api = {
    fs: function (op, body) { return netCall("api/fs/" + op, body || {}); },
    ftp: function (body) { return netCall("api/ftp", body); },
    smb: function (body) { return netCall("api/smb", body); },
    ping: function () { return netCall("api/ping", {}); },
    // 系统维护（走挂载点同源端点，平板与电脑均可调用）
    sysUpdate: function () { return netCall("sys/update", {}); },
    sysLog: function (logs) { return netCall("sys/log", { logs: logs }); },
    sysBackupUrl: function () {
      if (NET.base) return Promise.resolve(NET.base + "sys/backup");
      return netProbe(false).then(function (p) { return p ? p.base + "sys/backup" : null; });
    }
  };

  /* ---------------- 开发模式（DevLink）：电脑 ↔ 平板 双向命令通道 ----------------
   * 电脑（127.0.0.1:8899 /api/dev/exec）把命令投进服务端队列；平板长轮询即刻
   * 取回 → devExec 以全权限执行（eval 直接跑在本闭包作用域，可达 vfs/Store/
   * NET/窗口管理等一切内部能力 + window.OS）→ POST sys/dev-result 回传，
   * 电脑端阻塞等待的 exec 随即拿到结果。全程 POST + no-store，不占浏览器缓存；
   * 稳态仅一个挂起长轮询，命令延迟 ≈ 内网一个 RTT。服务端见 novacore/devmode.py。
   * 命令集（cmd / args）：
   *   ping                       连通性自检
   *   info                       系统一览（网络/应用清单/运行中/存储配额/统计）
   *   eval    {code}             执行任意 JS，返回值序列化回传（支持 Promise）
   *   storage {op,key,value}     localStorage 原始读写（get/set/del/keys/clear）
   *   vfs     {op,path,to,...}   离线空间直通（list/get/put/del/mkdir/rename/usage/clear）
   *   app     {op,id,arg}        应用控制（list/open/close）
   *   toast   {msg,ms}           平板弹轻提示
   *   lock                       立即锁屏
   *   reload                     重载 OS 页面（先回传结果再重载）
   *   dbg     {on}               开/关调试日志回传
   *   emit    {evt,data}         广播系统事件 */
  var DEV_KEY = "nova2.dev.token";
  var dev = {
    token: Store.get(DEV_KEY, ""),   // 会话令牌（服务端派发，失效自动重握手）
    on: false,        // 已与电脑 devmode 服务握手并轮询中
    off: false,       // 电脑端关闭了开发模式（config dev_mode=false）
    wait: 25,         // 长轮询单次挂起秒数（hello 返回）
    looping: false,   // 轮询链已启动（防重复）
    cmds: 0, ok: 0, fail: 0,         // 累计执行统计
    lastAt: 0,        // 最近一次收到命令的时间戳
    backoff: 0        // 连续失败退避（ms）
  };

  function devState() {
    return { on: dev.on, off: dev.off, token: dev.token, wait: dev.wait,
             cmds: dev.cmds, ok: dev.ok, fail: dev.fail, lastAt: dev.lastAt };
  }
  function devChanged() { try { emit("dev-change", devState()); } catch (e) { } }

  // 任意 JS 值 → 可 JSON 回传的近似值（函数/错误/DOM/Blob/循环引用均有兜底）
  function devJson(v) {
    var seen = [];
    function repl(k, val) {
      var t = typeof val;
      if (t === "function") return "[fn " + (val.name || "anonymous") + "]";
      if (t === "bigint") return String(val);
      if (val instanceof Error) return val.name + ": " + val.message;
      if (val && t === "object") {
        if (val instanceof Date) return val.toISOString();
        if (typeof Blob !== "undefined" && val instanceof Blob) return "[Blob " + val.size + "B]";
        if (val === window) return "[window]";
        if (val === document) return "[document]";
        if (typeof Element !== "undefined" && val instanceof Element)
          return "<" + val.tagName.toLowerCase() + (val.id ? "#" + val.id : "") + ">";
        if (seen.indexOf(val) >= 0) return "[Circular]";
        seen.push(val);
      }
      return val;
    }
    try { return JSON.parse(JSON.stringify(v, repl)); }
    catch (e) { return String(v); }
  }

  /* 全权限命令路由：电脑下发的每条命令在此执行。
   * eval 分支为「直接 eval」——代码串可读写本闭包全部内部变量，即完全控制平板 OS。 */
  function devExec(cmd, args) {
    args = args || {};
    var op = String(args.op || "");
    switch (String(cmd || "")) {
      case "ping":
        return { pong: true, t: Date.now(), ver: 1 };

      case "info":
        return Promise.resolve(
          navigator.storage && navigator.storage.estimate
            ? navigator.storage.estimate() : { note: "不支持 estimate" })
          .then(function (st) {
            return {
              ua: navigator.userAgent, url: location.href,
              screen: window.innerWidth + "x" + window.innerHeight + " @" + (window.devicePixelRatio || 1) + "x",
              net: { base: NET.base, online: NET.online, info: NET.info },
              apps: appList(), running: runningList(),
              dev: devState(), storage: st
            };
          });

      case "eval": {
        // 任意 JS：用 Function 包裹，可写语句 + return（直接 eval 只认表达式）。
        // 作用域为全局，可经 window.OS / window 拿到全部能力。
        var code = args.code == null ? "" : String(args.code);
        if (!code) return { error: "缺少 code" };
        var fn;
        try {
          fn = new Function(code);
        } catch (e) {
          return { error: "语法错误：" + (e && e.message ? e.message : e), code: code.slice(0, 400) };
        }
        var rv;
        try {
          rv = fn.call(window);
        } catch (e) {
          return { error: String(e && e.stack ? e.stack : e), code: code.slice(0, 400) };
        }
        // 支持返回 Promise（异步命令）
        if (rv && typeof rv.then === "function") {
          return rv.then(function (v) { return devJson(v); },
            function (e) { return { error: String(e && e.stack ? e.stack : e) }; });
        }
        return devJson(rv);
      }

      case "storage":
        if (op === "get") return { value: localStorage.getItem(String(args.key || "")) };
        if (op === "set") {
          localStorage.setItem(String(args.key || ""),
            typeof args.value === "string" ? args.value : JSON.stringify(args.value));
          return { ok: true };
        }
        if (op === "del") { localStorage.removeItem(String(args.key || "")); return { ok: true }; }
        if (op === "keys") {
          var ks = [];
          for (var ki = 0; ki < localStorage.length; ki++) ks.push(localStorage.key(ki));
          return { keys: ks };
        }
        if (op === "clear") { localStorage.clear(); return { ok: true }; }
        return { error: "storage 未知 op：" + op };

      case "vfs": {
        var vp = String(args.path || "");
        if (op === "list") return vfs.list(vp);
        if (op === "get") return vfs.get(vp);
        if (op === "put") return vfs.put(vp, {
          name: args.name || vp.split("/").pop(),
          text: args.text, data: args.data, mime: args.mime
        });
        if (op === "del") return vfs.del(vp);
        if (op === "mkdir") return vfs.mkdir(vp);
        if (op === "rename") return vfs.rename(vp, String(args.to || ""));
        if (op === "usage") return vfs.usage();
        if (op === "clear") return vfs.clear();
        return { error: "vfs 未知 op：" + op };
      }

      case "app":
        if (op === "list" || !op) return { apps: appList(), running: runningList() };
        if (op === "open") { openApp(String(args.id || ""), args.arg); return { ok: true }; }
        if (op === "close") { closeApp(String(args.id || "")); return { ok: true }; }
        return { error: "app 未知 op：" + op };

      case "toast":
        toast(String(args.msg == null ? "" : args.msg), args.ms); return { ok: true };

      case "lock":
        lockScreen(); return { ok: true };

      case "reload":
        setTimeout(function () { location.reload(); }, 400); return { reloading: true };

      case "dbg":
        if (args.on) dbgEnable(); else dbgDisable();
        return { debug: !!args.on };

      case "emit":
        emit(String(args.evt || ""), args.data); return { ok: true };

      default:
        return { error: "未知命令：" + cmd + "（ping/info/eval/storage/vfs/app/toast/lock/reload/dbg/emit）" };
    }
  }

  // 顺序执行一批命令，逐条回传结果（保持电脑端下发顺序）；单条结果超 4MB 截断
  function devRunQueue(cmds) {
    var i = 0;
    function step() {
      if (i >= cmds.length) return Promise.resolve();
      var c = cmds[i++], t0 = Date.now();
      return Promise.resolve().then(function () {
        return devExec(c.cmd, c.args || {});
      }).then(function (res) {
        return { ok: true, data: res, ms: Date.now() - t0 };
      }, function (err) {
        return { ok: false, error: (err && err.message) ? err.message : String(err), ms: Date.now() - t0 };
      }).then(function (res) {
        dev.cmds++; if (res.ok) dev.ok++; else dev.fail++;
        dev.lastAt = Date.now();
        try { emit("dev-cmd", { cmd: c.cmd, args: c.args || {}, res: res }); } catch (e) { }
        try { nvLog("info", "dev", "cmd " + c.cmd + " → " + (res.ok ? "ok" : "err") + " " + res.ms + "ms"); } catch (e) { }
        var body = { token: dev.token, cid: c.cid, res: res };
        var payload = "";
        try { payload = JSON.stringify(body); } catch (e) { }
        if (payload.length > 4 * 1024 * 1024) {
          res.data = "[结果过大（" + (payload.length / 1048576).toFixed(1) + "MB），已截断]";
          body = { token: dev.token, cid: c.cid, res: res };
        }
        return netCall("sys/dev-result", body);
      }).then(step);
    }
    return step();
  }

  function devCall(kind, body) { return netCall("sys/dev-" + kind, body); }

  /* 轮询主循环（单链）：无 token → hello 握手；有 token → 长轮询挂起。
   * 断网指数退避（2s→15s）；电脑端关闭开发模式 → 60s 后再试。 */
  function devLoop() {
    var job = dev.token
      ? devCall("poll", { token: dev.token, wait: dev.wait })
      : netProbe(false).then(function (p) {
        if (!p) return null;
        return devCall("hello", {
          token: dev.token || "", ver: 1,
          ua: navigator.userAgent, url: location.href,
          apps: appList().map(function (a) { return a.id; }),
          scr: window.innerWidth + "x" + window.innerHeight
        });
      });
    job.then(function (j) {
      if (!j) return fail("网络不可达");
      if (j.devoff) {
        if (!dev.off) { dev.off = true; dev.on = false; devChanged(); }
        return later(60000);
      }
      if (j.invalid) { dev.token = ""; Store.remove(DEV_KEY); return later(500); }
      if (!j.ok) return fail(j.error || "dev 通道错误");
      if (!dev.token) {          // hello 成功：记下会话令牌
        dev.token = j.token; dev.wait = j.poll || 25;
        Store.set(DEV_KEY, dev.token);
        try { nvLog("info", "dev", "开发模式已连接 token=" + dev.token + " poll=" + dev.wait + "s"); } catch (e) { }
      }
      dev.backoff = 0;
      if (!dev.on || dev.off) { dev.on = true; dev.off = false; devChanged(); }
      var cmds = j.cmds || [];
      var run = cmds.length ? devRunQueue(cmds) : Promise.resolve();
      run.then(function () { later(cmds.length ? 30 : 150); },
               function () { later(300); });
    }, function () { fail("poll 网络异常"); });

    function fail(why) {
      dev.on = false;
      dev.backoff = dev.backoff ? Math.min(15000, dev.backoff * 2) : 2000;
      try { nvLog("warn", "dev", "开发通道断开（" + why + "），" + dev.backoff + "ms 后重连"); } catch (e) { }
      devChanged(); later(dev.backoff);
    }
    function later(ms) { setTimeout(devLoop, ms); }
  }

  function devStart() {
    if (dev.looping) return;
    dev.looping = true;
    devLoop();
  }

  // 供 devterm 终端应用本地复用（与电脑下发走同一条全权限路由）
  var devApi = {
    state: devState,
    exec: function (cmd, args) {
      return Promise.resolve().then(function () { return devExec(cmd, args); });
    }
  };


  /* ---------------- 调试模式：统一日志器 + console/异常/网络全采集 ----------------
   * 开关存 localStorage（nova2.debug），开启后：
   *   1) 日志批量 POST 到 sys/log，电脑端按天落 logs/tablet-YYYYMMDD.log
   *   2) 同时追加写入平板离线空间 /日志/tablet-YYYYMMDD.log（256KB 截断，断网也能查）
   *   3) 自动包装 fetch / XMLHttpRequest，所有网络请求的状态码/耗时/失败自动入日志
   *   4) 捕获未处理异常、Promise reject、资源加载失败
   * 系统与所有应用统一用 OS.log(tag,msg,level) / OS.logerr(tag,err,ctx) 打点。
   * 离线时日志暂存缓冲，联网后补传。 */
  var DEBUG_KEY = "nova2.debug";
  var dbg = { on: false, buf: [], sending: false, timer: 0, orig: {} };
  var consoleOrig = {
    log: console.log.bind(console), info: (console.info || console.log).bind(console),
    warn: (console.warn || console.log).bind(console),
    error: (console.error || console.log).bind(console),
    debug: (console.debug || console.log).bind(console)
  };

  function dbgNow() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) +
           "." + ("00" + d.getMilliseconds()).slice(-3);
  }
  function dbgFmt(level, tag, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === "string" || a == null) parts.push(String(a));
      else if (a instanceof Error)
        parts.push(a.name + ": " + a.message + (a.stack ? " @" + String(a.stack).split("\n")[1] : ""));
      else {
        try { parts.push(JSON.stringify(a)); }
        catch (e) { parts.push(String(a)); }
      }
    }
    return dbgNow() + " " + level + " [" + tag + "] " + parts.join(" ");
  }

  function dbgSchedule() {
    if (!dbg.timer) dbg.timer = setInterval(dbgFlush, 3000);
  }
  function dbgPush(level, args) {
    // 应用直接 console.xxx 的原始行（无 tag，tag 位用 "-"）
    dbgEmit(level, "-", Array.prototype.slice.call(args));
  }
  function dbgEmit(level, tag, args) {
    var line = dbgFmt(level, tag, args);
    try { (consoleOrig[level] || consoleOrig.log)(line); } catch (e) { }
    if (!dbg.on) return;
    if (dbg.buf.length >= 400) dbg.buf.shift();
    dbg.buf.push(line);
    dbgSchedule();
    dbgFilePush(line);
  }
  // 全系统统一打点入口
  function nvLog(level, tag) {
    dbgEmit(level, tag, Array.prototype.slice.call(arguments, 2));
  }
  function nvErr(tag, err, ctx) {
    var msg = (ctx ? ctx + " | " : "") +
              (err && err.message ? (err.name || "Error") + ": " + err.message : String(err));
    if (err && err.stack) msg += " | " + String(err.stack).split("\n").slice(1, 3).join(" <- ");
    dbgEmit("error", tag, [msg]);
  }
  function dbgFlush() {
    if (dbg.sending || !dbg.buf.length) return;
    var batch = dbg.buf.splice(0, Math.min(100, dbg.buf.length));
    dbg.sending = true;
    netCall("sys/log", { logs: batch }).then(function () {
      dbg.sending = false;
      if (dbg.buf.length) dbgFlush();
    }, function () {
      dbg.sending = false;
      dbg.buf = batch.concat(dbg.buf).slice(-400);   // 发送失败保留，稍后重试
    });
  }

  /* ---------- 日志同步落盘：离线空间 /日志/tablet-YYYYMMDD.log ---------- */
  var LOG_DIR_VFS = "/日志";
  var dbgFile = { pending: [], writing: false, fails: 0, timer: 0 };
  function dbgFileDay() {
    var d = new Date(), p = function (n) { n = "" + n; while (n.length < 2) n = "0" + n; return n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  function dbgFilePush(line) {
    dbgFile.pending.push(line);
    if (dbgFile.pending.length >= 50) dbgFileFlush();
    else if (!dbgFile.timer) dbgFile.timer = setInterval(dbgFileTick, 2000);
  }
  function dbgFileTick() {
    if (dbgFile.pending.length) dbgFileFlush();
  }
  function dbgFileFlush() {
    if (dbgFile.writing || !dbgFile.pending.length) return;
    var batch = dbgFile.pending.splice(0, 50);
    dbgFile.writing = true;
    var name = "tablet-" + dbgFileDay() + ".log";
    var path = LOG_DIR_VFS + "/" + name;
    vfs.get(path)["catch"](function () { return { ok: false }; }).then(function (g) {
      var prev = (g && g.ok && g.text !== undefined && g.text !== null) ? g.text : "";
      var text = prev + (prev && prev.charAt(prev.length - 1) !== "\n" ? "\n" : "") +
                 batch.join("\n") + "\n";
      if (text.length > 262144) text = text.slice(text.length - 204800);  // 256KB 留尾部
      return vfs.put(path, { name: name, text: text }).then(function (r) {
        dbgFile.writing = false;
        dbgFile.fails = 0;
        if (r && r.ok === false) throw new Error(r.error || "vfs.put 失败");
        if (dbgFile.pending.length) dbgFileFlush();
      });
    })["catch"](function (e) {
      dbgFile.writing = false;
      dbgFile.pending = batch.concat(dbgFile.pending).slice(-400);
      if (dbgFile.fails++ < 2) consoleOrig.error("[日志] 离线空间写入失败：", e && e.message);
    });
  }
  // 清理 3 天前的本地日志文件（仅按文件名日期判断）
  function dbgFileGc() {
    try {
      var keep = dbgFileDay();
      vfs.list(LOG_DIR_VFS).then(function (r) {
        if (!r.ok) return;
        (r.entries || []).forEach(function (en) {
          var m = /^tablet-(\d{8})\.log$/.exec(en.name || "");
          if (m && m[1] < keep - 2) {   // 字符串日期可直接比大小，留 3 天
            vfs.del(LOG_DIR_VFS + "/" + en.name)["catch"](function () { });
          }
        });
      })["catch"](function () { });
    } catch (e) { }
  }

  /* ---------- 网络自动埋点（开关开启才真正记录，关时仅一次布尔判断） ---------- */
  function dbgInstallFetch() {
    if (window.__nvFetchPatched || !window.fetch) return;
    window.__nvFetchPatched = true;
    var of = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = (typeof input === "string") ? input : ((input && input.url) || "?");
      var method = ((init && init.method) ||
        (typeof input !== "string" && input && input.method) || "GET").toUpperCase();
      var skip = url.indexOf("sys/log") >= 0;
      var t0 = Date.now();
      return of(input, init).then(function (r) {
        if (dbg.on && !skip)
          nvLog(r.status >= 400 ? "warn" : "debug", "net",
                method + " " + r.status + " " + (Date.now() - t0) + "ms " + url.slice(0, 180));
        return r;
      }, function (e) {
        if (dbg.on && !skip)
          nvLog("error", "net", method + " 失败 " + url.slice(0, 180) + " | " + (e && e.message));
        throw e;
      });
    };
  }
  function dbgInstallXHR() {
    if (window.__nvXhrPatched || !window.XMLHttpRequest) return;
    window.__nvXhrPatched = true;
    var O = XMLHttpRequest, op = O.prototype.open, osend = O.prototype.send;
    O.prototype.open = function (m, u) { this.__nvM = m; this.__nvU = u; return op.apply(this, arguments); };
    O.prototype.send = function () {
      var x = this, t0 = Date.now(), u = String(x.__nvU || "?"), skip = u.indexOf("sys/log") >= 0;
      x.addEventListener("loadend", function () {
        if (dbg.on && !skip)
          nvLog(x.status >= 400 ? "warn" : "debug", "xhr",
                x.__nvM + " " + x.status + " " + (Date.now() - t0) + "ms " + u.slice(0, 180));
      });
      x.addEventListener("error", function () {
        if (dbg.on && !skip) nvLog("error", "xhr", x.__nvM + " 失败 " + u.slice(0, 180));
      });
      return osend.apply(this, arguments);
    };
  }
  function dbgBanner() {
    try {
      nvLog("info", "boot", "===== 调试模式启动 =====");
      nvLog("info", "boot", "页面 " + location.href);
      nvLog("info", "boot", "UA " + navigator.userAgent);
      nvLog("info", "boot", "屏幕 " + screen.width + "x" + screen.height +
        " 视口 " + window.innerWidth + "x" + window.innerHeight +
        " 在线 " + (navigator.onLine ? "是" : "否"));
      nvLog("info", "boot", "时间 " + new Date().toString());
    } catch (e) { }
  }

  function dbgEnable() {
    if (dbg.on) return;
    dbg.on = true;
    ["log", "info", "warn", "error", "debug"].forEach(function (lv) {
      var orig = (console[lv] || console.log).bind(console);
      dbg.orig[lv] = orig;
      console[lv] = function () {
        try { dbgPush(lv, arguments); } catch (e) { }
        return orig.apply(null, arguments);
      };
    });
    dbgInstallFetch();
    dbgInstallXHR();
    window.addEventListener("error", function (e) {
      if (!dbg.on) return;
      if (e.message) {
        dbgPush("error", ["[未捕获错误] " + (e.message || "(未知)") + " @ " +
          (e.filename || "") + ":" + (e.lineno || 0) + ":" + (e.colno || 0)]);
      }
    });
    // 资源（img/script/link/audio…）加载失败只在捕获阶段能拿到
    window.addEventListener("error", function (e) {
      if (!dbg.on) return;
      var t = e.target;
      if (t && t !== window && (t.src || t.href))
        dbgPush("error", ["[资源加载失败] " + (t.tagName || "?") + " " + (t.src || t.href)]);
    }, true);
    window.addEventListener("unhandledrejection", function (e) {
      if (!dbg.on) return;
      var r = e.reason;
      dbgPush("error", ["[未处理Promise] " + ((r && (r.stack || r.message)) || String(r))]);
    });
    dbgInstallFetch(); dbgInstallXHR();
    dbgBanner();
    dbgFileGc();
    dbgPush("info", ["[debug] 调试模式已开启：日志回传电脑 + 写入离线空间 /日志/"]);
    dbgSchedule();
  }
  function dbgDisable() {
    if (!dbg.on) return;
    nvLog("info", "boot", "调试模式关闭，刷写剩余日志");
    dbgFlush();
    dbgFileFlush();
    Object.keys(dbg.orig).forEach(function (lv) { console[lv] = dbg.orig[lv]; });
    dbg.orig = {};
    dbg.on = false;
  }
  var debugApi = {
    enabled: function () { return dbg.on; },
    enable: function () { Store.set(DEBUG_KEY, true); dbgEnable(); },
    disable: function () { Store.set(DEBUG_KEY, false); dbgDisable(); }
  };

  /* ---------------- 平板离线空间备份到电脑 ----------------
   * 递归遍历 VFS → sys/vfs-begin → 逐文件二进制 push → commit 打包。
   * onProgress({phase, index, total, name}) 供界面显示进度。 */
  function netPostRaw(rel, blob) {
    function attempt(base, tries) {
      return fetch(base + rel, { method: "POST", body: blob })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .catch(function () { return null; })
        .then(function (j) {
          if (j) return j;
          if (tries < 1) {
            return netProbe(true).then(function (p) {
              return p ? attempt(p.base, tries + 1) : OFFLINE;
            });
          }
          return OFFLINE;
        });
    }
    if (NET.base) return attempt(NET.base, 0);
    return netProbe(false).then(function (p) {
      return p ? attempt(p.base, 0) : OFFLINE;
    });
  }

  // GET 挂载点原始资源（应用仓库 .tzyp 下载等），带一次故障转移，成功返回 Blob
  function netGetRaw(rel) {
    function attempt(base, tries) {
      return fetch(base + rel, { method: "GET" })
        .then(function (r) {
          if (r.status === 200) return r.blob().then(function (b) { return { ok: true, blob: b }; });
          return r.json()["catch"](function () { return null; }).then(function (j) {
            return j || { ok: false, error: "HTTP " + r.status };
          });
        })
        .catch(function () { return null; })
        .then(function (res) {
          if (res) return res;
          if (tries < 1) {
            return netProbe(true).then(function (p) {
              return p ? attempt(p.base, tries + 1)
                      : { ok: false, offline: true, error: "电脑服务不可用（离线模式）" };
            });
          }
          return { ok: false, offline: true, error: "电脑服务不可用（离线模式）" };
        });
    }
    if (NET.base) return attempt(NET.base, 0);
    return netProbe(false).then(function (p) {
      return p ? attempt(p.base, 0)
              : { ok: false, offline: true, error: "电脑服务不可用（离线模式）" };
    });
  }

  function tabletBackup(onProgress) {
    function prog(phase, idx, total, name) {
      if (typeof onProgress === "function") {
        try { onProgress({ phase: phase, index: idx, total: total, name: name || "" }); } catch (e) { }
      }
    }
    var files = [];
    function walk(dir) {
      return vfs.list(dir).then(function (r) {
        if (!r.ok) throw new Error(r.error || "列举离线空间失败");
        var chain = Promise.resolve();
        (r.entries || []).forEach(function (en) {
          var p = (dir === "" ? "" : dir) + "/" + en.name;
          if (en.dir) {
            chain = chain.then(function () { return walk(p); });
          } else {
            files.push({ path: p, name: en.name, size: en.size || 0 });
          }
        });
        return chain;
      });
    }
    return vfs.ready().then(function () { return walk(""); })
      .then(function () {
        // localStorage 快照（设置/文档/连接配置等，便于完整还原）
        var snap = {};
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf("nova2.") === 0) snap[k] = localStorage.getItem(k);
          }
        } catch (e) { }
        files.push({
          path: "/.tzy-localstorage.json", name: ".tzy-localstorage.json",
          size: 0, _local: true, _json: snap
        });
        prog("begin", 0, files.length);
        nvLog("info", "backup", "全量备份开始，共 " + files.length + " 个文件");
        return netCall("sys/vfs-begin", { device: "tablet", files: files });
      })
      .then(function (r0) {
        if (!r0 || !r0.ok) throw new Error((r0 && r0.error) || "电脑服务不可用，无法备份");
        var sid = r0.sid;
        var i = 0;
        function next() {
          if (i >= files.length) {
            prog("commit", files.length, files.length);
            return netCall("sys/vfs-commit", { sid: sid });
          }
          var f = files[i++];
          prog("push", i, files.length, f.name);
          var getBlob;
          if (f._local) {
            getBlob = Promise.resolve(
              new Blob([JSON.stringify(f._json)], { type: "application/json" }));
          } else {
            getBlob = vfs.get(f.path).then(function (g) {
              if (!g.ok) throw new Error(g.error || "读取失败");
              if (g.text !== undefined && g.text !== null) {
                return new Blob([g.text], { type: (g.mime || "text/plain") + ";charset=utf-8" });
              }
              return b64ToBlob(g.data, g.mime || "application/octet-stream");
            });
          }
          return getBlob.then(function (blob) {
            var rel = "sys/vfs-push?sid=" + encodeURIComponent(sid) +
                      "&p=" + encodeURIComponent(f.path);
            return netPostRaw(rel, blob).then(function (rp) {
              if (!rp || !rp.ok) throw new Error((rp && rp.error) || ("推送失败：" + f.name));
              return next();   // 必须 return，否则顶层 Promise 会提前 resolve
            });
          });
        }
        return next();
      });
  }

  /* ---------------- 音乐歌单单独备份到电脑 ----------------
   * 推送 /音乐歌单.json（localStorage nova2.music.playlists 原文，含全部歌单与收藏元数据）；
   * withAudio=true 时附加离线空间 /音乐 目录下已下载的音频文件。
   * 走与平板全量备份相同的 sys/vfs-begin|push|commit，manifest 带 scope:"music"，
   * 电脑端会话目录/zip 名带 music- 前缀，便于在 backups/tablet/ 里区分。 */
  var MUSIC_PL_KEY = "nova2.music.playlists";
  function musicBackup(withAudio, onProgress) {
    function prog(phase, idx, total, name) {
      if (typeof onProgress === "function") {
        try { onProgress({ phase: phase, index: idx, total: total, name: name || "" }); } catch (e) { }
      }
    }
    var files = [{
      path: "/音乐歌单.json", name: "音乐歌单.json", size: 0,
      _local: true, _text: ""
    }];
    try { files[0]._text = localStorage.getItem(MUSIC_PL_KEY) || ""; } catch (e) { }
    var collect = Promise.resolve();
    if (withAudio) {
      // 下载的音频平铺在 /音乐 下，列一层即可；目录不存在视为没有已下载歌曲
      collect = vfs.list("/音乐").then(function (r) {
        if (!r.ok) return;
        (r.entries || []).forEach(function (en) {
          if (en.dir) return;
          files.push({ path: "/音乐/" + en.name, name: en.name, size: en.size || 0 });
        });
      });
    }
    return vfs.ready().then(function () { return collect; }).then(function () {
      prog("begin", 0, files.length);
      nvLog("info", "musicbk", "音乐歌单备份开始（含音频=" + (withAudio ? 1 : 0) +
        "），共 " + files.length + " 个文件");
      return netCall("sys/vfs-begin", { device: "tablet", scope: "music", files: files });
    }).then(function (r0) {
      if (!r0 || !r0.ok) throw new Error((r0 && r0.error) || "电脑服务不可用，无法备份");
      var sid = r0.sid;
      var i = 0;
      function next() {
        if (i >= files.length) {
          prog("commit", files.length, files.length);
          return netCall("sys/vfs-commit", { sid: sid });
        }
        var f = files[i++];
        prog("push", i, files.length, f.name);
        var getBlob;
        if (f._local) {
          getBlob = Promise.resolve(
            new Blob([f._text], { type: "application/json;charset=utf-8" }));
        } else {
          getBlob = vfs.get(f.path).then(function (g) {
            if (!g.ok) throw new Error(g.error || "读取失败");
            if (g.text !== undefined && g.text !== null) {
              return new Blob([g.text], { type: (g.mime || "text/plain") + ";charset=utf-8" });
            }
            return b64ToBlob(g.data, g.mime || "application/octet-stream");
          });
        }
        return getBlob.then(function (blob) {
          var rel = "sys/vfs-push?sid=" + encodeURIComponent(sid) +
                    "&p=" + encodeURIComponent(f.path);
          return netPostRaw(rel, blob).then(function (rp) {
            if (!rp || !rp.ok) throw new Error((rp && rp.error) || ("推送失败：" + f.name));
            return next();
          });
        });
      }
      return next();
    });
  }

  /* ---------------- 离线文件系统（IndexedDB VFS，内容以 Blob 存储） ----------------
   * IDB 库 nova2：store meta 单条 {dirs, files:{path:{name,mime,size,mtime,kind}}}
   *              store blobs：path -> Blob（文本为 UTF-8，二进制原样）
   * 容量：浏览器配额通常数百 MB（navigator.storage.estimate 查询）。
   * IDB 不可用时自动降级 localStorage（约 5MB，旧结构 nova2.vfs）。
   * 方法契约不变，全部返回 Promise。 */
  var VFS_KEY = "nova2.vfs";
  var IDB_DB = "nova2";
  function vfsNorm(p) {
    p = String(p || "").replace(/\\/g, "/");
    while (p.indexOf("//") >= 0) p = p.replace(/\/\//g, "/");
    if (p.charAt(0) !== "/") p = "/" + p;
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return p;
  }
  function vfsParent(p) {
    var i = p.lastIndexOf("/");
    return i <= 0 ? "" : p.slice(0, i);
  }
  function textBytes(s) {
    try { return unescape(encodeURIComponent(s || "")).length; }
    catch (e) { return (s || "").length; }
  }
  function vfsListEntries(t, dir) {
    var prefix = dir === "" ? "/" : dir + "/";
    var entries = [], seen = {};
    for (var dk in t.dirs) {
      if (dk === "" || dk === dir || dk.indexOf(prefix) !== 0) continue;
      var rest = dk.slice(prefix.length);
      if (rest && rest.indexOf("/") < 0 && !seen["d:" + rest]) {
        seen["d:" + rest] = 1;
        entries.push({ name: rest, dir: true, size: 0, mtime: 0 });
      }
    }
    for (var fk in t.files) {
      if (fk.indexOf(prefix) !== 0) continue;
      var fr = fk.slice(prefix.length);
      if (fr && fr.indexOf("/") < 0 && !seen["f:" + fr]) {
        seen["f:" + fr] = 1;
        var f = t.files[fk];
        entries.push({ name: fr, dir: false, size: f.size || 0, mtime: f.mtime || 0 });
      }
    }
    entries.sort(function (a, b) {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    });
    return entries;
  }
  function quotaError(err) {
    var name = err && (err.name || (err.message || ""));
    try {
      nvLog(/quota/i.test(name) ? "warn" : "error", "vfs",
            "存储异常：" + name + " " + (err && err.message ? err.message : ""));
    } catch (_) { }
    if (/quota/i.test(name)) return { ok: false, error: "离线空间已满（浏览器配额不足）" };
    return { ok: false, error: "存储读写失败：" + (err && err.message ? err.message : name || "未知错误") };
  }
  function readBlobAs(blob, asText) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        if (asText) resolve(String(fr.result || ""));
        else {
          var s = String(fr.result || "");
          var i = s.indexOf(",");
          resolve(i >= 0 ? s.slice(i + 1) : "");
        }
      };
      fr.onerror = function () { reject(new Error("读取文件内容失败")); };
      if (asText) fr.readAsText(blob);
      else fr.readAsDataURL(blob);
    });
  }

  /* ---------- 引擎一：localStorage 降级实现（旧版结构，约 5MB） ---------- */
  function vfsLoad() { return Store.get(VFS_KEY, null) || { dirs: { "": 1 }, files: {} }; }
  function vfsSave(t) {
    try { Store.set(VFS_KEY, t); return { ok: true }; }
    catch (e) { return { ok: false, error: "离线空间已满（浏览器本地存储约 5MB 上限）" }; }
  }
  var legacyVfs = {
    list: function (dir) {
      dir = dir ? vfsNorm(dir) : "";
      return Promise.resolve({ ok: true, path: dir, entries: vfsListEntries(vfsLoad(), dir) });
    },
    get: function (path) {
      var f = vfsLoad().files[vfsNorm(path)];
      return Promise.resolve(f ? { ok: true, text: f.text !== undefined && f.text !== null,
        name: f.name, content: f.text, data: f.data, mime: f.mime }
        : { ok: false, error: "文件不存在" });
    },
    put: function (path, rec) {
      var t = vfsLoad();
      path = vfsNorm(path);
      var acc = "";
      vfsParent(path).split("/").forEach(function (seg) {
        if (!seg) return;
        acc += "/" + seg;
        t.dirs[acc] = 1;
      });
      var text = rec.text !== undefined && rec.text !== null ? String(rec.text) : null;
      var data = rec.data || null;
      t.files[path] = {
        name: rec.name || path.split("/").pop(),
        mime: rec.mime || "application/octet-stream",
        text: text, data: data,
        size: text !== null ? textBytes(text) : (data ? Math.floor(data.length * 3 / 4) : 0),
        mtime: Date.now()
      };
      return Promise.resolve(vfsSave(t));
    },
    del: function (path) {
      var t = vfsLoad();
      path = vfsNorm(path);
      if (t.files[path] !== undefined) { delete t.files[path]; }
      else {
        var prefix = path + "/";
        for (var k in t.files) if (k.indexOf(prefix) === 0) { delete t.files[k]; }
        for (var d in t.dirs) if (d === path || d.indexOf(prefix) === 0) { delete t.dirs[d]; }
      }
      return Promise.resolve(vfsSave(t));
    },
    mkdir: function (path) {
      var t = vfsLoad();
      path = vfsNorm(path);
      var acc = "";
      path.split("/").forEach(function (seg) {
        if (!seg) return;
        acc += "/" + seg;
        t.dirs[acc] = 1;
      });
      return Promise.resolve(vfsSave(t));
    },
    usage: function () {
      var t = vfsLoad();
      var nFiles = 0, nDirs = 0, maxApprox = 5 * 1024 * 1024;
      for (var k in t.files) nFiles++;
      for (var d in t.dirs) if (d !== "") nDirs++;
      return Promise.resolve({ ok: true, bytes: textBytes(JSON.stringify(t)),
        files: nFiles, dirs: nDirs, max: maxApprox });
    },
    clear: function () { return Promise.resolve(vfsSave({ dirs: { "": 1 }, files: {} })); },
    rename: function (oldPath, newPath) {
      oldPath = vfsNorm(oldPath);
      newPath = vfsNorm(newPath);
      var t = vfsLoad();
      if (t.files[oldPath] !== undefined) {
        var rec = t.files[oldPath];
        rec.name = newPath.split("/").pop();
        rec.mtime = Date.now();
        delete t.files[oldPath];
        t.files[newPath] = rec;
      } else {
        var prefix = oldPath + "/", moved = false;
        for (var k in t.files) {
          if (k === oldPath || k.indexOf(prefix) === 0) {
            var nk = newPath + k.slice(oldPath.length);
            t.files[nk] = t.files[k];
            t.files[nk].name = nk.split("/").pop();
            delete t.files[k];
            moved = true;
          }
        }
        for (var d in t.dirs) {
          if (d === oldPath || d.indexOf(prefix) === 0) {
            var nd = newPath + d.slice(oldPath.length);
            delete t.dirs[d];
            t.dirs[nd] = 1;
            moved = true;
          }
        }
        if (!moved) return Promise.resolve({ ok: false, error: "路径不存在" });
      }
      return Promise.resolve(vfsSave(t));
    }
  };

  /* ---------- 引擎二：IndexedDB 实现（数百 MB 配额，内容以 Blob 存） ---------- */
  function openIDB() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") { reject(new Error("no-indexeddb")); return; }
      var rq;
      try { rq = indexedDB.open(IDB_DB, 2); }
      catch (e) { reject(e); return; }
      rq.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        // meta：内联键（记录自带 k 字段）。v1 曾误建成无 keyPath，需删了重建（该版本未发布，无用户数据）。
        if (db.objectStoreNames.contains("meta")) {
          var old = ev.target.transaction.objectStore("meta");
          if (!old.keyPath) { db.deleteObjectStore("meta"); }
        }
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "k" });
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error || new Error("idb open failed")); };
      rq.onblocked = function () { reject(new Error("idb blocked")); };
    });
  }
  function idbGetMeta(db) {
    return new Promise(function (resolve, reject) {
      var r = db.transaction(["meta"], "readonly").objectStore("meta").get("vfs");
      r.onsuccess = function () {
        resolve(r.result && r.result.dirs ? r.result : { dirs: { "": 1 }, files: {} });
      };
      r.onerror = function () { reject(r.error); };
    });
  }
  // 元数据 + blob 在同一个 readwrite 事务内改，fn(meta, blobStore) 同步部分排队请求即可
  function idbMutate(db, fn) {
    return idbGetMeta(db).then(function (m) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(["meta", "blobs"], "readwrite");
        var ms = t.objectStore("meta"), bs = t.objectStore("blobs");
        var out;
        try { out = fn(m, bs); }
        catch (e) { try { t.abort(); } catch (_) {} reject(e); return; }
        ms.put({ k: "vfs", dirs: m.dirs, files: m.files });
        t.oncomplete = function () { resolve(out === undefined ? { ok: true } : out); };
        t.onabort = function () { reject(t.error || new Error("idb aborted")); };
        t.onerror = function () { reject(t.error || new Error("idb error")); };
      });
    });
  }
  function makeIDBImpl(db) {
    var impl = {
      list: function (dir) {
        dir = dir ? vfsNorm(dir) : "";
        return idbGetMeta(db).then(function (m) {
          return { ok: true, path: dir, entries: vfsListEntries(m, dir) };
        });
      },
      get: function (path) {
        path = vfsNorm(path);
        return idbGetMeta(db).then(function (m) {
          var f = m.files[path];
          if (!f) return { ok: false, error: "文件不存在" };
          return new Promise(function (resolve, reject) {
            var r = db.transaction(["blobs"], "readonly").objectStore("blobs").get(path);
            r.onsuccess = function () {
              var asText = f.kind === "text";
              readBlobAs(r.result || new Blob([]), asText).then(function (val) {
                if (asText) resolve({ ok: true, name: f.name, mime: f.mime, text: true, content: val, textContent: val });
                else resolve({ ok: true, name: f.name, mime: f.mime, data: val });
              }, reject);
            };
            r.onerror = function () { reject(r.error); };
          });
        }).then(function (rec) {
          // 与旧契约对齐：文本文件 text/content 即字符串本身
          if (rec.ok && rec.textContent !== undefined) {
            rec.text = rec.textContent;
            rec.content = rec.textContent;
            delete rec.textContent;
          }
          return rec;
        }).catch(function (e) { return quotaError(e); });
      },
      put: function (path, rec) {
        path = vfsNorm(path);
        return idbMutate(db, function (m, bs) {
          var acc = "";
          vfsParent(path).split("/").forEach(function (seg) {
            if (!seg) return;
            acc += "/" + seg;
            m.dirs[acc] = 1;
          });
          var isText = rec.text !== undefined && rec.text !== null;
          var blob, size, kind;
          if (isText) {
            var s = String(rec.text);
            blob = new Blob([s], { type: "text/plain;charset=utf-8" });
            size = textBytes(s);
            kind = "text";
          } else {
            blob = rec.data ? b64ToBlob(rec.data, rec.mime || "application/octet-stream")
                            : new Blob([]);
            size = rec.data ? Math.floor(rec.data.replace(/=+$/, "").length * 3 / 4) : 0;
            kind = "bin";
          }
          m.files[path] = {
            name: rec.name || path.split("/").pop(),
            mime: rec.mime || "application/octet-stream",
            size: size, mtime: Date.now(), kind: kind
          };
          bs.put(blob, path);
        }).catch(function (e) { return quotaError(e); });
      },
      del: function (path) {
        path = vfsNorm(path);
        return idbMutate(db, function (m, bs) {
          if (m.files[path] !== undefined) {
            delete m.files[path];
            bs.delete(path);
          } else {
            var prefix = path + "/";
            for (var k in m.files) {
              if (k.indexOf(prefix) === 0) { delete m.files[k]; bs.delete(k); }
            }
            for (var d in m.dirs) {
              if (d === path || d.indexOf(prefix) === 0) delete m.dirs[d];
            }
          }
        }).catch(function (e) { return quotaError(e); });
      },
      mkdir: function (path) {
        path = vfsNorm(path);
        return idbMutate(db, function (m) {
          var acc = "";
          path.split("/").forEach(function (seg) {
            if (!seg) return;
            acc += "/" + seg;
            m.dirs[acc] = 1;
          });
        }).catch(function (e) { return quotaError(e); });
      },
      usage: function () {
        return idbGetMeta(db).then(function (m) {
          var nFiles = 0, nDirs = 0, sum = 0, k, d;
          for (k in m.files) { nFiles++; sum += m.files[k].size || 0; }
          for (d in m.dirs) if (d !== "") nDirs++;
          var est = navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : null;
          var fallback = { ok: true, bytes: sum, files: nFiles, dirs: nDirs, max: 256 * 1024 * 1024 };
          if (!est) return fallback;
          return est.then(function (q) {
            // estimate 是整个源的配额；usage 取本库时浏览器无细分接口，取 max(文件总和, 源已用)
            return {
              ok: true,
              bytes: Math.max(sum, (q && q.usage) || sum),
              files: nFiles, dirs: nDirs,
              max: (q && q.quota && q.quota > sum) ? q.quota : fallback.max
            };
          }, function () { return fallback; });
        }).catch(function (e) { return quotaError(e); });
      },
      clear: function () {
        return idbMutate(db, function (m, bs) {
          m.dirs = { "": 1 };
          m.files = {};
          bs.clear();
        }).catch(function (e) { return quotaError(e); });
      },
      rename: function (oldPath, newPath) {
        oldPath = vfsNorm(oldPath);
        newPath = vfsNorm(newPath);
        return idbMutate(db, function (m, bs) {
          var moves = [];
          if (m.files[oldPath] !== undefined) {
            moves.push([oldPath, newPath]);
          } else {
            var prefix = oldPath + "/", moved = false, k, d;
            for (k in m.files) {
              if (k === oldPath || k.indexOf(prefix) === 0) moves.push([k, newPath + k.slice(oldPath.length)]);
            }
            for (var ki = 0; ki < moves.length; ki++) {
              var pair = moves[ki];
              var rec = m.files[pair[0]];
              rec.name = pair[1].split("/").pop();
              rec.mtime = Date.now();
              delete m.files[pair[0]];
              m.files[pair[1]] = rec;
              moved = true;
            }
            for (d in m.dirs) {
              if (d === oldPath || d.indexOf(prefix) === 0) {
                var nd = newPath + d.slice(oldPath.length);
                delete m.dirs[d];
                m.dirs[nd] = 1;
                moved = true;
              }
            }
            if (!moved && !moves.length) { try { throw new Error("路径不存在"); } catch (e) { return Promise.reject(e); } }
          }
          if (m.files[oldPath] !== undefined) {
            var rec2 = m.files[oldPath];
            rec2.name = newPath.split("/").pop();
            rec2.mtime = Date.now();
            delete m.files[oldPath];
            m.files[newPath] = rec2;
          }
          // blob 改名：同一事务内逐个 get 再 put（请求在 fn 返回后仍会驱动事务至 complete）
          moves.forEach(function (pair) {
            var g = bs.get(pair[0]);
            g.onsuccess = function () {
              if (g.result !== undefined) bs.put(g.result, pair[1]);
              bs.delete(pair[0]);
            };
          });
        }).catch(function (e) {
          if (/路径不存在/.test(e.message || "")) return { ok: false, error: "路径不存在" };
          return quotaError(e);
        });
      }
    };
    return impl;
  }
  /* 旧 localStorage 数据一次性迁入 IDB（标记存 meta，旧键保留不删） */
  function migrateLegacy(db) {
    return new Promise(function (resolve) {
      var tr = db.transaction(["meta"], "readonly");
      var gr = tr.objectStore("meta").get("legacy-migrated");
      gr.onsuccess = function () {
        if (gr.result) { resolve(); return; }
        var old = null;
        try { old = Store.get(VFS_KEY, null); } catch (e) { old = null; }
        if (!old || !old.files) {
          var wt = db.transaction(["meta"], "readwrite");
          wt.objectStore("meta").put({ k: "legacy-migrated" });
          wt.oncomplete = function () { resolve(); };
          wt.onerror = function () { resolve(); };
          return;
        }
        var files = {}, puts = [], k;
        for (k in old.files) {
          var o = old.files[k] || {};
          var isText = o.text !== undefined && o.text !== null;
          files[k] = { name: o.name, mime: o.mime, size: o.size, mtime: o.mtime,
                       kind: isText ? "text" : "bin" };
          if (isText) puts.push([k, new Blob([String(o.text)], { type: "text/plain;charset=utf-8" })]);
          else if (o.data) { try { puts.push([k, b64ToBlob(o.data, o.mime)]); } catch (e) {} }
        }
        var t = db.transaction(["meta", "blobs"], "readwrite");
        t.objectStore("meta").put({ k: "vfs", dirs: old.dirs || { "": 1 }, files: files });
        t.objectStore("meta").put({ k: "legacy-migrated" });
        var bs = t.objectStore("blobs");
        puts.forEach(function (p) { bs.put(p[1], p[0]); });
        t.oncomplete = function () { resolve(); };
        t.onerror = function () { resolve(); };
        t.onabort = function () { resolve(); };
      };
      gr.onerror = function () { resolve(); };
    });
  }
  var vfsEngineP = openIDB().then(function (db) {
    return migrateLegacy(db).then(function () { return makeIDBImpl(db); });
  }).catch(function (e) {
    try { console.warn("[vfs] IndexedDB 不可用，降级 localStorage：", e); } catch (_) {}
    return legacyVfs;
  });
  var vfs = {
    ready: function () { return vfsEngineP.then(function () { return true; }); }
  };
  ["list", "get", "put", "del", "mkdir", "usage", "clear", "rename"].forEach(function (name) {
    vfs[name] = function () {
      var args = arguments;
      return vfsEngineP.then(function (impl) { return impl[name].apply(impl, args); });
    };
  });

  /* ---------------- base64 / 下载工具 ---------------- */
  function b64ToBlob(b64, mime) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime || "application/octet-stream" });
  }
  var MIME = {
    txt: "text/plain", md: "text/plain", log: "text/plain", csv: "text/csv",
    json: "application/json", js: "text/plain", css: "text/css", html: "text/html",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
    zip: "application/zip", mp3: "audio/mpeg", mp4: "video/mp4"
  };
  function mimeOf(name) {
    var ext = String(name || "").split(".").pop().toLowerCase();
    return MIME[ext] || "application/octet-stream";
  }
  function downloadName(name, content) {
    var url = URL.createObjectURL(content);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }, 60);
  }
  function readFileB64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        // result: data:<mime>;base64,xxxx
        var s = String(fr.result || "");
        var i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : "");
      };
      fr.onerror = function () { reject(new Error("读取文件失败")); };
      fr.readAsDataURL(file);
    });
  }

  /* ---------------- 应用注册表与窗口管理 ----------------
   * 借鉴 ColumnOS：应用清单（id/name/icon/version/desktop）+ 单例窗口 +
   * 任务视图（运行中应用卡片，可切换/关闭）+ 一键显示桌面。 */
  var apps = {};          // id -> {def, root, inited, win}
  var appOrder = [];      // 桌面图标顺序（= 注册顺序，可被清单约定扩展）
  var zBase = 100;
  var activeId = null;    // 当前聚焦的运行窗口

  function registerApp(def) {
    if (!def || !def.id) return;
    // 仅加载 .tzyp 用户应用期间注入的注册标记为用户应用，其余视为系统内置
    if (loadingPkgId) def.user = true;
    if (apps[def.id]) {
      // 系统内置应用不允许被包覆盖；用户应用更新时整体替换定义
      if (apps[def.id].def.builtin || !def.user) return;
      var old = apps[def.id];
      if (old.win) { try { old.win.close(); } catch (e) { } }
      if (old.root && old.root.parentNode) {
        try { old.root.parentNode.removeChild(old.root); } catch (e) { }
      }
      apps[def.id] = { def: def, root: null, inited: false, win: null };
      if (desktopReady) renderDesktop();
      return;
    }
    if (!def.user) def.builtin = true;
    apps[def.id] = { def: def, root: null, inited: false, win: null };
    appOrder.push(def.id);
    if (desktopReady) renderDesktop();
  }

  // 应用清单（设置页/应用商店展示用）
  function appList() {
    return appOrder.map(function (id) {
      var d = apps[id].def;
      return {
        id: d.id, name: d.name, icon: d.icon || "·",
        iconData: d.iconData || "",
        tone: d.tone || "tone-ink",
        version: d.version || "1.0.0",
        desktop: d.desktop !== false,
        builtin: !d.user,
        desc: d.desc || "", author: d.author || ""
      };
    });
  }

  /* ============================================================
   * Tzy 应用包标准 .tzyp（zip 容器，应用与系统隔离、可独立安装/更新/卸载）
   *   app.json   清单（必需）：
   *     {id,name,version,main,icon,tone,maximize,desktop,desc,author}
   *     id 仅小写字母数字 _-；main 默认 main.js；icon 可写 emoji 或包内图片文件名
   *   <main>     入口脚本：加载后自行调用 OS.registerApp({...})
   *   其他文件   应用资源，运行时 OS.pkg.assetUrl(id, rel) 取 blob 网址
   * 安装位置：离线空间 /apps/<id>/；注册表：localStorage nova2.apps
   * Loshop & Cpt
   * ============================================================ */
  var APPS_KEY = "nova2.apps";
  var APPS_ROOT = "/apps";
  var APP_TOTAL_MAX = 50 * 1024 * 1024;   // 单包解压后总大小上限
  var APP_ICON_MAX = 64 * 1024;           // 图标 dataURL 入注册表的上限
  var loadingPkgId = null;                // 正在注入入口脚本的包 id（registerApp 据此标记）
  var pkgUrlCache = {};                   // id/rel -> 已生成的 blob 网址

  function appsRegGet() {
    var v = Store.get(APPS_KEY, []);
    return Array.isArray(v) ? v : [];
  }
  function appsRegSet(list) { Store.set(APPS_KEY, list); }
  function validAppId(id) {
    return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(id || ""));
  }
  function validPkgRel(rel) {
    if (!rel || rel.charAt(0) === "/" || rel.charAt(0) === "\\") return false;
    if (rel.indexOf("..") >= 0 || rel.indexOf(":") >= 0 || rel.charAt(0) === "~") return false;
    return true;
  }
  // 简易版本号比较：1.2.10 > 1.2.9；返回 1/0/-1
  function cmpVer(a, b) {
    function parts(x) {
      return String(x || "0").split(".").map(function (n) {
        var v = parseInt(n, 10); return isNaN(v) ? 0 : v;
      });
    }
    var pa = parts(a), pb = parts(b), n = Math.max(pa.length, pb.length);
    for (var i = 0; i < n; i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  function b64ToText(b64) {
    var bin = atob(String(b64 || ""));
    try {
      return decodeURIComponent(escape(bin));   // utf-8
    } catch (e) { return bin; }
  }

  // 注入一个已安装应用的入口脚本（Blob 网址，全局作用域）
  function loadInstalledApp(meta) {
    var mainPath = APPS_ROOT + "/" + meta.id + "/" + (meta.main || "main.js");
    return vfs.get(mainPath).then(function (g) {
      if (!g || !g.ok) throw new Error((g && g.error) || "入口缺失");
      var code = (g.text !== undefined && g.text !== null) ? g.text : b64ToText(g.data);
      var url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      loadingPkgId = meta.id;
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.onload = function () {
          URL.revokeObjectURL(url);
          loadingPkgId = null;
          resolve(meta);
        };
        s.onerror = function () {
          URL.revokeObjectURL(url);
          loadingPkgId = null;
          reject(new Error("入口脚本执行失败：" + (meta.main || "main.js")));
        };
        s.src = url;
        document.head.appendChild(s);
      });
    });
  }

  // 开机后异步加载全部已安装应用，单个失败不影响其他应用与系统
  function loadInstalledApps() {
    var list = appsRegGet();
    nvLog("info", "pkg", "加载已注册应用 " + list.length + " 个：" +
      list.map(function (m) { return m.id + "@" + m.version; }).join(", "));
    var chain = Promise.resolve();
    list.forEach(function (meta) {
      chain = chain.then(function () {
        if (!meta || !meta.id || apps[meta.id]) return null;
        return loadInstalledApp(meta)["catch"](function (e) {
          nvErr("pkg", e, "已安装应用 " + meta.id + " 加载失败，已移出注册表");
          appsRegSet(appsRegGet().filter(function (m) { return m.id !== meta.id; }));
        });
      });
    });
    return chain;
  }

  // 预装：仓库里标记 preinstall 的应用包，开机时静默安装/升级。
  // 记 nova2.preinstall.done = {id: 已装版本}：
  //   - 从未装过 → 安装；
  //   - 已装但仓库版本更高 → 静默升级（保证预装包在电脑端更新后能刷到设备）；
  //   - 用户主动卸载（版本记录被清）→ 不再回装。
  function preinstallApps() {
    return pkgApi.catalog().then(function (list) {
      var reg = Store.get("nova2.preinstall.done", []);
      if (!Array.isArray(reg)) reg = [];
      var seen = {};                       // 兼容旧格式（纯 id 数组）
      reg.forEach(function (x) {
        if (typeof x === "string") seen[x] = "";
        else if (x && x.id) seen[x.id] = String(x.version || "");
      });
      var installed = {};
      appsRegGet().forEach(function (m) { installed[m.id] = String(m.version || ""); });

      var todo = (list || []).filter(function (a) {
        if (!a || !a.preinstall || !a.file) return false;
        if (apps[a.id] && apps[a.id].def && apps[a.id].def.builtin) return false;
        var cur = installed[a.id] || seen[a.id];
        if (cur === undefined) return true;          // 从未装过 → 装
        return cmpVer(a.version, cur) > 0;           // 已装且仓库更新 → 升级
      });
      if (todo.length) nvLog("info", "pkg", "待预装/升级应用：" + todo.map(function (a) {
        return a.id + "@" + a.version;
      }).join(", "));
      var chain = Promise.resolve();
      todo.forEach(function (a) {
        chain = chain.then(function () {
          return pkgApi.download(a.file).then(function (r) {
            // download 返回 netGetRaw 包装对象 {ok, blob}，需解包后交给 install
            if (!r || !r.ok || !r.blob) throw new Error((r && r.error) || "下载失败");
            nvLog("debug", "pkg", "预装包已下载 " + a.file + " " +
              ((r.blob && r.blob.size) || 0) + " 字节");
            return pkgApi.install(r.blob);
          }).then(function () {
            var d2 = Store.get("nova2.preinstall.done", []);
            if (!Array.isArray(d2)) d2 = [];
            d2 = d2.filter(function (x) {
              return (typeof x === "string" ? x : (x && x.id)) !== a.id;
            });
            d2.push({ id: a.id, version: String(a.version) });
            Store.set("nova2.preinstall.done", d2);
            nvLog("info", "pkg", "预装成功：" + a.id + "@" + a.version);
            if (desktopReady) renderDesktop();
          })["catch"](function (e) {
            nvErr("pkg", e, "预装失败：" + a.id + "（" + a.file + "）");
          });
        });
      });
      return chain;
    })["catch"](function (e) {
      nvErr("pkg", e, "获取应用仓库清单失败，预装跳过");
    });
  }

  // 安装/更新：入参 zip Blob（.tzyp），返回注册项 meta
  function appInstall(blob, onProgress) {
    function pg(stage, cur, total) {
      if (stage === "open" || stage === "register" || stage === "done")
        nvLog("debug", "pkg", "安装阶段 " + stage + " " + (cur || 0) + "/" + (total || 0));
      if (typeof onProgress === "function") {
        try { onProgress({ stage: stage, cur: cur || 0, total: total || 0 }); } catch (e) { }
      }
    }
    var zip, meta;
    pg("open", 0, 1);
    if (!window.JSZip) return Promise.reject(new Error("安装组件未加载"));
    return window.JSZip.loadAsync(blob).then(function (z) {
      zip = z;
      var mf = zip.file("app.json");
      if (!mf) throw new Error("缺少清单 app.json");
      return mf.async("string");
    }).then(function (txt) {
      try { meta = JSON.parse(txt); } catch (e) { throw new Error("app.json 不是合法 JSON"); }
      if (!meta || typeof meta !== "object") throw new Error("清单格式错误");
      if (!validAppId(meta.id)) throw new Error("id 非法：仅允许小写字母/数字/_-，且 2~32 字符");
      if (!meta.name) throw new Error("清单缺少 name");
      meta.main = meta.main || "main.js";
      if (!validPkgRel(meta.main)) throw new Error("main 路径非法");
      if (!zip.file(meta.main)) throw new Error("入口文件不存在：" + meta.main);
      if (apps[meta.id] && apps[meta.id].def.builtin) throw new Error("与系统内置应用 id 冲突");
      if (meta.icon && !/^[\u0020-\uFFFF]{1,8}$/.test(meta.icon) &&
          (!validPkgRel(meta.icon) || !zip.file(meta.icon))) {
        throw new Error("icon 须为 emoji 或包内存在的图片文件名");
      }
      var entries = [];
      var total = 0;
      zip.forEach(function (rel, zf) {
        if (zf.dir) return;
        if (!validPkgRel(rel)) throw new Error("非法包内路径：" + rel);
        total += (zf._data && zf._data.uncompressedSize) || 0;
        if (total > APP_TOTAL_MAX) throw new Error("应用包超过 50MB 上限");
        entries.push({ rel: rel, zf: zf });
      });
      if (!entries.length) throw new Error("空包");
      var base = APPS_ROOT + "/" + meta.id;
      pg("clear", 0, entries.length);
      return (apps[meta.id] ? vfs.del(base) : Promise.resolve())
        ["catch"](function () { return null; })
        .then(function () { return vfs.mkdir(base)["catch"](function () { return null; }); })
        .then(function () {
          var iconData = "";
          if (meta.icon && zip.file(meta.icon)) {
            return zip.file(meta.icon).async("base64").then(function (b64) {
              if (b64.length <= APP_ICON_MAX) iconData = "data:" + mimeOf(meta.icon) + ";base64," + b64;
            })["catch"](function () { return null; }).then(function () {
              return { entries: entries, total: total, iconData: iconData };
            });
          }
          return { entries: entries, total: total, iconData: "" };
        });
    }).then(function (ctx) {
      var entries = ctx.entries;
      var base = APPS_ROOT + "/" + meta.id;
      var i = 0;
      function writeOne() {
        if (i >= entries.length) return null;
        var en = entries[i++];
        pg("write", i, entries.length);
        return en.zf.async("base64").then(function (b64) {
          return vfs.put(base + "/" + en.rel, {
            data: b64, mime: mimeOf(en.rel), name: en.rel.split("/").pop()
          });
        }).then(writeOne);
      }
      return writeOne().then(function () { return ctx; });
    }).then(function (ctx) {
      pg("register", 1, 1);
      var now = Date.now();
      var ex = appsRegGet().filter(function (m) { return m.id === meta.id; })[0];
      var regItem = {
        id: meta.id, name: String(meta.name), version: String(meta.version || "1.0.0"),
        main: meta.main, icon: meta.icon || "📦", iconData: ctx.iconData || "",
        tone: meta.tone || "tone-blue",
        maximize: !!meta.maximize, desktop: meta.desktop !== false,
        desc: String(meta.desc || ""), author: String(meta.author || ""),
        size: ctx.total || 0,
        installedAt: ex ? ex.installedAt : now, updatedAt: now
      };
      var list = appsRegGet().filter(function (m) { return m.id !== regItem.id; });
      list.push(regItem);
      appsRegSet(list);
      // 更新场景：先清掉该应用的旧资源 blob 网址——否则 appAssetUrl 会一直返回
      // 指向旧代码/旧图片的网址，表现为“更新了还是旧界面”。
      clearPkgUrls(regItem.id);
      // 若该应用此前已注册（更新），先摘除旧实例定义，避免 registerApp 因
      // 内存里 def 仍在而误判为“无变化”跳过替换；窗口/根节点一并关闭，
      // 下次打开即执行新代码。
      var oldRec = apps[regItem.id];
      if (oldRec) {
        if (oldRec.win) { try { oldRec.win.close(); } catch (e) { } }
        if (oldRec.root && oldRec.root.parentNode) {
          try { oldRec.root.parentNode.removeChild(oldRec.root); } catch (e) { }
        }
        delete apps[regItem.id];
        appOrder = appOrder.filter(function (x) { return x !== regItem.id; });
      }
      return loadInstalledApp(regItem).then(function () {
        pg("done", 1, 1);
        return regItem;
      });
    });
  }

  function appUninstall(id) {
    var rec = apps[id];
    if (!rec || !rec.def.user) return Promise.reject(new Error("系统内置应用不可卸载"));
    if (rec.win) { try { rec.win.close(); } catch (e) { } }
    if (rec.root && rec.root.parentNode) {
      try { rec.root.parentNode.removeChild(rec.root); } catch (e) { }
    }
    delete apps[id];
    appOrder = appOrder.filter(function (x) { return x !== id; });
    clearPkgUrls(id);
    appsRegSet(appsRegGet().filter(function (m) { return m.id !== id; }));
    // 用户主动卸载：清掉预装记录，保证不会被开机预装逻辑再装回来
    // （即便仓库里之后出了该应用的新版本）。
    var pd = Store.get("nova2.preinstall.done", []);
    if (Array.isArray(pd)) {
      var pd2 = pd.filter(function (x) {
        return (typeof x === "string" ? x : (x && x.id)) !== id;
      });
      if (pd2.length !== pd.length) Store.set("nova2.preinstall.done", pd2);
    }
    return vfs.del(APPS_ROOT + "/" + id)["catch"](function () { return null; })
      .then(function () { if (desktopReady) renderDesktop(); return { ok: true }; });
  }

  // 应用运行时取包内资源的 blob 网址（应用内 iframe/图片等使用）
  // 释放某应用已生成的全部 blob 网址（更新/卸载时调用，防止旧代码残留）。
  function clearPkgUrls(id) {
    Object.keys(pkgUrlCache).forEach(function (k) {
      if (k.indexOf(id + "/") === 0) {
        try { URL.revokeObjectURL(pkgUrlCache[k]); } catch (e) { }
        delete pkgUrlCache[k];
      }
    });
  }

  function appAssetUrl(id, rel) {
    rel = String(rel || "").replace(/^\/+/, "");
    var key = id + "/" + rel;
    if (pkgUrlCache[key]) return Promise.resolve(pkgUrlCache[key]);
    return vfs.get(APPS_ROOT + "/" + id + "/" + rel).then(function (g) {
      if (!g || !g.ok) throw new Error((g && g.error) || "资源不存在");
      var blob = (g.text !== undefined && g.text !== null)
        ? new Blob([g.text], { type: g.mime || mimeOf(rel) })
        : b64ToBlob(g.data, g.mime || mimeOf(rel));
      var u = URL.createObjectURL(blob);
      pkgUrlCache[key] = u;
      return u;
    });
  }

  // 电脑端应用仓库目录（netCall 走 POST，端点同时接受 GET/POST）
  function appCatalog() {
    return netCall("sys/app-catalog", {}).then(function (r) {
      return (r && r.ok && r.apps) ? r.apps : [];
    });
  }
  function appDownload(file) {
    return netGetRaw("sys/app-package?f=" + encodeURIComponent(file));
  }

  var pkgApi = {
    install: appInstall,
    uninstall: appUninstall,
    installed: appsRegGet,
    catalog: appCatalog,
    download: appDownload,
    assetUrl: appAssetUrl,
    cmpVer: cmpVer,
    isUser: function (id) { return !!(apps[id] && apps[id].def.user); }
  };


  function winSize() {
    var w = window.innerWidth, hh = window.innerHeight;
    // 平板竖屏：接近全屏；桌面：适中窗口
    var ww = Math.min(w - 24, w < 700 ? w - 16 : 820);
    var wh = Math.min(hh - 96, w < 700 ? hh - 120 : 580);
    return { w: ww, h: wh };
  }

  function focusApp(id) {
    var rec = apps[id];
    if (!rec || !rec.win) return false;
    var wb = rec.win;
    try {
      if (wb.min) wb.restore();
      wb.focus();
    } catch (e) { }
    return true;
  }

  function openApp(id, arg) {
    var rec = apps[id];
    if (!rec) { nvLog("warn", "app", "openApp 未找到应用：" + id); return; }
    if (rec.win) {
      focusApp(id);
      if (rec.def.onArg) {
        try { rec.def.onArg(rec.root, arg); }
        catch (e) { nvErr("app", e, "应用 " + id + " onArg 异常"); }
      }
      return;
    }

    // 懒构造：应用根节点常驻隐藏容器，WinBox 以 mount 方式搬入，
    // 关闭时自动搬回原父节点 → 状态（输入内容/滚动位置）完整保留。
    if (!rec.root) {
      rec.root = h("div", "nv-app-root nv-wrap");
      rec.root.style.display = "none";
      rootsEl.appendChild(rec.root);
    }
    if (!rec.inited) {
      rec.inited = true;
      nvLog("info", "app", "首次构建应用：" + id);
      try { rec.def.open(rec.root, API_FOR_APP); }
      catch (e) { nvErr("app", e, "应用 " + id + " open/build 崩溃"); }
    }
    rec.root.style.display = "";

    var sz = winSize();
    var n = runningCount();
    var wb = new WinBox({
      title: rec.def.name,
      mount: rec.root,
      width: sz.w,
      height: sz.h,
      x: Math.max(8, Math.round((window.innerWidth - sz.w) / 2) + (n % 4) * 22 - 33),
      y: Math.max(52, Math.round((window.innerHeight - sz.h) / 2) - 24 + (n % 4) * 18),
      background: "#1a1d24",
      border: 0,
      onclose: function () {
        // WinBox close 会把 mount 的节点 unmount 回原父节点
        try { rec.root.dispatchEvent(new Event("nv-close")); } catch (e) { }
        rec.win = null;
        rec.root.style.display = "none";
        if (activeId === id) activeId = null;
        renderDock();
      },
      onfocus: function () { activeId = id; renderDock(); },
      onminimize: function () { if (activeId === id) activeId = null; renderDock(); },
      onrestore: function () { activeId = id; renderDock(); }
    });
    rec.win = wb;
    activeId = id;
    if (rec.def.maximize) { try { wb.maximize(); } catch (e) { } }
    if (rec.def.onArg) {
      try { rec.def.onArg(rec.root, arg); }
      catch (e) { nvErr("app", e, "应用 " + id + " 首次 onArg 异常"); }
    }
    // 每次打开（含关闭后复用根节点重开）都广播 nv-open：
    // 根节点只 build 一次，像远程浏览器这种在 nv-close 时释放连接的应用，
    // 需要靠它重新订阅，否则重开后永远是冻结的旧画面。
    try { rec.root.dispatchEvent(new Event("nv-open")); } catch (e) { }
    renderDock();
  }

  function closeApp(id) {
    var rec = apps[id];
    if (rec && rec.win) { try { rec.win.close(); } catch (e) { } }
  }

  function minimizeApp(id) {
    var rec = apps[id];
    if (rec && rec.win && !rec.win.min) { try { rec.win.minimize(); } catch (e) { } }
  }

  function runningList() {
    return appOrder.filter(function (id) { return !!apps[id].win; });
  }
  function runningCount() { return runningList().length; }

  /* 显示桌面：有未最小化窗口 → 全部最小化；否则 → 全部还原 */
  function showDesktop() {
    var ids = runningList();
    if (!ids.length) return;
    var anyVisible = ids.some(function (id) { return !apps[id].win.min; });
    if (anyVisible) {
      ids.forEach(function (id) {
        if (!apps[id].win.min) { try { apps[id].win.minimize(); } catch (e) { } }
      });
      activeId = null;
    } else {
      ids.forEach(function (id) { try { apps[id].win.restore(); } catch (e) { } });
      focusApp(ids[ids.length - 1]);
    }
    renderDock();
  }

  /* ---------------- 任务视图（运行中窗口的卡片总览） ---------------- */
  var taskViewEl = null;
  function openTaskView() {
    closeTaskView();
    var ov = h("div", "nv-taskview");
    var head = h("div", "nv-taskview-head");
    head.appendChild(h("span", "nv-taskview-title", "任务"));
    var headBtns = h("span", "nv-taskview-btns");
    var bCloseAll = h("button", "nv-tv-btn", "全部关闭");
    var bExit = h("button", "nv-tv-btn nv-tv-x", "✕");
    headBtns.appendChild(bCloseAll);
    headBtns.appendChild(bExit);
    head.appendChild(headBtns);
    ov.appendChild(head);

    var grid = h("div", "nv-taskview-grid");
    var ids = runningList();
    if (!ids.length) {
      grid.appendChild(h("div", "nv-taskview-empty", "没有运行中的应用"));
    }
    ids.forEach(function (id) {
      var rec = apps[id], def = rec.def;
      var card = h("div", "nv-tv-card");
      var top = h("div", "nv-tv-card-top");
      var ico = h("div", "nv-tv-card-icon " + (def.tone || "tone-ink"), def.icon || "·");
      var info = h("div", "nv-tv-card-info");
      info.appendChild(h("div", "nv-tv-card-name", def.name));
      info.appendChild(h("div", "nv-tv-card-sub", (rec.win && rec.win.min) ? "已最小化" : "运行中"));
      top.appendChild(ico);
      top.appendChild(info);
      var x = h("button", "nv-tv-card-x", "✕");
      top.appendChild(x);
      card.appendChild(top);
      card.appendChild(h("div", "nv-tv-card-bar"));
      card.addEventListener("click", function () {
        closeTaskView();
        focusApp(id);
      });
      x.addEventListener("click", function (e) {
        e.stopPropagation();
        closeApp(id);
        card.parentNode.removeChild(card);
        if (!runningList().length) setTimeout(closeTaskView, 150);
      });
      grid.appendChild(card);
    });
    ov.appendChild(grid);
    document.body.appendChild(ov);
    taskViewEl = ov;

    bExit.addEventListener("click", closeTaskView);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeTaskView(); });
    bCloseAll.addEventListener("click", function () {
      runningList().slice().forEach(closeApp);
      closeTaskView();
    });
  }
  function closeTaskView() {
    if (taskViewEl) {
      if (taskViewEl.parentNode) taskViewEl.parentNode.removeChild(taskViewEl);
      taskViewEl = null;
    }
  }

  /* ---------------- 系统级文件选择对话框 ----------------
   * pickFile({mode:"open"|"save", source, path, filter}) -> Promise<{source,path,name}|null>
   * 调起文件管理器并进入选择模式；用户点击文件或保存后 resolve。 */
  var _pickState = null;   // {resolve, opts}
  function pickFile(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      _pickState = { resolve: resolve, opts: opts };
      openApp("files", {
        __pick: true,
        source: opts.source || "fs",
        path: opts.path || "",
        mode: opts.mode || "open",
        filter: opts.filter || null,
        name: opts.name || ""
      });
    });
  }
  function _pickDone(result) {
    if (_pickState) {
      _pickState.resolve(result);
      _pickState = null;
    }
  }

  /* ---------------- 桌面 ---------------- */
  var desktopReady = false;
  var iconsEl, dockEl, rootsEl;

  function renderDesktop() {
    if (!iconsEl) return;
    clear(iconsEl);
    appOrder.forEach(function (id) {
      var def = apps[id].def;
      if (def.desktop === false) return;   // 清单声明不在桌面展示的应用
      var item = h("div", "nv-app");
      var ico = h("div", "nv-app-icon " + (def.tone || "tone-ink"));
      ico.textContent = def.icon || "·";
      var name = h("div", "nv-app-name", def.name);
      item.appendChild(ico);
      item.appendChild(name);
      item.addEventListener("click", function () { openApp(id); });
      iconsEl.appendChild(item);
    });
  }

  function renderDock() {
    if (!dockEl) return;
    clear(dockEl);
    var running = appOrder.filter(function (id) { return !!apps[id].win; });
    if (!running.length) {
      dockEl.appendChild(h("span", "nv-dock-empty", "打开的应用会出现在这里"));
      return;
    }
    running.forEach(function (id) {
      var rec = apps[id];
      var cls = "nv-dock-item running" + (id === activeId ? " active" : "");
      var d = h("div", cls, rec.def.icon || "·");
      d.title = rec.def.name;
      d.addEventListener("click", function () {
        if (id === activeId) { minimizeApp(id); }     // 点活动项 = 最小化
        else focusApp(id);
      });
      dockEl.appendChild(d);
    });
  }

  /* ---------------- 锁屏 ---------------- */
  var PIN_KEY = "nova2.pin";
  var pinInput = "";
  var pinMode = "check";        // check / set-new / set-again / set-old
  var pinStage = "";             // 暂存第一次输入的新 PIN

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function tickClock() {
    var d = new Date();
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    var week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    var dateStr = d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() +
                  "日 · 星期" + week;
    var c1 = document.getElementById("nv-clock");
    var c2 = document.getElementById("nv-date");
    var c3 = document.getElementById("nv-sb-clock");
    if (c1) c1.textContent = hm;
    if (c2) c2.textContent = dateStr;
    if (c3) c3.textContent = hm;
  }

  function enterDesktop() {
    document.getElementById("nv-lock").classList.add("nv-hidden");
    document.getElementById("nv-desktop").classList.remove("nv-hidden");
  }
  function lockScreen() {
    // 关闭所有窗口前先复位锁屏状态
    for (var k in apps) {
      if (apps[k].win) { try { apps[k].win.close(); } catch (e) { } }
    }
    pinInput = ""; pinMode = "check"; pinStage = "";
    renderPinDots();
    setPinTip("请输入锁屏密码");
    document.getElementById("nv-lock").classList.remove("nv-hidden");
    document.getElementById("nv-desktop").classList.add("nv-hidden");
  }

  function renderPinDots(err) {
    var dots = document.getElementById("nv-pin-dots").children;
    for (var i = 0; i < dots.length; i++) {
      dots[i].className = i < pinInput.length ? "on" : "";
      if (err) dots[i].className = "err";
    }
  }
  function setPinTip(t) {
    var el = document.getElementById("nv-pin-tip");
    if (el) el.textContent = t;
  }

  function pinDone() {
    var saved = Store.get(PIN_KEY, "");
    if (pinMode === "check") {
      if (pinInput === String(saved)) { enterDesktop(); }
      else {
        renderPinDots(true);
        setPinTip("密码错误");
        pinInput = "";
        setTimeout(function () { renderPinDots(); setPinTip("请输入锁屏密码"); }, 650);
      }
    } else if (pinMode === "set-old") {
      if (pinInput === String(saved)) {
        pinMode = "set-new"; pinInput = ""; renderPinDots(); setPinTip("请输入新密码（4 位数字）");
      } else {
        renderPinDots(true); setPinTip("原密码错误"); pinInput = "";
        setTimeout(function () { renderPinDots(); setPinTip("请输入原密码"); }, 650);
      }
    } else if (pinMode === "set-new") {
      pinStage = pinInput;
      pinMode = "set-again"; pinInput = ""; renderPinDots(); setPinTip("请再次输入新密码");
    } else if (pinMode === "set-again") {
      if (pinInput === pinStage) {
        Store.set(PIN_KEY, pinInput);
        toast("密码已设置");
        pinMode = "check"; pinInput = ""; renderPinDots(); setPinTip("请输入锁屏密码");
      } else {
        renderPinDots(true); setPinTip("两次输入不一致"); pinInput = "";
        pinMode = "set-new"; pinStage = "";
        setTimeout(function () { renderPinDots(); setPinTip("请输入新密码（4 位数字）"); }, 800);
      }
    }
  }

  function initLock() {
    var lockEl = document.getElementById("nv-lock");
    var hasPin = function () { return !!Store.get(PIN_KEY, ""); };

    function refreshLockMode() {
      document.getElementById("nv-pin-panel").classList.toggle("nv-hidden", !hasPin());
      document.getElementById("nv-enter-hint").classList.toggle("nv-hidden", hasPin());
    }
    refreshLockMode();

    // 无密码：点击锁屏任意处进入
    lockEl.addEventListener("click", function (e) {
      if (hasPin()) return;
      // 避免点到数字键盘留白区（无密码时键盘隐藏，实际不会触发）
      enterDesktop();
    });

    // 数字键盘
    var padEl = document.querySelector(".nv-pad");
    padEl.addEventListener("click", function (e) {
      var btn = e.target;
      if (btn.tagName !== "BUTTON") return;
      e.stopPropagation();
      var k = btn.getAttribute("data-k");
      if (k === "del") {
        pinInput = pinInput.slice(0, -1);
        renderPinDots();
      } else if (k === "set") {
        if (hasPin()) {
          pinMode = "set-old"; pinInput = ""; renderPinDots(); setPinTip("请输入原密码");
        } else {
          pinMode = "set-new"; pinInput = ""; renderPinDots(); setPinTip("请输入新密码（4 位数字）");
        }
      } else {
        if (pinInput.length >= 4) return;
        pinInput += k;
        renderPinDots();
        if (pinInput.length === 4) setTimeout(pinDone, 120);
      }
    });

    // 物理键盘也可输入（桌面调试）
    document.addEventListener("keydown", function (e) {
      if (lockEl.classList.contains("nv-hidden")) return;
      if (!hasPin() && (e.key === "Enter" || e.keyCode === 13)) { enterDesktop(); return; }
      if (/^[0-9]$/.test(e.key) && pinInput.length < 4) {
        pinInput += e.key; renderPinDots();
        if (pinInput.length === 4) setTimeout(pinDone, 120);
      } else if (e.key === "Backspace") {
        pinInput = pinInput.slice(0, -1); renderPinDots();
      }
    });

    // 每次重新锁屏都要同步模式（可能在设置后）
    window.addEventListener("focus", refreshLockMode);
  }

  /* ---------------- 对外 API（传给每个应用） ---------------- */
  var API_FOR_APP = null;   // boot 时构造

  /* ---------------- 启动 ---------------- */
  function boot() {
    if (!window.WinBox) {
      var w = document.createElement("div");
      w.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;z-index:999";
      w.textContent = "窗口组件加载失败，请检查网络后刷新";
      document.body.appendChild(w);
      return;
    }

    iconsEl = document.getElementById("nv-icons");
    dockEl = document.getElementById("nv-dock");
    rootsEl = h("div", "nv-app-roots");
    rootsEl.style.display = "none";
    document.body.appendChild(rootsEl);

    API_FOR_APP = {
      store: Store,
      api: api,
      net: {
        probe: netProbe,
        getWeb: netGetWeb,
        info: function () { return NET.info; },
        base: function () { return NET.base; },
        online: function () { return NET.online; },
        // 应用动态基址：换局域网/换设备后自动跟随电脑新 IP（详见 netFetch 注释）
        mountUrl: netUrl,        // 同步：mountUrl("novel/api/meta")
        resolveUrl: netResolve,  // 异步：确保探测完成后再拼地址（iframe.src 用）
        fetch: netFetch          // 带自动重探重试的 fetch，返回原生 Response
      },
      vfs: vfs,
      debug: debugApi,
      dev: devApi,        // 开发模式终端用：state()/exec(cmd,args) 全权限本地执行
      // 全系统统一日志：OS.log(tag, 任意内容..., level?) / OS.logerr(tag, err, 上下文)
      // 调试开关关时仅 console；开启后同时回传电脑 + 写离线空间 /日志/
      log: function (tag) {
        var args = Array.prototype.slice.call(arguments, 1);
        var level = "info";
        if (args.length && /^(debug|info|warn|error)$/.test(args[args.length - 1]))
          level = args.pop();
        dbgEmit(level, String(tag || "app"), args);
      },
      logerr: function (tag, err, ctx) { nvErr(String(tag || "app"), err, ctx); },
      tabletBackup: tabletBackup,
      musicBackup: musicBackup,
      pkg: pkgApi,
      ui: ui,
      dlg: dlg,
      toast: toast,
      on: on,
      emit: emit,
      h: h,
      clear: clear,
      openApp: openApp,
      closeApp: closeApp,
      minimizeApp: minimizeApp,
      apps: appList,
      running: runningList,
      lock: lockScreen,
      download: downloadName,
      b64ToBlob: b64ToBlob,
      mimeOf: mimeOf,
      readFileB64: readFileB64,
      pickFile: pickFile,
      _pickDone: _pickDone
    };
    window.OS = API_FOR_APP;
    window.OS.registerApp = registerApp;   // 扩展口：OS.registerApp({id,name,icon,open})

    applyWallpaper(ui.wallpaper());
    tickClock();
    setInterval(tickClock, 1000);
    initLock();
    if (Store.get(DEBUG_KEY, false)) dbgEnable();   // 调试模式：开机即回传日志

    var btnLock = document.getElementById("nv-sb-lock");
    if (btnLock) btnLock.addEventListener("click", lockScreen);
    var btnHome = document.getElementById("nv-sb-home");
    if (btnHome) btnHome.addEventListener("click", showDesktop);
    var btnTask = document.getElementById("nv-sb-task");
    if (btnTask) btnTask.addEventListener("click", openTaskView);
    // 返回专栏：通知父页面 loader 隐藏本 iframe（口令/连点可再唤起）
    var btnBack = document.getElementById("nv-sb-back");
    if (btnBack) btnBack.addEventListener("click", function () {
      try {
        var tk = window.__NVA_TOKEN__ || "";
        if (tk && window.parent && window.parent !== window) {
          window.parent.postMessage({ t: "nva-hide", k: tk }, "*");
        } else {
          toast("未在劫持环境中运行");
        }
      } catch (e) { }
    });
    netChanged();   // 初始网络灯（探测完成前为“离线/探测中”灰灯）

    desktopReady = true;
    renderDesktop();
    renderDock();
    window.OS.__booted = true;
    nvLog("info", "boot", "Tzy OS 桌面就绪，内置应用 " + Object.keys(apps).length + " 个");

    // 用户安装的 .tzyp 应用：桌面就绪后异步加载，不拖慢开机
    setTimeout(function () {
      try {
        loadInstalledApps().then(function () { return preinstallApps(); })
          ["catch"](function (e) { nvErr("boot", e, "开机应用加载链异常"); });
      } catch (e) { nvErr("boot", e, "触发开机应用加载失败"); }
    }, 300);

    // 后台预热：判定劫持同源 / 热点直连 / 完全离线，供文件应用即时使用
    setTimeout(function () { netProbe(false); }, 800);

    // 开发模式：桌面就绪后启动 DevLink 长轮询链（电脑可随时接入下发命令）
    setTimeout(devStart, 1200);
  }

  // nova.html 末尾会调用 OS.boot()；此处兜底（脚本顺序变化时也能启动）
  // 先暴露引导对象：应用脚本（os.js 之后加载）用 OS.registerApp 注册
  window.OS = { boot: boot, registerApp: registerApp, __booted: false };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (!window.OS.__booted) boot();
    });
  }

  window.__nvBoot = boot;
})();
