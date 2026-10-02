/* ============================================================
 * Tzy OS · 设置
 * 外观（壁纸）/ 安全（锁屏密码入口）/ 网络状态 / 离线空间 / 关于
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  OS.registerApp({
    id: "settings",
    name: "设置",
    icon: "⚙️",
    tone: "tone-ink",
    version: "2.0.0",
    open: function (root, OS) { build(root, OS); }
  });

  function fmtBytes(n) {
    n = n || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function build(root, OS) {
    var page = OS.h("div", "nv-set");

    /* ---------- 外观 ---------- */
    var cardLook = OS.h("div", "nv-set-card");
    cardLook.appendChild(OS.h("h4", "", "外观"));
    var swRow = OS.h("div", "nv-set-row");
    var swBox = OS.h("div", "nv-set-swatches");
    var swatches = {};
    OS.ui.wallpapers().forEach(function (w) {
      var sw = OS.h("div", "nv-wp-sw nv-wp-sw-" + w.id);
      sw.appendChild(OS.h("span", "", w.name));
      sw.addEventListener("click", function () {
        OS.ui.setWallpaper(w.id);
        markSelected(w.id);
      });
      swatches[w.id] = sw;
      swBox.appendChild(sw);
    });
    function markSelected(id) {
      Object.keys(swatches).forEach(function (k) {
        swatches[k].className = "nv-wp-sw nv-wp-sw-" + k + (Number(k) === id ? " sel" : "");
      });
    }
    markSelected(OS.ui.wallpaper());
    swRow.appendChild(swBox);
    cardLook.appendChild(swRow);
    page.appendChild(cardLook);

    /* ---------- 安全 ---------- */
    var cardSec = OS.h("div", "nv-set-card");
    cardSec.appendChild(OS.h("h4", "", "安全"));
    var pinRow = OS.h("div", "nv-set-row");
    pinRow.appendChild(OS.h("span", "nv-set-k", "锁屏密码"));
    pinRow.appendChild(OS.h("span", "nv-set-v", "在锁屏页点「设密码」修改"));
    cardSec.appendChild(pinRow);
    var lockRow = OS.h("div", "nv-set-row");
    var btnLock = OS.h("button", "nv-btn primary", "立即锁屏");
    btnLock.addEventListener("click", function () { OS.lock(); });
    var spacer = OS.h("span", "nv-set-v");
    lockRow.appendChild(spacer);
    lockRow.appendChild(btnLock);
    cardSec.appendChild(lockRow);
    page.appendChild(cardSec);

    /* ---------- 网络 ---------- */
    var cardNet = OS.h("div", "nv-set-card");
    cardNet.appendChild(OS.h("h4", "", "网络（电脑服务通道）"));
    var rowCh = OS.h("div", "nv-set-row");
    rowCh.appendChild(OS.h("span", "nv-set-k", "当前通道"));
    var vCh = OS.h("span", "nv-set-v", "探测中…");
    rowCh.appendChild(vCh);
    cardNet.appendChild(rowCh);
    var rowWan = OS.h("div", "nv-set-row");
    rowWan.appendChild(OS.h("span", "nv-set-k", "电脑外网"));
    var vWan = OS.h("span", "nv-set-v", "—");
    rowWan.appendChild(vWan);
    cardNet.appendChild(rowWan);
    var rowNetBtn = OS.h("div", "nv-set-row");
    var spNet = OS.h("span", "nv-set-v");
    var btnReprobe = OS.h("button", "nv-btn", "重新探测");
    spNet.appendChild(btnReprobe);
    rowNetBtn.appendChild(spNet);
    cardNet.appendChild(rowNetBtn);
    page.appendChild(cardNet);

    function refreshNet() {
      var info = OS.net.info();
      var base = OS.net.base();
      vCh.textContent = OS.net.online()
        ? (base === "" ? "同源（劫持通道）" : "热点直连 " + base.replace(/^https?:\/\//, "").split("/")[0])
        : "离线（仅离线空间可用）";
      if (info && typeof info.wan === "boolean") {
        vWan.textContent = info.wan ? "通畅（可代取外网）" : "不通";
      } else {
        vWan.textContent = OS.net.online() ? "未知" : "—";
      }
    }
    btnReprobe.addEventListener("click", function () {
      vCh.textContent = "正在探测…";
      OS.net.probe(true).then(function () { refreshNet(); });
    });
    OS.on("net-change", refreshNet);
    refreshNet();

    /* ---------- 离线空间 ---------- */
    var cardVfs = OS.h("div", "nv-set-card");
    cardVfs.appendChild(OS.h("h4", "", "离线空间（本机存储）"));
    var rowUsage = OS.h("div", "nv-set-row");
    var vUsage = OS.h("span", "nv-set-v", "统计中…");
    rowUsage.appendChild(OS.h("span", "nv-set-k", "已用空间"));
    rowUsage.appendChild(vUsage);
    cardVfs.appendChild(rowUsage);
    var bar = OS.h("div", "nv-set-bar");
    var barI = document.createElement("i");
    barI.style.width = "0%";
    bar.appendChild(barI);
    cardVfs.appendChild(bar);
    var rowCnt = OS.h("div", "nv-set-row");
    rowCnt.appendChild(OS.h("span", "nv-set-k", "文件/目录"));
    var vCnt = OS.h("span", "nv-set-v", "");
    rowCnt.appendChild(vCnt);
    cardVfs.appendChild(rowCnt);
    var rowVfsBtn = OS.h("div", "nv-set-row");
    var spVfs = OS.h("span", "nv-set-v");
    var btnRefreshVfs = OS.h("button", "nv-btn", "刷新统计");
    var btnClearVfs = OS.h("button", "nv-btn", "清空离线空间");
    spVfs.appendChild(btnRefreshVfs);
    spVfs.appendChild(document.createTextNode(" "));
    spVfs.appendChild(btnClearVfs);
    rowVfsBtn.appendChild(spVfs);
    cardVfs.appendChild(rowVfsBtn);
    page.appendChild(cardVfs);

    function refreshUsage() {
      vUsage.textContent = "统计中…";
      OS.vfs.usage().then(function (u) {
        if (!u.ok) { vUsage.textContent = u.error || "统计失败"; return; }
        vUsage.textContent = fmtBytes(u.bytes) + " / 约 " + fmtBytes(u.max);
        vCnt.textContent = u.files + " 个文件 · " + u.dirs + " 个文件夹";
        var pct = Math.max(0, Math.min(100, Math.round(u.bytes / u.max * 100)));
        barI.style.width = pct + "%";
      }, function () { vUsage.textContent = "统计失败"; });
    }
    btnRefreshVfs.addEventListener("click", refreshUsage);
    btnClearVfs.addEventListener("click", function () {
      OS.dlg.confirm("将删除离线空间中的全部文件与文件夹，且不可恢复。确定继续？", "清空离线空间")
        .then(function (yes) {
          if (!yes) return;
          OS.vfs.clear().then(function () {
            refreshUsage();
            OS.toast("离线空间已清空");
          });
        });
    });
    refreshUsage();

    /* ---------- 系统维护（更新 / 备份，走电脑端挂载点同源接口） ---------- */
    var cardSys = OS.h("div", "nv-set-card");
    cardSys.appendChild(OS.h("h4", "", "系统维护"));
    var rowSysBtn = OS.h("div", "nv-set-row");
    var spSys = OS.h("span", "nv-set-v");
    var btnSysUpdate = OS.h("button", "nv-btn", "立即更新");
    var btnSysBackup = OS.h("button", "nv-btn", "下载备份");
    spSys.appendChild(btnSysUpdate);
    spSys.appendChild(document.createTextNode(" "));
    spSys.appendChild(btnSysBackup);
    rowSysBtn.appendChild(spSys);
    cardSys.appendChild(rowSysBtn);
    var sysHint = OS.h("div", "nv-set-hint",
      "立即更新：刷新电脑端页面文件的缓存版本号，平板下次打开自动取最新版，无需清缓存。 " +
      "下载备份：把电脑端 novaos2、配置与入口脚本打包为 zip 下载到本机。");
    cardSys.appendChild(sysHint);
    page.appendChild(cardSys);

    btnSysUpdate.addEventListener("click", function () {
      btnSysUpdate.disabled = true;
      OS.toast("正在检查更新…");
      OS.api.sysUpdate().then(function (r) {
        btnSysUpdate.disabled = false;
        if (r && r.ok) {
          OS.toast(r.changed > 0 ? "已刷新 " + r.changed + " 个文件版本，重开页面生效" : "已是最新");
        } else {
          OS.toast((r && r.error) || "更新失败：电脑服务不可用");
        }
      }, function () { btnSysUpdate.disabled = false; OS.toast("更新失败"); });
    });
    btnSysBackup.addEventListener("click", function () {
      btnSysBackup.disabled = true;
      OS.api.sysBackupUrl().then(function (url) {
        btnSysBackup.disabled = false;
        if (!url) { OS.toast("电脑服务不可用（离线模式）"); return; }
        var a = document.createElement("a");
        a.href = url;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        OS.toast("备份下载已开始");
      }, function () { btnSysBackup.disabled = false; OS.toast("备份失败"); });
    });

    /* ---------- 关于 ---------- */
    var cardAbout = OS.h("div", "nv-set-card");
    cardAbout.appendChild(OS.h("h4", "", "关于"));
    var apps = OS.apps();
    var list = OS.h("div", "nv-set-apps");
    apps.forEach(function (a) {
      list.appendChild(document.createTextNode(a.icon + " " + a.name + " · v" + a.version));
      list.appendChild(document.createElement("br"));
    });
    cardAbout.appendChild(list);
    var about = OS.h("div", "nv-set-about");
    about.innerHTML =
      "Tzy OS v1.0.0 · 极简网页操作系统<br>" +
      "Loshop &amp; Cpt<br>" +
      "纯本机依赖，无外网亦可启动；兼容华为平板 Chrome 99（ES6）。<br>" +
      "断 DNS 劫持后自动直连电脑热点 192.168.137.1，FTP/SMB/外网代取继续可用。";
    cardAbout.appendChild(about);
    page.appendChild(cardAbout);

    root.appendChild(page);
  }
})();
