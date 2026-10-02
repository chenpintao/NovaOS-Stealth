/* ============================================================
 * Tzy OS · 远程浏览器（CDP 直推版）
 *   电脑上跑 headless Chrome，画面经 SSE 推 JPEG 帧到 canvas，
 *   触摸/键盘经 Input.dispatch* 回注，借电脑网络上网。
 *   全部走同源相对路径，断劫持后热点直连同样可用。
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  // 画布尺寸以 /cdp/state 返回的服务端配置为准（管理界面可自定义），此为首次连接前的默认值
  var DEFAULT_W = 1280, DEFAULT_H = 800;

  OS.registerApp({
    id: "vbrowser",
    name: "远程浏览器",
    icon: "🌐",
    tone: "tone-ink",
    version: "1.0.0",
    maximize: true,
    open: function (root, OS) { build(root, OS); },
    onArg: function (root, arg) {
      var st = root.__state;
      if (st && arg && arg.url) st.nav(arg.url);
    }
  });

  function build(root, OS) {
    var state = { es: null, running: false, timer: 0, W: DEFAULT_W, H: DEFAULT_H };
    root.__state = state;

    /* ---------- 顶栏 ---------- */
    var bar = OS.h("div", "nv-toolbar");
    var bBack = OS.h("button", "nv-btn", "◀");
    var bFwd = OS.h("button", "nv-btn", "▶");
    var bReload = OS.h("button", "nv-btn", "↻");
    var addr = document.createElement("input");
    addr.className = "nv-vb-addr";
    addr.type = "text";
    addr.placeholder = "输入网址或搜索词，回车前往";
    var bGo = OS.h("button", "nv-btn primary", "前往");
    var bKbd = OS.h("button", "nv-btn", "⌨");
    var bBksp = OS.h("button", "nv-btn", "⌫");
    var bEnter = OS.h("button", "nv-btn", "⏎");
    bBack.title = "后退"; bFwd.title = "前进"; bReload.title = "刷新";
    bKbd.title = "向页面输入文字"; bBksp.title = "退格"; bEnter.title = "回车";
    bar.appendChild(bBack);
    bar.appendChild(bFwd);
    bar.appendChild(bReload);
    bar.appendChild(addr);
    bar.appendChild(bGo);
    bar.appendChild(bKbd);
    bar.appendChild(bBksp);
    bar.appendChild(bEnter);

    /* ---------- 视口 ---------- */
    var view = OS.h("div", "nv-vb-view");
    var canvas = document.createElement("canvas");
    canvas.width = state.W;
    canvas.height = state.H;
    canvas.className = "nv-vb-canvas";
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#101318";
    ctx.fillRect(0, 0, state.W, state.H);
    ctx.fillStyle = "#8a94a6";
    ctx.font = "28px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("正在连接远程浏览器…", state.W / 2, state.H / 2);
    view.appendChild(canvas);
    var statusLine = OS.h("div", "nv-status-line", "远程浏览器：连接中…");

    root.appendChild(bar);
    root.appendChild(view);
    root.appendChild(statusLine);

    /* ---------- 视口等比适配（元素框=图像框，保证触摸坐标换算准确） ---------- */
    function fit() {
      var w = view.clientWidth, h = view.clientHeight;
      if (!w || !h) return;
      var s = Math.min(w / state.W, h / state.H);
      canvas.style.width = Math.floor(state.W * s) + "px";
      canvas.style.height = Math.floor(state.H * s) + "px";
    }
    window.addEventListener("resize", fit);
    setTimeout(fit, 0);
    setTimeout(fit, 300);

    /* ---------- 帧流（SSE） ---------- */
    var img = new Image();
    img.onload = function () {
      try { ctx.drawImage(img, 0, 0, state.W, state.H); } catch (e) { }
    };
    function connect() {
      if (state.es) { try { state.es.close(); } catch (e) { } }
      var es;
      try { es = new EventSource("cdp/stream"); } catch (e) {
        statusLine.textContent = "当前内核不支持 EventSource";
        return;
      }
      state.es = es;
      es.onmessage = function (ev) {
        img.src = "data:image/jpeg;base64," + ev.data;
      };
      es.onerror = function () {
        statusLine.textContent = "远程浏览器：连接断开，重试中…";
      };
      es.onopen = function () {
        statusLine.textContent = "远程浏览器：已连接（电脑 Chrome 渲染）";
      };
    }

    /* ---------- 控制 ---------- */
    function post(rel, body) {
      return fetch(rel, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      }).then(function (r) { return r.json(); });
    }
    state.nav = function (url) {
      post("cdp/nav", { url: url });
    };
    function goAddr() {
      var v = (addr.value || "").trim();
      if (v) state.nav(v);
    }
    bGo.addEventListener("click", goAddr);
    addr.addEventListener("keydown", function (e) {
      if ((e.key || "") === "Enter") { e.preventDefault(); goAddr(); }
    });
    bBack.addEventListener("click", function () { post("cdp/cmd", { op: "back" }); });
    bFwd.addEventListener("click", function () { post("cdp/cmd", { op: "forward" }); });
    bReload.addEventListener("click", function () { post("cdp/cmd", { op: "reload" }); });
    bKbd.addEventListener("click", function () {
      OS.dlg.prompt("输入文字（发送到远程页面焦点处）", "", "键盘输入").then(function (t) {
        if (t) post("cdp/input", { kind: "text", text: t });
      });
    });
    bBksp.addEventListener("click", function () { post("cdp/input", { kind: "key", key: "Backspace" }); });
    bEnter.addEventListener("click", function () { post("cdp/input", { kind: "key", key: "Enter" }); });

    /* ---------- 触摸映射：点按=点击，拖动=滚动 ---------- */
    var pStart = null, lastScroll = 0;
    function toRemote(e) {
      var r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * state.W / r.width,
        y: (e.clientY - r.top) * state.H / r.height
      };
    }
    canvas.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      pStart = { x: e.clientX, y: e.clientY, t: Date.now(), rp: toRemote(e) };
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!pStart) return;
      var dy = e.clientY - pStart.y;
      var dx = e.clientX - pStart.x;
      if (Math.abs(dy) > 24 || Math.abs(dx) > 24) {
        var now = Date.now();
        if (now - lastScroll > 60) {
          lastScroll = now;
          post("cdp/input", {
            kind: "scroll", x: pStart.rp.x, y: pStart.rp.y,
            dx: -dx * 1.6, dy: -dy * 1.6
          });
          pStart.x = e.clientX; pStart.y = e.clientY;
        }
      }
    });
    canvas.addEventListener("pointerup", function (e) {
      if (!pStart) return;
      var moved = Math.abs(e.clientX - pStart.x) + Math.abs(e.clientY - pStart.y);
      if (moved < 12 && Date.now() - pStart.t < 500) {
        var rp = toRemote(e);
        post("cdp/input", { kind: "click", x: rp.x, y: rp.y });
      }
      pStart = null;
    });
    canvas.addEventListener("pointercancel", function () { pStart = null; });

    /* ---------- 状态轮询（地址栏同步） ---------- */
    function poll() {
      fetch("cdp/state").then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.ok) return;
        // 服务端画面尺寸可能在管理界面改过：同步画布（下一帧自动重绘）
        if (d.w && d.h && (d.w !== state.W || d.h !== state.H)) {
          state.W = d.w;
          state.H = d.h;
          canvas.width = d.w;
          canvas.height = d.h;
          fit();
        }
        state.running = !!d.running;
        if (d.running && document.activeElement !== addr && d.url && d.url !== "about:blank") {
          addr.value = d.url;
        }
        if (!d.running) statusLine.textContent = "远程浏览器：Chrome 未运行，点「前往」启动";
      }).catch(function () { });
    }
    state.timer = setInterval(poll, 3000);

    connect();
    poll();

    root.addEventListener("nv-close", function () {
      if (state.es) { try { state.es.close(); } catch (e) { } state.es = null; }
      if (state.timer) { clearInterval(state.timer); state.timer = 0; }
      window.removeEventListener("resize", fit);
    });
  }
})();
