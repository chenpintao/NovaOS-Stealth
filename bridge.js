/*
 * NovaOS in-frame bridge（由代理内联注入 NovaOS 的 index.html）
 * 职责：
 *   1. 封禁 Service Worker 注册，杜绝 SW 越出挂载路径影响原平台；
 *   2. 在 NovaOS 内部提供与外层一致的隐蔽手势，向父页面发 postMessage 关闭/切换。
 * 令牌不经过 URL（保持 URL 干净以便命中长期缓存），通过 postMessage 握手获取。
 */
(function () {
    "use strict";
    try {
        var CFG = window.__BRIDGE_CFG__ || {};

        var TOKEN = "";
        var PARENT = "*";

        /* ---- 与父页面握手获取一次性令牌 ---- */
        function handshake() {
            try { window.parent.postMessage({ t: "nva-handshake" }, "*"); } catch (e) { }
        }
        window.addEventListener("message", function (e) {
            var d = e.data;
            if (!d || typeof d !== "object" || d.t !== "nva-auth") return;
            TOKEN = String(d.k || "");
            PARENT = e.origin || "*";
        });
        handshake();
        setTimeout(handshake, 400);
        setTimeout(handshake, 1200);

        /* ---- SW 封禁：NovaOS 仅在手动开启离线模式时注册 SW，这里直接拦截 ---- */
        try {
            if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                navigator.serviceWorker.getRegistrations().then(function (regs) {
                    regs.forEach(function (r) { try { r.unregister(); } catch (e) { } });
                }).catch(function () { });
            }
            if (navigator.serviceWorker) {
                navigator.serviceWorker.register = function () {
                    return Promise.reject(new DOMException("blocked", "SecurityError"));
                };
            }
        } catch (e) { }

        function send(t) {
            if (!TOKEN) return; // 尚未握手，丢弃
            try { window.parent.postMessage({ t: t, k: TOKEN }, PARENT); } catch (e) { }
        }

        /* ---- 后台静默预取（必须在本 iframe 同源分区执行：Chrome 双键缓存按
              (顶级站, 当前帧站) 分区，父页面预取对本 iframe 无效）---- */
        var PF_KEY = "__nova_pfv__";
        function bridgePrefetch() {
            try {
                fetch("__filelist__.json", { cache: "no-cache" })
                    .then(function (r) { return r.json(); })
                    .then(function (man) {
                        if (!man || !Array.isArray(man.files)) return;
                        var done = "";
                        try { done = localStorage.getItem(PF_KEY) || ""; } catch (e) { }
                        if (done === String(man.version)) return;
                        var i = 0, BATCH = 6;
                        (function pump() {
                            if (i >= man.files.length) {
                                try { localStorage.setItem(PF_KEY, String(man.version)); } catch (e) { }
                                return;
                            }
                            var part = man.files.slice(i, i + BATCH);
                            i += BATCH;
                            Promise.all(part.map(function (f) {
                                return fetch(f, { cache: "default" })
                                    .then(function () { }, function () { });
                            })).then(function () { setTimeout(pump, 80); });
                        })();
                    }).catch(function () { });
            } catch (e) { }
        }
        setTimeout(function () {
            var ric = window.requestIdleCallback || function (cb) { return setTimeout(cb, 1); };
            ric(bridgePrefetch, { timeout: 10000 });
        }, 3500);

        var hotOn = !!CFG.trigger_hotkey_enable;
        var wantKey = (CFG.trigger_hotkey_key || "").toLowerCase();
        var nCtrl = !!CFG.trigger_hotkey_ctrl, nShift = !!CFG.trigger_hotkey_shift, nAlt = !!CFG.trigger_hotkey_alt;

        var tapOn = !!CFG.trigger_tap_enable;
        var need = Math.max(1, Math.min(9, CFG.trigger_tap_count | 0 || 5));
        var radius = Math.max(8, Math.min(64, CFG.trigger_tap_radius | 0 || 20));
        var winMs = Math.max(300, Math.min(5000, CFG.trigger_tap_interval_ms | 0 || 1500));
        var corner = CFG.trigger_tap_corner || "top-left";

        function bind(doc) {
            if (!doc || doc.__nvaBridge) return;
            doc.__nvaBridge = true;

            if (hotOn && wantKey) {
                doc.addEventListener("keydown", function (e) {
                    var k = (e.key || "").toLowerCase();
                    if (k !== wantKey) return;
                    if (!!e.ctrlKey !== nCtrl || !!e.shiftKey !== nShift || !!e.altKey !== nAlt) return;
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    send("nva-toggle");
                }, true);
            }

            if (tapOn) {
                var taps = 0, firstAt = 0;
                doc.addEventListener("pointerdown", function (e) {
                    var x = e.clientX, y = e.clientY, w = window.innerWidth, h = window.innerHeight, hit = false;
                    if (corner === "top-left") hit = x <= radius && y <= radius;
                    else if (corner === "top-right") hit = (w - x) <= radius && y <= radius;
                    else if (corner === "bottom-left") hit = x <= radius && (h - y) <= radius;
                    else if (corner === "bottom-right") hit = (w - x) <= radius && (h - y) <= radius;
                    if (!hit) return;
                    var now = Date.now();
                    if (!taps || now - firstAt > winMs) { taps = 1; firstAt = now; }
                    else taps++;
                    if (taps >= need) { taps = 0; send("nva-hide"); }
                }, true);
            }
        }

        function arm() {
            bind(document);
            // NovaOS 应用可能在新子 iframe 中打开，同源子帧内的手势需要各自绑定
            document.addEventListener("load", function (e) {
                var t = e.target;
                if (t && t.tagName === "IFRAME" && t.contentDocument) {
                    try { bind(t.contentDocument); } catch (e) { }
                }
            }, true);
        }

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", arm, { once: true });
        } else {
            arm();
        }
    } catch (e) { /* 桥接失败不影响 NovaOS 本体 */ }
})();
