/*
 * NovaOS stealth loader
 * 前置注入到 manifest.build.* 之前，在专栏页面（顶层框架）中运行。
 *
 * 设计原则：
 *   - 触发前不创建任何可见/不可见元素，DOM 与原页面完全一致；
 *   - NovaOS 在独立的【跨域 iframe】中运行（独立 DOM/CSS/JS/存储），
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
    function createFrame() {
        frame = document.createElement("iframe");
        frame.id = FRAME_ID;
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen; autoplay");
        frame.style.cssText = [
            "position:fixed", "left:0", "top:0", "width:100vw", "height:100vh",
            "max-width:none", "max-height:none", "border:0", "margin:0", "padding:0",
            "display:none", "background:#000", "z-index:2147483646"
        ].join(";");
        var src = serveOrigin() + mountPath() + "index.html";
        frame.src = src;
        (document.documentElement || document.body).appendChild(frame);
        dbg("frame created");
    }

    function show() {
        if (!frame) createFrame();
        frame.style.display = "block";
        shown = true;
        try { frame.focus({ preventScroll: true }); } catch (e) { }
    }
    function hide() {
        if (frame) frame.style.display = "none";
        shown = false;
    }
    function toggle() {
        if (shown) hide(); else show();
    }

    /* 接收 NovaOS 内部桥接消息（跨域，严格校验来源与一次性 token） */
    window.addEventListener("message", function (e) {
        if (e.origin !== serveOrigin()) return;
        var d = e.data;
        if (!d || typeof d !== "object") return;
        if (d.t === "nva-handshake") {
            // 仅接受自己创建的 iframe，通过后下发一次性令牌
            if (frame && e.source === frame.contentWindow) {
                try { frame.contentWindow.postMessage({ t: "nva-auth", k: TOKEN }, e.origin); } catch (err) { }
            }
            return;
        }
        if (d.k !== TOKEN) return;
        if (d.t === "nva-toggle") toggle();
        else if (d.t === "nva-hide") hide();
    });

    /* ---------------- 隐蔽触发器（未命中时绝不干预原页面事件） ---------------- */
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

        if (wantOpen) { wantOpen = false; setTimeout(show, 600); }
    }

    try { arm(); } catch (e) { dbg("arm fail", e); }
})();
