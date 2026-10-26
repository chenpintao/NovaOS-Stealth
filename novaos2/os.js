/* ============================================================
 * Tzy OS · 核心 os.js
 * 锁屏 → 桌面图标网格 + Dock → 窗口 → 应用注册 → 存储
 *
 * 约束：需兼容 Chrome 99 内核的平板浏览器与 HTTP 非安全源；
 *      仅用 ES6 语法；本地存储为明文。
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

  var mediaRegistry = [];
  var headset = { supported: false, connected: null, checkedAt: 0, probing: null };
  function registerMedia(el) {
    if (!el) return function () {};
    if (mediaRegistry.indexOf(el) < 0) mediaRegistry.push(el);
    return function () { var i = mediaRegistry.indexOf(el); if (i >= 0) mediaRegistry.splice(i, 1); };
  }
  function pauseAllMedia(reason) {
    var pageMedia = document.querySelectorAll("audio,video");
    for (var i = 0; i < pageMedia.length; i++) {
      if (mediaRegistry.indexOf(pageMedia[i]) < 0) mediaRegistry.push(pageMedia[i]);
    }
    mediaRegistry = mediaRegistry.filter(function (el) {
      if (!el || !el.isConnected) return false;
      try { el.pause(); } catch (e) { }
      return true;
    });
    emit("media-pause", { reason: reason || "manual" });
  }
  function detectHeadset() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) { headset.supported = false; return Promise.resolve(headset); }
    headset.supported = true;
    if (headset.probing) return headset.probing;
    headset.probing = navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var outputs = devices.filter(function (d) { return d.kind === "audiooutput"; });
      var previous = headset.connected;
      var hasLabels = outputs.some(function (d) { return !!String(d.label || "").trim(); });
      var connected = hasLabels ? false : null;
      outputs.forEach(function (d) { if (/headphone|headset|耳机|bluetooth|airpods|buds|earbud|usb audio/i.test(String(d.label || ""))) connected = true; });
      if (!outputs.length) connected = null;
      var changed = headset.connected !== connected;
      headset.connected = connected; headset.checkedAt = Date.now(); headset.probing = null;
      if (changed) emit("headset-change", { connected: connected, supported: true });
      if (previous === true && connected === false) pauseAllMedia("headset-removed");
      return headset;
    }, function () { headset.probing = null; return headset; });
    return headset.probing;
  }
  function initMediaMonitor() {
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", detectHeadset);
    detectHeadset(); setInterval(detectHeadset, 5000);
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

  /* ---------------- 界面设置（壁纸等，明文 localStorage） ----------------
   * 壁纸分两类：
   *   预设  以 .nv-wp-N 类名切换，颜色写在 CSS 里；
   *   自定义 以 .nv-wp-custom + 两个内联变量 --wp-a/--wp-b 实现任意双色渐变。
   * 两者都同时作用于锁屏与桌面，保证切换后观感一致。 */
  var UI_KEY = "nova2.ui";

  var OS_VERSION = "2.3.0";
  var OS_BUILD = "20261026";

  var WALLPAPERS = [
    { id: 0, name: "石墨" },
    { id: 1, name: "松墨" },
    { id: 2, name: "玄紫" },
    { id: 3, name: "铁灰" },
    { id: 4, name: "深棕" },
    { id: 5, name: "夜蓝" }
  ];
  var CUSTOM_ID = 100;          // 自定义壁纸在设置里的标识

  function uiGet() {
    var s = Store.get(UI_KEY, null);
    if (!s || typeof s !== "object") s = { wp: 0 };
    return s;
  }
  function uiSet(patch) {
    var s = uiGet();
    for (var k in patch) s[k] = patch[k];
    Store.set(UI_KEY, s);
  }

  function wallpaperTargets() {
    var out = [];
    var lock = document.getElementById("nv-lock");
    var desk = document.getElementById("nv-desktop");
    if (lock) out.push(lock);
    if (desk) out.push(desk);
    return out;
  }

  // 应用壁纸：idx 为预设 id，或 CUSTOM_ID 表示用渐变
  function applyWallpaper(idx, colors) {
    var targets = wallpaperTargets();
    var isCustom = (idx === CUSTOM_ID);
    var c = colors || uiGet().wpColors || null;

    targets.forEach(function (el) {
      WALLPAPERS.forEach(function (w) { el.classList.remove("nv-wp-" + w.id); });
      el.classList.remove("nv-wp-custom");
      el.classList.add(isCustom ? "nv-wp-custom" : ("nv-wp-" + idx));
      if (isCustom && c && c[0] && c[1]) {
        el.style.setProperty("--wp-a", c[0]);
        el.style.setProperty("--wp-b", c[1]);
      } else {
        el.style.removeProperty("--wp-a");
        el.style.removeProperty("--wp-b");
      }
    });
  }

  // 供设置页实时预览（不落盘）
  function previewWallpaper(idx, colors) {
    applyWallpaper(idx, colors);
  }

  /* ---------------- 存储占用探测 ----------------
   * 目标：分别算出三类占用，并尽量探测 WebView 整体用量。
   *   os       本 OS 自己写在 localStorage 的键（nova2.*）与 IndexedDB(nova2)
   *   host     被劫持页面的 localStorage / sessionStorage（同源可直接读，
   *            跨域只能靠父页面自己回报）
   *   vfs      离线空间文件本身（IndexedDB blobs，已含在 os 的 IDB 里，
   *            这里单独统计便于用户理解“我的文件占了多少”）
   *   origin   整个源的 navigator.storage.estimate()（浏览器给出的总用量）
   *   quota    浏览器配额
   * 说明：WebView 的“总体占用”（含 HTTP 磁盘缓存、其他站点数据）浏览器
   * 不提供精确接口，只能拿到本源的 usage/quota；其余以“无法精确读取”呈现，
   * 不做假数据。 */
  var STORAGE_ENV = null;   // 缓存一次环境探测结果

  function detectWebViewEnv() {
    var ua = navigator.userAgent || "";
    var env = { webview: false, name: "浏览器", standalone: false, ios: false };
    // 常见 WebView 标识
    if (/\bwv\b/.test(ua) && /Android/i.test(ua)) { env.webview = true; env.name = "Android WebView"; }
    else if (/Android/i.test(ua) && /Version\/\d+\.\d+/.test(ua) && !/Chrome\//.test(ua)) {
      env.webview = true; env.name = "Android 内置浏览器";
    }
    if (/iPhone|iPad|iPod/i.test(ua)) {
      env.ios = true;
      // iOS 上除 Safari 外基本都是 WKWebView
      if (!/Safari\//.test(ua)) { env.webview = true; env.name = "iOS WKWebView"; }
    }
    // 被注入环境特有标记：宿主页与本 iframe 同源，能读到注入期的键
    try {
      if (window.parent && window.parent !== window) env.webview = true;
    } catch (e) { /* 跨域访问，仍是嵌入式环境 */ env.webview = true; }
    try {
      env.standalone = !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
        !!navigator.standalone;
    } catch (e) { }
    return env;
  }

  function bytesOfString(str) {
    if (!str) return 0;
    try {
      if (window.TextEncoder) return new TextEncoder().encode(str).length;
    } catch (e) { }
    return str.length * 2;   // 退化估算：UTF-16
  }

  // 统计某个 storage 对象的总字节与条目数
  function measureStorage(store) {
    var out = { bytes: 0, count: 0 };
    if (!store) return out;
    try {
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        var v = store.getItem(k);
        out.bytes += bytesOfString(k) + bytesOfString(v);
        out.count++;
      }
    } catch (e) { }
    return out;
  }

  // 读父页面（被劫持页面）的存储；同源成功，跨域返回 null 表示不可读
  function measureHostPage() {
    try {
      var pw = window.parent;
      if (!pw || pw === window) return { sameOrigin: false, reason: "非嵌入环境" };
      var ls = pw.localStorage, ss = pw.sessionStorage;
      var a = measureStorage(ls), b = measureStorage(ss);
      return {
        sameOrigin: true,
        localStorage: a,
        sessionStorage: b,
        bytes: a.bytes + b.bytes,
        keys: a.count + b.count
      };
    } catch (e) {
      // 跨域：浏览器禁止读取，只能告知状态
      return { sameOrigin: false, reason: "跨域受限，无法读取宿主页面存储" };
    }
  }

  // 列出 IndexedDB 库名（佐证 OS 自身占用）。
  // 注意：非安全上下文（http）下 databases() 可能永不回调，
  // 因此必须加超时兜底，否则整个存储面板会卡在“统计中…”。
  function measureIDB() {
    return new Promise(function (resolve) {
      if (typeof indexedDB === "undefined" || !indexedDB.databases) {
        resolve({ supported: false, list: [] });
        return;
      }
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      var timer = setTimeout(function () { finish({ supported: false, list: [], timeout: true }); }, 1200);
      var rq;
      try { rq = indexedDB.databases(); }
      catch (e) { clearTimeout(timer); finish({ supported: false, list: [] }); return; }
      if (!rq || typeof rq !== "object") {
        clearTimeout(timer); finish({ supported: false, list: [] }); return;
      }
      rq.onsuccess = function () {
        clearTimeout(timer);
        finish({ supported: true, list: (rq.result || []).map(function (d) {
          return { name: d.name, version: d.version };
        }) });
      };
      rq.onerror = function () { clearTimeout(timer); finish({ supported: false, list: [] }); };
    });
  }

  // 汇总存储信息。vfsBytes 由调用方传入（离线空间统计较重，避免重复算）
  function collectStorage(mode, vfsInfo) {
    var env = STORAGE_ENV || (STORAGE_ENV = detectWebViewEnv());
    var osLS = measureStorage(localStorage);
    var host = measureHostPage();

    // 只统计 OS 自己的键，便于与宿主页面区分
    var osOnly = { bytes: 0, count: 0 };
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("nova2.") === 0) {
          osOnly.bytes += bytesOfString(k) + bytesOfString(localStorage.getItem(k));
          osOnly.count++;
        }
      }
    } catch (e) { }

    var base = {
      env: env,
      localStorage: osLS,
      osLocalStorage: osOnly,
      hostPage: host,
      vfs: vfsInfo || null,
      mode: mode || "storage"
    };

    var estimateP = Promise.resolve(null);
    if (navigator.storage && navigator.storage.estimate) {
      // 某些 WebView 里 estimate() 可能长期不返回，加超时避免面板卡死
      estimateP = Promise.race([
        navigator.storage.estimate().catch(function () { return null; }),
        new Promise(function (r) { setTimeout(function () { r(null); }, 1500); })
      ]);
    }

    return Promise.all([estimateP, measureIDB()]).then(function (parts) {
      var est = parts[0], idb = parts[1];
      base.originUsage = est && est.usage !== undefined ? est.usage : null;
      base.originQuota = est && est.quota !== undefined ? est.quota : null;
      if (est && est.usageDetails) base.usageDetails = est.usageDetails;
      base.indexedDB = idb;

      // 已归因的字节（能在页内精确算出的部分）
      var accounted = osOnly.bytes + (host.sameOrigin ? host.bytes : 0);
      base.accounted = accounted;
      // 未归因 = 浏览器源总用量 - 已精确算出的部分（含 IDB、HTTP 缓存等）
      base.unaccounted = (base.originUsage !== null)
        ? Math.max(0, base.originUsage - accounted) : null;
      if (vfsInfo && vfsInfo.bytes) {
        base.osTotal = osOnly.bytes + vfsInfo.bytes;
      } else {
        base.osTotal = osOnly.bytes;
      }
      return base;
    });
  }

  var ui = {
    wallpapers: function () { return WALLPAPERS.slice(); },
    customId: function () { return CUSTOM_ID; },
    wallpaper: function () {
      var s = uiGet();
      if (s.wp === CUSTOM_ID) return CUSTOM_ID;
      return WALLPAPERS[s.wp] ? s.wp : 0;
    },
    wallpaperColors: function () {
      var c = uiGet().wpColors;
      return (c && c[0] && c[1]) ? [c[0], c[1]] : ["#2b3446", "#0f1116"];
    },
    setWallpaper: function (idx, colors) {
      if (idx === CUSTOM_ID) {
        var a = (colors && colors[0]) || "#2b3446";
        var b = (colors && colors[1]) || "#0f1116";
        uiSet({ wp: CUSTOM_ID, wpColors: [a, b] });
        applyWallpaper(CUSTOM_ID, [a, b]);
        return;
      }
      if (!WALLPAPERS[idx]) return;
      uiSet({ wp: idx });
      applyWallpaper(idx);
    },
    preview: previewWallpaper,
    restore: function () {
      var idx = ui.wallpaper();
      applyWallpaper(idx, idx === CUSTOM_ID ? ui.wallpaperColors() : null);
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
  var PREFERRED_BASE_KEY = "nova2.preferredApiBase";
  // 在线开关（默认关闭，且每次启动 OS 都强制关闭）：
  // 关闭时完全不探测电脑服务、也不向劫持域名发任何请求，避免后端不存在时
  // 反复请求非法后缀在服务端日志里留下 404/405 噪音、引起管理员误解。
  // 用户在设置页手动打开后，本次运行内生效；下次启动自动关闭。
  var ONLINE_KEY = "nova2.online";
  var NET = {
    base: "", info: null, online: false, probing: null, waiters: [],
    probed: false, nextProbeAt: 0, generation: 0
  };

  function onlineEnabled() {
    return Store.get(ONLINE_KEY, false) === true;
  }
  function setOnlineEnabled(on) {
    Store.set(ONLINE_KEY, !!on);
    // 切换后清空探测缓存，下一次调用按新状态重新判定
    NET.generation++;
    NET.probing = null;
    NET.probed = false;
    NET.online = false;
    NET.base = "";
    NET.info = null;
    NET.nextProbeAt = 0;
    netChanged();
    if (on) netProbe(true);
  }

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

  function normalizePreferredBase(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    var match = raw.match(/^(?:(https?):\/\/)?((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?$/i);
    if (!match) return "";
    var octets = match[2].split(".");
    if (octets.some(function (octet) { return Number(octet) > 255; })) return "";
    if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) return "";
    var host = match[2] + (match[3] ? ":" + match[3] : "");
    return (match[1] ? match[1].toLowerCase() : "http") + "://" + host + MOUNT_PATH;
  }

  function pingAt(base) {
    return new Promise(function (resolve) {
      var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) { } } }, 900);
      // POST 优先；旧后端（或某些中间层）只允许 GET 会回 405 + HTML，
      // 此时再试一次 GET，避免被误判为“不可达”而整体进入离线模式。
      fetch(base + "api/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) {
        if (r.status === 405 || r.status === 404) {
          return fetch(base + "api/ping", {
            method: "GET", signal: ctrl ? ctrl.signal : undefined
          }).then(function (r2) { return r2.json(); }).catch(function () { return null; });
        }
        return r.json().catch(function () { return null; });
      }).then(function (j) {
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
    // 在线开关关闭：不探测、不请求。直接返回 null，所有 netCall/netFetch
    // 走各自的离线分支，界面显示离线空间可用。
    if (!onlineEnabled()) {
      NET.online = false;
      NET.probed = true;
      NET.base = "";
      NET.info = null;
      NET.probing = null;
      NET.nextProbeAt = 0;
      // 统一收尾：唤醒任何等待中的调用方，避免开关切换时挂起。
      var ws0 = NET.waiters; NET.waiters = [];
      ws0.forEach(function (fn) { try { fn(null); } catch (e) { } });
      return Promise.resolve(null);
    }
    if (NET.probing) return NET.probing;
    // An empty base is valid for a healthy same-origin mount, so cache the
    // complete probe result instead of using base as the cache sentinel.
    if (!force && NET.probed) {
      if (NET.online) return Promise.resolve({ base: NET.base, info: NET.info });
      if (NET.nextProbeAt && Date.now() < NET.nextProbeAt) return Promise.resolve(null);
      // Offline cooldown expired: allow a passive caller to discover that
      // the service has come back even when WebView emitted no `online` event.
    }
    if (force && NET.probed && NET.nextProbeAt && Date.now() < NET.nextProbeAt) {
      return Promise.resolve(null);
    }
    NET.probing = (function () {
      // 候选顺序：手动首选 → 同源（劫持在）→ 上次成功的直连 → 注入 IP → 固定热点网段
      var list = [];
      var preferred = normalizePreferredBase(Store.get(PREFERRED_BASE_KEY, ""));
      if (preferred) list.push(preferred);
      list.push("");
      var saved = Store.get(BASE_KEY, "");
      if (saved && list.indexOf(saved) < 0) list.push(saved);
      lanCandidates().forEach(function (b) { if (list.indexOf(b) < 0) list.push(b); });
      try { nvLog("debug", "net", "开始探测电脑服务，候选 " + list.length + " 个：" +
        list.map(function (b) { return b || "(同源)"; }).join(", ")); } catch (_) { }

      var generation = NET.generation;
      return list.reduce(function (chain, base) {
        return chain.then(function (found) {
          return found ? found : pingAt(base);
        });
      }, Promise.resolve(null)).then(function (res) {
        if (generation !== NET.generation) return null;
        NET.online = !!res;
        NET.probed = true;
        if (res) {
          NET.base = res.base;
          NET.info = res.info;
          NET.nextProbeAt = 0;
          Store.set(BASE_KEY, res.base);
          // Best effort: keep the origin's IndexedDB/VFS in persistent storage.
          // Re-check when the computer backend comes back because some WebViews
          // only grant persistence after the site has been used for a while.
          requestStoragePersistence("backend-online");
          scheduleVfsMaintenance("backend-online");
          try { nvLog("info", "net", "电脑服务就绪：" + (res.base || "(同源)") +
            " wan=" + (res.info.wan ? 1 : 0) + " answer=" + res.info.answer); } catch (_) { }
        } else {
          // Clear stale online state after a failed probe.  Otherwise every
          // caller keeps retrying an endpoint that is no longer reachable.
          NET.base = "";
          NET.info = null;
          NET.nextProbeAt = Date.now() + 5000;
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
    try { emit("net-change", { base: NET.base, info: NET.info, offline: !NET.online }); } catch (e) { }
  }

  window.addEventListener("offline", function () {
    NET.generation++;
    NET.probing = null;
    NET.online = false;
    NET.probed = true;
    NET.base = "";
    NET.info = null;
    NET.nextProbeAt = Date.now() + 5000;
    netChanged();
  });
  window.addEventListener("online", function () {
    if (!onlineEnabled()) return;   // 在线开关关闭时不因网络恢复而探测
    NET.nextProbeAt = 0;
    netProbe(true);
  });

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
    if (!onlineEnabled()) return Promise.resolve(OFFLINE);
    if (NET.probed && !NET.online && NET.nextProbeAt && Date.now() < NET.nextProbeAt) {
      return Promise.resolve(OFFLINE);
    }
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
    if (!onlineEnabled()) return Promise.resolve({ ok: false, offline: true, error: "在线功能已关闭" });
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
    // 返回绝对地址：调用方多为 iframe.src / 图片 / 下载链接，而应用入口脚本
    // 运行在 blob: 环境里，相对路径会以 blob 为基准解析成非法地址。
    function abs(base) {
      return base ? (base + r) : (location.origin + (MOUNT_PATH || "/") + r);
    }
    if (!onlineEnabled()) return Promise.resolve(null);
    if (NET.base) return Promise.resolve(abs(NET.base));
    return netProbe(false).then(function (p) {
      return abs(p ? p.base : (NET.base || ""));
    });
  }
  // 带自动重探重试的动态基址 fetch：返回原生 Response，可直接 .json()/.text()/.blob()
  function netFetch(rel, init) {
    if (!onlineEnabled()) return Promise.reject(new Error("在线功能已关闭"));
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
    return netProbe(false).then(function (p) {
      if (!p) return Promise.reject(new Error("offline"));
      return attempt(p.base, 0);
    });
  }

  // 解析 SSE 文本块，逐帧回调 {type, ...}
  function parseSseBuffer(text, emit) {
    var lines = String(text || "").split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // 兼容 CRLF：先去掉行尾 \r（否则 "data:{...}\r" 解析会失败）
      line = line.replace(/\r+$/, "");
      if (!line || line.charAt(0) === ":") continue;
      var t = line.replace(/^\s+/, "");
      if (t.indexOf("data:") === 0) t = t.slice(5);
      t = t.trim();
      if (!t || t === "[DONE]") continue;
      try { emit(JSON.parse(t)); } catch (e) { }
    }
  }

  var api = {
    fs: function (op, body) { return netCall("api/fs/" + op, body || {}); },
    ftp: function (body) { return netCall("api/ftp", body); },
    smb: function (body) { return netCall("api/smb", body); },
    ping: function () { return netCall("api/ping", {}); },
    systemInfo: function () { return netCall("api/system-info", {}); },
    // 系统维护（走挂载点同源端点，平板与电脑均可调用）
    sysUpdate: function () {
      return netCall("sys/update", {}).then(function (result) {
        if (!result || !result.ok) return result;
        return updateInstalledAppsFromRepo().then(function (appsResult) {
          result.appsUpdated = appsResult.updated;
          result.appErrors = appsResult.errors;
          return result;
        });
      });
    },
    sysLog: function (logs) { return netCall("sys/log", { logs: logs }); },
    // 对话式搜索：联网搜索 + 可选云端 AI 整理（电脑端 novacore/search_api.py）
    search: function (query, options) {
      return netCall("api/search", {
        query: String(query || ""),
        limit: (options && options.limit) || 8
      });
    },
    searchStatus: function () { return netCall("api/search/status", {}); },
    searchConfig: function (body) { return netCall("api/search/config", body || {}); },
    // 校验 AI 配置修改口令（后端常量，非强安全边界）
    searchVerify: function (password) {
      return netCall("api/search/verify", { password: String(password || "") });
    },
    // AI 对话（useSearch 决定是否先联网搜索）
    searchAsk: function (query, options) {
      options = options || {};
      return netCall("api/search/ask", {
        query: String(query || ""),
        use_search: options.useSearch !== false,
        limit: options.limit || 8
      });
    },
    // 流式问答：SSE 逐帧回调 onEvent(evt)，返回 cancel()
    searchStream: function (query, options, onEvent) {
      options = options || {};
      var cancelled = false;
      var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      var body = JSON.stringify({
        query: String(query || ""),
        mode: options.mode === "ai" ? "ai" : "search",
        use_search: options.useSearch !== false,
        limit: options.limit || 8
      });
      function emit(e) { if (!cancelled) { try { onEvent(e); } catch (x) { } } }
      netResolve("api/search/stream").then(function (url) {
        if (!url || cancelled) { emit({ type: "error", error: "电脑服务不可用（离线模式）" }); return; }
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          signal: ctrl ? ctrl.signal : undefined,
          cache: "no-store"
        }).then(function (resp) {
          if (!resp.ok) {
            return resp.text().then(function (t) {
              emit({ type: "error", error: "HTTP " + resp.status + "：" + String(t || "").slice(0, 200) });
            });
          }
          var reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
          if (!reader) {
            return resp.text().then(function (text) {
              parseSseBuffer(text, emit);
              emit({ type: "done", text: "" });
            });
          }
          var decoder = new TextDecoder("utf-8");
          var buf = "";
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) { parseSseBuffer(buf + "\n\n", emit); return; }
              if (cancelled) { try { reader.cancel(); } catch (e) { } return; }
              buf += decoder.decode(r.value, { stream: true });
              var idx;
              while ((idx = buf.indexOf("\n\n")) >= 0) {
                var chunk = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                parseSseBuffer(chunk + "\n\n", emit);
              }
              return pump();
            });
          }
          return pump();
        });
      })["catch"](function (err) {
        if (!cancelled) emit({ type: "error", error: (err && err.message) || "网络错误" });
      });
      return function cancel() {
        cancelled = true;
        try { if (ctrl) ctrl.abort(); } catch (e) { }
      };
    },
    // 内置应用静态站地址。
    // 关键：这些页面（lib/mojuan、lib/quickdraw、lib/phigros、lib/geogebra）本身
    // 随系统分发，是纯静态资源，离线也应能打开。
    //
    // 优先级（修复“缓存丢失后无法恢复”）：
    //   1) 在线且电脑可达：调用 sys/app-data-ensure 让电脑端校验落库副本
    //      （文件清单 + 大小），缺失/截断时整体重拷，再用 apps-data/<id>/
    //      的真实磁盘地址加载。这样浏览器缓存被清理/损坏时也能自愈。
    //   2) 离线或 ensure 失败：回退随系统分发的 lib/<id>/ 绝对地址，
    //      依靠浏览器磁盘缓存打开（保持离线可用）。
    libAppUrl: function (id, page) {
      page = String(page || "index.html").replace(/^\/+/, "");
      var sub = page.split("/").map(encodeURIComponent).join("/");
      var origin = location.origin + (MOUNT_PATH || "/");
      var libUrl = origin + "lib/" + encodeURIComponent(id) + "/" + sub;

      function abs(base) {
        return base ? (base + "apps-data/" + encodeURIComponent(id) + "/" + sub) : null;
      }
      if (!onlineEnabled()) return Promise.resolve(libUrl);
      return netCall("sys/app-data-ensure", { id: id }).then(function (r) {
        if (r && r.ok) {
          if (NET.base) return abs(NET.base) || libUrl;
          // 同源但探测已完成：用同源挂载路径
          return origin + "apps-data/" + encodeURIComponent(id) + "/" + sub;
        }
        return libUrl;
      }, function () { return libUrl; });
    },
    restoreCatalog: function () { return netCall("sys/restore-catalog", {}); },
    restorePackage: function (name) {
      return netGetRaw("sys/restore-package?f=" + encodeURIComponent(name));
    },
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
    enabled: false,   // 平板本次运行是否临时开启；刷新页面后恢复关闭
    on: false,        // 已与电脑 devmode 服务握手并轮询中
    off: false,       // 电脑端关闭了开发模式（config dev_mode=false）
    wait: 25,         // 长轮询单次挂起秒数（hello 返回）
    looping: false,   // 轮询链已启动（防重复）
    cmds: 0, ok: 0, fail: 0,         // 累计执行统计
    lastAt: 0,        // 最近一次收到命令的时间戳
    backoff: 0,       // 连续失败退避（ms）
    generation: 0, checking: false
  };

  function devState() {
    return { enabled: dev.enabled, on: dev.on, off: dev.off,
             checking: dev.checking, token: dev.token, wait: dev.wait,
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
        if (args.op === "-all" || args.all === true) return resetAllSystem();
        setTimeout(function () { location.reload(); }, 400); return { reloading: true };

      case "dbg":
        if (args.on) dbgEnable(); else dbgDisable();
        return { debug: !!args.on };

      case "emit":
        emit(String(args.evt || ""), args.data); return { ok: true };

      /* ---------- 维护命令组（终端 / 电脑 exec 共用） ----------
       * 目标：把“清理缓存、重置应用、强制刷新”这类需要连点设置在多个
       * 页面里找的动作，收敛成一串可复现的原子命令。
       * 每条都只做一件事并回传做了什么，便于终端里逐条核对。 */
      case "cache": {
        var cacheKeys = function () {
          var out = [];
          for (var ci = 0; ci < localStorage.length; ci++) out.push(localStorage.key(ci));
          return out.sort();
        };
        if (op === "keys" || !op) {
          var all = cacheKeys();
          var pref = String(args.prefix || "");
          var keys = pref ? all.filter(function (k) { return k.indexOf(pref) === 0; }) : all;
          return { count: keys.length, keys: keys, all: all.length };
        }
        if (op === "get") {
          var gk = String(args.key || "");
          var raw = localStorage.getItem(gk);
          var size = raw === null ? 0 : raw.length;
          return { key: gk, exists: raw !== null, bytes: size, value: raw };
        }
        if (op === "del") {
          var dk = String(args.key || "");
          if (!dk) return { error: "缺少 key" };
          var had = localStorage.getItem(dk) !== null;
          localStorage.removeItem(dk);
          return { ok: true, key: dk, existed: had };
        }
        if (op === "purge") {
          // 只删指定前缀，默认删 OS 自己的 nova2.*；不碰宿主页面/其它域键。
          // 缺省（undefined/null）才用 nova2.；显式传空串视为非法，
          // 不能悄悄回退成 nova2. —— 调用方以为在“清全部”，结果删了 OS 设置。
          var pfx = (args.prefix === undefined || args.prefix === null)
            ? "nova2." : String(args.prefix);
          if (!pfx) return { error: "prefix 不能为空（清全部请显式指定前缀）" };
          var victims = cacheKeys().filter(function (k) { return k.indexOf(pfx) === 0; });
          if (args.dry === true)
            return { ok: true, dry: true, prefix: pfx, wouldRemove: victims.length, keys: victims };
          victims.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { } });
          return { ok: true, prefix: pfx, removed: victims.length, keys: victims };
        }
        if (op === "idb") {
          // 列出 IndexedDB 库名与对象仓（离线空间 nova2、墨卷 NovelReader 等）
          if (typeof indexedDB === "undefined") return { error: "不支持 IndexedDB" };
          var idb = indexedDB;
          return new Promise(function (resolve) {
            var rq;
            try { rq = idb.databases ? idb.databases() : null; } catch (e) { rq = null; }
            if (!rq) { resolve({ note: "浏览器不支持 databases() 枚举", keys: [] }); return; }
            rq.onsuccess = function () {
              resolve({ databases: (rq.result || []).map(function (d) {
                return { name: d.name, version: d.version };
              }) });
            };
            rq.onerror = function () { resolve({ error: String(rq.error) }); };
          });
        }
        if (op === "idb-drop") {
          // 删除整库（应用数据/离线空间）；默认拒绝删 OS 自己的 nova2，
          // 必须显式 force:true —— 那是用户文件，不是“缓存”。
          var dbName = String(args.name || "");
          if (!dbName) return { error: "缺少 name" };
          if (dbName === IDB_DB && args.force !== true)
            return { error: "nova2 是离线空间（用户文件），如确要删除请加 force:true" };
          return new Promise(function (resolve) {
            var rq = indexedDB.deleteDatabase(dbName);
            rq.onsuccess = function () { resolve({ ok: true, dropped: dbName }); };
            rq.onerror = function () { resolve({ error: String(rq.error) }); };
            rq.onblocked = function () { resolve({ ok: false, error: "被占用，请先关闭相关应用再重试", db: dbName }); };
          });
        }
        if (op === "sys") {
          // 系统级缓存清理：Service Worker 注册 + CacheStorage（若有）
          var done = { sw: 0, caches: [] };
          var jobs = [];
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
              done.sw = regs.length;
              return Promise.all(regs.map(function (r) { return r.unregister(); }));
            })["catch"](function () { }));
          }
          if (typeof caches !== "undefined" && caches.keys) {
            jobs.push(caches.keys().then(function (names) {
              done.caches = names;
              if (args.dry === true) return null;
              return Promise.all(names.map(function (n) { return caches["delete"](n); }));
            })["catch"](function () { }));
          }
          return Promise.all(jobs).then(function () { return done; });
        }
        return { error: "cache 未知 op：" + op + "（keys/get/del/purge/idb/idb-drop/sys）" };
      }

      case "appreset": {
        // 重置单个/全部应用：关窗 + 卸根节点 + 清 blob 网址 + 重建
        // （builtin 重建同一份代码；user 应用从离线空间重新加载注册表项）
        if (op === "list") {
          return { running: runningList(), apps: appList().map(function (a) {
            return { id: a.id, name: a.name, builtin: a.builtin, version: a.version };
          }) };
        }
        if (op === "asset") {
          // 重新把离线空间里的应用文件同步到电脑 apps_data/<id>/（落盘副本自愈）
          var aid = String(args.id || "");
          if (!aid) return { error: "缺少 id" };
          return rebuildAppDataFromVfs(aid).then(function (ok) {
            return { ok: ok, id: aid, action: ok ? "已从离线空间重写电脑端副本" : "离线空间无该应用文件或无电脑端" };
          });
        }
        var targets = [];
        if (args.id) targets = [String(args.id)];
        else targets = runningList();
        // 默认跳过终端自己：重建自己会把正在输出结果的窗口关掉，
        // 用户看到的是“点了按钮结果界面没了”。需要时用 self:true 强制。
        var selfId = "devterm";
        if (args.self !== true) {
          targets = targets.filter(function (id) { return id !== selfId; });
        }
        if (!targets.length) return { ok: true, reset: [],
          note: args.id ? "应用未在运行" : "没有需要重建的应用（终端自身已跳过）" };
        var report = [];
        targets.forEach(function (rid) {
          var rec = apps[rid];
          if (!rec) { report.push({ id: rid, error: "未注册" }); return; }
          // 上面是 var（函数作用域），异步回调里必须用局部副本，
          // 否则闭包拿到的是循环最后一个 rec，失败回退会恢复错的应用。
          var savedDef = rec.def;
          var isUser = !!savedDef.user;
          var meta = isUser
            ? appsRegGet().filter(function (m) { return m.id === rid; })[0] : null;
          try {
            if (rec.win) rec.win.close();
          } catch (e) { }
          try {
            if (rec.root) rec.root.dispatchEvent(new Event("nv-destroy"));
          } catch (e) { }
          try {
            if (rec.root && rec.root.parentNode) rec.root.parentNode.removeChild(rec.root);
          } catch (e) { }
          clearPkgUrls(rid);
          delete apps[rid];
          appOrder = appOrder.filter(function (x) { return x !== rid; });
          report.push({ id: rid, builtin: !isUser, rebuilt: isUser ? "loading" : "restored" });
          // 内置应用没有离线空间副本，重建 = 把原定义放回注册表（保留 desktop/
          // builtin 等标记）。此前直接 delete 不恢复，会把内置应用从桌面和
          // 应用清单里永久抹掉，只能刷新页面才能回来。
          if (!isUser) {
            var again = { def: savedDef, root: null, inited: false, win: null,
              healthMisses: 0, healthPending: false, healthCrashed: false, lastArg: null };
            apps[rid] = again;
            if (appOrder.indexOf(rid) < 0) appOrder.push(rid);
            if (desktopReady) renderDesktop();
            if (args.open === true) { try { openApp(rid); } catch (e) { } }
            return;
          }
          var boot = meta ? loadInstalledApp(meta) : Promise.resolve(true);
          boot.then(function () {
            if (args.open === true) { try { openApp(rid); } catch (e) { } }
          }, function (e) {
            nvErr("app", e, "appreset " + rid + " 重载失败");
            // 重载失败时必须把占位记录放回去：否则该应用从 apps 消失，
            // 桌面图标和续期重试都会跟着丢，只能重装才能恢复。
            if (!apps[rid]) {
              apps[rid] = { def: savedDef, root: null, inited: false, win: null,
                healthMisses: 0, healthPending: false, healthCrashed: false, lastArg: null };
              if (appOrder.indexOf(rid) < 0) appOrder.push(rid);
              if (desktopReady) renderDesktop();
            }
          });
        });
        return { ok: true, reset: report };
      }

      case "netreset": {
        // 清掉所有“后端地址”记忆，重新探测电脑服务（换网段/IP 后必备）
        Store.remove(BASE_KEY);
        Store.remove(PREFERRED_BASE_KEY);
        try { localStorage.removeItem("nova2.frameBase"); } catch (e) { }
        NET.base = "";
        NET.info = null;
        NET.probed = false;
        NET.online = false;
        NET.generation++;
        NET.probing = null;
        NET.nextProbeAt = 0;
        netChanged();
        return Promise.resolve(netProbe(true)).then(function (r) {
          return { ok: !!(r && r.base !== undefined), base: NET.base || "", online: NET.online,
            info: NET.info, cleared: [BASE_KEY, PREFERRED_BASE_KEY, "nova2.frameBase"] };
        });
      }

      case "sysreset": {
        // 比 reload -all 更彻底：额外清断点/地址记忆；默认保留软件与个人文件。
        // keep=apps,vfs,pin,ui 指定要保留的组；wipe:true 才连注册表一起清。
        // 默认保留 ui：壁纸/排版是用户能直接看见的设置，重置系统不该顺手抹掉。
        var keep = String(args.keep || "apps,vfs,pin,ui");
        var keepHas = function (n) { return keep.split(",").indexOf(n) >= 0; };
        var closed = [];
        appOrder.slice().forEach(function (id) {
          var rec = apps[id];
          if (!rec) return;
          try { if (rec.win) rec.win.close(); } catch (e) { }
          try { if (rec.root) rec.root.dispatchEvent(new Event("nv-destroy")); } catch (e) { }
          try { if (rec.root && rec.root.parentNode) rec.root.parentNode.removeChild(rec.root); } catch (e) { }
          clearPkgUrls(id);
          closed.push(id);
        });
        var wiped = [];
        if (args.wipe === true && !keepHas("apps")) {
          Store.remove(APPS_KEY);
          Store.remove("nova2.appdata");
          Store.remove("nova2.preinstall.done");
          wiped.push(APPS_KEY, "nova2.appdata", "nova2.preinstall.done");
        }
        if (!keepHas("ui")) { Store.remove(UI_KEY); wiped.push(UI_KEY); }
        if (!keepHas("pin")) Store.remove(PIN_KEY);
        [BASE_KEY, PREFERRED_BASE_KEY, DEV_KEY, DEBUG_KEY,
          "nova2.lock", "nova2.net", "nova2.settings"].forEach(function (k) {
          Store.remove(k); wiped.push(k);
        });
        try { localStorage.removeItem("nova2.frameBase"); } catch (e) { }
        apps = {}; appOrder = []; activeId = null;
        // 必须真的重载：apps 清空后当前会话就是一张空桌面，内置应用要等
        // 页面重新加载时才会由 nova.html 的脚本重新注册。之前只返回
        // willReload 标记却没执行，用户会停在“什么都没有”的桌面上。
        // now:false 用于“只清配置、暂不刷新”（例如组合其它命令前）。
        if (args.now === false) {
          return { ok: true, closed: closed, wiped: wiped, keep: keep,
            reloading: false, willReload: true,
            note: "配置已清；未刷新页面，请自行 reload 或重开 OS" };
        }
        setTimeout(function () {
          var url = location.href.split("#")[0].split("?")[0] + "?_rs=" + Date.now();
          try { location.replace(url); } catch (e) { location.href = url; }
        }, 350);
        return { ok: true, closed: closed, wiped: wiped, keep: keep,
          reloading: true, willReload: true };
      }

      case "forcerefresh": {
        // 强制刷新 OS 页面：两段式
        //   1) 平板上让电脑端刷新 ?v=（POST sys/update）
        //   2) 立即 reload（带时间戳绕 HTTP 缓存）
        // args.hard 为 true 时，先用 cache:reload 让浏览器跳过内存缓存。
        var steps = [];
        var bump = args.bump === false ? Promise.resolve(null) : netCall("sys/update", {})
          .then(function (r) { steps.push({ step: "bump", ok: !!(r && r.ok), files: r && r.changed }); return r; },
                function (e) { steps.push({ step: "bump", ok: false, error: String(e && e.message || e) }); });
        return bump.then(function () {
          if (args.now === false) return { ok: true, steps: steps, note: "未刷新页面，仅刷新版本号" };
          var url = location.href.split("#")[0].split("?")[0] + "?_r=" + Date.now();
          setTimeout(function () {
            try { location.replace(url); } catch (e) { location.href = url; }
          }, 300);
          return { ok: true, steps: steps, reloading: true, url: url };
        });
      }

      case "dump": {
        // 一次性导出修复用的快照：系统信息 + 存储键 + 已装应用 + 后端状态
        return Promise.resolve(
          navigator.storage && navigator.storage.estimate
            ? navigator.storage.estimate() : null
        ).then(function (st) {
          var keys = [];
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            var v = localStorage.getItem(k);
            keys.push({ key: k, bytes: v ? v.length : 0 });
          }
          keys.sort(function (a, b) { return b.bytes - a.bytes; });
          return {
            ua: navigator.userAgent,
            url: location.href,
            net: { base: NET.base, online: NET.online, probed: NET.probed, info: NET.info },
            apps: appList(), running: runningList(),
            installed: appsRegGet().map(function (m) { return m.id + "@" + m.version; }),
            storage: st,
            localStorage: { count: keys.length, keys: keys },
            dev: devState()
          };
        });
      }

      case "hostpage": {
        // 宿主（被劫持的平台页面）侧操作。bridge/loader 与 OS 同源但
        // OS 在闭合 Shadow DOM 的 iframe 里，只能通过 postMessage 请求：
        //   freeze / thaw  冻结/恢复宿主页面滚动与动画（省电、防误触）
        //   reload         让 loader 重建整个 OS iframe（顶层自愈）
        //   hide / show    主动隐藏/显示 OS
        var act = String(args.act || args.op || "");
        var allowed = { freeze: 1, thaw: 1, reload: 1, hide: 1, show: 1 };
        if (!allowed[act]) return { error: "hostpage 未知 act：" + act + "（freeze/thaw/reload/hide/show）" };
        // loader 只认 nva-* 且带握手 token 的消息（见 loader.js message 分支），
        // 这里沿用同一套协议，避免宿主页面里其它脚本伪造维护指令。
        // token 由 bridge 握手时写入 window.__NVA_TOKEN__。
        var tok = "";
        try { tok = String(window.__NVA_TOKEN__ || ""); } catch (e) { tok = ""; }
        var sent = false;
        try {
          if (window.parent && window.parent !== window)
            window.parent.postMessage({ t: "nva-host-" + act, k: tok, from: "nova-os" }, "*");
          sent = true;
        } catch (e) { sent = false; }
        if (act === "reload" && args.local !== false) {
          setTimeout(function () {
            var url = location.href.split("#")[0].split("?")[0] + "?recovery=" + Date.now();
            try { location.replace(url); } catch (e) { location.href = url; }
          }, 300);
        }
        return { ok: sent, act: act, note: sent ? "已向宿主页面派发指令" : "当前不在宿主 iframe 中" };
      }

      default:
        return { error: "未知命令：" + cmd + "（ping/info/eval/storage/vfs/app/toast/lock/reload/dbg/emit/cache/appreset/netreset/sysreset/forcerefresh/dump/hostpage）" };
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

  function devCall(kind, body) {
    // DevLink 是主动诊断入口，必须绕过普通请求的短暂离线冷却并立刻重探。
    NET.nextProbeAt = 0;
    return netCall("sys/dev-" + kind, body);
  }

  /* 轮询主循环（单链）：无 token → hello 握手；有 token → 长轮询挂起。
   * 断网指数退避（2s→15s）；电脑端关闭开发模式 → 60s 后再试。 */
  function devLoop(generation) {
    if (!dev.enabled || generation !== dev.generation) {
      dev.looping = false;
      return;
    }
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
      if (!dev.enabled || generation !== dev.generation) return later(0);
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
    function later(ms) {
      if (!dev.enabled || generation !== dev.generation) {
        dev.looping = false;
        return;
      }
      setTimeout(function () { devLoop(generation); }, ms);
    }
  }

  function devStart() {
    if (!dev.enabled || dev.looping) return;
    dev.looping = true;
    dev.generation++;
    devLoop(dev.generation);
  }

  function devWaitOnline(timeout) {
    var end = Date.now() + (timeout || 8000);
    return new Promise(function (resolve) {
      function check() {
        if (!dev.enabled) { resolve({ ok: false, error: "DevLink 已关闭" }); return; }
        if (dev.on) { resolve({ ok: true, pong: true, state: devState() }); return; }
        if (Date.now() >= end) {
          resolve({ ok: false, error: dev.off ? "电脑端未允许 DevLink" : "DevLink 生效检测超时" });
          return;
        }
        setTimeout(check, 200);
      }
      check();
    });
  }

  function devEnable() {
    if (dev.enabled && dev.on) return Promise.resolve({ ok: true, pong: true, state: devState() });
    dev.checking = true;
    devChanged();
    return devCall("control", { enabled: true }).then(function (r) {
      if (!r || !r.ok || !r.enabled) throw new Error((r && r.error) || "电脑端未能开启 DevLink");
      dev.enabled = true;
      dev.off = false;
      dev.token = "";
      Store.remove(DEV_KEY);
      devStart();
      return devWaitOnline(8000);
    }).then(function (r) {
      dev.checking = false;
      devChanged();
      return r;
    }, function (err) {
      dev.enabled = false;
      dev.on = false;
      dev.checking = false;
      devChanged();
      return { ok: false, error: (err && err.message) || String(err) };
    });
  }

  function devDisable() {
    dev.enabled = false;
    dev.on = false;
    dev.off = false;
    dev.checking = false;
    dev.generation++;
    dev.looping = false;
    dev.token = "";
    Store.remove(DEV_KEY);
    devChanged();
    return devCall("control", { enabled: false }).then(function (r) {
      return r && r.ok ? r : { ok: false, error: (r && r.error) || "关闭失败" };
    });
  }

  // 供 devterm 终端应用本地复用（与电脑下发走同一条全权限路由）
  var devApi = {
    state: devState,
    enable: devEnable,
    disable: devDisable,
    check: function () {
      if (!dev.enabled) return Promise.resolve({ ok: false, error: "请先开启 DevLink" });
      if (!dev.looping) devStart();
      return devWaitOnline(5000);
    },
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
    if (!onlineEnabled()) return Promise.resolve({ ok: false, offline: true, error: "在线功能已关闭" });
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

  /* ---------- VFS transparent compression + eviction protection ----------
   * Logical metadata (`size`) always remains the original byte count, while
   * `storedSize` records physical blob bytes.  Existing callers therefore see
   * exactly the same files and quota accounting can expose both figures.
   *
   * CompressionStream is available in the tablet's Chromium 99 WebView.  On
   * older engines every helper falls back to the original Blob; no database
   * schema upgrade or destructive bulk rewrite is required. */
  var VFS_GZIP = "gzip-v1";
  var VFS_COMPRESS_MIN = 8 * 1024;
  var vfsMaint = { db: null, timer: 0, running: false, persistAt: 0, persistP: null };

  function vfsTextLike(f, path) {
    var name = String((f && f.name) || String(path || "").split("/").pop() || "");
    var mime = String((f && f.mime) || "").split(";", 1)[0].toLowerCase();
    return (f && f.kind === "text") || /^text\//.test(mime) ||
      /\.(txt|md|markdown|log|csv|json|js|css|html?|xml|yaml|yml|ini|conf|cfg)$/i.test(name);
  }

  function gzipBlob(blob) {
    if (!blob || blob.size < VFS_COMPRESS_MIN || typeof CompressionStream === "undefined" ||
        typeof DecompressionStream === "undefined" || !blob.stream) {
      return Promise.resolve({ blob: blob, encoding: "identity-v1" });
    }
    try {
      var stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
      return new Response(stream).blob().then(function (packed) {
        // Require a meaningful saving; tiny gains are not worth decode overhead.
        if (!packed || packed.size >= blob.size * 0.90) {
          return { blob: blob, encoding: "identity-v1" };
        }
        return { blob: packed, encoding: VFS_GZIP };
      }, function () { return { blob: blob, encoding: "identity-v1" }; });
    } catch (e) {
      return Promise.resolve({ blob: blob, encoding: "identity-v1" });
    }
  }

  function unpackBlob(blob, encoding, mime) {
    if (encoding !== VFS_GZIP) return Promise.resolve(blob);
    if (typeof DecompressionStream === "undefined" || !blob || !blob.stream) {
      return Promise.reject(new Error("当前浏览器不支持读取压缩的离线文件"));
    }
    try {
      var stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(stream).blob().then(function (raw) {
        return raw.slice(0, raw.size, mime || "application/octet-stream");
      });
    } catch (e) { return Promise.reject(e); }
  }

  function requestStoragePersistence(reason) {
    var st = navigator.storage;
    if (!st || !st.persist || !st.persisted) return Promise.resolve(false);
    var now = Date.now();
    if (vfsMaint.persistP) return vfsMaint.persistP;
    if (now - vfsMaint.persistAt < 30 * 60 * 1000) return Promise.resolve(false);
    vfsMaint.persistAt = now;
    vfsMaint.persistP = st.persisted().then(function (yes) {
      return yes ? true : st.persist().catch(function () { return false; });
    }).then(function (yes) {
      try {
        Store.set("nova2.storage.persistence", { persistent: !!yes, checkedAt: Date.now(), reason: reason || "" });
        nvLog(yes ? "info" : "warn", "storage", yes ?
          "离线数据已获得持久存储保护" : "浏览器未授予持久存储，将继续安全使用普通存储");
      } catch (_) { }
      return !!yes;
    }, function () { return false; }).then(function (yes) {
      vfsMaint.persistP = null;
      return yes;
    });
    return vfsMaint.persistP;
  }

  /* ---------- 引擎一：localStorage 降级实现（容量约 5MB，IDB 不可用时使用） ---------- */
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
              // Older app versions could store a text payload through the binary
              // `data` field.  Keep those files readable by recognising their MIME
              // type/name as text even when the persisted kind says "bin".
              var asText = vfsTextLike(f, path);
              unpackBlob(r.result || new Blob([]), f.encoding, f.mime).then(function (raw) {
                return readBlobAs(raw, asText);
              }).then(function (val) {
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
        var isText = rec.text !== undefined && rec.text !== null;
        var rawBlob, logicalSize, kind;
        if (isText) {
          var text = String(rec.text);
          rawBlob = new Blob([text], { type: "text/plain;charset=utf-8" });
          logicalSize = textBytes(text);
          kind = "text";
        } else {
          rawBlob = rec.data ? b64ToBlob(rec.data, rec.mime || "application/octet-stream") : new Blob([]);
          logicalSize = rec.data ? Math.floor(rec.data.replace(/=+$/, "").length * 3 / 4) : 0;
          kind = "bin";
        }
        var packedP = isText ? gzipBlob(rawBlob) : Promise.resolve({ blob: rawBlob, encoding: "identity-v1" });
        return packedP.then(function (packed) { return idbMutate(db, function (m, bs) {
          var acc = "";
          vfsParent(path).split("/").forEach(function (seg) {
            if (!seg) return;
            acc += "/" + seg;
            m.dirs[acc] = 1;
          });
          m.files[path] = {
            name: rec.name || path.split("/").pop(),
            mime: rec.mime || "application/octet-stream",
            size: logicalSize, storedSize: packed.blob.size,
            mtime: Date.now(), kind: kind, encoding: packed.encoding
          };
          bs.put(packed.blob, path);
        }); }).catch(function (e) { return quotaError(e); });
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
          var nFiles = 0, nDirs = 0, sum = 0, stored = 0, compressed = 0, k, d;
          for (k in m.files) {
            nFiles++; sum += m.files[k].size || 0;
            stored += m.files[k].storedSize == null ? (m.files[k].size || 0) : m.files[k].storedSize;
            if (m.files[k].encoding === VFS_GZIP) compressed++;
          }
          for (d in m.dirs) if (d !== "") nDirs++;
          var est = navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : null;
          // `bytes` is the VFS' physical footprint.  `logicalBytes` remains the
          // uncompressed file total for file properties and compression stats.
          // navigator.storage.usage covers the whole origin (HTTP cache, app
          // packages and other IndexedDB data), so it must not be presented as
          // this VFS' usage.
          var fallback = { ok: true, bytes: stored, logicalBytes: sum, storedBytes: stored,
            savedBytes: Math.max(0, sum - stored), compressedFiles: compressed,
            files: nFiles, dirs: nDirs, max: 256 * 1024 * 1024 };
          if (!est) return fallback;
          return est.then(function (q) {
            return {
              ok: true,
              bytes: stored,
              logicalBytes: sum, storedBytes: stored,
              savedBytes: Math.max(0, sum - stored), compressedFiles: compressed,
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

  // Convert at most one legacy text Blob per maintenance pass.  Compression is
  // prepared outside IDB transactions, then blob + metadata are swapped in one
  // transaction only if the file has not changed meanwhile.
  function compressOneLegacy(db) {
    return idbGetMeta(db).then(function (m) {
      var path = "", meta = null;
      for (var k in m.files) {
        var f = m.files[k];
        if (f && !f.encoding && (f.size || 0) >= VFS_COMPRESS_MIN &&
            (f.size || 0) <= 32 * 1024 * 1024 && vfsTextLike(f, k) &&
            (!meta || (f.size || 0) > (meta.size || 0))) {
          path = k; meta = f;
        }
      }
      if (!path) return { ok: true, idle: true };
      return new Promise(function (resolve, reject) {
        var r = db.transaction(["blobs"], "readonly").objectStore("blobs").get(path);
        r.onsuccess = function () { resolve(r.result || new Blob([])); };
        r.onerror = function () { reject(r.error || new Error("读取待压缩文件失败")); };
      }).then(function (raw) {
        return gzipBlob(raw).then(function (packed) {
          return idbMutate(db, function (current, bs) {
            var f = current.files[path];
            if (!f || f.encoding || f.mtime !== meta.mtime || f.size !== meta.size) {
              return { ok: true, skipped: true };
            }
            f.encoding = packed.encoding;
            f.storedSize = packed.blob.size;
            if (packed.encoding === VFS_GZIP) bs.put(packed.blob, path);
            return { ok: true, path: path, compressed: packed.encoding === VFS_GZIP,
              before: raw.size, after: packed.blob.size };
          });
        });
      });
    }).catch(function (e) {
      try { nvLog("warn", "storage", "后台压缩跳过：" + (e && e.message ? e.message : e)); } catch (_) { }
      return { ok: false, error: String(e && e.message ? e.message : e) };
    });
  }

  function scheduleVfsMaintenance(reason) {
    requestStoragePersistence(reason || "maintenance");
    if (!vfsMaint.db || vfsMaint.running || vfsMaint.timer) return;
    vfsMaint.timer = setTimeout(function () {
      vfsMaint.timer = 0;
      vfsMaint.running = true;
      compressOneLegacy(vfsMaint.db).then(function (r) {
        if (r && r.compressed) {
          try { nvLog("info", "storage", "后台压缩 " + r.path + "：" + r.before + " → " + r.after + " 字节"); } catch (_) { }
        }
      }).then(function () {
        vfsMaint.running = false;
        // A single file per pass keeps startup responsive and makes migration
        // naturally resumable after reload/power loss.
        vfsMaint.timer = setTimeout(function () {
          vfsMaint.timer = 0; scheduleVfsMaintenance("periodic");
        }, 30 * 60 * 1000);
      }, function () { vfsMaint.running = false; });
    }, 2000);
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
    vfsMaint.db = db;
    return migrateLegacy(db).then(function () {
      scheduleVfsMaintenance("startup");
      return makeIDBImpl(db);
    });
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
      apps[def.id] = { def: def, root: null, inited: false, win: null,
        healthMisses: 0, healthPending: false, healthCrashed: false, lastArg: null };
      if (desktopReady) renderDesktop();
      return;
    }
    if (!def.user) def.builtin = true;
    apps[def.id] = { def: def, root: null, inited: false, win: null,
      healthMisses: 0, healthPending: false, healthCrashed: false, lastArg: null };
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

  // 注入包内脚本（Blob 网址，全局作用域）。依赖脚本必须先于入口串行执行。
  function loadInstalledScript(meta, file, isMain) {
    var scriptPath = APPS_ROOT + "/" + meta.id + "/" + file;
    return vfs.get(scriptPath).then(function (g) {
      if (!g || !g.ok) throw new Error((g && g.error) || "入口缺失");
      var code = (g.text !== undefined && g.text !== null) ? g.text : b64ToText(g.data);
      var url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      if (isMain) loadingPkgId = meta.id;
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.onload = function () {
          URL.revokeObjectURL(url);
          if (isMain) loadingPkgId = null;
          resolve(meta);
        };
        s.onerror = function () {
          URL.revokeObjectURL(url);
          if (isMain) loadingPkgId = null;
          reject(new Error((isMain ? "入口脚本" : "依赖脚本") + "执行失败：" + file));
        };
        s.src = url;
        document.head.appendChild(s);
      });
    });
  }

  // 注入一个已安装应用声明的依赖脚本及入口脚本。
  function loadInstalledApp(meta) {
    // 兼容旧注册表：早期安装器没有保存 scripts，重新从包内 app.json 补读。
    var manifestPath = APPS_ROOT + "/" + meta.id + "/app.json";
    return vfs.get(manifestPath).then(function (mf) {
      if (mf && mf.ok) {
        try {
          var declared = JSON.parse(mf.text !== undefined ? mf.text : b64ToText(mf.data));
          if (declared && Array.isArray(declared.scripts)) meta.scripts = declared.scripts.slice();
        } catch (_) { }
      }
      var scripts = Array.isArray(meta.scripts) ? meta.scripts.slice() : [];
      var chain = Promise.resolve();
      scripts.forEach(function (file) {
        if (typeof file !== "string" || !file || file.indexOf("..") >= 0 || /^[\\/]/.test(file)) return;
        chain = chain.then(function () { return loadInstalledScript(meta, file, false); });
      });
      return chain.then(function () { return loadInstalledScript(meta, meta.main || "main.js", true); });
    });
  }

  // 开机后异步加载全部已安装应用，单个失败不影响其他应用与系统。
  // 注意：以前加载失败会把应用直接从注册表删除，缓存被部分清理或 IDB 瞬时
  // 未就绪时，用户的已安装应用会永久消失。现在只记录失败，保留注册表并稍后
  // 重试；只有用户主动卸载或确认包已损坏时才移除。
  function loadInstalledApps() {
    var list = appsRegGet();
    nvLog("info", "pkg", "加载已注册应用 " + list.length + " 个：" +
      list.map(function (m) { return m.id + "@" + m.version; }).join(", "));
    var failed = [];
    var chain = Promise.resolve();
    list.forEach(function (meta) {
      chain = chain.then(function () {
        if (!meta || !meta.id || apps[meta.id]) return null;
        return loadInstalledApp(meta)["catch"](function (e) {
          failed.push(meta.id);
          nvErr("pkg", e, "已安装应用 " + meta.id + " 加载失败（保留注册表，稍后重试）");
        });
      });
    });
    return chain.then(function () {
      if (failed.length) scheduleAppRetry(failed);
      return failed;
    });
  }

  // 加载失败的应用做有限次延迟重试：缓存/存储瞬时不可用时仍能自愈。
  var appRetry = { round: 0, timer: 0, ids: {} };
  function scheduleAppRetry(ids) {
    ids.forEach(function (id) { appRetry.ids[id] = 1; });
    if (appRetry.timer || appRetry.round >= 3) return;
    appRetry.timer = setTimeout(function () {
      appRetry.timer = 0;
      appRetry.round++;
      var pending = Object.keys(appRetry.ids);
      appRetry.ids = {};
      pending.forEach(function (id) {
        var meta = appsRegGet().filter(function (m) { return m.id === id; })[0];
        if (!meta || apps[id]) return;
        loadInstalledApp(meta).then(function () {
          nvLog("info", "pkg", "应用重试加载成功：" + id);
          if (desktopReady) renderDesktop();
        }, function () { appRetry.ids[id] = 1; });
      });
      if (Object.keys(appRetry.ids).length) {
        appRetry.timer = 0;
        scheduleAppRetry(Object.keys(appRetry.ids));
      }
    }, 1500 * (appRetry.round + 1));
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
      // 无条件清空旧目录：此前只在 apps[id] 已加载时才删，导致全新安装、
      // 加载失败的应用或卸载后重装时旧版本文件残留，表现为“更新了还是旧代码”。
      return vfs.del(base)["catch"](function () { return null; })
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
      return writeOne().then(function () {
        // 同步落盘到电脑 apps_data/<id>/（离线或失败时忽略，assetUrl 会回退 blob）。
        return syncAppToDisk(meta.id, entries)["catch"](function (e) {
          var synced = Store.get("nova2.appdata", {}) || {};
          var had = !!synced[meta.id];
          delete synced[meta.id];
          Store.set("nova2.appdata", synced);
          // 失败时磁盘可能留下半套（begin 已清空并新建目录），删掉避免
          // 与注册表/离线空间不一致；删除失败不影响安装结果。
          if (had) {
            try { netCall("sys/app-data-remove", { id: meta.id }); } catch (_) { }
          }
          try { nvLog("warn", "pkg", "应用落盘失败，回退离线空间：" + meta.id + " | " +
            (e && e.message)); } catch (_) { }
          return null;
        }).then(function () { return ctx; });
      });
    }).then(function (ctx) {
      pg("register", 1, 1);
      var now = Date.now();
      var ex = appsRegGet().filter(function (m) { return m.id === meta.id; })[0];
      var regItem = {
        id: meta.id, name: String(meta.name), version: String(meta.version || "1.0.0"),
        main: meta.main, scripts: Array.isArray(meta.scripts) ? meta.scripts.slice() : [], icon: meta.icon || "📦", iconData: ctx.iconData || "",
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
      .then(function () {
        var synced = Store.get("nova2.appdata", {}) || {};
        if (synced[id]) {
          delete synced[id];
          Store.set("nova2.appdata", synced);
          // 同步删除电脑磁盘目录，避免卸载后残留可访问的页面/脚本。
          return netCall("sys/app-data-remove", { id: id })["catch"](function () { return null; });
        }
        return null;
      })
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
    // 优先用电脑磁盘 apps_data/<id>/<rel> 的真实文件地址：安装时已同步落盘，
    // HTML 可被 iframe 直接加载、js/css 可走 HTTP 缓存，且刷新后网址不变。
    // 电脑不可达（离线）时才回退到 IndexedDB + blob URL。
    var synced = Store.get("nova2.appdata", {}) || {};
    if (synced[id]) {
      return netResolve("apps-data/" + encodeURIComponent(id) + "/" +
        rel.split("/").map(encodeURIComponent).join("/")).then(function (url) {
        // netResolve 在在线开关关闭或探测失败时返回 null：此时必须回退
        // 到离线空间 blob，不能把 null 缓存为资源地址（会导致离线应用白屏）。
        if (!url) return appAssetUrlFromVfs(id, rel, key);
        pkgUrlCache[key] = url;
        return url;
      }, function () { return appAssetUrlFromVfs(id, rel, key); });
    }
    return appAssetUrlFromVfs(id, rel, key);
  }

  // 校验落盘后的页面/resources 是否真的可访问（防止磁盘被部分清理后
  // 一直返回 404 地址）。失败返回 false，由调用方回退 VFS 并触发重新落盘。
  function probeAppDataUrl(id, page) {
    page = String(page || "index.html").replace(/^\/+/, "");
    return netResolve("apps-data/" + encodeURIComponent(id) + "/" +
      page.split("/").map(encodeURIComponent).join("/")).then(function (url) {
      if (!url) return null;
      // 用轻量 HEAD 探测，避免把大文件读进内存
      return fetch(url, { method: "HEAD", cache: "no-store" }).then(function (r) {
        return r && r.ok ? url : null;
      }, function () { return null; });
    }, function () { return null; });
  }

  // 让电脑端重新落盘该应用（安装副本被破坏时自愈）
  function repairAppData(id, entries) {
    return syncAppToDisk(id, entries).then(function () { return true; }, function () { return false; });
  }

  function appAssetUrlFromVfs(id, rel, key) {
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

  // 从离线空间（VFS）把某应用的全部文件重新写回电脑磁盘。
  // 用于落盘副本被缓存清理破坏后的自愈。
  function rebuildAppDataFromVfs(id) {
    var base = APPS_ROOT + "/" + id;
    function walk(dir, out) {
      return vfs.list(dir).then(function (r) {
        if (!r || !r.ok) return out;
        var chain = Promise.resolve();
        (r.entries || []).forEach(function (en) {
          var p = (dir === "" ? "" : dir) + "/" + en.name;
          if (en.dir) {
            chain = chain.then(function () { return walk(p, out); });
          } else {
            out.push({ path: p, rel: p.slice(base.length + 1) });
          }
        });
        return chain.then(function () { return out; });
      }, function () { return out; });
    }
    return walk(base, []).then(function (files) {
      if (!files.length) return false;
      var entries = files.map(function (f) {
        return { rel: f.rel, path: f.path };
      });
      return netCall("sys/app-data-begin", { id: id }).then(function (r) {
        if (!r || !r.ok) return false;
        var i = 0;
        function next() {
          if (i >= entries.length) return true;
          var en = entries[i++];
          return vfs.get(en.path).then(function (g) {
            if (!g || !g.ok) return next();
            var blob = (g.text !== undefined && g.text !== null)
              ? new Blob([g.text], { type: g.mime || mimeOf(en.rel) })
              : b64ToBlob(g.data, g.mime || mimeOf(en.rel));
            return blob.arrayBuffer().then(function (buf) {
              return netFetch("sys/app-data-put?id=" + encodeURIComponent(id) +
                "&p=" + encodeURIComponent(en.rel), {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: new Uint8Array(buf)
              }).then(function (resp) {
                if (!resp || !resp.ok) throw new Error("写入失败 " + en.rel);
                return next();
              });
            });
          }, function () { return next(); });
        }
        return Promise.resolve().then(next);
      })["catch"](function () { return false; });
    });
  }

  // 把已解包的应用文件逐个同步到电脑磁盘（apps_data/<id>/）。
  // 失败时静默降级为 blob URL，不影响应用安装成功。
  function syncAppToDisk(id, entries) {
    return netCall("sys/app-data-begin", { id: id }).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || "电脑端拒绝创建应用目录");
      var i = 0;
      function next() {
        if (i >= entries.length) return null;
        var en = entries[i++];
        return en.zf.async("uint8array").then(function (bytes) {
          var rel = "sys/app-data-put?id=" + encodeURIComponent(id) +
            "&p=" + encodeURIComponent(en.rel);
          return netFetch(rel, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: bytes
          }).then(function (resp) {
            if (!resp || !resp.ok) throw new Error("写入失败：" + en.rel + "（HTTP " +
              (resp ? resp.status : "?") + "）");
            return next();
          });
        });
      }
      return Promise.resolve().then(next).then(function () {
        var synced = Store.get("nova2.appdata", {}) || {};
        synced[id] = 1;
        Store.set("nova2.appdata", synced);
        return { ok: true };
      });
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
    // 探测落盘资源是否可用（HEAD），失败返回 null；应用可据此判断是否需要修复
    probeAsset: probeAppDataUrl,
    // 检查并修复落盘副本：从 VFS 重新上传全部文件到 apps_data/<id>/
    ensureAsset: function (id, page) {
      return probeAppDataUrl(id, page || "index.html").then(function (u) {
        if (u) return { ok: true, url: u, repaired: false };
        return rebuildAppDataFromVfs(id).then(function (ok) {
          return probeAppDataUrl(id, page || "index.html").then(function (u2) {
            return { ok: !!u2, url: u2, repaired: ok };
          });
        });
      });
    },
    cmpVer: cmpVer,
    isUser: function (id) { return !!(apps[id] && apps[id].def.user); }
  };

  // A system update also upgrades applications that are already installed on
  // this tablet.  It never installs an app the user does not currently have,
  // and never downgrades a newer local version.
  function updateInstalledAppsFromRepo() {
    var installed = appsRegGet(), updated = [], errors = [];
    return appCatalog().then(function (catalog) {
      var remote = {};
      (catalog || []).forEach(function (a) { if (a && a.id) remote[a.id] = a; });
      var chain = Promise.resolve();
      installed.forEach(function (cur) {
        var next = cur && remote[cur.id];
        if (!next || !next.file || cmpVer(next.version, cur.version) <= 0) return;
        chain = chain.then(function () {
          return appDownload(next.file).then(function (r) {
            if (!r || !r.ok || !r.blob) throw new Error((r && r.error) || "下载失败");
            return appInstall(r.blob);
          }).then(function () {
            updated.push(next.id + "@" + next.version);
          })["catch"](function (e) {
            errors.push(next.id + "：" + ((e && e.message) || e));
          });
        });
      });
      return chain.then(function () { return { updated: updated, errors: errors }; });
    })["catch"](function (e) {
      return { updated: updated, errors: ["读取应用仓库失败：" + ((e && e.message) || e)] };
    });
  }


  function winSize() {
    var w = window.innerWidth, hh = window.innerHeight;
    // 窄屏（平板竖屏）几乎铺满，仅留状态栏与 Dock 的空间；
    // 宽屏用固定上限，避免窗口过大导致内容拉伸。
    var ww, wh;
    if (w < 700) {
      ww = Math.max(280, w - 16);
      wh = Math.max(320, hh - 132);
    } else {
      ww = Math.min(w - 24, 860);
      wh = Math.min(hh - 96, 600);
    }
    return { w: ww, h: wh };
  }

  /* 双击窗口标题栏 → 最大化/还原。
   * WinBox 自带 maximize()，但平板很难精确点到右上角按钮；
   * 双击标题栏是更符合桌面习惯的手势。仅绑定一次，避免重复叠加。 */
  function bindHeaderDblClick(wb, id) {
    try {
      var el = wb && wb.body ? wb.body.parentNode : null;   // .winbox
      if (!el) return;
      var header = el.querySelector(".wb-header");
      if (!header || header.getAttribute("data-dblclick") === "1") return;
      header.setAttribute("data-dblclick", "1");
      header.addEventListener("dblclick", function (e) {
        // 点在关闭/最大化按钮上时交给按钮自己处理
        if (e.target && e.target.closest && e.target.closest(".wb-control")) return;
        try { wb.maximize ? wb.maximize() : null; } catch (err) { }
      });
    } catch (e) { }
  }

  /* ---------------- 窗口降级容器 ----------------
   * 缓存部分被清理导致 lib/winbox.bundle.min.js 缺失时，系统仍必须能启动
   * 并使用离线空间/内置应用。MiniWin 提供 WinBox 的最小同形接口
   * （mount/min/close/focus/minimize/restore/maximize），保证 openApp、
   * 任务视图与 Dock 的调用不抛错。 */
  function MiniWin(opts) {
    opts = opts || {};
    var self = this;
    this.min = false;
    this._closed = false;
    var box = document.createElement("div");
    box.className = "nv-miniwin";
    box.style.cssText = "position:fixed;left:8px;right:8px;top:52px;bottom:8px;" +
      "display:flex;flex-direction:column;background:#1a1d24;border-radius:10px;" +
      "box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:9000;overflow:hidden;";
    var bar = document.createElement("div");
    bar.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:8px;" +
      "padding:8px 10px;background:#23262e;color:#f2eee5;font-size:13px;";
    var titleEl = document.createElement("div");
    titleEl.textContent = opts.title || "";
    titleEl.style.cssText = "flex:1;min-width:0;overflow:hidden;" +
      "text-overflow:ellipsis;white-space:nowrap;";
    var btnMin = document.createElement("button");
    btnMin.textContent = "—";
    var btnClose = document.createElement("button");
    btnClose.textContent = "✕";
    [btnMin, btnClose].forEach(function (b) {
      b.style.cssText = "background:transparent;border:0;color:#f2eee5;font-size:15px;" +
        "padding:2px 8px;cursor:pointer;";
    });
    var body = document.createElement("div");
    body.style.cssText = "flex:1;min-height:0;position:relative;overflow:hidden;";
    if (opts.mount) body.appendChild(opts.mount);
    bar.appendChild(titleEl); bar.appendChild(btnMin); bar.appendChild(btnClose);
    box.appendChild(bar); box.appendChild(body);
    document.body.appendChild(box);
    this._box = box;
    this._body = body;
    this._body.style.display = "block";

    btnMin.addEventListener("click", function () { self.minimize(); });
    btnClose.addEventListener("click", function () { self.close(); });
    box.addEventListener("mousedown", function () { self.focus(); });
    box.addEventListener("touchstart", function () { self.focus(); }, { passive: true });
  }
  MiniWin.prototype.focus = function () {
    if (this._closed) return this;
    try { this._box.style.zIndex = String(9000 + (++MiniWin._z || 1)); } catch (e) { }
    if (this.min) this.restore();
    if (this._onfocus) { try { this._onfocus(); } catch (e) { } }
    return this;
  };
  MiniWin.prototype.minimize = function () {
    if (this._closed) return this;
    this.min = true;
    this._box.style.display = "none";
    if (this._onminimize) { try { this._onminimize(); } catch (e) { } }
    return this;
  };
  MiniWin.prototype.restore = function () {
    if (this._closed) return this;
    this.min = false;
    this._box.style.display = "flex";
    return this;
  };
  MiniWin.prototype.maximize = function () {
    if (this._closed) return this;
    this._box.style.left = "0"; this._box.style.top = "0";
    this._box.style.right = "0"; this._box.style.bottom = "0";
    return this;
  };
  MiniWin.prototype.close = function () {
    if (this._closed) return;
    this._closed = true;
    this._box.style.display = "none";
    // WinBox close 会把 mount 节点退回原父节点；这里做等价处理，保证重开应用时不丢状态。
    if (this._mount && this._body && this._mount.parentNode === this._body) {
      try { this._body.removeChild(this._mount); } catch (e) { }
    }
    if (this._onclose) { try { this._onclose(); } catch (e) { } }
    try { if (this._box.parentNode) this._box.parentNode.removeChild(this._box); } catch (e) { }
  };

  // 创建窗口：优先 WinBox，缺失时降级 MiniWin
  function makeWin(opts) {
    if (window.WinBox) return new WinBox(opts);
    var w = new MiniWin(opts);
    w._mount = opts.mount;
    w._onclose = opts.onclose;
    w._onfocus = opts.onfocus;
    w._onminimize = opts.onminimize;
    return w;
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

  function releasePhiInput(root, releaseAfterLoad) {
    if (!root) return;
    try {
      var frame = root.querySelector("iframe.nv-phi-frame");
      if (releaseAfterLoad && frame) {
        frame.addEventListener("load", function () {
          releasePhiInput(root, false);
        }, { once: true });
      }
      var doc = frame && frame.contentDocument;
      var FrameEvent = doc && doc.defaultView && doc.defaultView.Event;
      if (doc) {
        doc.dispatchEvent(FrameEvent ?
          new FrameEvent("nv-phi-force-release") : new Event("nv-phi-force-release"));
        var stage = doc.getElementById("stage");
        if (stage) {
          stage.style.touchAction = "";
          stage.style.webkitTouchAction = "";
        }
      }
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: "nv-phi-force-release" }, "*");
      }
    } catch (e) { }
  }

  function openApp(id, arg) {
    var rec = apps[id];
    if (!rec) { nvLog("warn", "app", "openApp 未找到应用：" + id); return; }
    rec.healthMisses = 0;
    if (arg !== undefined) rec.lastArg = arg;
    if (rec.win) {
      focusApp(id);
      if (rec.def.onArg) {
        try { rec.def.onArg(rec.root, arg); }
        catch (e) { rec.healthCrashed = true; nvErr("app", e, "应用 " + id + " onArg 异常"); }
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
      try { rec.def.open(rec.root, API_FOR_APP); rec.healthCrashed = false; }
      catch (e) { rec.healthCrashed = true; nvErr("app", e, "应用 " + id + " open/build 崩溃"); }
    }
    if (!rec.resetHandler) {
      rec.resetHandler = function () { rebuildApp(id); };
      rec.root.addEventListener("nv-reset-app", rec.resetHandler);
    }
    rec.root.style.display = "";

    var sz = winSize();
    var n = runningCount();
    var wb = makeWin({
      title: rec.def.name,
      mount: rec.root,
      width: sz.w,
      height: sz.h,
      // 顶部留出状态栏（10px 外边距 + 40px 高 = 50px）。
      // 传 top 让 WinBox 自己把拖动/最大化限制在这条线以下，
      // 否则窗口能拖到状态栏底下，被它压住而无法操作。
      top: 50,
      x: Math.max(8, Math.round((window.innerWidth - sz.w) / 2) + (n % 4) * 22 - 33),
      y: Math.max(60, Math.round((window.innerHeight - sz.h) / 2) - 24 + (n % 4) * 18),
      background: "#1a1d24",
      border: 0,
      onclose: function () {
        // WinBox close 会把 mount 的节点 unmount 回原父节点
        if (id === "phi") releasePhiInput(rec.root, false);
        try {
          var fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
          var phiStage = rec.root && rec.root.querySelector && rec.root.querySelector("#stage");
          if (fullscreenElement && rec.root && (rec.root.contains(fullscreenElement) || (fullscreenElement === document.body && phiStage))) {
            var exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
            if (exitFullscreen) exitFullscreen.call(document);
          }
          if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
        } catch (e) { }
        // nv-close is delivered on the OS root; mirror it into embedded
        // documents so their input proxies can detach window/document hooks.
        try {
          var frame = rec.root && rec.root.querySelector && rec.root.querySelector("iframe");
          var fdoc = frame && frame.contentDocument;
          if (fdoc) {
            var FrameEvent = fdoc.defaultView && fdoc.defaultView.Event;
            fdoc.dispatchEvent(FrameEvent ? new FrameEvent("nv-close") : new Event("nv-close"));
          }
          if (frame && frame.contentWindow) {
            frame.contentWindow.postMessage({ type: "nv-close", appId: id }, "*");
          }
        } catch (e) { }
        try { rec.root.dispatchEvent(new Event("nv-close", { bubbles: true })); } catch (e) { }
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
    bindHeaderDblClick(wb, id);        // 双击标题栏最大化/还原
    if (rec.def.maximize) { try { wb.maximize(); } catch (e) { } }
    if (rec.def.onArg) {
      try { rec.def.onArg(rec.root, arg); }
      catch (e) { rec.healthCrashed = true; nvErr("app", e, "应用 " + id + " 首次 onArg 异常"); }
    }
    // 每次打开（含关闭后复用根节点重开）都广播 nv-open：
    // 根节点只 build 一次，像远程浏览器这种在 nv-close 时释放连接的应用，
    // 需要靠它重新订阅，否则重开后永远是冻结的旧画面。
    try { rec.root.dispatchEvent(new Event("nv-open")); } catch (e) { }
    if (id === "phi") releasePhiInput(rec.root, true);
    renderDock();
  }

  var appHealthPromptActive = false;
  function pingApp(id) {
    var rec = apps[id];
    if (!rec || !rec.win || !rec.inited || rec.healthCrashed) return Promise.resolve(false);
    var waits = [];
    var detail = {
      at: Date.now(),
      wait: function (p) { waits.push(Promise.resolve(p)); }
    };
    try {
      rec.root.dispatchEvent(new CustomEvent("nv-ping", { detail: detail }));
      if (typeof rec.def.ping === "function") waits.push(Promise.resolve(rec.def.ping(rec.root, API_FOR_APP)));
    } catch (e) {
      return Promise.resolve(false);
    }
    if (!waits.length) waits.push(Promise.resolve(!!(rec.root && rec.root.isConnected)));
    var probe = Promise.all(waits).then(function (values) {
      return values.every(function (value) { return value !== false; });
    }, function () { return false; });
    return Promise.race([
      probe,
      new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 4000); })
    ]);
  }

  function rebuildApp(id) {
    var rec = apps[id];
    if (!rec) return;
    var arg = rec.lastArg;
    if (rec.win) { try { rec.win.close(); } catch (e) { } }
    if (rec.root) {
      try { rec.root.dispatchEvent(new Event("nv-destroy")); } catch (e) { }
      if (rec.resetHandler) {
        try { rec.root.removeEventListener("nv-reset-app", rec.resetHandler); } catch (e) { }
      }
      if (rec.root.parentNode) rec.root.parentNode.removeChild(rec.root);
    }
    rec.root = null;
    rec.win = null;
    rec.inited = false;
    rec.healthMisses = 0;
    rec.healthPending = false;
    rec.healthCrashed = false;
    nvLog("warn", "app", "重建应用实例：" + id);
    setTimeout(function () { openApp(id, arg); }, 50);
  }

  // 无未保存内容、可安全自动重建的应用：看门狗判定无响应时直接重建，
  // 不弹“会丢失内容”的确认框，避免用户每次都要手动确认（Geo/Phi 白屏
  // 场景下确认框重建后仍可能白屏，自动重建更可靠）。
  var AUTO_HEAL_APPS = { geogebra: 1, phi: 1 };
  var autoHealCounts = {};   // 跨重建保留的自动自愈次数（rec 会被重建替换）

  function appWatchdogTick() {
    runningList().forEach(function (id) {
      var rec = apps[id];
      if (!rec || rec.healthPending) return;
      rec.healthPending = true;
      pingApp(id).then(function (ok) {
        rec.healthPending = false;
        rec.healthMisses = ok ? 0 : (rec.healthMisses || 0) + 1;
        if (ok) autoHealCounts[id] = 0;
        if (ok || rec.healthMisses < 2 || !rec.win) return;
        if (AUTO_HEAL_APPS[id]) {
          // 自动重建：连续失败有上限，避免“重建→仍白屏→再重建”死循环。
          autoHealCounts[id] = (autoHealCounts[id] || 0) + 1;
          if (autoHealCounts[id] <= 3) {
            rec.healthMisses = 0;
            nvLog("warn", "app", "自动重建无响应应用：" + id +
              "（第 " + autoHealCounts[id] + " 次）");
            rebuildApp(id);
            return;
          }
          // 超过上限：退化为一次手动确认，并把计数清零，避免持续打扰
          autoHealCounts[id] = 0;
          rec.healthMisses = 2;
        }
        if (appHealthPromptActive) return;
        appHealthPromptActive = true;
        dlg.confirm("应用“" + rec.def.name + "”无响应，重建会丢失未保存内容，继续？", "应用无响应")
          .then(function (yes) {
            appHealthPromptActive = false;
            if (yes) rebuildApp(id);
            else rec.healthMisses = 0;
          }, function (err) {
            appHealthPromptActive = false;
            rec.healthMisses = 0;
            nvErr("app", err, "应用无响应确认框异常：" + id);
          });
      });
    });
  }

  function closeApp(id) {
    var rec = apps[id];
    if (rec && rec.win) { try { rec.win.close(); } catch (e) { } }
  }

  function resetApp(id) {
    if (apps[id]) rebuildApp(id);
  }

  // Full recovery resets the live OS and system settings without deleting
  // installed software, VFS data, or browser-managed page caches.
  function resetAllSystem() {
    var ids = appOrder.slice();
    ids.forEach(function (id) {
      var rec = apps[id];
      if (!rec) return;
      try { if (rec.win) rec.win.close(); } catch (e) { }
      try { if (rec.root) rec.root.dispatchEvent(new Event("nv-destroy")); } catch (e) { }
      try { if (rec.root && rec.root.parentNode) rec.root.parentNode.removeChild(rec.root); } catch (e) { }
      clearPkgUrls(id);
    });
    // Keep app registry and package files. Reset only volatile/system config.
    [UI_KEY, BASE_KEY, PREFERRED_BASE_KEY, DEV_KEY, DEBUG_KEY, PIN_KEY,
      "nova2.lock", "nova2.net", "nova2.settings"].forEach(function (key) {
      try { Store.remove(key); } catch (e) { }
    });
    apps = {};
    appOrder = [];
    activeId = null;
    setTimeout(function () { location.reload(); }, 250);
    return Promise.resolve({ ok: true, reloading: true, softwareReset: false,
      preserved: "installed-apps,app-registry,vfs-personal-files,browser-cache",
      reset: "running-apps,watchdog,system-settings" });
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
    // 点空白处或按 Esc 关闭，符合桌面习惯
    ov.addEventListener("click", function (e) { if (e.target === ov) closeTaskView(); });
    ov.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || e.keyCode === 27) { e.preventDefault(); closeTaskView(); }
    });
    try { ov.tabIndex = -1; ov.focus({ preventScroll: true }); } catch (e) { }
    bCloseAll.addEventListener("click", function () {
      runningList().slice().forEach(closeApp);
      closeTaskView();
    });
  }
  // 全局 Esc：任务视图打开时优先关闭它
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Escape" || e.keyCode === 27) && taskViewEl) {
      e.preventDefault();
      closeTaskView();
    }
  });

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

  /* ---------------- 锁屏 ----------------
   * 密码为 4 位数字，存 localStorage（明文，仅本机离线屏保用途）。
   * 状态机（pinMode）：
   *   check      待验证，输入满 4 位即比对
   *   set-old    改密码：先验原密码
   *   set-new    设/改：输入新密码
   *   set-again  设/改：再次确认
   *   remove-old 关闭密码：验原密码后清除
   * 设计要点：
   *   1. 任何模式切换都复位输入与提示，避免串状态；
   *   2. 输错后短暂锁定输入，防止快速连按把 4 位输成 8 位；
   *   3. 无密码时键盘隐藏，点空白处进入；有密码时点空白不进入；
   *   4. 设密码全程可用“取消”退出，回到验证态。 */
  var PIN_KEY = "nova2.pin";
  var pinInput = "";
  var pinMode = "check";
  var pinStage = "";
  var pinBusy = false;      // 校验中/错误展示中，暂停接受输入
  var pinTimer = 0;

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function tickClock() {
    var d = new Date();
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    var week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
    var dateStr = d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() +
                  "日 星期" + week;
    var c1 = document.getElementById("nv-clock");
    var c2 = document.getElementById("nv-date");
    var c3 = document.getElementById("nv-sb-clock");
    if (c1) c1.textContent = hm;
    if (c2) c2.textContent = dateStr;
    if (c3) c3.textContent = hm;
  }

  function hasPin() { return !!Store.get(PIN_KEY, ""); }

  function enterDesktop() {
    document.getElementById("nv-lock").classList.add("nv-hidden");
    document.getElementById("nv-desktop").classList.remove("nv-hidden");
  }
  function lockScreen() {
    for (var k in apps) {
      if (apps[k].win) { try { apps[k].win.close(); } catch (e) { } }
    }
    resetPinState();
    document.getElementById("nv-lock").classList.remove("nv-hidden");
    document.getElementById("nv-desktop").classList.add("nv-hidden");
  }

  // 复位到“验证密码”初始态（切模式、锁屏、取消时都走这里）
  function resetPinState() {
    if (pinTimer) { clearTimeout(pinTimer); pinTimer = 0; }
    pinInput = "";
    pinMode = "check";
    pinStage = "";
    pinBusy = false;
    renderPinDots();
    setPinTip(hasPin() ? "请输入锁屏密码" : "");
    renderLockMode();
  }

  // 根据“是否已设密码”和当前模式，切换键盘/提示/功能键文案
  function renderLockMode() {
    var panel = document.getElementById("nv-pin-panel");
    var hint = document.getElementById("nv-enter-hint");
    if (!panel || !hint) return;
    // 无密码且不在设置流程：显示“轻触进入”，隐藏键盘
    var editing = pinMode !== "check";
    var showPad = hasPin() || editing;
    panel.classList.toggle("nv-hidden", !showPad);
    hint.classList.toggle("nv-hidden", showPad);
    var setBtn = document.querySelector('.nv-key[data-k="set"]');
    if (setBtn) {
      if (pinMode === "check") setBtn.textContent = hasPin() ? "改密码" : "设密码";
      else setBtn.textContent = "取消";
      // 无密码时也允许点“设密码”，所以编辑态/有密码都要有键盘
    }
  }

  function renderPinDots(err) {
    var box = document.getElementById("nv-pin-dots");
    if (!box) return;
    var dots = box.children;
    for (var i = 0; i < dots.length; i++) {
      dots[i].className = err ? "err" : (i < pinInput.length ? "on" : "");
    }
  }
  function setPinTip(t) {
    var el = document.getElementById("nv-pin-tip");
    if (el) el.textContent = t || "";
  }

  // 短暂展示错误后自动回到当前步骤的提示语
  function pinError(msg, backTip, after) {
    pinBusy = true;
    pinInput = "";
    renderPinDots(true);
    setPinTip(msg);
    if (pinTimer) clearTimeout(pinTimer);
    pinTimer = setTimeout(function () {
      pinTimer = 0;
      pinBusy = false;
      renderPinDots();
      setPinTip(backTip);
      if (after) after();
    }, 700);
  }

  function pinDone() {
    var saved = String(Store.get(PIN_KEY, ""));
    var v = pinInput;

    if (pinMode === "check") {
      if (!saved) { enterDesktop(); return; }
      if (v === saved) { enterDesktop(); return; }
      pinError("密码错误", "请输入锁屏密码");
      return;
    }

    if (pinMode === "set-old" || pinMode === "remove-old") {
      if (v !== saved) {
        pinError("原密码错误", pinMode === "set-old" ? "请输入原密码" : "请输入原密码",
          function () { pinInput = ""; renderPinDots(); });
        return;
      }
      if (pinMode === "remove-old") {
        Store.remove(PIN_KEY);
        toast("已关闭锁屏密码");
        resetPinState();
        return;
      }
      pinInput = "";
      pinMode = "set-new";
      renderPinDots();
      setPinTip("请输入新密码（4 位数字）");
      renderLockMode();
      return;
    }

    if (pinMode === "set-new") {
      pinStage = v;
      pinInput = "";
      pinMode = "set-again";
      renderPinDots();
      setPinTip("请再次输入新密码");
      return;
    }

    if (pinMode === "set-again") {
      if (v === pinStage) {
        Store.set(PIN_KEY, v);
        toast("密码已设置");
        resetPinState();
      } else {
        pinStage = "";
        pinMode = "set-new";
        pinError("两次输入不一致，请重新设置", "请输入新密码（4 位数字）");
      }
      return;
    }
  }

  /* ---------------- 锁屏交互绑定 ----------------
   * 只在这里绑定事件；状态判定全部交给上面 pinDone/状态机，
   * 避免旧实现在点击、键盘、按钮三处各写一份判断导致行为不一致。 */
  function initLock() {
    var lockEl = document.getElementById("nv-lock");
    if (!lockEl) return;

    // 无密码且未在设置流程：点锁屏任意处进入
    lockEl.addEventListener("click", function (e) {
      if (hasPin() || pinMode !== "check") return;
      enterDesktop();
    });

    // 数字键盘（含 设/改密码、取消、删除）
    var padEl = lockEl.querySelector(".nv-pad");
    if (padEl) {
      padEl.addEventListener("click", function (e) {
        var btn = e.target;
        if (!btn || btn.tagName !== "BUTTON") return;
        e.stopPropagation();
        if (pinBusy) return;
        var k = btn.getAttribute("data-k");

        if (k === "del") {
          pinInput = pinInput.slice(0, -1);
          renderPinDots();
          return;
        }

        if (k === "set") {
          // 查看态：进入“设/改密码”；编辑态：取消，回到验证
          if (pinMode === "check") {
            if (hasPin()) {
              pinMode = "set-old"; pinInput = "";
              renderPinDots(); setPinTip("请输入原密码");
            } else {
              pinMode = "set-new"; pinInput = "";
              renderPinDots(); setPinTip("请输入新密码（4 位数字）");
            }
            renderLockMode();
          } else {
            resetPinState();
          }
          return;
        }

        if (!/^[0-9]$/.test(k)) return;
        if (pinInput.length >= 4) return;
        pinInput += k;
        renderPinDots();
        if (pinInput.length === 4) {
          // 稍延迟，让第 4 个圆点先显示出来
          setTimeout(pinDone, 120);
        }
      });
    }

    // 物理键盘（外接键盘/调试）
    document.addEventListener("keydown", function (e) {
      if (lockEl.classList.contains("nv-hidden")) return;
      if (pinBusy) return;
      if (!hasPin() && pinMode === "check") {
        if (e.key === "Enter" || e.keyCode === 13) enterDesktop();
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        if (pinInput.length >= 4) return;
        pinInput += e.key;
        renderPinDots();
        if (pinInput.length === 4) setTimeout(pinDone, 120);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        pinInput = pinInput.slice(0, -1);
        renderPinDots();
      } else if (e.key === "Escape" && pinMode !== "check") {
        resetPinState();
      }
    });

    // 从设置页返回时同步模式（可能刚设/改/删了密码）
    window.addEventListener("focus", function () {
      if (!lockEl.classList.contains("nv-hidden")) renderLockMode();
    });

    resetPinState();
  }

  /* ---------------- 对外 API（传给每个应用） ---------------- */
  var API_FOR_APP = null;   // boot 时构造

  /* ---------------- 启动 ---------------- */
  var booting = false;
  function boot() {
    if (booting || (window.OS && window.OS.__booted)) return;
    // 注意：不再因为 WinBox 缺失而拒绝启动。缓存被部分清理时
    // lib/winbox.bundle.min.js 可能 404，但离线空间、设置、文件管理等
    // 仍必须可用；此时 makeWin() 会降级到内置 MiniWin。
    if (!window.WinBox) {
      try { console.warn("[os] WinBox 未加载，窗口降级为内置容器"); } catch (e) { }
    }
    booting = true;

    // 每次启动 OS 都强制关闭在线开关：即使上次手动打开过，重启后也回到离线，
    // 必须由用户到设置页重新手动开启。避免后端不存在时长期后台探测。
    try { Store.set(ONLINE_KEY, false); } catch (e) { }

    iconsEl = document.getElementById("nv-icons");
    dockEl = document.getElementById("nv-dock");
    rootsEl = h("div", "nv-app-roots");
    rootsEl.style.display = "none";
    document.body.appendChild(rootsEl);

    API_FOR_APP = {
      store: Store,
      api: api,
      media: {
        register: registerMedia, pauseAll: pauseAllMedia,
        headset: function () { return Object.assign({}, headset); }, refreshHeadset: detectHeadset
      },
      net: {
        probe: netProbe,
        getWeb: netGetWeb,
        info: function () { return NET.info; },
        base: function () { return NET.base; },
        online: function () { return NET.online; },
        // 在线开关：关闭时不探测电脑服务、不向劫持域名发任何请求。
        onlineEnabled: onlineEnabled,
        setOnline: function (on) { setOnlineEnabled(!!on); return onlineEnabled(); },
        preferred: function () { return Store.get(PREFERRED_BASE_KEY, ""); },
        setPreferred: function (value) {
          var normalized = normalizePreferredBase(value);
          if (value && !normalized) return { ok: false, error: "请输入有效的后端 IP 或地址" };
          if (normalized) Store.set(PREFERRED_BASE_KEY, String(value).trim());
          else Store.remove(PREFERRED_BASE_KEY);
          NET.generation++;
          NET.probing = null;
          NET.probed = false;
          NET.online = false;
          NET.base = "";
          NET.info = null;
          NET.nextProbeAt = 0;
          netChanged();
          return { ok: true, base: normalized };
        },
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
      version: function () { return OS_VERSION; },
      build: function () { return OS_BUILD; },
      // 存储占用探测：mode 传 "storage"（只看储存）/ "total"（含 WebView 总体）
      storage: function (mode, vfsInfo) { return collectStorage(mode, vfsInfo); },
      dlg: dlg,
      toast: toast,
      on: on,
      emit: emit,
      h: h,
      clear: clear,
      openApp: openApp,
      resetApp: resetApp,
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

    // 启动时恢复壁纸：自定义渐变需连同保存的两个色标一起还原
    var wpIdx = ui.wallpaper();
    applyWallpaper(wpIdx, wpIdx === CUSTOM_ID ? ui.wallpaperColors() : null);
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

    initMediaMonitor();
    setInterval(appWatchdogTick, 15000);
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

    // DevLink 默认关闭，仅由设置页在本次运行中临时开启。
  }

  // nova.html 末尾会调用 OS.boot()；此处兜底（脚本顺序变化时也能启动）
  // 先暴露引导对象：应用脚本（os.js 之后加载）用 OS.registerApp 注册
  window.addEventListener("message", function (event) {
    var data = event && event.data;
    if (!data || data.type !== "nv-reset-app" || data.appId !== "phi") return;
    resetApp("phi");
  });
  window.OS = { boot: boot, registerApp: registerApp, resetApp: resetApp,
    resetAll: resetAllSystem, __booted: false };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (!window.OS.__booted) boot();
    });
  }

  window.__nvBoot = boot;
})();
