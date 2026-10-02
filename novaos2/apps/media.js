/* ============================================================
 * Tzy OS · 媒体播放器（音/视频）
 * 文件管理器点「播放」→ 从当前源拉取文件转 Blob URL → 本窗口播放。
 * 支持播放列表（同目录媒体）、上一首/下一首、进度拖拽、循环模式。
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  var AUDIO_EXT = { mp3: 1, wav: 1, flac: 1, ogg: 1, m4a: 1, aac: 1 };
  var VIDEO_EXT = { mp4: 1, mov: 1, avi: 1, mkv: 1, webm: 1, m4v: 1 };

  function isMedia(name) {
    var ext = String(name || "").split(".").pop().toLowerCase();
    return !!(AUDIO_EXT[ext] || VIDEO_EXT[ext]);
  }
  function isVideo(name) {
    return !!VIDEO_EXT[String(name || "").split(".").pop().toLowerCase()];
  }

  OS.registerApp({
    id: "media",
    name: "媒体播放",
    icon: "🎵",
    tone: "tone-ink",
    version: "1.0.0",
    desktop: false,   // 不上桌面，由文件管理器唤起
    open: function (root) {
      // 首次 open 不初始化，等 onArg 带 payload 来再 build（否则会被 clear 掉）
    },
    onArg: function (root, arg) {
      if (arg && arg.__play && arg.payload) build(root, OS, arg.payload);
    }
  });

  /* payload = { source, path, entries:[{name,size}], conn } */
  function build(root, OS, payload) {
    OS.clear(root);

    var wrap = OS.h("div", "nv-media");

    /* 顶栏：标题 + 存离线 + 循环模式 */
    var bar = OS.h("div", "nv-media-bar");
    var titleEl = OS.h("div", "nv-media-title", "媒体播放");
    var btnSaveVfs = OS.h("button", "nv-btn", "存离线");
    var loopBtn = OS.h("button", "nv-btn", "顺序");
    bar.appendChild(titleEl);
    bar.appendChild(btnSaveVfs);
    bar.appendChild(loopBtn);
    wrap.appendChild(bar);

    /* 播放区 */
    var stage = OS.h("div", "nv-media-stage");
    var mediaEl = null;   // <audio> 或 <video>
    var infoEl = OS.h("div", "nv-media-info", "未在播放");
    stage.appendChild(infoEl);
    wrap.appendChild(stage);

    /* 控制区：进度 + 时间 */
    var ctrl = OS.h("div", "nv-media-ctrl");
    var prog = OS.h("div", "nv-media-prog");
    var progFill = OS.h("div", "nv-media-prog-fill");
    prog.appendChild(progFill);
    var timeEl = OS.h("div", "nv-media-time", "00:00 / 00:00");
    ctrl.appendChild(prog);
    ctrl.appendChild(timeEl);

    var btns = OS.h("div", "nv-media-btns");
    var btnPrev = OS.h("button", "nv-btn", "⏮");
    var btnPlay = OS.h("button", "nv-btn primary", "▶");
    var btnNext = OS.h("button", "nv-btn", "⏭");
    btns.appendChild(btnPrev);
    btns.appendChild(btnPlay);
    btns.appendChild(btnNext);
    ctrl.appendChild(btns);
    wrap.appendChild(ctrl);

    /* 播放列表 */
    var listWrap = OS.h("div", "nv-media-list-wrap");
    var listTitle = OS.h("div", "nv-media-list-title", "播放列表");
    var listEl = OS.h("div", "nv-media-list");
    listWrap.appendChild(listTitle);
    listWrap.appendChild(listEl);
    wrap.appendChild(listWrap);

    root.appendChild(wrap);

    /* ---------- 状态 ---------- */
    var playlist = [];   // [{name, size}]
    var curIdx = -1;
    var curUrl = null;   // 当前 Blob URL
    var loopMode = 0;    // 0顺序 1单曲 2随机
    var playing = false;
    var source = payload ? payload.source : "vfs";
    var basePath = payload ? payload.path : "";
    var conn = payload ? payload.conn : null;
    var entries = payload ? payload.entries : [];

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
    function fmtTime(s) {
      if (!isFinite(s) || s < 0) return "00:00";
      var m = Math.floor(s / 60);
      var sec = Math.floor(s % 60);
      return (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
    }
    function fmtSize(n) {
      n = n || 0;
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
      return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }

    /* ---------- 播放列表渲染 ---------- */
    function renderList() {
      OS.clear(listEl);
      if (!playlist.length) {
        listEl.appendChild(OS.h("div", "nv-empty", "无媒体文件"));
        return;
      }
      playlist.forEach(function (it, idx) {
        var row = OS.h("div", "nv-media-row" + (idx === curIdx ? " on" : ""));
        row.appendChild(OS.h("div", "nv-media-row-ico", isVideo(it.name) ? "🎬" : "🎵"));
        row.appendChild(OS.h("div", "nv-media-row-name", it.name));
        row.appendChild(OS.h("div", "nv-media-row-size", fmtSize(it.size)));
        row.addEventListener("click", function () { playIdx(idx); });
        listEl.appendChild(row);
      });
    }

    /* ---------- 拉取文件 ---------- */
    function fetchEntry(entry) {
      var p = joinPath(basePath, entry.name);
      if (source === "vfs") return OS.vfs.get(p);
      if (source === "fs") return OS.api.fs("get", { path: p });
      if (source === "ftp")
        return OS.api.ftp(Object.assign({}, conn, { op: "get", path: p }));
      return OS.api.smb(Object.assign({}, conn, { op: "get", path: p }));
    }

    /* ---------- 核心播放 ---------- */
    function playIdx(idx) {
      if (idx < 0 || idx >= playlist.length) return;
      curIdx = idx;
      var entry = playlist[idx];
      titleEl.textContent = entry.name;
      infoEl.textContent = "正在加载…";
      renderList();
      releaseUrl();
      stopMedia();

      fetchEntry(entry).then(function (r) {
        if (!r.ok) {
          infoEl.textContent = r.offline ? "服务不可达（离线）" : (r.error || "读取失败");
          return;
        }
        var blob = r.text
          ? new Blob([r.content], { type: "audio/mpeg" })
          : OS.b64ToBlob(r.data, r.mime || OS.mimeOf(entry.name));
        curUrl = URL.createObjectURL(blob);
        mountMedia(blob, entry);
        infoEl.textContent = "";
        // 记录当前 blob 供「存离线」使用
        curBlob = blob;
        curEntry = entry;
      });
    }

    /* 存离线：把当前播放文件写入 VFS */
    var curBlob = null;
    var curEntry = null;
    btnSaveVfs.addEventListener("click", function () {
      if (!curBlob || !curEntry) { OS.toast("没有正在播放的文件"); return; }
      var name = curEntry.name;
      OS.dlg.prompt("存入离线空间的文件名", name, "存离线").then(function (fname) {
        if (fname === null) return;
        fname = (fname || "").trim().replace(/[\\/]/g, "");
        if (!fname) return;
        var fr = new FileReader();
        fr.onload = function () {
          var b64 = String(fr.result || "").split(",")[1] || "";
          OS.vfs.put("/" + fname, { data: b64, mime: OS.mimeOf(fname), name: fname }).then(function (r) {
            if (r.ok) OS.toast("已存入离线空间：" + fname);
            else OS.toast(r.error || "存入失败");
          });
        };
        fr.readAsDataURL(curBlob);
      });
    });

    function mountMedia(blob, entry) {
      var tag = isVideo(entry.name) ? "video" : "audio";
      mediaEl = document.createElement(tag);
      mediaEl.controls = false;
      mediaEl.preload = "auto";
      mediaEl.src = curUrl;
      mediaEl.style.maxWidth = "100%";
      mediaEl.style.maxHeight = "100%";
      if (tag === "video") {
        stage.innerHTML = "";
        stage.appendChild(mediaEl);
      }
      mediaEl.addEventListener("timeupdate", onTimeUpdate);
      mediaEl.addEventListener("ended", onEnded);
      mediaEl.addEventListener("loadedmetadata", function () {
        timeEl.textContent = "00:00 / " + fmtTime(mediaEl.duration);
      });
      mediaEl.addEventListener("error", function () {
        infoEl.textContent = "无法播放此格式";
      });
      mediaEl.play().then(function () {
        playing = true;
        btnPlay.textContent = "⏸";
      }).catch(function () {
        infoEl.textContent = "自动播放被拦截，请点播放";
        playing = false;
        btnPlay.textContent = "▶";
      });
    }

    function stopMedia() {
      if (mediaEl) {
        try { mediaEl.pause(); } catch (e) { }
        mediaEl.src = "";
        mediaEl = null;
      }
      playing = false;
      btnPlay.textContent = "▶";
      progFill.style.width = "0%";
      timeEl.textContent = "00:00 / 00:00";
    }
    function releaseUrl() {
      if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
    }

    /* ---------- 进度/时间 ---------- */
    function onTimeUpdate() {
      if (!mediaEl || !mediaEl.duration) return;
      var pct = (mediaEl.currentTime / mediaEl.duration) * 100;
      progFill.style.width = pct + "%";
      timeEl.textContent = fmtTime(mediaEl.currentTime) + " / " + fmtTime(mediaEl.duration);
    }
    prog.addEventListener("click", function (e) {
      if (!mediaEl || !mediaEl.duration) return;
      var rect = prog.getBoundingClientRect();
      var ratio = (e.clientX - rect.left) / rect.width;
      mediaEl.currentTime = mediaEl.duration * Math.max(0, Math.min(1, ratio));
    });

    /* ---------- 播完/切换 ---------- */
    function onEnded() {
      playing = false;
      btnPlay.textContent = "▶";
      if (loopMode === 1) { playIdx(curIdx); return; }   // 单曲
      if (loopMode === 2) { playIdx(Math.floor(Math.random() * playlist.length)); return; }
      if (curIdx < playlist.length - 1) playIdx(curIdx + 1);
    }
    function next() {
      if (loopMode === 2) { playIdx(Math.floor(Math.random() * playlist.length)); return; }
      if (curIdx < playlist.length - 1) playIdx(curIdx + 1);
    }
    function prev() {
      if (curIdx > 0) playIdx(curIdx - 1);
    }

    btnPlay.addEventListener("click", function () {
      if (!mediaEl) { if (curIdx >= 0) playIdx(curIdx); return; }
      if (playing) { mediaEl.pause(); playing = false; btnPlay.textContent = "▶"; }
      else { mediaEl.play(); playing = true; btnPlay.textContent = "⏸"; }
    });
    btnPrev.addEventListener("click", prev);
    btnNext.addEventListener("click", next);
    loopBtn.addEventListener("click", function () {
      loopMode = (loopMode + 1) % 3;
      loopBtn.textContent = ["顺序", "单曲", "随机"][loopMode];
    });

    /* ---------- 初始化播放列表 ---------- */
    if (entries && entries.length) {
      playlist = entries.filter(function (e) { return !e.dir && isMedia(e.name); });
      renderList();
      if (payload && payload.startName) {
        var idx = -1;
        for (var i = 0; i < playlist.length; i++) {
          if (playlist[i].name === payload.startName) { idx = i; break; }
        }
        if (idx >= 0) playIdx(idx);
        else if (playlist.length) playIdx(0);
      } else if (playlist.length) {
        playIdx(0);
      }
    } else {
      listEl.appendChild(OS.h("div", "nv-empty", "请从文件管理器「播放」唤起"));
    }

    /* 窗口关闭时释放资源 */
    root.addEventListener("nv-close", function () {
      stopMedia();
      releaseUrl();
    });
  }
})();
