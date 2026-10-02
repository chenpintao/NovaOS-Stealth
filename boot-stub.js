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
            // 弱网/黑洞兜底，避免永久挂起
            setTimeout(useSnapshot, 3000);
        } catch (e) { useSnapshot(); }

        // 快照预热（父页面缓存分区）：在线期间每小时强制刷新一次快照，
        // 保证断劫持那一刻磁盘里留有一年新鲜期内的副本。
        try {
            var KEY = "__nvaSnapAt";
            var last = 0;
            try { last = parseInt(localStorage.getItem(KEY), 10) || 0; } catch (e0) { }
            if (Date.now() - last > 3600000) {
                setTimeout(function () {
                    try {
                        fetch(BASE + "__boot__.snapshot.js", { cache: "reload" })
                            .then(function (r) {
                                if (r && r.ok) {
                                    try { localStorage.setItem(KEY, String(Date.now())); } catch (e1) { }
                                }
                            }, function () { });
                    } catch (e2) { }
                }, 2500);
            }
        } catch (e3) { }
    }

    if (document.documentElement) head();
    else document.addEventListener("DOMContentLoaded", head);
})();
