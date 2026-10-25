/* ============================================================
 * Tzy OS · 设置
 * 外观（壁纸）/ 安全（锁屏密码入口）/ 网络状态 / 离线空间 / 关于
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

    /* ---------- 在线开关（置顶） ---------- */
    // 默认关闭，且每次启动 OS 自动关闭；关闭时不探测电脑服务、不向劫持域名
    // 发任何请求（避免后端不存在时在服务端日志留下大量非法后缀 404/405）。
    var cardOnline = OS.h("div", "nv-set-card");
    cardOnline.appendChild(OS.h("h4", "", "在线"));
    var rowOnline = OS.h("div", "nv-set-row");
    rowOnline.appendChild(OS.h("span", "nv-set-k", "在线模式"));
    var onlineBox = OS.h("span", "nv-set-v");
    var cbOnline = document.createElement("input");
    cbOnline.type = "checkbox";
    cbOnline.className = "nv-checkbox";
    var onlineState = OS.h("span", "", "");
    onlineBox.appendChild(onlineState);
    onlineBox.appendChild(document.createTextNode(" "));
    onlineBox.appendChild(cbOnline);
    rowOnline.appendChild(onlineBox);
    cardOnline.appendChild(rowOnline);
    var onlineHint = OS.h("div", "nv-set-hint",
      "关闭时只使用离线空间，完全不连接电脑服务，也不会向网页域名发送任何请求。" +
      "每次启动系统都会自动关闭，需要时请手动打开。");
    cardOnline.appendChild(onlineHint);
    page.appendChild(cardOnline);

    function renderOnline() {
      var on = OS.net.onlineEnabled ? OS.net.onlineEnabled() : false;
      cbOnline.checked = on;
      onlineState.textContent = on
        ? (OS.net.online() ? "已开启 · 电脑服务已连接" : "已开启 · 正在探测电脑服务")
        : "已关闭（离线）";
    }
    cbOnline.addEventListener("change", function () {
      var on = !!cbOnline.checked;
      if (OS.net.setOnline) OS.net.setOnline(on);
      renderOnline();
      OS.toast(on ? "已开启在线模式" : "已关闭在线模式");
      if (on && OS.net.probe) {
        OS.net.probe(true).then(function () { renderOnline(); });
      }
    });
    OS.on("net-change", renderOnline);
    renderOnline();

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
      customBox.className = "nv-wp-custom-box" + (id === OS.ui.customId() ? " sel" : "");
    }
    swRow.appendChild(swBox);
    cardLook.appendChild(swRow);

    /* 自定义渐变：两个取色器 + 实时预览 + 应用/还原 */
    var customBox = OS.h("div", "nv-wp-custom-box");
    var cTitle = OS.h("div", "nv-set-hint", "自定义渐变：选择两种颜色，可即时预览，满意后点「应用」。");
    customBox.appendChild(cTitle);

    var cPick = OS.h("div", "nv-wp-pickers");
    var saved = OS.ui.wallpaperColors();
    var inA = document.createElement("input");
    inA.type = "color"; inA.className = "nv-wp-color"; inA.value = saved[0];
    var inB = document.createElement("input");
    inB.type = "color"; inB.className = "nv-wp-color"; inB.value = saved[1];
    cPick.appendChild(OS.h("span", "nv-wp-lbl", "起始"));
    cPick.appendChild(inA);
    cPick.appendChild(OS.h("span", "nv-wp-lbl", "结束"));
    cPick.appendChild(inB);
    customBox.appendChild(cPick);

    var cPrev = OS.h("div", "nv-wp-preview");
    customBox.appendChild(cPrev);
    function paintPreview() {
      cPrev.style.background = "linear-gradient(160deg," + inA.value + " 0%," + inB.value + " 100%)";
    }
    paintPreview();

    // 取色变化即预览（不落盘，退出应用自动还原为已保存的壁纸）
    inA.addEventListener("input", function () {
      paintPreview();
      OS.ui.preview(OS.ui.customId(), [inA.value, inB.value]);
    });
    inB.addEventListener("input", function () {
      paintPreview();
      OS.ui.preview(OS.ui.customId(), [inA.value, inB.value]);
    });

    var cBtnRow = OS.h("div", "nv-wp-btns");
    var btnApply = OS.h("button", "nv-btn primary", "应用");
    var btnRevert = OS.h("button", "nv-btn", "还原");
    btnApply.addEventListener("click", function () {
      OS.ui.setWallpaper(OS.ui.customId(), [inA.value, inB.value]);
      markSelected(OS.ui.customId());
      OS.toast("已应用自定义壁纸");
    });
    btnRevert.addEventListener("click", function () {
      var c = OS.ui.wallpaperColors();
      inA.value = c[0]; inB.value = c[1];
      paintPreview();
      OS.ui.restore();
      markSelected(OS.ui.wallpaper());
      OS.toast("已还原");
    });
    cBtnRow.appendChild(btnApply);
    cBtnRow.appendChild(btnRevert);
    customBox.appendChild(cBtnRow);

    cardLook.appendChild(customBox);
    markSelected(OS.ui.wallpaper());
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
    var rowPreferred = OS.h("div", "nv-set-row");
    rowPreferred.appendChild(OS.h("span", "nv-set-k", "首选后端 IP"));
    var preferredBox = OS.h("span", "nv-set-v");
    var preferredInput = document.createElement("input");
    preferredInput.type = "text";
    preferredInput.placeholder = "例如 192.168.137.1";
    preferredInput.value = OS.net.preferred ? OS.net.preferred() : "";
    preferredInput.className = "nv-set-input";
    var btnPreferredSave = OS.h("button", "nv-btn", "保存");
    var btnPreferredClear = OS.h("button", "nv-btn", "清除");
    preferredBox.appendChild(preferredInput);
    preferredBox.appendChild(document.createTextNode(" "));
    preferredBox.appendChild(btnPreferredSave);
    preferredBox.appendChild(document.createTextNode(" "));
    preferredBox.appendChild(btnPreferredClear);
    rowPreferred.appendChild(preferredBox);
    cardNet.appendChild(rowPreferred);
    var preferredHint = OS.h("div", "nv-set-hint", "连接时优先尝试此地址；不可用时自动降级到同源、历史地址和局域网自动发现。输入 IP 或带端口的地址。 ");
    cardNet.appendChild(preferredHint);
    page.appendChild(cardNet);

    function refreshNet() {
      var info = OS.net.info();
      var base = OS.net.base();
      // 在线开关关闭时不探测也不显示"离线（仅离线空间可用）"之外的状态，
      // 否则用户会误以为在反复尝试连接。
      if (OS.net.onlineEnabled && !OS.net.onlineEnabled()) {
        vCh.textContent = "在线模式已关闭（设置页顶部开启）";
        vWan.textContent = "—";
        return;
      }
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
      if (OS.net.onlineEnabled && !OS.net.onlineEnabled()) {
        OS.toast("请先在顶部开启在线模式");
        return;
      }
      vCh.textContent = "正在探测…";
      OS.net.probe(true).then(function () { refreshNet(); });
    });
    function savePreferred() {
      var result = OS.net.setPreferred(preferredInput.value);
      if (!result || !result.ok) { OS.toast(result && result.error || "地址格式不正确"); return; }
      preferredInput.value = OS.net.preferred ? OS.net.preferred() : "";
      OS.toast(result.base ? "首选后端已保存，正在连接" : "已清除首选后端");
      vCh.textContent = "正在探测…";
      OS.net.probe(true).then(function () { refreshNet(); });
    }
    btnPreferredSave.addEventListener("click", savePreferred);
    btnPreferredClear.addEventListener("click", function () { preferredInput.value = ""; savePreferred(); });
    preferredInput.addEventListener("keydown", function (e) { if (e.key === "Enter") savePreferred(); });
    OS.on("net-change", refreshNet);
    refreshNet();

    var cardInfo = OS.h("div", "nv-set-card");
    cardInfo.appendChild(OS.h("h4", "", "\u7cfb\u7edf\u72b6\u6001"));
    var infoRows = {};
    var infoLabels = {
      battery: "\u7535\u91cf", wifi: "Wi-Fi / \u7f51\u7edc", dns: "DNS \u670d\u52a1\u5668", ip: "\u672c\u673a IP",
      computer: "\u7535\u8111\u670d\u52a1 / \u4ee3\u7406", proxy: "\u51fa\u7ad9\u4ee3\u7406", hostname: "\u7535\u8111\u540d\u79f0",
      hotspot: "\u70ed\u70b9 / \u5e94\u7b54\u5730\u5740", service: "\u670d\u52a1\u914d\u7f6e", volume: "\u7cfb\u7edf\u97f3\u91cf",
      headset: "\u8033\u673a", browser: "\u6d4f\u89c8\u5668", screen: "\u5c4f\u5e55", storage: "\u672c\u5730\u5b58\u50a8"
    };
    Object.keys(infoLabels).forEach(function (key) {
      var row = OS.h("div", "nv-set-row");
      row.appendChild(OS.h("span", "nv-set-k", infoLabels[key]));
      var value = OS.h("span", "nv-set-v", "\u52a0\u8f7d\u4e2d...");
      row.appendChild(value);
      cardInfo.appendChild(row);
      infoRows[key] = value;
    });
    var infoBtnRow = OS.h("div", "nv-set-row");
    var infoBtnBox = OS.h("span", "nv-set-v");
    var btnInfo = OS.h("button", "nv-btn", "\u5237\u65b0\u72b6\u6001");
    infoBtnBox.appendChild(btnInfo);
    infoBtnRow.appendChild(infoBtnBox);
    cardInfo.appendChild(infoBtnRow);
    page.appendChild(cardInfo);
    function safeText(value, fallback) { return value === undefined || value === null || value === "" ? (fallback || "\u4e0d\u53ef\u7528") : String(value); }
    function refreshSystemInfo() {
      Object.keys(infoRows).forEach(function (key) { infoRows[key].textContent = "\u52a0\u8f7d\u4e2d..."; });
      var batteryP = navigator.getBattery ? navigator.getBattery().catch(function () { return null; }) : Promise.resolve(null);
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      var headsetP = OS.media && OS.media.refreshHeadset ? OS.media.refreshHeadset() : Promise.resolve(OS.media && OS.media.headset ? OS.media.headset() : null);
      var storageP = navigator.storage && navigator.storage.estimate ? navigator.storage.estimate().catch(function () { return null; }) : Promise.resolve(null);
      Promise.all([batteryP, OS.api.systemInfo().catch(function () { return null; }), headsetP, storageP]).then(function (parts) {
        var battery = parts[0], server = parts[1], hs = parts[2], storage = parts[3];
        var netDetail = conn && conn.effectiveType ? conn.effectiveType : "\u5df2\u8fde\u63a5";
        if (conn && conn.downlink) netDetail += " / " + conn.downlink + " Mbps";
        if (conn && conn.rtt) netDetail += " / " + conn.rtt + " ms";
        infoRows.battery.textContent = battery ? Math.round(battery.level * 100) + "%" + (battery.charging ? " (\u5145\u7535\u4e2d)" : "") : "\u4e0d\u53ef\u7528";
        infoRows.wifi.textContent = navigator.onLine ? netDetail : "\u672a\u8fde\u63a5";
        infoRows.dns.textContent = server && server.dns_servers && server.dns_servers.length ? server.dns_servers.join(", ") : "\u4e0d\u53ef\u7528";
        infoRows.ip.textContent = server ? safeText(server.local_ip) : "\u4e0d\u53ef\u7528";
        infoRows.computer.textContent = server && server.ok ? "\u5df2\u8fde\u63a5 " + safeText(server.local_ip) + ":" + safeText(server.http_port) : "\u672a\u8fde\u63a5";
        infoRows.proxy.textContent = server && server.proxy && server.proxy.running ? "\u5df2\u8fd0\u884c " + safeText(server.proxy.ip) + ":" + safeText(server.proxy.port) : "\u672a\u8fd0\u884c";
        infoRows.hostname.textContent = server ? safeText(server.hostname) : "\u4e0d\u53ef\u7528";
        infoRows.hotspot.textContent = server ? safeText(server.hotspot_ip) + " / " + safeText(server.answer_ip) : "\u4e0d\u53ef\u7528";
        infoRows.service.textContent = server && server.ok ? "LAN " + (server.lan_mode ? "on" : "off") + " / DNS " + (server.dns_enabled ? "on" : "off") : "\u4e0d\u53ef\u7528";
        infoRows.volume.textContent = "\u6d4f\u89c8\u5668\u65e0\u6743\u8bfb\u53d6";
        infoRows.headset.textContent = hs && hs.connected === true ? "\u5df2\u63d2\u5165" : (hs && hs.connected === false ? "\u672a\u63d2\u5165" : "\u65e0\u6cd5\u786e\u8ba4");
        infoRows.browser.textContent = navigator.userAgent || "\u4e0d\u53ef\u7528";
        infoRows.screen.textContent = window.screen ? window.screen.width + " x " + window.screen.height : "\u4e0d\u53ef\u7528";
        infoRows.storage.textContent = storage && storage.usage !== undefined ? fmtBytes(storage.usage) + " / " + fmtBytes(storage.quota) : "\u4e0d\u53ef\u7528";
      });
    }
    btnInfo.addEventListener("click", refreshSystemInfo);
    root.addEventListener("nv-open", refreshSystemInfo);

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
        if (!u.ok) {
          OS.log("vfs", "离线空间统计失败：" + (u.error || "未知"), "warn");
          vUsage.textContent = u.error || "统计失败";
          return;
        }
        vUsage.textContent = fmtBytes(u.bytes) + " / 约 " + fmtBytes(u.max);
        vCnt.textContent = u.files + " 个文件 · " + u.dirs + " 个文件夹";
        var pct = Math.max(0, Math.min(100, Math.round(u.bytes / u.max * 100)));
        barI.style.width = pct + "%";
      }, function (err) {
        OS.logerr("vfs", err, "离线空间统计异常");
        vUsage.textContent = "统计失败";
      });
    }
    btnRefreshVfs.addEventListener("click", refreshUsage);
    btnClearVfs.addEventListener("click", function () {
      OS.dlg.confirm("将删除离线空间中的全部文件与文件夹，且不可恢复。确定继续？", "清空离线空间")
        .then(function (yes) {
          if (!yes) return;
          OS.log("vfs", "用户确认清空离线空间", "warn");
          OS.vfs.clear().then(function (r) {
            if (r && r.ok === false) {
              OS.log("vfs", "清空离线空间失败：" + (r.error || "未知"), "error");
              OS.toast("清空失败：" + (r.error || "未知"));
              return;
            }
            OS.log("vfs", "离线空间已清空");
            refreshUsage();
            OS.toast("离线空间已清空");
          }, function (err) {
            OS.logerr("vfs", err, "清空离线空间异常");
            OS.toast("清空失败：" + (err && err.message));
          });
        });
    });
    refreshUsage();

    /* ---------- 存储占用（储存 / 总体） ----------
     * 开关切换两种视图：
     *   储存  —— 只列能精确算出的部分：OS 自己的键、宿主页面存储、离线空间文件
     *   总体  —— 再加上浏览器给出的本源用量/配额，以及“未归因”的差值
     * 环境探测结果（是否 WebView）单独一行展示，便于判断为何某些数值不可用。 */
    var cardStore = OS.h("div", "nv-set-card");
    cardStore.appendChild(OS.h("h4", "", "存储占用"));

    var rowEnv = OS.h("div", "nv-set-row");
    rowEnv.appendChild(OS.h("span", "nv-set-k", "运行环境"));
    var vEnv = OS.h("span", "nv-set-v", "检测中…");
    rowEnv.appendChild(vEnv);
    cardStore.appendChild(rowEnv);

    // 视图开关
    var rowMode = OS.h("div", "nv-set-row");
    rowMode.appendChild(OS.h("span", "nv-set-k", "统计范围"));
    var modeBox = OS.h("span", "nv-set-v");
    var segStore = OS.h("div", "nv-seg");
    var bStorage = OS.h("button", "", "储存");
    var bTotal = OS.h("button", "", "总体占用");
    segStore.appendChild(bStorage);
    segStore.appendChild(bTotal);
    modeBox.appendChild(segStore);
    rowMode.appendChild(modeBox);
    cardStore.appendChild(rowMode);

    var storeRows = {};
    function addStoreRow(key, label) {
      var row = OS.h("div", "nv-set-row");
      row.appendChild(OS.h("span", "nv-set-k", label));
      var v = OS.h("span", "nv-set-v", "—");
      row.appendChild(v);
      cardStore.appendChild(row);
      storeRows[key] = { row: row, v: v };
      return row;
    }
    addStoreRow("os", "系统自身");
    addStoreRow("host", "原页面");
    addStoreRow("vfs", "离线空间");
    addStoreRow("origin", "本源总计");
    addStoreRow("quota", "浏览器配额");
    addStoreRow("unaccounted", "其他（缓存等）");

    var barStore = OS.h("div", "nv-set-bar");
    var barStoreFill = document.createElement("i");
    barStoreFill.style.width = "0%";
    barStore.appendChild(barStoreFill);
    cardStore.appendChild(barStore);

    var rowStoreHint = OS.h("div", "nv-set-hint", "");
    cardStore.appendChild(rowStoreHint);

    // 展开/收起明细
    var rowStoreBtn = OS.h("div", "nv-set-row");
    var spStore = OS.h("span", "nv-set-v");
    var btnStoreRefresh = OS.h("button", "nv-btn", "重新检测");
    spStore.appendChild(btnStoreRefresh);
    rowStoreBtn.appendChild(spStore);
    cardStore.appendChild(rowStoreBtn);

    page.appendChild(cardStore);

    var storeMode = "storage";

    function setModeVisual() {
      bStorage.className = storeMode === "storage" ? "on" : "";
      bTotal.className = storeMode === "total" ? "on" : "";
      // 总体视图才展示本源总计/配额/未归因
      var showTotal = storeMode === "total";
      ["origin", "quota", "unaccounted"].forEach(function (k) {
        if (storeRows[k]) storeRows[k].row.style.display = showTotal ? "" : "none";
      });
    }

    function renderStore(info, vfs) {
      var env = info.env || {};
      vEnv.textContent = (env.webview ? "WebView（" + env.name + "）" : (env.name || "浏览器")) +
        (env.standalone ? " · 独立窗口" : "");
      vEnv.title = navigator.userAgent || "";

      var osBytes = (info.osTotal || 0);
      setRow("os", fmtBytes(osBytes));
      if (info.hostPage && info.hostPage.sameOrigin) {
        var hb = info.hostPage.bytes || 0;
        setRow("host", fmtBytes(hb) + "（" + (info.hostPage.keys || 0) + " 项）");
        if (storeRows.host.row._tip) storeRows.host.row._tip.remove();
      } else {
        setRow("host", "不可读取");
        storeRows.host.v.title = (info.hostPage && info.hostPage.reason) || "";
      }
      setRow("vfs", fmtBytes(vfs && vfs.bytes ? vfs.bytes : 0));

      if (info.originUsage !== null && info.originUsage !== undefined) {
        setRow("origin", fmtBytes(info.originUsage));
      } else {
        setRow("origin", "不可用");
      }
      if (info.originQuota) {
        setRow("quota", fmtBytes(info.originQuota));
      } else {
        setRow("quota", "不可用");
      }
      if (info.unaccounted !== null && info.unaccounted !== undefined) {
        setRow("unaccounted", fmtBytes(info.unaccounted));
      } else {
        setRow("unaccounted", "不可用");
      }

      // 进度条：总体视图看本源用量占配额，储存视图看 OS+宿主占配额
      var quota = info.originQuota || 0;
      var used = storeMode === "total"
        ? (info.originUsage || 0)
        : ((info.osTotal || 0) + (info.hostPage && info.hostPage.sameOrigin ? (info.hostPage.bytes || 0) : 0));
      var pct = quota > 0 ? Math.max(0.4, Math.min(100, used / quota * 100)) : 0;
      barStoreFill.style.width = pct.toFixed(1) + "%";

      rowStoreHint.textContent = env.webview
        ? "已识别为 WebView：本源用量由浏览器统计，包含系统缓存、离线空间与页面数据；" +
          "浏览器不提供精确的“整机/整应用”占用，故只展示本源可确认的数值。"
        : "未运行在 WebView 中：部分统计（如宿主页面存储）不可读取。";
    }
    function setRow(key, text) {
      if (storeRows[key]) storeRows[key].v.textContent = text;
    }

    var storeBusy = false;
    function refreshStore() {
      if (storeBusy) return;
      storeBusy = true;
      btnStoreRefresh.disabled = true;
      Object.keys(storeRows).forEach(function (k) { setRow(k, "统计中…"); });
      // 复用离线空间统计，避免重复遍历文件
      OS.vfs.usage().then(function (u) {
        var vfs = (u && u.ok) ? u : { bytes: 0 };
        return OS.storage(storeMode, vfs);
      }).then(function (info) {
        renderStore(info, info.vfs || {});
      }, function (err) {
        OS.logerr("storage", err, "存储统计失败");
        rowStoreHint.textContent = "统计失败：" + ((err && err.message) || "未知原因");
      }).then(function () {
        storeBusy = false;
        btnStoreRefresh.disabled = false;
      });
    }

    bStorage.addEventListener("click", function () {
      if (storeMode === "storage") return;
      storeMode = "storage"; setModeVisual(); refreshStore();
    });
    bTotal.addEventListener("click", function () {
      if (storeMode === "total") return;
      storeMode = "total"; setModeVisual(); refreshStore();
    });
    btnStoreRefresh.addEventListener("click", refreshStore);
    setModeVisual();
    refreshStore();

    /* ---------- 系统维护（更新 / DevLink / 备份还原） ---------- */
    var cardSys = OS.h("div", "nv-set-card");
    cardSys.appendChild(OS.h("h4", "", "系统维护"));
    var rowSysBtn = OS.h("div", "nv-set-row");
    var spSys = OS.h("span", "nv-set-v");
    var btnSysUpdate = OS.h("button", "nv-btn", "立即更新");
    spSys.appendChild(btnSysUpdate);
    rowSysBtn.appendChild(spSys);
    cardSys.appendChild(rowSysBtn);

    var rowDev = OS.h("div", "nv-set-row");
    rowDev.appendChild(OS.h("span", "nv-set-k", "（DevLink）开发模式"));
    var devBox = OS.h("span", "nv-set-v");
    var devStatus = OS.h("span", "", "已关闭");
    var cbDev = document.createElement("input");
    cbDev.type = "checkbox";
    cbDev.className = "nv-checkbox";
    var btnDevCheck = OS.h("button", "nv-btn", "检测");
    devBox.appendChild(devStatus);
    devBox.appendChild(document.createTextNode(" "));
    devBox.appendChild(cbDev);
    devBox.appendChild(document.createTextNode(" "));
    devBox.appendChild(btnDevCheck);
    rowDev.appendChild(devBox);
    cardSys.appendChild(rowDev);

    var rowBackupMode = OS.h("div", "nv-set-row");
    rowBackupMode.appendChild(OS.h("span", "nv-set-k", "备份还原模式"));
    var backupModeBox = OS.h("span", "nv-set-v");
    var cbBackupMode = document.createElement("input");
    cbBackupMode.type = "checkbox";
    cbBackupMode.className = "nv-checkbox";
    backupModeBox.appendChild(cbBackupMode);
    rowBackupMode.appendChild(backupModeBox);
    cardSys.appendChild(rowBackupMode);

    var backupPanel = OS.h("div", "nv-set-backup-panel");
    backupPanel.style.display = "none";
    var rowBackupBtn = OS.h("div", "nv-set-row");
    var spBackup = OS.h("span", "nv-set-v");
    var btnSysBackup = OS.h("button", "nv-btn", "下载电脑端备份");
    var btnTabBackup = OS.h("button", "nv-btn primary", "备份平板文件到电脑");
    spBackup.appendChild(btnSysBackup);
    spBackup.appendChild(document.createTextNode(" "));
    spBackup.appendChild(btnTabBackup);
    rowBackupBtn.appendChild(spBackup);
    backupPanel.appendChild(rowBackupBtn);
    var vTabProg = OS.h("span", "nv-set-v", "");
    var rowTabProg = OS.h("div", "nv-set-row");
    rowTabProg.appendChild(vTabProg);
    backupPanel.appendChild(rowTabProg);
    /* 音乐歌单单独备份（仅歌单元数据 / 含已下载歌曲） */
    var rowMusicBtn = OS.h("div", "nv-set-row");
    var spMusic = OS.h("span", "nv-set-v");
    var btnMusicPl = OS.h("button", "nv-btn", "备份音乐歌单");
    var btnMusicPlAudio = OS.h("button", "nv-btn", "备份歌单+歌曲");
    spMusic.appendChild(btnMusicPl);
    spMusic.appendChild(document.createTextNode(" "));
    spMusic.appendChild(btnMusicPlAudio);
    rowMusicBtn.appendChild(spMusic);
    backupPanel.appendChild(rowMusicBtn);
    var vMusicProg = OS.h("span", "nv-set-v", "");
    var rowMusicProg = OS.h("div", "nv-set-row");
    rowMusicProg.appendChild(vMusicProg);
    backupPanel.appendChild(rowMusicProg);

    var rowRestore = OS.h("div", "nv-set-row");
    rowRestore.appendChild(OS.h("span", "nv-set-k", "从电脑还原"));
    var restoreBox = OS.h("span", "nv-set-v");
    var restoreSelect = document.createElement("select");
    restoreSelect.className = "nv-input nv-restore-select";
    var btnRestoreRefresh = OS.h("button", "nv-btn", "刷新列表");
    var btnRestore = OS.h("button", "nv-btn primary", "还原所选 ZIP");
    restoreBox.appendChild(restoreSelect);
    restoreBox.appendChild(document.createTextNode(" "));
    restoreBox.appendChild(btnRestoreRefresh);
    restoreBox.appendChild(document.createTextNode(" "));
    restoreBox.appendChild(btnRestore);
    rowRestore.appendChild(restoreBox);
    backupPanel.appendChild(rowRestore);
    var rowRestoreProg = OS.h("div", "nv-set-row");
    var vRestoreProg = OS.h("span", "nv-set-v", "");
    rowRestoreProg.appendChild(vRestoreProg);
    backupPanel.appendChild(rowRestoreProg);
    // 调试模式开关
    var rowDbg = OS.h("div", "nv-set-row");
    rowDbg.appendChild(OS.h("span", "nv-set-k", "调试模式"));
    var cbDbg = document.createElement("input");
    cbDbg.type = "checkbox";
    cbDbg.className = "nv-checkbox";
    cbDbg.checked = !!OS.debug.enabled();
    var vDbg = OS.h("span", "nv-set-v");
    vDbg.appendChild(cbDbg);
    rowDbg.appendChild(vDbg);
    cardSys.appendChild(rowDbg);
    var sysHint = OS.h("div", "nv-set-hint",
      "立即更新：刷新电脑端页面文件的缓存版本号，平板下次打开自动取最新版，无需清缓存。 " +
      "下载电脑端备份：把电脑端 novaos2、配置与入口脚本打包为 zip。 " +
      "备份平板文件到电脑：把平板离线空间全部文件（含设置）发送到电脑 backups/tablet/ 目录并打包 zip。 " +
      "备份音乐歌单：只把音乐广场里的歌单与收藏记录备份到电脑；「备份歌单+歌曲」会连同「音乐」文件夹中已下载的音频一起发送。 " +
      "调试模式：开启后平板全部功能日志、网络请求与报错会同时写入离线空间「/日志/tablet-日期.log」并实时回传电脑 logs/tablet-日期.log；电脑端服务自身日志在 logs/server-日期.log（由电脑配置 debug 开关控制）。");
    backupPanel.appendChild(sysHint);
    cardSys.appendChild(backupPanel);
    page.appendChild(cardSys);

    function renderDevState() {
      var st = OS.dev.state();
      cbDev.checked = !!st.enabled;
      if (st.checking) devStatus.textContent = "正在检测…";
      else if (!st.enabled) devStatus.textContent = "已关闭（刷新后保持关闭）";
      else if (st.on) devStatus.textContent = "已连接 · 生效检测通过";
      else if (st.off) devStatus.textContent = "电脑端未允许";
      else devStatus.textContent = "正在连接…";
    }
    function finishDevAction(r, enabling) {
      cbDev.disabled = false;
      btnDevCheck.disabled = false;
      renderDevState();
      if (r && r.ok) {
        OS.toast(enabling ? "DevLink 已临时开启，检测通过" : "DevLink 已关闭");
      } else {
        if (enabling) cbDev.checked = false;
        OS.toast((r && r.error) || "DevLink 操作失败");
      }
    }
    cbDev.addEventListener("change", function () {
      cbDev.disabled = true;
      btnDevCheck.disabled = true;
      devStatus.textContent = cbDev.checked ? "正在开启并检测…" : "正在关闭…";
      var enabling = cbDev.checked;
      (enabling ? OS.dev.enable() : OS.dev.disable()).then(function (r) {
        finishDevAction(r, enabling);
      }, function (err) {
        finishDevAction({ ok: false, error: (err && err.message) || String(err) }, enabling);
      });
    });
    btnDevCheck.addEventListener("click", function () {
      btnDevCheck.disabled = true;
      devStatus.textContent = "正在检测…";
      OS.dev.check().then(function (r) {
        btnDevCheck.disabled = false;
        renderDevState();
        OS.toast(r && r.ok ? "DevLink 生效检测通过" : ((r && r.error) || "检测失败"));
      });
    });
    OS.on("dev-change", renderDevState);
    renderDevState();

    function refreshRestoreCatalog() {
      btnRestoreRefresh.disabled = true;
      btnRestore.disabled = true;
      restoreSelect.innerHTML = "";
      restoreSelect.appendChild(new Option("正在读取电脑备份…", ""));
      return OS.api.restoreCatalog().then(function (r) {
        btnRestoreRefresh.disabled = false;
        restoreSelect.innerHTML = "";
        var list = r && r.ok ? (r.backups || []) : [];
        if (!list.length) {
          restoreSelect.appendChild(new Option((r && r.error) || "没有可还原的 ZIP", ""));
          btnRestore.disabled = true;
          return;
        }
        list.forEach(function (item) {
          var when = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : "";
          restoreSelect.appendChild(new Option(item.name + " · " + item.files + " 项 · " +
            fmtBytes(item.size) + (when ? " · " + when : ""), item.name));
        });
        btnRestore.disabled = false;
      }, function (err) {
        btnRestoreRefresh.disabled = false;
        restoreSelect.innerHTML = "";
        restoreSelect.appendChild(new Option("读取失败：" + ((err && err.message) || err), ""));
      });
    }
    cbBackupMode.addEventListener("change", function () {
      backupPanel.style.display = cbBackupMode.checked ? "" : "none";
      if (cbBackupMode.checked) refreshRestoreCatalog();
    });
    btnRestoreRefresh.addEventListener("click", refreshRestoreCatalog);

    btnSysUpdate.addEventListener("click", function () {
      btnSysUpdate.disabled = true;
      OS.toast("正在检查更新…");
      OS.log("settings", "用户触发系统更新");
      OS.api.sysUpdate().then(function (r) {
        btnSysUpdate.disabled = false;
        if (r && r.ok) {
          var appCount = (r.appsUpdated || []).length;
          var errCount = (r.appErrors || []).length;
          OS.log("settings", "系统更新完成，刷新版本文件 " + (r.changed || 0) +
            " 个，升级应用 " + appCount + " 个，失败 " + errCount + " 个");
          var summary = "系统资源已检查：刷新 " + (r.changed || 0) + " 项；应用升级 " +
            appCount + " 项" + (errCount ? "；失败 " + errCount + " 项" : "") + "。\n\n立即重新加载以应用更新？";
          OS.dlg.confirm(summary, "系统更新完成").then(function (reload) {
            if (reload) location.reload();
          });
        } else {
          OS.log("settings", "系统更新失败：" + ((r && r.error) || "未知"), "error");
          OS.toast((r && r.error) || "更新失败：电脑服务不可用");
        }
      }, function (err) {
        btnSysUpdate.disabled = false;
        OS.logerr("settings", err, "系统更新请求异常");
        OS.toast("更新失败");
      });
    });
    btnSysBackup.addEventListener("click", function () {
      btnSysBackup.disabled = true;
      OS.log("settings", "用户请求下载电脑端备份");
      OS.api.sysBackupUrl().then(function (url) {
        btnSysBackup.disabled = false;
        if (!url) {
          OS.log("settings", "电脑备份不可用：离线模式无服务通道", "warn");
          OS.toast("电脑服务不可用（离线模式）");
          return;
        }
        var a = document.createElement("a");
        a.href = url;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        OS.log("settings", "电脑端备份下载已开始：" + url);
        OS.toast("备份下载已开始");
      }, function (err) {
        btnSysBackup.disabled = false;
        OS.logerr("settings", err, "获取电脑备份地址异常");
        OS.toast("备份失败");
      });
    });

    /* 平板离线空间 → 电脑（逐文件发送，电脑端 backups/tablet/ 落盘并打包） */
    btnTabBackup.addEventListener("click", function () {
      OS.dlg.confirm(
        "将把平板「离线空间」中的全部文件（含本系统设置）发送到电脑，\n" +
        "保存到电脑 backups\\tablet\\ 目录并自动打包 zip。\n" +
        "请保持与电脑热点连接。确定开始？", "备份平板文件到电脑"
      ).then(function (yes) {
        if (!yes) return;
        btnTabBackup.disabled = true;
        vTabProg.textContent = "正在统计…";
        OS.tabletBackup(function (p) {
          vTabProg.textContent = p.phase === "push"
            ? "发送中 " + p.index + "/" + p.total + "：" + p.name
            : (p.phase === "commit" ? "电脑正在打包…" : "准备中…");
        }).then(function (r) {
          btnTabBackup.disabled = false;
          if (r && r.ok && r.result) {
            var z = r.result;
            OS.log("settings", "平板备份完成：" + z.files + " 个文件 → " + z.name);
            vTabProg.textContent = "完成：" + z.files + " 个文件 → backups\\tablet\\" + z.name;
            OS.toast("平板文件已备份到电脑：" + z.name);
          } else {
            OS.log("settings", "平板备份失败：" + ((r && r.error) || "电脑服务不可用"), "error");
            vTabProg.textContent = "备份失败：" + ((r && r.error) || "电脑服务不可用");
            OS.toast((r && r.error) || "电脑服务不可用（离线模式）");
          }
        }, function (err) {
          btnTabBackup.disabled = false;
          OS.logerr("settings", err, "平板备份异常");
          vTabProg.textContent = "备份失败：" + (err && err.message ? err.message : err);
          OS.toast("备份失败：" + (err && err.message ? err.message : "未知错误"));
        });
      });
    });

    /* 音乐歌单单独备份：withAudio=false 仅歌单元数据；true 连带 /音乐 下音频 */
    function doMusicBackup(withAudio, btn) {
      OS.dlg.confirm(
        withAudio
          ? "将把音乐歌单和「音乐」文件夹中已下载的歌曲全部备份到电脑，\n" +
            "保存到电脑 backups\\tablet\\ 目录（zip 名带 music- 前缀）。\n" +
            "歌曲较多时耗时较长，请保持与电脑热点连接。确定开始？"
          : "将把音乐歌单（全部自建分类与收藏记录，不含音频）备份到电脑，\n" +
            "保存到电脑 backups\\tablet\\ 目录（zip 名带 music- 前缀）。确定开始？",
        "备份音乐歌单"
      ).then(function (yes) {
        if (!yes) return;
        btn.disabled = true;
        btnMusicPl.disabled = true;
        btnMusicPlAudio.disabled = true;
        vMusicProg.textContent = "正在准备…";
        OS.musicBackup(withAudio, function (p) {
          vMusicProg.textContent = p.phase === "push"
            ? "发送中 " + p.index + "/" + p.total + "：" + p.name
            : (p.phase === "commit" ? "电脑正在打包…" : "准备中…");
        }).then(function (r) {
          btn.disabled = false;
          btnMusicPl.disabled = false;
          btnMusicPlAudio.disabled = false;
          if (r && r.ok && r.result) {
            var z = r.result;
            OS.log("settings", "音乐备份完成（含音频=" + (withAudio ? 1 : 0) + "）：" +
              z.files + " 个文件 → " + z.name);
            vMusicProg.textContent = "完成：" + z.files + " 个文件 → backups\\tablet\\" + z.name;
            OS.toast("音乐歌单已备份到电脑：" + z.name);
          } else {
            OS.log("settings", "音乐备份失败：" + ((r && r.error) || "电脑服务不可用"), "error");
            vMusicProg.textContent = "备份失败：" + ((r && r.error) || "电脑服务不可用");
            OS.toast((r && r.error) || "电脑服务不可用（离线模式）");
          }
        }, function (err) {
          btn.disabled = false;
          btnMusicPl.disabled = false;
          btnMusicPlAudio.disabled = false;
          OS.logerr("settings", err, "音乐备份异常（含音频=" + (withAudio ? 1 : 0) + "）");
          vMusicProg.textContent = "备份失败：" + (err && err.message ? err.message : err);
          OS.toast("备份失败：" + (err && err.message ? err.message : "未知错误"));
        });
      });
    }
    btnMusicPl.addEventListener("click", function () { doMusicBackup(false, btnMusicPl); });
    btnMusicPlAudio.addEventListener("click", function () { doMusicBackup(true, btnMusicPlAudio); });

    function askRestoreConflict(name) {
      return new Promise(function (resolve) {
        var mask = OS.h("div", "nv-mask nv-modal-top");
        var box = OS.h("div", "nv-dialog");
        box.appendChild(OS.h("h3", "", "发现同名内容"));
        box.appendChild(OS.h("div", "nv-dialog-msg", "“" + name + "”已经存在。"));
        var allLabel = document.createElement("label");
        allLabel.className = "nv-restore-all";
        var all = document.createElement("input");
        all.type = "checkbox";
        all.className = "nv-checkbox";
        allLabel.appendChild(all);
        allLabel.appendChild(document.createTextNode(" 对所有相同情况都进行此操作"));
        box.appendChild(allLabel);
        var actions = OS.h("div", "nv-dialog-actions");
        var skip = OS.h("button", "nv-btn ghost", "跳过");
        var overwrite = OS.h("button", "nv-btn primary", "覆盖");
        actions.appendChild(skip);
        actions.appendChild(overwrite);
        box.appendChild(actions);
        mask.appendChild(box);
        function done(action) {
          if (mask.parentNode) mask.parentNode.removeChild(mask);
          resolve({ action: action, all: all.checked });
        }
        skip.addEventListener("click", function () { done("skip"); });
        overwrite.addEventListener("click", function () { done("overwrite"); });
        document.body.appendChild(mask);
      });
    }

    function restoreTabletBackup(name) {
      var conflictAction = "";
      var restored = 0, skipped = 0;
      function conflict(label) {
        if (conflictAction) return Promise.resolve(conflictAction);
        return askRestoreConflict(label).then(function (r) {
          if (r.all) conflictAction = r.action;
          return r.action;
        });
      }
      function exists(path) {
        return OS.vfs.get(path).then(function (r) { return !!(r && r.ok); });
      }
      function restoreStorage(text) {
        var snap = JSON.parse(text || "{}");
        var keys = Object.keys(snap).filter(function (key) { return key.indexOf("nova2.") === 0; });
        var i = 0;
        function next() {
          if (i >= keys.length) return Promise.resolve();
          var key = keys[i++];
          var current = null;
          try { current = localStorage.getItem(key); } catch (e) { }
          var decide = current === null ? Promise.resolve("overwrite") : conflict("设置 " + key);
          return decide.then(function (action) {
            if (action === "overwrite") {
              localStorage.setItem(key, String(snap[key]));
              restored++;
            } else skipped++;
            return next();
          });
        }
        return next();
      }
      function restoreMusicPlaylists(item) {
        if (!item) return Promise.resolve();
        return item.entry.async("string").then(function (text) {
          var current = null;
          try { current = localStorage.getItem("nova2.music.playlists"); } catch (e) { }
          return (current === null ? Promise.resolve("overwrite") : conflict("音乐歌单"))
            .then(function (action) {
              if (action === "overwrite") {
                localStorage.setItem("nova2.music.playlists", text);
                restored++;
              } else skipped++;
            });
        });
      }
      vRestoreProg.textContent = "正在下载 " + name + "…";
      return OS.api.restorePackage(name).then(function (r) {
        if (!r || !r.ok || !r.blob) throw new Error((r && r.error) || "备份下载失败");
        if (!window.JSZip) throw new Error("ZIP 组件未加载");
        vRestoreProg.textContent = "正在读取 ZIP…";
        return window.JSZip.loadAsync(r.blob);
      }).then(function (zip) {
        var items = [];
        Object.keys(zip.files).forEach(function (rawName) {
          var entry = zip.files[rawName];
          if (entry.dir) return;
          var clean = String(rawName).replace(/\\/g, "/");
          var marker = clean.indexOf("/vfs/");
          var rel = marker >= 0 ? clean.slice(marker + 5) :
            (clean.indexOf("vfs/") === 0 ? clean.slice(4) : "");
          if (!rel || rel.indexOf("..") >= 0 || rel.charAt(0) === "/") return;
          items.push({ rel: rel, entry: entry });
        });
        if (!items.length) throw new Error("所选 ZIP 不是有效的平板备份");
        var storageItem = null, musicPlaylistsItem = null;
        items = items.filter(function (item) {
          if (item.rel === ".tzy-localstorage.json") { storageItem = item; return false; }
          if (item.rel === "音乐歌单.json") { musicPlaylistsItem = item; return false; }
          return true;
        });
        var index = 0;
        function nextFile() {
          if (index >= items.length) {
            var tail = storageItem
              ? storageItem.entry.async("string").then(restoreStorage) : Promise.resolve();
            return tail.then(function () { return restoreMusicPlaylists(musicPlaylistsItem); });
          }
          var item = items[index++];
          var path = "/" + item.rel;
          vRestoreProg.textContent = "还原中 " + index + "/" + items.length + "：" + item.rel;
          return exists(path).then(function (present) {
            return present ? conflict(path) : "overwrite";
          }).then(function (action) {
            if (action === "skip") { skipped++; return nextFile(); }
            var mime = OS.mimeOf(item.rel);
            var text = /^text\//.test(mime) || /\/(json|javascript|xml)$/.test(mime);
            return item.entry.async(text ? "string" : "base64").then(function (content) {
              return OS.vfs.put(path, text
                ? { name: item.rel.split("/").pop(), mime: mime, text: content }
                : { name: item.rel.split("/").pop(), mime: mime, data: content });
            }).then(function (put) {
              if (!put || put.ok === false) throw new Error((put && put.error) || ("写入失败：" + path));
              restored++;
              return nextFile();
            });
          });
        }
        return nextFile();
      }).then(function () {
        vRestoreProg.textContent = "还原完成：" + restored + " 项，跳过 " + skipped + " 项";
        OS.log("restore", "从 " + name + " 还原完成：写入=" + restored + " 跳过=" + skipped);
        refreshUsage();
        return OS.dlg.alert("还原完成。已写入 " + restored + " 项，跳过 " + skipped +
          " 项。重新打开页面后，应用和设置会完整生效。", "备份还原");
      });
    }

    btnRestore.addEventListener("click", function () {
      var name = restoreSelect.value;
      if (!name) { OS.toast("请选择备份 ZIP"); return; }
      OS.dlg.confirm("将从“" + name + "”还原平板文件和设置。遇到同名内容时会询问覆盖或跳过。继续？",
        "从备份还原").then(function (yes) {
        if (!yes) return;
        btnRestore.disabled = true;
        btnRestoreRefresh.disabled = true;
        restoreTabletBackup(name).then(function () {
          btnRestore.disabled = false;
          btnRestoreRefresh.disabled = false;
        }, function (err) {
          btnRestore.disabled = false;
          btnRestoreRefresh.disabled = false;
          vRestoreProg.textContent = "还原失败：" + ((err && err.message) || err);
          OS.logerr("restore", err, "备份还原失败 " + name);
          OS.toast("还原失败：" + ((err && err.message) || err));
        });
      });
    });

    /* 调试模式：立即生效；开启后 console/报错回传电脑并写离线空间 /日志/ */
    cbDbg.addEventListener("change", function () {
      if (cbDbg.checked) {
        OS.debug.enable();
        OS.log("settings", "用户开启调试模式（日志→离线空间 /日志/ + 电脑 logs/tablet）");
        OS.toast("调试模式已开启：日志同时写入离线空间 /日志/ 并回传电脑");
      } else {
        OS.log("settings", "用户关闭调试模式");
        OS.debug.disable();
        OS.toast("调试模式已关闭");
      }
    });

    /* ---------- 关于 ---------- */
    var cardAbout = OS.h("div", "nv-set-card");
    cardAbout.appendChild(OS.h("h4", "", "关于"));

    // 系统版本：独立一行，便于用户报障时直接读出
    var vRow = OS.h("div", "nv-set-row");
    vRow.appendChild(OS.h("span", "nv-set-k", "系统版本"));
    var ver = typeof OS.version === "function" ? OS.version() : "";
    var bld = typeof OS.build === "function" ? OS.build() : "";
    vRow.appendChild(OS.h("span", "nv-set-v", "v" + ver + (bld ? "  (" + bld + ")" : "")));
    cardAbout.appendChild(vRow);

    var nRow = OS.h("div", "nv-set-row");
    nRow.appendChild(OS.h("span", "nv-set-k", "系统名称"));
    nRow.appendChild(OS.h("span", "nv-set-v", "Tzy OS"));
    cardAbout.appendChild(nRow);

    // 已装应用清单（含各自版本）
    var apps = OS.apps();
    var listTitle = OS.h("div", "nv-set-row");
    listTitle.appendChild(OS.h("span", "nv-set-k", "已装应用"));
    listTitle.appendChild(OS.h("span", "nv-set-v", apps.length + " 个"));
    cardAbout.appendChild(listTitle);

    var list = OS.h("div", "nv-set-apps");
    apps.forEach(function (a) {
      list.appendChild(document.createTextNode(a.icon + " " + a.name + "  v" + a.version));
      list.appendChild(document.createElement("br"));
    });
    cardAbout.appendChild(list);
    page.appendChild(cardAbout);

    root.appendChild(page);
  }
})();
