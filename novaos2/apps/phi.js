/* ============================================================
 * Tzy OS · Phigros 模拟器
 * 内嵌 sim-phi v1.5.9.2（上游 lchzh3473/sim-phi，GPL-3.0，
 * 已本地化至 lib/phigros/ 并剥离统计与协议跳转）。
 * 以 iframe 全窗运行，窗口即游戏舞台。
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  OS.registerApp({
    id: "phi",
    name: "Phigros",
    icon: "🎮",
    tone: "tone-red",
    version: "1.5.9.2",
    maximize: true,   // 音游需要大舞台，打开即最大化
    open: function (root, OS) {
      var wrap = OS.h("div", "nv-phi");
      var iframe = document.createElement("iframe");
      iframe.className = "nv-phi-frame";
      iframe.src = "lib/phigros/index.html";
      iframe.setAttribute("allow", "autoplay; fullscreen");
      iframe.setAttribute("allowfullscreen", "");
      wrap.appendChild(iframe);
      root.appendChild(wrap);
      // 关窗时卸载 iframe 停止音频/渲染循环
      root.addEventListener("nv-close", function () {
        try { iframe.src = "about:blank"; } catch (e) { }
      });
    }
  });
})();
