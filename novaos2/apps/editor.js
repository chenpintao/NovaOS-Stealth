/* ============================================================
 * Tzy OS · 记事本（多文档）
 * - 文档明文存 localStorage
 * - 支持把当前文档另存到电脑（api/fs/put）
 * - 文件管理器用 OS.openApp("editor", {__editRemote,payload}) 调起远程文件编辑，
 *   保存时写回原处（电脑 / FTP / SMB / 离线空间）
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  var DOCS_KEY = "nova2.docs";

  OS.registerApp({
    id: "editor",
    name: "记事本",
    icon: "📝",
    tone: "tone-gold",
    version: "1.1.0",
    open: function (root, OS) { build(root, OS); },
    onArg: function (root, arg) {
      // 文件管理器 → 编辑远程文本文件
      if (arg && arg.__editRemote) {
        var st = root.__state;
        if (st) st.loadRemote(arg.payload);
      }
    }
  });

  function build(root, OS) {
    var docs = OS.store.get(DOCS_KEY, []);
    if (!docs.length) {
      docs = [{ id: "d" + Date.now(), name: "便签", content: "", updated: Date.now() }];
      OS.store.set(DOCS_KEY, docs);
    }
    var state = {
      docs: docs,
      curId: docs[0].id,
      remote: null,        // 远程会话 {source,path,conn,name,content}
      dirty: false,
      saveTimer: 0
    };
    root.__state = state;

    /* ---------- 工具栏 ---------- */
    var bar = OS.h("div", "nv-toolbar");

    var btnNew = OS.h("button", "nv-btn primary", "新建");
    var btnOpen = OS.h("button", "nv-btn", "打开");
    var sel = document.createElement("select");
    sel.className = "nv-select";
    sel.style.maxWidth = "130px";

    var btnSavePC = OS.h("button", "nv-btn", "存到电脑");
    var btnPutRemote = OS.h("button", "nv-btn primary", "保存回原处");
    btnPutRemote.style.display = "none";
    var btnToLocal = OS.h("button", "nv-btn", "转存本地");
    btnToLocal.style.display = "none";
    var btnDel = OS.h("button", "nv-btn", "删除");

    var remoteBadge = OS.h("span", "nv-crumbs", "");
    remoteBadge.style.color = "#b0463c";
    remoteBadge.style.display = "none";

    bar.appendChild(btnNew);
    bar.appendChild(btnOpen);
    bar.appendChild(sel);
    bar.appendChild(btnSavePC);
    bar.appendChild(btnPutRemote);
    bar.appendChild(btnToLocal);
    bar.appendChild(btnDel);
    bar.appendChild(remoteBadge);

    /* ---------- 编辑区 ---------- */
    var ta = document.createElement("textarea");
    ta.className = "nv-editor-area";
    ta.style.cssText =
      "-webkit-box-flex:1;flex:1 1 auto;width:100%;border:none;outline:none;" +
      "resize:none;padding:14px 16px;font-size:15px;line-height:1.7;" +
      "font-family:'Songti SC','STSong','SimSun',serif;color:#26282d;" +
      "background:#fffdf8;-webkit-user-select:text;user-select:text;";

    var statusLine = OS.h("div", "nv-status-line", "就绪");

    var wrap = root;
    wrap.appendChild(bar);
    wrap.appendChild(ta);
    wrap.appendChild(statusLine);

    /* ---------- 逻辑 ---------- */
    function cur() {
      for (var i = 0; i < state.docs.length; i++) {
        if (state.docs[i].id === state.curId) return state.docs[i];
      }
      return state.docs[0];
    }
    function persist() { OS.store.set(DOCS_KEY, state.docs); }

    function renderSel() {
      sel.innerHTML = "";
      state.docs.forEach(function (d) {
        var op = document.createElement("option");
        op.value = d.id;
        op.textContent = d.name;
        if (d.id === state.curId) op.selected = true;
        sel.appendChild(op);
      });
    }
    function setStatus(s) { statusLine.textContent = s; }
    function wordCount() {
      var v = ta.value;
      return v.length + " 字";
    }
    function loadLocal(d) {
      state.remote = null;
      state.curId = d.id;
      ta.value = d.content || "";
      ta.disabled = false;
      btnSavePC.style.display = "";
      btnPutRemote.style.display = "none";
      btnToLocal.style.display = "none";
      btnDel.style.display = "";
      sel.style.display = "";
      remoteBadge.style.display = "none";
      setStatus("已载入本地文档 · " + wordCount());
      renderSel();
    }
    function loadRemote(p) {
      state.remote = p;
      ta.value = p.content || "";
      ta.disabled = false;
      btnSavePC.style.display = "none";
      btnPutRemote.style.display = "";
      btnToLocal.style.display = "";
      btnDel.style.display = "none";
      sel.style.display = "none";
      remoteBadge.style.display = "";
      var label = { fs: "电脑", vfs: "离线空间", ftp: "FTP", smb: "SMB" }[p.source] || "远程";
      remoteBadge.textContent = label + "文档：" + p.path;
      setStatus("已载入远程文档 · 编辑后点「保存回原处」");
    }
    state.loadRemote = loadRemote;

    /* 自动保存（仅本地文档，防抖 600ms） */
    ta.addEventListener("input", function () {
      if (state.remote) { setStatus("远程文档已修改 · " + wordCount()); return; }
      var d = cur();
      if (!d) return;
      d.content = ta.value;
      d.updated = Date.now();
      state.dirty = true;
      setStatus("编辑中…");
      if (state.saveTimer) clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(function () {
        persist();
        state.dirty = false;
        setStatus("已自动保存 " + new Date().toLocaleTimeString() + " · " + wordCount());
      }, 600);
    });

    sel.addEventListener("change", function () {
      var d = null;
      for (var i = 0; i < state.docs.length; i++) {
        if (state.docs[i].id === sel.value) d = state.docs[i];
      }
      if (d) loadLocal(d);
    });

    btnNew.addEventListener("click", function () {
      OS.dlg.prompt("文档名称", "未命名 " + (state.docs.length + 1), "新建文档").then(function (name) {
        if (name === null) return;
        name = (name || "").trim() || "未命名";
        var d = { id: "d" + Date.now(), name: name, content: "", updated: Date.now() };
        state.docs.push(d);
        persist();
        loadLocal(d);
      });
    });

    /* 系统文件选择：打开任意源的文本文件 */
    btnOpen.addEventListener("click", function () {
      OS.pickFile({ mode: "open", source: "fs" }).then(function (sel) {
        if (!sel) return;
        // 读取内容
        var callGet;
        if (sel.source === "vfs") callGet = OS.vfs.get(sel.path);
        else if (sel.source === "fs") callGet = OS.api.fs("get", { path: sel.path });
        else if (sel.source === "ftp") callGet = OS.api.ftp(Object.assign({}, OS.store.get("nova2.ftp", {}), { op: "get", path: sel.path }));
        else callGet = OS.api.smb(Object.assign({}, OS.store.get("nova2.smb", {}), { op: "get", path: sel.path }));
        callGet.then(function (r) {
          if (!r.ok) { OS.toast(r.error || "读取失败"); return; }
          if (!r.text) { OS.toast("不是文本文件"); return; }
          loadRemote({
            source: sel.source, path: sel.path, subPath: sel.path,
            conn: sel.source === "fs" || sel.source === "vfs" ? null : OS.store.get(CFG_KEYS[sel.source], null),
            name: sel.name, content: r.content
          });
        });
      });
    });

    btnDel.addEventListener("click", function () {
      if (state.docs.length <= 1) { OS.toast("至少保留一个文档"); return; }
      var d = cur();
      OS.dlg.confirm("确定删除「" + d.name + "」？", "删除文档").then(function (yes) {
        if (!yes) return;
        state.docs = state.docs.filter(function (x) { return x.id !== d.id; });
        persist();
        loadLocal(state.docs[0]);
      });
    });

    /* 另存到电脑（api/fs/put，根目录由服务端 config.fs_root 限定） */
    btnSavePC.addEventListener("click", function () {
      var d = cur();
      var def = (d ? d.name : "note") + ".txt";
      OS.dlg.prompt("保存到电脑上的相对路径（相对文件根目录）", def, "存到电脑").then(function (path) {
        if (path === null) return;
        path = (path || "").trim();
        if (!path) return;
        setStatus("正在保存到电脑…");
        OS.api.fs("put", { path: path, content: ta.value }).then(function (r) {
          if (r.ok) { OS.toast("已保存到电脑：" + path); setStatus("已保存到电脑 · " + wordCount()); }
          else { OS.toast(r.error || "保存失败"); setStatus("保存失败：" + (r.error || "")); }
        });
      });
    });

    /* 远程文档保存回原处（电脑 / FTP / SMB / 离线空间） */
    btnPutRemote.addEventListener("click", function () {
      var p = state.remote;
      if (!p) return;
      setStatus("正在写回…");
      var req;
      if (p.source === "fs") {
        req = OS.api.fs("put", { path: p.path, content: ta.value });
      } else if (p.source === "vfs") {
        req = OS.vfs.put(p.path, { name: p.name, mime: "text/plain", text: ta.value });
      } else if (p.source === "ftp") {
        req = OS.api.ftp(Object.assign({}, p.conn, { op: "put", path: p.path, content: ta.value }));
      } else {
        req = OS.api.smb(Object.assign({}, p.conn, { op: "put", path: p.subPath, content: ta.value }));
      }
      req.then(function (r) {
        if (r.ok) { OS.toast("已保存回原处"); setStatus("已保存回原处 · " + new Date().toLocaleTimeString()); }
        else { OS.toast(r.offline ? "电脑/服务器不可达（离线）" : (r.error || "保存失败")); setStatus("保存失败"); }
      });
    });

    /* 远程文档转存为本地文档 */
    btnToLocal.addEventListener("click", function () {
      var p = state.remote;
      var d = {
        id: "d" + Date.now(),
        name: p.name || "远程文档",
        content: ta.value,
        updated: Date.now()
      };
      state.docs.push(d);
      persist();
      OS.toast("已转存为本地文档");
      loadLocal(d);
    });

    loadLocal(cur());
  }
})();
