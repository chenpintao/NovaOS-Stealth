/* ============================================================
 * Tzy OS · 应用商店（安装 / 更新 / 卸载 / 本地包安装）
 * 应用以 .tzyp 标准包存在，与系统隔离，安装在离线空间 /apps/。
 * 来源：① 电脑端 apps_repo/ 仓库（同挂载点，无需外网）
 *       ② 平板离线空间里的 .tzyp 包
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  OS.registerApp({
    id: "store",
    name: "应用商店",
    icon: "🛍️",
    tone: "tone-purple",
    version: "1.0.0",
    open: function (root, OS) {
      var tab = "repo";
      var catalog = [];
      var curDir = "";
      var busy = false;

      root.style.cssText = "display:-webkit-flex;display:flex;-webkit-flex-direction:column;" +
        "flex-direction:column;height:100%;background:#f3f1f8;";

      /* ---------------- 顶栏 ---------------- */
      var bar = OS.h("div", "nv-toolbar");
      var tabs = OS.h("div", "nv-store-tabs");
      var btnRepo = mkTab("应用仓库", "repo");
      var btnMine = mkTab("已安装", "mine");
      var btnLocal = mkTab("离线空间安装", "local");
      tabs.appendChild(btnRepo);
      tabs.appendChild(btnMine);
      tabs.appendChild(btnLocal);
      var btnReload = OS.h("button", "nv-btn", "刷新");
      bar.appendChild(tabs);
      bar.appendChild(btnReload);

      var view = document.createElement("div");
      view.className = "nv-store-view";
      var statusLine = OS.h("div", "nv-status-line", "就绪");

      root.appendChild(bar);
      root.appendChild(view);
      root.appendChild(statusLine);

      function mkTab(label, key) {
        var b = OS.h("button", "nv-store-tab" + (key === tab ? " active" : ""), label);
        b.addEventListener("click", function () { switchTab(key); });
        b._key = key;
        return b;
      }
      function setStatus(s) { statusLine.textContent = s; }
      function setBusy(b) {
        busy = b;
        btnReload.disabled = b;
        var bs = root.querySelectorAll(".nv-store-btn");
        for (var i = 0; i < bs.length; i++) bs[i].disabled = b;
      }
      function fmtSize(n) {
        n = n || 0;
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / 1024 / 1024).toFixed(1) + " MB";
      }
      function progText(p) {
        var map = {
          open: "正在打开应用包…", clear: "正在清理旧版本…",
          write: "正在写入文件 " + p.cur + "/" + p.total + " …",
          register: "正在注册应用…", done: "安装完成"
        };
        return map[p.stage] || "处理中…";
      }

      function switchTab(key) {
        tab = key;
        var btns = tabs.querySelectorAll(".nv-store-tab");
        for (var i = 0; i < btns.length; i++)
          btns[i].className = "nv-store-tab" + (btns[i]._key === key ? " active" : "");
        render();
      }
      btnReload.addEventListener("click", render);

      /* ---------------- 安装核心 ---------------- */
      function installBlob(blob, title) {
        if (busy) { OS.log("store", "安装被拒绝：商店正忙", "warn"); return; }
        setBusy(true);
        setStatus("准备安装：" + title);
        OS.log("store", "开始安装包：" + title + "（" + (blob && blob.size ? blob.size : "?") + " 字节）");
        OS.pkg.install(blob, function (p) { setStatus(title + "：" + progText(p)); })
          .then(function (meta) {
            setBusy(false);
            setStatus("已安装 " + meta.name + " " + meta.version);
            OS.log("store", "安装成功：" + meta.id + "@" + meta.version);
            OS.toast("已安装：" + meta.name + " " + meta.version);
            render();
          }, function (err) {
            setBusy(false);
            var msg = err && err.message ? err.message : String(err);
            OS.logerr("store", err, "安装失败：" + title);
            setStatus("安装失败：" + msg);
            OS.toast("安装失败：" + msg);
          });
      }

      function installRepo(item) {
        if (busy) { OS.log("store", "仓库下载被拒绝：商店正忙", "warn"); return; }
        setBusy(true);
        setStatus("正在从电脑下载 " + item.file + " …");
        OS.log("store", "从电脑仓库下载：" + item.id + " 文件 " + item.file);
        OS.pkg.download(item.file).then(function (r) {
          if (!r || !r.ok) {
            setBusy(false);
            var msg = (r && r.offline) ? "电脑服务不可用（离线模式）" : ((r && r.error) || "下载失败");
            OS.log("store", "仓库下载失败：" + item.file + " | " + msg, "error");
            setStatus(msg);
            OS.toast(msg);
            return;
          }
          OS.log("store", "仓库包下载完成：" + item.file + " " +
            (r.blob && r.blob.size ? r.blob.size : "?") + " 字节");
          setBusy(false);                          // 下载阶段的忙锁先释放，installBlob 会自己上锁
          installBlob(r.blob, item.name);
        }, function (err) {
          setBusy(false);
          OS.logerr("store", err, "仓库下载异常：" + item.file);
          setStatus("下载失败：" + (err && err.message));
          OS.toast("下载失败：" + (err && err.message));
        });
      }

      function uninstall(id, name) {
        if (busy) { OS.log("store", "卸载被拒绝：商店正忙", "warn"); return; }
        OS.dlg.confirm("确定卸载应用「" + name + "」吗？\n应用的全部文件与数据将从离线空间删除。", "卸载应用")
          .then(function (yes) {
            if (!yes) return;
            setBusy(true);
            setStatus("正在卸载 " + name + " …");
            OS.log("store", "开始卸载：" + id);
            OS.pkg.uninstall(id).then(function () {
              setBusy(false);
              setStatus("已卸载：" + name);
              OS.log("store", "卸载成功：" + id);
              OS.toast("已卸载：" + name);
              render();
            }, function (err) {
              setBusy(false);
              OS.logerr("store", err, "卸载失败：" + id);
              setStatus("卸载失败：" + (err && err.message));
              OS.toast("卸载失败：" + (err && err.message));
            });
          });
      }

      /* ---------------- 图标（emoji 或 dataURL 图片） ---------------- */
      function iconNode(icon, iconData, cls) {
        if (iconData && /^data:image\//.test(iconData)) {
          var im = document.createElement("img");
          im.className = cls + " nv-store-ic-img";
          im.src = iconData;
          return im;
        }
        return OS.h("span", cls, icon || "📦");
      }

      function actionForRepo(item) {
        var mine = OS.pkg.installed().filter(function (m) { return m.id === item.id; })[0];
        if (!mine) return { act: "install", label: "安装" };
        if (OS.pkg.cmpVer(item.version, mine.version) > 0)
          return { act: "update", label: "更新 " + mine.version + " → " + item.version };
        return { act: "reinstall", label: "重新安装" };
      }

      /* ---------------- 渲染 ---------------- */
      function render() {
        OS.clear(view);
        if (tab === "repo") renderRepo();
        else if (tab === "mine") renderMine();
        else renderLocal();
      }

      function renderRepo() {
        var loading = OS.h("div", "nv-empty", "正在读取电脑端应用仓库…");
        view.appendChild(loading);
        OS.pkg.catalog().then(function (list) {
          catalog = list || [];
          OS.clear(view);
          var hint = OS.h("div", "nv-store-hint",
            "仓库目录：电脑 apps_repo/（把 .tzyp 应用包放入即自动上架；无需外网）");
          view.appendChild(hint);
          if (!catalog.length) {
            view.appendChild(OS.h("div", "nv-empty",
              "仓库里还没有应用。\n把制作好的 .tzyp 包放到电脑端 apps_repo\\ 目录后点刷新。"));
            return;
          }
          catalog.forEach(function (item) {
            var ac = actionForRepo(item);
            var card = OS.h("div", "nv-store-card");
            var head = OS.h("div", "nv-store-card-hd");
            head.appendChild(iconNode(item.icon, "", "nv-store-ic " + (item.tone || "tone-blue")));
            var info = document.createElement("div");
            var t = document.createElement("div");
            t.className = "nv-store-title";
            t.textContent = item.name + "  " + item.version;
            var sub = document.createElement("div");
            sub.className = "nv-store-sub";
            sub.textContent = (item.author ? "作者：" + item.author + "　" : "") +
                              "大小：" + fmtSize(item.size);
            info.appendChild(t);
            info.appendChild(sub);
            head.appendChild(info);
            var btn = OS.h("button", "nv-btn primary nv-store-btn", ac.label);
            btn.addEventListener("click", function () { installRepo(item); });
            head.appendChild(btn);
            card.appendChild(head);
            if (item.desc) card.appendChild(OS.h("div", "nv-store-desc", item.desc));
            view.appendChild(card);
          });
        }, function (err) {
          OS.logerr("store", err, "读取电脑端应用仓库清单失败");
          OS.clear(view);
          view.appendChild(OS.h("div", "nv-empty",
            "无法连接电脑端仓库（离线模式）。\n可在「离线空间安装」页用本地 .tzyp 包安装。"));
        });
      }

      function renderMine() {
        var hint = OS.h("div", "nv-store-hint",
          "系统内置应用随系统更新；自己安装的应用可单独卸载，不影响系统。");
        view.appendChild(hint);
        var list = OS.apps();
        // 注册表有但运行时缺失（加载失败）的包也展示，便于清理
        var liveIds = {};
        list.forEach(function (a) { liveIds[a.id] = 1; });
        OS.pkg.installed().forEach(function (m) {
          if (!liveIds[m.id]) {
            list.push({
              id: m.id, name: m.name, icon: m.icon, iconData: m.iconData,
              version: m.version, builtin: false, desc: "（加载失败，可卸载后重装）"
            });
          }
        });
        if (!list.length) {
          view.appendChild(OS.h("div", "nv-empty", "没有应用"));
          return;
        }
        list.forEach(function (a) {
          var card = OS.h("div", "nv-store-card");
          var head = OS.h("div", "nv-store-card-hd");
          head.appendChild(iconNode(a.icon, a.iconData, "nv-store-ic " + (a.tone || "tone-ink")));
          var info = document.createElement("div");
          var t = document.createElement("div");
          t.className = "nv-store-title";
          t.textContent = a.name + "  " + a.version;
          var sub = document.createElement("div");
          sub.className = "nv-store-sub";
          sub.textContent = a.builtin ? "系统内置应用" : "已安装应用（.tzyp）";
          info.appendChild(t);
          info.appendChild(sub);
          head.appendChild(info);
          if (!a.builtin) {
            var btn = OS.h("button", "nv-btn nv-store-btn", "卸载");
            btn.addEventListener("click", function () { uninstall(a.id, a.name); });
            head.appendChild(btn);
          } else {
            head.appendChild(OS.h("span", "nv-store-tag", "内置"));
          }
          card.appendChild(head);
          if (a.desc) card.appendChild(OS.h("div", "nv-store-desc", a.desc));
          view.appendChild(card);
        });
      }

      /* ---------------- 离线空间选包 ---------------- */
      function renderLocal() {
        var hint = OS.h("div", "nv-store-hint",
          "从平板「离线空间」选择 .tzyp 应用包直接安装，适合无电脑场景侧载。");
        view.appendChild(hint);
        var crumbs = OS.h("div", "nv-store-crumbs");
        var rc = OS.h("span", "nv-store-crumb", "离线空间");
        rc.addEventListener("click", function () { curDir = ""; renderLocal(); });
        crumbs.appendChild(rc);
        var segs = curDir ? curDir.split("/").filter(Boolean) : [];
        var acc = "";
        segs.forEach(function (seg) {
          crumbs.appendChild(document.createTextNode(" / "));
          acc += "/" + seg;
          (function (target) {
            var c = OS.h("span", "nv-store-crumb", seg);
            c.addEventListener("click", function () { curDir = target; renderLocal(); });
            crumbs.appendChild(c);
          })(acc);
        });
        view.appendChild(crumbs);

        var listBox = OS.h("div", "nv-store-local-list");
        listBox.appendChild(OS.h("div", "nv-empty", "正在读取…"));
        view.appendChild(listBox);

        OS.vfs.list(curDir).then(function (r) {
          OS.clear(listBox);
          var entries = (r && r.entries) || [];
          if (curDir) {
            var up = OS.h("div", "nv-store-row nv-store-up", "📁  ..");
            up.addEventListener("click", function () {
              var a = curDir.split("/"); a.pop();
              curDir = a.join("/");
              renderLocal();
            });
            listBox.appendChild(up);
          }
          var pkgs = entries.filter(function (e) {
            return !e.dir && /\.tzyp$/i.test(e.name);
          });
          entries.forEach(function (e) {
            var p = (curDir ? curDir : "") + "/" + e.name;
            var row = OS.h("div", "nv-store-row");
            if (e.dir) {
              row.innerHTML = "<span class='nv-store-ric'>📁</span><span class='nv-store-rnm'></span>";
              row.querySelector(".nv-store-rnm").textContent = e.name;
              row.addEventListener("click", function () { curDir = p; renderLocal(); });
              listBox.appendChild(row);
            } else if (/\.tzyp$/i.test(e.name)) {
              row.classList.add("is-pkg");
              row.innerHTML = "<span class='nv-store-ric'>📦</span><span class='nv-store-rnm'></span>" +
                              "<span class='nv-store-rsz'></span>";
              row.querySelector(".nv-store-rnm").textContent = e.name;
              row.querySelector(".nv-store-rsz").textContent = fmtSize(e.size);
              row.addEventListener("click", function () {
                OS.dlg.confirm("安装应用包 " + e.name + " ？", "本地安装").then(function (yes) {
                  if (!yes) return;
                  OS.vfs.get(p).then(function (g) {
                    if (!g || !g.ok) throw new Error((g && g.error) || "读取失败");
                    var blob = (g.text !== undefined && g.text !== null)
                      ? new Blob([g.text], { type: "application/zip" })
                      : OS.b64ToBlob(g.data, "application/zip");
                    OS.log("store", "本地包已读入：" + p + " " +
                      (blob.size || "?") + " 字节，开始安装");
                    installBlob(blob, e.name);
                  }, function (err) {
                    OS.logerr("store", err, "读取本地安装包失败：" + p);
                    OS.toast("读取失败：" + (err && err.message));
                  });
                });
              });
              listBox.appendChild(row);
            }
          });
          if (!pkgs.length && !entries.some(function (e) { return e.dir; })) {
            listBox.appendChild(OS.h("div", "nv-empty", "此目录没有 .tzyp 应用包"));
          }
        }, function (err) {
          OS.logerr("store", err, "列举离线空间安装包失败：" + curDir);
          OS.clear(listBox);
          listBox.appendChild(OS.h("div", "nv-empty",
            "读取失败：" + (err && err.message ? err.message : err)));
        });
      }

      render();
    }
  });
})();
