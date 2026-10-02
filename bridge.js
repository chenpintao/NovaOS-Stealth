/*
 * Tzy OS in-frame bridge（由代理内联注入 Tzy OS 的 index.html）
 * 职责：
 *   1. 封禁 Service Worker 注册，杜绝 SW 越出挂载路径影响原平台；
 *   2. 在 Tzy OS 内部提供与外层一致的隐蔽手势，向父页面发 postMessage 关闭/切换。
 * 令牌不经过 URL（保持 URL 干净以便命中长期缓存），通过 postMessage 握手获取。
 */
(function () {
    "use strict";
    try {
        // 最原始打点：iframe 内 JS 只要执行到这一行就回传（同源相对地址，不经父页面）
        try { var _bb = new Image(); _bb.src = "__err__.gif?p=j&z=" + Date.now(); } catch (e0) { }
        var CFG = window.__BRIDGE_CFG__ || {};

        /* =====================================================================
         * 设备诊断探针：老内核/弱网平板启动失败时，把 iframe 内部真实状态
         * （JS 报错、资源加载失败、实际拿到的脚本、启动阶段）回传劫持服务端，
         * 电脑端 logs/access.log 中以 [DIAG] 记录。不做任何其他事。
         * ===================================================================== */
        function diag(phase, extra) {
            try {
                var d = {
                    t: "nva-diag", ph: phase, rs: document.readyState,
                    ua: (navigator.userAgent || "").slice(0, 130), ts: Date.now()
                };
                if (extra) { for (var k in extra) d[k] = extra[k]; }
                window.parent.postMessage(d, "*");
            } catch (e) { }
        }
        diag("boot");
        window.addEventListener("error", function (e) {
            var tgt = e.target;
            if (tgt && tgt !== window && (tgt.src || tgt.href)) {
                diag("res-error", { url: String(tgt.src || tgt.href).split("/__nova__/")[1] || String(tgt.src || tgt.href), tag: tgt.tagName || "" });
            } else {
                diag("js-error", {
                    msg: String(e.message || ""),
                    file: String(e.filename || "").split("/").pop(),
                    line: e.lineno || 0, col: e.colno || 0,
                    stack: (e.error && e.error.stack) ? String(e.error.stack).slice(0, 1400) : ""
                });
            }
        }, true);
        window.addEventListener("unhandledrejection", function (e) {
            var r = e.reason;
            diag("promise", { reason: String(r && (r.stack || r.message) || r).slice(0, 1400) });
        });
        function diagBeat(phase) {
            try {
                var ents = performance.getEntriesByType("resource")
                    .map(function (x) {
                        var n = x.name.split("/__nova__/")[1] || x.name;
                        return x.responseEnd ? n : n + "(pending)";
                    })
                    .filter(function (n) { return /\.(js|html|css|json|woff2)(\?|$)/.test(n) || n.indexOf("(pending)") > -1; });
                diag(phase, {
                    f1: typeof window.launchbios,        // script.js 执行后应为 function
                    f2: typeof window.openn,
                    f3: typeof window.setandinitnewuser,
                    res: ents.slice(0, 60)
                });
            } catch (e) { diag(phase, { probeErr: String(e) }); }
        }
        document.addEventListener("DOMContentLoaded", function () { diagBeat("dcl"); });
        window.addEventListener("load", function () {
            diagBeat("load");
            setTimeout(function () { diagBeat("t3"); }, 3000);
            setTimeout(function () { diagBeat("t8"); }, 8000);
        });

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
            try { window.__NVA_TOKEN__ = TOKEN; } catch (e) { }
        });
        handshake();
        setTimeout(handshake, 400);
        setTimeout(handshake, 1200);

        /* ---- SW 封禁：Tzy OS 仅在手动开启离线模式时注册 SW，这里直接拦截 ---- */
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
            // Tzy OS 应用可能在新子 iframe 中打开，同源子帧内的手势需要各自绑定
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
    } catch (e) { /* 桥接失败不影响 Tzy OS 本体 */ }
})();
