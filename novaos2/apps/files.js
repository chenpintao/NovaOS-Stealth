/* ============================================================
 * Tzy OS · 文件管理器（四源 · 全功能版）v3.1.0
 *   电脑 = server.py 浏览电脑文件（config.fs_root 限定），劫持在时同源、
 *          断劫持后自动直连热点 IP（192.168.137.1）
 *   离线 = 平板本机 localStorage VFS，完全无网可用
 *   FTP  = 电脑网络 stdlib ftplib 代理
 *   SMB  = 电脑网络 Windows UNC 直读（\\host\share）
 *   网址 = 借电脑网络代取外网资源，存入离线空间
 * v3.1.0：本地压缩/解压（全部在平板完成，离线可用）：
 *   压缩为 zip（支持文件/文件夹递归、跨四源）；
 *   解压 zip / tar / tar.gz(tgz) / gz（JSZip + 手写 tar 解析 + DecompressionStream）。
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  var TEXT_EXT = {
    txt: 1, md: 1, log: 1, csv: 1, json: 1, js: 1, css: 1, htm: 1, html: 1,
    xml: 1, ini: 1, conf: 1, py: 1, java: 1, c: 1, h: 1, cpp: 1, sh: 1,
    bat: 1, yml: 1, yaml: 1, sql: 1, php: 1, vue: 1, ts: 1
  };
  var IMG_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, svg: 1 };
  var AUDIO_EXT = { mp3: 1, wav: 1, flac: 1, ogg: 1, m4a: 1, aac: 1 };
  var VIDEO_EXT = { mp4: 1, mov: 1, avi: 1, mkv: 1, webm: 1, m4v: 1 };
  // 可在平板上直接预览的办公文档（pdf.js / mammoth / JSZip 纯前端渲染）
  var DOC_EXT = {
    pdf: 1, doc: 1, docx: 1, ppt: 1, pptx: 1, xls: 1, xlsx: 1
  };
  var CFG_KEYS = { ftp: "nova2.ftp", smb: "nova2.smb" };
  var SORT_KEY = "nova2.files.sort";
  // 本机可解压的归档格式；rar/7z 需专有解码器，暂不支持（会在操作处明确提示）
  function arcType(name) {
    var n = String(name || "").toLowerCase();
    if (n.slice(-7) === ".tar.gz") return "tgz";
    var ext = n.split(".").pop();
    if (ext === "zip" || ext === "tar" || ext === "gz" || ext === "tgz") return ext;
    if (ext === "rar" || ext === "7z") return "unsupported";
    return "";
  }
  // 去掉归档扩展名得到解压目录名
  function arcBaseName(name) {
    var n = String(name || "");
    if (n.toLowerCase().slice(-7) === ".tar.gz") return n.slice(0, -7);
    return n.replace(/\.(zip|tar|gz|tgz)$/i, "");
  }
  var SOURCES = [
    { key: "fs", label: "电脑" },
    { key: "vfs", label: "离线" },
    { key: "ftp", label: "FTP" },
    { key: "smb", label: "SMB" }
  ];

  OS.registerApp({
    id: "files",
    name: "文件管理",
    icon: "🗂",
    tone: "tone-red",
    version: "3.1.0",
    open: function (root, OS) { build(root, OS); },
    onArg: function (root, arg) {
      // 系统级文件选择对话框：OS.pickFile() 调起
      if (arg && arg.__pick) {
        var st = root.__state;
        if (st) st.enterPickMode(arg);
      }
    }
  });

  function joinPath(a, b) {
    a = a || "";
    if (!a) return b;
    return a.replace(/[\\/]+$/, "") + "/" + b;
  }
  function parentPath(p) {
    p = (p || "").replace(/[\\/]+$/, "");
    var i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? "" : p.slice(0, i);
  }
  function isText(name) {
    return !!TEXT_EXT[String(name || "").split(".").pop().toLowerCase()];
  }
  function isImg(name) {
    return !!IMG_EXT[String(name || "").split(".").pop().toLowerCase()];
  }
  function isMedia(name) {
    var ext = String(name || "").split(".").pop().toLowerCase();
    return !!(AUDIO_EXT[ext] || VIDEO_EXT[ext]);
  }
  function isDoc(name) {
    return !!DOC_EXT[String(name || "").split(".").pop().toLowerCase()];
  }
  function fmtSize(n) {
    n = n || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }
  function fmtTime(ts) {
    if (!ts) return "-";
    var d = new Date(ts * 1000);
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate() +
           " " + (d.getHours() < 10 ? "0" : "") + d.getHours() +
           ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  }
  function baseName(url) {
    try {
      var p = String(url || "").split("?")[0].split("#")[0];
      var seg = decodeURIComponent(p.split("/").pop() || "");
      return seg || ("download-" + Date.now());
    } catch (e) { return "download-" + Date.now(); }
  }
  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || "");
        var i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : "");
      };
      fr.onerror = function () { reject(new Error("读取失败")); };
      fr.readAsDataURL(blob);
    });
  }

  function build(root, OS) {
    var state = {
      source: "fs", path: "", conn: null, entries: [], busy: false,
      sortBy: "name", sortAsc: true,   // name / size / mtime
      selected: {},                     // 批量选择 {name: true}
      pickMode: null,                   // {mode:"open"|"save", filter}
      dragOver: false
    };
    var reqId = 0;   // 请求代次：切源/刷新后丢弃过期响应，防止慢回调污染当前视图
    root.__state = state;

    /* ---------- 顶栏 ---------- */
    var bar = OS.h("div", "nv-toolbar");

    var seg = OS.h("div", "nv-seg");
    var segBtns = {};
    SOURCES.forEach(function (s) {
      var b = OS.h("button", s.key === "fs" ? "on" : "", s.label);
      segBtns[s.key] = b;
      seg.appendChild(b);
    });

    var btnConn = OS.h("button", "nv-btn", "连接");
    btnConn.style.display = "none";
    var btnWeb = OS.h("button", "nv-btn", "网址");
    var btnUp = OS.h("button", "nv-btn", "上一级");
    var btnRefresh = OS.h("button", "nv-btn", "刷新");
    var btnMkdir = OS.h("button", "nv-btn", "新建文件夹");
    var btnUpload = OS.h("button", "nv-btn primary", "上传");
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.style.display = "none";
    fileInput.multiple = true;

    bar.appendChild(seg);
    bar.appendChild(btnConn);
    bar.appendChild(btnWeb);
    bar.appendChild(btnUp);
    bar.appendChild(btnRefresh);
    bar.appendChild(btnMkdir);
    bar.appendChild(btnUpload);
    bar.appendChild(fileInput);

    /* ---------- 批量操作栏（默认隐藏） ---------- */
    var batchBar = OS.h("div", "nv-batch-bar");
    batchBar.style.display = "none";
    var lblCount = OS.h("span", "nv-batch-count", "已选 0 项");
    var bBatchDl = OS.h("button", "nv-btn", "批量下载");
    var bBatchSave = OS.h("button", "nv-btn", "批量存离线");
    var bBatchZip = OS.h("button", "nv-btn", "压缩为zip");
    bBatchZip.title = "把勾选的文件/文件夹在本机压缩成 zip（离线可用）";
    var bBatchDel = OS.h("button", "nv-btn danger", "批量删除");
    var bBatchCancel = OS.h("button", "nv-btn ghost", "取消");
    batchBar.appendChild(lblCount);
    batchBar.appendChild(bBatchDl);
    batchBar.appendChild(bBatchSave);
    batchBar.appendChild(bBatchZip);
    batchBar.appendChild(bBatchDel);
    batchBar.appendChild(bBatchCancel);

    /* ---------- 表头（排序） ---------- */
    var thead = OS.h("div", "nv-thead");
    var thSel = OS.h("div", "nv-th nv-th-sel");
    var cbAll = document.createElement("input");
    cbAll.type = "checkbox";
    cbAll.className = "nv-checkbox";
    thSel.appendChild(cbAll);
    var thName = OS.h("div", "nv-th nv-th-name", "名称");
    var thSize = OS.h("div", "nv-th nv-th-size", "大小");
    var thTime = OS.h("div", "nv-th nv-th-time", "时间");
    thead.appendChild(thSel);
    thead.appendChild(thName);
    thead.appendChild(thSize);
    thead.appendChild(thTime);

    /* ---------- 路径面包屑 ---------- */
    var crumbs = OS.h("div", "nv-crumbs");

    /* ---------- 列表 ---------- */
    var list = OS.h("div", "nv-list");
    var statusLine = OS.h("div", "nv-status-line", "就绪");

    root.appendChild(bar);
    root.appendChild(batchBar);
    root.appendChild(thead);
    root.appendChild(crumbs);
    root.appendChild(list);
    root.appendChild(statusLine);

    /* ---------- 按源分派 ----------
     * logCall：所有文件操作的统一日志出口。业务失败（r.ok=false）与网络异常
     * （Promise reject）都记录，op/path/源/错误原因齐全，排查 FTP/SMB/电脑源问题用。 */
    function logCall(op, path, p) {
      return p.then(function (r) {
        if (r && r.ok === false) {
          OS.log("files", "[" + state.source + "] " + op + " " + (path || state.path || "") +
            " 失败：" + (r.offline ? "(离线/电脑不可达)" : (r.error || "未知错误")), "error");
        }
        return r;
      }, function (e) {
        OS.logerr("files", e, "[" + state.source + "] " + op + " " +
          (path || state.path || "") + " 请求异常");
        throw e;
      });
    }
    function callList() {
      if (state.source === "vfs") return logCall("list", state.path, OS.vfs.list(state.path));
      if (state.source === "fs") return logCall("list", state.path, OS.api.fs("list", { path: state.path }));
      if (state.source === "ftp")
        return logCall("list", state.path, OS.api.ftp(Object.assign({}, state.conn, { op: "list", path: state.path })));
      return logCall("list", state.path, OS.api.smb(Object.assign({}, state.conn, { op: "list", path: state.path })));
    }
    function callDel(path) {
      if (state.source === "vfs") return logCall("del", path, OS.vfs.del(path));
      if (state.source === "fs") return logCall("del", path, OS.api.fs("del", { path: path }));
      if (state.source === "ftp")
        return logCall("del", path, OS.api.ftp(Object.assign({}, state.conn, { op: "del", path: path })));
      return logCall("del", path, OS.api.smb(Object.assign({}, state.conn, { op: "del", path: path })));
    }
    function callMkdir(path) {
      if (state.source === "vfs") return logCall("mkdir", path, OS.vfs.mkdir(path));
      if (state.source === "fs") return logCall("mkdir", path, OS.api.fs("mkdir", { path: path }));
      if (state.source === "ftp")
        return logCall("mkdir", path, OS.api.ftp(Object.assign({}, state.conn, { op: "mkdir", path: path })));
      return logCall("mkdir", path, OS.api.smb(Object.assign({}, state.conn, { op: "mkdir", path: path })));
    }
    function callPut(path, b64, name) {
      if (state.source === "vfs")
        return logCall("put", path, OS.vfs.put(path, { data: b64, mime: OS.mimeOf(name), name: name }));
      var body = { op: "put", path: path, data: b64 };
      if (state.source === "fs") return logCall("put", path, OS.api.fs("put", body));
      if (state.source === "ftp") return logCall("put", path, OS.api.ftp(Object.assign({}, state.conn, body)));
      return logCall("put", path, OS.api.smb(Object.assign({}, state.conn, body)));
    }
    function callGet(path) {
      if (state.source === "vfs") return logCall("get", path, OS.vfs.get(path));
      if (state.source === "fs") return logCall("get", path, OS.api.fs("get", { path: path }));
      if (state.source === "ftp")
        return logCall("get", path, OS.api.ftp(Object.assign({}, state.conn, { op: "get", path: path })));
      return logCall("get", path, OS.api.smb(Object.assign({}, state.conn, { op: "get", path: path })));
    }
    function callRename(path, newName) {
      if (state.source === "vfs")
        return logCall("rename", path, OS.vfs.rename(path, joinPath(parentPath(path), newName)));
      var body = { op: "rename", path: path, newName: newName };
      if (state.source === "fs") return logCall("rename", path, OS.api.fs("rename", body));
      if (state.source === "ftp") return logCall("rename", path, OS.api.ftp(Object.assign({}, state.conn, body)));
      return logCall("rename", path, OS.api.smb(Object.assign({}, state.conn, body)));
    }
    function sourceLabel() {
      return { fs: "电脑", vfs: "离线空间", ftp: "FTP", smb: "SMB 共享" }[state.source];
    }

    /* ---------- 排序 ---------- */
    function applySort(entries) {
      var arr = entries.slice();
      arr.sort(function (a, b) {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        var r = 0;
        if (state.sortBy === "size") r = (a.size || 0) - (b.size || 0);
        else if (state.sortBy === "mtime") r = (a.mtime || 0) - (b.mtime || 0);
        else r = String(a.name).toLowerCase() < String(b.name).toLowerCase() ? -1 : 1;
        return state.sortAsc ? r : -r;
      });
      return arr;
    }
    function toggleSort(by) {
      if (state.sortBy === by) state.sortAsc = !state.sortAsc;
      else { state.sortBy = by; state.sortAsc = true; }
      OS.store.set(SORT_KEY, { by: state.sortBy, asc: state.sortAsc });
      renderEntries();
      renderThead();
    }
    function renderThead() {
      var arrow = state.sortAsc ? " ↑" : " ↓";
      thName.textContent = "名称" + (state.sortBy === "name" ? arrow : "");
      thSize.textContent = "大小" + (state.sortBy === "size" ? arrow : "");
      thTime.textContent = "时间" + (state.sortBy === "mtime" ? arrow : "");
    }
    thName.addEventListener("click", function () { toggleSort("name"); });
    thSize.addEventListener("click", function () { toggleSort("size"); });
    thTime.addEventListener("click", function () { toggleSort("mtime"); });

    /* ---------- 渲染 ---------- */
    function render() {
      SOURCES.forEach(function (s) {
        segBtns[s.key].className = s.key === state.source ? "on" : "";
      });
      btnConn.style.display = (state.source === "ftp" || state.source === "smb") ? "" : "none";
      btnConn.textContent = state.conn ? "重新连接" : "连接";
      btnWeb.style.display = state.source === "vfs" ? "none" : "";
      btnUpload.textContent = state.source === "vfs" ? "导入" : "上传";

      renderCrumbs();
      btnUp.disabled = !state.path;
      renderEntries();
    }

    function renderCrumbs() {
      OS.clear(crumbs);
      var parts = state.path ? state.path.split("/") : [];
      var label = sourceLabel();
      var b = OS.h("span", "nv-crumb", label);
      b.addEventListener("click", function () { state.path = ""; refresh(); });
      crumbs.appendChild(b);
      parts.forEach(function (p, i) {
        if (!p) return;
        crumbs.appendChild(document.createTextNode(" / "));
        var segBtn = OS.h("span", "nv-crumb", p);
        var target = parts.slice(0, i + 1).join("/");
        segBtn.addEventListener("click", function () { state.path = target; refresh(); });
        crumbs.appendChild(segBtn);
      });
    }

    function renderEntries() {
      OS.clear(list);
      if (state.busy) { list.appendChild(OS.h("div", "nv-loading", "加载中…")); return; }
      if (!state.entries) return;
      var sorted = applySort(state.entries);
      if (!sorted.length) {
        list.appendChild(OS.h("div", "nv-empty", state.source === "vfs"
          ? "离线空间为空（可点「导入」选本机文件，或从电脑/FTP/外网存入）"
          : "（空文件夹）"));
        return;
      }
      sorted.forEach(function (e) {
        var row = OS.h("div", "nv-row" + (state.selected[e.name] ? " selected" : ""));
        // 复选框
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "nv-checkbox nv-row-cb";
        cb.checked = !!state.selected[e.name];
        cb.addEventListener("click", function (ev) {
          ev.stopPropagation();
          state.selected[e.name] = cb.checked;
          if (!cb.checked) delete state.selected[e.name];
          updateBatchBar();
          row.classList.toggle("selected", cb.checked);
        });
        row.appendChild(cb);

        row.appendChild(OS.h("div", "nv-row-ico", e.dir ? "📁" : iconFor(e.name)));
        row.appendChild(OS.h("div", "nv-row-name", e.name));
        row.appendChild(OS.h("div", "nv-row-meta", e.dir ? "" : fmtSize(e.size)));
        row.appendChild(OS.h("div", "nv-row-time", e.dir ? "" : fmtTime(e.mtime)));

        if (!e.dir) {
          if (isText(e.name)) {
            var bEdit = OS.h("button", "nv-row-act", "编辑");
            bEdit.addEventListener("click", function (ev) { ev.stopPropagation(); openText(e); });
            row.appendChild(bEdit);
          }
          if (isMedia(e.name)) {
            var bPlay = OS.h("button", "nv-row-act", "播放");
            bPlay.addEventListener("click", function (ev) { ev.stopPropagation(); openMedia(e); });
            row.appendChild(bPlay);
          }
          if (isDoc(e.name)) {
            var bDoc = OS.h("button", "nv-row-act", "预览");
            bDoc.addEventListener("click", function (ev) { ev.stopPropagation(); openDoc(e); });
            row.appendChild(bDoc);
          }
          if (isImg(e.name)) {
            var bView = OS.h("button", "nv-row-act", "预览");
            bView.addEventListener("click", function (ev) { ev.stopPropagation(); previewImg(e); });
            row.appendChild(bView);
          }
          if (arcType(e.name) === "unsupported") {
            var bNoArc = OS.h("button", "nv-row-act", "解压");
            bNoArc.title = "暂不支持 rar/7z，请在电脑上转成 zip/tar.gz";
            bNoArc.addEventListener("click", function (ev) {
              ev.stopPropagation();
              OS.log("files", "拒绝解压不支持的格式：" + e.name, "warn");
              OS.toast("暂不支持 rar/7z，请转成 zip 或 tar.gz 后再解压");
            });
            row.appendChild(bNoArc);
          } else if (arcType(e.name)) {
            var bArc = OS.h("button", "nv-row-act", "解压");
            bArc.addEventListener("click", function (ev) { ev.stopPropagation(); extractArchive(e); });
            row.appendChild(bArc);
          }
          if (state.source !== "vfs") {
            var bSave = OS.h("button", "nv-row-act", "存离线");
            bSave.addEventListener("click", function (ev) { ev.stopPropagation(); saveToVfs(e); });
            row.appendChild(bSave);
          }
          var bDl = OS.h("button", "nv-row-act", "下载");
          bDl.addEventListener("click", function (ev) { ev.stopPropagation(); downloadEntry(e); });
          row.appendChild(bDl);
          var bCopy = OS.h("button", "nv-row-act", "复制到…");
          bCopy.addEventListener("click", function (ev) { ev.stopPropagation(); copyTo(e); });
          row.appendChild(bCopy);
        }
        var bRen = OS.h("button", "nv-row-act", "重命名");
        bRen.addEventListener("click", function (ev) { ev.stopPropagation(); renameEntry(e); });
        row.appendChild(bRen);
        var bProp = OS.h("button", "nv-row-act", "属性");
        bProp.addEventListener("click", function (ev) { ev.stopPropagation(); showProp(e); });
        row.appendChild(bProp);
        var bDel = OS.h("button", "nv-row-act danger", "删");
        bDel.addEventListener("click", function (ev) { ev.stopPropagation(); delEntry(e); });
        row.appendChild(bDel);

        // 行点击：目录进入；文件在 pickMode 下触发选择
        row.addEventListener("click", function (ev) {
          if (ev.target.type === "checkbox") return;
          if (e.dir) { state.path = joinPath(state.path, e.name); refresh(); return; }
          if (state.pickMode) {
            if (state.pickMode.mode === "open") {
              OS._pickDone({ source: state.source, path: joinPath(state.path, e.name), name: e.name });
              OS.closeApp("files");
            } else {
              // save 模式：用当前文件名做默认，弹 prompt 确认
              OS.dlg.prompt("保存为文件名", e.name, "另存为").then(function (name) {
                if (name === null) return;
                name = (name || "").trim().replace(/[\\/]/g, "");
                if (!name) return;
                OS._pickDone({ source: state.source, path: joinPath(state.path, name), name: name });
                OS.closeApp("files");
              });
            }
          }
        });
        list.appendChild(row);
      });
    }

    function iconFor(name) {
      var ext = String(name || "").split(".").pop().toLowerCase();
      if (IMG_EXT[ext]) return "🖼";
      if (AUDIO_EXT[ext]) return "🎵";
      if (VIDEO_EXT[ext]) return "🎬";
      if (ext === "zip" || ext === "rar" || ext === "7z" || ext === "tar" || ext === "gz") return "📦";
      if (ext === "pdf") return "📕";
      if (ext === "doc" || ext === "docx") return "📘";
      if (ext === "xls" || ext === "xlsx" || ext === "csv") return "📗";
      if (ext === "ppt" || ext === "pptx") return "📙";
      if (isText(name)) return "📄";
      return "📎";
    }

    function showError(msg, withRetry) {
      OS.clear(list);
      var box = OS.h("div", "nv-empty", msg);
      if (withRetry !== false) {
        box.appendChild(document.createElement("br"));
        var retry = OS.h("button", "nv-btn", "重试");
        retry.style.margin = "14px auto 0";
        retry.addEventListener("click", refresh);
        box.appendChild(retry);
      }
      list.appendChild(box);
    }

    /* ---------- 批量操作 ---------- */
    function updateBatchBar() {
      var names = Object.keys(state.selected);
      if (names.length) {
        batchBar.style.display = "";
        lblCount.textContent = "已选 " + names.length + " 项";
      } else {
        batchBar.style.display = "none";
      }
    }
    function clearSelection() {
      state.selected = {};
      cbAll.checked = false;
      updateBatchBar();
      renderEntries();
    }
    cbAll.addEventListener("change", function () {
      if (cbAll.checked) {
        state.entries.forEach(function (e) { state.selected[e.name] = true; });
      } else {
        state.selected = {};
      }
      updateBatchBar();
      renderEntries();
    });
    bBatchCancel.addEventListener("click", clearSelection);

    function batchOp(opName, fn) {
      var names = Object.keys(state.selected);
      if (!names.length) return;
      var done = 0, fail = 0;
      statusLine.textContent = "批量" + opName + " 0/" + names.length + "…";
      function next() {
        if (done + fail >= names.length) {
          OS.toast("批量" + opName + "完成" + (fail ? "，" + fail + " 个失败" : ""));
          clearSelection();
          refresh();
          return;
        }
        var name = names[done + fail];
        var entry = null;
        for (var i = 0; i < state.entries.length; i++) {
          if (state.entries[i].name === name) { entry = state.entries[i]; break; }
        }
        if (!entry) { fail++; next(); return; }
        fn(entry, function (ok) {
          if (ok) done++; else fail++;
          statusLine.textContent = "批量" + opName + " " + (done + fail) + "/" + names.length + "…";
          next();
        });
      }
      next();
    }
    bBatchDel.addEventListener("click", function () {
      var names = Object.keys(state.selected);
      if (!names.length) return;
      OS.dlg.confirm("确定批量删除 " + names.length + " 项？", "批量删除").then(function (yes) {
        if (!yes) return;
        batchOp("删除", function (entry, cb) {
          callDel(joinPath(state.path, entry.name)).then(function (r) { cb(r.ok); });
        });
      });
    });
    bBatchDl.addEventListener("click", function () {
      batchOp("下载", function (entry, cb) {
        downloadEntry(entry, cb);
      });
    });
    bBatchSave.addEventListener("click", function () {
      batchOp("存离线", function (entry, cb) {
        saveToVfs(entry, cb);
      });
    });
    bBatchZip.addEventListener("click", zipSelection);

    /* ========== 本地压缩 / 解压（纯前端，离线可用；Loshop & Cpt） ========== */
    // 按绝对路径参数化的四源原语（callXxx 绑定 state.path，递归遍历必须自带路径）
    function srcList(p) {
      if (state.source === "vfs") return OS.vfs.list(p);
      if (state.source === "fs") return OS.api.fs("list", { path: p });
      if (state.source === "ftp") return OS.api.ftp(Object.assign({}, state.conn, { op: "list", path: p }));
      return OS.api.smb(Object.assign({}, state.conn, { op: "list", path: p }));
    }
    function srcGet(p) {
      if (state.source === "vfs") return OS.vfs.get(p);
      if (state.source === "fs") return OS.api.fs("get", { path: p });
      if (state.source === "ftp") return OS.api.ftp(Object.assign({}, state.conn, { op: "get", path: p }));
      return OS.api.smb(Object.assign({}, state.conn, { op: "get", path: p }));
    }
    function srcMkdir(p) {
      if (state.source === "vfs") return OS.vfs.mkdir(p);
      if (state.source === "fs") return OS.api.fs("mkdir", { path: p });
      if (state.source === "ftp") return OS.api.ftp(Object.assign({}, state.conn, { op: "mkdir", path: p }));
      return OS.api.smb(Object.assign({}, state.conn, { op: "mkdir", path: p }));
    }
    function srcPut(p, rec) {
      if (state.source === "vfs") return OS.vfs.put(p, rec);
      var body = { op: "put", path: p };
      if (rec.text !== undefined && rec.text !== null) body.content = rec.text;
      else body.data = rec.data;
      if (state.source === "fs") return OS.api.fs("put", body);
      if (state.source === "ftp") return OS.api.ftp(Object.assign({}, state.conn, body));
      return OS.api.smb(Object.assign({}, state.conn, body));
    }
    // 归档内路径安全化：去前导斜杠/反斜杠，拒绝 ".."（zip-slip 防护），非法返回 ""
    function safeRel(rel) {
      var p = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
      var out = [];
      p.split("/").forEach(function (s) {
        if (!s || s === ".") return;
        if (s === "..") { out = null; }
        else if (out) out.push(s);
      });
      return out ? out.join("/") : "";
    }
    // 逐级建目录；已存在或失败都忽略（vfs/fs 幂等，FTP/SMB 对已存在目录会报错）
    function ensureDirs(absPath) {
      var segs = String(absPath || "").split("/").filter(Boolean);
      var chain = Promise.resolve(), acc = "";
      segs.forEach(function (s) {
        acc += "/" + s;
        chain = chain.then(function () {
          return srcMkdir(acc)["catch"](function () { return { ok: false }; });
        });
      });
      return chain;
    }
    function getAsBlob(abs, name) {
      return srcGet(abs).then(function (r) {
        if (!r.ok) {
          throw new Error(r.offline ? "服务不可达（离线）" : (r.error || "读取失败"));
        }
        return r.text
          ? new Blob([r.content], { type: "text/plain;charset=utf-8" })
          : OS.b64ToBlob(r.data, r.mime || OS.mimeOf(name));
      });
    }

    /* ---------- 压缩为 zip ---------- */
    function zipSelection() {
      var names = Object.keys(state.selected);
      if (!names.length) return;
      if (!window.JSZip) {
        OS.log("files", "压缩组件 JSZip 未加载，无法压缩", "error");
        OS.toast("压缩组件未加载");
        return;
      }
      var defName = names.length === 1 ? names[0].replace(/\.[^.]+$/, "") + ".zip" : "压缩包.zip";
      OS.dlg.prompt("压缩包文件名（zip 格式，含文件夹会递归打包）", defName, "压缩为 zip").then(function (fname) {
        if (fname === null) return;
        fname = (fname || "").trim().replace(/[\\/]/g, "");
        if (!fname) return;
        if (!/\.zip$/i.test(fname)) fname += ".zip";
        var zip = new JSZip();
        var nFiles = 0, nBytes = 0, t0 = Date.now();
        OS.log("files", "压缩开始：[" + state.source + "] " + (state.path || "/") +
          " 共 " + names.length + " 个顶层项 → " + fname);
        statusLine.textContent = "正在收集待压缩文件…";

        function addFile(abs, rel) {
          return getAsBlob(abs, rel).then(function (blob) {
            nBytes += blob.size;
            zip.file(rel.replace(/^\/+/, ""), blob);
            nFiles++;
            if (nFiles % 10 === 0) statusLine.textContent = "已收集 " + nFiles + " 个文件…";
          });
        }
        function walk(abs, rel) {
          return srcList(abs).then(function (r) {
            if (!r.ok) throw new Error(r.offline ? "列目录失败（离线）" : (r.error || ("列目录失败 " + abs)));
            var chain = Promise.resolve();
            (r.entries || []).forEach(function (e) {
              chain = chain.then(function () {
                var cAbs = joinPath(abs, e.name);
                var cRel = rel ? joinPath(rel, e.name) : e.name;
                if (e.dir) { zip.folder(cRel); return walk(cAbs, cRel); }
                return addFile(cAbs, cRel);
              });
            });
            return chain;
          });
        }
        var chain = Promise.resolve();
        names.forEach(function (nm) {
          chain = chain.then(function () {
            var entry = null;
            for (var i = 0; i < state.entries.length; i++) {
              if (state.entries[i].name === nm) { entry = state.entries[i]; break; }
            }
            if (!entry) return;
            var abs = joinPath(state.path, entry.name);
            if (entry.dir) { zip.folder(entry.name); return walk(abs, entry.name); }
            return addFile(abs, entry.name);
          });
        });
        chain.then(function () {
          OS.log("files", "压缩收集完成：" + nFiles + " 个文件共 " + fmtSize(nBytes) + "，开始 deflate");
          statusLine.textContent = "正在压缩打包…";
          return zip.generateAsync({
            type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 }
          }, function (meta) { statusLine.textContent = "压缩中 " + meta.percent.toFixed(0) + "%"; });
        }).then(function (blob) {
          statusLine.textContent = "正在写入 " + fname + "…";
          return blobToB64(blob).then(function (b64) {
            return srcPut(joinPath(state.path, fname), {
              name: fname, mime: "application/zip", data: b64
            });
          });
        }).then(function (r) {
          if (r && r.ok === false) throw new Error(r.error || "压缩包写入失败");
          OS.log("files", "压缩完成：" + fname + " 含 " + nFiles + " 个文件，耗时 " +
            (Date.now() - t0) + "ms");
          OS.toast("已压缩：" + fname);
          clearSelection();
          refresh();
        })["catch"](function (err) {
          OS.logerr("files", err, "压缩失败 " + fname + " [" + state.source + "]");
          OS.toast("压缩失败：" + (err && err.message));
          statusLine.textContent = "压缩失败";
        });
      });
    }

    /* ---------- 解压 zip / tar / tgz / gz ---------- */
    function gunzipBlob(blob) {
      if (!window.DecompressionStream) {
        return Promise.reject(new Error("当前浏览器不支持 gzip 解压（需 Chrome 80+）"));
      }
      var out = blob.stream().pipeThrough(new DecompressionStream("gzip"));
      return new Response(out).blob();
    }
    function parseZipItems(blob) {
      return JSZip.loadAsync(blob).then(function (zip) {
        var items = [], chain = Promise.resolve();
        Object.keys(zip.files).forEach(function (k) {
          chain = chain.then(function () {
            var obj = zip.files[k];
            if (obj.dir) { items.push({ rel: k, dir: true }); return; }
            return obj.async("blob").then(function (b) {
              items.push({ rel: k, dir: false, blob: b });
            });
          });
        });
        return chain.then(function () { return items; });
      });
    }
    function tarField(bytes, from, to) {
      var s = "";
      for (var i = from; i < to && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    function tarOctal(bytes, from, to) {
      var s = "";
      for (var i = from; i < to; i++) {
        var c = bytes[i] || 0;
        if (c === 0 || c === 32) break;
        s += String.fromCharCode(c);
      }
      return parseInt(s || "0", 8) || 0;
    }
    // 手写 ustar/gnu/pax tar 解析：512 字节头 + 按 512 对齐的数据块；
    // 支持 GNU 长文件名(L) 与 PAX 扩展头(x=局部/g=全局，现代 tar 默认就带)
    function parseTarItems(bytes) {
      var items = [], off = 0, pendingName = null, paxGlobal = null;
      while (off + 512 <= bytes.length) {
        var h = bytes.subarray(off, off + 512);
        if (h[0] === 0) break;                    // 全零块 = 归档结束
        var size = tarOctal(h, 124, 136);
        var type = String.fromCharCode(h[156] || 48);
        var dataStart = off + 512;
        var nextOff = dataStart + Math.ceil(size / 512) * 512;
        if (type === "x" || type === "g") {       // PAX 扩展头：数据是 "len key=val\n"
          var rec = tarField(bytes, dataStart, dataStart + size);
          var pm = rec.match(/(?:^|\n)\d+ path=([^\n]+)/);
          if (pm) {
            if (type === "g") paxGlobal = pm[1];  // 全局：后续条目都生效
            else pendingName = pm[1];             // 局部：仅下一个条目
          } else if (type === "x") {
            pendingName = null;
          }
          off = nextOff;
          continue;                               // 扩展头本身不落盘（即常见的 @PaxHeader）
        }
        var name = pendingName;
        pendingName = null;
        if (!name) name = paxGlobal;
        if (type === "L") {                        // GNU long name：数据块即长名
          pendingName = tarField(bytes, dataStart, dataStart + size).replace(/\0+$/, "");
          off = nextOff;
          continue;
        }
        if (!name) {
          var base = tarField(h, 0, 100);
          var prefix = tarField(h, 345, 500);
          name = prefix ? prefix + "/" + base : base;
        }
        if (type === "5") items.push({ rel: name.replace(/\/+$/, ""), dir: true });
        else if (size > 0) items.push({
          rel: name, dir: false,
          blob: new Blob([bytes.subarray(dataStart, dataStart + size)])
        });
        off = nextOff;
      }
      return items;
    }
    function parseArchive(blob, kind, arcName) {
      if (kind === "zip") return parseZipItems(blob);
      if (kind === "tar") {
        return blob.arrayBuffer().then(function (buf) { return parseTarItems(new Uint8Array(buf)); });
      }
      if (kind === "gz") {
        // 单文件 gzip：解压为去掉 .gz 的同名文件
        return gunzipBlob(blob).then(function (ub) {
          return [{ rel: arcBaseName(arcName) || ("解压_" + Date.now()), dir: false, blob: ub }];
        });
      }
      // tar.gz / .tgz：先 gunzip 再解 tar
      return gunzipBlob(blob).then(function (ub) { return ub.arrayBuffer(); }).then(function (buf) {
        return parseTarItems(new Uint8Array(buf));
      });
    }
    function writeArcItems(base, items, onProgress) {
      var okN = 0, failN = 0;
      var chain = Promise.resolve();
      items.forEach(function (it) {
        chain = chain.then(function () {
          var rel = safeRel(it.rel);
          if (!rel) { failN++; return; }
          var abs = joinPath(base, rel);
          var job;
          if (it.dir) {
            job = ensureDirs(abs);
          } else {
            job = ensureDirs(parentPath(abs)).then(function () {
              return blobToB64(it.blob);
            }).then(function (b64) {
              return srcPut(abs, {
                name: rel.split("/").pop(),
                mime: it.blob.type || "application/octet-stream", data: b64
              });
            }).then(function (r) {
              if (r && r.ok === false) throw new Error(r.error || "写入失败");
            });
          }
          return job.then(function () {
            okN++; onProgress(okN, failN);
          }, function (e) {
            failN++;
            OS.log("files", "解压条目写入失败 " + abs + "：" + (e && e.message), "warn");
            onProgress(okN, failN);
          });
        });
      });
      return chain.then(function () { return { ok: okN, fail: failN }; });
    }
    function extractArchive(entry) {
      var kind = arcType(entry.name);
      if (!kind || kind === "unsupported") {
        OS.toast("不支持的压缩格式（支持 zip/tar/tar.gz/gz）");
        return;
      }
      var arcPath = joinPath(state.path, entry.name);
      var outName = arcBaseName(entry.name) || ("解压_" + Date.now());
      OS.dlg.confirm(
        "解压「" + entry.name + "」到当前目录下的文件夹「" + outName + "」？\n" +
        "支持格式：zip / tar / tar.gz / gz，全程在本机完成。", "解压归档"
      ).then(function (yes) {
        if (!yes) return;
        var t0 = Date.now();
        OS.log("files", "解压开始：[" + state.source + "] " + arcPath + " 类型=" + kind);
        statusLine.textContent = "正在读取压缩包…";
        var total = 0;
        getAsBlob(arcPath, entry.name).then(function (blob) {
          OS.log("files", "压缩包已读取 " + fmtSize(blob.size) + "，开始解析 " + kind);
          return parseArchive(blob, kind, entry.name);
        }).then(function (items) {
          total = items.length;
          var bad = 0;
          items.forEach(function (it) { if (!safeRel(it.rel) && !it.dir) bad++; });
          if (bad) OS.log("files", "归档内含 " + bad + " 个非法路径条目（已跳过）：" + arcPath, "warn");
          var targetBase = joinPath(state.path, outName);
          statusLine.textContent = "解压写入 0/" + total + "…";
          return ensureDirs(targetBase).then(function () {
            return writeArcItems(targetBase, items, function (ok, fail) {
              statusLine.textContent = "解压写入 " + (ok + fail) + "/" + total +
                (fail ? "（" + fail + " 失败）" : "");
            });
          });
        }).then(function (st) {
          OS.log("files", "解压完成：" + entry.name + " → " + outName + "/ 条目 " +
            st.ok + " 成功" + (st.fail ? "、" + st.fail + " 失败" : "") +
            "，耗时 " + (Date.now() - t0) + "ms");
          OS.toast(st.fail
            ? "解压完成，" + st.fail + " 项失败"
            : "已解压到：" + outName);
          refresh();
        })["catch"](function (err) {
          OS.logerr("files", err, "解压失败 " + arcPath + " 类型=" + kind);
          OS.toast("解压失败：" + (err && err.message));
          statusLine.textContent = "解压失败";
        });
      });
    }

    /* ---------- 数据操作 ---------- */
    function refresh() {
      if ((state.source === "ftp" || state.source === "smb") && !state.conn) {
        reqId++;
        state.busy = false;
        state.entries = null;
        render();
        OS.clear(list);
        list.appendChild(OS.h("div", "nv-empty", "请先点「连接」填写服务器信息"));
        crumbs.textContent = (state.source === "ftp" ? "FTP" : "SMB") + " · 未连接";
        statusLine.textContent = "未连接";
        return;
      }
      var my = ++reqId;
      state.busy = true;
      state.entries = [];
      render();
      statusLine.textContent = "正在读取" + sourceLabel() + "…";
      callList().then(function (r) {
        if (my !== reqId) return;
        state.busy = false;
        if (r.ok) {
          state.entries = r.entries || [];
          var extra = "";
          if (state.source === "fs") {
            var info = OS.net.info();
            if (info && typeof info.wan === "boolean") {
              extra = " · 电脑外网：" + (info.wan ? "通畅" : "不通");
            }
          }
          statusLine.textContent = sourceLabel() + " · 共 " + state.entries.length + " 项" + extra;
          render();
        } else {
          statusLine.textContent = r.error || "读取失败";
          if (r.offline) showError("电脑服务不可用（离线模式）\n可切换到「离线」空间，或连回电脑热点");
          else showError("读取失败：" + (r.error || "未知错误"));
        }
      });
    }

    function openText(entry) {
      var p = joinPath(state.path, entry.name);
      statusLine.textContent = "正在打开 " + entry.name + "…";
      callGet(p).then(function (r) {
        if (!r.ok) { OS.toast(r.offline ? "服务不可达（离线）" : (r.error || "打开失败")); return; }
        if (!r.text && r.data) { OS.toast("不是文本文件，请用下载/存离线"); return; }
        OS.openApp("editor", {
          __editRemote: true,
          payload: {
            source: state.source,
            path: p,
            subPath: p,
            conn: (state.source === "fs" || state.source === "vfs") ? null : state.conn,
            name: entry.name,
            content: r.content
          }
        });
        statusLine.textContent = "已送记事本编辑：" + entry.name;
      });
    }

    function openMedia(entry) {
      var mediaList = state.entries.filter(function (x) { return !x.dir && isMedia(x.name); });
      OS.openApp("media", {
        __play: true,
        payload: {
          source: state.source,
          path: state.path,
          conn: (state.source === "fs" || state.source === "vfs") ? null : state.conn,
          entries: mediaList,
          startName: entry.name
        }
      });
    }

    // 办公文档（pdf/doc/docx/ppt/pptx/xls/xlsx）交查看器应用渲染
    function openDoc(entry) {
      var p = joinPath(state.path, entry.name);
      OS.openApp("preview", {
        __preview: true,
        payload: {
          source: state.source,
          path: p,
          conn: (state.source === "fs" || state.source === "vfs") ? null : state.conn,
          name: entry.name,
          size: entry.size || 0
        }
      });
    }

    function previewImg(entry) {
      var p = joinPath(state.path, entry.name);
      statusLine.textContent = "正在加载图片…";
      callGet(p).then(function (r) {
        if (!r.ok) { OS.toast(r.offline ? "服务不可达（离线）" : (r.error || "读取失败")); return; }
        var blob = r.text
          ? new Blob([r.content], { type: "image/svg+xml" })
          : OS.b64ToBlob(r.data, r.mime || OS.mimeOf(entry.name));
        var url = URL.createObjectURL(blob);
        var mask = OS.h("div", "nv-mask nv-modal-top");
        var box = OS.h("div", "nv-img-preview");
        var btnClose = OS.h("button", "nv-img-close", "✕");
        btnClose.setAttribute("title", "关闭预览");
        box.appendChild(btnClose);
        var img = document.createElement("img");
        img.src = url;
        img.style.maxWidth = "90vw";
        img.style.maxHeight = "80vh";
        img.style.objectFit = "contain";
        box.appendChild(img);
        var cap = OS.h("div", "nv-img-cap", entry.name + " · " + fmtSize(entry.size));
        box.appendChild(cap);
        mask.appendChild(box);
        var closePreview = function () {
          URL.revokeObjectURL(url);
          if (mask.parentNode) mask.parentNode.removeChild(mask);
        };
        btnClose.addEventListener("click", function (ev) {
          ev.stopPropagation();
          closePreview();
        });
        mask.addEventListener("click", closePreview);
        document.body.appendChild(mask);
        statusLine.textContent = "就绪";
      });
    }

    function showProp(entry) {
      var p = joinPath(state.path, entry.name);
      var html = "名称：" + entry.name + "\n" +
                 "路径：" + sourceLabel() + " · " + p + "\n" +
                 "大小：" + fmtSize(entry.size) + "\n" +
                 "修改时间：" + fmtTime(entry.mtime) + "\n" +
                 "类型：" + (entry.dir ? "文件夹" : (OS.mimeOf(entry.name) || "未知"));
      OS.dlg.alert(html, "属性");
    }

    function renameEntry(entry) {
      var p = joinPath(state.path, entry.name);
      OS.dlg.prompt("新名称", entry.name, "重命名").then(function (newName) {
        if (newName === null) return;
        newName = (newName || "").trim().replace(/[\\/]/g, "");
        if (!newName || newName === entry.name) return;
        callRename(p, newName).then(function (r) {
          if (r.ok) { OS.toast("已重命名"); refresh(); }
          else OS.toast(r.error || (r.offline ? "服务不可达（离线）" : "重命名失败"));
        });
      });
    }

    function copyTo(entry) {
      var p = joinPath(state.path, entry.name);
      var targets = SOURCES.filter(function (s) { return s.key !== state.source; });
      var msg = "把「" + entry.name + "」复制到：\n";
      targets.forEach(function (t, i) { msg += (i + 1) + ". " + t.label + "\n"; });
      OS.dlg.prompt(msg + "\n请输入序号", "1", "复制到…").then(function (idx) {
        if (idx === null) return;
        idx = parseInt(idx, 10) - 1;
        if (idx < 0 || idx >= targets.length) { OS.toast("序号无效"); return; }
        var dst = targets[idx];
        statusLine.textContent = "正在复制到" + dst.label + "…";
        callGet(p).then(function (r) {
          if (!r.ok) { OS.toast(r.offline ? "服务不可达（离线）" : (r.error || "读取失败")); return; }
          var rec = r.text
            ? { name: entry.name, mime: "text/plain", text: r.content }
            : { name: entry.name, mime: OS.mimeOf(entry.name), data: r.data };
          // 写入目标源
          var putP;
          if (dst.key === "vfs") putP = OS.vfs.put("/" + entry.name, rec);
          else if (dst.key === "fs") putP = OS.api.fs("put", { path: entry.name, data: rec.data, content: rec.text });
          else if (dst.key === "ftp") putP = OS.api.ftp(Object.assign({}, OS.store.get(CFG_KEYS.ftp, {}), { op: "put", path: entry.name, data: rec.data, content: rec.text }));
          else putP = OS.api.smb(Object.assign({}, OS.store.get(CFG_KEYS.smb, {}), { op: "put", path: entry.name, data: rec.data, content: rec.text }));
          putP.then(function (r2) {
            if (r2.ok) { OS.toast("已复制到" + dst.label); statusLine.textContent = "已复制到" + dst.label; }
            else OS.toast(r2.error || (r2.offline ? "服务不可达（离线）" : "写入失败"));
          });
        });
      });
    }

    function downloadEntry(entry, cb) {
      var p = joinPath(state.path, entry.name);
      statusLine.textContent = "正在下载 " + entry.name + "…";
      callGet(p).then(function (r) {
        if (!r.ok) {
          OS.toast(r.offline ? "服务不可达（离线）" : (r.error || "下载失败"));
          if (cb) cb(false);
          return;
        }
        var blob = r.text
          ? new Blob([r.content], { type: "text/plain;charset=utf-8" })
          : OS.b64ToBlob(r.data, r.mime || OS.mimeOf(entry.name));
        OS.download(entry.name, blob);
        statusLine.textContent = "已下载到本机：" + entry.name;
        if (cb) cb(true);
      });
    }

    function saveToVfs(entry, cb) {
      var p = joinPath(state.path, entry.name);
      statusLine.textContent = "正在存入离线空间：" + entry.name + "…";
      callGet(p).then(function (r) {
        if (!r.ok) {
          OS.toast(r.offline ? "服务不可达（离线）" : (r.error || "失败"));
          if (cb) cb(false);
          return;
        }
        var rec = r.text
          ? { name: entry.name, mime: "text/plain", text: r.content }
          : { name: entry.name, mime: OS.mimeOf(entry.name), data: r.data };
        return OS.vfs.put("/" + entry.name, rec);
      }).then(function (r) {
        if (!r) return;
        if (r.ok) {
          OS.toast("已存入离线空间：" + entry.name);
          statusLine.textContent = "已存离线 · 断网后在「离线」中查看";
          if (cb) cb(true);
        } else {
          OS.toast(r.error || "存入离线空间失败");
          if (cb) cb(false);
        }
      });
    }

    function delEntry(entry) {
      var p = joinPath(state.path, entry.name);
      var tip = state.source === "vfs"
        ? "确定从离线空间删除「" + entry.name + "」？"
        : "确定删除「" + entry.name + "」？\n" + p;
      OS.dlg.confirm(tip, "删除").then(function (yes) {
        if (!yes) return;
        callDel(p).then(function (r) {
          if (r.ok) { OS.toast("已删除"); refresh(); }
          else OS.toast(r.offline ? "服务不可达（离线）" : ("删除失败：" + (r.error || "")));
        });
      });
    }

    function mkdir() {
      OS.dlg.prompt("新建文件夹名称", "新建文件夹", "新建文件夹").then(function (name) {
        if (name === null) return;
        name = (name || "").trim().replace(/[\\/]/g, "");
        if (!name) return;
        callMkdir(joinPath(state.path, name)).then(function (r) {
          if (r.ok) { OS.toast("已创建"); refresh(); }
          else OS.toast(r.error || (r.offline ? "服务不可达（离线）" : "创建失败"));
        });
      });
    }

    function uploadFiles(files) {
      if (!files || !files.length) return;
      var i = 0, fail = 0;
      OS.log("files", "开始上传/导入 " + files.length + " 个文件到[" + state.source + "] " + state.path);
      function next() {
        if (i >= files.length) {
          if (fail) OS.log("files", "上传结束：" + fail + "/" + files.length + " 个失败", "warn");
          else OS.log("files", "上传结束：全部 " + files.length + " 个成功");
          OS.toast(fail ? "完成，" + fail + " 个失败" : "完成");
          refresh();
          return;
        }
        var f = files[i++];
        statusLine.textContent = (state.source === "vfs" ? "导入中 " : "上传中 ") +
                                 i + "/" + files.length + "：" + f.name;
        OS.readFileB64(f).then(function (b64) {
          return callPut(joinPath(state.path, f.name), b64, f.name);
        }).then(function (r) {
          if (!r.ok) {
            fail++;
            OS.log("files", "上传失败 " + f.name + "：" + (r.error || "未知"), "error");
            if (r.error) OS.toast(f.name + "：" + r.error);
          }
          next();
        }).catch(function (e) {
          fail++;
          OS.logerr("files", e, "上传异常 " + f.name);
          next();
        });
      }
      next();
    }

    // 借电脑网络代取外网资源 → 存入离线空间
    function fetchWeb() {
      OS.dlg.prompt(
        "输入外网网址（由电脑代取，断劫持/跨域均可）\n例：https://www.example.com/a.pdf",
        "https://", "网址代取"
      ).then(function (url) {
        if (url === null) return;
        url = (url || "").trim();
        if (!url || url === "https://") return;
        statusLine.textContent = "电脑正在代取：" + url;
        OS.log("files", "网址代取开始：" + url);
        OS.net.getWeb(url).then(function (r) {
          if (!r.ok) {
            statusLine.textContent = "代取失败";
            OS.log("files", "网址代取失败 " + url + "：" +
              (r.offline ? "(离线/电脑不可达)" : (r.error || "未知")), "error");
            OS.toast(r.offline ? "电脑服务不可达（离线）" : (r.error || "代取失败"));
            return;
          }
          var name = r.name || baseName(url);
          statusLine.textContent = "正在存入离线空间：" + name;
          OS.log("files", "代取成功 " + url + " → " + name + " " +
            (r.blob && r.blob.size ? r.blob.size : "?") + " 字节，存入离线空间");
          blobToB64(r.blob).then(function (b64) {
            return OS.vfs.put("/" + name, { data: b64, mime: r.blob.type || OS.mimeOf(name), name: name });
          }).then(function (s) {
            if (s.ok) { OS.toast("已存入离线空间：" + name); statusLine.textContent = "代取完成 · 到「离线」中查看"; }
            else { OS.log("files", "代取文件存入离线空间失败 " + name + "：" + (s.error || "未知"), "error"); OS.toast(s.error || "存入离线空间失败"); }
          }, function (err) {
            OS.logerr("files", err, "代取文件转存离线空间异常 " + name);
            OS.toast("存入离线空间失败：" + (err && err.message));
          });
        }, function (err) {
          OS.logerr("files", err, "网址代取请求异常 " + url);
          statusLine.textContent = "代取失败";
          OS.toast("代取失败：" + (err && err.message));
        });
      });
    }

    /* ---------- FTP / SMB 连接对话框 ---------- */
    function openConnDialog() {
      var saved = OS.store.get(CFG_KEYS[state.source], {}) || {};
      var mask = OS.h("div", "nv-mask");
      var dlg = OS.h("div", "nv-dialog");
      dlg.appendChild(OS.h("h3", "", state.source === "ftp"
        ? "连接 FTP 服务器（走电脑网络）" : "连接 SMB 共享（走电脑网络）"));

      var fields = state.source === "ftp" ? [
        ["主机", "host", "如 192.168.1.10"],
        ["端口", "port", "21"],
        ["用户名", "user", "匿名可留空"],
        ["密码", "pass", ""],
        ["起始目录", "path", "留空为根目录"]
      ] : [
        ["主机", "host", "如 192.168.1.10"],
        ["共享名", "share", "如 share"],
        ["用户名", "user", "来宾可留空"],
        ["密码", "pass", ""],
        ["起始目录", "path", "留空为共享根"]
      ];
      var inputs = {};
      fields.forEach(function (f) {
        var row = OS.h("div", "nv-form-row");
        row.appendChild(OS.h("label", "", f[0]));
        var inp = document.createElement("input");
        inp.className = "nv-input";
        inp.placeholder = f[2];
        if (f[1] === "pass") inp.type = "password";
        if (f[1] === "port") inp.type = "number";
        inp.value = saved[f[1]] !== undefined && saved[f[1]] !== null ? String(saved[f[1]]) : "";
        inputs[f[1]] = inp;
        row.appendChild(inp);
        dlg.appendChild(row);
      });

      var actions = OS.h("div", "nv-dialog-actions");
      var btnCancel = OS.h("button", "nv-btn ghost", "取消");
      var btnOk = OS.h("button", "nv-btn primary", "连接");
      actions.appendChild(btnCancel);
      actions.appendChild(btnOk);
      dlg.appendChild(actions);
      mask.appendChild(dlg);
      root.appendChild(mask);

      function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
      btnCancel.addEventListener("click", close);
      mask.addEventListener("click", function (e) { if (e.target === mask) close(); });
      btnOk.addEventListener("click", function () {
        var cfg = {};
        for (var k in inputs) cfg[k] = inputs[k].value.trim();
        if (!cfg.host || (state.source === "smb" && !cfg.share)) { OS.toast("主机/共享名必填"); return; }
        if (state.source === "ftp") cfg.port = parseInt(cfg.port, 10) || 21;
        OS.store.set(CFG_KEYS[state.source], cfg);
        state.conn = cfg;
        state.path = cfg.path || "";
        OS.log("files", "保存" + state.source.toUpperCase() + "连接配置并连接：host=" +
          cfg.host + (cfg.port ? ":" + cfg.port : "") + (cfg.share ? " share=" + cfg.share : "") +
          " user=" + (cfg.user || "(匿名)") + " path=" + (cfg.path || "/"));
        close();
        refresh();
      });
    }

    /* ---------- 拖拽上传 ---------- */
    list.addEventListener("dragover", function (e) {
      e.preventDefault();
      if (!state.dragOver) { state.dragOver = true; list.classList.add("nv-dragover"); }
    });
    list.addEventListener("dragleave", function () {
      state.dragOver = false; list.classList.remove("nv-dragover");
    });
    list.addEventListener("drop", function (e) {
      e.preventDefault();
      state.dragOver = false; list.classList.remove("nv-dragover");
      var files = e.dataTransfer ? e.dataTransfer.files : null;
      if (files && files.length) uploadFiles([].slice.call(files));
    });

    /* ---------- 源切换 ---------- */
    function switchSource(s) {
      OS.log("files", "切换文件源：" + state.source + " → " + s);
      state.source = s;
      state.path = "";
      state.entries = [];
      state.selected = {};
      cbAll.checked = false;
      updateBatchBar();
      if (s === "vfs") { state.conn = null; refresh(); }
      else if (s === "fs") { state.conn = null; refresh(); }
      else {
        state.conn = OS.store.get(CFG_KEYS[s], null);
        refresh();
      }
    }
    SOURCES.forEach(function (s) {
      segBtns[s.key].addEventListener("click", function () { switchSource(s.key); });
    });
    btnConn.addEventListener("click", openConnDialog);
    btnWeb.addEventListener("click", fetchWeb);
    btnUp.addEventListener("click", function () { state.path = parentPath(state.path); refresh(); });
    btnRefresh.addEventListener("click", refresh);
    btnMkdir.addEventListener("click", mkdir);
    btnUpload.addEventListener("click", function () { fileInput.value = ""; fileInput.click(); });
    fileInput.addEventListener("change", function () {
      uploadFiles([].slice.call(fileInput.files));
    });

    /* ---------- 系统级文件选择模式 ---------- */
    state.enterPickMode = function (arg) {
      state.pickMode = { mode: arg.mode || "open", filter: arg.filter || null };
      state.source = arg.source || "fs";
      state.path = arg.path || "";
      state.conn = (state.source === "ftp" || state.source === "smb")
        ? OS.store.get(CFG_KEYS[state.source], null) : null;
      // pick 模式下隐藏批量栏
      batchBar.style.display = "none";
      refresh();
    };

    /* 初始 */
    var savedSort = OS.store.get(SORT_KEY, null);
    if (savedSort) { state.sortBy = savedSort.by || "name"; state.sortAsc = savedSort.asc !== false; }
    renderThead();
    refresh();
  }
})();
