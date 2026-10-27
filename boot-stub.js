/*
 * Tzy OS 引导器（stub）—— 注入到平台 manifest.build.*.js 的最前面。
 * 本文件内容必须保持恒定（只有 __BOOT_BASE__ 在注入时替换一次）：
 * 因为宿主 manifest 会被浏览器缓存一年，真正可变的逻辑全部放到
 * 挂载点上的 __boot__.js（no-cache，每次校验，随时可更新），
 * __boot__.snapshot.js 是一年长缓存快照，仅供“断劫持离线”时兜底。
 *
 * 加载次序：
 *   1) __boot__.js        劫持在线时永远拿到最新 loader+配置；
 *   2) 404 / 超时 / 响应不是我们的脚本 -> 改用 snapshot（磁盘缓存直接执行，
 *      浏览器对新鲜缓存根本不发请求，所以断劫持后真实 CDN 回什么都无所谓）。
 * 纯 ES5，兼容华为平板 Android 10 / Chrome 99 WebView。
 */
(function () {
    if (window.__nvaBoot) return;
    window.__nvaBoot = true;

    var BASE = "__BOOT_BASE__";
    var snapped = false;

    function useSnapshot() {
        if (snapped) return;
        snapped = true;
        // loader 首行就会置位；已在运行则绝不重复执行
        if (window.__novaStealth) return;
        try {
            var s = document.createElement("script");
            s.charset = "utf-8";
            s.src = BASE + "__boot__.snapshot.js";
            (document.head || document.documentElement).appendChild(s);
        } catch (e) { }
    }

    function head(fn) {
        // 断网时优先用一年长缓存的快照，避免先请求 no-cache 的 __boot__.js
        // 白等 3 秒超时（弱网/WebView 差异下还可能直接失败）。
        // 联网时仍走 __boot__.js，保证 loader/配置即时更新。
        try {
            if (navigator.onLine === false) { useSnapshot(); return; }
        } catch (e) { }
        try {
            var s = document.createElement("script");
            s.charset = "utf-8";
            s.src = BASE + "__boot__.js";
            // 404 / 网络失败 / 被真实 CDN 劫持成非脚本内容，全部走快照
            s.onerror = useSnapshot;
            s.onload = function () {
                // loader 是同步 IIFE，onload 时 __novaStealth 必已置位；
                // 否则说明返回的根本不是我们的脚本（如真实 CDN 的 200 HTML）。
                setTimeout(function () { if (!window.__novaStealth) useSnapshot(); }, 60);
            };
            (document.head || document.documentElement).appendChild(s);
            // 弱网/黑洞兜底：断劫持后请求会打到真实 CDN（可能返回 200 HTML
            // 或长时间挂起）。缩短到 1.2s，显著减少离线启动等待。
            setTimeout(useSnapshot, 1200);
        } catch (e) { useSnapshot(); }

        // 快照预热（父页面缓存分区）：见 warmSnapshot。首屏也走一次，
        // 保证断劫持那一刻磁盘里留有一年新鲜期内的副本。
        setTimeout(function () { warmSnapshot(); }, 2500);
        // 关键增强：每次「联网」都强制刷新一次看门狗快照（不只按小时）。
        // 断劫持/断网后磁盘里能启动的唯一凭据就是这份 snapshot；
        // 弱网平板常常开机即联网、随后很久不再触发 head()，仅靠每小时
        // 打点会错过窗口。这里在 online 事件上无条件补刷，保证任何一次
        // 成功联网后快照都是新鲜的。
        try {
            window.addEventListener("online", function () { warmSnapshot(true); });
        } catch (e4) { }
        // WebView 从后台/息屏恢复时不一定派发 online；visibilitychange 与
        // pageshow(bfcache) 也各补刷一次（受限频，见 warmSnapshot 内 THROTTLE）。
        try {
            document.addEventListener("visibilitychange", function () {
                if (!document.hidden) warmSnapshot();
            });
            window.addEventListener("pageshow", function () { warmSnapshot(); });
        } catch (e5) { }
    }

    /* 刷新看门狗快照。cache:"reload" 强制回源并写入磁盘缓存，
     * 用 r.ok 校验，404/半截响应不算成功。
     * force=true（来自 online 事件）跳过节流，必定刷新一次；
     * 其余调用按 THROTTLE 节流，避免 visibilitychange 抖动放大流量。 */
    var SNAP_KEY = "__nvaSnapAt";
    var THROTTLE_MS = 10 * 60 * 1000;   // 非 online 触发时最少间隔 10 分钟
    var warming = false;
    function warmSnapshot(force) {
        if (warming) return;
        try {
            if (!force && navigator.onLine === false) return;
            var last = 0;
            try { last = parseInt(localStorage.getItem(SNAP_KEY), 10) || 0; } catch (e0) { }
            if (!force && Date.now() - last < THROTTLE_MS) return;
        } catch (e1) { }
        warming = true;
        try {
            fetch(BASE + "__boot__.snapshot.js", { cache: "reload" })
                .then(function (r) {
                    if (r && r.ok) {
                        try { localStorage.setItem(SNAP_KEY, String(Date.now())); } catch (e2) { }
                    }
                }, function () { })
                .then(function () { warming = false; }, function () { warming = false; });
        } catch (e3) { warming = false; }
    }

    if (document.documentElement) head();
    else document.addEventListener("DOMContentLoaded", head);
})();
