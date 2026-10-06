/* ============================================================
 * Tzy OS · 开发终端（devterm）
 * 开发模式的本地控制台：实时查看电脑下发的命令与执行结果，
 * 也可本地直接输入命令 —— 与电脑 /api/dev/exec 走同一条全权限
 * 命令路由（见 os.js 开发模式段 / novacore/devmode.py）。
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  OS.registerApp({
    id: "devterm",
    name: "开发终端",
    icon: "⌨️",
    tone: "tone-ink",
    version: "1.0.0",
    maximize: true,
    open: function (root, OS) { build(root, OS); }
  });

  var HELP = [
    "命令格式：cmd [参数] —— 与电脑 exec 同一路由，全权限执行",
    "  ping                       连通性自检",
    "  info                       系统一览（网络/应用/存储/统计）",
    "  eval <JS代码>              执行任意 JS（支持 Promise 返回）",
    "  app list | app open <id> | app close <id>",
    "  vfs list <路径> | vfs get <路径> | vfs usage | vfs mkdir <路径>",
    "  storage keys | storage get <键> | storage set <键> <值> | storage del <键>",
    "  toast <文字>               弹轻提示",
    "  lock                       锁屏          reload    重载 OS",
    "  dbg on | dbg off           开/关调试日志回传",
    "复合参数可整体给 JSON：vfs {\"op\":\"get\",\"path\":\"/音乐/a.mp3\"}",
    "clear 清屏 · help 本帮助 · 带 «电脑 前缀的行是电脑下发的命令"
  ].join("\n");

  /* 命令行解析：首词为 cmd，余文按习惯映射为 args；
   * 整体 JSON 直接采用（与电脑 exec 完全一致的参数结构）。 */
  function parseLine(line) {
    line = String(line || "").trim();
    if (!line) return null;
    var sp = line.indexOf(" ");
    var cmd = sp < 0 ? line : line.slice(0, sp);
    var rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    var args = {};
    if (!rest) return { cmd: cmd, args: args };
    if (cmd === "eval") { args.code = rest; return { cmd: cmd, args: args }; }
    if (rest.charAt(0) === "{") {
      try { return { cmd: cmd, args: JSON.parse(rest) }; } catch (e) { /* 回落 */ }
    }
    function cut(s) {                       // 首词 + 余文
      var i = s.indexOf(" ");
      return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1).trim()];
    }
    if (cmd === "toast") args.msg = rest;
    else if (cmd === "app") {
      var a = cut(rest); args.op = a[0];
      var b = cut(a[1]); args.id = b[0]; if (b[1]) args.arg = b[1];
    } else if (cmd === "vfs") {
      var v = cut(rest); args.op = v[0]; if (v[1]) args.path = v[1];
    } else if (cmd === "storage") {
      var s = cut(rest); args.op = s[0];
      if (args.op === "set") { var k = cut(s[1]); args.key = k[0]; if (k[1]) args.value = k[1]; }
      else if (s[1]) args.key = s[1];
    }
    else args.op = rest;
    return { cmd: cmd, args: args };
  }

  function build(root, OS) {
    var page = OS.h("div", "nv-term");

    /* ---------- 顶部状态条 ---------- */
    var bar = OS.h("div", "nv-term-bar");
    var dot = OS.h("span", "nv-term-dot");
    var stTxt = OS.h("span", "nv-term-st", "…");
    var stTok = OS.h("span", "nv-term-tok");
    var stCnt = OS.h("span", "nv-term-cnt");
    var btnPing = OS.h("button", "nv-btn", "ping");
    var btnInfo = OS.h("button", "nv-btn", "info");
    var btnHelp = OS.h("button", "nv-btn", "帮助");
    var btnClear = OS.h("button", "nv-btn", "清屏");
    bar.appendChild(dot);
    bar.appendChild(stTxt);
    bar.appendChild(stTok);
    bar.appendChild(stCnt);
    bar.appendChild(OS.h("span", "nv-term-gap"));
    bar.appendChild(btnPing);
    bar.appendChild(btnInfo);
    bar.appendChild(btnHelp);
    bar.appendChild(btnClear);

    /* ---------- 输出区 ---------- */
    var out = OS.h("div", "nv-term-out");

    /* ---------- 输入行 ---------- */
    var inrow = OS.h("div", "nv-term-in");
    var prompt = OS.h("span", "nv-term-prompt", "❯");
    var inp = document.createElement("input");
    inp.className = "nv-term-input";
    inp.type = "text";
    inp.placeholder = "输入命令，如 ping / info / help";
    inp.autocapitalize = "off";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    var btnRun = OS.h("button", "nv-btn primary", "执行");
    inrow.appendChild(prompt);
    inrow.appendChild(inp);
    inrow.appendChild(btnRun);

    page.appendChild(bar);
    page.appendChild(out);
    page.appendChild(inrow);
    root.appendChild(page);

    /* ---------- 输出辅助 ---------- */
    function ts() {
      var d = new Date();
      function p(n) { return (n < 10 ? "0" : "") + n; }
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }
    function print(cls, text) {
      var ln = OS.h("div", "nv-term-ln " + (cls || ""));
      ln.textContent = text;                    // textContent 直写，防注入
      out.appendChild(ln);
      while (out.childNodes.length > 400) out.removeChild(out.firstChild);
      out.scrollTop = out.scrollHeight;
    }
    // 结果格式化：远端包装 {ok,data,error,ms} 取 data；本地错误对象显 error
    function fmtRes(res) {
      var body = res;
      if (res && typeof res === "object" && "ok" in res && "ms" in res) body = res.data;
      if (body && typeof body === "object" && body.error) return "✗ " + body.error;
      var s;
      try { s = typeof body === "string" ? body : JSON.stringify(body, null, 1); }
      catch (e) { s = String(body); }
      if (typeof s === "undefined" || s === undefined) s = String(body);
      if (s && s.length > 4000) s = s.slice(0, 4000) + "\n…（已截断，共 " + s.length + " 字符）";
      return s;
    }
    function argsStr(a) {
      if (!a) return "";
      var s;
      try { s = JSON.stringify(a); } catch (e) { s = ""; }
      return s && s !== "{}" ? " " + s : "";
    }
    function banner() {
      print("sys", "Tzy OS 开发终端 v1.0 —— 与电脑 exec 通道共用全权限命令路由");
      print("sys", "电脑端调用：POST 127.0.0.1:8899/api/dev/exec {\"cmd\":\"…\",\"args\":{…}}");
      print("sys", "输入 help 查看命令；本终端与电脑均可完全控制平板 OS");
    }

    /* ---------- 本地执行 ---------- */
    function runLocal(line) {
      print("in", ts() + " ❯ " + line);
      var p = parseLine(line);
      if (!p) return;
      if (p.cmd === "clear") { out.textContent = ""; banner(); return; }
      if (p.cmd === "help") { print("sys", HELP); return; }
      OS.dev.exec(p.cmd, p.args).then(function (res) {
        print("", fmtRes(res));
      }, function (err) {
        print("err", "✗ " + (err && err.message ? err.message : String(err)));
      });
    }
    function go() { var v = inp.value; inp.value = ""; runLocal(v); }
    btnRun.addEventListener("click", go);
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });
    // 点输出区即聚焦输入框（平板上少一次精准点击）
    out.addEventListener("click", function () { try { inp.focus(); } catch (e) { } });
    btnPing.addEventListener("click", function () { runLocal("ping"); });
    btnInfo.addEventListener("click", function () { runLocal("info"); });
    btnHelp.addEventListener("click", function () { print("sys", HELP); });
    btnClear.addEventListener("click", function () { out.textContent = ""; banner(); });

    /* ---------- 电脑下发命令实时上屏 ---------- */
    OS.on("dev-cmd", function (d) {
      print("in", ts() + " «电脑 " + d.cmd + argsStr(d.args));
      print(d.res && d.res.ok === false ? "err" : "", fmtRes(d.res));
      refresh();
    });

    /* ---------- 通道状态 ---------- */
    function refresh() {
      var s = OS.dev.state();
      dot.className = "nv-term-dot " + (s.on ? "on" : s.off ? "off" : "");
      stTxt.textContent = s.on ? "已连接电脑（开发模式）" : s.off ? "电脑已关闭开发模式" : "未连接，等待电脑…";
      stTok.textContent = s.token ? "会话 " + s.token : "";
      stCnt.textContent = "命令 " + s.cmds + " · 成功 " + s.ok + " · 失败 " + s.fail;
    }
    OS.on("dev-change", refresh);

    banner();
    refresh();
    setTimeout(function () { try { inp.focus(); } catch (e) { } }, 250);
  }
})();
