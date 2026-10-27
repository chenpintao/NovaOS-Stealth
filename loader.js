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
    var osReady = false;     // iframe 内 OS 是否真正 boot 完成（nva-ready）
    var watchdog = 0;
    var lastToggleAt = 0;    // 防止一次口令触发两次开关（闪一下）
    var activationPending = false;
    var pageHiddenAt = 0;
    var RESUME_RECOVERY_MS = 60000;

    // 激活状态保存在宿主页面的 localStorage 中，并按服务地址隔离，避免
    // 同一浏览器里的不同部署互相继承激活状态。localStorage 不可用时按
    // 未激活处理，不能因为存储异常绕过激活流程。
    function activationKey() {
        return "__nova_activated__:" + serveOrigin() + ":" + mountPath();
    }
    function isActivated() {
        try { return localStorage.getItem(activationKey()) === "1"; } catch (e) { return false; }
    }
    function markActivated() {
        try { localStorage.setItem(activationKey(), "1"); } catch (e) { return false; }
        return true;
    }
    function todayCode() {
        var d = new Date();
        return (d.getMonth() + 1 < 10 ? "0" : "") + (d.getMonth() + 1) +
            (d.getDate() < 10 ? "0" : "") + d.getDate();
    }
    /* ---------------- 注入成功标识 ----------------
     * 右下角极小红点：注入脚本在宿主页跑起来就出现，用户据此确认
     * “这一次页面被成功接管了”。首次激活完成后永久移除（同源同挂载点
     * 已可信，不再打扰）；未激活前每次加载都会重新出现。
     * 用内联样式 + 独立宿主元素，不依赖平台页面的样式。 */
    var DOT_ID = "nv-inject-dot";
    function removeInjectDot() {
        try {
            var d = document.getElementById(DOT_ID);
            if (d && d.parentNode) d.parentNode.removeChild(d);
        } catch (e) { }
    }
    function showInjectDot() {
        // 已激活过就不再显示
        if (isActivated()) { removeInjectDot(); return; }
        try {
            if (document.getElementById(DOT_ID)) return;
            var d = document.createElement("div");
            d.id = DOT_ID;
            d.setAttribute("aria-hidden", "true");
            d.title = "Tzy OS 已注入";
            d.style.cssText = [
                "position:fixed", "right:3px", "bottom:3px",
                "width:6px", "height:6px", "border-radius:50%",
                "background:#e23b2e", "opacity:.85",
                "z-index:2147483647", "pointer-events:none",
                "box-shadow:0 0 3px rgba(226,59,46,.9)"
            ].join(";");
            (document.body || document.documentElement).appendChild(d);
        } catch (e) { }
    }

    function wipeInput(el) {
        try {
            if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
                var proto = el.tagName === "TEXTAREA"
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                var setter = Object.getOwnPropertyDescriptor(proto, "value");
                if (setter && setter.set) setter.set.call(el, "");
                else el.value = "";
                el.dispatchEvent(new Event("input", { bubbles: true }));
            } else if (el) {
                el.textContent = "";
            }
        } catch (e) { }
    }
    function beginActivation() {
        if (isActivated()) return true;
        activationPending = true;
        dbg("activation challenge armed");
        return false;
    }
    function completeActivation(value, el) {
        if (!activationPending || isActivated()) return false;
        if (String(value || "").replace(/\s+/g, "") !== todayCode()) return false;
        if (el) wipeInput(el);
        if (!markActivated()) return false;
        activationPending = false;
        removeInjectDot();      // 激活完成：红点使命结束
        show();
        return true;
    }

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
    // 地址不能写死成劫持域名：断劫持后 os.js 会改用 IP 直连，此时域名打不开，
    // 息屏恢复重建 iframe 若回到域名就会黑屏。bridge 在握手里回传 os.js 实际
    // 使用的基址，父页面存进 localStorage（iframe 与宿主不同源，不能直接共享）。
    var BASE_KEY = "nova2.frameBase";
    function storedBase() {
        try { return String(localStorage.getItem(BASE_KEY) || ""); } catch (e) { return ""; }
    }
    function saveBase(base) {
        try {
            if (base) localStorage.setItem(BASE_KEY, base);
            else localStorage.removeItem(BASE_KEY);
        } catch (e) { }
    }
    function frameSrc() {
        var b = storedBase();
        // 仅接受本服务的绝对地址（http(s)://host 开头），其余一律用同源
        if (b && !(b.indexOf("http://") === 0 || b.indexOf("https://") === 0)) b = "";
        return (b || (serveOrigin() + mountPath())) + "nova.html";
    }

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

    function recoverOS() {
        if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
        shown = true;
        handshaked = false;
        osReady = false;
        reloads = 0;
        armedAt = Date.now();
        var bust = "?recovery=" + Date.now();
        try {
            if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
            if (host && host.parentNode) host.parentNode.removeChild(host);
        } catch (e) { }
        frame = null;
        host = null;
        root = null;
        createFrame(frameSrc() + bust);
        // hide() 会把 pointerEvents 置 none；WebView 息屏恢复后若残留在 none，
        // 表现为“看得见但点不动”。这里显式复位全部显隐相关的内联样式。
        ensureHost().style.display = "block";
        ensureHost().style.visibility = "visible";
        ensureHost().style.opacity = "1";
        ensureHost().style.pointerEvents = "auto";
        armWatchdog();
        poke("recovery");
    }

    // Mobile/WebView processes may suspend a visible iframe while its host page
    // is backgrounded. Recreate it on a long resume instead of trusting the old
    // handshake forever; OS data is stored separately from this iframe runtime.
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
            pageHiddenAt = Date.now();
            return;
        }
        var away = pageHiddenAt ? Date.now() - pageHiddenAt : 0;
        pageHiddenAt = 0;
        if (shown && away >= RESUME_RECOVERY_MS) {
            recoverOS();
            return;
        }
        // 短时间息屏：WebView 没冻结 iframe，只是丢了焦点/渲染。此时要确保
        // 遮罩层可点，并让 iframe 内重新握手（内核丢弃旧 postMessage 监听时，
        // loader 会一直以为 handshaked 而不再兜底重建）。
        if (shown) {
            ensureHost().style.pointerEvents = "auto";
            poke("resume");
            armWatchdog();
        }
    });

    // WebView 从 bfcache 直接恢复页面时也会走这里（不触发 visibilitychange）
    window.addEventListener("pageshow", function (e) {
        if (e && e.persisted && shown) {
            poke("bfcache");
            recoverOS();
        }
    });

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
        frame.src = src || frameSrc();   // 先挂载再设 src；干净 URL 保证缓存键一致
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
            watchdog = 0;
            if (!shown || osReady || reloads >= 3) return;
            // 不再因 navigator.onLine === false 直接放弃：WebView 息屏恢复后
            // 常常先报告离线，而本地服务（IP 直连）其实是通的。此前在这里
            // return 会让黑屏 iframe 永远停在自定义域名上且吞掉所有触摸。
            // 现在仍然重建，但地址取自 frameSrc()（优先 os.js 回传的直连基址）。
            reloads++;
            poke("stalled");
            var bust = "?t=" + Date.now() + "&r=" + reloads;
            try {
                if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
            } catch (e) { }
            frame = null;
            osReady = false;
            handshaked = false;
            try {
                createFrame(frameSrc() + bust);
            } catch (e) { }
            armWatchdog();
        }, 8000);
        // 说明：8 秒是「从显示到 OS.__booted」的预算。首次冷启动在弱机上
        // 可能更久，但 bridge 的 nva-ready 一到就会立刻清掉这里的定时器，
        // 所以宁可稍紧一点，让坏缓存更快被换掉（最多 3 轮）。
    }

    function show() {
        if (!frame) createFrame();
        else ensureHost();
        host.style.display = "block";
        host.style.visibility = "visible";
        host.style.opacity = "1";
        host.style.pointerEvents = "auto";
        shown = true;
        armedAt = Date.now();
        poke("show");
        try { frame.focus({ preventScroll: true }); } catch (e) { }
        // 关键：不能只看 handshaked。bridge 在 <head> 就握手，os.js 坏掉时
        // 握手仍是 true，此时不挂看门狗就等于放弃自愈。只要 OS 还没真正
        // ready（osReady=false）就必须继续看护。
        if (!osReady) armWatchdog();
    }

    function hide() {
        if (host) {
            // Keep the iframe mounted and running in the background. Toggling
            // display:none freezes some WebViews and causes a black screen on return.
            host.style.display = "block";
            host.style.visibility = "visible";
            host.style.opacity = "0";
            host.style.pointerEvents = "none";
        }
        shown = false;
        poke("hide");
    }
    /* 看门狗快照刷新（每次联网）：
     * __boot__.snapshot.js 是断劫持/断网后唯一能把 OS 拉起来的凭据（见 boot-stub）。
     * loader 在宿主父页面运行，与 boot-stub 处在同一缓存分区；这里在每次
     * online 时再补刷一次，双保险。绝不删除、绝不 no-store —— 快照必须始终
     * 以长缓存留在磁盘里；OS 本体（nova.html/os.js）坏了可以重新拉取，
     * 看门狗丢了就再也起不来了。 */
    function warmWatchdogSnapshot() {
        try {
            if (navigator.onLine === false) return;
            var url = walkWatchdogBase() + "__boot__.snapshot.js";
            fetch(url, { cache: "reload" }).then(function (r) {
                dbg("watchdog snapshot refresh", r && r.status);
            }, function () { });
        } catch (e) { }
    }
    // 快照所在的基址：优先 loader 自身来源（与注入点同源的分区内），
    // 退化到挂载点。不能用 storedBase()（那是 iframe 的直连基址），
    // 因为 boot-stub 的快照写入的是「父页面」缓存分区。
    function walkWatchdogBase() {
        var origin = "";
        try {
            origin = (window.location && window.location.origin) || "";
            // file:/about: 等场景 origin 为 "null"，不可用作快照基址
            if (!/^https?:\/\//i.test(origin)) origin = "";
        } catch (e) { origin = ""; }
        return (origin || serveOrigin()) + mountPath();
    }
    window.addEventListener("online", function () {
        // 每次联网都刷新看门狗快照，保证离线兜底始终新鲜。
        warmWatchdogSnapshot();
        if (shown && !osReady) armWatchdog();
    });
    function toggle() {
        // 一次口令在部分内核上会同时命中 input 与 keydown 两条通道，
        // 造成“唤起后立刻又隐藏”（闪一下）；700ms 内的重复触发一律忽略。
        var now = Date.now();
        if (now - lastToggleAt < 700) return;
        if (!isActivated()) return;
        lastToggleAt = now;
        if (shown) hide(); else show();
    }

    /* 接收 Tzy OS 内部桥接消息（跨域，严格校验来源与一次性 token） */
    window.addEventListener("message", function (e) {
        // 恢复时 iframe 可能由 IP 直连地址加载（origin 随之变成 http://IP），
        // 因此除了劫持域名，还要放行已记录的后端基址来源。
        var origin = String(e.origin || "");
        var allowed = origin === serveOrigin();
        if (!allowed) {
            // 基址形如 http://IP:port/__nova__/ → 取协议+主机部分与 e.origin 比较
            try {
                var u = new URL(storedBase());
                if (origin === u.protocol + "//" + u.host) allowed = true;
            } catch (err) { }
        }
        if (!allowed) return;
        var d = e.data;
        if (!d || typeof d !== "object") return;
        if (d.t === "nva-handshake") {
            // 仅接受自己创建的 iframe，通过后下发一次性令牌
            if (frame && e.source === frame.contentWindow) {
                // 注意：这里只代表「HTML 解析到 <head>」，不代表 OS 起来了。
                // os.js 可能 404 / 被截断 / 返回 CDN 错误页 —— 那样 OS 永远
                // 不会 boot，若在此停掉看门狗就会永久卡死锁屏。真正就绪由
                // bridge 的 nva-ready（OS.__booted === true）确认。
                handshaked = true;                 // 已握手（bridge 已执行）
                // 这里绝不能停看门狗：握手只说明 HTML 解析到 <head>。
                // 若在此 clearTimeout，os.js 坏掉时再没有任何机制重建 iframe，
                // 用户会永久停在锁屏（实测 T11 复现）。停看门狗只在 nva-ready。
                // 记住 iframe 实际使用的电脑服务基址（同源时为空串 → 清掉记录），
                // 供息屏恢复/看门狗重建时选择正确地址。
                if (typeof d.b === "string") saveBase(d.b);
                try { frame.contentWindow.postMessage({ t: "nva-auth", k: TOKEN }, e.origin); } catch (err) { }
            }
            return;
        }
        // 诊断探针：握手前也允许，仅接受自己 frame 的消息；用图片打点跨域回传
        if (d.t === "nva-diag") {
            if (frame && e.source === frame.contentWindow) sendDiag(d);
            return;
        }
        // os.js 探测完成后广播的基址同步（握手之后也可能变化，如换网/重探）
        if (d.t === "nva-netbase") {
            if (frame && e.source === frame.contentWindow && typeof d.b === "string") {
                saveBase(d.b);
            }
            return;
        }
        if (d.t === "nva-ready") {
            // OS 真正起来了：这时才认为加载成功，停掉重试计数。
            if (frame && e.source === frame.contentWindow) {
                osReady = true;
                reloads = 0;
                if (watchdog) { clearTimeout(watchdog); watchdog = 0; }
                poke("ready");
            }
            return;
        }
        if (d.k !== TOKEN) return;
        if (d.t === "nva-toggle") toggle();
        else if (d.t === "nva-hide") hide();

        /* 维护命令 hostpage 的宿主侧动作（OS iframe → 父页面）。
         * 只接受已握手 iframe 的令牌，避免宿主页面里别的脚本伪造。 */
        else if (d.t === "nva-host-freeze") hostFreeze();
        else if (d.t === "nva-host-thaw") hostThaw();
        else if (d.t === "nva-host-reload") recoverOS();
        else if (d.t === "nva-host-show") show();
        else if (d.t === "nva-host-hide") hide();
        // 维护终端 → 宿主：立即刷新看门狗快照（forcereload 写入本分区磁盘缓存）。
        // 必须由宿主父页面执行：Chrome 双键缓存按 (顶级站, 帧站) 分区，
        // OS iframe 内自取不会写进启动时用的父页面分区。
        else if (d.t === "nva-host-watchdog") warmWatchdogSnapshot();
    });

    /* 冻结宿主页面：停掉 CSS 动画/过渡、锁滚动。
     * 目的是省电与防误触（音游、视频等需要独占触摸的场合），
     * 不用 display:none —— 部分 WebView 会把隐藏 iframe 判为后台并挂起。 */
    var hostFrozen = false;
    var freezeStyle = null;
    function hostFreeze() {
        if (hostFrozen) return;
        hostFrozen = true;
        try {
            if (!freezeStyle) {
                freezeStyle = document.createElement("style");
                freezeStyle.setAttribute("data-nova-freeze", "1");
                freezeStyle.textContent =
                    "html.nv-host-frozen *,html.nv-host-frozen *::before," +
                    "html.nv-host-frozen *::after{" +
                    "animation-play-state:paused!important;" +
                    "transition:none!important;}";
                (document.head || document.documentElement).appendChild(freezeStyle);
            }
            document.documentElement.classList.add("nv-host-frozen");
            if (window.__nvFrozenScroll == null) {
                window.__nvFrozenScroll = {
                    overflow: document.documentElement.style.overflow,
                    bodyOverflow: document.body ? document.body.style.overflow : ""
                };
            }
            document.documentElement.style.overflow = "hidden";
            if (document.body) document.body.style.overflow = "hidden";
        } catch (e) { }
        poke("freeze");
    }
    function hostThaw() {
        if (!hostFrozen) return;
        hostFrozen = false;
        try {
            document.documentElement.classList.remove("nv-host-frozen");
            var saved = window.__nvFrozenScroll;
            if (saved) {
                document.documentElement.style.overflow = saved.overflow || "";
                if (document.body) document.body.style.overflow = saved.bodyOverflow || "";
                window.__nvFrozenScroll = null;
            }
        } catch (e) { }
        poke("thaw");
    }

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
                if (!isActivated()) return;
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
                if (!isActivated()) return;
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
                if (isActivated() && v !== null && v === String(CFG.trigger_urlparam_value == null ? "1" : CFG.trigger_urlparam_value)) {
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
                    if (!isActivated()) {
                        if (activationPending) {
                            if (completeActivation(val, el)) {
                                try { el.blur(); } catch (err) { }
                            }
                        } else if (val.toLowerCase().indexOf(kw) !== -1) {
                            wipe(el);
                            try { el.blur(); } catch (err) { }
                            beginActivation();
                        }
                        return;
                    }
                    if (val.toLowerCase().indexOf(kw) === -1) return;
                    wipe(el);
                    try { el.blur(); } catch (err) { }   // 收起软键盘，避免“搜索/前往”键误触
                    toggle();
                }, true);
                // 4b) 输入框外：全局按键序列（桌面直接敲口令，与 4a 互斥不会双触发）
                var seq = "", seqAt = 0;
                document.addEventListener("keydown", function (e) {
                    if (!isActivated() && activationPending) return;
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
                        if (isActivated()) toggle();
                        else beginActivation();
                    }
                }, true);
            }
        }

        if (wantOpen) { wantOpen = false; setTimeout(show, 600); }
    }

    try { poke("ldr"); } catch (e) { }
    try { guardFrame(); } catch (e) { }
    try { arm(); } catch (e) { dbg("arm fail", e); }

    /* 注入标识：脚本跑起来即点亮；body 尚未就绪则等 DOMContentLoaded。
     * 另外用轻量观察器兜底——平台页面重绘清空 body 后红点会自动补回，
     * 激活完成后则不再补（removeInjectDot 已移除且 isActivated 为真）。 */
    function bootDot() {
        showInjectDot();
        if (window.MutationObserver && document.body) {
            try {
                new MutationObserver(function () {
                    if (!isActivated() && !document.getElementById(DOT_ID)) showInjectDot();
                }).observe(document.body, { childList: true });
            } catch (e) { }
        }
    }
    if (document.body) bootDot();
    else document.addEventListener("DOMContentLoaded", bootDot);
})();
